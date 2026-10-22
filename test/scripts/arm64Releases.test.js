const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { selectRelease } = require("../../scripts/sync-arm64-upstream");
const { hash, assertEvidence } = require("../../scripts/lib/arm64-release");
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
    const provenance = { sourceCommit: "a".repeat(40), installerSha256: hash(file), runId: "123" };
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
