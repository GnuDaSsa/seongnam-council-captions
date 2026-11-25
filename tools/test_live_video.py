import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('live_video', Path(__file__).with_name('live_video.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class RelayTests(unittest.TestCase):
    def test_playlist_and_render(self):
        body = b'#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:21\n#EXTINF:5.0,\n21.ts\n#EXTINF:4.5,\n22.ts\n'
        with patch.object(m, 'fetch', return_value=body):
            target, rows = m.parse_playlist('http://example.test/live.m3u8', 'http://example.test/live.m3u8')
        self.assertEqual([r[0] for r in rows], [21, 22])
        output = m.render(target, rows).decode()
        self.assertIn('#EXT-X-MEDIA-SEQUENCE:21\n', output)
        self.assertIn('\n9.ts\n', output)
        self.assertIn('\n10.ts\n', output)
        self.assertNotIn('example.test', output)
    def test_vod_and_cross_host_rejected(self):
        for body in [b'#EXTM3U\n#EXT-X-ENDLIST\n', b'#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:5,\nhttp://evil.test/1.ts\n']:
            with patch.object(m, 'fetch', return_value=body):
                with self.assertRaises(ValueError): m.parse_playlist('http://example.test/a', 'http://example.test/a')
    def test_deadline_offset(self):
        self.assertEqual(m.timestamp('2026-11-25T23:59:00+09:00'), m.timestamp('2026-11-25T14:59:00Z'))

if __name__ == '__main__': unittest.main()
