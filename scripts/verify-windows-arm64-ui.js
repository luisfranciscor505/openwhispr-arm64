// Launch the actual main process using an isolated profile and capture startup.
const { app, BrowserWindow, dialog } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = path.resolve(__dirname, "..");
const option = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };
const packaged = process.argv.includes("--packaged");
const installed = process.argv.includes("--installed");
const meetingFlows = process.argv.includes("--meeting-flows");
const searchFlows = process.argv.includes("--search-flows");
const audioFlows = process.argv.includes("--audio-flows") || meetingFlows;
let meetingFeed, meetingSilence;
const outputIndex = process.argv.indexOf("--output-dir");
const packageOutput =
  outputIndex >= 0 ? path.resolve(root, process.argv[outputIndex + 1]) : path.join(root, "dist");
const appRoot = installed
  ? path.join(option("--install-dir") || path.join(process.env.LOCALAPPDATA, "Programs", "OpenWhispr"), "resources", "app.asar")
  : packaged
    ? path.join(packageOutput, "win-arm64-unpacked", "resources", "app.asar")
    : root;
const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "ow-arm64-ui-"));
const output = path.resolve(option("--report-dir") || path.join(root, "artifacts", "windows-arm64"));
fs.mkdirSync(path.join(temporaryHome, "profile"));
fs.mkdirSync(path.join(temporaryHome, "appdata"));
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(temporaryHome, "profile"));
app.setPath("appData", path.join(temporaryHome, "appdata"));
app.setPath("home", temporaryHome);
process.env.OPENWHISPR_CHANNEL = "production";
app.setAppPath(appRoot);
if (packaged || installed)
  Object.defineProperty(process, "resourcesPath", { value: path.dirname(appRoot) });
const resultName = installed ? "installed-startup" : packaged ? "packaged-startup" : "startup";
os.homedir = () => temporaryHome;
const errors = [];
dialog.showErrorBox = (title, content) => errors.push({ title, content });
if (audioFlows) {
  const WhisperManager = require(path.join(appRoot, "src", "helpers", "whisper"));
  WhisperManager.prototype.getModelsDir = () =>
    path.join(root, ".cache", "arm64", "verification-models");
  dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: [path.join(root, ".cache", "arm64", "fox.wav")],
  });
}
if (meetingFlows) {
  // Inject public reference PCM at the hardware callback boundary. Native
  // capture itself is verified separately; the real meeting orchestration,
  // AEC/gates, NPU decoding, segment events, and stop path remain in place.
  const Capture = require(path.join(appRoot, "src", "helpers", "windowsLoopbackAudioManager"));
  Capture.prototype.start = async ({ onChunk }) => {
    clearInterval(meetingSilence);
    meetingFeed = onChunk;
    meetingSilence = setInterval(() => onChunk(Buffer.alloc(4800)), 100);
  };
  Capture.prototype.stop = async () => {
    clearInterval(meetingSilence);
    meetingFeed = null;
  };
}
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.showInactive = function () {};
try {
  require(path.join(appRoot, "main.js"));
} catch (error) {
  console.error(error);
  app.exit(1);
}

app.whenReady().then(async () => {
  try {
    await new Promise((resolve) => setTimeout(resolve, 15000));
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    const window = windows.sort(
      (a, b) =>
        b.getBounds().width * b.getBounds().height - a.getBounds().width * a.getBounds().height
    )[0];
    if (!window) throw new Error("No application window was created");
    const text = await window.webContents.executeJavaScript("document.body.innerText");
    const ipcVersion = await window.webContents.executeJavaScript("window.electronAPI.getAppVersion()");
    if (!ipcVersion?.version) throw new Error("Installed renderer/preload/main IPC failed");
    if (text.length < 50 || errors.length)
      throw new Error(`Startup failed: ${JSON.stringify(errors)} ${text}`);
    let processDetection;
    if (process.platform === "win32" && process.arch === "arm64") {
      const processes = await require(
        path.join(appRoot, "src", "helpers", "processListCache")
      ).getProcessList();
      processDetection = {
        count: processes.length,
        includesOwnProcess: processes.includes(path.basename(process.execPath).toLowerCase()),
      };
      if (!processDetection.includesOwnProcess)
        throw new Error("Native process detection did not find the test host");
    }
    if (audioFlows) await verifyAudioFlows(window);
    if (searchFlows) await verifySearchFlow(window);
    const capture = await window.webContents.capturePage();
    fs.writeFileSync(path.join(output, `${resultName}.png`), capture.toPNG());
    fs.writeFileSync(
      path.join(output, `${resultName}.json`),
      JSON.stringify(
        {
          success: true,
          ipc: true,
          arch: process.arch,
          windows: windows.length,
          text: text.slice(0, 1200),
          errors,
          processDetection,
        },
        null,
        2
      )
    );
    await require(path.join(appRoot, "src", "helpers", "sidecarRegistry")).shutdownAll();
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.writeFileSync(path.join(output, "startup-error.txt"), String(error.stack));
    app.exit(1);
  }
});

async function verifyAudioFlows(window) {
  const assert = require("assert/strict");
  const report = { date: new Date().toISOString(), installed, arch: process.arch };
  const reportPath = path.join(output, "installed-audio-flows.json");
  try {
    window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission === "media")
    );
    window.webContents.session.setPermissionCheckHandler(
      (_contents, permission) => permission === "media"
    );
    report.microphone = await window.webContents.executeJavaScript(`(async () => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        let bytes = 0;
        recorder.ondataavailable = (event) => bytes += event.data.size;
        const stopped = new Promise(resolve => recorder.onstop = resolve);
        recorder.start();
        await new Promise(resolve => setTimeout(resolve, 2000));
        recorder.stop();
        await stopped;
        return { opened: true, bytes, trackState: stream.getAudioTracks()[0].readyState };
      } catch (error) { return { opened: false, error: error.message }; }
      finally { stream?.getTracks().forEach(track => track.stop()); }
    })()`);
    const wav = fs.readFileSync(path.join(root, ".cache", "arm64", "fox.wav")).toString("base64");
    report.recordedDictation = await window.webContents.executeJavaScript(`(async () => {
      const context = new AudioContext();
      try {
        const wav = Uint8Array.from(atob(${JSON.stringify(wav)}), ch => ch.charCodeAt(0));
        const buffer = await context.decodeAudioData(wav.buffer);
        const source = context.createBufferSource(); source.buffer = buffer;
        const destination = context.createMediaStreamDestination();
        source.connect(destination);
        const recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' });
        const chunks = [];
        recorder.ondataavailable = event => chunks.push(event.data);
        const stopped = new Promise(resolve => recorder.onstop = resolve);
        source.onended = () => recorder.stop();
        await context.resume(); recorder.start(); source.start();
        await stopped;
        const audio = await new Blob(chunks).arrayBuffer();
        destination.stream.getTracks().forEach(track => track.stop());
        return { bytes: audio.byteLength, result: await window.electronAPI.transcribeLocalWhisper(audio, { model: 'base-snapdragon-npu', language: 'en' }) };
      } finally { await context.close(); }
    })()`);
    assert.equal(report.recordedDictation.result.success, true);
    assert.equal(report.recordedDictation.result.backend, "qnn-htp");
    assert.match(report.recordedDictation.result.text, /quick brown fox jumps over the lazy dog/i);
    report.fileImport = await window.webContents.executeJavaScript(`(async () => {
      const selected = await window.electronAPI.selectAudioFile();
      return window.electronAPI.transcribeAudioFile(selected.filePath, { model: 'base-snapdragon-npu', language: 'en' });
    })()`);
    assert.equal(report.fileImport.success, true);
    assert.equal(report.fileImport.backend, "qnn-htp");
    assert.match(report.fileImport.text, /quick brown fox jumps over the lazy dog/i);
    const { spawn } = require("child_process");
    const child = spawn(
      path.join(path.dirname(appRoot), "bin", "windows-system-audio-helper.exe"),
      ["start", "--sample-rate", "16000"],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
    let bytes = 0,
      events = "";
    child.stdout.on("data", (data) => (bytes += data.length));
    child.stderr.on("data", (data) => (events += data.toString()));
    const stopped = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    const timeout = setTimeout(() => child.kill(), 10000);
    try {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      child.stdin.end();
      report.systemCapture = { exitCode: await stopped, bytes, events };
      assert.match(events, /"type":"start"/);
      assert.ok(bytes > 0);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
    }
    if (meetingFlows) report.meeting = await verifyMeetingFlow(window);
    report.success = true;
  } catch (error) {
    report.success = false;
    report.error = error.stack;
    throw error;
  } finally {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }
}

async function verifyMeetingFlow(window) {
  const assert = require("assert/strict");
  const { promisify } = require("util");
  const execFile = promisify(require("child_process").execFile);
  const pcmFile = path.join(root, ".cache", "arm64", "meeting-fox-24k.pcm");
  await execFile(
    path.join(path.dirname(appRoot), "bin", "ffmpeg-win32-arm64.exe"),
    [
      "-nostdin",
      "-y",
      "-v",
      "error",
      "-i",
      path.join(root, ".cache", "arm64", "fox.wav"),
      "-ar",
      "24000",
      "-ac",
      "1",
      "-f",
      "s16le",
      pcmFile,
    ],
    { windowsHide: true }
  );
  const audio = fs.readFileSync(pcmFile);
  const systemFile = path.join(root, ".cache", "arm64", "meeting-spanish-24k.pcm");
  await execFile(
    path.join(path.dirname(appRoot), "bin", "ffmpeg-win32-arm64.exe"),
    [
      "-nostdin",
      "-y",
      "-v",
      "error",
      "-i",
      path.join(root, ".cache", "arm64", "spanish.wav"),
      "-ar",
      "24000",
      "-ac",
      "1",
      "-f",
      "s16le",
      systemFile,
    ],
    { windowsHide: true }
  );
  const start = await window.webContents.executeJavaScript(`(async () => {
    await window.electronAPI.setSpeakerDiarizationEnabled(false);
    window.__arm64Segments = [];
    window.__arm64SegmentCleanup = window.electronAPI.onMeetingTranscriptionSegment(segment => window.__arm64Segments.push(segment));
    return window.electronAPI.meetingTranscriptionStart({ provider: 'local', localProvider: 'whisper', localModel: 'base-snapdragon-npu', language: 'auto', sessionId: 'arm64-integration-meeting' });
  })()`);
  assert.equal(start.success, true, JSON.stringify(start));
  let stop;
  try {
    assert.equal(typeof meetingFeed, "function");
    await window.webContents.executeJavaScript(
      `window.electronAPI.meetingTranscriptionSend(Uint8Array.from(atob(${JSON.stringify(audio.toString("base64"))}), ch => ch.charCodeAt(0)).buffer, 'mic')`
    );
    async function waitFor(source) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const segments = await window.webContents.executeJavaScript("window.__arm64Segments");
        if (segments.some((segment) => segment.source === source && segment.type === "final"))
          return segments;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`No ${source} meeting segment arrived`);
    }
    await waitFor("mic");
    meetingFeed(fs.readFileSync(systemFile));
    await waitFor("system");
  } finally {
    stop = await window.webContents.executeJavaScript(
      `window.electronAPI.meetingTranscriptionStop(${JSON.stringify(start.sessionId)})`
    );
  }
  const segments = await window.webContents.executeJavaScript(
    "window.__arm64SegmentCleanup(); window.__arm64Segments"
  );
  const finals = segments.filter((segment) => segment.type === "final");
  assert.equal(stop.success, true, JSON.stringify(stop));
  assert.ok(
    finals.some((segment) => segment.source === "mic" && /quick brown fox/i.test(segment.text))
  );
  assert.ok(
    finals.some((segment) => segment.source === "system" && /prueba|español/i.test(segment.text))
  );
  assert.ok(
    finals.every(
      (segment, i) =>
        Number.isFinite(segment.timestamp) && (!i || segment.timestamp >= finals[i - 1].timestamp)
    )
  );
  const backend = await window.webContents.executeJavaScript(
    "window.electronAPI.getWhisperNpuStatus()"
  );
  assert.equal(backend.backend, "qnn-htp");
  return { start, stop, segments, backend, captureBoundary: "public reference PCM injection" };
}

async function verifySearchFlow(window) {
  const assert = require("assert/strict");
  const report = { date: new Date().toISOString(), installed, arch: process.arch };
  try {
    const result = await window.webContents.executeJavaScript(`(async () => {
      const notes = [];
      for (const [title, text] of [
        ['Hospital', 'A doctor treats patients at a hospital.'],
        ['Cat', 'The kitten sleeps on a warm blanket.'],
        ['Build', 'The compiler builds native Windows ARM64 executables.']
      ]) notes.push(await window.electronAPI.saveNote(title, text, 'text'));
      const query = 'medical care for sick people';
      const lexical = await window.electronAPI.searchNotes(query, 3);
      // The first search intentionally returns keywords while native indexing
      // warms asynchronously. Subsequent searches must retrieve the new notes.
      const deadline = Date.now() + 30000;
      let semantic = [];
      do {
        semantic = await window.electronAPI.semanticSearchNotes(query, 3);
        if (semantic.length) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      return { notes, query, lexical, semantic };
    })()`);
    report.result = result;
    assert.ok(result.notes.every((note) => note.success));
    assert.equal(result.lexical.length, 0, "Reference query must not match by keywords");
    assert.ok(result.semantic.length > 0, "Semantic retrieval returned no notes");
    assert.equal(result.semantic[0].id, result.notes[0].note.id);
    report.success = true;
  } catch (error) {
    report.success = false;
    report.error = error.stack;
    throw error;
  } finally {
    fs.writeFileSync(
      path.join(output, "installed-search-flow.json"),
      JSON.stringify(report, null, 2)
    );
  }
}
