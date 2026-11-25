/* 자막 표시용 점검: 표결 인원 숫자 표기, 합계 불일치, 뜻이 뒤집힐 수 있는 낱말. 원문은 바꾸지 않는다. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CouncilCaptionChecks = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const SINO = {일:1, 이:2, 삼:3, 사:4, 오:5, 육:6, 륙:6, 칠:7, 팔:8, 구:9};
  const NATIVE_UNITS = {한:1, 하나:1, 두:2, 둘:2, 세:3, 셋:3, 네:4, 넷:4, 다섯:5, 여섯:6, 일곱:7, 여덟:8, 아홉:9};
  const NATIVE_TENS = {열:10, 스물:20, 스무:20, 서른:30, 마흔:40, 쉰:50};
  const VOTE_LABEL = '(재적|재석|출석|찬성|반대|기권)';
  const VOTE_MEMBER = '(?:\\s*(?:의원|위원))?';
  const SINO_WORD = '[일이삼사오육륙칠팔구십백]+';
  const NATIVE_WORD = '(?:열|스물|스무|서른|마흔|쉰)?\\s*(?:하나|한|둘|두|셋|세|넷|네|다섯|여섯|일곱|여덟|아홉)?';

  /** 한자어 수사(일~구백구십구)를 숫자로 바꾼다. 해석할 수 없으면 null. */
  function sinoNumber(word) {
    if (!/^[일이삼사오육륙칠팔구십백]+$/u.test(word)) return null;
    let total = 0, digit = 0;
    for (const ch of word) {
      if (ch === '백' || ch === '십') {
        const unit = ch === '백' ? 100 : 10;
        total += (digit || 1) * unit;
        digit = 0;
      } else {
        if (digit) return null; // "이삼"처럼 단위 없이 이어진 수사는 모호하다
        digit = SINO[ch];
      }
    }
    return total + digit;
  }

  /** 고유어 수사(한~쉰아홉)를 숫자로 바꾼다. 해석할 수 없으면 null. */
  function nativeNumber(word) {
    const compact = word.replace(/\s+/gu, '');
    if (!compact) return null;
    const tens = Object.keys(NATIVE_TENS).find(key => compact.startsWith(key));
    const rest = tens ? compact.slice(tens.length) : compact;
    if (rest && !(rest in NATIVE_UNITS)) return null;
    const value = (tens ? NATIVE_TENS[tens] : 0) + (rest ? NATIVE_UNITS[rest] : 0);
    return value || null;
  }

  // 단위 뒤에는 조사·문장부호·공백만 허용한다 ("찬성이 인정" 같은 오탐 방지)
  const UNIT_END = '(?=[\\s.,·)이으입에과와은는도의중]|$)';
  const VOTE = new RegExp(VOTE_LABEL + '(' + VOTE_MEMBER + ')\\s*(' + SINO_WORD + '|' + NATIVE_WORD + ')\\s*(인|명|표)' + UNIT_END, 'gu');

  /** "재석의원 육인" → "재석의원 6인". 해석한 표결 인원 목록과 바꾼 문장을 돌려준다. */
  function voteNumbers(input) {
    const text = String(input ?? '');
    const counts = [];
    const labels = (text.match(new RegExp(VOTE_LABEL, 'gu')) || []).length;
    const output = text.replace(VOTE, (matched, label, member, word, unit) => {
      const compact = word.replace(/\s+/gu, '');
      if (!compact) return matched;
      // 한 글자 수사(이·사·오 등)는 조사·일반어와 겹치므로 "의원/위원"이 붙었거나 표결 낱말이 둘 이상인 줄에서만 해석한다
      if (compact.length === 1 && !member && labels < 2) return matched;
      const value = sinoNumber(compact) ?? nativeNumber(word);
      if (value == null || value > 999) return matched;
      counts.push({label, value});
      return label + member + ' ' + value + unit;
    });
    return {text: output, changed: output !== text, counts};
  }

  /** 아라비아 숫자로 이미 적힌 표결 인원도 함께 모은다. */
  function voteCounts(text) {
    const counts = voteNumbers(text).counts;
    const digits = new RegExp(VOTE_LABEL + VOTE_MEMBER + '\\s*(\\d{1,3})\\s*(?:인|명|표)' + UNIT_END, 'gu');
    for (const match of String(text ?? '').matchAll(digits)) counts.push({label: match[1], value: Number(match[2])});
    return counts;
  }

  /** 찬성+반대+기권이 재석(출석) 인원과 맞지 않으면 숫자 확인 사유를 돌려준다. */
  function sumCheck(text) {
    const counts = voteCounts(text);
    const first = label => counts.find(item => item.label === label)?.value;
    const present = first('재석') ?? first('출석');
    const parts = ['찬성', '반대', '기권'].map(first);
    if (present == null || parts.every(value => value == null)) return null;
    const sum = parts.reduce((total, value) => total + (value ?? 0), 0);
    const known = parts.every(value => value != null);
    if (sum > present || (known && sum !== present)) {
      return {kind: 'number_check', reason: `표결 합계 ${sum}인과 재석 ${present}인이 맞지 않음`};
    }
    return null;
  }

  // 발음이 가까워 음성인식이 서로 바꾸기 쉽고, 바뀌면 뜻이 뒤집히는 낱말. 문맥 단서가 있을 때만 표시한다.
  const WORD_RULES = [
    {heard: /제한(?:합니다|하겠습니다|드립니다|설명)/u, context: /안건|조례안|개정안|동의안|제안|설명|상정/u,
      reason: "'제안'을 '제한'으로 들었을 수 있음"},
    {heard: /제안(?:합니다|하겠습니다)/u, context: /금지|초과|이용|출입|속도|구역|범위/u,
      reason: "'제한'을 '제안'으로 들었을 수 있음"}
  ];

  /** 뜻이 뒤집혔을 수 있는 낱말이 든 줄에 낱말 확인 사유를 돌려준다. */
  function wordChecks(input) {
    const text = String(input ?? '');
    return WORD_RULES.filter(rule => rule.heard.test(text) && rule.context.test(text))
      .map(rule => ({kind: 'word_check', reason: rule.reason}));
  }

  /** 한 줄에 대한 표시 텍스트와 점검 결과를 한 번에 계산한다. */
  function review(input) {
    const numbers = voteNumbers(input);
    const checks = [sumCheck(numbers.text), ...wordChecks(numbers.text)].filter(Boolean);
    return {text: numbers.text, changed: numbers.changed, checks};
  }

  return Object.freeze({sinoNumber, nativeNumber, voteNumbers, sumCheck, wordChecks, review});
});
