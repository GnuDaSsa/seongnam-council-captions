import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

import numpy as np

from live_acoustic import CAM_POLICY_ID, LiveAcoustic, POLICY_ID, SHORT_POLICY_ID, load_extractor
from shared_stt import cue_batch


MEETING = {
    'id': '2853',
    'members': ['조우현', '안광환'],
    'staffRoster': [{
        'name': '유성희', 'role': '환경정책과장',
        'source': 'https://www.sncouncil.go.kr/record/recordView.do?key=abc123',
    }],
}
INTRO = '조우현 의원입니다. 올해 환경 정책에 대해 말씀드리겠습니다.'
SPEECH = '이번 추가경정예산에서 환경 사업의 진행 상황을 설명하겠습니다.'


class FakeExtractor:
    def __init__(self):
        self.amplitudes = []

    def embed(self, samples):
        amplitude = round(float(np.std(samples)) * 2**0.5, 1)
        self.amplitudes.append(amplitude)
        return [1, 0] if amplitude < 0.15 else [0, 1]


def samples(seconds, amplitude=0.1):
    time = np.arange(round(seconds * 16000)) / 16000
    return np.round(amplitude * 32768 * np.sin(2 * np.pi * 200 * time)).astype('<i2').tobytes()


def segment(text, start, end, log_probability=-0.25):
    return SimpleNamespace(text=text, start=start, end=end, avg_logprob=log_probability,
                           no_speech_prob=0.1, compression_ratio=1.0)


def batch(segments, pcm, *, acoustic=None, start=0, first_id=5):
    return cue_batch(segments, start, len(pcm) / 32000, 1700000000, first_id,
                     acoustic=acoustic, pcm=pcm)


class LiveAcousticTests(unittest.TestCase):
    def setUp(self):
        self.encoder = FakeExtractor()
        self.acoustic = LiveAcoustic(MEETING, self.encoder)

    def test_real_batch_emits_only_cue_ids_for_exact_pcm_and_accepted_chain(self):
        # A different voice exists outside the ASR cue; the anchor must see
        # precisely its own decoded samples, including past the chunk origin.
        rows, counter, errors = batch([
            segment(SPEECH, 4.5, 8.5), segment(INTRO, 0.5, 4.5),
        ], samples(0.5, 0.2) + samples(8), acoustic=self.acoustic)
        self.assertEqual((counter, errors), (7, {}))
        anchor = rows[0]['audioAnchor']
        self.assertRegex(anchor['sessionId'], '^[a-f0-9]{32}$')
        self.assertEqual(anchor, {'sessionId': anchor['sessionId'], 'policy': POLICY_ID})
        self.assertEqual(rows[1]['audioContinuation'], {**anchor, 'anchorId': '6', 'previousId': '6'})
        later, _, _ = batch([segment(SPEECH, 0, 4)], samples(4), acoustic=self.acoustic,
                            start=8.5, first_id=counter)
        self.assertEqual(later[0]['audioContinuation'], {**anchor, 'anchorId': '6', 'previousId': '7'})
        self.assertEqual(self.encoder.amplitudes, [0.1] * 6)
        self.assertFalse(any('speaker' in row or 'embedding' in json.dumps(row) for row in rows + later))

    def test_default_path_omits_acoustic_fields_even_with_audio(self):
        rows, _, _ = batch([segment(INTRO, 0, 4), segment(SPEECH, 4, 8)], samples(8))
        self.assertEqual([set(row) for row in rows],
                         [{'id', 'start', 'end', 'observedAt', 'rawText', 'text', 'flags'}] * 2)

    def test_starts_only_at_current_roster_self_introduction(self):
        for text in [
            '조우현 의원님 질문해 주시기 바랍니다.',
            '그분이 조우현 의원입니다. 관련 자료를 제출해 주세요.',
            '조우현 의원입니다라고 말씀하셨습니다.',
            '“조우현 의원입니다.” 발언자가 이렇게 소개했습니다.',
            '홍길동 의원입니다. 오늘 의견을 먼저 말씀드리겠습니다.',
            '조우현 의원입니다. 안광환 의원입니다.',
            '행정지원과장 유성희입니다. 이번 안건을 말씀드리겠습니다.',
        ]:
            with self.subTest(text=text):
                self.acoustic.reset()
                rows, _, _ = batch([segment(text, 0, 4), segment(SPEECH, 4, 8)], samples(8), acoustic=self.acoustic)
                self.assertFalse(any('audioAnchor' in row or 'audioContinuation' in row for row in rows))
        self.assertEqual(self.encoder.amplitudes, [])
        rows, _, _ = batch([
            segment('안녕하십니까. 환경정책과장 유성희입니다.', 0, 4),
            segment(SPEECH, 4, 8),
        ], samples(8), acoustic=LiveAcoustic(MEETING, self.encoder))
        self.assertIn('audioAnchor', rows[0])
        self.assertIn('audioContinuation', rows[1])

    def test_a_director_reading_colleagues_cannot_enroll_their_voice(self):
        rows, _, _ = batch([
            segment('환경보건국 소속 간부 공무원을 소개해 드리겠습니다.', 0, 4),
            segment('유성희 환경정책과장입니다.', 4, 8),
            segment('환경정책과장 유성희입니다.', 8, 12),
            segment(SPEECH, 12, 16),
        ], samples(16), acoustic=self.acoustic)
        self.assertFalse(any('audioAnchor' in c or 'audioContinuation' in c for c in rows))
        self.assertEqual(self.encoder.amplitudes, [])
        rows, _, _ = batch([segment('안녕하십니까. 환경정책과장 유성희입니다.', 0, 4)],
                           samples(4), acoustic=self.acoustic, start=16, first_id=20)
        self.assertIn('audioAnchor', rows[0])

    def test_announced_staff_with_asr_boundary_noise_cannot_enroll_a_listed_name(self):
        announcement = '간부 공무원을 위원님들께 소개해 드리도록 하겠습니다'
        for parts in [
            [segment(announcement, 0, 4), segment('유성희 환경정책과장입니다.', 3.97, 8)],
            [segment(announcement + ' 유성희 환경정책과장입니다.', 0, 4),
             segment('환경정책과장 유성희입니다.', 4, 8)],
            [segment(announcement, 0, 4), segment('안녕하십니까 환경정책과장', 4, 8),
             segment('유성희입니다.', 8, 12), segment('유성희 환경정책과장입니다.', 12, 16)],
        ]:
            with self.subTest(parts=parts):
                acoustic = LiveAcoustic(MEETING, self.encoder)
                rows, _, _ = batch(parts, samples(16), acoustic=acoustic)
                self.assertFalse(any('audioAnchor' in c or 'audioContinuation' in c for c in rows))

    def test_duplicate_roster_name_cannot_seed(self):
        ambiguous = {**MEETING, 'staffRoster': MEETING['staffRoster'] * 2}
        rows, _, _ = batch([segment('환경정책과장 유성희입니다.', 0, 4)], samples(4),
                           acoustic=LiveAcoustic(ambiguous, self.encoder))
        self.assertNotIn('audioAnchor', rows[0])

    def test_literal_geographic_introduction_and_retained_raw_text(self):
        meeting = {**MEETING, 'members': ['고병용', '조우현']}
        for introduction in [
            '상대원 1지 3등을 지역구로 하는 무소속 고병용 의원입니다.',
            '안녕하십니까. 저는 성남시 중원구 상대원2동을 지역구로 둔 고병용 의원입니다.',
            '삼평동, 백현동을 지역구로 하는 더불어 민주당 고병용 위원입니다.',
            '저는 서현1동과 서현2동을 지역구로 둔 고병용 의원입니다.',
            '중앙동 및 분당동을 지역구로 하는 국민의 힘 고병용 의원입니다.',
        ]:
            with self.subTest(text=introduction):
                rows, _, _ = batch([segment(introduction, 0, 4), segment(SPEECH, 4, 8)],
                                   samples(8), acoustic=LiveAcoustic(meeting, self.encoder))
                self.assertEqual(rows[0]['rawText'], introduction)
                self.assertIn('audioAnchor', rows[0])
                self.assertEqual(rows[1]['audioContinuation']['anchorId'], rows[0]['id'])

    def test_district_pattern_rejects_ambiguous_geography_quotes_and_roster(self):
        meeting = {**MEETING, 'members': ['고병용', '조우현']}
        literal = '상대원 1지 3등을 지역구로 하는 무소속 고병용 의원입니다.'
        for text in [
            literal.replace('상대원', '아무개'),
            literal.replace('상대원 1지 3등', '상대원 4동'),
            literal.replace('상대원 1지 3등', '상대원 1지'),
            literal.replace('상대원 1지 3등', '상대원 1동 3등'),
            literal.replace('상대원 1지 3등', '중앙동, 분당동, 삼평동, 백현동'),
            literal.replace('상대원 1지 3등을', '공동체와 협동을'),
            literal.replace('무소속', '정체불명의 당'),
            literal.replace('무소속', '상대 정당을 비판하는 무소속'),
            literal.replace('고병용', '조우현 의원을 부르고 고병용'),
            literal.replace('고병용', '홍길동'),
            '김주현 의원이 소개한 ' + literal,
            '이 자리에 계신 분은 ' + literal,
            '“' + literal + '”',
            literal + ' 조우현 의원입니다.',
            literal + ' 다음 안건을 소개하겠습니다.',
        ]:
            with self.subTest(text=text):
                rows, _, _ = batch([segment(text, 0, 4)], samples(4),
                                   acoustic=LiveAcoustic(meeting, self.encoder))
                self.assertNotIn('audioAnchor', rows[0])
        for collision in [{**meeting, 'members': ['고병용', '고병용']},
                          {**meeting, 'staffRoster': [{'name':'고병용', 'role':'국장'}]}]:
            rows, _, _ = batch([segment(literal, 0, 4)], samples(4),
                               acoustic=LiveAcoustic(collision, self.encoder))
            self.assertNotIn('audioAnchor', rows[0])

    def test_prior_staff_needs_the_spoken_name_office_and_same_committee(self):
        row = {
            'name': '류예지', 'role': '의회운영위원회 담당', 'officialRole': '주무관',
            'roleBasis': 'recorded-self-introduction', 'basis': 'official-recorded-committee-contact',
            'committee': '의회운영위원회', 'candidateOnly': True,
            'source': 'https://www.sncouncil.go.kr/record/recordView.do?key=abc123',
        }
        meeting = {'id': '5480', 'title': '제313회 제1차 의회운영위원회', 'members': [], 'staffRoster': [row]}
        intro = '안녕하십니까 의회 운영위원회 담당 류예지입니다.'
        for current, words, duration, expected in [
            (meeting, intro, 4.1, True),
            ({**meeting, 'title': '도시건설위원회'}, intro, 4.1, False),
            ({**meeting, 'members': ['류예지']}, intro, 4.1, False),
            ({**meeting, 'staffRoster': [row, row]}, intro, 4.1, False),
            (meeting, '위원장께서 “' + intro + '”라고 하셨습니다.', 4.1, False),
            (meeting, intro, 18, False),
            (meeting, intro.replace('류예지', '류예진'), 4.1, False),
        ]:
            with self.subTest(title=current['title'], words=words, duration=duration, expected=expected):
                cues, _, _ = batch([segment(words, 0, duration)], samples(duration),
                                   acoustic=LiveAcoustic(current, self.encoder))
                self.assertEqual('audioAnchor' in cues[0], expected)

    def test_unresolved_geographic_intro_ends_a_different_incumbent_chain(self):
        meeting = {**MEETING, 'members': ['고병용', '고병용', '조우현']}
        disputed = '상대원 1지 3등을 지역구로 하는 무소속 고병용 의원입니다.'
        rows, _, _ = batch([segment(INTRO, 0, 4), segment(disputed, 4, 8),
                             segment(SPEECH, 8, 12)], samples(12),
                            acoustic=LiveAcoustic(meeting,self.encoder))
        self.assertIn('audioAnchor', rows[0])
        self.assertTrue(all('audioContinuation' not in cue for cue in rows[1:]))

    def test_literal_ascii_roster_title_and_unapproved_model(self):
        executive = {**MEETING, 'staffRoster': [{
            **MEETING['staffRoster'][0], 'name': '차광승', 'role': 'AI혁신국장',
        }]}
        rows, _, _ = batch([segment('안녕하십니까 AI 혁신국장 차광승입니다.', 0, 4)], samples(4),
                           acoustic=LiveAcoustic(executive, self.encoder))
        self.assertIn('audioAnchor', rows[0])
        with tempfile.TemporaryDirectory() as directory:
            alternate = Path(directory) / 'wrong.onnx'
            alternate.write_bytes(b'not the profiled model')
            with self.assertRaisesRegex(ValueError, 'does not match'):
                load_extractor(alternate)

    def test_discontinuity_and_invalid_intervals_end_the_proof_chain(self):
        initial, _, _ = batch([segment(INTRO, 0, 4)], samples(4), acoustic=self.acoustic)
        rows, counter, _ = batch([segment(SPEECH, 0, 4), segment(INTRO, 4, 8)], samples(8),
                                 acoustic=self.acoustic, start=5, first_id=6)
        self.assertNotIn('audioContinuation', rows[0])
        self.assertNotEqual(initial[0]['audioAnchor']['sessionId'], rows[1]['audioAnchor']['sessionId'])
        review, counter, reasons = batch([segment('시각을 검토할 구간', 2, 2)], samples(4),
                                         acoustic=self.acoustic, start=13, first_id=counter)
        self.assertEqual(reasons, {'non_positive_interval': 1})
        self.assertIn('segment_review', review[0]['flags'])
        after, _, _ = batch([segment(SPEECH, 0, 4)], samples(4),
                            acoustic=self.acoustic, start=17, first_id=counter)
        self.assertNotIn('audioContinuation', after[0])

    def test_uncertainty_non_substance_short_and_mixed_audio_abstain(self):
        cases = [
            (segment(SPEECH, 4, 8, log_probability=-1.4), samples(4)),
            (segment('네, 맞습니다.', 4, 8), samples(4)),
            (segment(SPEECH, 4, 5), samples(1)),
            (segment(SPEECH, 4, 8), samples(2) + samples(2, 0.2)),
        ]
        for item, audio in cases:
            with self.subTest(text=item.text, duration=item.end - item.start):
                self.acoustic.reset()
                following = segment(SPEECH, item.end, item.end + 4)
                rows, _, _ = batch([segment(INTRO, 0, 4), item, following],
                                   samples(4) + audio + samples(4), acoustic=self.acoustic)
                self.assertIn('audioAnchor', rows[0])
                self.assertFalse(any('audioContinuation' in row for row in rows[1:]))
        short, _, _ = batch([segment(INTRO, 0, 2)], samples(2), acoustic=LiveAcoustic(MEETING, self.encoder))
        self.assertNotIn('audioAnchor', short[0])

    def test_optional_extractor_error_keeps_text_and_disables_evidence(self):
        class BadExtractor:
            def embed(self, _pcm):
                raise RuntimeError('failure in the optional backend')

        broken = LiveAcoustic(MEETING, BadExtractor())
        rows, _, _ = batch([segment(INTRO, 0, 4)], samples(4), acoustic=broken)
        self.assertTrue(broken.disabled)
        self.assertEqual(rows[0]['text'], INTRO)
        self.assertNotIn('audioAnchor', rows[0])

    def test_short_opt_in_requires_distinct_windows_and_substantive_successor(self):
        continuation = '여기 사진 한 장이 있습니다.'
        for profile, anticipated in [(POLICY_ID, False), (SHORT_POLICY_ID, True)]:
            with self.subTest(profile=profile):
                rows, _, _ = batch([segment('안녕하십니까. 조우현 의원입니다.', 0, 2.6),
                                     segment(continuation, 2.6, 5.2)], samples(5.2),
                                    acoustic=LiveAcoustic(MEETING, self.encoder, profile=profile))
                self.assertEqual('audioAnchor' in rows[0], anticipated)
                self.assertEqual('audioContinuation' in rows[1], anticipated)
                if anticipated:
                    self.assertEqual(rows[1]['audioContinuation']['policy'], SHORT_POLICY_ID)
        for sound, text in [
            (samples(2.6, 0.2), continuation),
            (samples(1.3, 0.2) + samples(1.3), continuation),
            (samples(2.6), '네, 알겠습니다. 그렇게 다시 말하겠습니다.'),
        ]:
            rows, _, _ = batch([segment('안녕하십니까. 조우현 의원입니다.', 0, 2.6), segment(text, 2.6, 5.2)],
                                samples(2.6) + sound,
                                acoustic=LiveAcoustic(MEETING, self.encoder, profile=SHORT_POLICY_ID))
            self.assertIn('audioAnchor', rows[0])
            self.assertNotIn('audioContinuation', rows[1])

    def test_cam_profile_requires_anchor_windows_to_support_reverse_comparison(self):
        class UnevenExtractor:
            def embed(self, wav):
                amplitude = round(float(np.std(wav)) * 2**0.5, 1)
                return [1, 0] if amplitude < 0.15 else [0.471, 0.8821]

        first = samples(2.0) + samples(2.0, 0.2)
        next_pcm = samples(4.0)
        rows, _, _ = batch([segment(INTRO, 0, 4), segment(SPEECH, 4, 8)], first + next_pcm,
                            acoustic=LiveAcoustic(MEETING, UnevenExtractor(), profile=CAM_POLICY_ID))
        self.assertEqual(rows[0]['audioAnchor']['policy'], CAM_POLICY_ID)
        self.assertNotIn('audioContinuation', rows[1])

    def test_cam_profile_distinct_model_does_not_share_legacy_profile_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory) / 'other-model.onnx'
            model.write_bytes(b'not the pinned CAM++ profile')
            with self.assertRaisesRegex(ValueError, 'does not match'):
                load_extractor(model, CAM_POLICY_ID)


if __name__ == '__main__':
    unittest.main()
