const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { hash } = require("./lib/arm64-release");
const { assertPeArchitecture } = require("../src/helpers/peArchitecture");
const root = path.resolve(__dirname, "..");
const candidate = path.resolve(process.argv[2] || "dist-arm64");
const provenance = JSON.parse(fs.readFileSync(path.join(candidate, "provenance.json"), "utf8"));
const installer = path.join(candidate, provenance.installer);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-candidate-"));
const installed = path.join(work, "app");
const report = {
  success: false,
  arch: process.arch,
  sourceCommit: provenance.sourceCommit,
  installerSha256: provenance.installerSha256,
  runId: provenance.runId,
  runAttempt: provenance.runAttempt,
};
const run = (exe, args, env = {}) =>
  execFileSync(exe, args, {
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: "inherit",
    timeout: 1200000,
  });
async function verify() {
  try {
    assert.equal(process.platform, "win32");
    assert.equal(process.arch, "arm64");
    // Installation writes HKCU uninstall/protocol entries. Never run against the
    // user's ordinary account, even when the destination itself is isolated.
    assert.equal(
      os.userInfo().username.toLowerCase(),
      "openwhisprverify",
      "Use the dedicated OpenWhisprVerify Windows account"
    );
    assert.equal(provenance.sourceCommit, process.env.CANDIDATE_SHA);
    assert.equal(provenance.runId, process.env.GITHUB_RUN_ID);
    assert.equal(provenance.runAttempt, process.env.GITHUB_RUN_ATTEMPT);
    assert.equal(hash(installer), provenance.installerSha256);
    run(installer, ["/S", `/D=${installed}`]);
    for (const item of provenance.inventory) {
      const target = path.resolve(installed, item.path);
      assert.ok(target.startsWith(installed + path.sep));
      assert.equal(hash(target), item.sha256, `Installed file mismatch: ${item.path}`);
      if (/\.(exe|dll|node)$/i.test(item.path)) assertPeArchitecture(target);
    }
    report.installedBytesMatch = true;
    const models = path.join(work, "models");
    const fixtureModels = process.env.OPENWHISPR_VERIFY_MODELS;
    assert.ok(
      fixtureModels && path.isAbsolute(fixtureModels),
      "Configure the isolated runner model cache"
    );
    fs.cpSync(fixtureModels, models, {
      recursive: true,
      filter: (src) => !/profiles|npu-acceleration\.json/.test(src),
    });
    const engineReport = path.join(work, "engines.json");
    run(
      path.join(root, "node_modules", "electron", "dist", "electron.exe"),
      [
        path.join(root, "scripts", "verify-arm64-release-engines.js"),
        installed,
        models,
        engineReport,
      ],
      { PATH: path.join(process.env.SystemRoot, "System32") }
    );
    Object.assign(report, JSON.parse(fs.readFileSync(engineReport, "utf8")));
    const output = path.join(work, "ui");
    run(path.join(root, "node_modules", "electron", "dist", "electron.exe"), [
      path.join(root, "scripts", "verify-windows-arm64-ui.js"),
      "--installed",
      "--install-dir",
      installed,
      "--report-dir",
      output,
    ]);
    const ui = JSON.parse(fs.readFileSync(path.join(output, "installed-startup.json")));
    assert.equal(ui.success, true);
    assert.equal(ui.ipc, true);
    report.rendererIpc = true;
    Object.assign(
      report,
      await require("./verify-arm64-update-cycle").verifyCycle(candidate, work)
    );
    report.success = true;
  } catch (error) {
    // Public evidence contains no account paths, profile contents, or screenshots.
    console.error(error.message);
    report.failure = "Candidate verification failed; inspect the private runner log.";
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(
      path.join(candidate, "hardware-verification.json"),
      JSON.stringify(report, null, 2)
    );
    // Retain failing isolated directories locally for diagnosis; never publish them.
    if (report.success) fs.rmSync(work, { recursive: true, force: true });
  }
}
verify().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
