"""Import published player transcripts. Usage: python import_council.py 5411 -o meeting.json

Downloads the public player and its public timeline. Text is the council's published
transcript; each speaker within a chapter shares the chapter interval, not an
invented word-level timestamp. Review publishing rights before redistributing it.
"""
import argparse
import html
import json
import os
import re
from html.parser import HTMLParser
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE = "https://cast.sncouncil.go.kr/vod/"


class PlayerParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.fields = {}
        self.positions = []
        self.active = None
        self.depth = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "li" and "goto_chapter_btn" in attrs.get("class", ""):
            match = re.search(r"position:'(\d+)'", attrs["class"])
            if match:
                self.positions.append(int(match.group(1)))
        name = attrs.get("id", "")
        if tag == "span" and re.fullmatch(r"contents_(?:title|view)_\d+", name):
            self.active, self.depth = name, 1
            self.fields[name] = []
        elif self.active:
            if tag == "br":
                self.fields[self.active].append("\n")
            elif tag not in ("img", "input", "hr"):
                self.depth += 1

    def handle_startendtag(self, tag, attrs):
        if self.active and tag == "br":
            self.fields[self.active].append("\n")

    def handle_endtag(self, tag):
        if self.active and tag not in ("br", "img", "input", "hr"):
            self.depth -= 1
            if not self.depth:
                self.active = None

    def handle_data(self, data):
        if self.active:
            self.fields[self.active].append(data)


def download(url, data=None):
    req = Request(url, data=data, headers={"User-Agent": "CouncilPublicTranscriptImporter/1.0"})
    with urlopen(req, timeout=25) as response:
        return response.read().decode("utf-8", errors="replace")


def build(vod):
    url = BASE + "vod_view.jsp?" + urlencode({"pk_vod_no": vod})
    parser = PlayerParser()
    page = download(url)
    parser.feed(page)
    headings = re.findall(r"<h3[^>]*>(.*?)</h3>", page, flags=re.I | re.S)
    headings = [html.unescape(re.sub(r"<[^>]*>", "", h)).strip() for h in headings]
    meeting_heading = next((h for h in headings if re.search(r"\d{4}\.\s*\d{1,2}\.\s*\d{1,2}", h) and "[" in h), "")
    session_heading = next((h for h in headings if re.search(r"제\s*\d+회", h)), "")
    match = re.search(r"(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})", meeting_heading)
    date = f"{int(match[1]):04d}-{int(match[2]):02d}-{int(match[3]):02d}" if match else ""
    timeline = json.loads(download(BASE + "get_timeline_list_json.jsp", urlencode({"vod_no": vod}).encode()))
    starts, ends = timeline.get("start_times", []), timeline.get("end_times", [])
    views = sorted((int(x.rsplit("_", 1)[1]) for x in parser.fields if x.startswith("contents_view_")))
    if not views or views != list(range(len(views))) or len(starts) != len(views) or len(ends) != len(views) or (parser.positions and parser.positions != starts):
        raise ValueError("Published transcript and timeline do not align; no guessed timing was generated")
    segments = []
    for idx in views:
        title = "".join(parser.fields.get(f"contents_title_{idx}", [])).strip().lstrip("○").strip()
        value = "".join(parser.fields[f"contents_view_{idx}"]).strip()
        # Embedded speaker turns are marked by the official ○ prefix at a line start.
        parts = re.split(r"(?m)^○([^\n]+?)\s{2,}", value)
        turns = [(title, parts[0].strip())]
        turns.extend((parts[i].strip(), parts[i + 1].strip()) for i in range(1, len(parts), 2))
        for speaker, text in turns:
            if text:
                segments.append({"id": f"{vod}-{idx}-{len(segments)+1}", "start": starts[idx], "end": ends[idx],
                                 "speaker": speaker or "발언자 미확인", "text": text, "status": "공개 회의록 원문 · 구간 단위 시간",
                                 "sourceUrl": url + "&position=" + str(starts[idx]), "timingPrecision": "chapter"})
    title = " ".join(part for part in (session_heading.split("(")[0].strip(), meeting_heading.split("[")[0].strip()) if part)
    return {"id": str(vod), "title": title or "공개 영상 " + str(vod), "date": date, "body": "성남시의회",
            "sourceUrl": url, "minutesUrl": url, "coverage": "공식 공개 회의록 원문; 시간은 발언별이 아닌 원본 장별 경계",
            "agenda": [], "segments": segments}


def main():
    arg = argparse.ArgumentParser(description=__doc__)
    arg.add_argument("vod", help="public numeric video ID")
    arg.add_argument("-o", "--output", required=True, help="output JSON path")
    opt = arg.parse_args()
    if not opt.vod.isdigit():
        arg.error("vod must be numeric")
    if os.path.exists(opt.output):
        arg.exit(1, "Import failed: output already exists\n")
    try:
        meeting = build(opt.vod)
        with open(opt.output, "x", encoding="utf-8") as f:
            json.dump(meeting, f, ensure_ascii=False, indent=2)
            f.write("\n")
    except (ValueError, OSError) as exc:
        arg.exit(1, f"Import failed: {exc}\n")
    print(f"Imported {len(meeting['segments'])} speaker turns to {opt.output}")


if __name__ == "__main__":
    main()
