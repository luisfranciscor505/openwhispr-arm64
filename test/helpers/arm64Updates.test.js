const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const {
  APP_ID,
  REPOSITORY,
  assetUrl,
  verifyManifest,
  verifyInstaller,
} = require("../../src/helpers/arm64UpdateManifest");
const { signedEnvelope } = require("../../scripts/lib/arm64-release");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" });
const bytes = Buffer.from("test installer");
const manifest = () => ({
  schema: 1,
  appId: APP_ID,
  repository: REPOSITORY,
  platform: "win32",
  arch: "arm64",
  version: "1.10.4-arm64.2",
  sourceCommit: "a".repeat(40),
  upstreamCommit: "b".repeat(40),
  installer: {
    url: assetUrl("1.10.4-arm64.2", "OpenWhispr-1.10.4-arm64.2-windows-arm64.exe"),
    size: bytes.length,
    sha512: crypto.createHash("sha512").update(bytes).digest("base64"),
  },
});
const check = (value) => verifyManifest(signedEnvelope(value, privateKey), pem, "1.10.4-arm64.1");

test("accepts authenticated ARM64 metadata and equal current version", () => {
  assert.equal(check(manifest()).arch, "arm64");
  assert.equal(
    verifyManifest(signedEnvelope(manifest(), privateKey), pem, "1.10.4-arm64.2").version,
    manifest().version
  );
});
test("rejects tampered payload, wrong key, architecture, source identity, URLs and downgrades", () => {
  const signed = signedEnvelope(manifest(), privateKey);
  signed.payload = Buffer.from(JSON.stringify({ ...manifest(), arch: "x64" })).toString("base64");
  assert.throws(() => verifyManifest(signed, pem, "1.0.0"), /signature/);
  const wrong = crypto.generateKeyPairSync("ed25519").publicKey;
  assert.throws(
    () =>
      verifyManifest(
        signedEnvelope(manifest(), privateKey),
        wrong.export({ type: "spki", format: "pem" }),
        "1.0.0"
      ),
    /signature/
  );
  for (const change of [
    { arch: "x64" },
    { platform: "darwin" },
    { appId: "other" },
    { repository: "OpenWhispr/openwhispr" },
    { sourceCommit: "no" },
    { version: "1.10.5-beta.1" },
  ])
    assert.throws(() => check({ ...manifest(), ...change }), /Incompatible/);
  for (const url of [
    "https://evil.example/update.exe",
    manifest().installer.url + "?token=anything",
    "https://github.com/OpenWhispr/openwhispr/releases/download/v1.10.4/update.exe",
  ])
    assert.throws(
      () => check({ ...manifest(), installer: { ...manifest().installer, url } }),
      /Unauthorized/
    );
  assert.throws(
    () => verifyManifest(signedEnvelope(manifest(), privateKey), pem, "1.10.5-arm64.1"),
    /downgrade/
  );
});
test("rechecks cached file bytes including same-size tampering", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arm64-update-test-"));
  const file = path.join(dir, "update.exe");
  try {
    fs.writeFileSync(file, bytes);
    await verifyInstaller(file, manifest());
    fs.writeFileSync(file, Buffer.alloc(bytes.length));
    await assert.rejects(verifyInstaller(file, manifest()), /checksum/);
    fs.writeFileSync(file, "interrupted");
    await assert.rejects(verifyInstaller(file, manifest()), /size/);
    await assert.rejects(verifyInstaller(file, null), /No verified/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("provider returns only signed file metadata and propagates offline/invalid feed errors", async () => {
  const { Arm64UpdateProvider } = require("../../src/helpers/arm64UpdateProvider");
  let verified;
  const provider = new Arm64UpdateProvider(
    {
      publicKey: pem,
      onVerified: (m) => {
        verified = m;
      },
    },
    { currentVersion: { version: "1.10.4-arm64.1" } },
    { executor: {} }
  );
  provider.httpRequest = async () => JSON.stringify(signedEnvelope(manifest(), privateKey));
  const info = await provider.getLatestVersion();
  info.files[0].url = "https://evil.example/test.exe";
  assert.equal(provider.resolveFiles(info)[0].url.href, manifest().installer.url);
  assert.equal(verified.sourceCommit, manifest().sourceCommit);
  assert.throws(() => provider.resolveFiles({ version: "unverified" }), /authenticated/);
  provider.httpRequest = async () => {
    throw new Error("offline");
  };
  await assert.rejects(provider.getLatestVersion(), /offline/);
  provider.httpRequest = async () => JSON.stringify({ payload: "e30=", signature: "invalid" });
  await assert.rejects(provider.getLatestVersion(), /signature/);
});
test("managed updater prompts for restart, honors activity, and verifies before installation", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const originalLoad = Module._load;
  const modulePath = require.resolve("../../src/updater");
  const listeners = {};
  let installs = 0,
    prepared = 0;
  const updater = {
    setFeedURL() {},
    on: (event, cb) => {
      listeners[event] = cb;
    },
    quitAndInstall: () => {
      installs++;
    },
    removeListener() {},
  };
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === modulePath && request === "../package.json")
      return {
        localArm64Build: true,
        arm64Release: { publicKey: pem, upstreamTag: "v1.10.4", portRevision: 1 },
      };
    if (request === "electron-updater") return { autoUpdater: updater };
    if (request === "electron") return { autoUpdater: { on() {}, removeListener() {} } };
    return originalLoad.call(this, request, parent, isMain);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arm64-updater-managed-"));
  try {
    delete require.cache[modulePath];
    const Manager = require(modulePath);
    const manager = new Manager();
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.autoDownload, false);
    manager.prepareInstall = async () => {
      prepared++;
    };
    const file = path.join(dir, "update.exe");
    fs.writeFileSync(file, bytes);
    manager.verifiedManifests.set(manifest().version, check(manifest()));
    listeners["update-downloaded"]({ version: manifest().version, downloadedFile: file });
    manager.canInstall = () => false;
    assert.equal((await manager.installUpdate()).success, false);
    assert.equal(installs, 0);
    assert.equal(prepared, 0);
    manager.canInstall = () => true;
    fs.writeFileSync(file, Buffer.alloc(bytes.length));
    await assert.rejects(manager.installUpdate(), /checksum/);
    assert.equal(installs, 0);
    fs.writeFileSync(file, bytes);
    assert.equal((await manager.installUpdate()).success, true);
    assert.equal(installs, 1);
    assert.equal(prepared, 1);
    manager.cleanup();
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    delete require.cache[modulePath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
