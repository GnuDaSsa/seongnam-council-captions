(() => {
  'use strict';

  // Conservative text-only hints. These are review suggestions, never verified identities.
  const SELF_INTRO = [
    /(?:안녕하십니까|안녕하십니까\s*\?)\s*([가-힣]{2,4})\s*(의원|위원장)\s*입니다/,
    /저는\s*([가-힣]{2,4})\s*(의원|위원장)?\s*입니다/,
    /저\s*([가-힣]{2,4})\s*(의원|위원장)\s*입니다/
  ];
  const OFFICIAL_INTRO = /(?:^|[,，.!?。]\s*)(?:저는\s*)?((?:[가-힣]{1,8}(?:시장|부시장|국장|과장|팀장|실장|본부장|센터장|원장|주무관))|(?:시장|부시장|국장|과장|팀장|실장|본부장|센터장|원장|주무관))\s*([가-힣]{2,4})\s*입니다/;
  const SHORT_RESPONSE = /^(?:네|예|아니요|아닙니다|맞습니다|알겠습니다|감사합니다|예\s*,?\s*감사합니다|네\s*,?\s*감사합니다)[.!?。\s]*$/;
  const BRIEF_ADDRESSED_ACK = /^(?:네|예)\s*[,，]\s*(?:과장님|국장님|팀장님|실장님|본부장님|센터장님|원장님|위원장님|의원님)\s*[.!?。\s]*$/;
  const DIRECTIVE = '(?:질의|질문|발언|말씀)(?:을|를)?\\s*(?:해\\s*주시고|해\\s*주시기\\s*바랍니다|해\\s*주시죠|하시기\\s*바랍니다|하시고|하시죠|하십시오|해\\s*주세요|부탁드립니다)';
  const MIN_SUBSTANTIVE = 12;

  function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function membersOf(meeting) {
    return [...new Set((Array.isArray(meeting?.members) ? meeting.members : [])
      .map(clean).filter(name => /^[가-힣]{2,4}$/.test(name)))];
  }
  function cueText(cue) { return clean(cue?.text || cue?.rawText); }
  function cueId(cue) { return cue && cue.id != null ? String(cue.id) : ''; }
  function safeId(id) { return !!id && !['__proto__', 'constructor', 'prototype'].includes(id); }
  function uncertain(cue, allowNameFlag = false) {
    const flags = Array.isArray(cue?.flags) ? cue.flags : [];
    return !!cue?.rejected || flags.some(flag => ['low_confidence', 'severe_uncertainty', 'repetition', 'segment_review'].includes(flag) || (!allowNameFlag && flag === 'name'));
  }
  function substantive(text) {
    if (!text || SHORT_RESPONSE.test(text)) return false;
    const korean = (text.match(/[가-힣]/g) || []).length;
    if (korean < MIN_SUBSTANTIVE) return false;
    // A chunk with explicit changes of addressee or multiple floor signals is not one speaker.
    if (/(?:잠깐만요|끼어들|제가 한 말씀|보충해서|추가로 말씀|다른 위원님|위원장님,?\s*제가)/.test(text)) return false;
    return true;
  }
  function quotedIntro(text, match) {
    const tail = text.slice(match.index + match[0].length);
    return /^\s*(?:라고|라며|이라고|이라며)/.test(tail) || /(?:라고|라며)\s*(?:소개|말씀|설명|전했|하셨)/.test(text);
  }
  function explicitSelfIntro(text, members) {
    const found = [];
    for (const pattern of SELF_INTRO) {
      for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
        const name = match[1], role = match[2] || '의원';
        if (members.includes(name) && !quotedIntro(text, match)) found.push({ name, role, pattern });
      }
    }
    const names = [...new Set(found.map(item => item.name))];
    if (names.length !== 1) return null;
    const candidate = found.find(item => item.name === names[0]);
    return { name: names[0], role: candidate.role };
  }
  function explicitOfficialIntro(text) {
    const match = text.match(OFFICIAL_INTRO);
    return match && !quotedIntro(text, match) ? { name: match[2], role: match[1] } : null;
  }
  function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function recognizedMember(text, members) {
    const matches = [];
    for (const name of members) {
      const pattern = new RegExp(`${escapeRegExp(name)}\\s*((?<!부)위원장|의원|(?<!부)위원)\\s*(?:님)?[\\s,，]*(?:${DIRECTIVE})`);
      const match = text.match(pattern);
      if (match) matches.push({ name, role: /(?<!부)위원장/.test(match[1]) ? '위원장' : '의원', match });
    }
    // Multiple named members or a cited/reported call cannot establish who has the floor.
    const mentioned = members.filter(name => text.includes(name));
    if (matches.length !== 1 || mentioned.length !== 1 || quotedIntro(text, matches[0].match)) return null;
    return matches[0];
  }

  function guesses(meeting, cues) {
    const result = {};
    if (!meeting || !Array.isArray(cues)) return result;
    const members = membersOf(meeting);
    if (!members.length) return result;
    const ordered = cues.map((cue, index) => ({ cue, index, start: Number(cue?.start) }))
      .filter(item => cueId(item.cue));
    const allTimed = ordered.every(item => Number.isFinite(item.start));
    ordered.sort((a, b) => allTimed ? a.start - b.start || a.index - b.index : a.index - b.index);

    for (let i = 0; i < ordered.length; i++) {
      const { cue } = ordered[i], text = cueText(cue), id = cueId(cue);
      if (!safeId(id)) continue;
      if (uncertain(cue, true)) continue;
      const self = explicitSelfIntro(text, members);
      if (self) {
        result[id] = { name: self.name, role: self.role, confidence: 'medium', evidence: [id], method: '명부 이름의 명시적 자기소개 문구' };
        continue;
      }
      const official = explicitOfficialIntro(text);
      if (official && !members.includes(official.name)) {
        result[id] = { name: official.name, role: official.role, confidence: 'low', evidence: [id], method: '직책과 이름을 포함한 자기소개 문구(명부 미대조)' };
        continue;
      }

      // A call identifies the next cue only. Do not skip an acknowledgement/interjection.
      const called = recognizedMember(text, members);
      if (!called || uncertain(cue, true) || i + 1 >= ordered.length) continue;
      const next = ordered[i + 1].cue, nextText = cueText(next), nextId = cueId(next);
      const briefAck = BRIEF_ADDRESSED_ACK.test(nextText);
      if ((!substantive(nextText) && !briefAck) || uncertain(next) || nextId === id || !safeId(nextId)) continue;
      if (members.some(name => nextText.includes(name))) continue;
      const gap = Number(next?.start) - Number(cue?.end);
      if (!Number.isFinite(gap) || gap < 0 || gap > 15) continue;
      result[nextId] = {
        name: called.name,
        role: called.role,
        confidence: 'low',
        evidence: [id, nextId],
        method: briefAck ? '명부의 직접 호명 직후 상대 직책을 부른 짧은 응답(수동 확인 필요)' : '명부의 직접 호명 직후 연속된 한 구간 추정'
      };
    }
    return result;
  }

  const api = Object.freeze({ guesses });
  if (typeof window !== 'undefined') window.CouncilSpeakerReview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
