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
    return match && !quotedIntro(text, match) ? { name: match[2], role: '집행부(직위 확인 필요)' } : null;
  }
  function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function recognizedMember(text, members) {
    const matches = [];
    for (const name of members) {
      const pattern = new RegExp(`${escapeRegExp(name)}\\s*((?<!부)위원장|의원|(?<!부)위원)\\s*(?:님)?[\\s,，]*(?:${DIRECTIVE})`);
      const match = text.match(pattern);
      if (match) {
        matches.push({ name, role: /(?<!부)위원장/.test(match[1]) ? '위원장' : '의원', match, kind: 'direct' });
        continue;
      }
      // This exact ASR substitution is accepted only with the next cue's explicit
      // citation to a different committee member's earlier remarks.
      const observedMishear = new RegExp(`${escapeRegExp(name)}\\s*의원\\s*님[,，\\s]*지리하시러`);
      const misheard = text.match(observedMishear);
      if (misheard) matches.push({ name, role: '의원', match: misheard, kind: 'misheard_query' });
    }
    // Multiple named members or a cited/reported call cannot establish who has the floor.
    const mentioned = members.filter(name => text.includes(name));
    if (matches.length !== 1 || mentioned.length !== 1 || quotedIntro(text, matches[0].match)) return null;
    return matches[0];
  }
  function citesEarlierMember(text, members, calledName) {
    const cited = members.filter(name => name !== calledName && new RegExp(`^(?:아까\\s*)?앞서\\s*${escapeRegExp(name)}\\s*(?:의원|위원장)\\s*님?\\s*말씀하셨던`).test(text));
    const mentioned = members.filter(name => text.includes(name));
    return cited.length === 1 && mentioned.length === 1 ? cited[0] : null;
  }
  function proceduralRole(text, members) {
    if (!text || members.some(name => text.includes(name))) return null;
    if (/(?:라고|라며|선포했다고|선포하셨다고|선포했다|선포하셨다)/.test(text)) return null;
    const body = text.replace(/\s*(?:안녕하십니까|안녕하십니까\s*[?？])\s*$/, '').trim();
    if (/[?？]|(?:^|[.!。]\s*)(?:네|예|아니요)\s*[,，.!?。]/.test(body)) return null;
    const opening = /(?:개회|개의)(?:를)?\s*(?:선포합니다|선포하겠습니다|하겠습니다|합니다)[.!。]*(?:\s*(?:존경하는|동료위원|여러분|그리고)[^?？]{0,100})?$/.test(body) &&
      (/(?:성원이\s*되었으므로|(?:위원회|본회의|회의)\s*(?:를\s*)?(?:개회|개의))/.test(body));
    if (opening) return '개회 또는 개의 정형 진행 문구(실명 미확인)';
    if (/산회(?:를)?\s*선포(?:합니다|하겠습니다)[.!。]*$/.test(body)) return '산회 선포 정형 진행 문구(실명 미확인)';
    if (/가결되었음을\s*선포(?:합니다|하겠습니다)[.!。]*$/.test(body)) return '가결 선포 정형 진행 문구(실명 미확인)';
    return null;
  }

  function guesses(meeting, cues) {
    const result = {};
    if (!meeting || !Array.isArray(cues)) return result;
    const members = membersOf(meeting);
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
        result[id] = { name: official.name, role: official.role, confidence: 'low', evidence: [id], method: '직책·이름 자기소개 문구(성명 명부 미대조, 직위 원문 확인 필요)' };
        continue;
      }
      const procedure = proceduralRole(text, members);
      if (procedure) {
        result[id] = { name: '', role: '의사진행자', confidence: 'medium', evidence: [id], method: procedure };
        continue;
      }

      // A call identifies the next cue only. Do not skip an acknowledgement/interjection.
      const called = recognizedMember(text, members);
      if (!called || uncertain(cue, true) || i + 1 >= ordered.length) continue;
      const next = ordered[i + 1].cue, nextText = cueText(next), nextId = cueId(next);
      const briefAck = BRIEF_ADDRESSED_ACK.test(nextText);
      const citedMember = citesEarlierMember(nextText, members, called.name);
      if ((!substantive(nextText) && !briefAck) || nextId === id || !safeId(nextId)) continue;
      if (called.kind === 'misheard_query' && !citedMember) continue;
      if (members.some(name => nextText.includes(name)) && !(called.kind === 'misheard_query' && citedMember)) continue;
      if (uncertain(next, called.kind === 'misheard_query' && !!citedMember)) continue;
      const gap = Number(next?.start) - Number(cue?.end);
      if (!Number.isFinite(gap) || gap < 0 || gap > 15) continue;
      result[nextId] = {
        name: called.name,
        role: called.role,
        confidence: 'low',
        evidence: [id, nextId],
        method: called.kind === 'misheard_query' ? '호명 단어 오인식 가능성 + 직후 다른 의원의 선행 발언 인용(수동 확인 필요)' :
          briefAck ? '명부의 직접 호명 직후 상대 직책을 부른 짧은 응답(수동 확인 필요)' : '명부의 직접 호명 직후 연속된 한 구간 추정'
      };
    }
    return result;
  }

  const api = Object.freeze({ guesses });
  if (typeof window !== 'undefined') window.CouncilSpeakerReview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
