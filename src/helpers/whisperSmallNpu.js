const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { createInterface } = require("node:readline");
const { promisify } = require("node:util");
const { app } = require("electron");
const { convertBufferToWav, isPcm16Mono16kWav } = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { assertPeArchitecture } = require("./peArchitecture");
const { createAbortError } = require("./abortError");
const {
  checkDiskSpace,
  createDownloadSignal,
  downloadFile,
  extractArchive,
  findFile,
} = require("./downloadUtils");

const runFile = promisify(execFile);
const READY_TIMEOUT = 90000;
const REQUEST_TIMEOUT = 180000;

class WhisperSmallNpu {
  constructor() {
    this.hardware = null;
    this.installing = null;
    this.installAbort = null;
    this.starting = null;
    this.child = null;
    this.pending = null;
    this.lastError = null;
  }

  get workerPath() {
    const packaged =
      process.resourcesPath &&
      path.join(process.resourcesPath, "app.asar.unpacked", "src", "workers", "whisper-small.py");
    return packaged && fs.existsSync(packaged)
      ? packaged
      : path.join(__dirname, "..", "workers", "whisper-small.py");
  }

  async supported() {
    if (
      process.platform !== "win32" ||
      process.arch !== "arm64" ||
      !fs.existsSync(this.workerPath)
    ) {
      return false;
    }
    this.hardware ??= this.detectHardware();
    return this.hardware;
  }

  async detectHardware() {
    const powershell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    try {
      const { stdout } = await runFile(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "if (Get-PnpDevice -PresentOnly | Where-Object { $_.Status -eq 'OK' -and $_.FriendlyName -match 'Qualcomm.*Hexagon.*NPU' }) { 'present' }",
        ],
        { windowsHide: true, timeout: 7000 }
      );
      return stdout.trim() === "present";
    } catch {
      return false;
    }
  }

  get assets() {
    return require("./whisperSmallNpuAssets.json");
  }

  get root() {
    return path.join(app.getPath("userData"), "whisper-small-npu", this.assets.version);
  }

  get installed() {
    try {
      return fs.existsSync(path.join(this.root, "complete.json"));
    } catch {
      return false;
    }
  }

  async status() {
    const supported = await this.supported();
    return {
      supported,
      installed: supported && this.installed,
      enabled: supported && process.env.WHISPER_NPU_ENABLED === "true" && this.installed,
      active: supported && !!this.child && !this.starting,
      busy: !!this.installing,
      error: this.lastError,
    };
  }

  async prepare() {
    if (!(await this.supported())) throw new Error("No supported Qualcomm NPU was detected");
    this.lastError = null;
    if (!this.installed) {
      if (!this.installing) {
        this.installAbort = createDownloadSignal();
        this.installing = this.install(this.installAbort.signal).finally(() => {
          this.installing = null;
          this.installAbort = null;
        });
      }
      await this.installing;
    }
    await this.start();
  }

  cancelInstallation() {
    this.installAbort?.abort();
  }

  async install(signal) {
    const base = path.dirname(this.root);
    await fsp.mkdir(base, { recursive: true });
    const space = await checkDiskSpace(base, 2 * 1024 ** 3);
    if (!space.ok)
      throw new Error("At least 2 GB of free space is required to prepare Whisper NPU");
    const stage = await fsp.mkdtemp(path.join(base, "install-"));
    try {
      const runtime = path.join(stage, "runtime");
      const model = path.join(stage, "model");
      await fsp.mkdir(runtime);
      await fsp.mkdir(model);

      await this.extract(this.assets.python, runtime, stage, signal);
      for (const asset of this.assets.wheels) {
        await this.extract(asset, runtime, stage, signal);
      }
      await fsp.writeFile(path.join(runtime, this.assets.pythonPathFile), "python313.zip\n.\n");
      await this.fetch(this.assets.tokenizer, path.join(stage, "tokenizer.json"), signal);
      await this.extract(this.assets.model, model, stage, signal);

      const encoder = await findFile(model, "encoder.onnx");
      const decoder = await findFile(model, "decoder.onnx");
      if (
        !encoder ||
        !decoder ||
        !fs.existsSync(path.join(path.dirname(encoder), "encoder.bin")) ||
        !fs.existsSync(path.join(path.dirname(decoder), "decoder.bin"))
      ) {
        throw new Error("The Whisper NPU model package is incomplete");
      }
      assertPeArchitecture(path.join(runtime, "python.exe"));

      if (signal.aborted) throw createAbortError("Whisper NPU setup cancelled");
      await fsp.writeFile(
        path.join(stage, "complete.json"),
        JSON.stringify({
          encoder: path.relative(stage, encoder),
          decoder: path.relative(stage, decoder),
        })
      );
      await fsp.rename(stage, this.root);
    } finally {
      await fsp.rm(stage, { recursive: true, force: true });
    }
  }

  async fetch(asset, destination, signal) {
    await downloadFile(asset.url, destination, {
      expectedSize: asset.size,
      expectedSha256: asset.sha256,
      signal,
    });
  }

  async extract(asset, destination, stage, signal) {
    const archive = path.join(stage, "download.zip");
    await this.fetch(asset, archive, signal);
    await extractArchive(archive, destination);
    await fsp.unlink(archive);
  }

  start() {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve();
    this.starting = this.spawnWorker().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  spawnWorker() {
    const python = path.join(this.root, "runtime", "python.exe");
    assertPeArchitecture(python);
    const record = JSON.parse(fs.readFileSync(path.join(this.root, "complete.json"), "utf8"));
    const encoder = path.resolve(this.root, record.encoder);
    const decoder = path.resolve(this.root, record.decoder);
    const modelRoot = path.join(this.root, "model") + path.sep;
    if (![encoder, decoder].every((file) => file.startsWith(modelRoot))) {
      throw new Error("Invalid Whisper NPU installation");
    }
    const child = spawn(
      python,
      [
        "-I",
        this.workerPath,
        "--encoder",
        encoder,
        "--decoder",
        decoder,
        "--tokenizer",
        path.join(this.root, "tokenizer.json"),
      ],
      { cwd: this.root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
    this.child = child;
    return new Promise((resolve, reject) => {
      let stderr = "";
      let ready = false;
      const timer = setTimeout(
        () => fail(new Error("Whisper NPU startup timed out")),
        READY_TIMEOUT
      );
      const fail = (error) => {
        if (this.child !== child) return;
        clearTimeout(timer);
        this.child = null;
        this.pending?.reject(error);
        if (!ready) reject(error);
        child.kill();
      };
      child.once("error", fail);
      child.stdin.on("error", fail);
      child.once("close", (code) =>
        fail(new Error(stderr.trim() || "Whisper NPU exited (" + code + ")"))
      );
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (this.child !== child) return;
        let reply;
        try {
          reply = JSON.parse(line);
        } catch {
          return;
        }
        if (!ready && reply.ready === true) {
          ready = true;
          clearTimeout(timer);
          resolve();
        } else if (reply.id === 1 && this.pending) {
          if (typeof reply.text === "string") this.pending.resolve(reply.text);
          else this.pending.reject(new Error(reply.error || "Invalid Whisper NPU response"));
        }
      });
    });
  }

  stop() {
    // The close event rejects any in-flight startup or transcription.
    this.child?.kill();
  }

  async transcribe(audio, { language, prompt, vad, signal }) {
    if (signal?.aborted) throw createAbortError("Whisper NPU transcription cancelled");
    await this.start();
    const wav = isPcm16Mono16kWav(audio) ? audio : await convertBufferToWav(audio, { signal });
    const dir = await fsp.mkdtemp(path.join(getSafeTempDir(), "ow-whisper-npu-"));
    try {
      const file = path.join(dir, "speech.wav");
      await fsp.writeFile(file, wav);
      const text = await this.request({ wav: file, language, prompt, vad }, signal);
      this.lastError = null;
      return { text };
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  request(request, signal) {
    if (signal?.aborted) throw createAbortError("Whisper NPU transcription cancelled");
    if (!this.child || this.pending) throw new Error("Whisper NPU worker is busy or stopped");
    return new Promise((resolve, reject) => {
      const settle = (callback, value) => {
        if (!this.pending) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending = null;
        callback(value);
      };
      const abort = () => {
        this.stop();
        settle(reject, createAbortError("Whisper NPU transcription cancelled"));
      };
      const timer = setTimeout(() => {
        this.stop();
        settle(reject, new Error("Whisper NPU transcription timed out"));
      }, REQUEST_TIMEOUT);
      this.pending = {
        resolve: (text) => settle(resolve, text),
        reject: (error) => settle(reject, error),
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.child.stdin.write(JSON.stringify({ id: 1, ...request }) + "\n");
    });
  }
}

module.exports = WhisperSmallNpu;
