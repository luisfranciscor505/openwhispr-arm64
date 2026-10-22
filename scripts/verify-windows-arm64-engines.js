const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const root = path.resolve(__dirname, "..");
const cache = path.join(root, ".cache", "arm64");
const reportPath = path.join(root, "artifacts", "windows-arm64", "engine-verification.json");

async function verify() {
  const report = {};
  const { WhisperNpuManager } = require("../src/helpers/whisperNpu");
  const npu = new WhisperNpuManager(() => path.join(cache, "verification-models"));
  const originalRequest = npu.request.bind(npu);
  npu.request = (op, payload, options) =>
    originalRequest(
      op,
      op === "load"
        ? { ...payload, profileDir: path.join(cache, "cancellation-profiles") }
        : payload,
      options
    );
  const LlamaServer = require("../src/helpers/llamaServer");
  const llama = new LlamaServer();
  const worker = require("../src/helpers/onnxWorkerClient");
  const DiarizationManager = require("../src/helpers/diarization");
  const diarization = new DiarizationManager();
  diarization.getBundledModelsDir = () => path.join(root, "resources", "bin", "diarization-models");
  try {
    assert.equal((await npu.probe()).available, true);
    const controller = new AbortController();
    const request = npu.request(
      "transcribe",
      { audioPath: path.join(cache, "long.pcm"), language: "en" },
      { signal: controller.signal }
    );
    const timer = setTimeout(() => controller.abort(), 25);
    await assert.rejects(request, /cancelled/);
    clearTimeout(timer);
    report.npuCancellation = true;
    assert.equal((await npu.probe()).available, true);
    npu.unavailableReason = "previous request failed";
    const recovered = await npu.transcribe(fs.readFileSync(path.join(cache, "fox.wav")), {
      language: "en",
    });
    assert.match(recovered.text, /quick brown fox/i);
    assert.equal(npu.unavailableReason, null);
    report.npuRecovery = recovered;
    await npu.stop();

    await worker.request("speaker.load", {
      modelPath: path.join(
        root,
        "resources",
        "bin",
        "diarization-models",
        "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx"
      ),
    });
    const pcm = fs.readFileSync(path.join(cache, "fox.pcm"));
    const samples = Float32Array.from(
      new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2),
      (value) => value / 32768
    );
    const speaker = await worker.request("speaker.extract", { samplesBuffer: samples.buffer });
    const embedding = new Float32Array(speaker.embeddingBuffer);
    assert.ok(embedding.length > 0 && embedding.every(Number.isFinite));
    report.speakerEmbeddingDimensions = embedding.length;
    await worker.stop();
    const { promisify } = require("util");
    const { execFile } = require("child_process");
    const diarizationWav = path.join(cache, "diarization-16k.wav");
    await promisify(execFile)(
      require("../src/helpers/ffmpegUtils").getFFmpegPath(),
      [
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-i",
        path.join(cache, "long.wav"),
        "-ar",
        "16000",
        "-ac",
        "1",
        diarizationWav,
      ],
      { windowsHide: true }
    );
    report.diarization = await diarization.diarize(diarizationWav);
    assert.ok(
      report.diarization.length > 0,
      "Diarization must detect speech in the reference recording"
    );

    const model = path.join(cache, "LFM2.5-230M-Q8_0.gguf");
    if (!fs.existsSync(model))
      await require("../src/helpers/downloadUtils").downloadFile(
        "https://huggingface.co/LiquidAI/LFM2.5-230M-GGUF/resolve/main/LFM2.5-230M-Q8_0.gguf",
        model,
        { timeout: 600000 }
      );
    await llama.start(model, { contextSize: 2048, threads: 4 });
    report.localReasoning = await llama.inference(
      [{ role: "user", content: "Say hello in one short sentence." }],
      { max_tokens: 64, temperature: 0 }
    );
    assert.equal(typeof report.localReasoning, "string");
    assert.ok(report.localReasoning.trim());
    report.reasoningBackend = llama.activeBackend;
    assert.equal(report.reasoningBackend, "cpu");
    report.success = true;
  } catch (error) {
    report.success = false;
    report.error = error.stack;
    throw error;
  } finally {
    await Promise.allSettled([npu.stop(), llama.stop(), worker.stop(), diarization.shutdown()]);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
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
