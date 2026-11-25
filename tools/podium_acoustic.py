"""Bounded optional plenary floor evidence from an already shared CAM++ model.

No speaker name, raw audio, or embedding appears in a wire proof. The receiver
must independently check the original visible call, the same self-introduction,
the confirmation and match ordering, and gaps in its own stored cue timeline.
"""

from dataclasses import dataclass
import re
import secrets

import numpy as np

from acoustic_tracker import UNCERTAIN_FLAGS, _agreement, _similarity, _speech_windows, _unit
from speaker_policy import policy_block


_CONFIG = policy_block('podium')
PODIUM_POLICY_ID = _CONFIG['profile']
MAX_CALL_TO_INTRO = _CONFIG['callMaxSeconds']
MAX_UNREAD_CALL_AUDIO = _CONFIG['maxUnreadCallAudioSeconds']
MAX_CONFIRMATION_DELAY = _CONFIG['confirmationMaxSeconds']
MAX_FLOOR_AGE = _CONFIG['maxFloorSeconds']
MAX_UNSUPPORTED = _CONFIG['maxCueGapSeconds']
MAX_PCM_JOIN = _CONFIG['maxOverlapSeconds']
MIN_CHAIR_SEPARATION = _CONFIG['minChairSeparation']
MIN_CHAIR_MARGIN = _CONFIG['minChairMargin']

_CALL = re.compile(
    r'^(?:(?P<outgoing>[가-힣]{2,4})\s*(?:의원|위원)님\s*수고하셨습니다[.!?。！？]\s*)?'
    r'(?:(?:다음은|그러면)\s+)?(?P<called>[가-힣]{2,4})\s*(?:의원|위원)님'
    r'\s*(?:나오셔서|나와서)\s*(?:[5오]분\s*(?:자유)?\s*)?발언(?:을)?\s*해\s*주시기\s*바랍니다[.!?。！？\s]*$'
)
_EXIT = re.compile(
    r'경청해\s*주셔서\s*감사|이상(?:으로)?\s*(?:[5오]분\s*)?(?:발언|보고|설명).{0,10}마치'
    r'|(?:의원|위원)님\s*수고하셨습니다|(?:정회|산회|휴회)를?\s*선포'
)
_INTERRUPTION = re.compile(
    r'^(?:위원장님|의장님)[,.!\s]+(?:잠깐|저기|질문|답변)|잠깐만요|답변\s*드리겠|질의(?:에|하신)'
    r'|의원님께서|보충\s*(?:질의|설명)'
)
_CALL_WAIT_TEXT = frozenset({'네', '예', '감사합니다', '안녕하십니까', '안녕하세요'})
_UNRESOLVED_INTRO = re.compile(r'(?:의원|위원|과장|국장|주무관|팀장)\s*(?:[가-힣]{2,4}\s*)?입니다')


@dataclass
class _Reference:
    windows: tuple
    center: np.ndarray
    short: bool


@dataclass
class _Floor:
    session: str
    name: str
    call_id: str
    call_end: float
    chair: _Reference
    anchor_id: str | None = None
    anchor_start: float | None = None
    anchor: _Reference | None = None
    confirmation_id: str | None = None
    confirmation: _Reference | None = None
    last_evidence_end: float | None = None
    unplaced_audio: float = 0
    confirmed_text: str | None = None


def _between(left, right, selection):
    return selection([_similarity(vector, right.center) for vector in left.windows] +
                     [_similarity(vector, left.center) for vector in right.windows])


def _elapsed(new, old):
    return round(new - old, 3)


class PodiumAcoustic:
    def __init__(self, meeting, extractor, policy, *, text, identify, quoted, mixed, transfer, substantive):
        self._meeting = meeting
        self._extractor = extractor
        self._policy = policy
        self._text = text
        self._identify = identify
        self._quoted = quoted
        self._mixed = mixed
        self._transfer = transfer
        self._substantive = substantive
        self.reset()

    def reset(self):
        self._floor = None
        self._last_capture_end = None
        self._last_cue_end = None
        self._session = secrets.token_hex(16)

    def _unique_member(self, name):
        return (sum(self._text(value) == name for value in self._meeting.get('members', ())) == 1 and
                not any(isinstance(row, dict) and self._text(row.get('name')) == name
                        for row in self._meeting.get('staffRoster', ())))

    def _read_voice(self, pcm, duration):
        short = duration < 3.5
        window = self._policy.short_cues.windows if short else self._policy.windows
        minimum = self._policy.short_cues.anchor_window_min if short else self._policy.same_window_min
        values, _ = _speech_windows(self._extractor, pcm, window, duration)
        if values is None or _agreement(values) < minimum:
            return None
        center = _unit(np.mean(values, axis=0))
        return _Reference(tuple(values), center, short) if center is not None else None

    def _proof(self, stage):
        floor = self._floor
        proof = {'policy': PODIUM_POLICY_ID, 'sessionId': floor.session, 'stage': stage}
        if stage != 'call':
            proof['callId'] = floor.call_id
        if stage in {'confirm', 'match'}:
            proof['anchorId'] = floor.anchor_id
        if stage == 'match':
            proof['confirmationId'] = floor.confirmation_id
        return proof

    def _unplaced(self, pcm):
        floor = self._floor
        if not floor or floor.anchor is not None or not pcm:
            return
        samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768
        frame_size = 320
        full, leftover = divmod(len(samples), frame_size)
        threshold = self._policy.windows.min_rms
        if full:
            rms = np.std(samples[:full * frame_size].reshape(-1, frame_size), axis=1)
            floor.unplaced_audio += int(np.count_nonzero(rms >= threshold)) * .02
        if leftover and np.std(samples[-leftover:]) >= threshold:
            floor.unplaced_audio += leftover / 16000
        if floor.unplaced_audio > MAX_UNREAD_CALL_AUDIO:
            self._floor = None

    def annotate(self, cues, pcm, chunk_start, sample_ranges):
        """Return staged changes for this verified source batch, without mutation."""
        if (self._last_capture_end is not None and
                abs(chunk_start - self._last_capture_end) > MAX_PCM_JOIN):
            self.reset()
        self._last_capture_end = chunk_start + len(pcm) / 32000
        result = []
        cursor = 0
        for cue in cues:
            first, last = sample_ranges[cue['id']]
            if not 0 <= first < last <= len(pcm) // 2:
                self.reset()
                return []
            self._unplaced(pcm[cursor * 2:first * 2])
            cursor = max(cursor, last)
            if (self._last_cue_end is not None and
                    _elapsed(cue['start'], self._last_cue_end) < -MAX_PCM_JOIN):
                self._floor = None
                self._last_cue_end = max(cue['end'], self._last_cue_end)
                continue
            self._last_cue_end = cue['end']
            proof = self._observe(cue, pcm[first * 2:last * 2])
            if proof:
                result.append((cue, 'audioPodium', proof))
        self._unplaced(pcm[cursor * 2:])
        if self._floor:
            marker = self._floor.last_evidence_end
            if marker is not None and _elapsed(self._last_capture_end, marker) > MAX_UNSUPPORTED:
                self._floor = None
            elif marker is None and _elapsed(self._last_capture_end, self._floor.call_end) > MAX_CALL_TO_INTRO:
                self._floor = None
        return result

    def _observe(self, cue, pcm):
        if cue['rawText'] != cue['text'] or UNCERTAIN_FLAGS.intersection(cue['flags']):
            self._floor = None
            return
        text = self._text(cue['text'])
        start, end = cue['start'], cue['end']
        duration = _elapsed(end, start)
        if self._quoted.search(text) or self._mixed.search(text):
            self._floor = None
            return
        call = _CALL.search(text)
        if call:
            self._floor = None
            called, outgoing = call['called'], call['outgoing']
            outgoing_valid = outgoing is None or (outgoing != called and self._unique_member(outgoing))
            if _CONFIG['minCallSeconds'] <= duration <= _CONFIG['maxCueSeconds'] and self._unique_member(called) and outgoing_valid:
                chair = self._read_voice(pcm, duration)
                if chair:
                    self._floor = _Floor(self._session, called, cue['id'], end, chair)
                    return self._proof('call')
            return
        floor = self._floor
        if floor is None:
            return
        seed = self._identify(self._meeting, cue['id'], text)
        if seed is not None:
            self._floor = None
            if (floor.anchor_id is not None or seed.role != '의원' or seed.name != floor.name or
                    not 0 <= _elapsed(start, floor.call_end) <= MAX_CALL_TO_INTRO or
                    not _CONFIG['minSeedSeconds'] <= duration <= _CONFIG['maxCueSeconds']):
                return
            anchor = self._read_voice(pcm, duration)
            if anchor is None or 1 - _between(anchor, floor.chair, max) < MIN_CHAIR_SEPARATION:
                return
            floor.anchor_id, floor.anchor_start, floor.anchor = cue['id'], start, anchor
            floor.last_evidence_end = end
            self._floor = floor
            return self._proof('intro')
        if (_EXIT.search(text) or _INTERRUPTION.search(text) or self._transfer.search(text) or
                _UNRESOLVED_INTRO.search(text)):
            self._floor = None
            return
        if floor.anchor_id is None:
            if text.strip(' .!?。！？') not in _CALL_WAIT_TEXT or _elapsed(start, floor.call_end) > MAX_CALL_TO_INTRO:
                self._floor = None
            return
        if (_elapsed(end, floor.anchor_start) > MAX_FLOOR_AGE or
                _elapsed(start, floor.last_evidence_end) > MAX_UNSUPPORTED):
            self._floor = None
            return
        confirm = floor.confirmation_id is None
        if confirm and _elapsed(start, floor.anchor_start) > MAX_CONFIRMATION_DELAY:
            self._floor = None
            return
        # A safe short fragment is held without support; it cannot extend the
        # live floor. An attempted quality/identity check that fails ends it.
        minimum_seconds = _CONFIG['minSeedSeconds'] if confirm else _CONFIG['minMatchSeconds']
        if not minimum_seconds <= duration <= _CONFIG['maxCueSeconds']:
            return
        normalized = re.sub(r'[^가-힣A-Za-z0-9]', '', text)
        if (not self._substantive(text, duration < 3.5) or (duration >= 3.5 and len(text.split()) < 3) or
                normalized == floor.confirmed_text):
            return
        heard = self._read_voice(pcm, duration)
        if heard is None:
            self._floor = None
            return
        anchor_score = _between(heard, floor.anchor, min)
        minimum = (self._policy.short_cues.symmetric_min if confirm and heard.short and floor.anchor.short
                   else self._policy.anchor_min)
        agree = anchor_score if confirm else min(anchor_score, _between(heard, floor.confirmation, min))
        if agree < minimum or agree - _between(heard, floor.chair, max) < MIN_CHAIR_MARGIN:
            self._floor = None
            return
        if confirm:
            floor.confirmation_id, floor.confirmation = cue['id'], heard
            floor.confirmed_text = normalized
        floor.last_evidence_end = end
        return self._proof('confirm' if confirm else 'match')
