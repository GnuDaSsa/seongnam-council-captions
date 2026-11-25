"""Offline, causal acoustic corroboration for a single public meeting session.

Call reset() at every source restart or seek, and update(cue, pcm, seed=None)
in capture order. PCM is mono 16 kHz float [-1, 1], int16 NumPy, or s16le bytes,
isolated to the exact cue interval. A caller-supplied NamedSeed is an external
identity claim from a checked cue or explicit self-introduction. The tracker
can corroborate its continuation; it never obtains a name from audio alone.

Policy score thresholds must be supplied by the caller after calibration.
Use compare_pcm() to inspect scores without storing audio, vectors, or identities.
The tracker is stateful and expects a single caller per instance.
"""

from dataclasses import dataclass
from itertools import combinations
import math
from pathlib import Path
from typing import Protocol

import numpy as np


SAMPLE_RATE = 16_000
UNCERTAIN_FLAGS = frozenset({
    'uncertain', 'low_confidence', 'severe_uncertainty', 'repetition', 'segment_review',
    'mixed', 'overlap', 'interrupted', 'audio_gap', 'invalid_time_value',
})
SEED_SOURCES = frozenset({'explicit_self_intro', 'verified_cue'})


class Extractor(Protocol):
    def embed(self, samples: np.ndarray) -> np.ndarray | None:
        """Return a short-lived embedding for one 16 kHz speech window."""


class SherpaExtractor:
    def __init__(self, model_path: str | Path, *, threads: int = 1):
        import sherpa_onnx

        path = Path(model_path)
        if not path.is_file() or threads < 1:
            raise ValueError('A local model and positive thread count are required')
        config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(path), num_threads=threads, debug=False, provider='cpu',
        )
        if not config.validate():
            raise ValueError('Invalid speaker-embedding configuration')
        self._extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)

    def embed(self, samples: np.ndarray) -> np.ndarray | None:
        stream = self._extractor.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        stream.input_finished()
        if not self._extractor.is_ready(stream):
            return None
        return np.asarray(self._extractor.compute(stream), dtype=np.float32)


@dataclass(frozen=True)
class WindowPolicy:
    min_window_seconds: float = 1.75
    max_cue_seconds: float = 15.0
    max_windows: int = 4
    min_rms: float = 0.003
    min_active_fraction: float = 0.50
    max_clipped_fraction: float = 0.015
    pcm_tolerance_seconds: float = 0.15

    def __post_init__(self):
        if not (1 <= self.min_window_seconds <= 5 and
                2 * self.min_window_seconds <= self.max_cue_seconds <= 30 and
                2 <= self.max_windows <= 8 and 0 < self.min_rms < 1 and
                0 < self.min_active_fraction <= 1 and 0 <= self.max_clipped_fraction < 1 and
                0 <= self.pcm_tolerance_seconds <= 0.5):
            raise ValueError('Invalid window or signal threshold')


@dataclass(frozen=True)
class ShortCuePolicy:
    windows: WindowPolicy
    anchor_window_min: float
    continuation_window_min: float
    independent_anchor_min: float | None
    symmetric_min: float | None = None

    def __post_init__(self):
        if not (self.windows.max_windows == 2 and
                all(score is None or -1 <= score <= 1 for score in
                    (self.anchor_window_min, self.continuation_window_min,
                     self.independent_anchor_min, self.symmetric_min))):
            raise ValueError('Short cues require two independently measured windows')


@dataclass(frozen=True)
class AcousticPolicy:
    # Calibrate these cosine and margin thresholds on disjoint reviewed audio.
    same_window_min: float
    anchor_min: float
    rolling_min: float
    competing_margin: float
    windows: WindowPolicy = WindowPolicy()
    max_gap_seconds: float = 0.35
    max_overlap_seconds: float = 0.04
    max_anchor_age_seconds: float = 120.0
    max_anchors: int = 8
    short_cues: ShortCuePolicy | None = None
    symmetric: bool = False

    def __post_init__(self):
        if not (all(-1 <= score <= 1 for score in
                    (self.same_window_min, self.anchor_min, self.rolling_min)) and
                0 < self.competing_margin <= 2 and 0 <= self.max_gap_seconds <= 2 and
                0 <= self.max_overlap_seconds <= 0.25 and
                0 < self.max_anchor_age_seconds <= 600 and 1 <= self.max_anchors <= 32):
            raise ValueError('Invalid acoustic or continuity threshold')
        if self.short_cues is not None and not (
                self.short_cues.windows.max_cue_seconds == self.windows.min_window_seconds * 2 and
                self.short_cues.windows.min_window_seconds < self.windows.min_window_seconds):
            raise ValueError('Short-cue range must meet the lower bound of the normal range')


@dataclass(frozen=True)
class Cue:
    meeting_id: str
    session_id: str
    id: str
    start: float
    end: float
    substantive: bool = True
    flags: tuple[str, ...] = ()


@dataclass(frozen=True)
class NamedSeed:
    name: str
    role: str
    cue_id: str
    source: str


@dataclass
class _ActiveVoice:
    seed: NamedSeed
    anchor_start: float
    anchor: np.ndarray
    latest: np.ndarray
    latest_cue_id: str
    anchor_windows: tuple[np.ndarray, ...]
    latest_windows: tuple[np.ndarray, ...]
    anchor_short: bool
    latest_short: bool


def _unit(vector):
    if vector is None:
        return None
    array = np.asarray(vector, dtype=np.float32)
    if array.ndim != 1 or array.size == 0 or not np.all(np.isfinite(array)):
        return None
    norm = float(np.linalg.norm(array))
    return array / norm if math.isfinite(norm) and norm > 0.000001 else None


def _similarity(left, right):
    return float(np.clip(np.dot(left, right), -1, 1))


def _agreement(windows):
    return min(_similarity(a, b) for a, b in combinations(windows, 2))


def _float_pcm(pcm):
    if isinstance(pcm, bytes):
        if len(pcm) % 2:
            return None
        pcm = np.frombuffer(pcm, dtype='<i2')
    try:
        samples = np.asarray(pcm)
    except (TypeError, ValueError):
        return None
    if samples.ndim != 1 or samples.size == 0:
        return None
    if samples.dtype.kind == 'i' and samples.dtype.itemsize == 2:
        samples = samples.astype(np.float32) / 32768
    elif samples.dtype.kind == 'f':
        samples = samples.astype(np.float32, copy=False)
    else:
        return None
    if not np.all(np.isfinite(samples)) or np.max(np.abs(samples)) > 1:
        return None
    return samples


def _good_signal(samples, policy):
    frame_size = SAMPLE_RATE // 50
    used = len(samples) // frame_size * frame_size
    frames = samples[:used].reshape(-1, frame_size)
    # Frame-wise zero mean keeps a DC offset from being treated as activity.
    rms = np.std(frames, axis=1)
    return (np.mean(rms >= policy.min_rms) >= policy.min_active_fraction and
            np.mean(np.abs(samples) >= 0.995) <= policy.max_clipped_fraction)


def _speech_windows(extractor, pcm, policy, duration=None):
    samples = _float_pcm(pcm)
    if samples is None:
        return None, 'invalid_pcm'
    actual_duration = len(samples) / SAMPLE_RATE
    if duration is not None and abs(duration - actual_duration) > policy.pcm_tolerance_seconds:
        return None, 'pcm_interval_mismatch'
    if not 2 * policy.min_window_seconds <= actual_duration <= policy.max_cue_seconds:
        return None, 'cue_duration_out_of_range'
    count = min(policy.max_windows, int(actual_duration / policy.min_window_seconds))
    windows = np.array_split(samples, count)
    if not all(_good_signal(window, policy) for window in windows):
        return None, 'poor_window_signal'
    vectors = [_unit(extractor.embed(window)) for window in windows]
    if any(vector is None for vector in vectors) or len({vector.shape for vector in vectors}) != 1:
        return None, 'embedding_unavailable'
    return vectors, None


def compare_pcm(extractor: Extractor, reference_pcm, cue_pcm, windows: WindowPolicy = WindowPolicy()):
    """Return aggregate within/cross-window scores for manually reviewed pairs."""
    reference, reason = _speech_windows(extractor, reference_pcm, windows)
    if reference is None:
        return {'reason': 'reference_' + reason}
    current, reason = _speech_windows(extractor, cue_pcm, windows)
    if current is None:
        return {'reason': 'candidate_' + reason}
    if reference[0].shape != current[0].shape:
        return {'reason': 'embedding_dimension_mismatch'}
    centroid = _unit(np.mean(reference, axis=0))
    if centroid is None:
        return {'reason': 'reference_centroid_unavailable'}
    cross = [_similarity(vector, centroid) for vector in current]
    return {
        'reference_windows': len(reference), 'candidate_windows': len(current),
        'reference_agreement': round(_agreement(reference), 6),
        'candidate_agreement': round(_agreement(current), 6),
        'min_reference': round(min(cross), 6), 'max_reference': round(max(cross), 6),
    }


class AcousticTracker:
    def __init__(self, extractor: Extractor, policy: AcousticPolicy):
        self._extractor = extractor
        self._policy = policy
        self.reset()

    def reset(self):
        """Drop active and competing identity references at source discontinuity."""
        self._scope = None
        self._last = None
        self._active = None
        self._seed_anchors = {}

    def _abstain(self, reason, scores=None):
        self._active = None
        return {'status': 'abstain', 'reason': reason, 'candidate': None, 'scores': scores or {}}

    def update(self, cue: Cue, pcm, seed: NamedSeed | None = None):
        """Consume one causally ordered cue; return JSON-safe provenance and scores."""
        if not (cue.meeting_id and cue.session_id and cue.id and
                math.isfinite(cue.start) and math.isfinite(cue.end) and 0 <= cue.start < cue.end):
            return self._abstain('invalid_cue')
        scope = cue.meeting_id, cue.session_id
        if self._scope != scope:
            self.reset()
            self._scope = scope
        last = self._last
        if last and (cue.id == last.id or cue.start < last.start or cue.end <= last.end):
            self.reset()
            self._scope, self._last = scope, last
            return self._abstain('out_of_order')
        gap = round(cue.start - last.end, 3) if last else 0
        discontinuity = not -self._policy.max_overlap_seconds <= gap <= self._policy.max_gap_seconds
        self._last = Cue(cue.meeting_id, cue.session_id, cue.id, cue.start, cue.end)
        if discontinuity:
            self._active = None
            self._seed_anchors.clear()
        if not cue.substantive or UNCERTAIN_FLAGS.intersection(cue.flags):
            return self._abstain('weak_or_uncertain_cue')
        if seed is not None and (not seed.name.strip() or not seed.role.strip() or
                                 seed.cue_id != cue.id or seed.source not in SEED_SOURCES):
            return self._abstain('invalid_seed')
        active = self._active
        if seed is None and active is None:
            return self._abstain('discontinuity' if discontinuity else 'no_active_seed')
        if seed is None and cue.end - active.anchor_start > self._policy.max_anchor_age_seconds:
            return self._abstain('anchor_expired')

        duration = round(cue.end - cue.start, 3)
        short = self._policy.short_cues
        is_short = short is not None and duration < self._policy.windows.min_window_seconds * 2
        window_policy = short.windows if is_short else self._policy.windows
        minimum_agreement = (short.anchor_window_min if seed is not None else short.continuation_window_min
                             ) if is_short else self._policy.same_window_min
        windows, reason = _speech_windows(self._extractor, pcm, window_policy, duration)
        if windows is None:
            return self._abstain(reason)
        agreement = _agreement(windows)
        scores = {'window_count': len(windows), 'window_min': round(agreement, 6)}
        if agreement < minimum_agreement:
            return self._abstain('inconsistent_windows', scores)
        center = _unit(np.mean(windows, axis=0))
        if center is None:
            return self._abstain('embedding_centroid_unavailable', scores)
        if seed is not None:
            key = seed.name.strip()
            self._seed_anchors.pop(key, None)
            self._seed_anchors[key] = center
            while len(self._seed_anchors) > self._policy.max_anchors:
                del self._seed_anchors[next(iter(self._seed_anchors))]
            self._active = _ActiveVoice(seed, cue.start, center, center, cue.id,
                                       tuple(windows) if is_short or self._policy.symmetric else (),
                                       tuple(windows) if self._policy.symmetric else (), is_short, is_short)
            return {'status': 'anchored', 'reason': seed.source, 'candidate': None, 'scores': scores}

        competitors = [anchor for name, anchor in self._seed_anchors.items() if name != active.seed.name.strip()]
        if active.anchor.shape != center.shape or any(other.shape != center.shape for other in competitors):
            return self._abstain('embedding_dimension_mismatch', scores)
        anchor_scores = [_similarity(vector, active.anchor) for vector in windows]
        rolling_scores = [_similarity(vector, active.latest) for vector in windows]
        anchor_score, rolling_score = min(anchor_scores), min(rolling_scores)
        anchor_threshold, rolling_threshold = self._policy.anchor_min, self._policy.rolling_min
        if self._policy.symmetric:
            anchor_score = min(anchor_score, *(_similarity(center, vector) for vector in active.anchor_windows))
            rolling_score = min(rolling_score, *(_similarity(center, vector) for vector in active.latest_windows))
            if short and short.symmetric_min is not None:
                # Calibrated short-short pairs use their own score. Cross-length
                # identity claims retain the stricter of the two locked scores.
                if active.anchor_short and is_short:
                    anchor_threshold = short.symmetric_min
                elif active.anchor_short or is_short:
                    anchor_threshold = max(anchor_threshold, short.symmetric_min)
                if active.latest_short and is_short:
                    rolling_threshold = short.symmetric_min
                elif active.latest_short or is_short:
                    rolling_threshold = max(rolling_threshold, short.symmetric_min)
        scores.update(anchor_min=round(anchor_score, 6), rolling_min=round(rolling_score, 6))
        if anchor_score < anchor_threshold or rolling_score < rolling_threshold:
            return self._abstain('anchor_or_continuity_mismatch', scores)
        if active.anchor_short and short.independent_anchor_min is not None:
            support = min(_similarity(vector, anchor) for vector in windows for anchor in active.anchor_windows)
            scores['independent_short_anchor_min'] = round(support, 6)
            if support < short.independent_anchor_min:
                return self._abstain('short_anchor_windows_disagree', scores)
        if competitors:
            margin = min(score - max(_similarity(vector, other) for other in competitors)
                         for score, vector in zip(anchor_scores, windows))
            scores['competing_margin_min'] = round(margin, 6)
            if margin < self._policy.competing_margin:
                return self._abstain('competing_seed', scores)

        provenance = list(dict.fromkeys((active.seed.cue_id, active.latest_cue_id, cue.id)))
        active.latest = center
        active.latest_cue_id = cue.id
        active.latest_short = is_short
        if self._policy.symmetric:
            active.latest_windows = tuple(windows)
        return {
            'status': 'corroborated', 'reason': 'same_session_contiguous_acoustic_support',
            'candidate': {
                'name': active.seed.name.strip(), 'role': active.seed.role.strip(), 'confidence': 'low',
                'method': '외부 발언자 근거와 연속 음성 창의 유사도를 대조한 연구용 추정',
                'evidence': provenance, 'anchor_source': active.seed.source,
            },
            'scores': scores,
        }
