const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { hash, versionOf, assertEvidence } = require("./lib/arm64-release");
const release = require("../arm64-release.json");
const { REPOSITORY, verifyManifest } = require("../src/helpers/arm64UpdateManifest");
const output = path.resolve(process.argv[2] || "dist-arm64");
const read = (name) => JSON.parse(fs.readFileSync(path.join(output, name), "utf8"));
const provenance = read("provenance.json");
const report = read("hardware-verification.json");
const version = versionOf(release);
const installer = path.join(output, `OpenWhispr-${version}-windows-arm64.exe`);
assertEvidence(provenance, report, installer);
if (
  provenance.sourceCommit !== process.env.CANDIDATE_SHA ||
  provenance.runId !== process.env.GITHUB_RUN_ID ||
  provenance.runAttempt !== process.env.GITHUB_RUN_ATTEMPT ||
  provenance.upstreamCommit !== release.upstreamCommit ||
  provenance.version !== version
)
  throw new Error("Release source/run identity mismatch");
const manifest = verifyManifest(read("arm64-update.json"), release.publicKey, version);
if (
  manifest.sourceCommit !== provenance.sourceCommit ||
  manifest.upstreamCommit !== release.upstreamCommit ||
  manifest.installer.sha512 !== hash(installer, "sha512", "base64") ||
  manifest.installer.size !== fs.statSync(installer).size
)
  throw new Error("Signed candidate metadata differs from verified installer");
const previous = require("node:child_process").spawnSync(
  "gh",
  ["api", `repos/${REPOSITORY}/releases/latest`],
  { encoding: "utf8" }
);
if (previous.status === 0) {
  const previousVersion = JSON.parse(previous.stdout).tag_name.replace(/^v/, "");
  if (
    report.updateCycle !== true ||
    report.previousVersion !== previousVersion ||
    !report.settingsAndModelsPreserved
  )
    throw new Error("Installed A to B update verification is missing or stale");
} else if (!previous.stderr.includes("404") || report.updateCycle !== "bootstrap") {
  throw new Error("Cannot establish previous release for upgrade verification");
}
fs.writeFileSync(
  path.join(output, "SHA256SUMS.txt"),
  `${hash(installer)}  ${path.basename(installer)}\n`
);
const gh = (...args) => execFileSync("gh", args, { stdio: "inherit", windowsHide: true });
// create refuses an existing tag: published versions/assets are never overwritten.
gh(
  "release",
  "create",
  `v${version}`,
  "--repo",
  REPOSITORY,
  "--target",
  provenance.sourceCommit,
  "--draft",
  "--title",
  `OpenWhispr ${release.upstreamTag} — Windows ARM64 #${release.portRevision}`,
  "--notes",
  "Native Windows ARM64 build with verified Snapdragon NPU transcription. See hardware-verification.json and provenance.json for evidence."
);
for (const name of [
  path.basename(installer),
  "arm64-update.json",
  "provenance.json",
  "hardware-verification.json",
  "SHA256SUMS.txt",
])
  gh("release", "upload", `v${version}`, path.join(output, name), "--repo", REPOSITORY);
gh(
  "release",
  "edit",
  `v${version}`,
  "--repo",
  REPOSITORY,
  "--draft=false",
  "--prerelease=false",
  "--latest"
);
