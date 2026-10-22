// Run with native ARM64 Node after installing the unsigned local build.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const assert = require("assert/strict");
const { spawn } = require("child_process");
const { assertPeArchitecture } = require("../src/helpers/peArchitecture");
const { WhisperNpuManager } = require("../src/helpers/whisperNpu");

const root = path.resolve(__dirname, "..");
const installDir = process.argv[2] || path.join(process.env.LOCALAPPDATA, "Programs", "OpenWhispr");
const unpacked = path.join(root, "dist-arm64", "win-arm64-unpacked");
const output = path.join(root, "artifacts", "windows-arm64");
const profileDir = path.join(output, "installed-npu-profiles", String(Date.now()));
const report = { date: new Date().toISOString(), installDir, arch: process.arch };
report.profileDir = profileDir;
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function verify() {
  assert.equal(process.arch, "arm64");
  let checkedImages = 0;
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const source = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(source);
      else if (/\.(exe|dll|node)$/i.test(entry.name) || entry.name === "app.asar") {
        const installed = path.join(installDir, path.relative(unpacked, source));
        assert.equal(hash(installed), hash(source), `Installed bytes differ: ${installed}`);
        if (entry.name !== "app.asar") {
          assertPeArchitecture(installed);
          checkedImages++;
        }
      }
    }
  }
  visit(unpacked);
  report.checkedImages = checkedImages;
  report.installedBytesMatch = true;
  // No compiler, Python, SDK, repository DLL directory, or developer PATH.
  const manager = new WhisperNpuManager(
    () => path.join(process.env.USERPROFILE, ".cache", "openwhispr", "whisper-models"),
    {
      spawn: (exe, args, options) =>
        spawn(exe, args, {
          ...options,
          env: {
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            PATH: path.join(process.env.SystemRoot, "System32"),
          },
        }),
    }
  );
  manager.getRuntimeDir = () => path.join(installDir, "resources", "bin", "whisper-npu");
  const request = manager.request.bind(manager);
  manager.request = (op, payload, options) =>
    request(op, op === "load" ? { ...payload, profileDir } : payload, options);
  try {
    report.npu = await manager.probe();
    assert.equal(report.npu.available, true, report.npu.unavailableReason);
    report.transcription = await manager.request("transcribe", {
      audioPath: path.join(root, ".cache", "arm64", "fox.pcm"),
      language: "en",
    });
    assert.equal(report.transcription.backend, "qnn-htp");
    assert.equal(report.transcription.text.trim(), "The quick brown fox jumps over the lazy dog.");
  } finally {
    await manager.stop();
  }
  report.profiles = fs
    .readdirSync(profileDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const events = JSON.parse(fs.readFileSync(path.join(profileDir, file), "utf8"));
      const kernels = events.filter((event) => event.args?.provider);
      assert.ok(kernels.length > 0);
      assert.ok(kernels.every((event) => event.args.provider === "QNNExecutionProvider"));
      return { file, provider: "QNNExecutionProvider", kernels: kernels.length };
    });
  assert.ok(report.profiles.some((p) => p.file.startsWith("encoder")));
  assert.ok(report.profiles.some((p) => p.file.startsWith("decoder")));
  const incompatible = fs.mkdtempSync(path.join(os.tmpdir(), "ow-invalid-qnn-"));
  try {
    fs.copyFileSync(
      path.join(manager.modelDir, "encoder.onnx"),
      path.join(incompatible, "encoder.onnx")
    );
    fs.writeFileSync(path.join(incompatible, "encoder.bin"), "invalid QNN context");
    await assert.rejects(
      manager.request(
        "load",
        {
          modelDir: incompatible,
          runtimeDir: manager.getRuntimeDir(),
        },
        { timeout: 30000 }
      ),
      (error) => {
        report.incompatibleContextError = error.message;
        return true;
      }
    );
    report.incompatibleContextRejected = true;
  } finally {
    await manager.stop();
    fs.rmSync(incompatible, { recursive: true, force: true });
  }
  const missing = new WhisperNpuManager(() => path.join(incompatible, "missing"));
  report.missingModel = await missing.probe();
  assert.equal(report.missingModel.available, false);
  assert.match(report.missingModel.unavailableReason, /not downloaded/);
  report.success = true;
}

fs.mkdirSync(output, { recursive: true });
verify()
  .catch((error) => {
    report.success = false;
    report.error = error.stack;
    process.exitCode = 1;
  })
  .finally(() => {
    fs.writeFileSync(
      path.join(output, "installation-verification.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify(report, null, 2));
  });
