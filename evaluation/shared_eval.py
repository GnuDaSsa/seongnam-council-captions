"""Run production shared transcriber over contiguous 20-second source slices.

No capture/network gaps are simulated. Usage: python shared_eval.py WAV OUTPUT.
"""
import io, json, sys, time, wave
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from shared_stt import load_model, transcribe_audio, audio_chunks, quality_decision

with wave.open(sys.argv[1], 'rb') as f:
    assert (f.getframerate(),f.getnchannels(),f.getsampwidth()) == (16000,1,2)
    audio=np.frombuffer(f.readframes(f.getnframes()),dtype='<i2').astype(np.float32)/32768
assert len(audio)==9600000
before=time.perf_counter(); model=load_model(); init=time.perf_counter()-before
previous=''; chunks=[]; raw_chunks=[]; start=time.perf_counter()
i=0
pcm=(audio*32768).astype('<i2').tobytes()
for offset, raw in audio_chunks(io.BytesIO(pcm).read):
    assert offset == i/16000
    part=np.frombuffer(raw,dtype='<i2').astype(np.float32)/32768
    # Public agenda / chapter labels, not the transcript or ground truth.
    # Same producer-level silence gate; empty audio yields no captions or context.
    rms=float(np.sqrt(np.mean(part*part))) if len(part) else 0.0
    segs=transcribe_audio(model,part,previous,hints='추선미 의원, 윤혜선 의원, 도촌야탑역 신설') if rms>=0.004 else []
    decisions=[quality_decision(s) for s in segs]
    raw_text=' '.join(d[0] for d in decisions)
    text=' '.join(d[1] for d in decisions)
    for raw_text_part, visible_text_part, flags in decisions:
        if visible_text_part == raw_text_part:
            previous=(previous+' '+raw_text_part)[-300:]
    chunks.append({'start':i/16000,'end':(i+len(part))/16000,'text':text,
                   'segments':[{'start':s.start+i/16000,'end':s.end+i/16000,'raw':d[0],'visible':d[1],'flags':d[2]} for s,d in zip(segs,decisions)]})
    raw_chunks.append({'start':i/16000,'end':(i+len(part))/16000,'text':raw_text})
    print(i/16000,text,flush=True)
    i+=len(part)
assert i==len(audio)
Path(sys.argv[2]).write_text(json.dumps({'init_seconds':init,'wall_seconds':time.perf_counter()-start,'chunks':chunks,'raw_chunks':raw_chunks},ensure_ascii=False,indent=2),encoding='utf8')
