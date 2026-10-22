const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

test("local dictation preserves NPU and CPU fallback diagnostics through cleanup", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-npu-diagnostics-",
    settingsKey: "__npuDiagnosticsSettings",
    settings: { useLocalWhisper: true, allowOpenAIFallback: false },
  });
  const manager = createManager({
    getEffectiveSttLanguage: () => "en",
    getCustomDictionaryPrompt: () => null,
    getWhisperPrompt: () => null,
    processTranscription: async (text) => `${text}!`,
  });
  const audio = new Blob([new Uint8Array([1, 2])], { type: "audio/webm" });
  window.electronAPI.transcribeLocalWhisper = async () => ({
    success: true,
    text: "Hello",
    backend: "cpu",
    fallbackReason: "NPU driver unavailable",
    warning: "NPU unavailable; used ARM64 CPU",
  });
  const cpu = await manager.processWithLocalWhisper(audio, "base-snapdragon-npu");
  assert.equal(cpu.text, "Hello!");
  assert.equal(cpu.backend, "cpu");
  assert.equal(cpu.fallbackReason, "NPU driver unavailable");
  assert.equal(cpu.warning, "NPU unavailable; used ARM64 CPU");
  window.electronAPI.transcribeLocalWhisper = async () => ({
    success: true,
    text: "Hello",
    backend: "qnn-htp",
  });
  const npu = await manager.processWithLocalWhisper(audio, "base-snapdragon-npu");
  assert.equal(npu.backend, "qnn-htp");
  assert.equal(npu.warning, undefined);
});
