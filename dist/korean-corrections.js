/* Meeting transcription defaults to 갈음 while protecting explicit distinction contexts. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CouncilKoreanCorrections = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const distinction = /성패|승패|우열|진위|시비|흑백|승부|당락|경중|잘잘못|옳고\s*그름|책임\s*소재|누가\s*(?:옳|맞)|(?:자리|길|경계|몫|구역|구획|영역|순위)\s*(?:을|를|은|는|이|가)?\s*$/u;
  const distinctionAfter = /성패|승패|우열|진위|시비|흑백|승부|당락|경중|잘잘못|옳고\s*그름|책임\s*소재/u;
  const medium = /(?:서면|자료|유인물|설명서|이것|문서|서류|보고서|회의록)(?:으로|로)(?:써)?/u;
  const attachedMedium = /(?:서면|자료|유인물|설명서|이것|문서|서류|보고서|회의록)(?:으로|로)(?:써)?$/u;

  function correct(input) {
    const original = String(input ?? '');
    let cursor = 0;
    let result = '';
    let previous = -1;
    for (const match of original.matchAll(/가름/gu)) {
      const position = match.index;
      const before = original.slice(0, position);
      const tail = original.slice(position + match[0].length);
      const sentenceBefore = before.split(/[.!?。？！;\n]/u).pop();
      const relativePrevious = previous >= 0 && position - previous <= sentenceBefore.length
        ? previous + 2 - (position - sentenceBefore.length) : 0;
      const clause = sentenceBefore.slice(Math.max(0, relativePrevious));
      const after = tail.split(/[.!?。？！;\n]|(?:보고|답변|설명|브리핑)(?:은|는)/u)[0];
      const isAttached = position > 0 && /[가-힣A-Za-z0-9]/u.test(original[position - 1]);
      const allowedAttachment = attachedMedium.test(sentenceBefore);
      const hasMedium = medium.test(clause);
      const verb = /^[ \t]*(?:하|합|할|한|함|해|했)/u.test(tail);
      const passive = /^[ \t]*(?:되|됩|됐)/u.test(tail);
      const nominalVerb = /^을[ \t]*(?:하|합|할|한|함|해|했)/u.test(tail);
      const terminal = /^[ \t]*(?:[.!?。？！,;]|$)/u.test(tail);
      const eligible = (!isAttached || allowedAttachment) &&
        (verb || (hasMedium && (passive || nominalVerb || terminal))) &&
        !distinction.test(clause) && !distinctionAfter.test(after);
      result += original.slice(cursor, position) + (eligible ? '갈음' : match[0]);
      cursor = position + match[0].length;
      previous = position;
    }
    result += original.slice(cursor);
    return {text: result, changed: result !== original};
  }
  return Object.freeze({correct});
});
