import importlib.util
import io
import unittest
from unittest.mock import patch
from pathlib import Path
spec = importlib.util.spec_from_file_location('live_producer', Path(__file__).with_name('live_producer.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Response(io.BytesIO):
    pass

class PlaylistTests(unittest.TestCase):
    def test_master_and_media(self):
        responses = [Response(b'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10\nmedia.m3u8\n'), Response(b'#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:3\n#EXTINF:4,\na.ts\n')]
        with patch.object(m.urllib.request, 'urlopen', side_effect=responses):
            self.assertEqual(m.playlist('https://example.com/master.m3u8'), ('https://example.com/media.m3u8', ('#EXT-X-MEDIA-SEQUENCE:3', 'a.ts')))
    def test_vod_rejected(self):
        with patch.object(m.urllib.request, 'urlopen', return_value=Response(b'#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n')):
            with self.assertRaises(ValueError): m.playlist('https://example.com/vod')
    def test_empty_rejected(self):
        with patch.object(m.urllib.request, 'urlopen', return_value=Response(b'#EXTM3U\n')):
            with self.assertRaises(ValueError): m.playlist('https://example.com/empty')

class UploadTests(unittest.TestCase):
    def test_bearer_and_payload(self):
        response = Response(b'')
        response.status = 200
        with patch.dict(m.os.environ, {'SN_LIVE_WRITE_TOKEN': 'test-secret'}), patch.object(m.urllib.request, 'urlopen', return_value=response) as call:
            m.upload('https://example.com/feed', b'{}')
        request = call.call_args.args[0]
        self.assertEqual(request.method, 'PUT')
        self.assertEqual(request.get_header('Authorization'), 'Bearer test-secret')
        self.assertEqual(request.data, b'{}')
    def test_offset_required(self):
        with self.assertRaises(ValueError): m.parse_utc('2026-11-25T23:59:00')
        self.assertEqual(m.parse_utc('2026-11-25T23:59:00+09:00'), m.parse_utc('2026-11-25T14:59:00Z'))

if __name__ == '__main__': unittest.main()
