/* Correct only self-contained, explicit substitution formulas. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CouncilKoreanCorrections = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function correct(input) {
    const original = String(input ?? '');
    const pattern = /(^|\s)((?:자료로|서면으로|유인물로)[ \t]+(?:(?:설명|보고|답변)을[ \t]+)?)가름(하겠습니다|합니다|하겠으며|하겠(?=\.\.\.)|하도록[ \t]+하겠습니다|하도록[ \t]+하고)(?=[.!?。？！\s]|$)/g;
    const text = original.replace(pattern, '$1$2갈음$3');
    return {text, changed: text !== original};
  }
  return Object.freeze({correct});
});
