const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { performance } = require("perf_hooks");
const { WhisperNpuManager } = require("../src/helpers/whisperNpu");

const root = path.resolve(__dirname, "..");
const cache = path.join(root, ".cache", "arm64");
const vad = process.argv.includes("--vad");
const output = path.join(
  root,
  "artifacts",
  "windows-arm64",
  vad ? "long-audio-vad-verification.json" : "long-audio-verification.json"
);
const manager = new WhisperNpuManager(() => path.join(cache, "verification-models"));
const report = { date: new Date().toISOString(), vad, arch: process.arch };

async function verify() {
  try {
    const reference = fs.readFileSync(path.join(cache, "fox.pcm"));
    const repeats = 120;
    // Repeat complete sentences, retaining the original trailing silence.
    const pcm = Buffer.concat(Array(repeats).fill(reference));
    report.durationSeconds = pcm.length / 32000;
    const header = Buffer.alloc(44);
    header.write("RIFF");
    header.writeUInt32LE(pcm.length + 36, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    const start = performance.now();
    const result = await manager.transcribe(Buffer.concat([header, pcm]), {
      language: "en",
      ...(vad
        ? {
            vadModelPath: path.join(
              root,
              "resources",
              "bin",
              "whisper-vad",
              "ggml-silero-v5.1.2.bin"
            ),
          }
        : {}),
    });
    report.elapsedMilliseconds = Math.round(performance.now() - start);
    report.realTimeFactor = report.elapsedMilliseconds / 1000 / report.durationSeconds;
    assert.equal(result.backend, "qnn-htp");
    assert.ok(result.segments.length >= 59);
    assert.ok(
      result.segments.every(
        (segment, i) =>
          segment.start >= 0 &&
          segment.end > segment.start &&
          segment.end <= report.durationSeconds + 0.01 &&
          (!i || segment.start >= result.segments[i - 1].end)
      )
    );
    report.segmentCount = result.segments.length;
    report.expectedSentences = repeats;
    report.completeReferenceSentences = (
      result.text.match(/the quick brown fox jumps over the lazy dog/gi) || []
    ).length;
    report.text = result.text;
    report.segments = result.segments;
    const normalized = result.text
      .toLowerCase()
      .replace(/[^a-z ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    assert.equal(
      normalized,
      Array(repeats).fill("the quick brown fox jumps over the lazy dog").join(" "),
      "Long audio must preserve every reference word in order"
    );
    report.success = true;
  } catch (error) {
    report.success = false;
    report.error = error.stack;
    throw error;
  } finally {
    await manager.stop();
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
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
