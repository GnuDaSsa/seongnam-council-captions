/* Correct only self-contained, explicit substitution formulas. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CouncilKoreanCorrections = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const substitution = /(^|\s)((?:자료로|서면으로|유인물로)[ \t]+(?:(?:설명을|보고를|답변을)[ \t]+)?)가름(하겠습니다|합니다|하겠으며|하겠(?=\.\.\.)|하도록[ \t]+하겠습니다|하도록[ \t]+하고|하여[ \t]+주시기[ \t]+바랍니다)(?=[.!?。？！\s]|$)/g;
  function correct(input) {
    const original = String(input ?? '');
    const text = original.replace(substitution, '$1$2갈음$3');
    return {text, changed: text !== original};
  }
  return Object.freeze({correct});
});
