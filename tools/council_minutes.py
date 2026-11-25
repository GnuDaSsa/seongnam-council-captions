#!/usr/bin/env python3
"""Operator-side transcription and evidence-linked draft minutes generator."""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def intervals(duration, chunk_seconds):
    if not math.isfinite(duration) or duration <= 0 or not 1 <= chunk_seconds <= 600:
        raise ValueError("duration must be positive; chunk size must be 1–600 seconds")
    return [(float(s), min(float(s + chunk_seconds), duration))
            for s in range(0, math.ceil(duration), chunk_seconds)]


def probe(path):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                            check=True, capture_output=True, text=True)
    return float(result.stdout.strip())


def transcribe(client, path, duration, chunk_seconds, model, temp_dir, offset=0):
    segments = []
    for index, (start, end) in enumerate(intervals(duration, chunk_seconds), 1):
        chunk = Path(temp_dir) / f"chunk-{index:05d}.mp3"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", str(start),
                        "-i", str(path), "-t", str(end - start), "-vn", "-ac", "1",
                        "-ar", "16000", "-b:a", "32k", "-y", str(chunk)], check=True)
        if chunk.stat().st_size >= 24_000_000:
            raise ValueError("encoded chunk exceeds upload safety limit")
        with chunk.open("rb") as audio:
            response = client.audio.transcriptions.create(model=model, file=audio)
        text = response.text.strip()
        if text:
            segments.append({"id": f"cue-{index:05d}", "start": start + offset, "end": end + offset,
                             "speaker": "미확인", "text": text, "status": "검토 필요"})
    return segments


def validate_draft(raw, segments):
    data = json.loads(raw)
    if not isinstance(data, dict) or set(data) != {"items"} or not isinstance(data["items"], list):
        raise ValueError("invalid draft shape")
    valid_ids = {s["id"] for s in segments}
    for item in data["items"]:
        if (not isinstance(item, dict) or set(item) != {"kind", "text", "cueIds"}
                or item["kind"] not in ("논의", "요청", "결정")
                or not isinstance(item["text"], str) or not item["text"].strip()
                or not isinstance(item["cueIds"], list) or not item["cueIds"]
                or any(not isinstance(x, str) or x not in valid_ids for x in item["cueIds"])):
            raise ValueError("draft has invalid or missing evidence references")
    return {"notice": "자동 작성 초안: 원음과 원문을 대조해 검토해야 합니다.", "items": data["items"]}


def summarize(client, segments, model):
    instructions = ("다음 회의 전사만 근거로 한국어 회의록 초안을 작성하세요. "
                    "추측하지 말고 명시된 사실만 쓰세요. 의결·확정은 명시적 근거가 있을 때만 결정으로 분류하세요. "
                    "각 항목은 반드시 근거 cue ID를 하나 이상 인용하세요. "
                    'JSON 객체만 반환: {"items":[{"kind":"논의|요청|결정","text":"...","cueIds":["cue-00001"]}]}')
    response = client.responses.create(model=model, instructions=instructions, store=False,
                                       input=json.dumps(segments, ensure_ascii=False))
    return validate_draft(response.output_text, segments)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("audio", type=Path, nargs="?", help="local recording (not a URL)")
    p.add_argument("--from-meeting", type=Path, help="resume summary from previously saved meeting JSON")
    p.add_argument("--output", type=Path, required=True, help="meeting JSON output")
    p.add_argument("--draft-output", type=Path, required=True, help="separate draft JSON output")
    for flag in ("id", "title", "date", "body"):
        p.add_argument("--" + flag)
    p.add_argument("--source-url", default="")
    p.add_argument("--minutes-url", default="")
    p.add_argument("--agenda", action="append", default=[])
    p.add_argument("--chunk-seconds", type=int, default=60)
    p.add_argument("--offset-seconds", type=float, default=0, help="clip start offset in original source")
    p.add_argument("--coverage", choices=("full", "excerpt"), default="excerpt")
    p.add_argument("--transcription-model", default="gpt-transcribe")
    p.add_argument("--summary-model", default="gpt-6.1-terra")
    args = p.parse_args(argv)
    if bool(args.audio) == bool(args.from_meeting):
        p.error("provide exactly one local audio file or --from-meeting")
    input_path = args.audio or args.from_meeting
    if not input_path.is_file():
        p.error("input must be an existing local file")
    if args.output.resolve() == args.draft_output.resolve() or input_path.resolve() in (args.output.resolve(), args.draft_output.resolve()):
        p.error("input and outputs must be distinct")
    if args.output.exists() or args.draft_output.exists():
        p.error("output already exists; choose new output paths")
    for path in (args.output, args.draft_output):
        if not path.parent.is_dir():
            p.error(f"output parent does not exist: {path.parent}")
        try:
            with tempfile.TemporaryFile(dir=path.parent):
                pass
        except OSError:
            p.error(f"output parent is not writable: {path.parent}")
    if not math.isfinite(args.offset_seconds) or args.offset_seconds < 0:
        p.error("offset must be finite and nonnegative")
    if not 1 <= args.chunk_seconds <= 600:
        p.error("chunk size must be 1–600 seconds")
    if args.audio:
        if not all((args.id, args.title, args.date, args.body)):
            p.error("--id, --title, --date and --body are required for audio")
        if args.coverage == "full" and args.offset_seconds != 0:
            p.error("full coverage cannot have a nonzero offset")
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            p.error("ffmpeg and ffprobe must be on PATH")
        duration = probe(args.audio)
        intervals(duration, args.chunk_seconds)
    else:
        with args.from_meeting.open(encoding="utf-8") as f:
            meeting = json.load(f)
        if not isinstance(meeting, dict) or not isinstance(meeting.get("segments"), list) or not meeting["segments"]:
            p.error("meeting JSON must contain nonempty segments")
        if any(not isinstance(s, dict) or not isinstance(s.get("id"), str) or not isinstance(s.get("text"), str) for s in meeting["segments"]):
            p.error("meeting segments require id and text")
        meeting.pop("draft", None)
    if not os.environ.get("OPENAI_API_KEY"):
        p.error("OPENAI_API_KEY must be set in the process environment")
    from openai import OpenAI
    client = OpenAI()
    if args.audio:
        with tempfile.TemporaryDirectory(prefix="council-audio-") as tmp:
            segments = transcribe(client, args.audio, duration, args.chunk_seconds, args.transcription_model, tmp, args.offset_seconds)
        if not segments:
            raise ValueError("no transcript returned; no output written")
        scope = "전체 녹음" if args.coverage == "full" else "발췌 녹음"
        meeting = {"id": args.id, "title": args.title, "date": args.date, "body": args.body,
                   "sourceUrl": args.source_url, "minutesUrl": args.minutes_url,
                   "coverage": f"{scope} 자동 전사 초안 · 시간은 분할 구간 기준 · 원음 대조 필요",
                   "agenda": args.agenda, "segments": segments}
    else:
        segments = meeting["segments"]
    # Save the paid transcript before asking the model for a summary.
    with args.output.open("x", encoding="utf-8") as f:
        json.dump(meeting, f, ensure_ascii=False, indent=2)
        f.write("\n")
    draft = summarize(client, segments, args.summary_model)
    with args.draft_output.open("x", encoding="utf-8") as f:
        json.dump(draft, f, ensure_ascii=False, indent=2)
        f.write("\n")
    meeting["draft"] = draft
    with args.output.open("w", encoding="utf-8") as f:
        json.dump(meeting, f, ensure_ascii=False, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
