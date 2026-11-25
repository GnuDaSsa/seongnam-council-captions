"""Relay a short moving window of an official public HLS broadcast to Sites."""
import argparse
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime

USER_AGENT = 'Mozilla/5.0'
MAX_PLAYLIST = 1024 * 1024
MAX_SEGMENT = 16 * 1024 * 1024

def timestamp(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('deadline must include UTC offset')
    return result.timestamp()

def same_host(base, target):
    left, right = urllib.parse.urlsplit(base), urllib.parse.urlsplit(target)
    return (left.scheme.lower(), left.hostname, left.port) == (right.scheme.lower(), right.hostname, right.port)

def fetch(url, limit):
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=7) as response:
        if not same_host(url, response.geturl()):
            raise ValueError('cross-host redirect rejected')
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('response exceeds size limit')
        return data

def parse_playlist(url, origin):
    for _ in range(4):
        if not same_host(origin, url): raise ValueError('cross-host playlist rejected')
        lines = [s.strip() for s in fetch(url, MAX_PLAYLIST).decode('utf-8-sig').splitlines() if s.strip()]
        if not lines or lines[0] != '#EXTM3U' or '#EXT-X-ENDLIST' in lines:
            raise ValueError('not a live playlist')
        variants = [lines[i + 1] for i, s in enumerate(lines[:-1]) if s.startswith('#EXT-X-STREAM-INF:')]
        if variants:
            url = urllib.parse.urljoin(url, variants[0]); continue
        sequence = next((int(s.split(':',1)[1]) for s in lines if s.startswith('#EXT-X-MEDIA-SEQUENCE:')), None)
        target = next((int(s.split(':',1)[1]) for s in lines if s.startswith('#EXT-X-TARGETDURATION:')), None)
        if sequence is None or target is None or target < 1:
            raise ValueError('playlist missing sequence or target duration')
        if any(s.startswith(('#EXT-X-KEY:', '#EXT-X-MAP:', '#EXT-X-BYTERANGE:', '#EXT-X-DISCONTINUITY')) for s in lines):
            raise ValueError('unsupported encrypted or non-TS/discontinuous HLS')
        rows, duration = [], None
        for line in lines:
            if line.startswith('#EXTINF:'):
                duration = float(line.split(':', 1)[1].split(',', 1)[0])
                if not 0 < duration <= 120: raise ValueError('invalid segment duration')
            elif not line.startswith('#'):
                segment_url = urllib.parse.urljoin(url, line)
                if duration is None or not same_host(origin, segment_url): raise ValueError('invalid segment URL')
                rows.append((sequence + len(rows), duration, segment_url)); duration = None
        if not rows: raise ValueError('empty playlist')
        return target, rows
    raise ValueError('too many playlist levels')

def put(url, data, token, content_type):
    req = urllib.request.Request(url, data=data, method='PUT', headers={'Authorization': 'Bearer ' + token, 'Content-Type': content_type})
    with urllib.request.urlopen(req, timeout=10) as response:
        if not 200 <= response.status < 300: raise ValueError('upload failed')

def render(target, rows):
    lines = ['#EXTM3U', '#EXT-X-VERSION:3', f'#EXT-X-TARGETDURATION:{target}', f'#EXT-X-MEDIA-SEQUENCE:{rows[0][0]}']
    for seq, duration, _ in rows:
        lines.extend([f'#EXTINF:{duration:.3f},', f'{seq % 12}.ts'])
    return ('\n'.join(lines) + '\n').encode('utf-8')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hls', required=True)
    parser.add_argument('--site', required=True, help='HTTPS origin of the Sites relay')
    parser.add_argument('--deadline', default='2026-11-25T14:59:00Z')
    args = parser.parse_args()
    token = os.environ.get('SN_LIVE_WRITE_TOKEN')
    if not token: parser.error('SN_LIVE_WRITE_TOKEN is required')
    parsed = urllib.parse.urlsplit(args.site)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        parser.error('--site must be an HTTPS origin')
    try: deadline = timestamp(args.deadline)
    except ValueError as exc: parser.error(str(exc))
    base = args.site.rstrip('/') + '/api/live/'
    uploaded = {}
    previous = None
    changed_at = 0
    try:
        while time.time() < deadline:
            try:
                target, rows = parse_playlist(args.hls, args.hls)
                identity = (rows[-1][0], rows[-1][2])
                if previous is not None and identity != previous:
                    changed_at = time.time()
                previous = identity
                if not changed_at or time.time() - changed_at > max(30, target * 4):
                    time.sleep(min(3, target)); continue
                window = rows[-4:]
                for seq, duration, url in window:
                    if uploaded.get(seq % 12) == (seq, url): continue
                    data = fetch(url, MAX_SEGMENT)
                    if not data or data[0] != 0x47:
                        raise ValueError('segment is not MPEG-TS')
                    error = None
                    for _ in range(2):
                        try:
                            put(base + str(seq % 12) + '.ts', data, token, 'video/mp2t')
                            error = None; break
                        except Exception as exc: error = exc
                    if error: raise error
                    uploaded[seq % 12] = (seq, url)
                put(base + 'playlist.m3u8', render(target, window), token, 'application/vnd.apple.mpegurl')
                time.sleep(max(1, min(3, target / 2)))
            except Exception as exc:
                print('live video relay:', str(exc), file=sys.stderr, flush=True)
                time.sleep(3)
    except KeyboardInterrupt:
        print('live video relay stopped', file=sys.stderr)

if __name__ == '__main__': main()
