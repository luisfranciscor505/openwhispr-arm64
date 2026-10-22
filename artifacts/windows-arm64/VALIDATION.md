# Windows ARM64 verification — 22 October 2026

Built and installed unsigned OpenWhispr 1.10.4 on Windows 11 ARM64, Snapdragon
X Plus X1P42100. Native Electron 41.10.7, Node 24.19.0. NPU inference was
demonstrated on this machine using Qualcomm Whisper Base v0.65.0, ONNX Runtime
1.30.0, and QNN EP 2.6.0 / QAIRT 2.50.40.

## Deliverable

`dist-arm64/OpenWhispr-1.10.4-windows-arm64.exe` — unsigned, 427,055,604 bytes.

SHA-256: `f6ca95bcd995332f701ae63f411af884c277b11b83a846e6fe73352528377d07`

Installed at `%LOCALAPPDATA%\Programs\OpenWhispr`. Installer exited 0. All 87
application EXE/DLL/native Node images are ARM64; their bytes and `app.asar`
match the unpacked build. The standard NSIS installer/uninstaller bootstrap is
outside this application runtime audit. Its archive uses `LZMA2 BCJ`, avoiding
the legacy NSIS decoder's unsupported ARM64 filter. Native application startup
from the installed ASAR passed in an isolated Electron profile (two windows,
rendered Spanish onboarding, no fatal startup errors).

The installed helper transcribed reference audio with only Windows system
directories on PATH, using its bundled redistributables. No Python, compiler,
developer SDK, repository DLL directory, or network download was required.
Both installed encoder and decoder profiles contain QNNExecutionProvider kernel
events, with CPU graph fallback forbidden and QNN HTP selected. Raw evidence:
`installation-verification.json` and `installed-npu-profiles/`.

## Measurements

Same 4.9267-second English reference clip for CPU and NPU; both returned exactly
“The quick brown fox jumps over the lazy dog.” Normalized reference word error
rate is 0 for this single sentence. These are individual samples, not a broad
accuracy study or statistically reliable speed estimate.

| Measurement | Milliseconds | Real-time factor |
| --- | ---: | ---: |
| NPU load plus executed graph probe | 872 | — |
| NPU first transcription after load | 321 | 0.065 |
| NPU warm transcription | 311 | 0.063 |
| CPU first request including server/model startup | 3,507 | 0.712 |
| CPU warm transcription | 2,297 | 0.466 |

NPU and CPU cold measurements have different boundaries as labeled; source
builds and other checks were running during parts of verification. Results do
not establish a general speed improvement. Full output: `verification.json`.

Spanish synthetic reference speech was recognized correctly (7.45-second clip,
422 ms). Automatic language detection passed on English. The 39.41-second
recording also passed. A longer 591.20-second recording preserved all 120
sentences / 1,080 reference words in order, with VAD disabled (26,970 ms, 61
chunks) and enabled (40,607 ms, 120 speech segments). Real-time factors were
0.046 and 0.069 respectively, including cold loading. These repeated-reference
tests do not establish accuracy on arbitrary conversations. The longer test
exposed fixed-cut word loss; quiet-boundary splitting fixed that regression.
Five seconds of silence with Silero VAD returned no text or segments.
Timestamps retain source positions and are chunk-level, not word alignment.
Evidence: `long-audio-verification.json`, `long-audio-vad-verification.json`.

## Other checks

- Real NPU cancellation terminates the helper; a fresh helper recovers and
  transcribes correctly. Successful inference clears a stale failure reason.
- Installed helper rejects an invalid QNN context with “Failed to load from
  EpContext model. Failed to get context binary info.” Missing model reports an
  unavailable reason without claiming NPU availability.
- Automatic CPU retry, explicit NPU failure, CPU selection, helper crash,
  timeout, serialization, preference persistence, and architecture rejection
  passed targeted automated tests.
- SQLite query, keyring module load, native Node ONNX runtime, MiniLM embedding
  inference (384 dimensions), speaker embedding (512 dimensions), and actual
  diarization (eight speech segments) passed. Local LFM2.5 reasoning returned
  “Hello! How can I assist you today?” using ARM64 CPU.
- Actual MiniLM embeddings were inserted into the installed native Qdrant
  server and queried by semantic similarity. “medical care for sick people”
  ranked the hospital/doctor document first out of three. This verifies vector
  storage and retrieval; it does not exercise the application's entire search UI.
- The installed application's renderer API also passed note creation, SQLite
  vector-change journaling, asynchronous native indexing, and semantic retrieval.
  After cold indexing warmed, a medical-care query returned the hospital note;
  the same query returned no keyword matches. Evidence: `installed-search-flow.json`.
- WASAPI helper capability probe, FFmpeg audio conversion, llama.cpp, yt-dlp,
  Qdrant executable startup, and preprocessing FFT numerical self-test passed.
  FFT max absolute error against a direct DFT: 0.0000157.
- Installed native process detection passed: the ARM64 Toolhelp helper returned
  the running test host in the process list. The installed startup report
  records only the process count and this check, not process names.
- Installed-app audio flows passed through the actual renderer preload and main
  IPC handlers: browser MediaRecorder reference audio returned the correct NPU
  transcript, and the normal selected-file import preserved segments/backend.
  The physical microphone opened and recorded two seconds (diagnostic byte
  count only; no microphone recording retained). Native WASAPI capture streamed
  PCM and stopped cleanly. Evidence: `installed-audio-flows.json`.
- The installed local meeting start/send/stop path passed using controlled
  reference PCM at the capture callback boundary. English microphone speech
  and Spanish system speech produced separate final segments, correct source
  labels, increasing epoch timestamps, and an ordered combined transcript.
  Automatic language detection handled both. Backend remained QNN HTP with no
  fallback. Hardware WASAPI capture was tested separately; the reference meeting
  test does not substitute for a real conferencing application's audio.
- Native SendInput paste passed in a controlled Electron textarea through the
  installed ARM64 helper, including native focus restoration. The clipboard
  image was restored and its pixels verified unchanged. The test refuses to
  paste if its native foreground guard cannot identify the test window.
  Evidence: `paste-verification.json`.
- Renderer cleanup preserves NPU/CPU backend diagnostics and CPU fallback
  warnings. The new regression plus existing dictionary-prompt recovery tests
  passed: 29 tests, zero failures.
- Current affected regression selection: 48 passed, zero failures. An additional
  64 meeting/file tests passed, covering routing, stop races, timeline handling,
  microphone holdback, epoch timestamps, and file segment propagation. Earlier
  relevant Whisper/updater/AEC regression selection: 181 passed. Type checking
  and renderer production compilation passed. Full lint passed with warnings
  only; cached upstream source/build files are excluded from application lint.

The full Node test run before the final regression fixes reported 8,150 passed,
67 failed, 496 skipped (8,714 total including a todo). Three affected cases were
fixed and passed on rerun: registry ordering preserved and Windows media tests
made architecture-specific. The full suite was not rerun afterward. Other
failures include Electron-versus-Node SQLite ABI mismatch, translation test
initialization/language assumptions, and POSIX path expectations on Windows.
Do not interpret the targeted results as a completely passing full suite.
Full log: `.cache/arm64/full-tests.log`.

## Remaining acceptance

User-spoken microphone dictation, paste into the user's applications, actual meeting
audio/channel attribution, driver-unavailable behavior on real hardware, and installation on a separate
clean Windows account/machine remain unverified. Driver failure and fallback
are covered by injected failures; the working device's driver was not disabled.
The payload was installed and updated in this account, not a pristine OS image.

The ARM64 build now pairs default hosted sign-in with the public cloud API in
both renderer and main-process runtime configuration. The previous missing API
setting caused authenticated policy resolution to fail and hid every setup
choice. Endpoint availability and configuration regression tests passed; the
actual existing onboarding session was checked after installing this fix: the
local and cloud setup cards are visible and the unavailable-policy screen is
gone. Evidence: `onboarding-setup-verification.json`. The temporary local
inspection session was closed and the application restarted normally.
Custom auth deployments retain their own API configuration. Local use remains
available through **Continue without account**. Existing user
model choices were preserved; the verified NPU and Base fallback assets were
seeded into the user's model cache without replacing existing files.

Use `docs/windows-arm64.md` for build, model preparation, and verification
commands. Do not mark the complete acceptance plan satisfied until the remaining
hands-on checks have passed.

The user has been asked to test real dictation/paste and a short meeting with
the NPU model in explicit NPU mode. Those results are pending. Further acceptance
requires that input or access to a separate clean test environment; repeating
the successful automated checks cannot prove those remaining cases.
