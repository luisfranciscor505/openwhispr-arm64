const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const semver = require("semver");
const { REPOSITORY } = require("../src/helpers/arm64UpdateManifest");
const { git } = require("./lib/arm64-release");

function selectRelease(releases, currentTag) {
  return (
    releases
      .filter((r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
      .sort((a, b) => semver.rcompare(a.tag_name.slice(1), b.tag_name.slice(1)))
      .find((r) => semver.gt(r.tag_name.slice(1), currentTag.slice(1))) || null
  );
}
function archiveUpstreamWorkflows() {
  const dir = ".github/workflows";
  const archive = ".github/upstream-workflows";
  fs.mkdirSync(archive, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("arm64-") && /\.ya?ml$/.test(name))
      fs.renameSync(path.join(dir, name), path.join(archive, name));
  }
}

async function sync() {
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", windowsHide: true }).trim();
  const state = JSON.parse(fs.readFileSync("arm64-release.json", "utf8"));
  const releases = JSON.parse(
    gh(
      "api",
      "repos/OpenWhispr/openwhispr/releases?per_page=100",
      "--jq",
      "map({tag_name,draft,prerelease})"
    )
  );
  const candidate = selectRelease(releases, state.upstreamTag);
  if (!candidate) {
    console.log("No new stable upstream release.");
    return;
  }
  const branch = `sync/${candidate.tag_name}`;
  // Never overwrite a maintainer's conflict resolutions or duplicate an open PR.
  const prs = JSON.parse(
    gh(
      "pr",
      "list",
      "--repo",
      REPOSITORY,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,state"
    )
  );
  if (prs.some((p) => p.state !== "CLOSED")) {
    console.log(`Candidate ${branch} already exists.`);
    return;
  }
  if (git("ls-remote", "--heads", "origin", branch)) {
    console.log(`Branch ${branch} already exists; maintain it manually.`);
    return;
  }
  git("config", "user.name", "OpenWhispr ARM64 release bot");
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  if (!git("remote").split(/\r?\n/).includes("upstream"))
    git("remote", "add", "upstream", "https://github.com/OpenWhispr/openwhispr.git");
  git("fetch", "upstream", `refs/tags/${candidate.tag_name}:refs/tags/${candidate.tag_name}`);
  const upstreamCommit = git("rev-parse", `${candidate.tag_name}^{commit}`);
  git("checkout", "-b", branch);
  const merge = spawnSync("git", ["merge", "--no-edit", upstreamCommit], {
    encoding: "utf8",
    windowsHide: true,
  });
  const blocked = merge.status !== 0;
  let conflicts = [];
  if (blocked) {
    conflicts = git("diff", "--name-only", "--diff-filter=U").split(/\r?\n/).filter(Boolean);
    git("merge", "--abort");
  } else {
    archiveUpstreamWorkflows();
    fs.writeFileSync(
      "arm64-release.json",
      JSON.stringify(
        { ...state, upstreamTag: candidate.tag_name, upstreamCommit, portRevision: 1 },
        null,
        2
      ) + "\n"
    );
  }
  fs.writeFileSync(
    "arm64-sync-status.json",
    JSON.stringify(
      { requestedTag: candidate.tag_name, upstreamCommit, blocked, conflicts },
      null,
      2
    ) + "\n"
  );
  git("add", ".");
  git(
    "commit",
    "-m",
    `${blocked ? "Record conflict importing" : "Prepare ARM64 port of"} ${candidate.tag_name}`
  );
  git("push", "origin", branch);
  const body = path.resolve(".git", "arm64-sync-pr.md");
  fs.writeFileSync(
    body,
    blocked
      ? `Upstream ${candidate.tag_name} cannot merge cleanly. Resolve the merge against ${upstreamCommit}, update arm64-release.json and clear the blocked status before dispatching the ARM64 release workflow.\n\nConflicting files:\n${conflicts.map((f) => `- ${f}`).join("\n")}\n`
      : `Imports stable upstream ${candidate.tag_name} (${upstreamCommit}). Publication requires cloud checks and hardware NPU verification of this exact candidate. Native/model pins remain unchanged.\n`
  );
  gh(
    "pr",
    "create",
    "--repo",
    REPOSITORY,
    "--base",
    "arm64",
    "--head",
    branch,
    "--title",
    `Sync ${candidate.tag_name} into Windows ARM64`,
    "--body-file",
    body,
    ...(blocked ? ["--draft"] : [])
  );
  if (!blocked)
    gh(
      "workflow",
      "run",
      "arm64-release.yml",
      "--repo",
      REPOSITORY,
      "--ref",
      "arm64",
      "-f",
      `candidate=${branch}`
    );
}
if (require.main === module)
  sync().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { selectRelease, archiveUpstreamWorkflows };
