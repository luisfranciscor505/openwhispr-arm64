const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const release = require("../arm64-release.json");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim();
if (process.platform !== "win32" || process.arch !== "arm64")
  throw new Error("Native Windows ARM64 build runner required");
if (
  fs.existsSync("arm64-sync-status.json") &&
  JSON.parse(fs.readFileSync("arm64-sync-status.json")).blocked
)
  throw new Error("Upstream synchronization has unresolved conflicts");
git("merge-base", "--is-ancestor", release.upstreamCommit, "HEAD");
if (git("rev-parse", `${release.upstreamTag}^{commit}`) !== release.upstreamCommit)
  throw new Error("Upstream tag/commit mismatch");
const changedPins = git(
  "diff",
  "--name-only",
  "origin/arm64",
  "HEAD",
  "--",
  "src/models/whisperNpuManifest.json",
  "native/whisper-npu",
  "scripts/build-whisper-npu.js",
  "scripts/prepare-windows-arm64.js"
);
if (changedPins)
  throw new Error(
    `Native/model pin changes require a separate validated port release: ${changedPins}`
  );
if (!release.publicKey.startsWith("-----BEGIN PUBLIC KEY-----"))
  throw new Error("Missing update trust key");
const unexpected = fs
  .readdirSync(".github/workflows")
  .filter((name) => !["arm64-release.yml", "arm64-sync.yml"].includes(name));
if (unexpected.length)
  throw new Error(`Upstream workflows must stay archived: ${unexpected.join(", ")}`);
console.log("Candidate provenance and pinned native dependencies verified.");
