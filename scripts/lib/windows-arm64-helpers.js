const fs = require("fs");
const path = require("path");
const { compilerEnvironment, run } = require("./windows-arm64-tools");
const { assertPeArchitecture } = require("../../src/helpers/peArchitecture");
const { parseArgs } = require("./download-utils");

const helpers = {
  "windows-key-listener": ["user32.lib"],
  "windows-fast-paste": ["user32.lib"],
  "windows-text-monitor": ["ole32.lib", "oleaut32.lib"],
  "windows-mic-listener": ["ole32.lib", "oleaut32.lib"],
  "windows-system-audio-helper": ["ole32.lib", "mmdevapi.lib"],
  "windows-process-list": [],
};
function isArm64Target() {
  const args = parseArgs();
  return !args.isAll && args.targetPlatform === "win32" && args.targetArch === "arm64";
}
function ensureHelpers() {
  const root = path.resolve(__dirname, "../..");
  const bin = path.join(root, "resources", "bin");
  const cache = path.join(root, ".cache", "arm64");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  let env;
  for (const [helper, libs] of Object.entries(helpers)) {
    const output = path.join(bin, `${helper}.exe`);
    const source = path.join(root, "resources", `${helper}.c`);
    try {
      assertPeArchitecture(output);
      if (fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) continue;
    } catch {
      /* missing or wrong-architecture helpers must be rebuilt */
    }
    env ||= compilerEnvironment();
    run(
      "cl.exe",
      [
        "/O2",
        "/MT",
        "/nologo",
        source,
        `/Fe:${output}`,
        `/Fo:${path.join(cache, helper)}.obj`,
        ...libs,
      ],
      { env, cwd: cache }
    );
    assertPeArchitecture(output);
  }
}
async function ensureSourceBinary(name) {
  const root = path.resolve(__dirname, "../..");
  const file = path.join(root, "resources", "bin", name);
  if (!fs.existsSync(file)) await require("../prepare-windows-arm64").prepare();
  assertPeArchitecture(file);
}
module.exports = { helpers, isArm64Target, ensureHelpers, ensureSourceBinary };
