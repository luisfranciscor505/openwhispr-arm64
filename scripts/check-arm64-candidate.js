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
if (!/^v\d+\.\d+\.\d+$/.test(release.upstreamTag))
  throw new Error("Invalid stable upstream release tag");
const tagRef = `refs/tags/${release.upstreamTag}`;
const tagRefs = new Map(
  git("ls-remote", "https://github.com/OpenWhispr/openwhispr.git", tagRef, `${tagRef}^{}`)
    .split(/\r?\n/)
    .map((line) => line.split("\t").reverse())
);
if ((tagRefs.get(`${tagRef}^{}`) ?? tagRefs.get(tagRef)) !== release.upstreamCommit)
  throw new Error("Upstream tag/commit mismatch");
const candidateBaseline = "origin/arm64";
const baselineRelease = JSON.parse(git("show", `${candidateBaseline}:arm64-release.json`));
const nativePinPaths = git(
  "diff",
  "--name-only",
  candidateBaseline,
  "HEAD",
  "--",
  "electron-builder.arm64-win.cjs",
  "src/models/whisperNpuManifest.json",
  "native/whisper-npu",
  "scripts/build-whisper-npu.js",
  "scripts/prepare-windows-arm64.js",
  "scripts/download-*.js",
  "scripts/lib/download-utils.js",
  "scripts/lib/windows-arm64-tools.js"
)
  .split(/\r?\n/)
  .filter(Boolean);
const changedPins = nativePinPaths.filter((file) => {
  const entry = (revision) => git("ls-tree", revision, "--", file);
  // A native input may follow upstream if the fork never diverged from the previous
  // upstream pin and the candidate matches the newly authenticated upstream tree.
  return (
    entry(candidateBaseline) !== entry(baselineRelease.upstreamCommit) ||
    entry("HEAD") !== entry(release.upstreamCommit)
  );
});
const { changedNativeDependencies } = require("./lib/arm64-native-pins");
const previousLock = JSON.parse(git("show", "origin/arm64:package-lock.json"));
const upstreamLock = JSON.parse(git("show", `${release.upstreamCommit}:package-lock.json`));
const candidateLock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
// Official release pins still pass the native build and hardware gate. New pins that
// differ from both the published fork and the verified upstream tag require review.
const forkOnlyPins = new Set(changedNativeDependencies(upstreamLock, candidateLock));
const dependencyChanges = changedNativeDependencies(previousLock, candidateLock).filter((name) =>
  forkOnlyPins.has(name)
);
if (changedPins.length || dependencyChanges.length)
  throw new Error(
    `Native/model pin changes require a separate validated port release: ${changedPins} ${dependencyChanges.join(", ")}`
  );
if (!release.publicKey.startsWith("-----BEGIN PUBLIC KEY-----"))
  throw new Error("Missing update trust key");
const unexpected = fs
  .readdirSync(".github/workflows")
  .filter((name) => !["arm64-release.yml", "arm64-sync.yml"].includes(name));
if (unexpected.length)
  throw new Error(`Upstream workflows must stay archived: ${unexpected.join(", ")}`);
console.log("Candidate provenance and pinned native dependencies verified.");
