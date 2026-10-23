// Retry interrupted vendor downloads; Electron still verifies its pinned checksums.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

for (let attempt = 1; attempt <= 3; attempt++) {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "node_modules", "electron", "install.js")],
    { stdio: "inherit", windowsHide: true, timeout: 600000 }
  );
  if (result.status === 0) process.exit(0);
  console.error(`Electron installation attempt ${attempt}/3 failed`);
}
process.exit(1);
