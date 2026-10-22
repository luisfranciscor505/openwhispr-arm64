const { spawnSync } = require("child_process");
const { isArm64Target, ensureHelpers } = require("./lib/windows-arm64-helpers");
if (isArm64Target()) {
  try {
    ensureHelpers();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else {
  const result = spawnSync(
    process.execPath,
    [process.env.npm_execpath, "run", "compile:native:platforms"],
    { stdio: "inherit", windowsHide: true }
  );
  if (result.error || result.status !== 0) process.exitCode = result.status || 1;
}
