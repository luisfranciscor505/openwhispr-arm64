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
function shouldRetryOffline(run, jobs) {
  const hardware = jobs.find((job) => job.name === "hardware");
  return (
    run.status === "completed" &&
    ["failure", "timed_out"].includes(run.conclusion) &&
    jobs.some((job) => job.name === "build" && job.conclusion === "success") &&
    jobs.some((job) => job.name === "sign" && job.conclusion === "success") &&
    Boolean(
      hardware &&
      !hardware.runner_id &&
        ["failure", "timed_out"].includes(hardware.conclusion)
    )
  );
}

function selectCandidate(releases, currentTag, openPrs) {
  const pending = openPrs
    .filter((pr) => !pr.isCrossRepository && /^sync\/v\d+\.\d+\.\d+$/.test(pr.headRefName))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  if (!pending) return selectRelease(releases, currentTag);
  return releases.find((release) => release.tag_name === pending.headRefName.slice(5)) || null;
}

function archiveUpstreamWorkflows() {
  const dir = ".github/workflows";
  const archive = ".github/upstream-workflows";
  fs.mkdirSync(archive, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (!["arm64-release.yml", "arm64-sync.yml"].includes(name) && /\.ya?ml$/.test(name))
      fs.renameSync(path.join(dir, name), path.join(archive, name));
  }
}

function mergeCandidate(upstreamCommit) {
  const merge = spawnSync("git", ["merge", "--no-edit", upstreamCommit], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (merge.status === 0) return { blocked: false, conflicts: [] };
  const conflicts = git("diff", "--name-only", "--diff-filter=U").split(/\r?\n/).filter(Boolean);
  git("merge", "--abort");
  if (!conflicts.length)
    throw new Error(
      "Upstream merge failed without conflicts; inspect the Git failure before retrying"
    );
  return { blocked: true, conflicts };
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
  const openPrs = JSON.parse(
    gh(
      "pr",
      "list",
      "--repo",
      REPOSITORY,
      "--base",
      "arm64",
      "--state",
      "open",
      "--json",
      "headRefName,isCrossRepository,createdAt"
    )
  );
  const candidate = selectCandidate(releases, state.upstreamTag, openPrs);
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
      "number,state,isDraft,isCrossRepository"
    )
  ).filter((pr) => !pr.isCrossRepository);
  if (prs.some((p) => p.state !== "CLOSED")) {
    const open = prs.find((p) => p.state === "OPEN" && !p.isDraft);
    if (open) {
      const runs = JSON.parse(
        gh(
          "api",
          `repos/${REPOSITORY}/actions/workflows/arm64-release.yml/runs?per_page=100`,
          "--jq",
          ".workflow_runs | map({id,display_title,status,conclusion})"
        )
      );
      const last = runs.find((run) => run.display_title === `ARM64 release — ${branch}`);
      if (last) {
        const jobs = JSON.parse(
          gh(
            "api",
            `repos/${REPOSITORY}/actions/runs/${last.id}/jobs`,
            "--jq",
            ".jobs | map({name,conclusion,runner_id})"
          )
        );
        if (shouldRetryOffline(last, jobs)) {
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
          console.log(`Retried ${branch}: its NPU job expired before reaching a runner.`);
          return;
        }
      }
    }
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
  const { blocked, conflicts } = mergeCandidate(upstreamCommit);
  if (!blocked) {
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
module.exports = {
  selectRelease,
  selectCandidate,
  archiveUpstreamWorkflows,
  mergeCandidate,
  shouldRetryOffline,
};
