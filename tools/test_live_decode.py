import unittest
from types import SimpleNamespace
from unittest.mock import patch

import shared_stt as stt


def segment(text, start, end):
    return SimpleNamespace(text=text, start=start, end=end, avg_logprob=-0.3,
                           no_speech_prob=0.1, compression_ratio=1.2)


class LiveDecodeTests(unittest.TestCase):
    def test_clean_audio_uses_one_pass(self):
        good = [segment('자료를 제출했습니다.', 0, 3)]
        with patch.object(stt, 'transcribe_audio', return_value=good) as decode:
            self.assertIs(stt.transcribe_live('model', 'audio'), good)
            self.assertEqual(decode.call_count, 1)

    def test_retry_uses_same_audio_and_preserves_other_speech(self):
        first = [segment('이 자료는 지난달 것입니다.', 0, 4), segment('그러니까요 ' * 20, 5, 9)]
        good = [segment('이 자료는 지난달 것입니다.', 0, 4), segment('다시 제출해 주세요.', 5, 9)]
        for second, expected in [(good, good), ([], first), (first, first), ([good[1]], first)]:
            with self.subTest(second=second), patch.object(stt, 'transcribe_audio', side_effect=[first, second]) as decode:
                self.assertIs(stt.transcribe_live('model', 'audio', 'previous', 'agenda'), expected)
                self.assertEqual(decode.call_args.args, ('model', 'audio', 'previous', 'agenda'))
                self.assertEqual(decode.call_args.kwargs, {'beam_size': 5})
