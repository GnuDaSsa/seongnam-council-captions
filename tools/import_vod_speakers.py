#!/usr/bin/env python3
"""Extract named turns from saved Seongnam Council official record pages."""

import argparse
from datetime import date
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlsplit

from bs4 import BeautifulSoup


def clean(text):
    return " ".join(text.split())


def validate_source_url(url):
    parsed = urlsplit(url)
    keys = parse_qs(parsed.query).get("key", [])
    if (parsed.scheme != "https" or parsed.netloc not in {"www.sncouncil.go.kr", "sncouncil.go.kr"}
            or parsed.path != "/record/recordView.do" or len(keys) != 1
            or not re.fullmatch(r"[0-9a-f]+", keys[0])):
        raise ValueError("Use a canonical Seongnam Council recordView URL")


def speaker_identity(heading):
    label = clean(heading.get_text(" ", strip=True)).removeprefix("○").strip()
    linked = heading.find("a")
    if linked:
        name = clean(linked.get_text(" ", strip=True))
        role = clean(label.replace(name, "", 1))
    else:
        role, _, name = label.rpartition(" ")
    if not role or not re.fullmatch(r"[가-힣]{2,5}", name):
        raise ValueError(f"unrecognized named heading: {label!r}")
    return name, role


def speech_text(nodes):
    lines = [""]
    for node in nodes:
        if node.name in {"br", "hr", "div", "strong"}:
            # The original includes agenda headings, files and clock notes within <spk>.
            lines.append("")
        elif node.name == "a" and str(node.get("href", "")).startswith(("#", "/record/")):
            continue
        else:
            lines[-1] += str(node) if node.name is None else node.get_text()

    speech = []
    for line in map(clean, lines):
        if not line or re.fullmatch(r"\(.*\)", line):
            continue
        speech.append(re.sub(r"^\([^)]*을 향해\)\s*", "", line))
    return " ".join(speech)


def named_block_turns(block):
    headings = [tag for tag in block.find_all("strong") if tag.get_text(strip=True).startswith("○")]
    if not headings or any(tag.parent is not block for tag in headings):
        raise ValueError("expected a speaker heading in each official speaker block")

    heading = headings[0]
    nodes = []
    pending = iter(heading.next_siblings)
    for node in pending:
        if node.name == "strong" and node.get_text(strip=True).startswith("○"):
            # The surrounding turn may include '(○NAME 의석에서 - SPOKEN.)'.
            following = clean(str(next(pending, "")))
            remark = re.fullmatch(r"[가-힣]+에서\s*[-–]\s*(.+?)\)", following)
            if not nodes or str(nodes.pop()).strip() != "(" or not remark:
                raise ValueError("unrecognized format for an inline named remark")
            text = speech_text(nodes)
            if text:
                yield (*speaker_identity(heading), text)
            yield (*speaker_identity(node), remark[1])
            nodes = []
        else:
            nodes.append(node)
    text = speech_text(nodes)
    if text:
        yield (*speaker_identity(heading), text)


def read_record(path, url, session, body, day, part):
    validate_source_url(url)
    soup = BeautifulSoup(path.read_text(encoding="utf-8-sig"), "html.parser")
    canvas = soup.select_one("#canvas")
    if not canvas or not soup.title:
        raise ValueError(f"{path}: record body is missing")
    title = clean(soup.title.get_text())
    expected_title = f"제{session}회 {body} {part}({day:%Y.%m.%d.})"
    caption = canvas.select_one(".caption1")
    header = canvas.find("h1")
    expected_caption = "개회식" if part == "개회식" else f"제{part[1:-1]}호"
    expected_date = f"일시{day.year}년{day.month}월{day.day}일"
    if (title != expected_title or not header or clean(header.get_text()) != f"{body}회의록"
            or not caption or re.sub(r"\s+", "", caption.get_text()) != expected_caption
            or expected_date not in re.sub(r"\s+", "", canvas.get_text()[:250])):
        raise ValueError(f"{path}: verified meeting identity differs from original header {title!r}")
    turns = []
    for block in canvas.find_all("spk"):
        for name, role, text in named_block_turns(block):
            turns.append({"name": name, "role": role, "text": text})
    if not turns:
        raise ValueError(f"{path}: no named turns found")
    return turns


def timed_cast_turns(path, meeting_id, official_turns):
    cast = json.loads(path.read_text(encoding="utf-8-sig"))
    expected_url = f"https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no={meeting_id}&position=0"
    if cast["meetingId"] != meeting_id or cast["sourceUrl"] != expected_url:
        raise ValueError("cast transcript does not match the verified VOD ID")

    def spoken_key(text):
        return re.sub(r"[^가-힣a-z0-9]", "", text.lower())

    official_by_speaker = {}
    for turn in official_turns:
        identity = (turn["name"], turn["role"])
        official_by_speaker.setdefault(identity, []).append(spoken_key(turn["text"]))

    turns = []
    for turn in cast["turns"]:
        name, role, start, end = (turn[field] for field in ("name", "role", "start", "end"))
        official = official_by_speaker.get((name, role))
        if not official or type(start) is not int or type(end) is not int or not 0 <= start < end:
            raise ValueError(f"unverified cast speaker or chapter interval: {name} / {role}")
        if turns and start < turns[-1]["start"]:
            raise ValueError("cast chapter intervals are out of order")

        utterances = []
        for raw_line in map(clean, turn["text"].splitlines()):
            if not raw_line or re.fullmatch(r"\(.*\)", raw_line):
                continue
            line = re.sub(r"^\([^)]*\)\s*", "", raw_line)
            key = spoken_key(line)
            if key and any(key in text for text in official):
                utterances.append(line)
            elif not re.match(r"^(?:[0-9]+\.|o )", raw_line):
                raise ValueError(f"cast text differs from the corresponding official speaker turn: {name} / {role}")
        if utterances:
            turns.append({"name": name, "role": role, "text": " ".join(utterances), "start": start, "end": end})
    if not turns:
        raise ValueError("no verified timed cast turns")
    return expected_url, turns


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--meeting-id", required=True)
    parser.add_argument("--session", type=int, required=True)
    parser.add_argument("--body", required=True)
    parser.add_argument("--date", type=date.fromisoformat, required=True)
    parser.add_argument("--record", nargs=3, metavar=("PART", "URL", "HTML"), action="append", required=True,
                        help="ordered sections, for example 제1차 URL saved.html")
    parser.add_argument("--cast-turns", type=Path,
                        help="use saved VOD chapter intervals for dialogue verified against the official record")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]+", args.meeting_id):
        parser.error("--meeting-id must be the numeric VOD ID")

    turns = []
    urls = []
    for part, url, path in args.record:
        if not re.fullmatch(r"(?:제[1-9][0-9]*차|개회식)", part):
            parser.error(f"invalid record part: {part}")
        section = read_record(Path(path), url, args.session, args.body, args.date, part)
        urls.append(url)
        for turn in section:
            if len(args.record) > 1:
                turn["sourceUrl"] = url
            turns.append(turn)

    source_url = urls[-1]
    if args.cast_turns:
        source_url, turns = timed_cast_turns(args.cast_turns, args.meeting_id, turns)
    result = {"meetingId": args.meeting_id, "sourceUrl": source_url,
              "turns": [{"id": f"{args.meeting_id}-turn-{i:04d}", **turn} for i, turn in enumerate(turns, 1)]}
    if args.cast_turns:
        result["sourceUrls"] = [source_url, *urls]
    elif len(urls) > 1:
        result["sourceUrls"] = urls
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"{args.meeting_id}: {len(turns)} named turns")


if __name__ == "__main__":
    main()
