"""Bounded public council audio transcription and signed caption publisher."""
import argparse
import base64
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import queue
import threading
import subprocess
import time
import urllib.request
import urllib.error
from urllib.parse import urlencode, parse_qs
from urllib.parse import urlparse

MANIFEST = Path(__file__).resolve().parents[1] / 'dist' / 'data' / 'live-meetings.json'
HOME = Path(os.environ['LOCALAPPDATA']) / 'SeongnamCouncilDesk'
MODEL = HOME / 'models' / 'faster-whisper-small'
KEY = HOME / 'signing.pem'
PROMPT = '성남시의회 회의 발언입니다. 의장, 의원, 위원장, 성남시, 예산, 조례, 집행부.'


def load_model():
    from faster_whisper import WhisperModel
    return WhisperModel(str(MODEL), device='cpu', compute_type='int8', cpu_threads=2, num_workers=1, local_files_only=True)


def transcribe_audio(model, audio, previous_text='', hints='', *, beam_size=2):
    duration = len(audio) / 16000 if not isinstance(audio, (str, Path)) else 20
    segments, _ = model.transcribe(audio, language='ko', beam_size=beam_size, temperature=0.0,
        max_new_tokens=max(32, min(160, int(duration * 8))), vad_filter=True,
        vad_parameters={'min_silence_duration_ms': 500, 'speech_pad_ms': 300},
        condition_on_previous_text=True, initial_prompt=(PROMPT + ' ' + hints[:500] + ' ' + previous_text[-300:]))
    return list(segments)


def cue_flags(text):
    flags = []
    if re.search(r'\d|[일이삼사오육칠팔구십백천만억조]+\s*(?:원|명|개|년|월|일|퍼센트|%)', text):
        flags.append('number')
    if re.search(r'[가-힣]{2,4}\s*(?:의원|위원장|시장|국장|과장)', text):
        flags.append('name')
    if re.search(r'출석|불출석|참석|재석|의결|표결|찬성|반대|기권|가결|부결', text):
        flags.append('proceeding')
    return flags


def quality_decision(segment):
    raw = segment.text.strip()
    compact = re.sub(r'[\s\W_]+', '', raw)
    flags = cue_flags(raw)
    if len(compact) >= 12 and re.search(r'(.{2,20}?)\1{3,}', compact):
        flags.append('repetition')
    weak = getattr(segment, 'avg_logprob', 0) < -1.0
    silent = getattr(segment, 'no_speech_prob', 0) > 0.6
    compressed = getattr(segment, 'compression_ratio', 0) > 2.4
    if weak or silent:
        flags.append('low_confidence')
    severe = (weak and silent) or (compressed and (weak or silent))
    if severe:
        flags.append('severe_uncertainty')
    text = '[음성 재확인]' if 'repetition' in flags or severe else raw
    return raw, text, flags


def transcribe_live(model, audio, previous_text='', hints=''):
    """Retry one suspect chunk from its audio before exposing a review marker."""
    def suspect(segments):
        return any(
            {'repetition', 'severe_uncertainty'}.intersection(quality_decision(seg)[2])
            for seg in segments
        )

    first = transcribe_audio(model, audio, previous_text, hints)
    if not suspect(first):
        return first
    second = transcribe_audio(model, audio, previous_text, hints, beam_size=5)
    usable = [seg for seg in second if seg.text.strip()]
    if not usable or suspect(usable):
        return first
    # A short alternative can omit a different, otherwise usable utterance.
    for segment in first:
        if segment.text.strip() and not suspect([segment]) and segment.end > segment.start:
            if not any(other.end > segment.start and other.start < segment.end for other in usable):
                return first
    return second


def cue_batch(segments, chunk_start, chunk_duration, origin, first_id):
    """Build publishable cues; retain unplaceable recognition text for chunk review."""
    if not math.isfinite(chunk_start) or not math.isfinite(chunk_duration) or \
            not math.isfinite(origin) or chunk_duration <= 0 or chunk_start < 0 or \
            chunk_start + chunk_duration > 86400:
        raise ValueError('invalid source audio chunk interval')
    rounded_chunk_start = round(chunk_start, 3)
    chunk_end = round(chunk_start + chunk_duration, 3)
    if chunk_end <= rounded_chunk_start:
        raise ValueError('source audio chunk interval is below timestamp precision')

    ordered = []
    invalid = []
    invalid_reasons = {}
    for index, segment in enumerate(segments):
        raw, text, flags = quality_decision(segment)
        if not raw:
            continue
        reason = None
        absolute_start = None
        try:
            start, end = float(segment.start), float(segment.end)
            # The decoder can place the final token just past the recorded PCM.
            if 0 <= start < chunk_duration < end <= chunk_duration + 1.0:
                end = chunk_duration
            absolute_start, absolute_end = round(chunk_start + start, 3), round(chunk_start + end, 3)
            if not math.isfinite(start) or not math.isfinite(end):
                reason = 'non_finite_time'
            elif start < 0 or end > chunk_duration or absolute_end > 86400:
                reason = 'outside_source_chunk'
            elif start >= end or absolute_start < rounded_chunk_start or absolute_end <= absolute_start:
                reason = 'non_positive_interval'
            elif len(raw) > 2000 or len(text) > 2000:
                reason = 'text_too_long'
        except (AttributeError, TypeError, ValueError, OverflowError):
            reason = 'invalid_time_value'
        if reason is None:
            ordered.append((absolute_start, index, absolute_end, raw, text, flags))
        else:
            invalid.append((raw, flags, absolute_start, reason))
            invalid_reasons[reason] = invalid_reasons.get(reason, 0) + 1

    ordered.sort(key=lambda item: (item[0], item[1]))
    cues = []
    counter = first_id
    for start, _, end, raw, text, flags in ordered:
        counter += 1
        cues.append({'id': str(counter), 'start': start, 'end': end, 'rawText': raw,
                     'observedAt': dt.datetime.fromtimestamp(origin + start, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                     'text': text, 'flags': flags})

    # Do not discard text whose timestamps cannot be trusted. Chunk-level timing
    # keeps each item inside the source audio window without inventing a segment time.
    if invalid:
        pieces = []
        accepted_turns = {(entry[0], entry[3]) for entry in ordered}
        for raw, flags, start, reason in invalid:
            if reason == 'outside_source_chunk' and (start, raw) in accepted_turns:
                continue
            while raw:
                part, raw = raw[:1800], raw[1800:]
                pieces.append((part, flags))
        groups = []
        audio_flags = {'severe_uncertainty', 'repetition'}
        for part, source_flags in pieces:
            if groups and set(groups[-1][1]).intersection(audio_flags) == set(source_flags).intersection(audio_flags) and \
                    len(groups[-1][0]) + 1 + len(part) <= 2000 and \
                    len(set(groups[-1][1]).union(source_flags, {'segment_review'})) <= 12:
                groups[-1][0] += '\n' + part
                groups[-1][1].extend(source_flags)
            else:
                groups.append([part, list(source_flags)])
        for raw, source_flags in groups:
            counter += 1
            flags = ['segment_review'] + list(dict.fromkeys(source_flags))[:11]
            cues.append({'id': str(counter), 'start': rounded_chunk_start, 'end': chunk_end,
                         'rawText': raw or '[original text unavailable]',
                         'observedAt': dt.datetime.fromtimestamp(origin + chunk_start, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                         'text': '[음성 재확인]' if {'repetition', 'severe_uncertainty'}.intersection(flags) else raw,
                         'flags': flags})
        cues.sort(key=lambda cue: cue['start'])
    return cues, counter, invalid_reasons


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def signed_put(url, payload, key_path=KEY):
    from cryptography.hazmat.primitives import serialization
    u = urlparse(url)
    if u.scheme != 'https' or not u.netloc or u.username or u.password or u.path != '/api/live/captions' or set(parse_qs(u.query)) != {'meetingId'} or u.fragment:
        raise ValueError('caption endpoint must be an HTTPS /api/live/captions URL')
    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    key = serialization.load_pem_private_key(Path(key_path).read_bytes(), password=None)
    signature = base64.urlsafe_b64encode(key.sign(body)).decode('ascii').rstrip('=')
    req = urllib.request.Request(url, body, {'Content-Type': 'application/json', 'X-Council-Signature': signature,
                                             'User-Agent': 'SeongnamCouncilCaptionPublisher/1.0'}, method='PUT')
    with urllib.request.urlopen(req, timeout=15) as response:
        response.read(4096)


def session_origin(meeting_id):
    """Persist a fixed wall-clock origin so cue positions survive process restarts."""
    HOME.mkdir(parents=True, exist_ok=True)
    path = HOME / ('session-' + meeting_id + '.json')
    if path.exists():
        data = json.loads(path.read_text(encoding='utf-8'))
        if data.get('meetingId') != meeting_id:
            raise ValueError('unexpected session')
        return float(data['origin'])
    origin = time.time()
    with path.open('x', encoding='utf-8') as f:
        json.dump({'meetingId': meeting_id, 'origin': origin}, f)
    return origin



def audio_chunks(read_frame):
    """Yield 16kHz PCM chunks, ending at pauses after 5s or forcibly at 20s."""
    frames = []
    start = 0
    count = 0
    silence = 0
    while True:
        frame = read_frame(16000)
        if not frame:
            break
        if len(frame) % 2:
            raise ValueError('truncated audio frame')
        frames.append(frame)
        count += len(frame) // 2
        import numpy as np
        samples = np.frombuffer(frame, dtype='<i2').astype(np.float32)
        rms = float(np.sqrt(np.mean(samples * samples))) if len(samples) else 0
        silence = silence + len(samples) if rms < 220 else 0
        if count >= 320000 or (count >= 80000 and silence >= 12000):
            yield start / 16000, b''.join(frames)
            start += count
            frames, count, silence = [], 0, 0
    if frames:
        yield start / 16000, b''.join(frames)


def run(endpoint, end_at, meeting_id, model, decode):
    import numpy as np
    if end_at.tzinfo is None or end_at <= dt.datetime.now(dt.timezone.utc):
        raise ValueError('end time must be a future timezone-aware timestamp')
    if not re.fullmatch(r'[0-9]+', meeting_id):
        raise ValueError('invalid meeting ID')
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8-sig'))
    matches = [m for m in manifest['meetings'] if str(m['id']) == meeting_id]
    if len(matches) != 1:
        raise ValueError('meeting not uniquely present in official-source manifest')
    meeting = matches[0]
    now_local = dt.datetime.now().astimezone()
    if manifest['date'] != now_local.date().isoformat():
        raise ValueError('manifest is not for today')
    scheduled = dt.datetime.fromisoformat(meeting['scheduledAt'].replace('Z', '+00:00'))
    if scheduled.tzinfo is None or now_local < scheduled:
        raise ValueError('meeting is not yet scheduled to start')
    official = urlparse(meeting['officialPage'])
    if official.scheme != 'https' or official.hostname != 'cast.sncouncil.go.kr' or official.path != '/live/flashPlayer.jsp' or parse_qs(official.query).get('live_no') != [meeting_id]:
        raise ValueError('invalid official meeting page')
    hints = '회의 안건: ' + ', '.join(meeting.get('agenda', [])) + '. 위원 명단(출석 여부 미확인): ' + ', '.join(meeting.get('members', []))
    staff = [row['role'] + ' ' + row['name'] for row in meeting.get('staffRoster', [])]
    if staff:
        hints += '. 직책·이름 표기 참고: ' + ', '.join(staff)
    source = meeting['playlist']
    parsed = urlparse(source)
    if parsed.scheme != 'https' or parsed.hostname != 'cast.sncouncil.go.kr' or parsed.port != 4443 or not re.fullmatch(r'/live/ch[0-9]+\.sdp/playlist\.m3u8', parsed.path) or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError('unapproved public playlist')
    meeting_end = dt.datetime.fromisoformat(matches[0]['endsAt'].replace('Z', '+00:00'))
    if meeting_end.tzinfo is None or end_at > meeting_end:
        raise ValueError('end exceeds manifest meeting bound')
    endpoint = endpoint.rstrip('/') + '/api/live/captions?' + urlencode({'meetingId': meeting_id})
    origin = session_origin(meeting_id)
    # Anchor wall-clock once per process; elapsed positions advance monotonically.
    position_path = HOME / ('position-' + meeting_id + '.json')
    last_end = float(json.loads(position_path.read_text(encoding='utf-8'))['lastEnd']) if position_path.exists() else 0.0
    base_position = max(last_end, time.time() - origin, 0.0)
    base_mono = time.monotonic()
    cues = []
    try:
        request = urllib.request.Request(endpoint, headers={'User-Agent': 'SeongnamCouncilCaptionPublisher/1.0'})
        with urllib.request.urlopen(request, timeout=10) as response:
            existing = json.load(response)
        if existing.get('meetingId') != meeting_id or not isinstance(existing.get('cues'), list):
            raise ValueError('unreadable existing caption snapshot')
        cues = existing['cues'][-100:]
        base_position = max(base_position, max((float(c['end']) for c in cues), default=0.0))
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    previous = ''
    counter = time.time_ns()
    progress = [time.monotonic()]
    publish_failed = False
    def publish(status):
        nonlocal publish_failed
        try:
            signed_put(endpoint, {'meetingId': meeting_id, 'updatedAt': utc_now(), 'status': status, 'cues': cues[-100:]})
        except Exception:
            publish_failed = True
            raise
        print('{} meeting={} status={} cues={}'.format(utc_now(), meeting_id, status, len(cues)), flush=True)
    command = ['ffmpeg', '-nostdin', '-v', 'error', '-rw_timeout', '15000000', '-live_start_index', '-1', '-i', source, '-vn', '-ac', '1',
               '-ar', '16000', '-f', 's16le', 'pipe:1']
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    chunks = queue.Queue(maxsize=4)
    stop = threading.Event()
    capture_base = base_position + time.monotonic() - base_mono
    def capture():
        try:
            def read_frame(size):
                data = process.stdout.read(size)
                if data:
                    progress[0] = time.monotonic()
                return data
            for offset, data in audio_chunks(read_frame):
                if stop.is_set():
                    break
                try:
                    chunks.put((offset, data), timeout=1)
                except queue.Full:
                    stop.set()
                    break
        finally:
            stop.set()
    thread = threading.Thread(target=capture, daemon=True)
    thread.start()
    try:
        while dt.datetime.now(dt.timezone.utc) < end_at:
            try:
                offset, data = chunks.get(timeout=2)
            except queue.Empty:
                if stop.is_set():
                    raise RuntimeError('capture ended or audio queue overflowed')
                if time.monotonic() - progress[0] > 45:
                    raise RuntimeError('capture stalled')
                continue
            start = capture_base + offset
            if base_position + time.monotonic() - base_mono - start > 60:
                raise RuntimeError('transcription is over 60 seconds behind capture')
            audio = np.frombuffer(data, dtype='<i2').astype(np.float32) / 32768.0
            if float(np.sqrt(np.mean(audio * audio))) >= 0.004:
                segments = decode(meeting_id, audio, previous, hints,
                                  lambda: base_position + time.monotonic() - base_mono - start)
                if base_position + time.monotonic() - base_mono - start > 60:
                    raise RuntimeError('transcription result is stale')
            else:
                segments = []
            batch, counter, invalid_reasons = cue_batch(segments, start, len(data) / 32000, origin, counter)
            if invalid_reasons:
                print('{} meeting={} cue_interval_review count={} reasons={}'.format(
                    utc_now(), meeting_id, sum(invalid_reasons.values()),
                    ','.join('{}:{}'.format(name, count) for name, count in sorted(invalid_reasons.items()))), flush=True)
            cues.extend(batch)
            for cue in batch:
                if cue['text'] == cue['rawText']:
                    previous = (previous + ' ' + cue['rawText'])[-300:]
            cues[:] = cues[-100:]
            publish('live' if cues and cues[-1]['end'] >= start else 'listening')
            position_path.write_text(json.dumps({'lastEnd': max((c['end'] for c in cues), default=base_position)}), encoding='utf-8')
    finally:
        stop.set()
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        thread.join(timeout=5)
        # A time limit or capture failure does not prove the meeting has ended.
        if not publish_failed:
            publish('interrupted')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--end-at', required=True, help='bounded ISO 8601 timestamp with timezone')
    parser.add_argument('--meeting-id', action='append', help='repeat for each meeting; defaults to 2853')
    args = parser.parse_args()
    import msvcrt
    HOME.mkdir(parents=True, exist_ok=True)
    ids = args.meeting_id or ['2853']
    if len(ids) != len(set(ids)) or any(not re.fullmatch(r'[0-9]+', mid) for mid in ids):
        raise ValueError('meeting IDs must be distinct numbers')
    end_at = dt.datetime.fromisoformat(args.end_at.replace('Z', '+00:00'))
    model = load_model()
    jobs = queue.PriorityQueue()
    def decoder():
        while True:
            _, _, job = jobs.get()
            try:
                if job['lag']() > 60:
                    raise RuntimeError('transcription is over 60 seconds behind capture')
                started = time.monotonic()
                print('{} decode_start meeting={} audio_seconds={:.2f} queue={} lag={:.2f}'.format(
                    utc_now(), job['mid'], len(job['audio']) / 16000, jobs.qsize(), job['lag']()), flush=True)
                job['result'] = transcribe_live(model, job['audio'], job['previous'], job['hints'])
                print('{} decode_end meeting={} wall_seconds={:.2f} segments={}'.format(
                    utc_now(), job['mid'], time.monotonic() - started, len(job['result'])), flush=True)
            except Exception as error:
                job['error'] = error
            finally:
                job['done'].set()
    threading.Thread(target=decoder, daemon=True).start()
    def decode(mid, audio, previous, hints, lag):
        job = {'mid': mid, 'audio': audio, 'previous': previous, 'hints': hints,
               'lag': lag, 'done': threading.Event()}
        jobs.put((0 if mid == '2853' else 1, time.monotonic_ns(), job))
        job['done'].wait()
        if 'error' in job:
            raise job['error']
        return job['result']
    errors = []
    def worker(mid):
        try:
            with (HOME / ('producer-' + mid + '.lock')).open('a+b') as lock:
                lock.seek(0)
                if not lock.read(1):
                    lock.write(b'0')
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                try:
                    run(args.endpoint, end_at, mid, model, decode)
                finally:
                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        except Exception as error:
            errors.append((mid, error))
            print('meeting {} interrupted: {}'.format(mid, error), flush=True)
            if isinstance(error, urllib.error.HTTPError):
                print('HTTP response: {}'.format(error.read(300).decode('utf-8', 'replace').replace('\n', ' ')), flush=True)
    threads = [threading.Thread(target=worker, args=(mid,)) for mid in ids]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    if errors:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
