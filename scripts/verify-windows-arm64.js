// Run with Electron: npx electron scripts/verify-windows-arm64.js
// Uses isolated test models under .cache; does not change the user's settings.
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { assertPeArchitecture } = require("../src/helpers/peArchitecture");

const root = path.resolve(__dirname, "..");
const cache = path.join(root, ".cache", "arm64");
const output = path.join(root, "artifacts", "windows-arm64");
app.commandLine.appendSwitch("disable-gpu");

async function timed(work) {
  const start = performance.now();
  const result = await work();
  return { milliseconds: Math.round(performance.now() - start), result };
}
async function verify() {
  if (process.platform !== "win32" || process.arch !== "arm64")
    throw new Error("Run using native Windows ARM64 Electron");
  fs.mkdirSync(output, { recursive: true });
  const WhisperManager = require("../src/helpers/whisper");
  const wm = new WhisperManager();
  wm.getModelsDir = () => path.join(cache, "verification-models");
  fs.rmSync(path.join(wm.getModelsDir(), "npu-profiles"), { recursive: true, force: true });
  const report = {
    date: new Date().toISOString(),
    electron: process.versions.electron,
    arch: process.arch,
    checks: {},
  };
  try {
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    if (db.prepare("select 1 as value").get().value !== 1) throw new Error("SQLite failed");
    db.close();
    report.checks.sqlite = true;
    report.checks.keyringModule = !!require("@napi-rs/keyring");
    report.checks.onnxBackends = require("onnxruntime-node").listSupportedBackends();
    const embeddings = require("../src/helpers/localEmbeddings");
    const embedding = await embeddings.embedText("Windows ARM64 native inference verification");
    if (embedding.length !== 384 || !embedding.every(Number.isFinite))
      throw new Error("Text embedding inference failed");
    report.checks.textEmbeddingDimensions = embedding.length;
    await embeddings.unload();
    const { downloadFile } = require("../src/helpers/downloadUtils");
    const clip = path.join(cache, "fox.wav");
    if (!fs.existsSync(clip))
      await downloadFile(
        "https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/hf_whisper_asr_shared/v1/audio/fox.wav",
        clip
      );
    if (!wm.npuManager.isDownloaded()) await wm.downloadWhisperModel("base-snapdragon-npu");
    else if (!wm.isModelDownloaded("base")) await wm.downloadWhisperModel("base");
    const audio = fs.readFileSync(clip);
    report.npuLoad = await timed(() => wm.npuManager.probe());
    if (!report.npuLoad.result.available) throw new Error(report.npuLoad.result.unavailableReason);
    report.npuFirst = await timed(() => wm.npuManager.transcribe(audio, { language: "en" }));
    report.npuWarm = await timed(() => wm.npuManager.transcribe(audio, { language: "en" }));
    report.npuAutomaticLanguage = await timed(() =>
      wm.npuManager.transcribe(audio, { language: "auto" })
    );
    report.npuVad = await timed(() =>
      wm.npuManager.transcribe(audio, { language: "en", vadModelPath: wm.getVadModelPath() })
    );
    if (!/quick brown fox jumps over the lazy dog/i.test(report.npuVad.result.text))
      throw new Error("VAD speech recognition lost the reference sentence");
    const silenceHeader = Buffer.alloc(44);
    const silenceBytes = 5 * 32000;
    silenceHeader.write("RIFF");
    silenceHeader.writeUInt32LE(silenceBytes + 36, 4);
    silenceHeader.write("WAVEfmt ", 8);
    silenceHeader.writeUInt32LE(16, 16);
    silenceHeader.writeUInt16LE(1, 20);
    silenceHeader.writeUInt16LE(1, 22);
    silenceHeader.writeUInt32LE(16000, 24);
    silenceHeader.writeUInt32LE(32000, 28);
    silenceHeader.writeUInt16LE(2, 32);
    silenceHeader.writeUInt16LE(16, 34);
    silenceHeader.write("data", 36);
    silenceHeader.writeUInt32LE(silenceBytes, 40);
    report.npuVadSilence = await timed(() =>
      wm.npuManager.transcribe(Buffer.concat([silenceHeader, Buffer.alloc(silenceBytes)]), {
        language: "en",
        vadModelPath: wm.getVadModelPath(),
      })
    );
    if (report.npuVadSilence.result.text || report.npuVadSilence.result.segments.length)
      throw new Error("VAD must reject silent audio");
    if (fs.existsSync(path.join(cache, "spanish.wav"))) {
      report.spanish = await timed(() =>
        wm.npuManager.transcribe(fs.readFileSync(path.join(cache, "spanish.wav")), {
          language: "es",
        })
      );
      if (!/prueba/i.test(report.spanish.result.text))
        throw new Error("Spanish speech test did not recognize the reference sentence");
    }
    if (fs.existsSync(path.join(cache, "long.wav"))) {
      report.longRecording = await timed(() =>
        wm.npuManager.transcribe(fs.readFileSync(path.join(cache, "long.wav")), { language: "en" })
      );
      const segments = report.longRecording.result.segments;
      if (
        segments.length < 3 ||
        segments.some((segment, i) => i && segment.start < segments[i - 1].end)
      )
        throw new Error("Long recording chunk timestamps are invalid");
    }
    report.cpuFirst = await timed(() =>
      wm.transcribeViaServer(audio, "base", "en", null, { forceCpu: true })
    );
    report.cpuWarm = await timed(() =>
      wm.transcribeViaServer(audio, "base", "en", null, { forceCpu: true })
    );
    const expected = "the quick brown fox jumps over the lazy dog";
    for (const key of ["npuFirst", "npuWarm", "npuAutomaticLanguage", "cpuFirst", "cpuWarm"]) {
      const actual = report[key].result.text
        .toLowerCase()
        .replace(/[^a-z ]/g, "")
        .trim();
      report[key].matchesReference = actual === expected;
      report[key].realTimeFactor = report[key].milliseconds / 4926.6875;
      if (!report[key].matchesReference)
        throw new Error(`${key}: reference transcription differed`);
    }
    await wm.stopServer();
    const fft = await promisify(execFile)(
      path.join(root, "resources", "bin", "whisper-npu", "whisper-npu.exe"),
      ["--self-test"],
      { windowsHide: true, timeout: 10000 }
    );
    report.checks.fft = JSON.parse(fft.stdout);
    if (!report.checks.fft.success) throw new Error("Whisper feature FFT self-test failed");
    const profileDir = path.join(wm.getModelsDir(), "npu-profiles");
    const profiles = fs.readdirSync(profileDir).filter((file) => file.endsWith(".json"));
    report.qnnProfiles = [];
    for (const file of profiles) {
      const source = path.join(profileDir, file);
      const events = JSON.parse(fs.readFileSync(source, "utf8"));
      const kernels = events.filter((event) => event.args?.provider);
      if (
        !kernels.length ||
        kernels.some((event) => event.args.provider !== "QNNExecutionProvider")
      )
        throw new Error("Model graph used a non-QNN provider");
      fs.copyFileSync(source, path.join(output, file));
      report.qnnProfiles.push({
        file,
        provider: "QNNExecutionProvider",
        kernelEvents: kernels.length,
      });
    }
    if (
      !report.qnnProfiles.some((p) => p.file.startsWith("encoder")) ||
      !report.qnnProfiles.some((p) => p.file.startsWith("decoder"))
    )
      throw new Error("Missing encoder/decoder profiling evidence");
    for (const [name, args] of Object.entries({
      "windows-system-audio-helper.exe": ["probe"],
      "yt-dlp-win32-arm64.exe": ["--version"],
      "llama-server-win32-arm64-cpu.exe": ["--version"],
      "qdrant-win32-arm64.exe": ["--version"],
    })) {
      const binary = path.join(root, "resources", "bin", name);
      if (!fs.existsSync(binary)) throw new Error(`Missing bundled binary ${name}`);
      assertPeArchitecture(binary);
      const result = await promisify(execFile)(binary, args, { windowsHide: true, timeout: 30000 });
      report.checks[name] = result.stdout.trim() || result.stderr.trim();
    }
    report.success = true;
  } catch (error) {
    report.success = false;
    report.error = error.stack;
    throw error;
  } finally {
    await wm.stopServer();
    await require("../src/helpers/onnxWorkerClient").stop();
    fs.writeFileSync(path.join(output, "verification.json"), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
}

app
  .whenReady()
  .then(verify)
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error);
      app.exit(1);
    }
  );
