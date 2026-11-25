import base64
import io
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

import shared_stt as stt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


class Response:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, limit): return b''


class ProducerTests(unittest.TestCase):
    def test_flags_korean(self):
        self.assertEqual(set(stt.cue_flags('장일남 의원은 2명 출석으로 표결했습니다')), {'name', 'number', 'proceeding'})
        self.assertEqual(stt.cue_flags('안녕하세요'), [])

    def test_signed_raw_json(self):
        key = Ed25519PrivateKey.generate()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'key.pem'
            path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            with patch('urllib.request.urlopen', return_value=Response()) as mock:
                stt.signed_put('https://example.com/api/live/captions?meetingId=2853', {'text': '안건'}, path)
                request = mock.call_args.args[0]
                signature = request.get_header('X-council-signature')
                key.public_key().verify(base64.urlsafe_b64decode(signature + '=' * (-len(signature) % 4)), request.data)

    def test_silence_splits_after_five_seconds(self):
        frames = list(stt.audio_chunks(io.BytesIO(bytes(16000 * 2 * 7)).read))
        self.assertEqual([offset for offset, _ in frames], [0, 5])

    def test_repetition_and_low_confidence_preserve_raw(self):
        for raw in ('그러니까요 ' * 41, '이 제품은 ' * 80):
            segment = SimpleNamespace(text=raw, avg_logprob=-0.2, no_speech_prob=0.1)
            original, visible, flags = stt.quality_decision(segment)
            self.assertEqual(original, raw.strip())
            self.assertEqual(visible, '[음성 재확인]')
            self.assertIn('repetition', flags)
        original, visible, flags = stt.quality_decision(SimpleNamespace(text='다시 말씀드립니다 다시 말씀드립니다', avg_logprob=-0.2, no_speech_prob=0.1))
        self.assertEqual(original, visible)
        self.assertNotIn('repetition', flags)
        _, visible, flags = stt.quality_decision(SimpleNamespace(text='안건입니다', avg_logprob=-1.5, no_speech_prob=0.1))
        self.assertEqual(visible, '안건입니다')
        self.assertIn('low_confidence', flags)
        _, visible, flags = stt.quality_decision(SimpleNamespace(text='불확실한 발언', avg_logprob=-1.5, no_speech_prob=0.8))
        self.assertEqual(visible, '[음성 재확인]')
        self.assertIn('severe_uncertainty', flags)


if __name__ == '__main__': unittest.main()
