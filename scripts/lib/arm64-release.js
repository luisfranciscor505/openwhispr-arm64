const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { APP_ID, REPOSITORY, assetUrl } = require("../../src/helpers/arm64UpdateManifest");
const hash = (file, algorithm = "sha256", encoding = "hex") =>
  crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim();
const versionOf = (release) => `${release.upstreamTag.slice(1)}-arm64.${release.portRevision}`;

function assertEvidence(provenance, report, installer) {
  if (
    report.success !== true ||
    report.sourceCommit !== provenance.sourceCommit ||
    report.installerSha256 !== provenance.installerSha256 ||
    hash(installer) !== provenance.installerSha256 ||
    report.arch !== "arm64" ||
    !report.installedBytesMatch ||
    !report.npu ||
    !report.multilingual ||
    !report.cpuFallback ||
    !report.explicitNpuFailure ||
    !report.cancellation ||
    !report.rendererIpc ||
    report.runId !== provenance.runId ||
    report.runAttempt !== provenance.runAttempt
  )
    throw new Error("Candidate hardware evidence does not match this build");
}

function signedEnvelope(manifest, privateKey) {
  const payload = Buffer.from(JSON.stringify(manifest));
  return {
    payload: payload.toString("base64"),
    signature: crypto.sign(null, payload, privateKey).toString("base64"),
  };
}

function assertUpgradeEvidence(report, previousVersion) {
  if (previousVersion === null) {
    if (report.updateCycle !== "bootstrap" || report.previousVersion !== null)
      throw new Error("Bootstrap verification is missing");
    return;
  }
  if (
    report.updateCycle !== true ||
    report.previousVersion !== previousVersion ||
    report.settingsAndModelsPreserved !== true ||
    report.npuAfterUpdate !== true
  )
    throw new Error("Installed A to B update verification is missing or stale");
}

function manifestFor(release, provenance, installer) {
  const version = versionOf(release);
  return {
    schema: 1,
    appId: APP_ID,
    repository: REPOSITORY,
    platform: "win32",
    arch: "arm64",
    version,
    sourceCommit: provenance.sourceCommit,
    upstreamCommit: release.upstreamCommit,
    releaseDate: new Date().toISOString(),
    releaseNotes: `OpenWhispr ${release.upstreamTag}, Windows ARM64 port revision ${release.portRevision}. Verified on Snapdragon NPU.`,
    installer: {
      url: assetUrl(version, `OpenWhispr-${version}-windows-arm64.exe`),
      size: fs.statSync(installer).size,
      sha512: hash(installer, "sha512", "base64"),
    },
  };
}

module.exports = {
  hash,
  git,
  versionOf,
  assertEvidence,
  assertUpgradeEvidence,
  signedEnvelope,
  manifestFor,
};
