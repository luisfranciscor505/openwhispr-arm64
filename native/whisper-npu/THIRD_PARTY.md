# References and notices

The helper implements Whisper preprocessing and autoregressive decoding for
Qualcomm AI Hub's precompiled Hugging Face Whisper encoder/decoder interface.
Reference implementations:

- Qualcomm AI Hub Models, `templates/hf_whisper` (BSD-3-Clause):
  https://github.com/qualcomm/ai-hub-models
- OpenAI Whisper (MIT): https://github.com/openai/whisper
- Hugging Face Transformers Whisper feature extraction (Apache-2.0):
  https://github.com/huggingface/transformers

The build downloads nlohmann JSON 3.12.0 (MIT), Microsoft ONNX Runtime 1.30.0,
and Qualcomm QNN EP 2.6.0. Their original notices and license conditions apply.
ONNX Runtime and QNN packages include their own bundled component notices;
these are copied to the helper's runtime directory by the build script.

Silero VAD uses the same pinned whisper.cpp/GGML implementation and packaged
GGML model as the CPU backend. It runs on ARM64 CPU before NPU graph execution.
The static Whisper library's MIT license is copied as WHISPER-LICENSE.txt.

The NPU model is downloaded separately from Qualcomm's public model repository.
The tokenizer comes from the pinned `openai/whisper-base` Hugging Face revision.
