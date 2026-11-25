/* Correct only self-contained, explicit substitution formulas. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CouncilKoreanCorrections = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const substitution = /(^|\s)((?:자료로|서면으로|유인물로)[ \t]+(?:(?:설명을|보고를|답변을)[ \t]+)?)가름(하겠습니다|합니다|하겠으며|하겠(?=\.\.\.)|하도록[ \t]+하겠습니다|하도록[ \t]+하고|하여[ \t]+주시기[ \t]+바랍니다)(?=[.!?。？！\s]|$)/g;
  const distinction = /성패|승패|우열|진위|시비|흑백|승부|당락|경중|여부|잘잘못|옳고\s*그름|책임\s*소재|누가\s*(?:옳|맞)/;
  function correct(input) {
    const original = String(input ?? '');
    const text = original.replace(substitution, (matched, boundary, medium, ending, offset) => {
      // A document can also be the evidence used to distinguish two outcomes.
      const clause = original.slice(0, offset).split(/[.!?。？！;\n]/u).pop();
      if (distinction.test(clause)) return matched;
      return boundary + medium + '갈음' + ending;
    });
    return {text, changed: text !== original};
  }
  return Object.freeze({correct});
});
