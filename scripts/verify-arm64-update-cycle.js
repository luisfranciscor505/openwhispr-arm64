const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
  verifyManifest,
  verifyInstaller,
  REPOSITORY,
} = require("../src/helpers/arm64UpdateManifest");
const { hash } = require("./lib/arm64-release");

async function verifyCycle(candidate, work) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { "User-Agent": "OpenWhispr-ARM64-verifier" },
  });
  if (response.status === 404) return { updateCycle: "bootstrap", previousVersion: null };
  if (!response.ok) throw new Error(`Previous release lookup failed (${response.status})`);
  const previous = await response.json();
  const manifestResponse = await fetch(
    `https://github.com/${REPOSITORY}/releases/download/${previous.tag_name}/arm64-update.json`
  );
  assert.equal(manifestResponse.ok, true);
  const release = require("../arm64-release.json");
  const manifest = verifyManifest(await manifestResponse.json(), release.publicKey, "0.0.0");
  const provenance = JSON.parse(fs.readFileSync(path.join(candidate, "provenance.json")));
  assert.equal(require("semver").lt(manifest.version, provenance.version), true);
  const installer = path.join(work, "previous.exe");
  const download = await fetch(manifest.installer.url);
  assert.equal(download.ok, true);
  const { Readable } = require("node:stream");
  await require("node:stream/promises").pipeline(
    Readable.fromWeb(download.body),
    fs.createWriteStream(installer)
  );
  await verifyInstaller(installer, manifest);
  const target = path.join(work, "upgrade-app");
  const run = (exe, args) =>
    execFileSync(exe, args, { windowsHide: true, stdio: "inherit", timeout: 300000 });
  run(installer, ["/S", `/D=${target}`]);
  const profile = path.join(work, "upgrade-profile");
  fs.mkdirSync(profile, { recursive: true });
  const sentinel = path.join(profile, "settings-preservation.txt");
  fs.writeFileSync(sentinel, "arm64-upgrade-settings");
  const before = hash(sentinel);
  const modelBefore = hash(path.join(process.env.OPENWHISPR_VERIFY_MODELS, "ggml-base.bin"));
  const status = path.join(work, "update-cycle.json");
  run(path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe"), [
    path.join(__dirname, "verify-arm64-update-driver.js"),
    target,
    candidate,
    profile,
    status,
  ]);
  const asar = require("@electron/asar");
  const deadline = Date.now() + 120000;
  let installedVersion;
  do {
    try {
      installedVersion = JSON.parse(
        asar.extractFile(path.join(target, "resources", "app.asar"), "package.json")
      ).version;
    } catch {}
    if (installedVersion === provenance.version) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  assert.equal(
    installedVersion,
    provenance.version,
    "NSIS update did not install candidate version"
  );
  assert.equal(hash(sentinel), before);
  assert.equal(hash(path.join(process.env.OPENWHISPR_VERIFY_MODELS, "ggml-base.bin")), modelBefore);
  assert.equal(JSON.parse(fs.readFileSync(status)).authenticated, true);
  // Stop only this isolated restarted instance, never another user's app.
  const powershell = path.join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  execFileSync(
    powershell,
    [
      "-NoProfile",
      "-Command",
      "$target = $env:OPENWHISPR_UPGRADE_EXE; Get-Process OpenWhispr -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target } | ForEach-Object { $_.CloseMainWindow() | Out-Null; $_ | Stop-Process -Force }",
    ],
    {
      windowsHide: true,
      env: { ...process.env, OPENWHISPR_UPGRADE_EXE: path.join(target, "OpenWhispr.exe") },
    }
  );
  return { updateCycle: true, previousVersion: manifest.version, settingsAndModelsPreserved: true };
}

module.exports = { verifyCycle };
