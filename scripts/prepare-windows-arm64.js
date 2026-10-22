#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { run, compilerEnvironment } = require("./lib/windows-arm64-tools");
const { downloadFile, extractZip, findBinaryInDir } = require("./lib/download-utils");
const { assertPeArchitecture } = require("../src/helpers/peArchitecture");

const root = path.resolve(__dirname, "..");
const bin = path.join(root, "resources", "bin");
const cache = path.join(root, ".cache", "arm64");
const FFMPEG = {
  url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-20-13-08/ffmpeg-n8.1.3-18-g46d899d7a0-winarm64-lgpl-8.1.zip",
  sha256: "423412912c5100c4e4e852f1c47803ec4ba5843b421100cf4938056619420fd6",
};
const WHISPER_COMMIT = "6ac14546046ffb17d144a08bcad65337e535cf5f";

function copyNative(source, dest) {
  assertPeArchitecture(source);
  fs.copyFileSync(source, dest);
}

function sourceCheckout(repo, ref, dir, env) {
  if (!fs.existsSync(path.join(dir, ".git")))
    run("git", ["clone", "--no-checkout", `https://github.com/${repo}.git`, dir], { env });
  run("git", ["-C", dir, "checkout", "--detach", ref], { env });
}

async function prepare() {
  if (process.platform !== "win32" || process.arch !== "arm64")
    throw new Error("Run this build with native ARM64 Node.js on Windows.");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const env = { ...compilerEnvironment(), TARGET_ARCH: "arm64", TARGET_PLATFORM: "win32" };
  const task = (script, args = []) =>
    run(process.execPath, [path.join(__dirname, script), ...args], { env, cwd: root });

  const helpers = {
    "windows-key-listener": ["user32.lib"],
    "windows-fast-paste": ["user32.lib"],
    "windows-text-monitor": ["ole32.lib", "oleaut32.lib"],
    "windows-mic-listener": ["ole32.lib", "oleaut32.lib"],
    "windows-system-audio-helper": ["ole32.lib", "mmdevapi.lib"],
    "windows-process-list": [],
  };
  for (const [helper, libs] of Object.entries(helpers)) {
    const output = path.join(bin, `${helper}.exe`);
    run(
      "cl.exe",
      [
        "/O2",
        "/MT",
        "/nologo",
        path.join(root, "resources", `${helper}.c`),
        `/Fe:${output}`,
        `/Fo:${path.join(cache, helper)}.obj`,
        ...libs,
      ],
      { env, cwd: cache }
    );
    assertPeArchitecture(output);
  }

  task("download-llama-server.js", ["--current", "--force"]);
  task("download-sherpa-onnx.js", ["--current", "--force"]);
  task("download-yt-dlp.js", ["--current", "--force"]);
  const ffZip = path.join(cache, "ffmpeg.zip");
  if (
    !fs.existsSync(ffZip) ||
    crypto.createHash("sha256").update(fs.readFileSync(ffZip)).digest("hex") !== FFMPEG.sha256
  )
    await downloadFile(FFMPEG.url, ffZip);
  if (crypto.createHash("sha256").update(fs.readFileSync(ffZip)).digest("hex") !== FFMPEG.sha256)
    throw new Error("FFmpeg checksum mismatch");
  const ffDir = path.join(cache, "ffmpeg");
  await extractZip(ffZip, ffDir);
  copyNative(findBinaryInDir(ffDir, "ffmpeg.exe"), path.join(bin, "ffmpeg-win32-arm64.exe"));
  const licenses = path.join(bin, "arm64-licenses");
  fs.mkdirSync(licenses, { recursive: true });
  fs.writeFileSync(path.join(licenses, "ffmpeg.json"), JSON.stringify(FFMPEG, null, 2));
  function copyNotices(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) copyNotices(file);
      else if (/license|copying/i.test(entry.name))
        fs.copyFileSync(file, path.join(licenses, `ffmpeg-${entry.name}`));
    }
  }
  copyNotices(ffDir);

  const whisper = path.join(cache, "whisper.cpp");
  sourceCheckout("OpenWhispr/whisper.cpp", WHISPER_COMMIT, whisper, env);
  const whisperBuild = path.join(whisper, "build-arm64-ninja");
  const llvm = path.join(env.VCToolsInstallDir, "..", "..", "Llvm", "ARM64", "bin", "clang-cl.exe");
  run(
    "cmake",
    [
      "-S",
      whisper,
      "-B",
      whisperBuild,
      "-G",
      "Ninja",
      `-DCMAKE_C_COMPILER=${llvm}`,
      `-DCMAKE_CXX_COMPILER=${llvm}`,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_SYSTEM_PROCESSOR=ARM64",
      "-DBUILD_SHARED_LIBS=OFF",
      "-DGGML_NATIVE=OFF",
      "-DGGML_OPENMP=OFF",
      "-DWHISPER_BUILD_SERVER=ON",
      "-DWHISPER_BUILD_TESTS=OFF",
      "-DWHISPER_CURL=OFF",
      "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
    ],
    { env }
  );
  run(
    "cmake",
    [
      "--build",
      whisperBuild,
      "--config",
      "Release",
      "--target",
      "whisper-server",
      "--parallel",
      "4",
    ],
    { env }
  );
  copyNative(
    findBinaryInDir(whisperBuild, "whisper-server.exe"),
    path.join(bin, "whisper-server-win32-arm64.exe")
  );

  const qdrant = path.join(cache, "qdrant");
  sourceCheckout("qdrant/qdrant", "016542aa5deb6c66380bb137badf73d54f742bde", qdrant, env);
  const cargo = path.join(process.env.USERPROFILE, ".cargo", "bin", "cargo.exe");
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  env[pathKey] = path.dirname(cargo) + ";" + env[pathKey];
  env.LIBCLANG_PATH = path.resolve(env.VCToolsInstallDir, "../../Llvm/ARM64/bin");
  const protocArchive = path.join(cache, "protoc.zip");
  const protocHash = "70381b116ab0d71cb6a5177d9b17c7c13415866603a0fd40d513dafe32d56c35";
  if (
    !fs.existsSync(protocArchive) ||
    crypto.createHash("sha256").update(fs.readFileSync(protocArchive)).digest("hex") !== protocHash
  ) {
    await downloadFile(
      "https://github.com/protocolbuffers/protobuf/releases/download/v31.1/protoc-31.1-win64.zip",
      protocArchive
    );
  }
  if (
    crypto.createHash("sha256").update(fs.readFileSync(protocArchive)).digest("hex") !== protocHash
  )
    throw new Error("protoc checksum mismatch");
  await extractZip(protocArchive, path.join(cache, "protoc"));
  env.PROTOC = path.join(cache, "protoc", "bin", "protoc.exe");
  run(
    cargo,
    ["build", "--release", "--locked", "--target", "aarch64-pc-windows-msvc", "--bin", "qdrant"],
    { env, cwd: qdrant }
  );
  copyNative(
    path.join(qdrant, "target", "aarch64-pc-windows-msvc", "release", "qdrant.exe"),
    path.join(bin, "qdrant-win32-arm64.exe")
  );
  task("build-meeting-aec-helper.js", ["--arch", "arm64"]);
  for (const script of [
    "download-whisper-vad-model.js",
    "download-minilm.js",
    "download-diarization-models.js",
    "download-brand-fonts.js",
  ]) {
    const args = script.includes("diarization")
      ? ["--output-dir", path.join(bin, "diarization-models")]
      : script.includes("minilm")
        ? ["--for-build"]
        : [];
    task(script, args);
  }
  task("build-whisper-npu.js");
  for (const file of fs.readdirSync(bin))
    if (/\.(exe|dll)$/i.test(file) && !/x64|darwin|linux|^nircmd\.exe$/i.test(file))
      assertPeArchitecture(path.join(bin, file));
}

if (require.main === module)
  prepare().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { prepare, FFMPEG, WHISPER_COMMIT };
