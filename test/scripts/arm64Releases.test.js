const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { selectRelease } = require("../../scripts/sync-arm64-upstream");
const { hash, assertEvidence } = require("../../scripts/lib/arm64-release");
test("conflicted upstream merges abort cleanly and preserve the port", () => {
  const { execFileSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arm64-merge-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  try {
    git("init", "-b", "port");
    git("config", "core.autocrlf", "false");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(dir, "shared.txt"), "base\n");
    git("add", ".");
    git("commit", "-m", "base");
    git("branch", "upstream");
    fs.writeFileSync(path.join(dir, "shared.txt"), "ARM64 port\n");
    git("commit", "-am", "port");
    git("checkout", "upstream");
    fs.writeFileSync(path.join(dir, "shared.txt"), "upstream change\n");
    git("commit", "-am", "upstream");
    git("checkout", "port");
    const modulePath = require.resolve("../../scripts/sync-arm64-upstream");
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          `console.log(JSON.stringify(require(process.argv[1]).mergeCandidate('upstream')))`,
          modulePath,
        ],
        { cwd: dir, encoding: "utf8" }
      )
    );
    assert.equal(result.blocked, true);
    assert.deepEqual(result.conflicts, ["shared.txt"]);
    assert.equal(fs.readFileSync(path.join(dir, "shared.txt"), "utf8"), "ARM64 port\n");
    assert.equal(git("status", "--porcelain").trim(), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("selects only newer stable upstream releases and is idempotent", () => {
  const releases = [
    { tag_name: "v1.10.6", prerelease: true },
    { tag_name: "v1.10.7", draft: true },
    { tag_name: "v1.10.5" },
    { tag_name: "v1.10.4" },
    { tag_name: "v1.10.9-beta.1" },
  ];
  assert.equal(selectRelease(releases, "v1.10.4").tag_name, "v1.10.5");
  assert.equal(selectRelease(releases, "v1.10.5"), null);
});
test("publication requires complete hardware evidence for the exact run, source and installer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arm64-evidence-"));
  const file = path.join(dir, "installer.exe");
  fs.writeFileSync(file, "candidate");
  try {
    const provenance = {
      sourceCommit: "a".repeat(40),
      installerSha256: hash(file),
      runId: "123",
      runAttempt: "1",
    };
    const good = {
      ...provenance,
      success: true,
      arch: "arm64",
      installedBytesMatch: true,
      npu: true,
      multilingual: true,
      cpuFallback: true,
      explicitNpuFailure: true,
      cancellation: true,
      rendererIpc: true,
    };
    assert.doesNotThrow(() => assertEvidence(provenance, good, file));
    for (const change of [
      { success: false },
      { arch: "x64" },
      { sourceCommit: "stale" },
      { runId: "old" },
      { npu: false },
      { multilingual: false },
      { cpuFallback: false },
      { explicitNpuFailure: false },
      { cancellation: false },
      { rendererIpc: false },
    ])
      assert.throws(
        () => assertEvidence(provenance, { ...good, ...change }, file),
        /does not match/
      );
    fs.writeFileSync(file, "different build");
    assert.throws(() => assertEvidence(provenance, good, file), /does not match/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
