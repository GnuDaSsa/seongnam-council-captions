"""Generate a replay of signed-publisher inputs from real local audio without writing to a meeting."""
import argparse
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import sys
import time
import wave

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import shared_stt as stt


def timestamp(seconds):
    return dt.datetime.fromtimestamp(seconds,dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')


def file_hash(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source,'sha256').hexdigest()


def replay(args):
    import numpy as np
    config=json.loads(args.meeting.read_text(encoding='utf-8-sig'))
    if 'meetings' in config:
        found=[row for row in config['meetings'] if row['id']==args.id]
        if len(found)!=1:raise ValueError('--id must identify one meeting in the catalog')
        meeting=found[0]
    else:
        meeting=config
        if args.id and args.id!=meeting.get('id'):raise ValueError('meeting ID mismatch')
    if not isinstance(meeting.get('members'),list) or not all(meeting.get(key) for key in ('title','id','scheduledAt','endsAt')):
        raise ValueError('Give the meeting ID, title, dated schedule and roster (an empty list is valid)')
    start_date=dt.datetime.fromisoformat(meeting['scheduledAt'])
    end_date=dt.datetime.fromisoformat(meeting['endsAt'])
    if start_date.tzinfo is None or end_date.tzinfo is None:raise ValueError('Schedule requires explicit UTC offsets')
    origin=start_date.timestamp()
    if not math.isfinite(args.start) or args.start<0:raise ValueError('Media offset must be nonnegative')
    evidence=None
    if args.speaker_model:
        from live_acoustic import LiveAcoustic,load_extractor
        evidence=LiveAcoustic(meeting,load_extractor(args.speaker_model,args.speaker_profile),
                              profile=args.speaker_profile,podium_floor=args.podium_floor)
    stt.MODEL=args.whisper_model
    model=stt.load_model()
    hints='' if args.generic_prompt else stt.meeting_hints(meeting)
    prior=''; counter=0; snapshots=[]
    sha=file_hash(args.wav)
    if args.sha256 and sha!=args.sha256.lower():raise ValueError('WAV checksum differs from the given recording')
    with wave.open(str(args.wav),'rb') as audio:
        if (audio.getnchannels(),audio.getsampwidth(),audio.getframerate())!=(1,2,16000):
            raise ValueError('Input must be mono 16 kHz signed 16-bit PCM WAV')
        if origin+args.start+audio.getnframes()/16000>end_date.timestamp()+120:
            raise ValueError('The simulated capture falls outside this meeting schedule')
        for offset,pcm in stt.audio_chunks(lambda size:audio.readframes(size//2)):
            began=time.perf_counter()
            samples=np.frombuffer(pcm,dtype='<i2').astype(np.float32)/32768.0
            rms=float(np.sqrt(np.mean(samples*samples)))
            segments=stt.transcribe_live(model,samples,prior,hints) if rms>=.004 else []
            start=args.start+offset
            batch,counter,invalid=stt.cue_batch(segments,start,len(samples)/16000,origin,counter,
                                                acoustic=evidence,pcm=pcm)
            for cue in batch:
                if cue['rawText']==cue['text']:prior=(prior+' '+cue['rawText'])[-300:]
            snapshots.append({'clock':timestamp(origin+start+len(samples)/16000),'status':'live',
                 'newCues':batch,'invalidTime':invalid,'processingMs':round(1000*(time.perf_counter()-began),1)})
    if not snapshots:raise ValueError('The WAV contains no samples')
    snapshots[-1]['status']='ended'
    experiment={'sample':args.wav.stem,'meeting':meeting,'split':args.split,'snapshots':snapshots,
        'pcmSha256':sha,'mediaStart':args.start,'prompt':'generic' if args.generic_prompt else 'dated meeting roster',
        'clockBasis':'Simulated clock equals meeting scheduledAt + source media time',
        'policy':args.speaker_profile if evidence else None,'podiumFloor':args.podium_floor}
    tmp=args.out.with_suffix(args.out.suffix+'.partial')
    tmp.write_text(json.dumps(experiment,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    tmp.replace(args.out)
    print(f'{meeting["title"]}: {len(snapshots)} batches, {counter} cues. {args.out}')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wav',required=True,type=Path)
    parser.add_argument('--meeting',required=True,type=Path,help='A meeting JSON or an original catalog')
    parser.add_argument('--id',help='Required when reading a catalog')
    parser.add_argument('--start',type=float,default=0,help='Original player time at the start of the WAV, seconds')
    parser.add_argument('--sha256',help='Expected SHA-256 of the source WAV')
    parser.add_argument('--whisper-model',required=True,type=Path,help='Already installed local CTranslate2 Whisper model directory')
    parser.add_argument('--speaker-model',type=Path,help='Matching pinned optional ONNX file')
    parser.add_argument('--speaker-profile',choices=['same-session-1','same-session-2','same-session-cam-1'])
    parser.add_argument('--podium-floor',action='store_true')
    parser.add_argument('--generic-prompt',action='store_true',help='Omit optional roster hints from the ASR text prompt')
    parser.add_argument('--split',default='local replay')
    parser.add_argument('--out',required=True,type=Path)
    args=parser.parse_args()
    if bool(args.speaker_model)!=bool(args.speaker_profile):
        parser.error('Give both --speaker-model and --speaker-profile')
    if args.podium_floor and args.speaker_profile!='same-session-cam-1':parser.error('Podium requires the CAM++ profile')
    replay(args)


if __name__=='__main__':main()

