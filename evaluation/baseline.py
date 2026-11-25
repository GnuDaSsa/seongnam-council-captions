"""Approximate browser tiny model using faster-whisper, 8 s independent chunks.

This is not transformers.js; report engine difference with all results.
Usage: python baseline.py AUDIO.wav TINY_MODEL OUTPUT.json
"""
import json, sys, time, wave
from pathlib import Path
import numpy as np
from faster_whisper import WhisperModel

audio, model_path, output = map(Path, sys.argv[1:])
with wave.open(str(audio), 'rb') as f:
    assert f.getframerate() == 16000 and f.getnchannels() == 1 and f.getsampwidth() == 2
    samples = np.frombuffer(f.readframes(f.getnframes()), dtype='<i2').astype(np.float32) / 32768
assert len(samples) == 600 * 16000
model = WhisperModel(str(model_path), device='cpu', compute_type='int8', local_files_only=True)
start = time.perf_counter()
chunks = []
for i in range(0, len(samples), 8 * 16000):
    segments, _ = model.transcribe(samples[i:i+8*16000], language='ko', beam_size=1,
                                   condition_on_previous_text=False, vad_filter=False)
    text = ''.join(s.text for s in segments).strip()
    chunks.append({'start': i/16000, 'end': min((i+8*16000)/16000, 600), 'text': text})
    print(f'{i/16000:.0f}: {text}', flush=True)
output.write_text(json.dumps({'engine': 'faster-whisper tiny int8, approximation of browser transformers.js',
    'wall_seconds': time.perf_counter()-start, 'chunks': chunks}, ensure_ascii=False, indent=2), encoding='utf-8')
