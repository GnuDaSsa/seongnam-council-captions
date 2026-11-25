import base64
import io
import math
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


    @staticmethod
    def segment(text, start, end):
        return SimpleNamespace(text=text, start=start, end=end, avg_logprob=-0.2,
                               no_speech_prob=0.1, compression_ratio=1.0)

    def test_cue_batch_sorts_valid_segments_and_keeps_chunk_smoke_payload(self):
        segments = [self.segment('later', 1.5, 2.0), self.segment('earlier', 0.2, 0.8)]
        batch, counter, reasons = stt.cue_batch(segments, 10.0, 3.0, 100.0, 7)
        self.assertEqual(reasons, {})
        self.assertEqual(counter, 9)
        self.assertEqual([cue['rawText'] for cue in batch], ['earlier', 'later'])
        self.assertEqual([(cue['start'], cue['end']) for cue in batch], [(10.2, 10.8), (11.5, 12.0)])
        self.assertTrue(all(0 <= cue['start'] < cue['end'] <= 13.0 for cue in batch))

    def test_cue_batch_accepts_start_at_rounded_chunk_origin(self):
        for chunk_start in (0.1 + 0.2, 10.0004):
            batch, _, reasons = stt.cue_batch(
                [self.segment('valid', 0.0, 1.0)], chunk_start, 3.0, 100.0, 0)
            self.assertEqual(reasons, {})
            self.assertEqual(len(batch), 1)
            self.assertEqual(batch[0]['rawText'], 'valid')
            self.assertEqual(batch[0]['start'], round(chunk_start, 3))

    def test_invalid_segment_times_become_chunk_review_without_dropping_text(self):
        segments = [
            self.segment('zero duration', 0.5, 0.5),
            self.segment('reversed', 1.5, 1.0),
            self.segment('not finite', math.nan, 1.2),
            self.segment('negative', -0.1, 0.2),
            self.segment('outside chunk', 2.5, 4.2),
            self.segment('valid', 0.2, 0.8),
        ]
        batch, _, reasons = stt.cue_batch(segments, 10.0, 3.0, 100.0, 0)
        self.assertEqual(reasons, {'non_finite_time': 1, 'non_positive_interval': 2,
                                   'outside_source_chunk': 2})
        self.assertEqual([cue['rawText'] for cue in batch if cue['rawText'] == 'valid'], ['valid'])
        review = [cue for cue in batch if 'segment_review' in cue['flags']]
        self.assertEqual(len(review), 1)
        self.assertEqual((review[0]['start'], review[0]['end']), (10.0, 13.0))
        self.assertEqual(set(review[0]['rawText'].splitlines()),
                         {'zero duration', 'reversed', 'not finite', 'negative', 'outside chunk'})
        self.assertEqual(review[0]['text'], review[0]['rawText'])
        self.assertTrue(all(0 <= cue['start'] < cue['end'] <= 86400 for cue in batch))

    def test_minor_end_overrun_is_clamped_and_duplicate_review_is_omitted(self):
        segments = [self.segment('답변입니다.', 1.2, 3.3), self.segment('답변입니다.', 1.2, 4.7)]
        batch, _, reasons = stt.cue_batch(segments, 10.0, 3.0, 100.0, 0)
        self.assertEqual(reasons, {'outside_source_chunk': 1})
        self.assertEqual([(c['start'], c['end'], c['text']) for c in batch], [(11.2, 13.0, '답변입니다.')])
        self.assertNotIn('segment_review', batch[0]['flags'])

    def test_oversized_text_is_split_into_chunk_review_items(self):
        raw = '가' * 4100
        batch, _, reasons = stt.cue_batch([self.segment(raw, 0.2, 0.8)], 10.0, 3.0, 100.0, 0)
        review = [cue for cue in batch if 'segment_review' in cue['flags']]
        self.assertEqual(reasons, {'text_too_long': 1})
        self.assertEqual(''.join(cue['rawText'].replace('\n', '') for cue in review), raw)
        self.assertTrue(all(len(cue['rawText']) <= 2000 and cue['end'] == 13.0 for cue in review))

    def test_chunk_review_preserves_severe_uncertainty_flags_for_raw_comparison(self):
        uncertain = self.segment('불확실 발화', 1.0, 1.0)
        uncertain.avg_logprob = -1.5
        uncertain.no_speech_prob = 0.8
        batch, _, _ = stt.cue_batch([uncertain], 10.0, 3.0, 100.0, 0)
        review = batch[0]
        self.assertIn('segment_review', review['flags'])
        self.assertIn('severe_uncertainty', review['flags'])
        self.assertEqual(review['rawText'], '불확실 발화')
        self.assertNotEqual(review['text'], review['rawText'])


if __name__ == '__main__': unittest.main()
