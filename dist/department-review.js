(() => {
  'use strict';
  // Reviewed against committee VOD and minutes. Only the selected meeting's
  // published agenda can supply a candidate. The editor decides whether to use it.
  const variants = new Map([['자원수란과', '자원순환과']]);
  function suggestions(text, agenda) {
    if (typeof text !== 'string' || !Array.isArray(agenda)) return [];
    const results = [];
    for (const [heard, official] of variants) {
      if (agenda.includes(official) && text.includes(heard)) results.push({heard, official});
    }
    return results;
  }
  globalThis.CouncilDepartmentReview = {suggestions};
  if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.CouncilDepartmentReview;
})();
