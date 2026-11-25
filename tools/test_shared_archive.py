import concurrent.futures
import hashlib
import importlib.util
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import urlopen as real_urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT.parent
spec = importlib.util.spec_from_file_location('shared_stt', ROOT / 'tools' / 'shared_stt.py')
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
MEETINGS = {m['id']: m for m in json.loads(shared.MANIFEST.read_text(encoding='utf-8-sig'))['meetings']}
BUILDER = ROOT / 'tools' / 'build_caption_archive.cjs'


def minutes_fixture(meeting_id):
    # A release includes original captures. A clean source checkout still tests overflow of the 100-cue tail.
    for directory in (WORK / 'evidence' / 'captures', WORK / 'field-replay'):
        source = directory / (meeting_id + '.json')
        if source.is_file():
            return json.loads(source.read_text(encoding='utf-8'))['minutes']
    stamp = MEETINGS[meeting_id]['scheduledAt']
    return {'meetingId': meeting_id, 'updatedAt': stamp, 'status': 'interrupted', 'gaps': [],
            'cues': [{'id': f'{meeting_id}-unit-{i}', 'start': i, 'end': i + .75,
                      'text': f'검증 자막 {i}번입니다.', 'flags': [], 'observedAt': stamp}
                     for i in range(104)]}


class Handler(BaseHTTPRequestHandler):
    snapshot = b''
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        if isinstance(self.snapshot, dict):
            self.wfile.write(self.snapshot[self.path.rsplit('/', 1)[-1]])
        else:
            self.wfile.write(self.snapshot)
    def log_message(self, *_):
        pass


class Response:
    def __init__(self, response, requested):
        self.response, self.requested = response, requested
    def __enter__(self): return self
    def __exit__(self, *args): self.response.close()
    def geturl(self): return self.requested
    def read(self, n): return self.response.read(n)


class ArchiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.minutes = minutes_fixture('2852')

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def mock_get(self, request, timeout):
        self.assertEqual(request.full_url, 'https://example.test/api/live/minutes?meetingId=2852')
        return Response(real_urlopen('http://127.0.0.1:%d/minutes' % self.server.server_port, timeout=timeout), request.full_url)

    def test_full_snapshot_and_failure_preserves_previous(self):
        Handler.snapshot = json.dumps(self.minutes, ensure_ascii=False).encode('utf-8')
        with tempfile.TemporaryDirectory() as directory, patch.object(shared.urllib.request, 'urlopen', self.mock_get):
            out = Path(directory)
            shared.archive_finished_meeting('https://example.test', MEETINGS['2852'], out, BUILDER)
            catalog = json.loads((out / 'catalog.json').read_text(encoding='utf-8'))
            self.assertEqual(catalog[0]['cueCount'], len(self.minutes['cues']))
            self.assertGreater(catalog[0]['cueCount'], 100)
            self.assertIsNone(catalog[0]['completionAt'])
            txt = (out / catalog[0]['files']['txt']['name']).read_text(encoding='utf-8')
            self.assertIn(self.minutes['cues'][0]['id'], txt)
            self.assertIn(self.minutes['cues'][-1]['id'], txt)
            with ZipFile(out / catalog[0]['files']['hwpx']['name']) as hwpx:
                self.assertIsNone(hwpx.testzip())
                self.assertIn('Contents/section0.xml', hwpx.namelist())
                contents = hwpx.read('Contents/section0.xml').decode('utf-8')
                self.assertIn(self.minutes['cues'][0]['id'], contents)
                self.assertIn(self.minutes['cues'][-1]['id'], contents)
            before = hashlib.sha256((out / 'catalog.json').read_bytes()).hexdigest()
            Handler.snapshot = json.dumps({**self.minutes, 'cues': []}).encode('utf-8')
            with self.assertRaises(ValueError):
                shared.archive_finished_meeting('https://example.test', MEETINGS['2852'], out, BUILDER)
            self.assertEqual(before, hashlib.sha256((out / 'catalog.json').read_bytes()).hexdigest())
            Handler.snapshot = json.dumps({**self.minutes, 'cues': self.minutes['cues'][-100:]}).encode('utf-8')
            with self.assertRaises(RuntimeError):
                shared.archive_finished_meeting('https://example.test', MEETINGS['2852'], out, BUILDER)
            self.assertEqual(before, hashlib.sha256((out / 'catalog.json').read_bytes()).hexdigest())

    def test_no_unsafe_origin_or_missing_builder(self):
        with self.assertRaises(ValueError): shared.archive_finished_meeting('http://example.test', MEETINGS['2852'], '.', BUILDER)
        with self.assertRaises(ValueError): shared.archive_builder_path(ROOT / 'missing-builder.cjs')
        self.assertEqual(shared.archive_builder_path(), BUILDER)

    def test_retry_does_not_load_model_or_capture(self):
        Handler.snapshot = json.dumps(self.minutes, ensure_ascii=False).encode('utf-8')
        with tempfile.TemporaryDirectory() as directory, patch.object(shared.urllib.request, 'urlopen', self.mock_get), \
                patch.object(shared, 'load_model', side_effect=AssertionError('must not load model')), \
                patch.object(sys, 'argv', ['shared_stt.py', '--endpoint', 'https://example.test', '--meeting-id', '2852',
                                          '--archive-dir', directory, '--archive-retry']):
            shared.main()
            rows = json.loads((Path(directory) / 'catalog.json').read_text(encoding='utf-8'))
            self.assertEqual(rows[0]['cueCount'], len(self.minutes['cues']))

    def test_capture_failure_archives_only_after_new_cues(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = json.loads(shared.MANIFEST.read_text(encoding='utf-8-sig'))
            manifest['date'] = shared.dt.datetime.now(shared.COUNCIL_TZ).date().isoformat()
            fixture = Path(directory) / 'meetings.json'
            fixture.write_text(json.dumps(manifest), encoding='utf-8')
            self.enterContext(patch.object(shared, 'MANIFEST', fixture))
            args = ['shared_stt.py', '--endpoint', 'https://example.test', '--end-at', '2099-01-01T00:00:00Z',
                    '--meeting-id', '2852', '--archive-dir', directory, '--text-only-speakers']
            def failed_capture(*_args, **kwargs):
                kwargs['on_capture_started'](MEETINGS['2852'])
                raise RuntimeError('capture failed')
            with patch.object(shared, 'HOME', Path(directory)), patch.object(shared, 'load_model', return_value=None), \
                    patch.object(shared, 'run', side_effect=failed_capture), \
                    patch.object(shared, 'archive_finished_meeting') as archived, patch.object(sys, 'argv', args):
                with self.assertRaises(SystemExit): shared.main()
                archived.assert_called_once()
            with patch.object(shared, 'HOME', Path(directory)), patch.object(shared, 'load_model', return_value=None), \
                    patch.object(shared, 'run', side_effect=RuntimeError('no captured cues')), \
                    patch.object(shared, 'archive_finished_meeting') as archived, patch.object(sys, 'argv', args):
                with self.assertRaises(SystemExit): shared.main()
                archived.assert_not_called()

    def test_concurrent_meetings_preserve_both(self):
        minutes3 = minutes_fixture('2853')
        Handler.snapshot = {'2852': json.dumps(self.minutes, ensure_ascii=False).encode('utf-8'),
                            '2853': json.dumps(minutes3, ensure_ascii=False).encode('utf-8')}
        def get(request, timeout):
            mid = request.full_url.rsplit('=', 1)[-1]
            self.assertIn(mid, ('2852', '2853'))
            return Response(real_urlopen('http://127.0.0.1:%d/%s' % (self.server.server_port, mid), timeout=timeout), request.full_url)
        with tempfile.TemporaryDirectory() as directory, patch.object(shared.urllib.request, 'urlopen', get):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(shared.archive_finished_meeting, 'https://example.test', MEETINGS[mid], directory, BUILDER)
                           for mid in ('2852', '2853')]
                for future in futures: future.result()
            rows = json.loads((Path(directory) / 'catalog.json').read_text(encoding='utf-8'))
            self.assertEqual({row['id'] for row in rows}, {'2852', '2853'})

if __name__ == '__main__': unittest.main()
