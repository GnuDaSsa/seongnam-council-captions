"""Find *candidate* whole-sentence omissions via normalized global alignment.

Candidates have >= 15 normalized characters and < 20% aligned characters;
official editorial prose is not necessarily a complete spoken utterance.
Manually review candidates against audio before reporting confirmed omissions.
"""
import difflib, json, re, sys, unicodedata
from pathlib import Path
p=Path(sys.argv[1]); a=(p/'chapter3.txt').read_text(encoding='utf8'); b=(p/'chapter4.txt').read_text(encoding='utf8')
anchor='더 이상의 뭉개기식 행정은 용납되지 않습니다.'
assert b.count(anchor)==1 and '(마이크 중단 이후 계속 발언한 부분\n추미애 도지사……' in a
b=b.split(anchor,1)[0]+anchor
ref=(a+'\n'+b).replace('(마이크 중단 이후 계속 발언한 부분\n추미애 도지사……', '')
ref=re.sub(r'\([^)]*\)', '', ref, flags=re.S)
ref=re.sub(r'○(?:의장\s+강상태|추선미의원)\s*', '', ref)
norm=lambda s: ''.join(c for c in unicodedata.normalize('NFKC',s).lower() if c.isalnum())
sentences=[(s.strip(),norm(s)) for s in re.split(r'(?<=[!?。？！])\s*|(?<!\d)\.(?!\d)\s*|\n+',ref) if norm(s)]
full=''.join(n for _,n in sentences)
data=json.loads(Path(sys.argv[2]).read_text(encoding='utf8')); hyp=norm(''.join(x['text'] for x in data['chunks']))
mask=bytearray(len(full))
for m in difflib.SequenceMatcher(None,full,hyp,autojunk=False).get_matching_blocks(): mask[m.a:m.a+m.size]=b'\1'*m.size
offset=0; candidates=[]
for text,n in sentences:
    coverage=sum(mask[offset:offset+len(n)])/len(n); offset+=len(n)
    if len(n)>=15 and coverage<0.2: candidates.append({'reference':text,'aligned_fraction':round(coverage,3)})
print(json.dumps({'definition':'reference sentence >=15 chars, <20% normalized chars in SequenceMatcher matching blocks; candidates require audio review','count':len(candidates),'candidates':candidates},ensure_ascii=False,indent=2))
