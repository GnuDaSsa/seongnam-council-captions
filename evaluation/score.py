"""Compute normalized character edit distance to official player transcript.

Usage: python score.py CHAPTER_DIRECTORY ASR.json
Only this selected excerpt is supported. The boundary is a sentence end near
600 s and approximate; minutes are edited prose, not a phonetic transcript.
"""
import json, re, sys, unicodedata
from pathlib import Path

p=Path(sys.argv[1]); a=(p/'chapter3.txt').read_text(encoding='utf8'); b=(p/'chapter4.txt').read_text(encoding='utf8')
anchor='더 이상의 뭉개기식 행정은 용납되지 않습니다.'
assert b.count(anchor)==1 and '(마이크 중단 이후 계속 발언한 부분\n추미애 도지사……' in a
b=b.split(anchor,1)[0]+anchor
ref=a+'\n'+b
ref=ref.replace('(마이크 중단 이후 계속 발언한 부분\n추미애 도지사……', '')
ref=re.sub(r'\([^)]*\)', '', ref, flags=re.S)
ref=re.sub(r'○(?:의장\s+강상태|추선미의원)\s*', '', ref)
def norm(s): return ''.join(c for c in unicodedata.normalize('NFKC', s).lower() if c.isalnum())
ref=norm(ref)
data=json.loads(Path(sys.argv[2]).read_text(encoding='utf8'))
hyp=norm(''.join(x['text'] for x in data['chunks']))
prev=list(range(len(hyp)+1))
for i,c in enumerate(ref,1):
    cur=[i]
    for j,d in enumerate(hyp,1): cur.append(min(cur[-1]+1,prev[j]+1,prev[j-1]+(c!=d)))
    prev=cur
print(json.dumps({'reference_chars':len(ref),'hypothesis_chars':len(hyp),'edit_distance':prev[-1], 'cer':prev[-1]/len(ref)},ensure_ascii=False))
