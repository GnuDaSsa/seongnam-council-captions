"""Recover saved public caption snapshots into the minutes history after a release.

Reads only specified captured snapshots, validates the meeting, and signs bounded
batches using the same operator key as the live publisher. Does not modify live cues.
"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlencode, urlsplit
import urllib.request
import base64
from cryptography.hazmat.primitives import serialization
from shared_stt import KEY, utc_now


def restore(site, meeting, path, gap_file=None):
    parsed = urlsplit(site)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise ValueError('Use the HTTPS site origin')
    cues = {}
    with path.open(encoding='utf-8-sig') as stream:
        for line in stream:
            record = json.loads(line)
            if record['meetingId'] != meeting:
                raise ValueError('Recorded meeting ID mismatch')
            for cue in record['cues']:
                cues[cue['id']] = cue
    ordered = sorted(cues.values(), key=lambda c: (c['start'], c['end'], c['id']))
    gaps = json.loads(gap_file.read_text(encoding='utf-8-sig')) if gap_file else []
    private = serialization.load_pem_private_key(KEY.read_bytes(), password=None)
    url = site.rstrip('/') + '/api/live/minutes/recover?' + urlencode({'meetingId': meeting})
    for offset in range(0, max(1, len(ordered)), 25):
        data = dict(purpose='restore-captured-cues', meetingId=meeting, updatedAt=utc_now(),
                    status='interrupted', cues=ordered[offset:offset+25], gaps=gaps if offset == 0 else [])
        body = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()
        signature = base64.urlsafe_b64encode(private.sign(body)).decode().rstrip('=')
        headers = {'Content-Type':'application/json', 'User-Agent':'SeongnamCouncilMinutesArchive/1.0', 'X-Council-Signature':signature}
        with urllib.request.urlopen(urllib.request.Request(url, body, headers, method='PUT'), timeout=20) as response:
            if response.status != 204:
                raise ValueError('Archive did not acknowledge this batch')
    print(meeting, 'restored', len(ordered), 'captured cues')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', required=True)
    parser.add_argument('--meeting-id', required=True)
    parser.add_argument('--snapshots', type=Path, required=True, help='JSON lines with meetingId and cues')
    parser.add_argument('--gaps', type=Path)
    args = parser.parse_args()
    restore(args.site, args.meeting_id, args.snapshots, args.gaps)
