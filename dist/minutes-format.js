(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) { require('./asr/quality.js'); root.CouncilKoreanCorrections = require('./korean-corrections.js'); }
  const api = factory(root.CouncilQuality, root.CouncilKoreanCorrections);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CouncilMinutesFormat = api;
})(typeof window !== 'undefined' ? window : globalThis, function (quality, corrections) {
  'use strict';

  function stamp(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(part => String(part).padStart(2, '0')).join(':');
  }

  function date(value) {
    if (value == null || value === '') return '확인 불가';
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleString('ko-KR', {timeZone:'Asia/Seoul', hour12:false}) : '확인 불가';
  }

  function bad(cue) {
    return !!cue.rejected || cue.flags?.includes('severe_uncertainty') || cue.flags?.includes('repetition') ||
      (cue.flags?.includes('low_confidence') && cue.text === '[음성 재확인]') ||
      !!quality?.repeated(cue.text) || !!quality?.repeated(cue.rawText);
  }

  function initial(cue) {
    if (bad(cue)) return '[음성 인식 오류 · 원음 재확인 필요]';
    const source = cue.flags?.includes('segment_review') ? cue.rawText || '[원문 없음 · 재확인 필요]' : cue.text || cue.rawText || '';
    return corrections ? corrections.correct(source).text : String(source);
  }

  function tidy(text) {
    return String(text || '').replace(/\r\n?/g, '\n').split('\n')
      .map(line => line.replace(/[^\S\n]+/g, ' ').replace(/(?:그\.\.\.[ \t]*){2,}/g, '그... ').trim())
      .join('\n').trim();
  }

  function isDuplicate(cue, cues, edited = false, isBad = () => false) {
    if (!cue.flags?.includes('segment_review') || !cue.rawText || isBad(cue) || edited) return false;
    return cues.some(other => other !== cue && !other.flags?.includes('segment_review') && !isBad(other) &&
      Number(other.start) < Number(cue.end) && Number(other.end) > Number(cue.start) &&
      String(other.rawText || other.text || '').trim() === String(cue.rawText).trim());
  }

  function acknowledgement(text) {
    return /^(?:네|예|응|아니요|아니오)[.!?。？！,\s]*$/.test(text);
  }

  function manuallyChanged(text, original, info) {
    return text !== original || !!info.speaker || !!info.confirmed || (!!info.kind && info.kind !== '일반 발언');
  }

  function canJoin(previous, next, gaps) {
    const first = previous.cue, second = next.cue;
    if (!previous.speaker || previous.speaker !== next.speaker) return false;
    if (previous.kind !== '일반 발언' || next.kind !== '일반 발언' || previous.confirmed || next.confirmed) return false;
    if (first.flags?.length || second.flags?.length || previous.bad || next.bad) return false;
    if (!previous.text || !next.text || previous.text.includes('\n') || next.text.includes('\n')) return false;
    if (acknowledgement(previous.text) || acknowledgement(next.text)) return false;
    if (/[.!?。？！…]$/.test(previous.text) || /(습니다|습니까|입니다|합니다|이다|있다|없다|해요|돼요|인가요|죠|네요|예요|됩니다)$/.test(previous.text)) return false;
    const delta = Number(second.start) - Number(first.end);
    if (!Number.isFinite(delta) || delta < 0 || delta > 2) return false;
    const begin = Date.parse(first.observedAt), end = Date.parse(second.observedAt);
    if (!Number.isFinite(begin) || !Number.isFinite(end) || end < begin) return false;
    return !gaps.some(gap => {
      const start = Date.parse(gap.start), finish = gap.end ? Date.parse(gap.end) : Infinity;
      return !Number.isFinite(start) || Number.isNaN(finish) || (start <= end && finish >= begin);
    });
  }

  function lines({meeting, archive, read, meta, coverage, bad: isBad, initial: defaultText}) {
    const cues = archive.cues;
    const gaps = archive.gaps || [];
    const rows = [];
    let previous = null;
    for (const cue of cues) {
      const info = meta(cue);
      if (isDuplicate(cue, cues, manuallyChanged(read(cue), defaultText(cue), info), isBad)) {
        previous = null;
        continue;
      }
      const current = {
        cue, speaker: String(info.speaker || '').trim(), kind: info.kind || '일반 발언',
        confirmed: !!info.confirmed, bad: isBad(cue), text: tidy(read(cue)),
        time: cue.observedAt ? Date.parse(cue.observedAt) : NaN
      };
      if (previous && canJoin(previous, current, gaps)) {
        previous.row.text += ' ' + current.text;
        current.row = previous.row;
      } else {
        current.row = {time: current.time, order: rows.length, text: current.text,
          prefix: `[${stamp(cue.start)}] ○${current.speaker || '발언자 미확인'}${cue.flags?.includes('segment_review') ? ' (시간 불확실)' : ''}  `};
        rows.push(current.row);
      }
      previous = current;
    }
    for (const gap of gaps) {
      const time = Date.parse(gap.start);
      if (!Number.isFinite(time)) continue;
      rows.push({time, order:rows.length, prefix:'',
        text:`(${date(gap.start)} ~ ${gap.end ? date(gap.end) : '수집 재개 대기'} 수집 중단 · 시간 추정)`});
    }
    rows.sort((a, b) => (Number.isFinite(a.time) ? a.time : Infinity) -
      (Number.isFinite(b.time) ? b.time : Infinity) || a.order - b.order);
    const out = [`${meeting.title} ${meeting.label || ''}`.trim(), '회의록 초안',
      `회의일  ${meeting.scheduledAt?.slice(0,10) || '미확인'}`, `회의체  성남시의회 ${meeting.title}`,
      `원본 영상  ${meeting.source || '미확인'}`, `수집 범위  ${coverage}`];
    if (meeting.agenda?.length) out.push('', '안건', ...meeting.agenda.map((item, i) => `${i + 1}. ${item}`));
    const confirmed = cues.filter(cue => meta(cue).confirmed && ['자료 제출 요청','의결'].includes(meta(cue).kind));
    if (confirmed.length) {
      out.push('', '담당자가 확인한 자료 제출 요청·의결', ...confirmed.map(cue =>
        `[${meta(cue).kind}] ${tidy(read(cue))} (근거 ${stamp(cue.start)})`));
    }
    out.push('', '발언 기록', ...rows.map(row => row.prefix + row.text));
    return out;
  }
  return Object.freeze({bad, initial, tidy, isDuplicate, manuallyChanged, canJoin, lines});
});
