"""Decode a mono 16 kHz PCM recording using a candidate or the live recognizer."""
import argparse
import io
import json
import sys
import time
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import shared_stt as stt

VOCABULARY = "일부개정조례안, 제안설명, 심사보고, 자료 제출, 경기도신용보증재단."


def run_comparison(audio_path, output_path, variant):
    with wave.open(str(audio_path), "rb") as recording:
        if (recording.getframerate(), recording.getnchannels(), recording.getsampwidth()) != (16000, 1, 2):
            raise ValueError("Expected signed 16-bit mono PCM WAV at 16 kHz")
        pcm = recording.readframes(recording.getnframes())

    model = stt.load_model()
    previous = ""
    chunks = []
    counts = {"calls": 0, "beam5": 0}
    original_decode = stt.transcribe_audio

    def count_decode(*args, **kwargs):
        counts["calls"] += 1
        if kwargs.get("beam_size") == 5:
            counts["beam5"] += 1
        return original_decode(*args, **kwargs)

    started = time.perf_counter()
    with patch.object(stt, "transcribe_audio", count_decode):
        for offset, raw in stt.audio_chunks(io.BytesIO(pcm).read):
            samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
            if np.sqrt(np.mean(samples * samples)) < 0.004:
                continue
            if variant == "live":
                segments = stt.transcribe_live(model, samples, previous)
            else:
                segments = stt.transcribe_audio(
                    model, samples, "" if variant == "no_previous" else previous,
                    VOCABULARY if variant == "vocabulary" else "",
                    beam_size=5 if variant == "beam5" else 2,
                )
            displayed = []
            for segment in segments:
                original, text, _ = stt.quality_decision(segment)
                if original == text:
                    previous = (previous + " " + original)[-300:]
                displayed.append(text)
            chunks.append({"start": offset, "text": " ".join(displayed)})
            print(variant, round(offset, 2), chunks[-1]["text"], flush=True)
    result = {"variant": variant, "seconds": time.perf_counter() - started, "calls": counts, "chunks": chunks}
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav")
    parser.add_argument("output")
    parser.add_argument("variant", choices=["baseline", "no_previous", "beam5", "vocabulary", "live"])
    args = parser.parse_args()
    run_comparison(args.wav, args.output, args.variant)
