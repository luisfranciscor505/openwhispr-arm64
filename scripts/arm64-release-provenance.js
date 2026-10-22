const fs = require("node:fs");
const path = require("node:path");
const { hash, git, versionOf } = require("./lib/arm64-release");
const release = require("../arm64-release.json");
const output = path.resolve(process.argv[2] || "dist-arm64");
const installer = `OpenWhispr-${versionOf(release)}-windows-arm64.exe`;
const inventory = [];
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file);
    else
      inventory.push({
        path: path
          .relative(path.join(output, "win-arm64-unpacked"), file)
          .split(path.sep)
          .join("/"),
        sha256: hash(file),
      });
  }
}
walk(path.join(output, "win-arm64-unpacked"));
fs.writeFileSync(
  path.join(output, "provenance.json"),
  JSON.stringify(
    {
      schema: 1,
      sourceCommit: git("rev-parse", "HEAD"),
      upstreamCommit: release.upstreamCommit,
      version: versionOf(release),
      installer,
      installerSha256: hash(path.join(output, installer)),
      runId: process.env.GITHUB_RUN_ID || "local",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
      inventory,
    },
    null,
    2
  )
);
