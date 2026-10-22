const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message || result.status}`);
  }
}

function compilerEnvironment() {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  if (!fs.existsSync(vswhere))
    throw new Error(
      "Install Visual Studio Build Tools with C++ ARM64 tools and Windows SDK. See docs/windows-arm64.md."
    );
  const result = spawnSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.ARM64",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8", windowsHide: true }
  );
  const installation = result.stdout?.trim();
  if (!installation)
    throw new Error("Visual Studio C++ ARM64 tools are missing. See docs/windows-arm64.md.");
  const devcmd = path.join(installation, "Common7", "Tools", "VsDevCmd.bat");
  const initialized = spawnSync(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", `""${devcmd}" -no_logo -arch=arm64 -host_arch=arm64 && set"`],
    { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true }
  );
  if (initialized.status !== 0)
    throw new Error(`Cannot initialize ARM64 compiler: ${initialized.stderr}`);
  const env = { ...process.env };
  for (const line of initialized.stdout.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) {
      const key = line.slice(0, i);
      for (const existing of Object.keys(env))
        if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
      env[key] = line.slice(i + 1);
    }
  }
  return env;
}

function copyArm64Crt(destination, env) {
  const {
    assertPeArchitecture,
    readPeMachine,
    MACHINES,
  } = require("../../src/helpers/peArchitecture");
  const redist = path.resolve(env.VCToolsInstallDir, "../../../Redist/MSVC");
  const versions = fs
    .readdirSync(redist)
    .filter((name) => /^\d+\./.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const source = versions
    .flatMap((version) => {
      const arm64 = path.join(redist, version, "arm64");
      return fs.existsSync(arm64)
        ? fs
            .readdirSync(arm64)
            .filter((name) => /^Microsoft\.VC\d+\.CRT$/.test(name))
            .map((name) => path.join(arm64, name))
        : [];
    })
    .find((dir) => fs.existsSync(dir));
  if (!source) throw new Error("Visual Studio ARM64 redistributable DLLs are missing");
  fs.mkdirSync(destination, { recursive: true });
  for (const file of fs.readdirSync(source).filter((name) => name.endsWith(".dll"))) {
    // Microsoft's ARM64 CRT directory also contains the x64-only exception
    // companion for ARM64EC. Pure ARM64 images use vcruntime140.dll instead.
    if (
      file.toLowerCase() === "vcruntime140_1.dll" &&
      readPeMachine(path.join(source, file)) !== MACHINES.arm64
    )
      continue;
    assertPeArchitecture(path.join(source, file));
    fs.copyFileSync(path.join(source, file), path.join(destination, file));
  }
}

module.exports = { run, compilerEnvironment, copyArm64Crt };
