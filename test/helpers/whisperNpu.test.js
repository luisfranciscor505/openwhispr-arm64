const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const {
  WhisperNpuManager,
  resolvePreference,
  isSupported,
} = require("../../src/helpers/whisperNpu");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-npu-"));
  const manager = new WhisperNpuManager(() => dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return manager;
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit("exit", 1));
  };
  return child;
}

test("acceleration defaults to Automatic and persists independently of existing models", (t) => {
  const manager = setup(t);
  assert.equal(manager.preference, "automatic");
  manager.setPreference("npu");
  assert.equal(manager.preference, "npu");
  assert.throws(() => manager.setPreference("gpu"), /Acceleration/);
  assert.equal(isSupported("win32", "arm64"), true);
  assert.equal(isSupported("win32", "x64"), false);
  assert.equal(resolvePreference(), "automatic");
});

test("NPU availability requires an executed graph probe, not just model files", async (t) => {
  const manager = setup(t);
  manager.isDownloaded = () => true;
  manager.getRuntimeDir = () => "runtime";
  assert.equal(manager.status().available, false);
  manager.request = async () => ({ available: true, backend: "cpu" });
  await assert.rejects(manager.load(), /did not verify/);
  assert.equal(manager.status().available, false);
  manager.request = async () => ({ available: true, backend: "qnn-htp" });
  await manager.load();
  assert.equal(manager.status().available, true);
});

test("queued inference remains serialized after a failed request", async (t) => {
  const manager = setup(t);
  const events = [];
  const first = manager.enqueue(async () => {
    events.push(1);
    await new Promise((r) => setTimeout(r, 10));
    throw new Error("failed");
  });
  const second = manager.enqueue(async () => events.push(2));
  await assert.rejects(first, /failed/);
  await second;
  assert.deepEqual(events, [1, 2]);
});

test("an aborted operation terminates a hung NPU driver call", async (t) => {
  const manager = setup(t);
  const child = fakeChild();
  manager.child = child;
  manager.ensureProcess = () => {};
  const controller = new AbortController();
  const pending = manager.request("transcribe", {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(child.killed, true);
  assert.equal(manager.child, null);
  assert.equal(manager.pending.size, 0);
});

test("helper timeout kills the process and leaves no unresolved request", async (t) => {
  const manager = setup(t);
  const child = fakeChild();
  manager.child = child;
  manager.ensureProcess = () => {};
  await assert.rejects(manager.request("load", {}, { timeout: 10 }), /timed out/);
  assert.equal(manager.pending.size, 0);
  assert.equal(child.killed, true);
});

test("missing models report a reason without claiming NPU availability", async (t) => {
  const manager = setup(t);
  const status = await manager.probe();
  assert.equal(status.available, false);
  assert.match(status.unavailableReason, /not downloaded/);
});

test(
  "an unexpected helper exit rejects the pending request",
  { skip: !isSupported() },
  async (t) => {
    const manager = setup(t);
    const child = fakeChild();
    manager.spawn = () => child;
    manager.getRuntimeDir = () => "runtime";
    const pending = manager.request("load");
    child.emit("exit", 42);
    await assert.rejects(pending, /exited \(42\)/);
    assert.equal(manager.child, null);
    assert.equal(manager.pending.size, 0);
  }
);

test(
  "a broken helper input pipe is handled without an unhandled stream error",
  { skip: !isSupported() },
  async (t) => {
    const manager = setup(t);
    const child = fakeChild();
    manager.spawn = () => child;
    manager.getRuntimeDir = () => "runtime";
    const pending = manager.request("load");
    child.stdin.emit("error", new Error("broken pipe"));
    await assert.rejects(pending, /broken pipe/);
    assert.equal(manager.pending.size, 0);
  }
);
