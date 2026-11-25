"""Send already-generated cue batches at 1x; this does not measure ASR latency."""

import argparse
import datetime as dt
import hashlib
import json
import subprocess
import time
import wave
from pathlib import Path


def stamp(t):
    return (
        dt.datetime.fromtimestamp(t, dt.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--wav", type=Path, required=True)
    p.add_argument("--sha256", required=True)
    p.add_argument("--cues", type=Path, required=True)
    p.add_argument("--chunks", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument(
        "--duration-seconds",
        type=float,
        default=2700,
        help="declared clip duration; default is the full 45-minute run",
    )
    p.add_argument(
        "--worker",
        type=Path,
        default=Path(__file__).with_name("realtime_soak_worker.mjs"),
    )
    a = p.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    sha = hashlib.file_digest(a.wav.open("rb"), "sha256").hexdigest()
    if sha != a.sha256:
        raise ValueError("PCM hash mismatch")
    with wave.open(str(a.wav), "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (
            1,
            2,
            16000,
        ):
            raise ValueError("expected mono PCM 16kHz")
        if audio.getnframes() / 16000 != a.duration_seconds:
            raise ValueError("PCM length does not match declared duration")
    cues = [json.loads(x) for x in a.cues.read_text(encoding="utf8").splitlines()]
    chunks = [json.loads(x) for x in a.chunks.read_text(encoding="utf8").splitlines()]
    if (
        a.duration_seconds <= 0
        or not chunks
        or chunks[0]["start"] != 0
        or chunks[-1]["end"] != a.duration_seconds
    ):
        raise ValueError("chunk plan does not cover the declared duration")
    by_id = {cue["id"]: cue for cue in cues}
    if len(by_id) != len(cues):
        raise ValueError("duplicate cue ID")
    used = set()
    previous_end = 0
    for chunk in chunks:
        if chunk["start"] != previous_end or chunk["end"] <= chunk["start"]:
            raise ValueError("non-contiguous chunk plan")
        for cue_id in chunk["cueIds"]:
            cue = by_id.get(cue_id)
            if (
                cue_id in used
                or cue is None
                or cue["start"] < chunk["start"]
                or cue["end"] > chunk["end"]
            ):
                raise ValueError("invalid or duplicate chunk cue")
            used.add(cue_id)
        previous_end = chunk["end"]
    if used != set(by_id):
        raise ValueError("unreferenced cue")
    with (a.out / "worker.err").open("w", encoding="utf8") as worker_errors:
        child = subprocess.Popen(
            ["node", str(a.worker.resolve()), str(a.out.resolve())],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=worker_errors,
            text=True,
            encoding="utf8",
            bufsize=1,
        )

    def send(x):
        child.stdin.write(json.dumps(x, ensure_ascii=False) + "\n")
        child.stdin.flush()
        line = child.stdout.readline()
        if not line:
            raise RuntimeError("local Worker stopped")
        result = json.loads(line)
        if not result.get("ok"):
            raise RuntimeError(result.get("error"))
        return result

    try:
        wall = time.time()
        mono = time.monotonic()
        send({"type": "init", "startWall": round(wall * 1000)})
        lookup = {x["id"]: x for x in cues}
        (a.out / "run-meta.json").write_text(
            json.dumps(
                {
                    "startedAt": stamp(wall),
                    "mode": "precomputed ASR, 1x paced signed delivery; no ASR latency claim",
                    "pcmSha256": sha,
                    "duration": a.duration_seconds,
                    "cueSourceSha256": hashlib.sha256(a.cues.read_bytes()).hexdigest(),
                    "chunkSourceSha256": hashlib.sha256(
                        a.chunks.read_bytes()
                    ).hexdigest(),
                    "worker": "actual local createSite; ephemeral signing key; in-memory storage; no network",
                    "workerHarnessSha256": hashlib.sha256(
                        a.worker.read_bytes()
                    ).hexdigest(),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf8",
        )
        for chunk in chunks:
            deadline = mono + chunk["end"]
            delay = deadline - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            batch = []
            for id in chunk["cueIds"]:
                x = lookup[id]
                batch.append(
                    {
                        **{
                            k: x[k]
                            for k in ("start", "end", "rawText", "text", "flags")
                        },
                        "id": id.rsplit("-", 1)[1],
                        "observedAt": stamp(wall + x["start"]),
                    }
                )
            lag = round(max(0, time.monotonic() - deadline), 3)
            send(
                {
                    "type": "publish",
                    "status": "live" if batch else "listening",
                    "mediaEnd": chunk["end"],
                    "lagSeconds": lag,
                    "cues": batch,
                }
            )
            print(
                json.dumps(
                    {
                        "index": chunk["index"],
                        "mediaEnd": chunk["end"],
                        "lagSeconds": lag,
                        "cues": len(batch),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        send(
            {
                "type": "publish",
                "status": "interrupted",
                "mediaEnd": a.duration_seconds,
                "lagSeconds": round(
                    max(0, time.monotonic() - mono - a.duration_seconds), 3
                ),
                "cues": [],
            }
        )
        r = send({"type": "finish", "mediaEnd": a.duration_seconds})["result"]
        r["mode"] = "precomputed ASR; 1x signed-delivery comparison"
        (a.out / "summary.json").write_text(
            json.dumps(r, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
        )
        print("SOAK_COMPLETE", json.dumps(r, ensure_ascii=False), flush=True)
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
