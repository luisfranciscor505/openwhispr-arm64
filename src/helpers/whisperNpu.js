const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { createInterface } = require("readline");
const { promisify } = require("util");
const { execFile } = require("child_process");
const manifest = require("../models/whisperNpuManifest.json");
const { assertPeArchitecture } = require("./peArchitecture");
const { createAbortError } = require("./abortError");

const MODEL_ID = manifest.id;
const isSupported = (platform = process.platform, arch = process.arch) =>
  platform === "win32" && arch === "arm64";
const requiredFiles = [
  "encoder.onnx",
  "encoder.bin",
  "decoder.onnx",
  "decoder.bin",
  "tokenizer.json",
  "metadata.json",
  "LICENSE.txt",
];

function resolvePreference(value) {
  const preference = value || "automatic";
  if (!["automatic", "npu", "cpu"].includes(preference))
    throw new Error("Acceleration must be automatic, npu, or cpu");
  return preference;
}

class WhisperNpuManager {
  constructor(getModelRoot, dependencies = {}) {
    this.getModelRoot = getModelRoot;
    this.spawn = dependencies.spawn || spawn;
    this.child = null;
    this.nextId = 0;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.loaded = false;
    this.activeBackend = null;
    this.unavailableReason = null;
    this.downloadController = null;
  }

  get modelDir() {
    return path.join(this.getModelRoot(), MODEL_ID);
  }
  get preferencePath() {
    return path.join(this.getModelRoot(), "npu-acceleration.json");
  }
  get preference() {
    try {
      return resolvePreference(JSON.parse(fs.readFileSync(this.preferencePath, "utf8")).preference);
    } catch {
      return "automatic";
    }
  }
  setPreference(value) {
    const preference = resolvePreference(value);
    fs.mkdirSync(this.getModelRoot(), { recursive: true });
    const temporary = `${this.preferencePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ preference }));
    fs.renameSync(temporary, this.preferencePath);
    return preference;
  }
  isDownloaded() {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(this.modelDir, "install.json"), "utf8"));
      return (
        marker.sha256 === manifest.sha256 &&
        requiredFiles.every((name) => fs.statSync(path.join(this.modelDir, name)).isFile())
      );
    } catch {
      return false;
    }
  }
  getRuntimeDir() {
    const candidates = [
      ...(process.resourcesPath ? [path.join(process.resourcesPath, "bin", "whisper-npu")] : []),
      path.join(__dirname, "..", "..", "resources", "bin", "whisper-npu"),
    ];
    const runtime = candidates.find((dir) => fs.existsSync(path.join(dir, "whisper-npu.exe")));
    if (!runtime)
      throw new Error("The ARM64 NPU helper is missing. Rebuild with npm run build:win:arm64.");
    for (const file of [
      "onnxruntime.dll",
      "onnxruntime_providers_qnn.dll",
      "QnnHtp.dll",
      "QnnHtpV73Stub.dll",
      "libQnnHtpV73Skel.so",
    ]) {
      if (!fs.existsSync(path.join(runtime, file)))
        throw new Error(`NPU runtime file ${file} is missing. Reinstall the ARM64 build.`);
    }
    assertPeArchitecture(path.join(runtime, "whisper-npu.exe"));
    return runtime;
  }
  status() {
    return {
      supported: isSupported(),
      downloaded: this.isDownloaded(),
      available: this.loaded,
      preference: this.preference,
      backend: this.activeBackend,
      unavailableReason: this.unavailableReason,
      model: MODEL_ID,
      profileDir: path.join(this.getModelRoot(), "npu-profiles"),
    };
  }
  enqueue(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  ensureProcess() {
    if (this.child) return;
    if (!isSupported()) throw new Error("Snapdragon NPU transcription requires Windows ARM64.");
    const runtimeDir = this.getRuntimeDir();
    const child = this.spawn(path.join(runtimeDir, "whisper-npu.exe"), [], {
      cwd: runtimeDir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let diagnostics = "";
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending || pending.child !== child) return;
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    child.stderr.on("data", (data) => {
      diagnostics = (diagnostics + data.toString()).slice(-4096);
    });
    const fail = (error) => {
      lines.close();
      if (this.child === child) {
        this.child = null;
        this.loaded = false;
        this.activeBackend = null;
        this.unavailableReason = error.message;
      }
      for (const pending of this.pending.values())
        if (pending.child === child) pending.reject(error);
    };
    child.once("error", fail);
    child.stdin.on("error", fail);
    child.once("exit", (code) => fail(new Error(`NPU helper exited (${code}). ${diagnostics}`)));
  }
  request(op, payload = {}, { signal, timeout = 120000 } = {}) {
    if (signal?.aborted) return Promise.reject(createAbortError("NPU transcription cancelled"));
    this.ensureProcess();
    const child = this.child;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const settle = (callback, value) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = () => {
        child.stdin.write(JSON.stringify({ op: "cancel", id }) + "\n");
        // Terminate to guarantee cancellation even while a driver call is blocked.
        child.kill();
        if (this.child === child) {
          this.child = null;
          this.loaded = false;
          this.activeBackend = null;
        }
        settle(reject, createAbortError("NPU transcription cancelled"));
      };
      const timer = setTimeout(() => {
        child.kill();
        if (this.child === child) {
          this.child = null;
          this.loaded = false;
          this.activeBackend = null;
        }
        settle(reject, new Error(`NPU ${op} timed out`));
      }, timeout);
      this.pending.set(id, {
        child,
        resolve: (value) => settle(resolve, value),
        reject: (error) => settle(reject, error),
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      child.stdin.write(JSON.stringify({ id, op, ...payload }) + "\n", (error) => {
        if (error) settle(reject, error);
      });
    });
  }
  async load(signal) {
    if (this.loaded) return this.status();
    if (!this.isDownloaded())
      throw new Error(
        "Whisper Base Snapdragon NPU model is not downloaded. Download it in Settings."
      );
    const result = await this.request(
      "load",
      {
        modelDir: this.modelDir,
        runtimeDir: this.getRuntimeDir(),
        profileDir: path.join(this.getModelRoot(), "npu-profiles"),
      },
      { signal }
    );
    if (result.backend !== "qnn-htp" || !result.available)
      throw new Error("The helper did not verify NPU inference");
    this.loaded = true;
    this.activeBackend = "qnn-htp";
    this.unavailableReason = null;
    return this.status();
  }
  async probe() {
    return this.enqueue(async () => {
      try {
        await this.load();
      } catch (error) {
        this.unavailableReason = error.message;
        this.activeBackend = null;
      }
      return this.status();
    });
  }
  async transcribe(audio, options = {}) {
    return this.enqueue(async () => {
      const signal = options.signal;
      if (signal?.aborted) throw createAbortError("NPU transcription cancelled");
      if (options.initialPrompt)
        throw new Error(
          "NPU Whisper Base does not support initial prompts; select Automatic or CPU to use this feature."
        );
      await this.load(signal);
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openwhispr-npu-"));
      try {
        const input = path.join(dir, "input.audio");
        const output = path.join(dir, "audio.pcm");
        let buffer;
        if (Buffer.isBuffer(audio)) buffer = audio;
        else if (typeof audio === "string") buffer = Buffer.from(audio, "base64");
        else if (ArrayBuffer.isView(audio))
          buffer = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
        else buffer = Buffer.from(audio);
        if (!buffer.length) throw new Error("Audio buffer is empty");
        await fs.promises.writeFile(input, buffer);
        await promisify(execFile)(
          require("./ffmpegUtils").getFFmpegPath(),
          [
            "-nostdin",
            "-y",
            "-v",
            "error",
            "-i",
            input,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-f",
            "s16le",
            output,
          ],
          { signal, windowsHide: true, timeout: 120000 }
        );
        const result = await this.request(
          "transcribe",
          {
            audioPath: output,
            language: options.language || "auto",
            translate: options.translate === true,
            ...(options.vadModelPath
              ? {
                  vadModelPath: options.vadModelPath,
                  vadConfig: require("./whisperVadConfig").sanitizeWhisperVadConfig(
                    options.vadConfig
                  ),
                }
              : {}),
          },
          { signal, timeout: 600000 }
        );
        if (result.backend !== "qnn-htp")
          throw new Error("NPU inference returned an unexpected backend");
        this.activeBackend = "qnn-htp";
        this.unavailableReason = null;
        return { ...result, text: result.text.replace(/\s+/g, " ").trim() };
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    });
  }
  async download(onProgress) {
    if (!isSupported()) throw new Error("The Snapdragon model requires Windows ARM64.");
    if (this.downloadController)
      throw Object.assign(new Error("NPU model download already in progress"), {
        code: "DOWNLOAD_IN_PROGRESS",
      });
    const controller = new AbortController();
    this.downloadController = controller;
    const parent = this.getModelRoot();
    let stage;
    const signal = controller.signal;
    try {
      fs.mkdirSync(parent, { recursive: true });
      stage = await fs.promises.mkdtemp(path.join(parent, ".npu-download-"));
      const { downloadFile } = require("./downloadUtils");
      const archive = path.join(stage, "model.zip");
      await downloadFile(manifest.url, archive, {
        signal,
        expectedSize: manifest.size,
        timeout: 600000,
        onProgress: (downloaded, total) =>
          onProgress?.({
            type: "progress",
            model: MODEL_ID,
            percentage: total ? Math.floor((downloaded / total) * 95) : 0,
            downloaded_bytes: downloaded,
            total_bytes: total,
          }),
      });
      const hash = crypto
        .createHash("sha256")
        .update(await fs.promises.readFile(archive))
        .digest("hex");
      if (hash !== manifest.sha256) throw new Error("NPU model archive checksum mismatch");
      onProgress?.({ type: "installing", model: MODEL_ID, percentage: 95 });
      await require("unzipper")
        .Open.file(archive)
        .then((zip) => zip.extract({ path: stage }));
      if (signal.aborted) throw createAbortError("NPU model download cancelled");
      const model = path.join(stage, manifest.directory);
      await downloadFile(manifest.tokenizerUrl, path.join(model, "tokenizer.json"), {
        signal,
        timeout: 120000,
      });
      const tokenizerHash = crypto
        .createHash("sha256")
        .update(await fs.promises.readFile(path.join(model, "tokenizer.json")))
        .digest("hex");
      if (tokenizerHash !== manifest.tokenizerSha256)
        throw new Error("NPU tokenizer checksum mismatch");
      await downloadFile(manifest.licenseUrl, path.join(model, "LICENSE.txt"), {
        signal,
        timeout: 120000,
      });
      const licenseHash = crypto
        .createHash("sha256")
        .update(await fs.promises.readFile(path.join(model, "LICENSE.txt")))
        .digest("hex");
      if (licenseHash !== manifest.licenseSha256)
        throw new Error("NPU model license checksum mismatch");
      await fs.promises.writeFile(
        path.join(model, "install.json"),
        JSON.stringify(manifest, null, 2)
      );
      await this.stop();
      await fs.promises.rm(this.modelDir, { recursive: true, force: true });
      await fs.promises.rename(model, this.modelDir);
      onProgress?.({ type: "complete", model: MODEL_ID, percentage: 100 });
      return {
        success: true,
        model: MODEL_ID,
        downloaded: true,
        size_mb: Math.round(manifest.size / 1048576),
      };
    } catch (error) {
      if (signal.aborted)
        throw Object.assign(createAbortError("NPU model download cancelled"), {
          code: "DOWNLOAD_CANCELLED",
        });
      throw error;
    } finally {
      this.downloadController = null;
      if (stage) await fs.promises.rm(stage, { recursive: true, force: true });
    }
  }
  cancelDownload() {
    this.downloadController?.abort();
  }
  async stop() {
    if (this.child) {
      try {
        await this.request("unload", {}, { timeout: 5000 });
      } catch {
        /* termination below also handles failed drivers */
      }
      const child = this.child;
      this.child = null;
      child?.stdin.end();
      child?.kill();
    }
    this.loaded = false;
    this.activeBackend = null;
  }
}

module.exports = { WhisperNpuManager, MODEL_ID, isSupported, resolvePreference };
