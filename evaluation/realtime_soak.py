"""Offline 1x paced local-audio -> Whisper -> signed in-memory Worker soak."""

import argparse
import datetime as dt
import hashlib
import json
import os
import subprocess
import sys
import time
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import shared_stt as stt


def stamp(t):
    return (
        dt.datetime.fromtimestamp(t, dt.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--wav", required=True, type=Path)
    p.add_argument("--sha256", required=True)
    p.add_argument("--model", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--threads", type=int, default=1, choices=[1, 2])
    a = p.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    actual = hashlib.file_digest(a.wav.open("rb"), "sha256").hexdigest()
    if actual != a.sha256.lower():
        raise ValueError("PCM hash mismatch")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["OMP_NUM_THREADS"] = str(a.threads)
    os.environ["MKL_NUM_THREADS"] = str(a.threads)
    import numpy as np
    from faster_whisper import WhisperModel

    with wave.open(str(a.wav), "rb") as test:
        if (test.getnchannels(), test.getsampwidth(), test.getframerate()) != (
            1,
            2,
            16000,
        ):
            raise ValueError("expected mono PCM 16kHz")
        duration = test.getnframes() / 16000
    if duration != 2700:
        raise ValueError("expected exactly 45 minutes")
    model = WhisperModel(
        str(a.model),
        device="cpu",
        compute_type="int8",
        cpu_threads=a.threads,
        num_workers=1,
        local_files_only=True,
    )
    with (a.out / "worker.err").open("w", encoding="utf8") as worker_errors:
        child = subprocess.Popen(
            [
                "node",
                str(Path(__file__).with_name("realtime_soak_worker.mjs")),
                str(a.out.resolve()),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=worker_errors,
            text=True,
            encoding="utf8",
            bufsize=1,
        )

    def command(value):
        child.stdin.write(json.dumps(value, ensure_ascii=False) + "\n")
        child.stdin.flush()
        line = child.stdout.readline()
        if not line:
            raise RuntimeError("local worker stopped")
        reply = json.loads(line)
        if not reply.get("ok"):
            raise RuntimeError(reply.get("error", "worker error"))
        return reply

    try:
        start_wall = time.time()
        start_mono = time.monotonic()
        command({"type": "init", "startWall": round(start_wall * 1000)})
        previous = ""
        counter = 0
        count = 0
        max_lag = 0
        over60 = 0
        times = []
        with (a.out / "run-meta.json").open("w", encoding="utf8") as f:
            json.dump(
                {
                    "startedAt": stamp(start_wall),
                    "pcmSha256": actual,
                    "duration": duration,
                    "model": "faster-whisper-small",
                    "threads": a.threads,
                    "prompt": "generic; previous local text only",
                    "clock": "wall-clock 1x, decode starts no earlier than media chunk end",
                    "worker": "actual local createSite; ephemeral signing key; in-memory storage; no network",
                    "workerHarnessSha256": hashlib.sha256(
                        Path(__file__)
                        .with_name("realtime_soak_worker.mjs")
                        .read_bytes()
                    ).hexdigest(),
                    "publisherSha256": hashlib.sha256(
                        Path(stt.__file__).read_bytes()
                    ).hexdigest(),
                    "caveat": "when processing lags, file audio waits rather than real microphone buffering; no producer drop inferred",
                },
                f,
                ensure_ascii=False,
                indent=2,
            )
        with (
            wave.open(str(a.wav), "rb") as reader,
            (a.out / "chunks.jsonl").open("w", encoding="utf8", buffering=1) as log,
        ):
            for index, (offset, pcm) in enumerate(
                stt.audio_chunks(lambda n: reader.readframes(n // 2))
            ):
                end = offset + len(pcm) / 32000
                deadline = start_mono + end
                delay = deadline - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                began = time.monotonic()
                samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
                rms = float(np.sqrt(np.mean(samples * samples)))
                segments = (
                    stt.transcribe_live(model, samples, previous, "")
                    if rms >= 0.004
                    else []
                )
                batch, counter, invalid = stt.cue_batch(
                    segments, offset, len(pcm) / 32000, start_wall, counter
                )
                for cue in batch:
                    if cue["rawText"] == cue["text"]:
                        previous = (previous + " " + cue["rawText"])[-300:]
                lag = round(max(0, time.monotonic() - deadline), 3)
                max_lag = max(max_lag, lag)
                over60 += lag > 60
                times.append(time.monotonic() - began)
                command(
                    {
                        "type": "publish",
                        "cues": batch,
                        "status": "live" if batch else "listening",
                        "mediaEnd": round(end, 3),
                        "lagSeconds": lag,
                    }
                )
                count += len(batch)
                row = {
                    "index": index,
                    "start": round(offset, 3),
                    "end": round(end, 3),
                    "rms": round(rms, 6),
                    "decoded": rms >= 0.004,
                    "processingSeconds": round(times[-1], 3),
                    "lagSeconds": lag,
                    "cues": len(batch),
                    "invalidTime": invalid,
                    "wall": stamp(time.time()),
                }
                log.write(json.dumps(row, ensure_ascii=False) + "\n")
                print(json.dumps(row, ensure_ascii=False), flush=True)
        command(
            {
                "type": "publish",
                "cues": [],
                "status": "interrupted",
                "mediaEnd": duration,
                "lagSeconds": round(
                    max(0, time.monotonic() - start_mono - duration), 3
                ),
            }
        )
        result = command({"type": "finish", "mediaEnd": duration})["result"]
        result.update(
            maxLagSeconds=max_lag,
            chunksOver60Seconds=over60,
            decoderChunks=len(times),
            decodedCues=count,
            meanProcessingSeconds=sum(times) / len(times) if times else 0,
            pcmSha256=actual,
        )
        (a.out / "summary.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
        )
        print("SOAK_COMPLETE", json.dumps(result, ensure_ascii=False), flush=True)
    finally:
        try:
            child.stdin.close()
        except OSError:
            pass
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)


if __name__ == "__main__":
    main()
