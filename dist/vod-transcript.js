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
    splitPredicate: Object.freeze({anchorCharacters:15,maxGapSeconds:0.35,maxCueSeconds:10}),
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
  const replyBoundaryCache = new WeakMap();
  const suspectFlags = new Set(['low_confidence', 'severe_uncertainty', 'repetition', 'segment_review']);
  const generic = /^(?:네|예|아)?(?:알겠습니다|잘알겠습니다|그렇게하겠습니다|그부분은그렇게하겠습니다|수고하셨습니다|감사합니다|말씀드리겠습니다|답변드리겠습니다)$/;
  const mixedTurn = /[.!?。！？]\s*(?:네|예|아니요|아닙니다)(?=\s|[,.!?，。！？]|$)/;
  const questionReply = /(?:나요|습니까|시죠|맞죠|했죠|있죠)\s*[.?!。！？]?\s*(?:(?:네|예)[,.\s]*)?(?:그렇습니다|맞습니다|아닙니다)(?=\s|[.,?!。！？]|$)/;
  const electedTitles = '의장직무대리|위원장대리|예산결산특별위원회장|부위원장|위원장|부의장|의장|간사|의원|위원';
  const officerTitles = '전문위원|비서실장|센터장|담당관|주무관|구청장|부시장|시장|실장|과장|국장|팀장|부장|소장|단장|관장|본부장|대표이사|이사장|사장|공보관|감사관|재난안전관|소통관|공공의료정책관';
  const titles = electedTitles + '|(?:' + officerTitles + ')(?:직무대리)?|의회사무국직원';
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
        name, role, text, sourceText:trim(turn.text),
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
    return { heard, raw, query, grams: trigrams(query), mixed: mixedTurn.test(heard) || mixedTurn.test(raw) ||
      questionReply.test(heard) || questionReply.test(raw) };
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

  const boundaryFlags = new Set([...suspectFlags,'mixed','overlap','interrupted','audio_gap','invalid_time_value']);
  function safePredicateFlags(cue) {
    return cue.flags==null || (Array.isArray(cue.flags) && !cue.flags.some(flag=>boundaryFlags.has(flag)));
  }
  function attachedPredicate(cue) {
    return /^(?:부탁드립니다|요청드립니다|바랍니다)[.。]?$/.test(trim(cue?.text).replace(/\s/g,''));
  }
  function matchAttachedPredicate(meeting,cue,reference,context) {
    const id=String(meeting.id), rule=policy.splitPredicate;
    if (!attachedPredicate(cue) || cue.source!=='local' || cue.meetingId!==id || !trim(cue.id) ||
        !validInterval(cue.start,cue.end) || cue.rejected || cue.speakerConflict || trim(cue.rawText)!==trim(cue.text) ||
        cue.end-cue.start>rule.maxCueSeconds || !safePredicateFlags(cue) ||
        !Array.isArray(context)) return;
    const prior=context.at(-1)?.id===cue.id ? context.at(-2) : context.at(-1);
    const before=preparedCue(prior,id);
    if (!before || before.mixed || prior.id===cue.id || prior.speakerConflict || before.raw!==before.heard ||
        !safePredicateFlags(prior) || cue.start<prior.end || cue.start-prior.end>rule.maxGapSeconds ||
        /[.!?。！？“”‘’"'「」『』]\s*$/.test(before.heard) || /[“”‘’"'「」『』]/.test(before.heard)) return;
    const ending=compact(cue.text), suffix=before.query.slice(-rule.anchorCharacters);
    if (suffix.length<rule.anchorCharacters || !/(?:간곡하게|간곡히|정중하게|정중히|해주시길|해주시기를|해주시기|주시기를|주시길|주시기)$/.test(suffix)) return;
    // Independently match the previous clause. A name inherited from another cue cannot seed this path.
    const anchor=assess(meeting,prior,reference)?.speaker;
    if (!anchor?.officialReference || (prior.speaker?.name && prior.speaker.name!==anchor.name)) return;
    const phrase=suffix+ending;
    const entries=indexTurns(reference).get(suffix.slice(0,3))||[];
    let matched;
    for (const entry of entries) {
      if (entry.end<=prior.start-policy.maxBoundaryDrift || entry.start>=cue.end+policy.maxBoundaryDrift) continue;
      if (!entry.text.includes(phrase)) continue;
      if (matched || !anchor.officialReference.cueIds.includes(entry.id)) return;
      const sentences=entry.sourceText.split(/[.!?。！？\r\n]/);
      if (!sentences.some(sentence=>!/[“”‘’"'「」『』]/.test(sentence) && compact(sentence).includes(phrase)) ||
          entry.text.indexOf(phrase)!==entry.text.lastIndexOf(phrase)) return;
      matched=entry;
    }
    if (matched) return speakerResult([prior.id,cue.id],matched,reference,meeting,
      '직전 자막의 미완성 구절과 짧은 서술어가 공식 회의록의 한 문장에서 그대로 이어져 추정');
  }
  // A generic thank-you can tie several speakers by itself. A corrected predicate may
  // resolve that tie only when BOTH draft clauses are accounted for inside the same official turn.
  function resolvePredicateAmbiguity(meeting,draft,refined,reference,context,speaker) {
    if (!speaker?.officialReference || draft.id!==refined.id || draft.start!==refined.start ||
        draft.end!==refined.end || !validatesSource(meeting,reference) || draft.rejected ||
        !safePredicateFlags(draft) || trim(draft.rawText)!==trim(draft.text) || !Array.isArray(context)) return false;
    const independentlyMatched=matchAttachedPredicate(meeting,refined,reference,context)?.speaker;
    const turnId=speaker.officialReference.cueIds?.[0];
    if (!independentlyMatched || independentlyMatched.name!==speaker.name ||
        independentlyMatched.officialReference.cueIds[0]!==turnId) return false;
    const parts=trim(draft.text).match(/^([^.!?。！？]+)[.。]\s*([가-힣\s]+)[.。]?$/);
    if (!parts || compact(parts[1])!==compact(refined.text)) return false;
    const heard=compact(parts[2]).match(/^(끝까지)?([가-힣]{3})주셔서감사합니다$/);
    if (!heard || heard[2][0]!=='경') return false;
    const cost=[...heard[2]].reduce((sum,char,i)=>sum+syllableCost(char.charCodeAt(0),'경청해'.charCodeAt(i)),0);
    if (cost>4) return false;
    const prior=context.at(-1)?.id===refined.id ? context.at(-2) : context.at(-1);
    const suffix=compact(prior.text).slice(-policy.splitPredicate.anchorCharacters);
    const entry=(indexTurns(reference).get(suffix.slice(0,3))||[]).find(row=>row.id===turnId);
    if (!entry) return false;
    const sentences=entry.sourceText.split(/[.!?。！？\r\n]+/).map(trim).filter(Boolean);
    const expected=(heard[1]||'')+'경청해주셔서감사합니다';
    return sentences.some((s,i)=>compact(s).endsWith(suffix+compact(refined.text)) &&
      !/[“”‘’"'「」『』]/.test(s+' '+(sentences[i+1]||'')) && compact(sentences[i+1])===expected);
  }
  function spansInterposedReply(raw, reference) {
    const clauses=raw.split(/[?？]/);
    if (clauses.length!==2) return false;
    const left=compact(clauses[0]).slice(-13), right=compact(clauses[1]).slice(0,9);
    if (!/^[가-힣]{13}$/.test(left) || !/^[가-힣]{9}$/.test(right)) return false;
    let turns=replyBoundaryCache.get(reference);
    if (!turns) {
      turns=reference.turns.map(turn=>({name:trim(turn?.name),role:trim(turn?.role),
        text:compact(turn?.text),sourceUrl:turn?.sourceUrl || reference.sourceUrl}));
      replyBoundaryCache.set(reference,turns);
    }
    const before=turns.findIndex(turn=>turn.text.endsWith(left));
    if (before<0) return false;
    const question=turns[before], reply=turns[before+1], resumed=turns[before+2];
    if (!/^[가-힣]{2,4}$/.test(question.name) || !question.role || !resumed?.text.startsWith(right) ||
        resumed.name!==question.name || resumed.role!==question.role || !/^[가-힣]{2,4}$/.test(reply?.name || '') ||
        !reply.role || reply.name===question.name || reply.text.length<5 || reply.text.length>20 ||
        reply.sourceUrl!==question.sourceUrl || resumed.sourceUrl!==question.sourceUrl) return false;
    // The anchors must be independently unique across the trusted record.
    return !turns.some((turn,i)=>(i!==before && turn.text.includes(left)) || (i!==before+2 && turn.text.includes(right))) &&
      question.text.indexOf(left)===question.text.lastIndexOf(left) && resumed.text.indexOf(right)===resumed.text.lastIndexOf(right);
  }
  function assess(meeting, cue, reference, context) {
    if (!validatesSource(meeting, reference)) return;
    const prepared = preparedCue(cue, String(meeting.id));
    if (!prepared) return matchAttachedPredicate(meeting,cue,reference,context);
    if (prepared.mixed || (prepared.raw===prepared.heard && spansInterposedReply(prepared.raw,reference))) return { blocked: true };
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
    if (runnerUp && best.similarity - runnerUp.similarity < policy.minSpeakerMargin) return { blocked:true,reason:'ambiguous-speaker' };
    return speakerResult([cue.id], entry, reference, meeting,
      '같은 영상의 공식 회의록에서 발언 내용이 한 이름의 발언과 뚜렷하게 일치해 추정');
  }

  // The publisher clock starts with the live capture, often many minutes away from the VOD clock.
  // Index all actual utterances, including unattributed ones, so common phrases cannot identify a speaker.
  function prepareCaptured(meeting,archive,matcher) {
    const meetingId=meeting?.liveMeetingId;
    if (typeof meetingId!=='string' || !/^[1-9]\d{0,7}$/.test(meetingId) || archive?.meetingId!==meetingId ||
        !sameVideo(meeting.officialPage,String(meeting.id)) || typeof matcher?.attribute!=='function' ||
        !Array.isArray(archive.cues) || !archive.cues.length || archive.cues.length>20_000) return;
    const cues=archive.cues;
    // This flag is set by the same-origin minutes endpoint after applying the live meeting's roster and camera evidence.
    // When an authoritative row has no label, a second pass with the VOD roster must respect that decision.
    const canonical=archive.speakerAttributionApplied===true;
    const labels=canonical ? null : matcher.attribute({...meeting,id:meetingId},cues,[],archive.gaps || []);
    const cueIds=new Set(cues.map(row=>row?.id));
    const entries=new Map(), postings=new Map();
    for (const cue of cues) {
      const text=compact(cue?.rawText || cue?.text), id=trim(cue?.id);
      if (!id || text.length<10 || text.length>2000 || !validInterval(cue.start,cue.end) || entries.has(id)) continue;
      const label=canonical ? cue.speaker : labels[id];
      const oath=canonical && label?.basis==='oath-signature';
      const bad=cue.rejected || !Array.isArray(cue.flags) || cue.flags.some(f=>suspectFlags.has(f)) ||
        cue.text!==cue.rawText || mixedTurn.test(cue.text) || !/^[가-힣]{2,4}$/.test(label?.name || '') ||
        typeof label.role!=='string' || !label.role || label.role.length>40 ||
        (!oath && !/자기소개|본인 이름|연속 음성/.test(label.method || '')) ||
        !Array.isArray(label.evidence) || !label.evidence.includes(id) || !label.evidence.every(key=>cueIds.has(key));
      const entry={id,text,label:bad ? null : label,oath};
      entries.set(id,entry);
      for (const gram of trigrams(text)) {
        if (!postings.has(gram)) postings.set(gram,[]);
        postings.get(gram).push(entry);
      }
    }
    if ([...entries.values()].some(entry=>entry.label)) return {vodId:String(meeting.id),meetingId,postings};
  }
  // Require two exact, separated excerpts in spoken order before entertaining a noisy ASR match.
  // The longer excerpt must contain Korean text even if a year, amount or page number agrees.
  function orderedExcerpts(query,source) {
    const candidates=[];
    for (let i=0;i+5<=query.length;i++) {
      const prefix=query.slice(i,i+5);
      for (let j=source.indexOf(prefix);j>=0;j=source.indexOf(prefix,j+1)) {
        if (i && j && query[i-1]===source[j-1]) continue;
        let length=5;
        while (i+length<query.length && query[i+length]===source[j+length]) length++;
        const fragment=query.slice(i,i+length), hangul=(fragment.match(/[가-힣]/g) || []).length;
        if (hangul>=4) candidates.push({i,j,length,distinct:length>=10 && hangul>=6});
        if (candidates.length>64) return false;
      }
    }
    return candidates.some(a=>candidates.some(b=>(a.distinct || b.distinct) &&
      b.i>=a.i+a.length+3 && b.j>=a.j+a.length+3));
  }
  function noisyCapturedMatch(rankings,parsed) {
    const {query,grams}=parsed;
    if (query.length<25 || query.length>120 || (query.match(/[가-힣]/g) || []).length<20) return;
    const plausible=[];
    let work=0;
    for (const candidate of rankings) {
      work+=query.length*candidate.entry.text.length;
      if (work>750_000) return;
      const positions=phoneticPlacements(query,grams,candidate.entry.text);
      if (positions.length) plausible.push({...candidate,phonetic:Math.max(...positions.map(p=>p.similarity))});
    }
    plausible.sort((a,b)=>b.phonetic-a.phonetic);
    const best=plausible[0];
    if (!best?.entry.label || best.phonetic<0.78 || best.count<Math.max(10,grams.size*0.45) ||
        (plausible[1] && best.phonetic-plausible[1].phonetic<0.18) || !orderedExcerpts(query,best.entry.text)) return;
    return best;
  }
  function assessCaptured(meeting,cue,captured) {
    if (!captured || captured.vodId!==String(meeting?.id) || captured.meetingId!==meeting.liveMeetingId) return;
    const parsed=preparedCue(cue,captured.vodId);
    if (!parsed || parsed.mixed || parsed.query.length<18 || (parsed.query.match(/[가-힣]/g) || []).length<14) return;
    const hits=new Map();
    for (const gram of parsed.grams) {
      for (const entry of captured.postings.get(gram) || []) hits.set(entry,(hits.get(entry) || 0)+1);
    }
    const rankings=[];
    let work=0;
    for (const [entry,count] of hits) {
      if (count<5) continue;
      work+=entry.text.length*parsed.query.length;
      if (work>1_000_000) return;
      rankings.push({entry,count,score:substringSimilarity(parsed.query,entry.text)});
    }
    rankings.sort((a,b)=>b.score-a.score);
    let best=rankings[0];
    const exact=best?.entry.label && best.score>=0.88 && best.count>=Math.max(10,parsed.grams.size*0.65) &&
      (!rankings[1] || best.score-rankings[1].score>=0.15);
    if (!exact) best=noisyCapturedMatch(rankings,parsed);
    if (!best) return;
    const {label,id,oath}=best.entry;
    // The date and stock oath wording can be shared by several witnesses on the same day.
    if (oath && (![parsed.query,compact(parsed.raw)].every(words=>words.includes(compact(label.role)+compact(label.name))))) return;
    const competitors=[...hits].filter(([entry,n])=>entry!==best.entry && n>=4).map(([entry])=>entry);
    if (containsSecondSpeaker(parsed.query,best.entry,competitors) || conflictsWithIntro(parsed.heard,label) ||
        (parsed.raw!==parsed.heard && conflictsWithIntro(parsed.raw,label))) return;
    return {speaker:{name:label.name,role:label.role,confidence:'low',method:'같은 회의 생중계 자막의 발언 내용과 실명 단서 대조 (원음 확인 필요)',
      evidence:[cue.id],liveReference:{meetingId:captured.meetingId,cueId:id,evidence:label.evidence}}};
  }
  // A later cue may clarify the preceding one. Both utterances must match distinct, ordered portions of the same official turn.
  function previousSpeaker(meeting, prior, cue, reference) {
    const id=String(meeting?.id || ''), anchor=cue?.speaker;
    if (!prior || prior.speaker || prior.speakerConflict || cue?.speakerConflict || !anchor?.name ||
        anchor.officialReference?.vodId!==id || !validatesSource(meeting,reference)) return;
    const current=preparedCue(cue,id);
    if (!current || current.mixed) return;
    const postings=indexTurns(reference), hits=matchingTrigrams(cue,current.grams,postings);
    const match=pairedSpeaker(cue,current,hits,[prior,cue],postings,reference,meeting)?.speaker;
    if (!match || match.name!==anchor.name || match.role!==anchor.role ||
        !anchor.officialReference.cueIds?.includes(match.officialReference.cueIds[0])) return;
    return {...match,method:'뒤이어 들어온 자막과 앞 문장이 공식 회의록의 같은 발언에 순서대로 일치해 추정'};
  }
  function match(meeting, cue, reference, context) {
    return assess(meeting, cue, reference, context)?.speaker;
  }

  return Object.freeze({ assess, match, attachedPredicate, resolvePredicateAmbiguity, previousSpeaker, validatesSource, prepareCaptured, assessCaptured });
});
