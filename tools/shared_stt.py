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
import tempfile
import time
import urllib.request
import urllib.error
from urllib.parse import urlencode, parse_qs
from urllib.parse import urlparse

MANIFEST = Path(__file__).resolve().parents[1] / 'dist' / 'data' / 'live-meetings.json'
HOME = Path(os.environ.get('LOCALAPPDATA') or Path.home() / '.local' / 'share') / 'SeongnamCouncilDesk'
MODEL = HOME / 'models' / 'faster-whisper-small'
KEY = HOME / 'signing.pem'
PROMPT = '성남시의회 회의 발언입니다. 의장, 의원, 위원장, 성남시, 예산, 조례, 집행부.'
MAX_AUDIO_LAG = 60
DEFAULT_LAG_RECONNECTS = 2
COUNCIL_TZ = dt.timezone(dt.timedelta(hours=9))


class AudioLagError(RuntimeError):
    """The current PCM stream has fallen too far behind the live edge."""


def require_current_audio(age, stage):
    if age > MAX_AUDIO_LAG:
        raise AudioLagError(f'{stage}: audio is {age:.3f} seconds behind live capture')


def load_model(model_path=None):
    from faster_whisper import WhisperModel
    return WhisperModel(str(model_path or MODEL), device='cpu', compute_type='int8', cpu_threads=2, num_workers=1, local_files_only=True)


def installed_speaker_model():
    filename = '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'
    # The portable handoff stores its pinned model next to source/. An operator installation uses HOME/models.
    for directory in (HOME / 'models', Path(__file__).resolve().parents[2] / 'models'):
        candidate = directory / filename
        if candidate.is_file():
            return candidate
    return None


def meeting_hints(meeting):
    hints = '회의 안건: ' + ', '.join(meeting.get('agenda', []))
    # A historically assigned person can corroborate a name heard in the audio.
    # Feeding that same candidate into the decoder would also bias its spelling.
    if not (meeting.get('memberRoster') or {}).get('candidateOnly'):
        hints += '. 위원 명단(출석 여부 미확인): ' + ', '.join(meeting.get('members', []))
    staff = [row['role'] + ' ' + row['name'] for row in meeting.get('staffRoster', [])
             if not row.get('candidateOnly')]
    if staff:
        hints += '. 직책·이름 표기 참고: ' + ', '.join(staff)
    return hints


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


def select_first_beam(latency_policy, chunk_age):
    if latency_policy == 'adaptive' and chunk_age >= 30:
        return 1
    return 2


def transcribe_live(model, audio, previous_text='', hints='', *, first_beam_size=2):
    """Retry one suspect chunk from its audio before exposing a review marker."""
    def suspect(segments):
        return any(
            {'repetition', 'severe_uncertainty'}.intersection(quality_decision(seg)[2])
            for seg in segments
        )

    first = transcribe_audio(model, audio, previous_text, hints, beam_size=first_beam_size)
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


def cue_batch(segments, chunk_start, chunk_duration, origin, first_id, *, acoustic=None, pcm=None):
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
            ordered.append((absolute_start, index, absolute_end, raw, text, flags, start, end))
        else:
            invalid.append((raw, flags, absolute_start, reason))
            invalid_reasons[reason] = invalid_reasons.get(reason, 0) + 1

    ordered.sort(key=lambda item: (item[0], item[1]))
    cues = []
    sample_ranges = {}
    counter = first_id
    for start, _, end, raw, text, flags, source_start, source_end in ordered:
        counter += 1
        cue_id = str(counter)
        cues.append({'id': cue_id, 'start': start, 'end': end, 'rawText': raw,
                     'observedAt': dt.datetime.fromtimestamp(origin + start, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                     'text': text, 'flags': flags})
        if acoustic is not None:
            sample_ranges[cue_id] = (round(source_start * 16000), round(source_end * 16000))

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
    if acoustic is not None:
        if invalid_reasons:
            acoustic.reset()
        else:
            error = acoustic.annotate(cues, pcm, chunk_start, sample_ranges)
            if error:
                print(f'{utc_now()} acoustic_disabled reason={error}', flush=True)
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


def run(endpoint, end_at, meeting_id, model, decode, *, acoustic_extractor=None, acoustic_profile=None,
        podium_floor=False, on_capture_started=None, lag_reconnects=DEFAULT_LAG_RECONNECTS, manifest_override=None):
    import numpy as np
    if end_at.tzinfo is None or end_at <= dt.datetime.now(dt.timezone.utc):
        raise ValueError('end time must be a future timezone-aware timestamp')
    if not re.fullmatch(r'[0-9]+', meeting_id):
        raise ValueError('invalid meeting ID')
    if type(lag_reconnects) is not int or not 0 <= lag_reconnects <= DEFAULT_LAG_RECONNECTS:
        raise ValueError('invalid lag reconnect budget')
    manifest = manifest_override if manifest_override is not None else json.loads(MANIFEST.read_text(encoding='utf-8-sig'))
    matches = [m for m in manifest['meetings'] if str(m['id']) == meeting_id]
    if len(matches) != 1:
        raise ValueError('meeting not uniquely present in official-source manifest')
    meeting = matches[0]
    acoustic = None
    if acoustic_extractor is not None:
        from live_acoustic import LiveAcoustic, POLICY_ID
        acoustic = LiveAcoustic(meeting, acoustic_extractor, profile=acoustic_profile or POLICY_ID,
                                podium_floor=podium_floor)
    now_local = dt.datetime.now(COUNCIL_TZ)
    if manifest['date'] != now_local.date().isoformat():
        raise ValueError('manifest is not for today')
    scheduled = dt.datetime.fromisoformat(meeting['scheduledAt'].replace('Z', '+00:00'))
    if scheduled.tzinfo is None or now_local < scheduled:
        raise ValueError('meeting is not yet scheduled to start')
    official = urlparse(meeting['officialPage'])
    if official.scheme != 'https' or official.hostname != 'cast.sncouncil.go.kr' or official.path != '/live/flashPlayer.jsp' or parse_qs(official.query).get('live_no') != [meeting_id]:
        raise ValueError('invalid official meeting page')
    hints = meeting_hints(meeting)
    source = meeting['playlist']
    parsed = urlparse(source)
    if parsed.scheme != 'https' or parsed.hostname != 'cast.sncouncil.go.kr' or parsed.port != 4443 or not re.fullmatch(r'/live/ch[0-9]+\.sdp/playlist\.m3u8', parsed.path) or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError('unapproved public playlist')
    meeting_end = dt.datetime.fromisoformat(matches[0]['endsAt'].replace('Z', '+00:00'))
    if meeting_end.tzinfo is None or end_at > meeting_end:
        raise ValueError('end exceeds manifest meeting bound')
    endpoint = endpoint.rstrip('/') + '/api/live/captions?' + urlencode({'meetingId': meeting_id})
    origin = session_origin(meeting_id)
    end_position = end_at.timestamp() - origin
    # Anchor wall-clock once per process; elapsed positions advance monotonically.
    position_path = HOME / ('position-' + meeting_id + '.json')
    last_end = float(json.loads(position_path.read_text(encoding='utf-8'))['lastEnd']) if position_path.exists() else 0.0
    base_position = max(last_end, time.time() - origin, 0.0)
    base_mono = time.monotonic()
    cues = []
    last_status = None
    last_update = ''
    try:
        request = urllib.request.Request(endpoint, headers={'User-Agent': 'SeongnamCouncilCaptionPublisher/1.0'})
        with urllib.request.urlopen(request, timeout=10) as response:
            existing = json.load(response)
        if existing.get('meetingId') != meeting_id or not isinstance(existing.get('cues'), list):
            raise ValueError('unreadable existing caption snapshot')
        cues = existing['cues'][-100:]
        base_position = max(base_position, max((float(c['end']) for c in cues), default=0.0))
        last_status = existing.get('status')
        last_update = existing.get('updatedAt') or ''
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    counter = time.time_ns()
    last_audio_end = None
    publish_failed = False
    def capture_position():
        return base_position + time.monotonic() - base_mono

    def publish(status, *, gap_start=None, gap_end=None):
        nonlocal publish_failed, last_status, last_update
        updated_at = utc_now()
        # Consecutive acknowledgements can share the same millisecond.
        for _ in range(10):
            if updated_at > last_update:
                break
            time.sleep(0.002)
            updated_at = utc_now()
        if updated_at <= last_update:
            publish_failed = True
            raise RuntimeError('caption publication clock did not advance')
        payload = {'meetingId': meeting_id, 'updatedAt': updated_at, 'status': status, 'cues': cues[-100:]}
        for key, position in [('captureGapStart', gap_start), ('captureGapEnd', gap_end)]:
            if position is not None:
                timestamp = dt.datetime.fromtimestamp(origin + position, dt.timezone.utc).isoformat(
                    timespec='milliseconds').replace('+00:00', 'Z')
                if timestamp <= payload['updatedAt']:
                    payload[key] = timestamp
        try:
            signed_put(endpoint, payload)
        except Exception:
            publish_failed = True
            raise
        last_status = status
        last_update = updated_at
        print('{} meeting={} status={} cues={}'.format(utc_now(), meeting_id, status, len(cues)), flush=True)
    command = ['ffmpeg', '-nostdin', '-v', 'error', '-rw_timeout', '15000000', '-live_start_index', '-1', '-i', source, '-vn', '-ac', '1',
               '-ar', '16000', '-f', 's16le', 'pipe:1']
    archive_notified = False
    capture_opened = False

    def capture_attempt():
        nonlocal counter, last_audio_end, archive_notified, capture_opened
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        capture_opened = True
        capture_base = max(capture_position(), last_audio_end or 0.0)
        progress = time.monotonic()
        chunks = queue.Queue(maxsize=4)
        stop = threading.Event()
        capture_failure = None

        def capture():
            nonlocal progress, capture_failure
            try:
                def read_frame(size):
                    nonlocal progress
                    data = process.stdout.read(size)
                    if data:
                        progress = time.monotonic()
                    return data
                for offset, data in audio_chunks(read_frame):
                    if stop.is_set():
                        break
                    chunks.put((offset, data), timeout=1)
            except queue.Full:
                capture_failure = AudioLagError('audio capture queue overflowed')
            except Exception as error:
                capture_failure = error
            finally:
                stop.set()

        previous = ''
        thread = threading.Thread(target=capture, daemon=True)
        thread.start()
        try:
            while dt.datetime.now(dt.timezone.utc) < end_at:
                if isinstance(capture_failure, AudioLagError):
                    raise capture_failure
                try:
                    offset, data = chunks.get(timeout=2)
                except queue.Empty:
                    if dt.datetime.now(dt.timezone.utc) >= end_at:
                        break
                    if stop.is_set():
                        if capture_failure is not None:
                            raise capture_failure
                        code = process.poll()
                        if code:
                            raise RuntimeError(f'FFmpeg capture ended with exit code {code}')
                        raise RuntimeError('capture ended')
                    if time.monotonic() - progress > 45:
                        raise RuntimeError('capture stalled')
                    continue
                if dt.datetime.now(dt.timezone.utc) >= end_at:
                    break
                start = capture_base + offset
                # A buffered FFmpeg read can contain samples beyond the requested stop.
                samples_before_end = math.floor((end_position - start) * 16000)
                if samples_before_end < 16:
                    break
                data = data[:samples_before_end * 2]
                def age():
                    return capture_position() - start

                require_current_audio(age(), 'before decode')
                audio = np.frombuffer(data, dtype='<i2').astype(np.float32) / 32768.0
                segments = (decode(meeting_id, audio, previous, hints, age)
                            if float(np.sqrt(np.mean(audio * audio))) >= 0.004 else [])
                if dt.datetime.now(dt.timezone.utc) >= end_at:
                    break
                if isinstance(capture_failure, AudioLagError):
                    raise capture_failure
                require_current_audio(age(), 'after decode')
                acoustic_batch = acoustic
                if acoustic is not None and age() >= 50:
                    acoustic.reset()
                    acoustic_batch = None
                batch, counter, invalid_reasons = cue_batch(
                    segments, start, len(data) / 32000, origin, counter, acoustic=acoustic_batch, pcm=data,
                )
                if dt.datetime.now(dt.timezone.utc) >= end_at:
                    break
                require_current_audio(age(), 'before publish')
                if batch and on_capture_started and not archive_notified:
                    on_capture_started(meeting)
                    archive_notified = True
                if invalid_reasons:
                    print('{} meeting={} cue_interval_review count={} reasons={}'.format(
                        utc_now(), meeting_id, sum(invalid_reasons.values()),
                        ','.join('{}:{}'.format(name, count) for name, count in sorted(invalid_reasons.items()))), flush=True)
                cues.extend(batch)
                for cue in batch:
                    if cue['text'] == cue['rawText']:
                        previous = (previous + ' ' + cue['rawText'])[-300:]
                cues[:] = cues[-100:]
                publish('live' if cues and cues[-1]['end'] >= start else 'listening',
                        gap_end=start if last_status == 'interrupted' else None)
                last_audio_end = start + len(data) / 32000
                position_path.write_text(json.dumps({'lastEnd': max((c['end'] for c in cues), default=base_position)}), encoding='utf-8')
        except AudioLagError as error:
            if stop.is_set() and not isinstance(capture_failure, AudioLagError):
                if capture_failure is not None:
                    raise capture_failure from error
                raise RuntimeError(f'capture ended with stale audio: {error}') from error
            raise
        finally:
            stop.set()
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            thread.join(timeout=5)
            process.stdout.close()

    capture_error = None
    try:
        for attempt in range(lag_reconnects + 1):
            if dt.datetime.now(dt.timezone.utc) >= end_at:
                break
            try:
                capture_attempt()
                break
            except AudioLagError as error:
                if publish_failed or attempt == lag_reconnects or dt.datetime.now(dt.timezone.utc) >= end_at:
                    raise
                print(f'{utc_now()} meeting={meeting_id} lag_reconnect={attempt+1}/{lag_reconnects} reason={error}', flush=True)
                if last_status != 'interrupted':
                    publish('interrupted', gap_start=last_audio_end)
                if acoustic is not None:
                    acoustic.reset()
    except BaseException as error:
        capture_error = error
        raise
    finally:
        # A time limit or capture failure does not prove the meeting has ended.
        if capture_opened and not publish_failed and last_status != 'interrupted':
            try:
                publish('interrupted', gap_start=last_audio_end)
            except Exception as error:
                if capture_error is None:
                    raise
                print(f'{utc_now()} meeting={meeting_id} interruption publish failed: {error}', flush=True)


def archive_builder_path(explicit=None):
    if explicit is not None:
        candidate = Path(explicit).expanduser().resolve()
        if not candidate.is_file():
            raise ValueError('archive builder not found: ' + str(candidate))
        return candidate
    source = Path(__file__).resolve()
    candidates = [source.with_name('build_caption_archive.cjs'),
                  source.parents[2] / 'ui-preview-assets' / 'build-archive.cjs',
                  source.parents[2] / 'build-archive.cjs', source.parents[1] / 'build-archive.cjs']
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise ValueError('archive builder not found; specify --archive-builder')


def archive_finished_meeting(endpoint, meeting, directory, builder):
    """Fetch the complete same-origin minutes and let the archive builder validate them."""
    base = urlparse(endpoint)
    if (base.scheme != 'https' or not base.netloc or base.username or base.password or
            base.path not in ('', '/') or base.query or base.fragment):
        raise ValueError('archive endpoint must be an HTTPS site origin')
    mid = str(meeting.get('id', ''))
    if not re.fullmatch(r'[1-9]\d{0,7}', mid):
        raise ValueError('invalid archive meeting ID')
    url = endpoint.rstrip('/') + '/api/live/minutes?' + urlencode({'meetingId': mid})
    request = urllib.request.Request(url, headers={'User-Agent': 'SeongnamCouncilCaptionArchive/1.0'})
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.geturl() != url:
            raise ValueError('unexpected minutes redirect')
        body = response.read(64 * 1024 * 1024 + 1)
    if len(body) > 64 * 1024 * 1024:
        raise ValueError('minutes response exceeds size limit')
    snapshot = json.loads(body.decode('utf-8-sig'))
    if snapshot.get('meetingId') != mid or not isinstance(snapshot.get('cues'), list) or not snapshot['cues']:
        raise ValueError('no valid full minutes for this meeting')
    with tempfile.TemporaryDirectory(prefix='council-archive-') as temp:
        minutes = Path(temp) / 'minutes.json'
        metadata = Path(temp) / 'meeting.json'
        minutes.write_bytes(body)
        metadata.write_text(json.dumps(meeting, ensure_ascii=False), encoding='utf-8')
        command = ['node', str(builder), '--minutes', str(minutes), '--metadata', str(metadata), '--archive', str(directory)]
        for attempt in range(4):
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
            if result.returncode == 0:
                print(f'{utc_now()} meeting={mid} archive=saved cues={len(snapshot["cues"])}', flush=True)
                return
            if '다른 보관 갱신이 진행 중' not in result.stderr or attempt == 3:
                raise RuntimeError('archive builder failed: ' + result.stderr.strip()[:500])
            time.sleep(1 + attempt)


def default_capture_meeting_id(manifest):
    rows = manifest.get('meetings', [])
    counts = {}
    for row in rows:
        if isinstance(row, dict):
            mid = str(row.get('id'))
            if re.fullmatch(r'[1-9]\d{0,7}', mid):
                counts[mid] = counts.get(mid, 0) + 1
    eligible = {
        str(row['id']): row for row in rows
        if isinstance(row, dict) and counts.get(str(row.get('id'))) == 1
        and isinstance(row.get('playlist'), str) and row['playlist'].strip()
        and row.get('provider', 'hls') == 'hls'
    }
    configured = str(manifest.get('defaultMeetingId'))
    if configured in eligible:
        return configured
    for mid, row in eligible.items():
        if row.get('title') == '경제환경위원회':
            return mid
    return next(iter(eligible), None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--live-schedule', action='store_true', help='read current schedule from the deployed API')
    parser.add_argument('--end-at', help='bounded ISO 8601 timestamp with timezone; required for capture')
    parser.add_argument('--meeting-id', action='append',
                        help='repeat for each meeting; defaults to the configured live HLS meeting')
    parser.add_argument('--asr-model', type=Path, help='path to a local faster-whisper-small model')
    parser.add_argument('--latency-policy', choices=['standard', 'adaptive'], default='standard',
                        help='adaptive uses greedy first-pass ASR if the oldest audio in a chunk is at least 30 seconds old')
    parser.add_argument('--lag-reconnects', type=int, choices=range(DEFAULT_LAG_RECONNECTS + 1), default=DEFAULT_LAG_RECONNECTS,
                        help='reopen live audio on stale PCM or buffer overflow, at most twice (0 disables)')
    parser.add_argument('--text-only-speakers', action='store_true', help='skip optional local same-meeting voice evidence')
    parser.add_argument('--speaker-model', type=Path, help='local ONNX speaker model for the experimental evidence profile')
    parser.add_argument('--speaker-profile', help='explicit opt-in profile for local acoustic evidence')
    parser.add_argument('--podium-floor', action='store_true',
                        help='experimental named plenary floor evidence; requires the pinned CAM++ speaker profile')
    parser.add_argument('--archive-dir', type=Path, help='opt in to saving complete minutes to this local archive directory')
    parser.add_argument('--archive-builder', type=Path, help='path to build-archive.cjs (optional if found next to the checkout)')
    parser.add_argument('--archive-retry', action='store_true', help='retry archive only, without starting capture or publishing')
    args = parser.parse_args()
    if args.archive_builder and not args.archive_dir:
        parser.error('--archive-builder requires --archive-dir')
    if args.archive_retry and (not args.archive_dir or not args.meeting_id):
        parser.error('--archive-retry requires --archive-dir and explicit --meeting-id')
    if not args.archive_retry and not args.end_at:
        parser.error('--end-at is required for capture')
    builder = archive_builder_path(args.archive_builder) if args.archive_dir else None
    archive_lock = threading.Lock()
    if args.archive_retry:
        ids = args.meeting_id
        if len(ids) != len(set(ids)) or any(not re.fullmatch(r'[1-9]\d{0,7}', mid) for mid in ids):
            parser.error('meeting IDs must be distinct valid numbers')
        manifest = json.loads(MANIFEST.read_text(encoding='utf-8-sig'))
        failed = False
        for mid in ids:
            matches = [meeting for meeting in manifest.get('meetings', []) if str(meeting.get('id')) == mid]
            try:
                if len(matches) != 1:
                    raise ValueError('meeting not uniquely present in official-source manifest')
                archive_finished_meeting(args.endpoint, matches[0], args.archive_dir, builder)
            except Exception as error:
                failed = True
                print('meeting {} archive failed: {}'.format(mid, error), flush=True)
        if failed:
            raise SystemExit(1)
        return
    if args.live_schedule:
        from live_schedule import fetch_schedule
        manifest = fetch_schedule(args.endpoint)
    else:
        manifest = json.loads(MANIFEST.read_text(encoding='utf-8-sig'))
    if manifest.get('date') != dt.datetime.now(COUNCIL_TZ).date().isoformat():
        parser.error('manifest is not for today')
    default_mid = default_capture_meeting_id(manifest)
    ids = args.meeting_id or ([default_mid] if default_mid else [])
    if not ids:
        parser.error('manifest has no eligible HLS capture meeting')
    if len(ids) != len(set(ids)) or any(not re.fullmatch(r'[1-9]\d{0,7}', mid) for mid in ids):
        parser.error('meeting IDs must be distinct valid numbers')
    acoustic_extractor = None
    if args.text_only_speakers and (args.speaker_model or args.speaker_profile or args.podium_floor):
        parser.error('--text-only-speakers conflicts with explicit acoustic settings')
    if not args.text_only_speakers and args.speaker_model is None and args.speaker_profile is None:
        args.speaker_model = installed_speaker_model()
        if args.speaker_model is not None:
            args.speaker_profile = 'same-session-cam-1'
    if args.podium_floor and (args.speaker_model is None or args.speaker_profile != 'same-session-cam-1'):
        parser.error('--podium-floor requires --speaker-model and --speaker-profile same-session-cam-1')
    if args.speaker_model is not None or args.speaker_profile is not None:
        if args.speaker_model is None or args.speaker_profile is None:
            parser.error('--speaker-model and --speaker-profile must be set together')
        from live_acoustic import PROFILES, load_extractor
        if args.speaker_profile not in PROFILES:
            parser.error('unsupported speaker profile; use ' + ' or '.join(PROFILES))
        try:
            acoustic_extractor = load_extractor(args.speaker_model, args.speaker_profile)
            print(f'{utc_now()} acoustic_ready profile={args.speaker_profile}', flush=True)
        except Exception as error:
            print(f'{utc_now()} acoustic_disabled reason={type(error).__name__}', flush=True)
    import msvcrt
    HOME.mkdir(parents=True, exist_ok=True)
    end_at = dt.datetime.fromisoformat(args.end_at.replace('Z', '+00:00'))
    model = load_model(args.asr_model)
    jobs = queue.PriorityQueue()
    def decoder():
        while True:
            _, _, job = jobs.get()
            try:
                age = job['lag']()
                require_current_audio(age, 'before queued decode')
                first_beam = select_first_beam(args.latency_policy, age)
                started = time.monotonic()
                print('{} decode_start meeting={} audio_seconds={:.2f} queue={} lag={:.2f} first_beam={}'.format(
                    utc_now(), job['mid'], len(job['audio']) / 16000, jobs.qsize(), age, first_beam), flush=True)
                job['result'] = transcribe_live(model, job['audio'], job['previous'], job['hints'], first_beam_size=first_beam)
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
        jobs.put((0 if mid == default_mid else 1, time.monotonic_ns(), job))
        job['done'].wait()
        if 'error' in job:
            raise job['error']
        return job['result']
    errors = []
    def worker(mid):
        archive_meeting = None
        def capture_started(meeting):
            nonlocal archive_meeting
            archive_meeting = meeting
        try:
            with (HOME / ('producer-' + mid + '.lock')).open('a+b') as lock:
                lock.seek(0)
                if not lock.read(1):
                    lock.write(b'0')
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                try:
                    try:
                        run(args.endpoint, end_at, mid, model, decode, acoustic_extractor=acoustic_extractor,
                            acoustic_profile=args.speaker_profile, podium_floor=args.podium_floor,
                            on_capture_started=capture_started if builder else None, lag_reconnects=args.lag_reconnects, manifest_override=manifest if args.live_schedule else None)
                    finally:
                        if builder and archive_meeting is not None:
                            try:
                                with archive_lock:
                                    archive_finished_meeting(args.endpoint, archive_meeting, args.archive_dir, builder)
                            except Exception as error:
                                errors.append((mid, error))
                                print('meeting {} archive failed: {}'.format(mid, error), flush=True)
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
