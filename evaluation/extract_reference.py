"""Extract official chapter transcripts from a downloaded public player HTML."""
import html, re, sys
from pathlib import Path

page = Path(sys.argv[1]).read_text(encoding='utf-8')
for n in (3, 4):
    found = re.search(r'id="contents_view_' + str(n) + r'">(.*?)</span>', page, re.S)
    if not found:
        raise ValueError(f'Chapter {n} missing')
    text = html.unescape(re.sub(r'<br\s*/?>', '\n', found.group(1)))
    Path(sys.argv[2], f'chapter{n}.txt').write_text(text, encoding='utf-8')
