(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CouncilVodTranscript = api;
})(typeof window === 'undefined' ? globalThis : window, function (root) {
  'use strict';
  const policy = Object.freeze({
    minCharacters: 12,
    maxCharacters: 300,
    minTrigrams: 8,
    minTrigramShare: 0.56,
    minSimilarity: 0.78,
    minConflictSimilarity: 0.65,
    runnerUpTrigramShare: 0.35,
    minSpeakerMargin: 0.12,
    mixedFragment: 10,
    maxBoundaryDrift: 0.75,
    pair: Object.freeze({
      minCharacters: 18,
      minHangul: 14,
      minExactGrams: 5,
      maxCaptureGap: 1,
      maxTextGap: 12,
      minCueSimilarity: 0.67,
      competitorSimilarity: 0.55,
      jointMargin: 0.10,
      maxWork: 1_250_000,
    }),
  });
  const cache = new WeakMap();
  const suspectFlags = new Set(['low_confidence', 'severe_uncertainty', 'repetition', 'segment_review']);
  const generic = /^(?:네|예|아)?(?:알겠습니다|잘알겠습니다|그렇게하겠습니다|그부분은그렇게하겠습니다|수고하셨습니다|감사합니다|말씀드리겠습니다|답변드리겠습니다)$/;
  const mixedTurn = /[.!?。！？]\s*(?:네|예|아니요|아닙니다)(?=\s|[,.!?，。！？]|$)/;
  const titles = '전문위원|비서실장|센터장|담당관|주무관|위원장|부의장|의장|부시장|시장|간사|실장|과장|국장|팀장|부장|소장|의원|위원';
  const titleSuffix = new RegExp('(?:' + titles + ')$');
  const fullTitle = '([가-힣]{0,24}(?:' + titles + '))';
  const nameThenTitle = new RegExp('(?:^|[^가-힣])([가-힣]{2,4})\\s*' + fullTitle + '\\s*입니다', 'g');
  const titleThenName = new RegExp('(?:^|[^가-힣])' + fullTitle + '\\s+([가-힣]{2,4})\\s*입니다', 'g');
  const selfName = /(?:^|[^가-힣])(?:저는|제가|제\s*이름은)\s*([가-힣]{2,4})\s*입니다/g;
  const minutesUrl = /^https:\/\/www\.sncouncil\.go\.kr\/record\/recordView\.do\?key=[a-f0-9]+$/;
  const trim = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
  const compact = value => trim(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

  function sameVideo(url, id) {
    try {
      const page = new URL(url);
      const ids = page.searchParams.getAll('pk_vod_no');
      return page.origin === 'https://cast.sncouncil.go.kr' && page.pathname === '/vod/vod_view.jsp' &&
        !page.username && !page.password && ids.length === 1 && ids[0] === id;
    } catch {
      return false;
    }
  }

  function trustedSource(meeting, reference, id) {
    const source = reference?.sourceUrl;
    return reference?.meetingId === id && sameVideo(meeting.officialPage, id) &&
      linkedSource(meeting, source, id);
  }

  function linkedSource(meeting, source, id) {
    return sameVideo(source, id) || (minutesUrl.test(source) &&
      (source === meeting.minutesUrl || (Array.isArray(meeting.minutesUrls) && meeting.minutesUrls.includes(source))));
  }

  function validatesSource(meeting, reference) {
    const id = String(meeting?.id || '');
    return /^\d{1,12}$/.test(id) && trustedSource(meeting, reference, id) && Array.isArray(reference.turns);
  }

  function validInterval(start, end) {
    return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
  }

  function trigrams(text) {
    const unique = new Set();
    for (let i = 0; i + 2 < text.length; i++) unique.add(text.slice(i, i + 3));
    return unique;
  }

  function indexTurns(reference) {
    if (cache.has(reference)) return cache.get(reference);
    const postings = new Map();
    for (const [index, turn] of reference.turns.entries()) {
      const name = trim(turn?.name);
      const role = trim(turn?.role);
      const text = compact(turn?.text);
      if (!/^[가-힣]{2,4}$/.test(name) || !role || text.length < policy.mixedFragment) continue;
      const timed = turn.start !== undefined || turn.end !== undefined;
      if (timed && !validInterval(turn.start, turn.end)) continue;
      const entry = {
        name, role, text,
        id: trim(turn.id) || reference.meetingId + '-turn-' + index,
        sourceUrl: turn.sourceUrl,
        speakerKey: name + '\0' + role,
        start: timed ? turn.start : -Infinity,
        end: timed ? turn.end : Infinity,
      };
      for (const gram of trigrams(text)) {
        const previous = postings.get(gram);
        if (previous) previous.push(entry);
        else postings.set(gram, [entry]);
      }
    }
    cache.set(reference, postings);
    return postings;
  }

  function conflictsWithIntro(text, entry) {
    const expectedTitle = titleSuffix.exec(entry.role)?.[0];
    const conflicts = (name, role) => name !== entry.name ||
      (expectedTitle && titleSuffix.exec(role)?.[0] !== expectedTitle);
    for (const [, name, role] of text.matchAll(nameThenTitle)) {
      if (conflicts(name, role)) return true;
    }
    for (const [, role, name] of text.matchAll(titleThenName)) {
      if (conflicts(name, role)) return true;
    }
    return [...text.matchAll(selfName)].some(([, name]) => name !== entry.name);
  }

  function substringSimilarity(query, reference) {
    if (reference.includes(query)) return 1;
    let previous = new Uint16Array(reference.length + 1);
    let current = new Uint16Array(reference.length + 1);
    for (let i = 1; i <= query.length; i++) {
      current[0] = i;
      for (let j = 1; j <= reference.length; j++) {
        const substitution = previous[j - 1] + (query[i - 1] === reference[j - 1] ? 0 : 1);
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
      }
      [previous, current] = [current, previous];
    }
    // A cue can start and end within a turn. Its own omitted text still costs an edit.
    return 1 - previous.reduce((minimum, cost) => Math.min(minimum, cost), query.length) / query.length;
  }

  function containsSecondSpeaker(query, best, competitors) {
    for (let offset = 0; offset + policy.mixedFragment <= query.length; offset++) {
      const fragment = query.slice(offset, offset + policy.mixedFragment);
      if (!best.text.includes(fragment) && competitors.some(entry => entry.text.includes(fragment))) return true;
    }
    return false;
  }

  function preparedCue(cue, id) {
    if (cue?.source !== 'local' || cue.meetingId !== id ||
        !trim(cue.id) || !validInterval(cue.start, cue.end) || cue.rejected ||
        (Array.isArray(cue.flags) && cue.flags.some(flag => suspectFlags.has(flag)))) return;
    const heard = trim(cue.text);
    const raw = trim(cue.rawText);
    const query = compact(heard);
    if (query.length < policy.minCharacters || query.length > policy.maxCharacters || generic.test(query) ||
        root.CouncilQuality?.repeated(heard) || root.CouncilQuality?.repeated(raw)) return;
    return { heard, raw, query, grams: trigrams(query), mixed: mixedTurn.test(heard) || mixedTurn.test(raw) };
  }

  function matchingTrigrams(cue, queryGrams, postings) {
    const hits = new Map();
    const from = cue.start - policy.maxBoundaryDrift;
    const to = cue.end + policy.maxBoundaryDrift;
    for (const gram of queryGrams) {
      for (const entry of postings.get(gram) || []) {
        if (entry.start < to && entry.end > from) hits.set(entry, (hits.get(entry) || 0) + 1);
      }
    }
    return hits;
  }

  function speakerResult(cueIds, entry, reference, meeting, method) {
    const vodId = reference.meetingId;
    const sourceUrl = linkedSource(meeting, entry.sourceUrl, vodId) ? entry.sourceUrl : reference.sourceUrl;
    return { speaker: {
      name: entry.name,
      role: entry.role,
      confidence: 'low',
      method,
      evidence: cueIds,
      officialReference: { vodId, sourceUrl, cueIds: [entry.id] },
    } };
  }

  function syllableCost(a, b) {
    if (a === b) return 0;
    a -= 0xac00;
    b -= 0xac00;
    if (a < 0 || b < 0 || a >= 11172 || b >= 11172) return 3;
    return Number(Math.floor(a / 588) !== Math.floor(b / 588)) +
      Number(Math.floor(a % 588 / 28) !== Math.floor(b % 588 / 28)) + Number(a % 28 !== b % 28);
  }

  function phoneticPlacements(query, queryGrams, text) {
    let previous = new Uint16Array(text.length + 1);
    let current = new Uint16Array(text.length + 1);
    let starts = Uint32Array.from(previous, (_, index) => index);
    let nextStarts = new Uint32Array(text.length + 1);
    for (let i = 1; i <= query.length; i++) {
      current[0] = i * 3;
      for (let j = 1; j <= text.length; j++) {
        const substitution = previous[j - 1] + syllableCost(query.charCodeAt(i - 1), text.charCodeAt(j - 1));
        const insertion = previous[j] + 3;
        const deletion = current[j - 1] + 3;
        const best = current[j] = Math.min(substitution, insertion, deletion);
        nextStarts[j] = best === substitution ? starts[j - 1] : best === insertion ? starts[j] : nextStarts[j - 1];
      }
      [previous, current] = [current, previous];
      [starts, nextStarts] = [nextStarts, starts];
    }
    const placements = [];
    for (let end = 1; end <= text.length; end++) {
      const similarity = 1 - previous[end] / (query.length * 3);
      if (similarity < policy.pair.competitorSimilarity) continue;
      const start = starts[end];
      const exact = [...trigrams(text.slice(start, end))].filter(gram => queryGrams.has(gram)).length;
      if (exact >= policy.pair.minExactGrams) placements.push({ similarity, start, end });
    }
    return placements;
  }

  function bestOrderedPlacement(entry, previous, current) {
    current.sort((a, b) => a.start - b.start);
    let best;
    let index = 0;
    for (const a of previous) {
      while (index < current.length && current[index].start < a.end - 2) index++;
      for (let j = index; j < current.length; j++) {
        const b = current[j];
        if (b.start - a.end > policy.pair.maxTextGap) break;
        const score = (a.similarity + b.similarity) / 2;
        if (!best || score > best.score) best = { entry, a, b, score };
      }
    }
    return best;
  }

  function pairedSpeaker(cue, current, currentHits, context, postings, reference, meeting) {
    if (!Array.isArray(context)) return;
    const tail = context.at(-1);
    const prior = tail?.id === cue.id ? context.at(-2) : tail;
    const before = preparedCue(prior, reference.meetingId);
    if (!before || before.mixed || before.query.length < policy.pair.minCharacters ||
        current.query.length < policy.pair.minCharacters || prior.id === cue.id ||
        cue.start < prior.end - 0.05 || cue.start - prior.end > policy.pair.maxCaptureGap) return;
    const enoughHangul = sample => (sample.query.match(/[가-힣]/g) || []).length >= policy.pair.minHangul;
    if (!enoughHangul(before) || !enoughHangul(current)) return;
    const repeated = [...before.grams].filter(gram => current.grams.has(gram)).length;
    if (repeated * 2 >= Math.min(before.grams.size, current.grams.size)) return;

    const priorHits = matchingTrigrams(prior, before.grams, postings);
    const choices = [];
    let strongestPrior = 0;
    let strongestCurrent = 0;
    let work = 0;
    for (const entry of new Set([...priorHits.keys(), ...currentHits.keys()])) {
      const priorCount = priorHits.get(entry) || 0;
      const currentCount = currentHits.get(entry) || 0;
      if (Math.max(priorCount, currentCount) < policy.pair.minExactGrams) continue;
      if (priorCount >= policy.pair.minExactGrams) work += before.query.length * entry.text.length;
      if (currentCount >= policy.pair.minExactGrams) work += current.query.length * entry.text.length;
      if (work > policy.pair.maxWork) return;
      const previousOptions = priorCount >= policy.pair.minExactGrams ?
        phoneticPlacements(before.query, before.grams, entry.text) : [];
      const currentOptions = currentCount >= policy.pair.minExactGrams ?
        phoneticPlacements(current.query, current.grams, entry.text) : [];
      for (const option of previousOptions) strongestPrior = Math.max(strongestPrior, option.similarity);
      for (const option of currentOptions) strongestCurrent = Math.max(strongestCurrent, option.similarity);
      const bestPlacement = bestOrderedPlacement(entry, previousOptions, currentOptions);
      if (bestPlacement) choices.push(bestPlacement);
    }
    choices.sort((a, b) => b.score - a.score);
    const best = choices[0];
    if (!best || best.a.similarity < policy.pair.minCueSimilarity || best.b.similarity < policy.pair.minCueSimilarity ||
        best.a.similarity < strongestPrior - 0.02 || best.b.similarity < strongestCurrent - 0.02) return;
    const opposition = choices.find(row => row.entry.speakerKey !== best.entry.speakerKey);
    if (opposition && best.score - opposition.score < policy.pair.jointMargin) return { blocked: true };
    const entry = best.entry;
    for (const [sample, matched] of [[before, priorHits], [current, currentHits]]) {
      const others = [...matched].filter(([row, count]) => row.speakerKey !== entry.speakerKey && count >= 4)
        .map(([row]) => row);
      if (containsSecondSpeaker(sample.query, entry, others) || conflictsWithIntro(sample.heard, entry) ||
          (sample.heard !== sample.raw && conflictsWithIntro(sample.raw, entry))) return { blocked: true };
    }
    return speakerResult([prior.id, cue.id], entry, reference, meeting,
      '이어진 두 자막의 발언 내용이 같은 영상의 공식 회의록에서 한 발언의 순서와 일치해 추정');
  }

  function assess(meeting, cue, reference, context) {
    if (!validatesSource(meeting, reference)) return;
    const prepared = preparedCue(cue, String(meeting.id));
    if (!prepared) return;
    if (prepared.mixed) return { blocked: true };
    const { heard, raw, query, grams: queryGrams } = prepared;
    const postings = indexTurns(reference);
    const hits = matchingTrigrams(cue, queryGrams, postings);
    const paired = () => pairedSpeaker(cue, prepared, hits, context, postings, reference, meeting);
    const candidates = [];
    const runnerUpMinimum = Math.max(4, Math.ceil(queryGrams.size * policy.runnerUpTrigramShare));
    for (const [entry, shared] of hits) {
      if (shared >= runnerUpMinimum) candidates.push({ entry, shared, similarity: substringSimilarity(query, entry.text) });
    }
    candidates.sort((a, b) => b.similarity - a.similarity);
    const best = candidates[0];
    if (!best) return paired();
    const entry = best.entry;
    const otherSpeakers = [...hits].filter(([row, shared]) =>
      row.speakerKey !== entry.speakerKey && shared >= 4).map(([row]) => row);
    if (containsSecondSpeaker(query, entry, otherSpeakers)) return { blocked: true };
    const minimum = Math.max(policy.minTrigrams, Math.ceil(queryGrams.size * policy.minTrigramShare));
    if (best.shared < minimum) return paired();
    if (best.similarity >= policy.minConflictSimilarity &&
        (conflictsWithIntro(heard, entry) || (heard !== raw && conflictsWithIntro(raw, entry)))) return { blocked: true };
    if (best.similarity < policy.minSimilarity) return paired();
    const runnerUp = candidates.find(row => row.entry.speakerKey !== entry.speakerKey);
    if (runnerUp && best.similarity - runnerUp.similarity < policy.minSpeakerMargin) return { blocked: true };
    return speakerResult([cue.id], entry, reference, meeting,
      '같은 영상의 공식 회의록에서 발언 내용이 한 이름의 발언과 뚜렷하게 일치해 추정');
  }

  function match(meeting, cue, reference, context) {
    return assess(meeting, cue, reference, context)?.speaker;
  }

  return Object.freeze({ assess, match, validatesSource });
});
