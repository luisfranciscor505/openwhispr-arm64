const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  hash,
  versionOf,
  assertEvidence,
  signedEnvelope,
  manifestFor,
} = require("./lib/arm64-release");
const release = require("../arm64-release.json");
const { REPOSITORY } = require("../src/helpers/arm64UpdateManifest");
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
const privateKey = crypto.createPrivateKey(process.env.ARM64_UPDATE_PRIVATE_KEY);
if (
  crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }) !== release.publicKey
)
  throw new Error("Publication signing key does not match the application trust key");
const envelope = signedEnvelope(manifestFor(release, provenance, installer), privateKey);
fs.writeFileSync(path.join(output, "arm64-update.json"), JSON.stringify(envelope));
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
