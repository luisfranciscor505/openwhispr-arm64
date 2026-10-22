// Run once on the maintainer's PC. Private material stays outside the checkout.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { REPOSITORY } = require("../src/helpers/arm64UpdateManifest");
const dir = path.join(process.env.LOCALAPPDATA, "OpenWhisprRelease");
fs.mkdirSync(dir, { recursive: true });
const sid = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).match(
  /S-1-[\d-]+/
)[0];
execFileSync(
  "icacls",
  [
    dir,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
  ],
  { stdio: "ignore" }
);
const keyPath = path.join(dir, "update-signing-private.pem");
if (!fs.existsSync(keyPath))
  fs.writeFileSync(
    keyPath,
    crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" })
  );
const key = fs.readFileSync(keyPath, "utf8");
const publicKey = crypto.createPublicKey(key).export({ type: "spki", format: "pem" });
const configPath = path.join(__dirname, "..", "arm64-release.json");
const config = JSON.parse(fs.readFileSync(configPath));
if (config.publicKey && config.publicKey !== publicKey)
  throw new Error("Existing trust key differs; do not rotate implicitly");
fs.writeFileSync(configPath, JSON.stringify({ ...config, publicKey }, null, 2) + "\n");
const gh = (args, input) => {
  const result = spawnSync("gh", args, { input, encoding: "utf8", windowsHide: true });
  if (result.status !== 0)
    throw new Error(`GitHub setup failed (${args.slice(0, 2).join(" ")}): ${result.stderr}`);
  return result.stdout;
};
gh(
  ["api", `repos/${REPOSITORY}/environments/arm64-release`, "-X", "PUT", "--input", "-"],
  JSON.stringify({
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  })
);
const policies = JSON.parse(
  gh(["api", `repos/${REPOSITORY}/environments/arm64-release/deployment-branch-policies`])
);
if (!policies.branch_policies.some((p) => p.name === "arm64"))
  gh([
    "api",
    `repos/${REPOSITORY}/environments/arm64-release/deployment-branch-policies`,
    "-X",
    "POST",
    "-f",
    "name=arm64",
    "-f",
    "type=branch",
  ]);
gh(
  ["secret", "set", "ARM64_UPDATE_PRIVATE_KEY", "--repo", REPOSITORY, "--env", "arm64-release"],
  key
);
gh(
  ["api", `repos/${REPOSITORY}/actions/permissions/workflow`, "-X", "PUT", "--input", "-"],
  JSON.stringify({ default_workflow_permissions: "read", can_approve_pull_request_reviews: true })
);
console.log(
  `Release public key configured. Private key backup is restricted to this Windows account at ${keyPath}.`
);
// Runner registration token is short-lived and restricted to this repository.
const token = JSON.parse(
  gh(["api", `repos/${REPOSITORY}/actions/runners/registration-token`, "-X", "POST"])
).token;
const asset = JSON.parse(
  gh([
    "api",
    "repos/actions/runner/releases/latest",
    "--jq",
    '.assets[] | select(.name | test("win-arm64.*zip$")) | {name,browser_download_url,digest}',
  ])
);
if (
  !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
  !asset.browser_download_url.startsWith("https://github.com/actions/runner/releases/")
)
  throw new Error("Missing official runner checksum");
const provision = path.join(dir, "runner-provision.json");
fs.writeFileSync(
  provision,
  JSON.stringify({
    token,
    repository: REPOSITORY,
    downloadUrl: asset.browser_download_url,
    sha256: asset.digest.slice(7),
    modelSource: path.join(os.homedir(), ".cache", "openwhispr", "whisper-models"),
  })
);
console.log("Runner provisioning configuration prepared (registration token expires in one hour).");
