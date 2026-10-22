#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { downloadFile, extractZip } = require("./lib/download-utils");
const { run, compilerEnvironment, copyArm64Crt } = require("./lib/windows-arm64-tools");
const { assertPeArchitecture } = require("../src/helpers/peArchitecture");

const root = path.resolve(__dirname, "..");
const cache = path.join(root, ".cache", "arm64");
const packages = {
  ort: {
    url: "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/1.30.0/microsoft.ml.onnxruntime.1.30.0.nupkg",
    hash: "30df119bd9164eaa187666d93147448fdd4a9a1a3caf83f1505daf7af2d1c5d2",
  },
  qnn: {
    url: "https://api.nuget.org/v3-flatcontainer/qualcomm.ml.onnxruntime.qnn/2.6.0/qualcomm.ml.onnxruntime.qnn.2.6.0.nupkg",
    hash: "c2fe66eeaf92a0cb89faef1d4d05c23b939896aeb9dcfa2261d8fe70b54b8103",
  },
  json: {
    url: "https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp",
    hash: "aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63",
  },
};

async function build() {
  if (process.platform !== "win32" || process.arch !== "arm64")
    throw new Error("The QNN helper requires native Windows ARM64.");
  fs.mkdirSync(cache, { recursive: true });
  for (const [name, info] of Object.entries(packages)) {
    const file = path.join(cache, name === "json" ? "json.hpp" : `${name}.nupkg`);
    const hash = () =>
      fs.existsSync(file) &&
      crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (hash() !== info.hash) await downloadFile(info.url, file);
    if (hash() !== info.hash) throw new Error(`${name}: checksum mismatch`);
    if (name !== "json") await extractZip(file, path.join(cache, name));
  }
  const out = path.join(root, "resources", "bin", "whisper-npu");
  fs.mkdirSync(out, { recursive: true });
  const nativeSource = path.join(root, "native", "whisper-npu");
  for (const file of fs
    .readdirSync(nativeSource)
    .filter((name) => /LICENSE|THIRD_PARTY/i.test(name)))
    fs.copyFileSync(path.join(nativeSource, file), path.join(out, file));
  for (const name of ["ort", "qnn"]) {
    const native = path.join(cache, name, "runtimes", "win-arm64", "native");
    for (const file of fs.readdirSync(native)) {
      if (/\.(dll|so|cat)$/i.test(file)) {
        if (file.endsWith(".dll")) assertPeArchitecture(path.join(native, file));
        fs.copyFileSync(path.join(native, file), path.join(out, file));
      }
    }
    for (const file of fs.readdirSync(path.join(cache, name))) {
      if (/license|notice|privacy/i.test(file))
        fs.copyFileSync(path.join(cache, name, file), path.join(out, `${name}-${file}`));
    }
  }
  const env = compilerEnvironment();
  const whisper = path.join(cache, "whisper.cpp");
  const whisperBuild = path.join(whisper, "build-arm64-ninja");
  if (!fs.existsSync(path.join(whisperBuild, "src", "whisper.lib")))
    throw new Error(
      "Build the pinned ARM64 Whisper libraries first with npm run prepare:win:arm64."
    );
  fs.copyFileSync(path.join(whisper, "LICENSE"), path.join(out, "WHISPER-LICENSE.txt"));
  copyArm64Crt(out, env);
  copyArm64Crt(path.dirname(out), env);
  run(
    "cl.exe",
    [
      "/std:c++20",
      "/O2",
      "/EHsc",
      "/MD", // match the pinned clang-cl Whisper libraries; CRT DLLs are bundled above
      "/nologo",
      `/I${cache}`,
      `/I${path.join(cache, "ort", "build", "native", "include")}`,
      `/I${path.join(whisper, "include")}`,
      `/I${path.join(whisper, "ggml", "include")}`,
      path.join(root, "native", "whisper-npu", "main.cpp"),
      `/Fo:${path.join(cache, "whisper-npu.obj")}`,
      `/Fe:${path.join(out, "whisper-npu.exe")}`,
      path.join(cache, "ort", "runtimes", "win-arm64", "native", "onnxruntime.lib"),
      "advapi32.lib",
      path.join(whisperBuild, "src", "whisper.lib"),
      ...["ggml", "ggml-base", "ggml-cpu"].map((name) =>
        path.join(whisperBuild, "ggml", "src", `${name}.lib`)
      ),
    ],
    { env, cwd: cache }
  );
  assertPeArchitecture(path.join(out, "whisper-npu.exe"));
}
if (require.main === module)
  build().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { build, packages };
