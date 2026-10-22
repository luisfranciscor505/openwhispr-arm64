# Windows ARM64 and Snapdragon NPU

This build keeps Electron and runs the application, native Node modules, and
bundled helper processes as ARM64. The unsigned NSIS installer uses its standard
bootstrap; the installed application does not require x64 emulation.

## Build

Use native ARM64 Node.js 24 on Windows 11. Install Visual Studio 2022 Build Tools
with the C++ workload, ARM64 compiler/libraries, Windows SDK, CMake/Ninja, and the
ARM64 LLVM compiler. Also install Python and native ARM64 Rust (Rust 1.98 or newer).
Initialize Rust with `rustup default stable-aarch64-pc-windows-msvc`.

```powershell
npm ci
npm run build:win:arm64
```

The output is `dist/OpenWhispr-1.10.4-windows-arm64.exe`. For an unpacked build,
use `npm run pack:win:arm64`. Preparation compiles the Windows helpers, Whisper,
Qdrant, and WebRTC echo cancellation; downloads ARM64 llama.cpp, Sherpa, FFmpeg,
and yt-dlp; and builds the NPU helper. Source trees and build tools downloaded by
the scripts are cached under `.cache/arm64`. The first source build can take a
while, particularly Qdrant's release link.

The verified installer for this checkout is in `dist-arm64/`. To reproduce that
output location, pass `--config.directories.output=dist-arm64` to electron-builder.
The ARM64 configuration forces the BCJ archive filter: electron-builder 26.15.3's
default ARM64 filter cannot be decoded by its bundled NSIS extraction plugin.
Removing this setting can produce an installer that silently omits executables.

Build scripts discover Visual Studio themselves. They do not need a developer
shell. ARM64 Whisper/WebRTC use clang-cl with Ninja; the Windows C helpers use
MSVC. Protobuf's pinned compiler is used only during the Qdrant build and is not
shipped in the application.

## Use the NPU

1. In local transcription settings, download **Whisper Base — Snapdragon NPU**.
   This also installs the regular Base model for offline CPU fallback.
2. Select that model and choose **Automatic**, **NPU**, or **CPU**.
3. Automatic tries the NPU and retries a failed request once on ARM64 CPU.
   Explicit NPU mode reports an error when NPU inference cannot run.

Existing model choices are preserved. Existing GGML Whisper files and Sherpa
models continue using their existing engines. NPU acceleration applies to the
new Whisper Base model in dictation, local file transcription, and local meeting
chunks. Language-model reasoning, text embeddings, and speaker identification
remain on CPU.

NPU inference needs a working Qualcomm Hexagon driver, but installed users do not
need Python, Visual Studio, a Qualcomm account, or the developer SDK. After the
model download, inference works offline. The downloadable context is Qualcomm's
X Elite artifact; compatibility with X Plus is established by executing both
graphs on the actual device, with CPU graph fallback disabled.

QNN requires its own compiled models. Dropping a GGML file into the NPU model
folder does not work. The NPU package, ONNX context files, tokenizer, and runtime
versions are pinned in `src/models/whisperNpuManifest.json` and
`scripts/build-whisper-npu.js`. The runtime uses ONNX Runtime 1.30.0 and QNN EP
2.6.0 (QAIRT 2.50.40), compatible with the model's QAIRT 2.50.0 contexts.

The helper uses CPU log-mel preprocessing and token decoding around NPU encoder
and decoder execution. It reuses the packaged Silero VAD model and context
settings through the pinned Whisper library on CPU. Long speech regions are
split at quiet boundaries within the graphs' ten-second input limit, retaining
the original audio positions. It emits chunk-level timestamps rather than word-level
alignment. Initial prompts currently require CPU; Automatic falls back and NPU
mode explains the limitation. This local build disables upstream updates to
prevent an incompatible release replacing it.

## Verification

```powershell
npm run verify:win:arm64
node --test test/helpers/peArchitecture.test.js test/helpers/whisperNpu.test.js test/helpers/whisperNpuFallback.test.js
npm run typecheck
npm run lint
electron scripts/verify-windows-arm64-engines.js
electron scripts/verify-windows-arm64-search.js
node scripts/verify-windows-arm64-installation.js
electron scripts/verify-windows-arm64-ui.js --installed
electron scripts/verify-windows-arm64-ui.js --installed --audio-flows
electron scripts/verify-windows-arm64-ui.js --installed --meeting-flows
electron scripts/verify-windows-arm64-ui.js --installed --search-flows
electron scripts/verify-windows-arm64-paste.js
electron scripts/verify-windows-arm64-long-audio.js
electron scripts/verify-windows-arm64-long-audio.js --vad
```

The Electron verification command uses a separate model cache and writes results
to `artifacts/windows-arm64/verification.json`. It measures cold loading and warm
transcription for the same reference recording on NPU and CPU. It also saves ONNX
profiling files and checks that both encoder and decoder kernels use
`QNNExecutionProvider`. Build packaging independently validates PE architecture
for every shipped EXE, DLL, and native Node module outside the ASAR.

Results are device-specific. Compare warm inference separately from cold model
loading, and run measurements without simultaneous source builds. A working NPU
does not by itself guarantee lower latency for every model or recording.

The installed payload and its private NPU runtime were verified on this machine.
See `artifacts/windows-arm64/VALIDATION.md` for measurements and the remaining
acceptance checks. Real microphone recording, paste targets, and real meeting
apps still need interactive checks; reference audio alone does not establish
those behaviors. The ARM64 renderer build pairs the default hosted auth service
with `https://api.openwhispr.com`, including the main process's runtime config.
This is required for signed-in workspace policy to resolve during onboarding.
Custom auth deployments must configure their matching API URL; the build never
defaults their credentials to the public API. Choose **Continue without account**
for local use. Use `npm run build:renderer:win:arm64` when rebuilding this
renderer separately from the installer.

## Third-party resources

- [Qualcomm Whisper models and reference application](https://aihub.qualcomm.com/apps/whisper_windows_py)
- [Qualcomm QNN execution provider](https://github.com/onnxruntime/onnxruntime-qnn)
- [ONNX Runtime](https://github.com/microsoft/onnxruntime)
- [OpenAI Whisper](https://github.com/openai/whisper)
- [nlohmann JSON](https://github.com/nlohmann/json)
- [BtbN FFmpeg builds](https://github.com/BtbN/FFmpeg-Builds)

Runtime package notices are copied beside the NPU helper. FFmpeg's license files
are copied to `resources/bin/arm64-licenses`. Keep the model and tokenizer license
notices with any redistributed model assets.
