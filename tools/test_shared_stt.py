import base64
from contextlib import ExitStack
import datetime as dt
import io
import json
import math
import threading
import tempfile
import unittest
import urllib.error
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


class CaptureClock:
    def __init__(self):
        self.origin = dt.datetime(2026, 8, 28, 5, tzinfo=dt.timezone.utc)
        self.elapsed = 0

    def now(self, timezone=None):
        instant = self.origin + dt.timedelta(seconds=self.elapsed)
        return instant.astimezone(timezone) if timezone else instant.astimezone().replace(tzinfo=None)

    def time(self):
        return self.origin.timestamp() + self.elapsed

    def time_ns(self):
        return round(self.time() * 1_000_000_000)

    def monotonic(self):
        return self.elapsed

    def sleep(self, seconds):
        self.elapsed += seconds


def sample_chunk(value):
    # Four seconds of voiced PCM and one second of silence triggers the real splitter.
    return value.to_bytes(2, 'little', signed=True) * 64000 + bytes(32000)


class FakeFFmpeg:
    def __init__(self, values, *, eof=False, on_read=None):
        self.stdout = self
        self.input = io.BytesIO(b''.join(map(sample_chunk, values)))
        self.exited = threading.Event()
        self.eof = eof
        self.on_read = on_read

    def read(self, size):
        if self.on_read:
            on_read, self.on_read = self.on_read, None
            on_read()
        data = self.input.read(size)
        if not data:
            if self.eof:
                self.exited.set()
            else:
                self.exited.wait(timeout=5)
        return data

    def poll(self):
        return 0 if self.exited.is_set() else None

    def terminate(self):
        self.exited.set()

    def wait(self, timeout):
        assert self.exited.wait(timeout)

    def close(self):
        self.input.close()


class ProducerTests(unittest.TestCase):
    def test_default_capture_uses_configured_hls_meeting_then_legacy_fallback(self):
        meetings = [
            {'id': '4360', 'title': '행정교육위원회', 'playlist': 'admin'},
            {'id': '4361', 'title': '경제환경위원회', 'playlist': 'economy'},
            {'id': '4362', 'title': '문화복지체육위원회', 'provider': 'youtube'},
        ]
        self.assertEqual(stt.default_capture_meeting_id({'meetings': meetings, 'defaultMeetingId': '4360'}), '4360')
        self.assertEqual(stt.default_capture_meeting_id({'meetings': meetings}), '4361')
        self.assertEqual(stt.default_capture_meeting_id({'meetings': meetings, 'defaultMeetingId': '4362'}), '4361')
        self.assertEqual(stt.default_capture_meeting_id({'meetings': [None, {'id': 'bad'}, meetings[0]]}), '4360')
        self.assertIsNone(stt.default_capture_meeting_id({'meetings': [meetings[2]]}))

    def test_stale_manifest_fails_before_loading_a_model_in_default_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / 'live-meetings.json'
            manifest.write_text(json.dumps({'date': '2020-01-01', 'defaultMeetingId': '2853'}), encoding='utf-8')
            cli = ['shared_stt.py', '--endpoint', 'https://caption.example', '--end-at', '2099-01-01T00:00:00Z']
            stderr = io.StringIO()
            with patch.object(stt, 'MANIFEST', manifest), patch('sys.argv', cli), patch('sys.stderr', stderr), patch.object(stt, 'load_model') as load_model:
                with self.assertRaises(SystemExit) as error:
                    stt.main()
            self.assertEqual(error.exception.code, 2)
            self.assertIn('manifest is not for today', stderr.getvalue())
            load_model.assert_not_called()

    def test_discovers_pinned_model_filename_in_operator_and_portable_layouts(self):
        filename = '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / 'release' / 'source' / 'tools' / 'shared_stt.py'
            operator = root / 'operator'
            portable_model = root / 'release' / 'models' / filename
            operator_model = operator / 'models' / filename
            with patch.object(stt, 'HOME', operator), patch.object(stt, '__file__', str(script)):
                self.assertIsNone(stt.installed_speaker_model())
                portable_model.parent.mkdir(parents=True)
                portable_model.touch()
                self.assertEqual(stt.installed_speaker_model(), portable_model)
                operator_model.parent.mkdir(parents=True)
                operator_model.touch()
                self.assertEqual(stt.installed_speaker_model(), operator_model)

    def test_flags_korean(self):
        self.assertEqual(set(stt.cue_flags('장일남 의원은 2명 출석으로 표결했습니다')), {'name', 'number', 'proceeding'})
        self.assertEqual(stt.cue_flags('안녕하세요'), [])

    def test_historical_candidates_do_not_prompt_the_decoder(self):
        meeting = {'agenda': ['사업 보고'], 'members': ['김가람'], 'memberRoster': {'candidateOnly': True},
                   'staffRoster': [{'name': '서하늘', 'role': '담당', 'candidateOnly': True},
                                   {'name': '박바다', 'role': '과장'}]}
        hints = stt.meeting_hints(meeting)
        self.assertIn('사업 보고', hints)
        self.assertIn('과장 박바다', hints)
        self.assertNotIn('서하늘', hints)
        self.assertNotIn('김가람', hints)
        del meeting['memberRoster']
        self.assertIn('김가람', stt.meeting_hints(meeting))

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

    def run_capture(self, clock, sources, decode, *, limit=74, expected_error=None, existing=None,
                    reconnects=stt.DEFAULT_LAG_RECONNECTS, capture_events=None, publish_error=None, acoustic=None):
        publications, archive_start, launched = [], [], []
        meeting = {
            'id': '2853',
            'scheduledAt': (clock.origin - dt.timedelta(minutes=1)).isoformat(),
            'endsAt': (clock.origin + dt.timedelta(minutes=10)).isoformat(),
            'officialPage': 'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=2853',
            'playlist': 'https://cast.sncouncil.go.kr:4443/live/ch1.sdp/playlist.m3u8',
        }
        end = clock.origin + dt.timedelta(seconds=limit)
        if existing is None:
            get = {'side_effect': urllib.error.HTTPError('', 404, '', {}, None)}
        else:
            get = {'return_value': io.BytesIO(json.dumps(existing).encode())}
        fake_date = SimpleNamespace(now=clock.now, fromtimestamp=dt.datetime.fromtimestamp,
                                    fromisoformat=dt.datetime.fromisoformat)

        def popen(command, **options):
            self.assertEqual(command[command.index('-live_start_index') + 1], '-1')
            process = sources[len(launched)]
            launched.append(process)
            return process

        def put(endpoint, payload):
            publications.append(payload)
            if publish_error:
                raise publish_error

        def capture_event():
            event = threading.Event()
            capture_events.append(event)
            return event

        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            home = Path(tmp)
            manifest = home / 'live-meetings.json'
            manifest.write_text(json.dumps({'date': clock.now().date().isoformat(), 'meetings': [meeting]}))
            patch_module = lambda key, value: stack.enter_context(patch.object(stt, key, value))
            patch_module('HOME', home)
            patch_module('MANIFEST', manifest)
            patch_module('time', clock)
            patch_module('dt', SimpleNamespace(datetime=fake_date, timezone=dt.timezone))
            if capture_events is not None:
                patch_module('threading', SimpleNamespace(Event=capture_event, Thread=threading.Thread))
            if acoustic is not None:
                stack.enter_context(patch('live_acoustic.LiveAcoustic', return_value=acoustic))
            stack.enter_context(patch.object(stt.subprocess, 'Popen', side_effect=popen))
            stack.enter_context(patch.object(stt.urllib.request, 'urlopen', **get))
            stack.enter_context(patch.object(stt, 'session_origin', return_value=clock.origin.timestamp()-100))
            patch_module('signed_put', put)
            def run():
                stt.run('https://caption.example', end, '2853', None, decode,
                        lag_reconnects=reconnects, on_capture_started=archive_start.append,
                        acoustic_extractor=object() if acoustic is not None else None)

            if expected_error:
                with self.assertRaisesRegex(*expected_error):
                    run()
            else:
                run()

        self.assertTrue(all(process.poll() == 0 for process in launched))
        return publications, archive_start, launched

    def test_stale_result_reopens_live_edge_and_tracks_first_accepted_audio(self):
        clock = CaptureClock()
        first = FakeFFmpeg([2000, 2100])
        second = FakeFFmpeg([3000, 3100])
        calls = []
        acoustic_events = []
        acoustic = SimpleNamespace(annotate=lambda batch, *_:acoustic_events.append(batch[0]['rawText']),
                                   reset=lambda:acoustic_events.append('reset'))

        def decode(mid, audio, previous, hints, lag):
            marker = round(float(audio[0])*32768)
            calls.append((marker, previous))
            move, text = {
                2000: (5, '첫 정상 발언'),
                2100: (61.074, '폐기된 지연 전사'),
                3000: (5, '다시 연결한 발언'),
                3100: (4, '정해진 종료 뒤 전사'),
            }[marker]
            clock.elapsed += move
            return [self.segment(text, 0, 3)]

        updates, archived, launched = self.run_capture(clock, [first, second], decode, acoustic=acoustic)
        self.assertEqual(len(launched), 2)
        self.assertEqual(len(archived), 1)
        self.assertEqual(calls, [(2000, ''), (2100, ' 첫 정상 발언'), (3000, ''), (3100, ' 다시 연결한 발언')])
        self.assertEqual(acoustic_events, ['첫 정상 발언', 'reset', '다시 연결한 발언'])
        self.assertEqual([row['status'] for row in updates], ['live', 'interrupted', 'live', 'interrupted'])
        earlier = updates[0]['cues'][0]
        self.assertEqual(earlier['start'], 100)
        self.assertEqual(updates[1]['captureGapStart'], '2026-08-28T05:00:05.000Z')
        self.assertEqual(updates[1]['cues'], [earlier])
        self.assertEqual(updates[2]['cues'][0], earlier)
        resumed = updates[2]['cues'][1]
        self.assertEqual(resumed['start'], 166.074)
        self.assertEqual(updates[2]['captureGapEnd'], resumed['observedAt'])
        self.assertEqual(updates[2]['captureGapEnd'], '2026-08-28T05:01:06.074Z')
        self.assertEqual(updates[3]['cues'], [earlier, resumed])
        self.assertGreater(int(resumed['id']), int(earlier['id']))
        self.assertEqual(updates[3]['captureGapStart'], '2026-08-28T05:01:11.074Z')

    def test_stale_pcm_before_decode_is_discarded_without_fabricating_a_gap_start(self):
        clock = CaptureClock()
        cold = FakeFFmpeg([2000], on_read=lambda: setattr(clock, 'elapsed', 61.074))
        fresh = FakeFFmpeg([3000, 3100])
        markers = []

        def decode(mid, audio, previous, hints, lag):
            marker = round(float(audio[0])*32768)
            markers.append(marker)
            clock.elapsed += 5
            return [self.segment('재연결 뒤 발언', 0, 3)]

        updates, archived, launched = self.run_capture(clock, [cold, fresh], decode, limit=69)
        self.assertEqual(markers, [3000, 3100])
        self.assertEqual(len(archived), 1)
        self.assertEqual(len(launched), 2)
        self.assertNotIn('captureGapStart', updates[0])
        self.assertEqual(updates[1]['captureGapEnd'], '2026-08-28T05:01:01.074Z')

    def test_buffered_pcm_is_clipped_at_the_user_end_time(self):
        clock = CaptureClock()
        lengths = []

        def decode(mid, audio, previous, hints, lag):
            lengths.append(len(audio))
            clock.elapsed += 2
            return [self.segment('종료 직전 발언', 0, 3)]

        updates, _, launched = self.run_capture(clock, [FakeFFmpeg([2000, 2100])], decode, limit=3)
        self.assertEqual(lengths, [3*16000])
        self.assertEqual(updates[0]['cues'][0]['end'], 103)
        self.assertLess(updates[0]['updatedAt'], updates[1]['updatedAt'])
        self.assertEqual(len(launched), 1)

    def test_pcm_queue_overflow_is_retryable_but_does_not_publish_the_interrupted_decode(self):
        clock = CaptureClock()
        capture_events = []

        def decode(mid, audio, previous, hints, lag):
            if round(float(audio[0])*32768) == 2000:
                self.assertTrue(capture_events[0].wait(3))
                clock.elapsed = 21
                return [self.segment('폐기된 전사', 0, 3)]
            clock.elapsed += 5
            return [self.segment('새 원음 발언', 0, 3)]

        updates, _, launched = self.run_capture(
            clock, [FakeFFmpeg([2000]*6), FakeFFmpeg([3000, 3100])], decode, limit=29, capture_events=capture_events)
        self.assertEqual(len(launched), 2)
        self.assertEqual([row['status'] for row in updates], ['interrupted', 'live', 'interrupted'])
        self.assertEqual([row['rawText'] for row in updates[-1]['cues']], ['새 원음 발언'])

    def test_retry_budget_and_non_lag_errors(self):
        for budget in (0, 2):
            with self.subTest(budget=budget):
                clock = CaptureClock()
                def lagging(*args):
                    clock.elapsed += 61.074
                    stt.require_current_audio(args[-1](), 'before queued decode')

                updates, archived, launched = self.run_capture(
                    clock, [FakeFFmpeg([2000]) for _ in range(budget+1)], lagging, limit=300,
                    expected_error=(stt.AudioLagError, '61.074'), reconnects=budget)
                self.assertEqual(len(launched), budget+1)
                self.assertEqual([row['status'] for row in updates], ['interrupted'])
                self.assertEqual(archived, [])

        clock = CaptureClock()
        updates, _, launched = self.run_capture(clock, [FakeFFmpeg([],eof=True)], None,
                                                expected_error=(RuntimeError, 'capture ended'))
        self.assertEqual(len(launched), 1)
        self.assertNotIn('captureGapEnd', updates[0])

        clock = CaptureClock()
        interrupted = {'meetingId': '2853', 'status': 'interrupted', 'cues': []}
        updates, _, launched = self.run_capture(clock, [FakeFFmpeg([],eof=True)], None, existing=interrupted,
                                                expected_error=(RuntimeError, 'capture ended'))
        self.assertEqual(updates, [])
        self.assertEqual(len(launched), 1)

        clock = CaptureClock()
        def stale_decode(*args):
            clock.elapsed += 61.074
            return [self.segment('폐기된 발언', 0, 1)]
        updates, _, launched = self.run_capture(clock, [FakeFFmpeg([2000]), FakeFFmpeg([],eof=True)], stale_decode,
                                                expected_error=(RuntimeError, 'capture ended'))
        self.assertEqual(len(launched), 2)
        self.assertEqual([row['status'] for row in updates], ['interrupted'])
        self.assertNotIn('captureGapEnd', updates[0])

        clock = CaptureClock()
        def model_failed(*args):
            raise RuntimeError('model failed')
        updates, _, launched = self.run_capture(clock, [FakeFFmpeg([2000])], model_failed,
                                                expected_error=(RuntimeError, 'model failed'))
        self.assertEqual([row['status'] for row in updates], ['interrupted'])
        self.assertEqual(len(launched), 1)

        clock = CaptureClock()
        updates, _, launched = self.run_capture(
            clock, [FakeFFmpeg([2000])], lambda *args:[self.segment('미게시 발언', 0, 1)],
            publish_error=PermissionError('signing key unavailable'), expected_error=(PermissionError, 'signing key'))
        self.assertEqual([row['status'] for row in updates], ['live'])
        self.assertEqual(len(launched), 1)


if __name__ == '__main__': unittest.main()
