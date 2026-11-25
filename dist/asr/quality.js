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
  root.CouncilQuality = {repeated};
})(globalThis);
