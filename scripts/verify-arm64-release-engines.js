const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { hash } = require("./lib/arm64-release");
const [installed, models, output, fixtureDirectory, profileDirectory] = process.argv.slice(2);
const appRoot = path.join(installed, "resources", "app.asar");
const profile = path.resolve(profileDirectory || path.join(path.dirname(output), "profile"));
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(path.join(path.dirname(output), "appdata"), { recursive: true });
app.setPath("userData", profile);
app.setPath("appData", path.join(path.dirname(output), "appdata"));
Object.defineProperty(process, "resourcesPath", { value: path.join(installed, "resources") });
app.setAppPath(appRoot);
const fixtures = path.resolve(
  fixtureDirectory || path.join(__dirname, "..", "test", "fixtures", "arm64-release")
);
const fixtureHashes = require("../test/fixtures/arm64-release/manifest.json");
app
  .whenReady()
  .then(async () => {
    const Whisper = require(path.join(appRoot, "src", "helpers", "whisper"));
    const whisper = new Whisper();
    whisper.getModelsDir = () => models;
    const npu = whisper.npuManager;
    const profiles = path.join(path.dirname(output), "profiles");
    const request = npu.request.bind(npu);
    npu.request = (op, payload, options) =>
      request(op, op === "load" ? { ...payload, profileDir: profiles } : payload, options);
    const result = {};
    try {
      for (const [name, expected] of Object.entries(fixtureHashes))
        assert.equal(hash(path.join(fixtures, name)), expected);
      const english = fs.readFileSync(path.join(fixtures, "fox.wav"));
      const spanish = fs.readFileSync(path.join(fixtures, "spanish.wav"));
      assert.equal((await npu.probe()).available, true);
      const en = await npu.transcribe(english, { language: "en" });
      const es = await npu.transcribe(spanish, { language: "es" });
      assert.match(en.text, /quick brown fox jumps over the lazy dog/i);
      assert.match(es.text, /prueba/i);
      assert.equal(en.backend, "qnn-htp");
      assert.equal(es.backend, "qnn-htp");
      await npu.stop();
      const graphs = new Set();
      result.npuProfiles = [];
      for (const file of fs.readdirSync(profiles).filter((name) => name.endsWith(".json"))) {
        const kernels = JSON.parse(fs.readFileSync(path.join(profiles, file))).filter(
          (event) => event.args?.provider
        );
        assert.ok(kernels.length > 0);
        assert.ok(kernels.every((event) => event.args.provider === "QNNExecutionProvider"));
        if (file.startsWith("encoder")) graphs.add("encoder");
        if (file.startsWith("decoder")) graphs.add("decoder");
        result.npuProfiles.push({
          graph: file.startsWith("encoder") ? "encoder" : "decoder",
          provider: "QNNExecutionProvider",
          kernels: kernels.length,
        });
      }
      assert.equal(graphs.size, 2);
      result.npu = true;
      result.multilingual = true;
      result.referenceTranscripts = { en: en.text, es: es.text };
      const controller = new AbortController();
      const cancelled = npu.transcribe(english, { language: "en", signal: controller.signal });
      setTimeout(() => controller.abort(), 5);
      await assert.rejects(cancelled, (error) => error.name === "AbortError");
      await npu.stop();
      result.cancellation = true;
      // A deterministic unavailable backend must produce native CPU fallback
      // exactly once in Automatic, and an error in explicit NPU mode.
      const original = npu.transcribe.bind(npu);
      npu.transcribe = async () => {
        throw new Error("Verification: NPU unavailable");
      };
      npu.setPreference("automatic");
      const fallback = await whisper.transcribeLocalWhisper(english, {
        model: "base-snapdragon-npu",
        language: "en",
      });
      assert.equal(fallback.backend, "cpu");
      assert.match(fallback.fallbackReason, /NPU unavailable/);
      assert.match(fallback.text, /quick brown fox jumps over the lazy dog/i);
      result.cpuFallback = true;
      npu.setPreference("npu");
      await assert.rejects(
        whisper.transcribeLocalWhisper(english, { model: "base-snapdragon-npu", language: "en" }),
        /NPU unavailable/
      );
      result.explicitNpuFailure = true;
      npu.transcribe = original;
      assert.equal((await npu.transcribe(english, { language: "en" })).backend, "qnn-htp");
      fs.writeFileSync(output, JSON.stringify(result));
    } finally {
      await whisper.stopServer();
    }
  })
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
