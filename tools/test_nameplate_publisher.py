import base64
import datetime as dt
import json
import os
import tempfile
from types import SimpleNamespace
from urllib.error import HTTPError
import unittest
from pathlib import Path
from unittest.mock import patch
import nameplate_publisher as p


class NameplatePublisherTests(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime.now(dt.timezone.utc)
        self.end = self.now + dt.timedelta(hours=1)
        self.meeting = {
            'id': '2853', 'provider': 'hls',
            'scheduledAt': (self.now-dt.timedelta(hours=1)).isoformat(),
            'endsAt': (self.now+dt.timedelta(hours=2)).isoformat(),
            'officialPage': 'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=2853',
            'playlist': 'https://cast.sncouncil.go.kr:4443/live/ch2.sdp/playlist.m3u8',
            'members': ['김옥수', '정연화']}
        self.manifest = {'date': self.now.astimezone().date().isoformat(), 'meetings':[self.meeting]}

    def test_catalog_enforces_today_source_and_roster(self):
        self.assertEqual(p.validate_meeting(self.manifest, '2853', self.end, self.now), self.meeting)
        for field, value in [('playlist', 'https://evil.example/live/ch2.sdp/playlist.m3u8'),
                             ('officialPage', 'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=9999'),
                             ('members', ['김옥수', '김옥수'])]:
            changed = dict(self.meeting, **{field:value})
            with self.subTest(field=field), self.assertRaises(ValueError):
                p.validate_meeting(dict(self.manifest, meetings=[changed]), '2853', self.end, self.now)
        with self.assertRaises(ValueError):
            p.validate_meeting(dict(self.manifest, date='2000-01-01'), '2853', self.end, self.now)
        with self.assertRaises(ValueError):
            p.validate_meeting(self.manifest, '2853', self.now+dt.timedelta(hours=3), self.now)

    def test_frame_cleanup_and_allowlisted_matches(self):
        for returned, ok in [([], True), (['김옥수','정연화'], True), (['다른사람'], False), (['김옥수','김옥수'], False)]:
            with self.subTest(returned=returned), tempfile.TemporaryDirectory() as directory:
                class Result:
                    stdout = json.dumps({'matchedMembers':returned}, ensure_ascii=False).encode('utf8')
                with patch.object(p, 'HOME', Path(directory)), patch.object(p.subprocess, 'run', return_value=Result()):
                    if ok:
                        self.assertEqual(p.capture_and_ocr(self.meeting, self.end)['matchedMembers'], returned)
                    else:
                        with self.assertRaises(ValueError):
                            p.capture_and_ocr(self.meeting, self.end)
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_signed_payload_uses_exact_bytes_and_fixed_origin(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives import serialization
        key = Ed25519PrivateKey.generate()
        captured = {}
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): return b'{}'
        class Opener:
            def open(self, request, timeout):
                captured['request'] = request
                captured['timeout'] = timeout
                return Response()
        with tempfile.TemporaryDirectory() as directory:
            key_path = Path(directory) / 'test-key.pem'
            key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                   serialization.NoEncryption()))
            with patch.object(p.urllib.request, 'build_opener', return_value=Opener()):
                p.signed_put('2853', {'capturedAt':'2026-11-25T07:00:00.000Z','matchedMembers':['김옥수']}, key_path)
        req = captured['request']
        self.assertEqual(req.full_url, 'https://'+p.PUBLIC_HOST+'/api/live/nameplates?meetingId=2853')
        self.assertEqual(req.get_method(), 'PUT')
        payload = json.loads(req.data)
        self.assertEqual(payload['observations'][0]['matchedMembers'], ['김옥수'])
        signature = req.get_header('X-council-signature')
        key.public_key().verify(base64.urlsafe_b64decode(signature + '=' * (-len(signature) % 4)), req.data)
        self.assertEqual(captured['timeout'], 15)

    def test_backoff_and_unauthorized_failure(self):
        args = SimpleNamespace(meeting_id='2853', dry_run=False, once=False, interval=60)
        observation = {'capturedAt':p.utc_now(),'matchedMembers':[]}
        waits = []
        def sleep(seconds):
            waits.append(seconds)
            if len(waits) == 3:
                raise StopIteration()
        err = HTTPError('https://example.org', 503, 'temporary', {}, None)
        with patch.object(p, 'capture_and_ocr', return_value=observation), \
             patch.object(p, 'signed_put', side_effect=err), \
             patch.object(p.time, 'monotonic', return_value=0), \
             patch.object(p.time, 'sleep', side_effect=sleep):
            with self.assertRaises(StopIteration):
                p.run_loop(args, self.meeting, self.end)
        self.assertEqual(waits, [60, 120, 240])
        unauthorized = HTTPError('https://example.org', 401, 'bad signature', {}, None)
        with patch.object(p, 'capture_and_ocr', return_value=observation), \
             patch.object(p, 'signed_put', side_effect=unauthorized), \
             patch.object(p.time, 'sleep') as wait:
            with self.assertRaises(HTTPError):
                p.run_loop(args, self.meeting, self.end)
            wait.assert_not_called()
        args.once = True
        with patch.object(p, 'capture_and_ocr', side_effect=TimeoutError()), \
             patch.object(p.time, 'sleep') as wait:
            with self.assertRaises(TimeoutError):
                p.run_loop(args, self.meeting, self.end)
            wait.assert_not_called()
    def test_conflict_retries_same_observation_without_new_capture(self):
        args = SimpleNamespace(meeting_id='2853', dry_run=False, once=False, interval=60)
        observation = {'capturedAt':p.utc_now(),'matchedMembers':['김옥수']}
        conflict = HTTPError('https://example.org', 409, 'conflict', {}, None)
        waits = []
        def sleep(seconds):
            waits.append(seconds)
            if len(waits) == 2:
                raise StopIteration()
        with patch.object(p, 'capture_and_ocr', return_value=observation) as capture, \
             patch.object(p, 'signed_put', side_effect=[conflict, None]) as send, \
             patch.object(p.time, 'monotonic', return_value=0), \
             patch.object(p.time, 'sleep', side_effect=sleep):
            with self.assertRaises(StopIteration):
                p.run_loop(args, self.meeting, self.end)
        self.assertEqual(capture.call_count, 1)
        self.assertEqual(send.call_count, 2)
        self.assertEqual(send.call_args_list[0].args[1], observation)
        self.assertEqual(send.call_args_list[1].args[1], observation)
        self.assertEqual(waits, [60, 60])
        for code in (400, 401, 403):
            with self.subTest(code=code), \
                 patch.object(p, 'capture_and_ocr', return_value=observation), \
                 patch.object(p, 'signed_put', side_effect=HTTPError('https://example.org', code, 'error', {}, None)), \
                 patch.object(p.time, 'sleep') as wait:
                with self.assertRaises(HTTPError):
                    p.run_loop(args, self.meeting, self.end)
                wait.assert_not_called()
    def test_stale_pending_is_discarded_and_fresh_sample_is_sent(self):
        args = SimpleNamespace(meeting_id='2853', dry_run=False, once=False, interval=60)
        old = {'capturedAt':p.utc_now(),'matchedMembers':['김옥수']}
        fresh = {'capturedAt':p.utc_now(),'matchedMembers':['정연화']}
        self.assertFalse(p.pending_expired(old, dt.datetime.fromisoformat(old['capturedAt'].replace('Z','+00:00')) + dt.timedelta(seconds=569)))
        self.assertTrue(p.pending_expired(old, dt.datetime.fromisoformat(old['capturedAt'].replace('Z','+00:00')) + dt.timedelta(seconds=570)))
        conflict = HTTPError('https://example.org', 409, 'conflict', {}, None)
        waits = []
        def sleep(seconds):
            waits.append(seconds)
            if len(waits) == 2:
                raise StopIteration()
        with patch.object(p, 'capture_and_ocr', side_effect=[old, fresh]) as capture, \
             patch.object(p, 'pending_expired', return_value=True), \
             patch.object(p, 'signed_put', side_effect=[conflict, None]) as send, \
             patch.object(p.time, 'monotonic', return_value=0), \
             patch.object(p.time, 'sleep', side_effect=sleep):
            with self.assertRaises(StopIteration):
                p.run_loop(args, self.meeting, self.end)
        self.assertEqual(capture.call_count, 2)
        self.assertEqual(send.call_args_list[0].args[1], old)
        self.assertEqual(send.call_args_list[1].args[1], fresh)
    def test_deadline_prevents_starting_new_subprocess(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(p, 'HOME', Path(directory)):
            with patch.object(p.subprocess, 'run') as run:
                with self.assertRaises(p.DeadlineExpired):
                    p.capture_and_ocr(self.meeting, self.now-dt.timedelta(seconds=1))
                run.assert_not_called()
            self.assertEqual(list(Path(directory).iterdir()), [])
            with patch.object(p.subprocess, 'run') as run, \
                 patch.object(p, 'deadline_timeout', side_effect=[1, p.DeadlineExpired()]):
                with self.assertRaises(p.DeadlineExpired):
                    p.capture_and_ocr(self.meeting, self.end)
                self.assertEqual(run.call_count, 1)
            self.assertEqual(list(Path(directory).iterdir()), [])
    @unittest.skipUnless(os.name == 'nt', 'Windows OCR integration test')
    def test_windows_ocr_unions_two_lower_nameplates(self):
        # Two synthetic names in the exact left/right screen regions. Full-frame
        # OCR can miss one; the crop union must retain both and never nominate one.
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / 'two.png'
            quoted = str(image).replace("'", "''")
            tiny = Path(directory) / 'tiny.png'
            tiny_quoted = str(tiny).replace("'", "''")
            script = f"""
Add-Type -AssemblyName System.Drawing
$b=[Drawing.Bitmap]::new(1280,720)
$g=[Drawing.Graphics]::FromImage($b)
$g.Clear([Drawing.Color]::White)
$f=[Drawing.Font]::new('맑은 고딕',24)
$g.DrawString('서은경',$f,[Drawing.Brushes]::Black,80,550)
$g.DrawString('김옥수',$f,[Drawing.Brushes]::Black,1020,550)
$b.Save('{quoted}',[Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $f.Dispose(); $b.Dispose()
$b=[Drawing.Bitmap]::new(5,5)
$g=[Drawing.Graphics]::FromImage($b)
$g.Clear([Drawing.Color]::White)
$b.Save('{tiny_quoted}',[Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $b.Dispose()
"""
            encoded = base64.b64encode(script.encode('utf-16le')).decode('ascii')
            p.subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',encoded],
                             check=True, capture_output=True, timeout=20)
            roster = ['서은경','김옥수','정연화']
            roster_arg = base64.b64encode(json.dumps(roster, ensure_ascii=False).encode('utf8')).decode('ascii')
            result = p.subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-File',str(p.OCR),
                                       '-ImagePath',str(image),'-MembersBase64',roster_arg,
                                       '-VideoUrl','https://example.org/synthetic',
                                       '-CapturedAt','2026-11-25T16:30:54+09:00'],
                                      check=True, capture_output=True, timeout=20)
            output = json.loads(result.stdout.decode('utf-8-sig'))
            self.assertEqual(set(output['matchedMembers']), {'서은경','김옥수'})
            self.assertIsNone(output['candidate'])
            self.assertEqual(output['status'], 'abstain')
            tiny_result = p.subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-File',str(p.OCR),
                                            '-ImagePath',str(tiny),'-MembersBase64',roster_arg,
                                            '-VideoUrl','https://example.org/synthetic',
                                            '-CapturedAt','2026-11-25T16:30:54+09:00'],
                                           check=True, capture_output=True, timeout=20)
            tiny_output = json.loads(tiny_result.stdout.decode('utf-8-sig'))
            self.assertEqual(tiny_output['matchedMembers'], [])
            self.assertEqual(tiny_output['status'], 'abstain')
            self.assertIn(b'too small', tiny_result.stderr)
    def test_meeting_lock_is_exclusive(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(p, 'HOME', Path(directory)):
            with p.meeting_lock('2853'):
                with self.assertRaises(RuntimeError):
                    with p.meeting_lock('2853'):
                        pass
            with p.meeting_lock('2853'):
                pass


if __name__ == '__main__':
    unittest.main()
