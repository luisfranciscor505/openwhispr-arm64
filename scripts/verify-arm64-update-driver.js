// Isolated transport fixture around the packaged updater. Only the HTTP source
// is substituted: signed metadata, cache validation, manager and NSIS stay real.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const [installed, candidate, profile, status] = process.argv.slice(2);
const downloadOnly = process.argv.includes("--download-only");
const appRoot = path.join(installed, "resources", "app.asar");
const packageInfo = require(path.join(appRoot, "package.json"));
const envelope = JSON.parse(fs.readFileSync(path.join(candidate, "arm64-update.json")));
const provenance = JSON.parse(fs.readFileSync(path.join(candidate, "provenance.json")));
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setPath("appData", path.dirname(profile));
app.setAppPath(appRoot);
app.getVersion = () => (downloadOnly ? "0.0.0" : packageInfo.version);
process.env.LOCALAPPDATA = path.join(profile, "updater-cache");
fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
Object.defineProperty(process, "resourcesPath", { value: path.dirname(appRoot) });
app
  .whenReady()
  .then(async () => {
    app.on("window-all-closed", () => {});
    const preferences = new BrowserWindow({ show: false });
    await preferences.loadFile(path.join(appRoot, "src", "dist", "index.html"));
    await preferences.webContents.executeJavaScript(
      "localStorage.setItem('arm64UpdateCycleSentinel', 'preserved'); localStorage.setItem('autoUpdatesEnabled', 'false')"
    );
    preferences.webContents.session.flushStorageData();
    preferences.destroy();
    const { Arm64UpdateProvider } = require(
      path.join(appRoot, "src", "helpers", "arm64UpdateProvider")
    );
    Arm64UpdateProvider.prototype.httpRequest = async (url) => {
      assert.equal(
        url.href,
        "https://github.com/luisfranciscor505/openwhispr-arm64/releases/latest/download/arm64-update.json"
      );
      return JSON.stringify(envelope);
    };
    const { autoUpdater } = require(path.join(appRoot, "node_modules", "electron-updater"));
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.updateConfigPath = path.join(installed, "resources", "app-update.yml");
    autoUpdater.installDirectory = installed;
    autoUpdater.httpExecutor.download = async (url, target) => {
      assert.equal(url.href, JSON.parse(Buffer.from(envelope.payload, "base64")).installer.url);
      await fs.promises.copyFile(path.join(candidate, provenance.installer), target);
    };
    const Manager = require(path.join(appRoot, "src", "updater"));
    const manager = new Manager();
    manager.setAutoUpdatesEnabled(false);
    const available = await manager.checkForUpdates();
    assert.equal(available.updateAvailable, true);
    assert.equal(available.version, provenance.version);
    await manager.downloadUpdate();
    assert.equal(manager.updateDownloaded, true);
    assert.equal(autoUpdater.autoInstallOnAppQuit, false);
    await require(path.join(appRoot, "src", "helpers", "arm64UpdateManifest")).verifyInstaller(
      manager.downloadedFile,
      manager.verifiedManifests.get(provenance.version)
    );
    fs.writeFileSync(
      status,
      JSON.stringify({
        authenticated: true,
        downloaded: true,
        previousVersion: packageInfo.version,
      })
    );
    if (downloadOnly) {
      manager.cleanup();
      app.exit(0);
      return;
    }
    const result = await manager.installUpdate();
    assert.equal(result.success, true);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
