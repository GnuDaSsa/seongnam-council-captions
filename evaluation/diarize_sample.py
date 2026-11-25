"""Exploratory anonymous audio-window clustering; never identifies a person.

Requires onnxruntime, numpy, scipy and kaldi-native-fbank. No model downloads.
Usage: python diarize_sample.py AUDIO.wav WESPEAKER.onnx OUTPUT.json
"""
import os
# Process-local limits only; this does not edit user or machine environment settings.
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['MKL_NUM_THREADS'] = '1'
import argparse
import hashlib
import json
import time
import wave
from pathlib import Path
import numpy as np
import onnxruntime as ort
import kaldi_native_fbank as knf
from scipy.cluster.hierarchy import linkage, fcluster


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('audio', type=Path)
    parser.add_argument('model', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Choose a new output file')
    with wave.open(str(args.audio), 'rb') as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
            raise ValueError('Requires 16 kHz mono PCM16')
        if wav.getnframes() > 90 * 16000:
            raise ValueError('Evaluation is bounded to 90 seconds')
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    session = ort.InferenceSession(str(args.model), opts, providers=['CPUExecutionProvider'])
    vectors, windows = [], []
    start_time = time.perf_counter()
    for start in range(0, len(samples), 3 * 16000):
        part = samples[start:start + 3 * 16000]
        if len(part) < 16000:
            continue
        rms = float(np.sqrt(np.mean((part / 32768.0) ** 2)))
        if rms < 0.004:
            continue
        fopts = knf.FbankOptions()
        fopts.frame_opts.samp_freq = 16000
        fopts.frame_opts.dither = 0
        fopts.mel_opts.num_bins = 80
        fb = knf.OnlineFbank(fopts)
        fb.accept_waveform(16000, part.tolist())
        fb.input_finished()
        if fb.num_frames_ready < 50:
            continue
        feat = np.array([fb.get_frame(i) for i in range(fb.num_frames_ready)], dtype=np.float32)
        feat -= feat.mean(axis=0, keepdims=True)
        vector = session.run(None, {'feats': feat[None, :, :]})[0].reshape(-1)
        norm = np.linalg.norm(vector)
        if not np.isfinite(norm) or norm == 0:
            continue
        vectors.append(vector / norm)
        windows.append({'start': start / 16000, 'end': (start + len(part)) / 16000, 'rms': round(rms, 6)})
    if len(vectors) < 2:
        raise ValueError('Not enough non-silent windows')
    # Exploratory threshold, fixed before inspecting this clip: not calibrated to this room/language.
    cluster = fcluster(linkage(np.stack(vectors), method='average', metric='cosine'), 0.65, criterion='distance')
    for window, label in zip(windows, cluster):
        window['cluster'] = int(label)
    changes = [
        current['start'] for previous, current in zip(windows, windows[1:])
        if current['cluster'] != previous['cluster'] and current['start'] == previous['end']
    ]
    result = {'method': '3 s fixed windows; 80-bin fbank, WeSpeaker embedding, average-linkage cosine distance 0.65; energy gate 0.004',
              'not_speaker_identity': True, 'not_validated_turns': True,
              'elapsed_seconds': round(time.perf_counter() - start_time, 2),
              'wav_sha256': hashlib.sha256(args.audio.read_bytes()).hexdigest(),
              'model_sha256': hashlib.sha256(args.model.read_bytes()).hexdigest(),
              'windows': windows, 'clusters': len(set(map(int, cluster))), 'candidate_boundaries': changes}
    with args.output.open('x', encoding='utf8') as file:
        json.dump(result, file, ensure_ascii=False, indent=2)
    print(json.dumps({k: result[k] for k in ('elapsed_seconds','clusters','candidate_boundaries')}, ensure_ascii=False))

if __name__ == '__main__':
    main()
