const { test } = require("node:test");
const assert = require("node:assert/strict");
const WhisperManager = require("../../src/helpers/whisper");
const { MODEL_ID } = require("../../src/helpers/whisperNpu");

function manager(preference) {
  const wm = new WhisperManager();
  wm.npuManager = {
    preference,
    transcribe: async () => {
      throw new Error("driver unavailable");
    },
  };
  return wm;
}

test("Automatic retries once on native CPU and exposes the fallback reason", async () => {
  const wm = manager("automatic");
  let calls = 0;
  wm.transcribeViaServer = async (audio, model, language, prompt, options) => {
    calls++;
    assert.equal(model, "base");
    assert.equal(options.forceCpu, true);
    return { success: true, text: "hello" };
  };
  const result = await wm.transcribeLocalWhisper(Buffer.from("audio"), { model: MODEL_ID });
  assert.equal(calls, 1);
  assert.equal(result.backend, "cpu");
  assert.match(result.fallbackReason, /driver unavailable/);
  assert.equal(wm.npuManager.activeBackend, "cpu");
});

test("explicit NPU errors never silently fall back", async () => {
  const wm = manager("npu");
  wm.transcribeViaServer = async () => assert.fail("CPU must not be called");
  await assert.rejects(
    wm.transcribeLocalWhisper(Buffer.from("audio"), { model: MODEL_ID }),
    /driver unavailable/
  );
});

test("cancellation never retries on CPU", async () => {
  const wm = manager("automatic");
  wm.npuManager.transcribe = async () => {
    throw Object.assign(new Error("cancelled"), { name: "AbortError" });
  };
  wm.transcribeViaServer = async () => assert.fail("Cancelled audio must not be retried");
  await assert.rejects(
    wm.transcribeLocalWhisper(Buffer.from("audio"), { model: MODEL_ID }),
    /cancelled/
  );
});

test("CPU preference bypasses the NPU entirely", async () => {
  const wm = manager("cpu");
  wm.npuManager.transcribe = async () => assert.fail("NPU must not be called");
  wm.transcribeViaServer = async () => ({ success: true, text: "cpu" });
  const result = await wm.transcribeLocalWhisper(Buffer.from("audio"), { model: MODEL_ID });
  assert.equal(result.backend, "cpu");
  assert.equal(result.fallbackReason, undefined);
});

test("NPU reuses the configured Silero model only when VAD is enabled", async () => {
  const wm = manager("npu");
  wm.getVadModelPath = () => "silero.bin";
  const requests = [];
  wm.npuManager.transcribe = async (_audio, options) => {
    requests.push(options);
    return { success: true, text: "speech", backend: "qnn-htp" };
  };
  await wm.transcribeLocalWhisper(Buffer.from("audio"), {
    model: MODEL_ID,
    vadEnabled: true,
    vadConfig: { threshold: 0.7 },
  });
  await wm.transcribeLocalWhisper(Buffer.from("audio"), { model: MODEL_ID, vadEnabled: false });
  assert.equal(requests[0].vadModelPath, "silero.bin");
  assert.equal(requests[0].vadConfig.threshold, 0.7);
  assert.equal(requests[1].vadModelPath, null);
});
