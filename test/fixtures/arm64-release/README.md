# Fixed speech fixtures

These clips contain no user recordings or account data.

- `fox.wav`: public Qualcomm Whisper reference clip, downloaded from
  https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/hf_whisper_asr_shared/v1/audio/fox.wav
- `spanish.wav`: synthetic Spanish test speech generated locally with Windows
  speech synthesis during the ARM64 port verification; contains the word "prueba".

The manifest pins the bytes used for every release test. Do not replace either
clip silently or substitute live microphone input.
