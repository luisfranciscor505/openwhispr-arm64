// Verify the installed SendInput helper against a controlled native window.
const { app, BrowserWindow, clipboard } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { promisify } = require("util");
const execFile = promisify(require("child_process").execFile);
const root = path.resolve(__dirname, "..");
const report = { date: new Date().toISOString(), arch: process.arch };
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "ow-arm64-paste-")));

async function verify() {
  let window, original, originalImage, marker;
  try {
    const formats = clipboard.availableFormats();
    // Do not flatten rich text, images, file-copy data, or custom clipboard data.
    const imageOnly = formats.length === 1 && formats[0] === "image/png";
    if (!imageOnly && formats.some((format) => format !== "text/plain")) {
      report.skipped = true;
      report.reason = "Clipboard contains formats this verifier cannot restore exactly";
      report.formats = formats;
      return;
    }
    original = clipboard.readText();
    if (imageOnly) {
      originalImage = clipboard.readImage();
      assert.equal(originalImage.isEmpty(), false);
    }
    marker = `OpenWhispr ARM64 paste ${Date.now()}`;
    window = new BrowserWindow({
      width: 550,
      height: 180,
      title: "OpenWhispr ARM64 paste verification",
      alwaysOnTop: true,
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    await window.loadURL(
      "data:text/html,<title>OpenWhispr ARM64 paste verification</title><label>Automatic native paste verification <textarea autofocus style='width:95%;height:80px'></textarea></label>"
    );
    window.show();
    window.focus();
    await window.webContents.executeJavaScript("document.querySelector('textarea').focus()");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(window.isFocused(), true, "Test window did not acquire focus; paste was not sent");
    const helper = path.join(
      process.env.LOCALAPPDATA,
      "Programs",
      "OpenWhispr",
      "resources",
      "bin",
      "windows-fast-paste.exe"
    );
    const handle = window.getNativeWindowHandle().readBigUInt64LE().toString(16);
    const target = await execFile(helper, ["--restore-window", handle, "--detect-only"], {
      windowsHide: true,
      timeout: 5000,
    });
    assert.ok(
      target.stdout.includes("WINDOW_TITLE OpenWhispr ARM64 paste verification"),
      "Native focus guard failed; no paste sent"
    );
    clipboard.writeText(marker);
    await execFile(helper, ["--restore-window", handle], { windowsHide: true, timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const text = await window.webContents.executeJavaScript(
      "document.querySelector('textarea').value"
    );
    assert.equal(text, marker);
    report.success = true;
    report.target = "Controlled Electron textarea";
  } catch (error) {
    report.success = false;
    report.error = error.stack;
    throw error;
  } finally {
    if (marker && clipboard.readText() === marker) {
      if (originalImage) {
        clipboard.writeImage(originalImage);
        assert.ok(
          clipboard.readImage().toPNG().equals(originalImage.toPNG()),
          "Clipboard image pixels must be restored"
        );
      } else if (original) clipboard.writeText(original);
      else clipboard.clear();
      report.clipboardRestored = true;
    }
    window?.destroy();
    fs.writeFileSync(
      path.join(root, "artifacts", "windows-arm64", "paste-verification.json"),
      JSON.stringify(report, null, 2)
    );
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
