"""Operator-only public HLS captions. No credentials or generated output belong in this repo."""
import argparse
import base64
import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

RATE = 16000
CHUNK = RATE * 2 * 12

def utc():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')

def playlist(url):
    """Follow a master playlist and return media identity; reject finite/archived VOD."""
    for _ in range(4):
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=8) as r:
            body = r.read(1024 * 1024).decode('utf-8-sig')
        lines = [line.strip() for line in body.splitlines() if line.strip()]
        if not lines or lines[0] != '#EXTM3U' or '#EXT-X-ENDLIST' in lines:
            raise ValueError('not an active HLS media playlist')
        variant = next((lines[i + 1] for i, line in enumerate(lines[:-1]) if line.startswith('#EXT-X-STREAM-INF:')), None)
        if variant:
            url = urllib.parse.urljoin(url, variant)
            continue
        media = [line for line in lines if not line.startswith('#')]
        if not media or not any(line.startswith('#EXTINF:') for line in lines):
            raise ValueError('empty HLS media playlist')
        seq = next((line for line in lines if line.startswith('#EXT-X-MEDIA-SEQUENCE:')), '')
        return url, (seq, media[-1])
    raise ValueError('too many HLS playlist levels')

def publish(repo, branch, path, data):
    endpoint = f'repos/{repo}/contents/{path}'
    get = subprocess.run(['gh', 'api', f'{endpoint}?ref={branch}'], capture_output=True, timeout=20)
    sha = None
    if get.returncode == 0:
        sha = json.loads(get.stdout)['sha']
    elif b'404' not in get.stderr:
        raise RuntimeError('GitHub read failed: ' + get.stderr.decode('utf-8', 'replace')[:300])
    payload = {'message': 'Update public live captions', 'branch': branch, 'content': base64.b64encode(data).decode('ascii')}
    if sha:
        payload['sha'] = sha
    result = subprocess.run(['gh', 'api', '--method', 'PUT', endpoint, '--input', '-'], input=json.dumps(payload).encode(), capture_output=True, timeout=25)
    if result.returncode:
        raise RuntimeError('GitHub update failed: ' + result.stderr.decode('utf-8', 'replace')[:300])

def upload(url, data):
    token = os.environ.get('SN_LIVE_WRITE_TOKEN')
    if not token:
        raise RuntimeError('SN_LIVE_WRITE_TOKEN is missing')
    request = urllib.request.Request(url, data=data, method='PUT', headers={
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=25) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError('feed upload failed: HTTP ' + str(response.status))

def parse_utc(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamp must include a UTC offset')
    return parsed.timestamp()

def read_pcm(proc, out, received):
    try:
        while True:
            block = proc.stdout.read(CHUNK)
            if not block:
                break
            received[0] = time.time()
            try:
                out.put_nowait((received[0], block))
            except queue.Full:
                try: out.get_nowait()
                except queue.Empty: pass
                out.put_nowait((time.time(), block))
    finally:
        proc.stdout.close()

def transcribe_worker(model, audio, results, stop):
    import numpy as np
    while not stop.is_set():
        try: captured, block = audio.get(timeout=1)
        except queue.Empty: continue
        if time.time() - captured > 45: continue
        samples = np.frombuffer(block, dtype='<i2').astype(np.float32) / 32768.0
        if len(samples) < RATE or float(np.sqrt(np.mean(samples * samples))) < 0.005: continue
        try:
            segments, _ = model.transcribe(samples, language='ko', beam_size=1, vad_filter=True, condition_on_previous_text=False, no_speech_threshold=0.6)
            results.put((captured, [(s.start, s.end, s.text.strip()) for s in segments if s.text.strip() and s.no_speech_prob < 0.6]))
        except Exception as exc:
            print('transcription error:', exc, file=sys.stderr, flush=True)

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--hls', required=True, help='official public HLS playlist URL')
    p.add_argument('--source-url', required=True, help='public meeting page URL')
    p.add_argument('--output', required=True, help='private local JSON path, outside source checkout')
    p.add_argument('--model', required=True)
    p.add_argument('--python-libs', required=True)
    p.add_argument('--ffmpeg', default='ffmpeg')
    p.add_argument('--repo', help='GitHub OWNER/REPO')
    p.add_argument('--branch', help='dedicated live-data branch')
    p.add_argument('--feed-upload', help='Sites HTTPS feed endpoint (token from SN_LIVE_WRITE_TOKEN)')
    p.add_argument('--not-before', help='start after ISO 8601 timestamp including UTC offset')
    p.add_argument('--deadline', default='2026-11-25T14:59:00Z', help='stop and publish ended at ISO 8601 timestamp including UTC offset')
    p.add_argument('--path', default='live/economy.json')
    p.add_argument('--meeting-id', default='20261125-economy')
    p.add_argument('--max-segments', type=int, default=80)
    p.add_argument('--interval', type=int, default=20)
    args = p.parse_args()
    if args.interval < 15 or args.max_segments < 1 or args.max_segments > 500:
        p.error('interval must be at least 15 seconds; max-segments must be 1–500')
    if not args.feed_upload and not (args.repo and args.branch):
        p.error('provide --feed-upload or both --repo and --branch')
    if args.feed_upload and not args.feed_upload.startswith('https://'):
        p.error('--feed-upload must use HTTPS')
    try:
        deadline = parse_utc(args.deadline)
        not_before = parse_utc(args.not_before) if args.not_before else 0
    except ValueError as exc:
        p.error(str(exc))
    if not_before >= deadline:
        p.error('--not-before must be earlier than --deadline')
    if args.feed_upload and not os.environ.get('SN_LIVE_WRITE_TOKEN'):
        p.error('SN_LIVE_WRITE_TOKEN is required with --feed-upload')
    while time.time() < not_before:
        time.sleep(min(5, not_before - time.time()))
    sys.path.insert(0, args.python_libs)
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device='cpu', compute_type='int8', local_files_only=True)
    audio, results, stop = queue.Queue(maxsize=3), queue.Queue(), threading.Event()
    threading.Thread(target=transcribe_worker, args=(model, audio, results, stop), daemon=True).start()
    received = [0.0]
    segments = deque(maxlen=args.max_segments)
    proc = None
    identity = None
    last_change = 0
    last_probe = 0
    last_publish = 0
    last_audio = 0
    live_seen = False
    epoch = time.time()
    status = 'waiting'
    def send(state):
        data = json.dumps({'schemaVersion': 1, 'meetingId': args.meeting_id, 'status': state, 'updatedAt': utc(), 'segments': list(segments), 'sourceUrl': args.source_url}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_bytes(data)
        if args.feed_upload:
            upload(args.feed_upload, data)
        else:
            publish(args.repo, args.branch, args.path, data)
    try:
        while True:
            now = time.time()
            if now >= deadline:
                break
            if now - last_probe >= 10:
                last_probe = now
                try:
                    media_url, current = playlist(args.hls)
                    if identity is not None and current != identity:
                        last_change = now
                    identity = current
                except Exception as exc:
                    print('playlist:', exc, file=sys.stderr, flush=True)
                    last_change = 0
                active = last_change and now - last_change < 45
                if not active and proc:
                    proc.terminate(); proc.wait(timeout=5); proc = None
                if active and (proc is None or proc.poll() is not None):
                    proc = subprocess.Popen([args.ffmpeg, '-nostdin', '-loglevel', 'error', '-live_start_index', '-1', '-i', media_url, '-vn', '-ac', '1', '-ar', str(RATE), '-f', 's16le', 'pipe:1'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                    threading.Thread(target=read_pcm, args=(proc, audio, received), daemon=True).start()
            while True:
                try: captured, rows = results.get_nowait()
                except queue.Empty: break
                last_audio = max(last_audio, captured)
                for start, end, text in rows:
                    segments.append({'id': uuid.uuid4().hex, 'text': text, 'start': round(max(0, captured - epoch - 12 + start), 1), 'end': round(max(0, captured - epoch - 12 + end), 1), 'at': datetime.fromtimestamp(captured - 12 + start, timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')})
            # The reader records PCM independently of speech; silence is still live audio.
            # Queue timestamps reflect full audio blocks even if no speech was recognized.
            last_audio = max(last_audio, received[0])
            if last_audio and now - last_audio < 35 and last_change and now - last_change < 45:
                status = 'live'; live_seen = True
            else:
                status = 'offline' if live_seen else 'waiting'
            if now - last_publish >= args.interval:
                try: send(status)
                except Exception as exc: print('publication error:', exc, file=sys.stderr, flush=True)
                last_publish = now
            time.sleep(1)
    except KeyboardInterrupt:
        print('Stopping live captions.', file=sys.stderr)
    finally:
        stop.set()
        if proc and proc.poll() is None:
            proc.terminate()
            try: proc.wait(timeout=5)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()
        for attempt in range(3):
            try:
                send('ended')
                break
            except Exception as exc:
                print('ended publication error:', exc, file=sys.stderr, flush=True)
                if attempt < 2: time.sleep(2)

if __name__ == '__main__':
    main()
