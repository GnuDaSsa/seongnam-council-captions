/* Shared, conservative detection of excessive repeated recognition output. */
(function (root) {
  'use strict';
  function repeated(text) {
    const normalized = String(text || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
    if (normalized.length < 40 || !/[가-힣]/.test(normalized)) return false;
    for (let width = 2; width <= Math.min(40, Math.floor(normalized.length / 8)); width++) {
      for (let start = 0; start <= normalized.length - width * 8; start++) {
        const unit = normalized.slice(start, start + width);
        if (!/[가-힣]/.test(unit)) continue;
        let end = start + width;
        while (normalized.slice(end, end + width) === unit) end += width;
        if ((end - start) / width >= 8 && end - start >= 40 && (end - start) / normalized.length >= 0.6) return true;
      }
    }
    return false;
  }
  function spokenText(value) {
    const text=typeof value==='string' ? value : '';
    const enclosed=/^(?:\(([^()]+)\)|\[([^\[\]]+)\])$/.exec(text.normalize('NFKC').trim());
    const marker=(enclosed?.[1] || enclosed?.[2] || '').trim();
    return /^(?:인트로|엔딩|음악|간주|박수|웃음|무음|잡음|music|applause|silence)$/i.test(marker) ? '' : text;
  }
  // The Sherpa WASM decoder can lose word boundaries in text while retaining them in tokens.
  // Use those boundaries only when they describe exactly the same recognized characters.
  function koreanTokenSpacing(text, tokens) {
    if (!/[가-힣]/u.test(text) || !Array.isArray(tokens) || !tokens.length ||
        !tokens.every(token => typeof token === 'string')) return text;
    const pieces = tokens.join('').replaceAll('▁', ' ').trim();
    const unspaced = value => value.replace(/[ \t]/gu, '');
    if (unspaced(pieces) !== unspaced(text)) return text;

    const boundaries = new Set();
    let offset = 0;
    for (const part of pieces.split(/[ \t]+/u)) {
      offset += part.length;
      boundaries.add(offset);
    }
    // Keep the decoder's existing whitespace and punctuation, including around Latin text.
    let index = 0;
    return text.replace(/[^ \t]+/gu, run => {
      let result = '';
      for (let i = 0; i < run.length; i++, index++) {
        if (i > 0 && boundaries.has(index)) result += ' ';
        result += run[i];
      }
      return result;
    });
  }
  root.CouncilQuality = {repeated,spokenText,koreanTokenSpacing};
})(globalThis);
