const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { hash, versionOf, manifestFor, signedEnvelope } = require("./lib/arm64-release");
const release = require("../arm64-release.json");
const output = path.resolve(process.argv[2] || "dist-arm64");
const provenance = JSON.parse(fs.readFileSync(path.join(output, "provenance.json")));
const installer = path.join(output, `OpenWhispr-${versionOf(release)}-windows-arm64.exe`);
if (
  provenance.sourceCommit !== process.env.CANDIDATE_SHA ||
  provenance.installerSha256 !== hash(installer) ||
  provenance.runId !== process.env.GITHUB_RUN_ID ||
  provenance.runAttempt !== process.env.GITHUB_RUN_ATTEMPT
)
  throw new Error("Candidate identity mismatch before signing");
const key = crypto.createPrivateKey(process.env.ARM64_UPDATE_PRIVATE_KEY);
if (crypto.createPublicKey(key).export({ format: "pem", type: "spki" }) !== release.publicKey)
  throw new Error("Candidate signing key does not match application trust key");
fs.writeFileSync(
  path.join(output, "arm64-update.json"),
  JSON.stringify(signedEnvelope(manifestFor(release, provenance, installer), key))
);
console.log("Candidate metadata signed; publication still requires hardware verification.");
