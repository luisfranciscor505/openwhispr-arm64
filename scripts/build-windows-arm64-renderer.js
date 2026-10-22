const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// Match the application's default hosted auth service with its cloud API.
// A custom auth deployment must supply its own API URL; do not send its
// credentials to the public service as an implicit fallback.
function buildEnvironment(environment = {}, dotenv = {}) {
  const env = { ...dotenv, ...environment };
  const auth = env.AUTH_URL || env.VITE_AUTH_URL || "https://auth.openwhispr.com";
  if (env.AUTH_URL) env.VITE_AUTH_URL = env.AUTH_URL;
  const api = env.OPENWHISPR_API_URL || env.VITE_OPENWHISPR_API_URL;
  if (api) env.VITE_OPENWHISPR_API_URL = api;
  else if (auth.replace(/\/$/, "") === "https://auth.openwhispr.com")
    env.VITE_OPENWHISPR_API_URL = "https://api.openwhispr.com";
  return env;
}

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const dotenvPath = path.join(root, ".env");
  const dotenv = fs.existsSync(dotenvPath)
    ? require("dotenv").parse(fs.readFileSync(dotenvPath))
    : {};
  const vite = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");
  const result = spawnSync(process.execPath, [vite, "build"], {
    cwd: path.join(root, "src"),
    env: buildEnvironment(process.env, dotenv),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
module.exports = { buildEnvironment };
