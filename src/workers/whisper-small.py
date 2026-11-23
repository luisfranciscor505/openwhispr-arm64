"""Local Whisper Small worker for the Qualcomm Hexagon NPU."""

import argparse
import json
from pathlib import Path
import re
import sys
import wave

import numpy as np
import onnxruntime as ort
import onnxruntime_qnn as qnn


SAMPLE_RATE = 16000
WINDOW_SAMPLES = 30 * SAMPLE_RATE
CHUNK_SAMPLES = 25 * SAMPLE_RATE
FFT_SIZE = 400
HOP = 160
DTYPES = {
    "tensor(float)": np.float32,
    "tensor(float16)": np.float16,
    "tensor(int32)": np.int32,
    "tensor(int64)": np.int64,
}


def npu_options():
    name = "QNNExecutionProvider"
    ort.register_execution_provider_library(name, qnn.get_library_path())
    devices = [
        device
        for device in ort.get_ep_devices()
        if device.ep_name == name and device.device.type == ort.OrtHardwareDeviceType.NPU
    ]
    if not devices:
        raise RuntimeError("The Qualcomm NPU is unavailable")
    options = ort.SessionOptions()
    options.add_provider_for_devices(devices[:1], {"backend_path": qnn.get_qnn_htp_path()})
    options.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
    return options


def mel_filter_bank():
    """The 80-band Slaney mel bank used by the Whisper Small checkpoint."""
    frequencies = np.linspace(0, SAMPLE_RATE / 2, FFT_SIZE // 2 + 1)
    step = np.log(6.4) / 27
    mel = np.linspace(0, 15 + np.log(8) / step, 82)
    edges = np.where(mel < 15, mel * 200 / 3, 1000 * np.exp(step * (mel - 15)))
    lower = (frequencies - edges[:-2, None]) / np.diff(edges)[:-1, None]
    upper = (edges[2:, None] - frequencies) / np.diff(edges)[1:, None]
    weights = np.maximum(0, np.minimum(lower, upper))
    return (weights * (2 / (edges[2:] - edges[:-2]))[:, None]).astype(np.float32)


def features(samples, filters):
    padded = np.pad(samples, (0, WINDOW_SAMPLES - samples.size))
    frames = np.lib.stride_tricks.sliding_window_view(
        np.pad(padded, FFT_SIZE // 2, mode="reflect"), FFT_SIZE
    )[::HOP][:-1]
    window = np.hanning(FFT_SIZE + 1)[:-1].astype(np.float32)
    spectrum = np.abs(np.fft.rfft(frames * window, axis=1)) ** 2
    log_mel = np.log10(np.maximum(filters @ spectrum.T, 1e-10))
    return ((np.maximum(log_mel, log_mel.max() - 8) + 4) / 4)[None].astype(np.float32)


class Graph:
    def __init__(self, filename, options):
        self.session = ort.InferenceSession(str(filename), sess_options=options)
        self.inputs = {item.name: item for item in self.session.get_inputs()}
        self.outputs = [item.name for item in self.session.get_outputs()]

    def run(self, values):
        outputs = self.session.run(
            self.outputs,
            {
                name: np.asarray(values[name], dtype=DTYPES[info.type])
                for name, info in self.inputs.items()
            },
        )
        return dict(zip(self.outputs, outputs, strict=True))


class Whisper:
    def __init__(self, encoder, decoder, tokenizer_path, options):
        from tokenizers import Tokenizer

        self.encoder = Graph(encoder, options)
        self.decoder = Graph(decoder, options)
        self.tokenizer = Tokenizer.from_file(str(tokenizer_path))
        self.filters = mel_filter_bank()
        self.sot = self.token("<|startoftranscript|>")
        self.eot = self.token("<|endoftext|>")
        self.no_speech = self.token("<|nocaptions|>")
        self.languages = [
            index
            for token, index in self.tokenizer.get_vocab().items()
            if re.fullmatch(r"<\|[a-z]{2,3}\|>", token)
        ]

    def token(self, text):
        index = self.tokenizer.token_to_id(text)
        if index is None:
            raise ValueError(f"Unsupported Whisper token: {text}")
        return index

    def decode_chunk(self, samples, language, prompt, vad):
        if not samples.size or np.max(np.abs(samples)) < 1e-5:
            return ""
        cross = self.encoder.run({"input_features": features(samples, self.filters)})
        cache = {
            name: np.zeros(slot.shape, dtype=DTYPES[slot.type])
            for name, slot in self.decoder.inputs.items()
            if "_cache_self_" in name
        }
        mask = np.full(self.decoder.inputs["attention_mask"].shape, -100, dtype=np.float32)
        start = []
        if prompt:
            tokens = self.tokenizer.encode(prompt, add_special_tokens=False).ids
            if tokens:
                start = [self.token("<|startofprev|>"), *tokens[-32:]]
        start.append(self.sot)
        language_id = self.token(f"<|{language}|>") if language and language != "auto" else None
        fixed = [self.token("<|transcribe|>"), self.token("<|notimestamps|>")]
        output = []
        log_probability = 0.0
        no_speech_probability = 0.0
        current = start[0]
        for position in range(mask.shape[-1] - 1):
            mask[..., -(position + 1) :] = 0
            reply = self.decoder.run({
                "input_ids": [[current]],
                "position_ids": [position],
                "attention_mask": mask,
                **cache,
                **cross,
            })
            cache = {name: reply[name.removesuffix("_in") + "_out"] for name in cache}
            scores = reply["logits"].reshape(-1).astype(np.float32)
            if position < len(start) - 1:
                current = start[position + 1]
            elif position == len(start) - 1:
                if vad:
                    no_speech_probability = np.exp(scores[self.no_speech] - np.logaddexp.reduce(scores))
                current = language_id if language_id is not None else max(self.languages, key=scores.__getitem__)
            elif position <= len(start) + 1:
                current = fixed[position - len(start)]
            else:
                # Text mode: discard timestamps and other control tokens except EOT.
                scores[self.eot + 1 :] = -np.inf
                current = int(scores.argmax())
                if vad:
                    log_probability += scores[current] - np.logaddexp.reduce(scores)
                if current == self.eot:
                    if no_speech_probability > 0.6 and log_probability / (len(output) + 1) < -1:
                        return ""
                    return self.tokenizer.decode(output, skip_special_tokens=True).strip()
                output.append(current)
        raise RuntimeError("Whisper NPU exceeded the token limit for this audio segment")

    def transcribe(self, audio_path, language, prompt, vad):
        with wave.open(audio_path, "rb") as audio:
            if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (SAMPLE_RATE, 1, 2):
                raise ValueError("Expected mono 16-bit PCM at 16 kHz")
            pieces = []
            while raw := audio.readframes(CHUNK_SAMPLES):
                samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
                text = self.decode_chunk(samples, language, prompt, vad)
                if text:
                    pieces.append(text)
            return " ".join(pieces)


def send(message):
    print(json.dumps(message), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--encoder", type=Path)
    parser.add_argument("--decoder", type=Path)
    parser.add_argument("--tokenizer", type=Path)
    args = parser.parse_args()
    options = npu_options()
    if args.probe:
        send({"ready": True})
        return
    whisper = Whisper(args.encoder, args.decoder, args.tokenizer, options)
    send({"ready": True})
    for line in sys.stdin:
        request = json.loads(line)
        try:
            text = whisper.transcribe(
                request["wav"], request.get("language"), request.get("prompt"), request.get("vad", False)
            )
            send({"id": request["id"], "text": text})
        except Exception as error:
            send({"id": request["id"], "error": str(error)})


if __name__ == "__main__":
    main()
