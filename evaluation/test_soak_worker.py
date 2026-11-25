"""Short offline checks for the local signed-soak protocol."""

import datetime as dt
import json
import subprocess
import tempfile
import time
from pathlib import Path


def main():
    with tempfile.TemporaryDirectory(prefix="council-soak-test-") as directory:
        worker = Path(__file__).with_name("realtime_soak_worker.mjs")
        process = subprocess.Popen(
            ["node", str(worker), directory],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf8",
            bufsize=1,
        )

        def send(message):
            process.stdin.write(json.dumps(message) + "\n")
            process.stdin.flush()
            line = process.stdout.readline()
            if not line:
                raise RuntimeError("test Worker stopped")
            return json.loads(line)

        try:
            now = time.time()
            observed = (
                dt.datetime.fromtimestamp(now, dt.timezone.utc)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z")
            )
            cue = {
                "id": "1",
                "start": 0,
                "end": 1,
                "rawText": "회의를 시작합니다.",
                "text": "회의를 시작합니다.",
                "flags": [],
                "observedAt": observed,
            }
            assert not send({"type": "publish", "cues": [], "status": "live"})["ok"]
            assert send({"type": "init", "startWall": round(now * 1000)})["ok"]
            assert not send({"type": "publish", "cues": [cue, cue], "status": "live"})[
                "ok"
            ]
            assert send(
                {
                    "type": "publish",
                    "cues": [cue],
                    "status": "live",
                    "mediaEnd": 1,
                    "lagSeconds": 0,
                }
            )["ok"]
            assert not send({"type": "publish", "cues": [cue], "status": "live"})["ok"]
            assert send(
                {
                    "type": "publish",
                    "cues": [],
                    "status": "interrupted",
                    "mediaEnd": 1,
                    "lagSeconds": 0,
                }
            )["ok"]
            result = send({"type": "finish", "mediaEnd": 1})
            assert result["ok"] and result["result"]["published"] == 1
            assert result["result"]["archiveCues"] == 1
            assert result["result"]["expiryBoundary"] == {
                "justBefore": 200,
                "atExpiry": 404,
            }
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        assert process.returncode == 0
    print(
        "PASS invalid, duplicate before and after write, signed archive and child shutdown"
    )


if __name__ == "__main__":
    main()
