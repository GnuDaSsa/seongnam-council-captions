import unittest

from live_acoustic import CAM_POLICY_ID, POLICY_ID, LiveAcoustic
from podium_acoustic import PODIUM_POLICY_ID
from test_live_acoustic import FakeExtractor, batch, samples, segment


MEETING = {'id': '5467', 'title': '제312회 임시회 제2차 본회의',
           'members': ['강상태', '박기범', '추선미', '윤혜선']}
CALL = '박기범 의원님 수고하셨습니다. 다음은 추선미 의원님 나오셔서 발언해 주시기 바랍니다.'
INTRO = '안녕하십니까. 추선미 의원입니다.'
CONFIRM = '여기 사진 한 장이 있습니다.'
SPEECH = '지역의 경제와 환경 정책에 대한 제안을 말씀드리겠습니다.'


class Replay:
    def __init__(self, meeting=MEETING, *, enabled=True):
        self.acoustic = LiveAcoustic(meeting, FakeExtractor(), CAM_POLICY_ID, podium_floor=enabled)
        self.time = 0
        self.index = 0

    def feed(self, text, duration=4, amplitude=0.1, *, pcm=None, log_probability=-0.25):
        audio = samples(duration, amplitude) if pcm is None else pcm
        turns = [] if text is None else [segment(text, 0, duration, log_probability)]
        rows, self.index, errors = batch(turns, audio, acoustic=self.acoustic,
                                         start=self.time, first_id=self.index)
        self.time += duration
        if errors:
            raise AssertionError(errors)
        return rows[0] if rows else {}

    def enroll(self):
        return [self.feed(CALL, amplitude=0.2), self.feed(INTRO, duration=2.6),
                self.feed(CONFIRM, duration=2.6)]


class PlenaryFloorTests(unittest.TestCase):
    def test_actual_publisher_entry_does_not_export_names_or_vectors(self):
        replay = Replay()
        call = replay.feed(CALL, amplitude=0.2)
        for seconds in (10, 9):
            replay.feed(None, seconds, 0)
        intro = replay.feed(INTRO, 2.6)
        confirm = replay.feed(CONFIRM, 2.6)
        latest = replay.feed(SPEECH)
        stages = [row['audioPodium'] for row in (call, intro, confirm, latest)]
        common = {'policy': PODIUM_POLICY_ID, 'sessionId': stages[0]['sessionId']}
        self.assertRegex(common['sessionId'], r'^[a-f0-9]{32}$')
        self.assertEqual(stages, [
            {**common, 'stage': 'call'},
            {**common, 'stage': 'intro', 'callId': call['id']},
            {**common, 'stage': 'confirm', 'callId': call['id'], 'anchorId': intro['id']},
            {**common, 'stage': 'match', 'callId': call['id'], 'anchorId': intro['id'],
             'confirmationId': confirm['id']},
        ])
        self.assertIn('audioContinuation', confirm)
        self.assertNotIn('speaker', latest)

    def test_wrong_name_same_audio_and_mixed_intro_clear_pending_call(self):
        for text, audio in [
            ('안녕하십니까. 윤혜선 의원입니다.', samples(2.6)),
            (INTRO, samples(2.6, .2)),
            (INTRO, samples(1.3, .2) + samples(1.3)),
            ('“추선미 의원입니다.” 이렇게 소개했습니다.', samples(2.6)),
        ]:
            with self.subTest(text=text, audio=audio[:20]):
                replay = Replay()
                self.assertIn('audioPodium', replay.feed(CALL, amplitude=.2))
                self.assertNotIn('audioPodium', replay.feed(text, duration=2.6, pcm=audio))
                self.assertNotIn('audioPodium', replay.feed(INTRO, duration=2.6))
                self.assertNotIn('audioPodium', replay.feed(SPEECH))

    def test_none_for_wrong_voice_noisy_windows_or_transfer_until_new_call(self):
        for text, audio, probability in [
            (SPEECH, samples(4, .2), -.25),
            (SPEECH, samples(2, .2) + samples(2), -.25),
            (SPEECH, samples(4), -1.4),
            ('경청해 주셔서 감사합니다.', samples(4), -.25),
            ('잠깐만요. 잠시 제가 설명을 드리겠습니다.', samples(4), -.25),
            ('홍길동 의원입니다. 다른 안건을 설명드리겠습니다.', samples(4), -.25),
        ]:
            with self.subTest(text=text, probability=probability):
                replay = Replay()
                self.assertEqual(replay.enroll()[-1]['audioPodium']['stage'], 'confirm')
                self.assertNotIn('audioPodium', replay.feed(text, pcm=audio, log_probability=probability))
                self.assertNotIn('audioPodium', replay.feed(SPEECH))
                self.assertEqual(replay.enroll()[-1]['audioPodium']['stage'], 'confirm')

    def test_pending_call_only_survives_a_bounded_silent_physical_capture(self):
        for silent, seconds in [(False, 3.02), (True, 65.01)]:
            with self.subTest(silent=silent, seconds=seconds):
                replay = Replay()
                replay.feed(CALL, amplitude=.2)
                replay.feed(None, duration=seconds, amplitude=0 if silent else .2)
                self.assertNotIn('audioPodium', replay.feed(INTRO, duration=2.6))
        replay = Replay()
        replay.feed(CALL, amplitude=.2)
        replay.time += .041
        self.assertNotIn('audioPodium', replay.feed(INTRO, duration=2.6))

    def test_unsupported_fragments_do_not_renew_confirmation_and_floor_is_bounded(self):
        replay = Replay()
        replay.enroll()
        replay.feed(None, duration=8, amplitude=0)
        self.assertNotIn('audioPodium', replay.feed(CONFIRM))
        self.assertEqual(replay.feed(SPEECH)['audioPodium']['stage'], 'match')
        replay.feed(None, duration=11, amplitude=0)
        self.assertNotIn('audioPodium', replay.feed('네.', duration=1.001))
        self.assertNotIn('audioPodium', replay.feed(SPEECH))

        replay = Replay()
        replay.enroll()
        while replay.time < 360:
            self.assertEqual(replay.feed(SPEECH)['audioPodium']['stage'], 'match')
        self.assertNotIn('audioPodium', replay.feed(SPEECH))

    def test_plenary_opt_in_and_unique_roster_and_unmarked_report(self):
        for replay in [Replay(enabled=False), Replay({**MEETING, 'title': '경제환경위원회'}),
                       Replay({**MEETING, 'members': [*MEETING['members'], '추선미']})]:
            with self.subTest(replay=replay):
                self.assertFalse(any('audioPodium' in row for row in replay.enroll()))
        with self.assertRaisesRegex(ValueError, 'CAM'):
            LiveAcoustic(MEETING, FakeExtractor(), POLICY_ID, podium_floor=True)
        for text in ('방금 이런 내용을 들었습니다. ' + CALL,
                     CALL.replace('박기범', '추선미'), CALL.replace('박기범', '홍길동')):
            with self.subTest(text=text):
                self.assertNotIn('audioPodium', Replay().feed(text, amplitude=.2))

    def test_bounded_polite_call_variants_accept_only_the_registered_target(self):
        for text in [
            '그러면 추선미 의원님 나와서 5분 자유 발언해 주시기 바랍니다.',
            CALL.replace('나오셔서', '나와서'),
        ]:
            with self.subTest(text=text):
                self.assertEqual(Replay().feed(text, amplitude=.2)['audioPodium']['stage'], 'call')
        for text in [
            '방금 기록에는 다음은 추선미 의원님 나와서 발언해 주시기 바랍니다.',
            '그러면 홍길동 의원님 나와서 발언해 주시기 바랍니다.',
            '박기봄 의원님 수고하셨습니다. 다음은 추선미 의원님 나와서 발언해 주시기 바랍니다.',
        ]:
            with self.subTest(text=text):
                self.assertNotIn('audioPodium', Replay().feed(text, amplitude=.2))


if __name__ == '__main__':
    unittest.main()
