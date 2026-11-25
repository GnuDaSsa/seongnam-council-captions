/* 의원 이름을 위원회 명단으로 바로잡는다. "이름+의원/위원" 호칭 안에서, 명단과 유일하게 가까울 때만 바꾼다. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CouncilNameCorrection = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
  const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  const STRICT = 0.34;   // 자모 편집거리 / 명단 이름 자모 수
  const RELAXED = 0.6;   // 같은 성의 위원이 한 명뿐일 때
  const MARGIN = 0.12;   // 1·2위 차이
  // 이름 뒤에 호칭이 붙은 경우만 본다. "의원입니다"·"의원님" 모두 포함한다.
  const HONORIFIC = /([가-힣]{2,4})(\s*)(의원|부위원장|위원장|위원)(?=님|입니다|께서|께|은|는|이|가|,|\.|\s|$)/gu;
  // 호칭 앞에 붙어 이름으로 오인되기 쉬운 낱말
  const NOT_NAME = /^(?:부위원|위원|의원|국회|도의|시의|구의|본|전|현|동료|여러|우리|모든|해당|관계|소속|담당|여야|초선|재선|다선|비례)$/u;

  function jamo(text) {
    const out = [];
    for (const ch of String(text)) {
      const code = ch.charCodeAt(0) - 0xAC00;
      if (code < 0 || code >= 11172) continue;
      out.push(CHO[Math.floor(code / 588)], JUNG[Math.floor((code % 588) / 28)]);
      if (code % 28) out.push(JONG[code % 28]);
    }
    return out;
  }

  function distance(a, b) {
    let previous = Array.from({length: b.length + 1}, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      for (let j = 1; j <= b.length; j++) {
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      previous = current;
    }
    return previous[b.length];
  }

  /** 들린 이름을 명단의 한 사람으로 유일하게 대응시킨다. 모호하면 null. */
  function matchMember(heard, roster) {
    const name = String(heard ?? '').replace(/[^가-힣]/gu, '');
    const members = [...new Set((Array.isArray(roster) ? roster : []).map(item => String(item ?? '').trim()).filter(Boolean))];
    if (name.length < 2 || !members.length) return null;
    if (members.includes(name)) return name;
    const scored = members.map(member => ({member, score: distance(jamo(name), jamo(member)) / Math.max(jamo(member).length, 1)}))
      .sort((a, b) => a.score - b.score);
    const [best, second = {score: Infinity}] = scored;
    if (second.score - best.score < MARGIN) return null;
    if (best.score <= STRICT) return best.member;
    const sameSurname = members.filter(member => member[0] === name[0]);
    if (sameSurname.length === 1 && sameSurname[0] === best.member && best.score <= RELAXED && second.score - best.score >= 0.15) return best.member;
    return null;
  }

  /** 호칭 패턴 안의 이름만 명단 이름으로 바꾼다. 원문은 그대로 두고 바꾼 목록을 함께 돌려준다. */
  function correct(input, roster) {
    const text = String(input ?? '');
    const changes = [];
    const output = text.replace(HONORIFIC, (matched, heard, space, title, offset) => {
      // "서은경이 형님"처럼 이름 뒤에 조사 '이'가 붙어 들린 경우를 위해 끝 '이'를 한 번 떼어 본다
      const candidates = [heard, heard.length > 2 && heard.endsWith('이') ? heard.slice(0, -1) : null].filter(Boolean);
      for (const candidate of candidates) {
        if (NOT_NAME.test(candidate)) continue;
        // "부위원장"처럼 호칭 낱말의 일부인 경우를 건너뛴다
        if (/[가-힣]/u.test(text[offset - 1] || '') && candidate === heard) continue;
        const official = matchMember(candidate, roster);
        if (!official) continue;
        if (official === heard) return matched;
        changes.push({heard, official});
        return official + space + title;
      }
      return matched;
    });
    return {text: output, changed: changes.length > 0, changes};
  }

  return Object.freeze({jamo, distance, matchMember, correct});
});
