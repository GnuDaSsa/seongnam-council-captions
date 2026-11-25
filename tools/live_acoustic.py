"""Opt-in local acoustic continuity evidence for the shared caption producer.

The cue wire format contains cue IDs, a transient session ID, and a version.
Speaker names and acoustic features remain local to the tracker. The reader
must independently validate the named text anchor and the complete cue chain.
"""

import hashlib
from pathlib import Path
import re
import secrets
import threading
import unicodedata
from urllib.parse import urlparse
from dataclasses import replace

from acoustic_tracker import AcousticPolicy, AcousticTracker, Cue, NamedSeed, SherpaExtractor, ShortCuePolicy, WindowPolicy
from speaker_policy import policy_block


POLICY_ID = 'same-session-1'
SHORT_POLICY_ID = 'same-session-2'
CAM_POLICY_ID = 'same-session-cam-1'
MODEL_SHA256 = 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012'
CAM_MODEL_SHA256 = '53cab20ba8f2eb2f6e2d89ecc18e88ef3222169b61b4419cbc13666744a4574b'
SAMPLE_RATE = 16_000
PROFILE = AcousticPolicy(
    same_window_min=0.72, anchor_min=0.75, rolling_min=0.75, competing_margin=0.07,
    windows=WindowPolicy(min_rms=0.002, min_active_fraction=0.45),
)
PROFILES = {
    POLICY_ID: PROFILE,
    SHORT_POLICY_ID: replace(PROFILE, short_cues=ShortCuePolicy(
        windows=WindowPolicy(min_window_seconds=1.25, max_cue_seconds=3.5, max_windows=2,
                             min_rms=0.002, min_active_fraction=0.45),
        anchor_window_min=0.70, continuation_window_min=0.82, independent_anchor_min=0.68,
    )),
    CAM_POLICY_ID: replace(
        PROFILE, same_window_min=0.469803, anchor_min=0.514906, rolling_min=0.514906, symmetric=True,
        short_cues=ShortCuePolicy(
            windows=WindowPolicy(min_window_seconds=1.25, max_cue_seconds=3.5, max_windows=2,
                                 min_rms=0.002, min_active_fraction=0.45),
            anchor_window_min=0.464396, continuation_window_min=0.464396,
            independent_anchor_min=None, symmetric_min=0.417269,
        ),
    ),
}
_GREETING = r'(?:(?:안녕하십니까|안녕하세요|네|예)[,.!?。！？\s]+){0,2}'
_INTRO = re.compile(r'^' + _GREETING + r'(?:저는\s+)?([A-Za-z가-힣 ]{3,36})\s*입니다(?=$|[.!。！])')
_DISTRICT_INTRO_SHAPE = re.compile(r'지역구로.{0,45}(?:의원|위원)\s*입니다')
_QUOTED = re.compile(r'["“”‘’「」『』]|(?:라며|라고|다고)\s*(?:하셨|했|소개|말씀|전했|답했|말했|적혀|읽)')
_MIXED = re.compile(r'[?？.!。！]\s*(?:네|예|아니요|아닙니다)(?=$|[\s,，.!?])')
_TRANSFER = re.compile(
    r'(?:다음은|수고하셨습니다|질의|질문|답변|발언|말씀)'
    r'\s*(?:해\s*주(?:십시오|시기\s*바랍니다|세요)|하시기\s*바랍니다)'
    r'|^(?:네|예)?[,\s]*(?:제가\s*)?(?:답변|보고)드리겠습니다[.!]?\s*$'
    r'|(?:수고하셨습니다|다음은)\s*(?:[.!]|$)'
)
_ADDITIONAL_INTRO = re.compile(
    r'(?:[가-힣]{2,4}\s*(?:의원|위원|과장|국장|주무관)|'
    r'(?:의원|위원|과장|국장|주무관)\s+[가-힣]{2,4})\s*입니다'
)
_ACKNOWLEDGMENT = re.compile(
    r'^(?:네|예|아니요)[,.!?\s]+(?:잘\s*)?(?:맞습니다|알겠습니다|그렇습니다|감사합니다|동의합니다)'
)


def _district_intro_pattern():
    # Use the same finite Seongnam administrative-dong and party vocabulary
    # the Worker uses. Alternate numbered form accepts literal observed ASR.
    vocabulary = policy_block('district-intro')
    districts = [re.escape(value) for value in vocabulary['districts'] + vocabulary['dongs']]
    for stem, digits in vocabulary['numberedDongs'].items():
        number = '[' + re.escape(digits) + ']'
        districts.append(re.escape(stem) + rf'\s*{number}\s*(?:동|지\s*{number}\s*등)')
    item = '(?:' + '|'.join(districts) + ')'
    separator = r'(?:\s*[,·ㆍ]\s*|(?:과|와)\s*|\s+및\s+|\s+)'
    parties = '|'.join(r'\s*'.join(re.escape(letter) for letter in party) for party in vocabulary['parties'])
    return re.compile(
        r'^(?:(?:안녕하십니까|안녕하세요)[,.!?。！？\s]+)?(?:저는\s+)?(?:성남시\s+)?'
        + item + '(?:' + separator + item + r'){0,2}'
        r'(?:을|를)\s+지역구로\s+(?:하는|둔)\s+(?:(?:' + parties + r')\s+)?'
        r'([가-힣]{2,4})\s*(?:의원|위원)\s*입니다[.!。！]?$'
    )


_DISTRICT_INTRO = _district_intro_pattern()


def _text(value):
    return ' '.join(unicodedata.normalize('NFKC', str(value or '')).split())


def _compact(value):
    return _text(value).replace(' ', '')


def _staff_source(value):
    try:
        url = urlparse(str(value or ''))
        return (url.scheme == 'https' and url.netloc == 'www.sncouncil.go.kr' and
                url.path == '/record/recordView.do' and bool(re.fullmatch(r'key=[a-f0-9]+', url.query)) and
                not url.fragment)
    except ValueError:
        return False


_PRIOR_STAFF = policy_block('prior-staff')


def _historical_staff_intro(meeting, row, text, duration):
    body, role = _compact(row.get('committee')), _compact(row.get('role'))
    name, office = _text(row.get('name')), row.get('officialRole')
    if (not re.fullmatch(r'[가-힣]{2,15}위원회', body) or
            row.get('basis') not in _PRIOR_STAFF['bases'] or office not in _PRIOR_STAFF['offices'] or
            duration is None or not _PRIOR_STAFF['minCueSeconds'] <= duration <= _PRIOR_STAFF['maxCueSeconds']):
        return False
    sitting = (r'(?:성남시의회)?(?:제\d+회(?:(?:제\d+차)?(?:정례회|임시회))?)?(?:제\d+차)?' +
               re.escape(body) + r'(?:\[폐회중\]|행정사무감사제\d+일차)?')
    expected_role = {'recorded-self-introduction': body + '담당', 'chair-assigned-role': office}.get(row.get('roleBasis'))
    if not expected_role or role != expected_role or not re.fullmatch(sitting, _compact(meeting.get('title'))):
        return False
    words = re.sub(r'^(?:안녕하십니까|안녕하세요)[,.!?。！？\s]+', '', text)
    return _compact(re.sub(r'[.!。！]$', '', words)) == role + name + '입니다'


def _explicit_seed(meeting, cue_id, text, duration=None):
    if _QUOTED.search(text) or _MIXED.search(text) or _TRANSFER.search(text):
        return None
    members = [_text(name) for name in meeting.get('members', [])]
    staff = [row for row in meeting.get('staffRoster', []) if isinstance(row, dict)]
    district = _DISTRICT_INTRO.fullmatch(text)
    if district is not None:
        name = district[1]
        if members.count(name) == 1 and not any(_text(row.get('name')) == name for row in staff):
            return NamedSeed(name, '의원', cue_id, 'explicit_self_intro')
        return None
    match = _INTRO.match(text)
    if match is None or _ADDITIONAL_INTRO.search(text[match.end():]):
        return None
    spoken = _compact(match[1])
    match_names = []
    for name in set(members):
        if (re.fullmatch(r'[가-힣]{2,4}', name) and members.count(name) == 1 and
                not any(_text(row.get('name')) == name for row in staff) and
                spoken in (name + '의원', name + '위원', '의원' + name, '위원' + name)):
            match_names.append((name, '의원'))
    for row in staff:
        name, role = _text(row.get('name')), _text(row.get('role'))
        if row.get('candidateOnly') and not _historical_staff_intro(meeting, row, text, duration):
            continue
        if (name not in members and re.fullmatch(r'[가-힣]{2,4}', name) and role and
                sum(_text(item.get('name')) == name for item in staff) == 1 and
                _staff_source(row.get('source')) and spoken in (_compact(role) + name, name + _compact(role))):
            match_names.append((name, role))
    if len(match_names) != 1:
        return None
    name, role = match_names[0]
    return NamedSeed(name, role, cue_id, 'explicit_self_intro')


def _substantive(text, short=False):
    minimum_letters, minimum_words = (11, 4) if short else (12, 2)
    return (len(re.findall(r'[가-힣]', text)) >= minimum_letters and len(text.split()) >= minimum_words and
            not (_MIXED.search(text) or _QUOTED.search(text) or _TRANSFER.search(text) or
                 (short and _ACKNOWLEDGMENT.search(text))))


class _LockedExtractor:
    def __init__(self, model):
        self._model = model
        self._lock = threading.Lock()

    def embed(self, samples):
        with self._lock:
            return self._model.embed(samples)


def load_extractor(model_path, profile=POLICY_ID):
    """Create one bounded CPU extractor shared across active meeting readers."""
    if profile not in PROFILES:
        raise ValueError('Unsupported speaker profile')
    expected = CAM_MODEL_SHA256 if profile == CAM_POLICY_ID else MODEL_SHA256
    with Path(model_path).open('rb') as file:
        if hashlib.file_digest(file, 'sha256').hexdigest() != expected:
            raise ValueError('Speaker model does not match this experimental profile')
    return _LockedExtractor(SherpaExtractor(model_path, threads=1))


_STAFF_PRESENTATION = re.compile(
    r'(?:간부(?:공무원)?|참석(?:자|직원)|직원|공무원|과장|국장|팀장|주무관|전문위원|정책지원관)'
    r'(?:님)?(?:들)?(?:을|를)?(?:위원님들?께)?(?:먼저)?소개(?:해드리(?:겠습니다|도록하겠습니다)|올리겠습니다|하겠습니다)'
)
_OFFICE = r'(?:국장|과장|팀장|소장|관장|담당관|주무관|전문위원|본부장|센터장)'
_LISTED_STAFF = re.compile(r'(?:[가-힣]{2,4}\s+[가-힣A-Za-z ]{1,24}' + _OFFICE +
                          r'|[가-힣A-Za-z ]{1,24}' + _OFFICE + r'\s+[가-힣]{2,4})입니다')
_SPLIT_OFFICE = re.compile(r'(?:안녕하십니까|안녕하세요)[ ,.!?。！？]+[가-힣A-Za-z ]{1,24}' + _OFFICE)
_SPLIT_NAME = re.compile(r'[가-힣]{2,4}입니다[.!?。！？]?')


class LiveAcoustic:
    def __init__(self, meeting, extractor, profile=POLICY_ID, *, podium_floor=False):
        self._meeting = meeting
        self._profile = profile
        self._policy = PROFILES[profile]
        self._tracker = AcousticTracker(extractor, self._policy)
        if podium_floor and profile != CAM_POLICY_ID:
            raise ValueError('Plenary floor evidence requires the pinned CAM++ profile')
        self._podium = None
        if podium_floor and '본회의' in _text(meeting.get('title')):
            from podium_acoustic import PodiumAcoustic
            self._podium = PodiumAcoustic(
                meeting, extractor, self._policy, text=_text, identify=_explicit_seed,
                quoted=_QUOTED, mixed=_MIXED, transfer=_TRANSFER, substantive=_substantive,
            )
        self.disabled = False
        self.reset()

    def _reset_regular(self):
        self._tracker.reset()
        self._session = secrets.token_hex(16)
        self._last_cue_end = None

    def reset(self):
        self._reset_regular()
        self._last_capture_end = None
        self._last_staff_listing_end = None
        self._pending_staff_name = False
        if self._podium is not None:
            self._podium.reset()

    def _is_staff_listing(self, cue, text):
        sentences = [part.strip() for part in re.split(r'[.!?。！？]', text) if part.strip()]
        announced = bool(_STAFF_PRESENTATION.search(_compact(text)))
        following = self._last_staff_listing_end is not None and (
            -self._policy.max_overlap_seconds <= round(cue['start'] - self._last_staff_listing_end, 3) <= 8
        )
        listed = bool(sentences) and all(_LISTED_STAFF.fullmatch(part) for part in sentences)
        split_office = following and bool(_SPLIT_OFFICE.fullmatch(text))
        split_name = following and self._pending_staff_name and bool(_SPLIT_NAME.fullmatch(text))
        self._pending_staff_name = split_office
        if announced or (following and listed) or split_office or split_name:
            self._last_staff_listing_end = cue['end']
            return True
        self._last_staff_listing_end = None
        return False

    def _adjacent(self, start, end):
        if end is None:
            return True
        # Published cue timestamps have millisecond precision.
        gap = round(start - end, 3)
        return -self._policy.max_overlap_seconds <= gap <= self._policy.max_gap_seconds

    def annotate(self, cues, pcm, chunk_start, sample_ranges):
        """Annotate one exact decoded PCM batch; optional failure is text-only."""
        if self.disabled:
            return None
        if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2 or len(sample_ranges) != len(cues):
            self.reset()
            return None
        if not self._adjacent(chunk_start, self._last_capture_end):
            self.reset()
        try:
            pending = self._podium.annotate(cues, pcm, chunk_start, sample_ranges) if self._podium is not None else []
            if not cues:
                self._reset_regular()
            for cue in cues:
                first, last = sample_ranges[cue['id']]
                if not (0 <= first < last <= len(pcm) // 2):
                    self.reset()
                    return None
                if not self._adjacent(cue['start'], self._last_cue_end):
                    self._reset_regular()
                text = _text(cue['rawText']) if cue['rawText'] == cue['text'] else ''
                listing = self._is_staff_listing(cue, text)
                seed = None if listing else _explicit_seed(self._meeting, cue['id'], text, round(cue['end'] - cue['start'], 3))
                # A new but unsupported introduction must not continue the old voice.
                unknown_intro = seed is None and bool(_INTRO.match(text) or _DISTRICT_INTRO_SHAPE.search(text))
                duration = round(cue['end'] - cue['start'], 3)
                short = self._policy.short_cues is not None and 2.5 <= duration < 3.5
                row = Cue(str(self._meeting['id']), self._session, cue['id'], cue['start'], cue['end'],
                          bool((seed or _substantive(text, short)) and not listing and not unknown_intro), tuple(cue['flags']))
                heard = self._tracker.update(row, pcm[first * 2:last * 2], seed)
                common = {'sessionId': self._session, 'policy': self._profile}
                if heard['status'] == 'anchored':
                    pending.append((cue, 'audioAnchor', common))
                elif heard['status'] == 'corroborated':
                    evidence = heard['candidate']['evidence']
                    pending.append((cue, 'audioContinuation', {
                        **common, 'anchorId': evidence[0], 'previousId': evidence[-2],
                    }))
                self._last_cue_end = cue['end']
            self._last_capture_end = chunk_start + len(pcm) / (2 * SAMPLE_RATE)
        except Exception as error:
            self.reset()
            self.disabled = True
            return type(error).__name__
        for cue, key, payload in pending:
            cue[key] = payload
        return None
