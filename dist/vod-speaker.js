(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CouncilVodSpeaker = api;
})(typeof window === 'undefined' ? globalThis : window, function (root) {
  'use strict';
  const policy = Object.freeze({
    minCharacters: 12,
    minTrigrams: 8,
    bigramShare: 0.66,
    trigramShare: 0.54,
    minCoverage: 0.85,
    maxEdgeDrift: 0.75,
    maxInternalGap: 0.25,
  });
  const suspectFlags = new Set(['low_confidence', 'severe_uncertainty', 'repetition', 'segment_review']);
  const minutesUrl = /^https:\/\/www\.sncouncil\.go\.kr\/record\/recordView\.do\?key=[a-f0-9]+$/;
  const roles = '센터장|담당관|주무관|위원장|의장|부의장|부시장|시장|과장|국장|팀장|부장|소장|의원|위원';
  const knownRole = new RegExp('(?:' + roles + ')$');
  const generic = /^(?:네|예|아)?(?:알겠습니다|잘알겠습니다|그렇게하겠습니다|그부분은그렇게하겠습니다|수고하셨습니다|감사합니다|말씀드리겠습니다|답변드리겠습니다)$/;
  const mixedTurn = /[.!?。！？]\s*(?:네|예|아니요|아닙니다)(?=\s|[,.!?，。！？]|$)/;
  const textOf = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
  const compact = value => textOf(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  function knownVod(meeting) {
    if (!meeting || !/^\d{1,12}$/.test(meeting.id) || !minutesUrl.test(meeting.minutesUrl)) return false;
    try {
      const page = new URL(meeting.officialPage);
      const ids = page.searchParams.getAll('pk_vod_no');
      return page.origin === 'https://cast.sncouncil.go.kr' && page.pathname === '/vod/vod_view.jsp' &&
        !page.username && !page.password && ids.length === 1 && ids[0] === String(meeting.id);
    } catch {
      return false;
    }
  }

  function validInterval(cue) {
    return Number.isFinite(cue?.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start;
  }

  function speakerOf(cue) {
    const label = textOf(cue.speaker);
    const named = /^([가-힣]{2,4}) (.+)$/.exec(label);
    if (named && knownRole.test(named[2])) return { name: named[1], role: named[2] };
    const reversed = /^(.+) ([가-힣]{2,4})$/.exec(label);
    if (reversed && knownRole.test(reversed[1])) return { name: reversed[2], role: reversed[1] };
    return null;
  }

  function conflictsWithIntro(text, speaker) {
    const title = '([가-힣]{0,24}(?:' + roles + '))';
    const nameFirst = new RegExp('(?:^|[^가-힣])([가-힣]{2,4})\\s*' + title + '\\s*입니다', 'g');
    const roleFirst = new RegExp('(?:^|[^가-힣])' + title + '\\s+([가-힣]{2,4})\\s*입니다', 'g');
    const roleAgrees = role => knownRole.exec(speaker.role)?.[0] === knownRole.exec(role)?.[0];
    for (const [, name, role] of text.matchAll(nameFirst)) {
      if (name !== speaker.name || !roleAgrees(role)) return true;
    }
    for (const [, role, name] of text.matchAll(roleFirst)) {
      if (name !== speaker.name || !roleAgrees(role)) return true;
    }
    return [...text.matchAll(/(?:^|[^가-힣])(?:저는|제가|제\s*이름은)\s*([가-힣]{2,4})\s*입니다/g)]
      .some(([, name]) => name !== speaker.name);
  }

  function grams(value, width) {
    const counts = new Map();
    for (let start = 0; start + width <= value.length; start++) {
      const unit = value.slice(start, start + width);
      counts.set(unit, (counts.get(unit) || 0) + 1);
    }
    return counts;
  }

  function sharedGrams(local, reference, width) {
    const available = grams(reference, width);
    let shared = 0;
    for (const [key, count] of grams(local, width)) shared += Math.min(count, available.get(key) || 0);
    return shared;
  }

  function covers(local, references) {
    let covered = 0;
    let through = local.start;
    for (const row of references) {
      const from = Math.max(row.start, local.start);
      const limit = through === local.start ? policy.maxEdgeDrift : policy.maxInternalGap;
      if (from - through > limit) return false;
      const end = Math.min(row.end, local.end);
      covered += Math.max(0, end - Math.max(through, from));
      through = Math.max(through, end);
    }
    return local.end - through <= policy.maxEdgeDrift && covered / (local.end - local.start) >= policy.minCoverage;
  }

  function assess(meeting, cue) {
    if (!knownVod(meeting) || cue?.source !== 'local' || cue.meetingId !== String(meeting.id) ||
        !textOf(cue.id) || !validInterval(cue) || cue.rejected ||
        (Array.isArray(cue.flags) && cue.flags.some(flag => suspectFlags.has(flag)))) return;
    if (!Array.isArray(meeting.cues)) return;
    const references = meeting.cues.filter(row => row?.source === 'minutes_aligned' && validInterval(row) &&
      row.start < cue.end && row.end > cue.start).sort((a, b) => a.start - b.start);
    if (!references.length) return;
    const speaker = speakerOf(references[0]);
    if (!speaker || references.some(row => {
      const label = speakerOf(row);
      return label?.name !== speaker.name || label?.role !== speaker.role || !textOf(row.text) ||
        typeof row.id !== 'string' || !row.id.startsWith(String(meeting.id) + '-') ||
        /chapter/i.test(row.timingPrecision || '');
    })) return { blocked: true };
    const heard = textOf(cue.text), raw = textOf(cue.rawText);
    if (mixedTurn.test(heard) || mixedTurn.test(raw) || conflictsWithIntro(heard, speaker) ||
        (raw !== heard && conflictsWithIntro(raw, speaker))) return { blocked: true };

    const local = compact(heard);
    if (!covers(cue, references) || local.length < policy.minCharacters || generic.test(local) ||
        root.CouncilQuality?.repeated(heard) || root.CouncilQuality?.repeated(raw)) return;

    // Adjacent checked excerpts from the same speaker can support a local chunk.
    // Keep each passage's text separate so the join cannot create matching grams.
    const official = references.map(row => compact(row.text)).join(' ');
    const bigrams = sharedGrams(local, official, 2);
    const trigrams = sharedGrams(local, official, 3);
    if (bigrams / (local.length - 1) < policy.bigramShare ||
        trigrams < policy.minTrigrams || trigrams / (local.length - 2) < policy.trigramShare) return;

    return { speaker: {
      ...speaker,
      confidence: 'low',
      method: '개인 자막의 재생 시각과 발언 내용이 공식 회의록 대조 구간과 일치해 추정',
      evidence: [cue.id],
      officialReference: { vodId: String(meeting.id), minutesUrl: meeting.minutesUrl, cueIds: references.map(row => row.id) },
    } };
  }

  function match(meeting, cue) {
    return assess(meeting, cue)?.speaker;
  }
  return Object.freeze({ assess, match });
});
