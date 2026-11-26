"""Sample official HLS nameplate text and publish unconfirmed observations.

One process handles one scheduled meeting. The publisher never assigns a speaker.
Use --dry-run --once to observe locally without sending anything.
"""
import argparse
import base64
from contextlib import contextmanager
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.parse import parse_qs, urlencode, urlparse
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'dist' / 'data' / 'live-meetings.json'
OCR = ROOT / 'tools' / 'video_nameplate_ocr.ps1'
HOME = Path(os.environ['LOCALAPPDATA']) / 'SeongnamCouncilDesk'
KEY = HOME / 'signing.pem'
PUBLIC_HOST = 'seongnam-council-desk.gnudas0923.chatgpt.site'
MIN_INTERVAL_SECONDS = 20


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def validate_meeting(manifest, meeting_id, end_at, now):
    if not re.fullmatch(r'[0-9]+', meeting_id):
        raise ValueError('invalid meeting ID')
    if end_at.tzinfo is None or end_at <= now:
        raise ValueError('end must be a future timezone-aware timestamp')
    if manifest.get('date') != now.astimezone().date().isoformat():
        raise ValueError('manifest is not for today')
    found = [m for m in manifest.get('meetings', []) if str(m.get('id')) == meeting_id]
    if len(found) != 1:
        raise ValueError('meeting not uniquely present in manifest')
    meeting = found[0]
    scheduled = dt.datetime.fromisoformat(meeting['scheduledAt'].replace('Z', '+00:00'))
    bound = dt.datetime.fromisoformat(meeting['endsAt'].replace('Z', '+00:00'))
    if scheduled.tzinfo is None or bound.tzinfo is None or now < scheduled or end_at > bound:
        raise ValueError('outside scheduled meeting bounds')
    official = urlparse(meeting['officialPage'])
    if (official.scheme != 'https' or official.hostname != 'cast.sncouncil.go.kr' or
            official.port not in (None, 443) or official.path != '/live/flashPlayer.jsp' or
            parse_qs(official.query) != {'live_no': [meeting_id]} or official.fragment or
            official.username or official.password):
        raise ValueError('invalid official meeting page')
    source = urlparse(meeting.get('playlist') or '')
    if (meeting.get('provider') != 'hls' or source.scheme != 'https' or
            source.hostname != 'cast.sncouncil.go.kr' or source.port != 4443 or
            not re.fullmatch(r'/live/ch[0-9]+\.sdp/playlist\.m3u8', source.path) or
            source.query or source.fragment or source.username or source.password):
        raise ValueError('unapproved official HLS source')
    members = meeting.get('members')
    if (not isinstance(members, list) or len(members) < 2 or len(members) > 40 or
            any(not isinstance(n, str) or not re.fullmatch(r'[가-힣]{2,4}', n) for n in members) or
            len(set(members)) != len(members)):
        raise ValueError('invalid official member roster')
    return meeting


class DeadlineExpired(RuntimeError):
    """The user-specified meeting bound has elapsed."""


def deadline_timeout(deadline, maximum):
    remaining = (deadline - dt.datetime.now(dt.timezone.utc)).total_seconds()
    if remaining <= 0:
        raise DeadlineExpired('meeting deadline has elapsed')
    return min(maximum, remaining)


def make_nameplate_crops(filename):
    """Create bounded grayscale crops; the full-frame OCR remains the fallback."""
    paths = []
    try:
        from PIL import Image, ImageOps
        with Image.open(filename) as source:
            width, height = source.size
            if width < 200 or height < 100 or width * height > 16000000:
                return []
            # The first two cover the supplied 855 x 482 split-screen view.
            # The third covers the left plaque in the 1280 x 720 broadcast
            # with the blue program border. No face detection is involved.
            for x, y, w, h in [(58/855, 364/482, 119/855, 50/482),
                               (622/855, 387/482, 119/855, 50/482),
                               (106/1280, 458/720, 111/1280, 58/720)]:
                box = (round(width*x), round(height*y), round(width*(x+w)), round(height*(y+h)))
                crop = ImageOps.grayscale(source.crop(box))
                # Keep the plaque near the proven 444–476 pixel OCR width,
                # without excessively enlarging a high-resolution feed.
                scale = min(4.0, 476 / crop.width)
                crop = crop.resize((max(1, round(crop.width * scale)), max(1, round(crop.height * scale))), Image.Resampling.LANCZOS)
                fd, path = tempfile.mkstemp(prefix='nameplate-crop-', suffix='.png', dir=HOME)
                os.close(fd)
                paths.append(path)
                crop.save(path, format='PNG')
        return paths
    except (ImportError, OSError, ValueError):
        for path in paths:
            Path(path).unlink(missing_ok=True)
        return []


def capture_and_ocr(meeting, deadline):
    HOME.mkdir(parents=True, exist_ok=True)
    descriptor, filename = tempfile.mkstemp(prefix='nameplate-', suffix='.png', dir=HOME)
    os.close(descriptor)
    crops = []
    try:
        subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
                        '-threads', '1', '-rw_timeout', '15000000', '-live_start_index', '-1',
                        '-i', meeting['playlist'], '-frames:v', '1', '-update', '1', '-y', filename],
                       check=True, timeout=deadline_timeout(deadline, 25), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        captured_at = utc_now()
        crops = make_nameplate_crops(filename)
        try:
            command = ['powershell.exe', '-NoProfile', '-NonInteractive', '-File', str(OCR),
                                 '-ImagePath', filename, '-MembersBase64',
                                 base64.b64encode(json.dumps(meeting['members'], ensure_ascii=False).encode('utf-8')).decode('ascii'),
                                 '-VideoUrl', meeting['officialPage'], '-CapturedAt', captured_at]
            if crops:
                command += ['-ExtraImagesBase64', base64.b64encode(json.dumps(crops).encode('utf-8')).decode('ascii')]
            result = subprocess.run(command,
                                    check=True, timeout=deadline_timeout(deadline, 20), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as error:
            diagnostic = (error.stderr or b'').decode('utf-8', errors='replace')
            if 'Korean Windows OCR is unavailable' in diagnostic or 'complete member roster is required' in diagnostic:
                raise RuntimeError('OCR is not configured') from error
            raise
        data = json.loads(result.stdout.decode('utf-8-sig'))
        names = data.get('matchedMembers')
        if (not isinstance(names, list) or len(names) > len(meeting['members']) or
                any(not isinstance(n, str) or n not in meeting['members'] for n in names) or
                len(set(names)) != len(names)):
            raise ValueError('OCR returned invalid member matches')
        return {'capturedAt': captured_at, 'matchedMembers': names}
    finally:
        for path in crops:
            Path(path).unlink(missing_ok=True)
        Path(filename).unlink(missing_ok=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def signed_put(meeting_id, observation, key_path=KEY, deadline=None):
    from cryptography.hazmat.primitives import serialization
    body = json.dumps({'meetingId': meeting_id, 'updatedAt': utc_now(), 'observations': [observation]},
                      ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    key = serialization.load_pem_private_key(Path(key_path).read_bytes(), password=None)
    signature = base64.urlsafe_b64encode(key.sign(body)).decode('ascii').rstrip('=')
    url = 'https://' + PUBLIC_HOST + '/api/live/nameplates?' + urlencode({'meetingId': meeting_id})
    req = urllib.request.Request(url, body, {'Content-Type': 'application/json',
        'X-Council-Signature': signature, 'User-Agent': 'SeongnamCouncilNameplatePublisher/1.0'}, method='PUT')
    timeout = deadline_timeout(deadline, 15) if deadline else 15
    with urllib.request.build_opener(NoRedirect).open(req, timeout=timeout) as response:
        response.read(4096)


@contextmanager
def meeting_lock(meeting_id):
    """Prevent two publishers from sampling the same meeting simultaneously."""
    import msvcrt
    HOME.mkdir(parents=True, exist_ok=True)
    lock_path = HOME / ('nameplate-' + meeting_id + '.lock')
    with lock_path.open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise RuntimeError('another nameplate publisher owns this meeting') from exc
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def pending_expired(observation, now=None):
    """Leave a margin below the server's ten-minute capturedAt limit."""
    captured = dt.datetime.fromisoformat(observation['capturedAt'].replace('Z', '+00:00'))
    if captured.tzinfo is None:
        raise ValueError('observation timestamp must include a timezone')
    current = now if now is not None else dt.datetime.now(dt.timezone.utc)
    return (current - captured).total_seconds() >= 570

def run_loop(args, meeting, end):
    failures = 0
    pending = None
    while dt.datetime.now(dt.timezone.utc) < end:
        start = time.monotonic()
        try:
            if pending is not None and pending_expired(pending):
                print(f'{utc_now()} meeting={args.meeting_id} expired unsent observation discarded', flush=True)
                pending = None
            if pending is None:
                pending = capture_and_ocr(meeting, end)
            observation = pending
            if dt.datetime.now(dt.timezone.utc) >= end:
                break
            if args.dry_run:
                print(json.dumps(observation, ensure_ascii=False), flush=True)
            else:
                signed_put(args.meeting_id, observation, deadline=end)
                print(f"{observation['capturedAt']} meeting={args.meeting_id} matched={len(observation['matchedMembers'])}", flush=True)
            pending = None
            failures = 0
        except DeadlineExpired:
            break
        except urllib.error.HTTPError as error:
            if args.once or (400 <= error.code < 500 and error.code not in (409, 429)):
                raise
            failures += 1
            print(f'{utc_now()} meeting={args.meeting_id} temporary HTTP failure: {error.code}', flush=True)
        except (FileNotFoundError, PermissionError):
            # Missing executable or signing key is a configuration failure.
            raise
        except (OSError, subprocess.SubprocessError) as error:
            if dt.datetime.now(dt.timezone.utc) >= end:
                break
            if args.once:
                raise
            failures += 1
            print(f'{utc_now()} meeting={args.meeting_id} temporary sampling failure: {type(error).__name__}', flush=True)
        if args.once:
            break
        delay = min(300, args.interval * 2 ** min(max(failures - 1, 0), 8)) if failures else args.interval
        remaining = min(delay - (time.monotonic() - start), (end - dt.datetime.now(dt.timezone.utc)).total_seconds())
        if remaining > 0:
            time.sleep(remaining)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--meeting-id', required=True)
    parser.add_argument('--live-schedule', action='store_true', help='read current schedule from the deployed API')
    parser.add_argument('--end-at', required=True, help='ISO 8601 timestamp with timezone, within meeting bounds')
    parser.add_argument('--interval', type=int, default=MIN_INTERVAL_SECONDS, help='minimum 20 seconds between attempts')
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--dry-run', action='store_true', help='do not sign or publish')
    args = parser.parse_args()
    if args.interval < MIN_INTERVAL_SECONDS or args.interval > 300:
        parser.error('interval must be between 20 and 300 seconds')
    end = dt.datetime.fromisoformat(args.end_at.replace('Z', '+00:00'))
    now = dt.datetime.now(dt.timezone.utc)
    if args.live_schedule:
        from live_schedule import fetch_schedule
        manifest = fetch_schedule('https://' + PUBLIC_HOST)
    else:
        manifest = json.loads(MANIFEST.read_text(encoding='utf-8-sig'))
    meeting = validate_meeting(manifest, args.meeting_id, end, now)
    with meeting_lock(args.meeting_id):
        run_loop(args, meeting, end)


if __name__ == '__main__':
    main()
