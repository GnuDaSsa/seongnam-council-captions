(() => {
  'use strict';
  const el = id => document.getElementById(id);
  let meeting = null, version = 0, archive = null;
  const edits = new Map();
  const flags = {number:'숫자 확인',name:'이름 확인',proceeding:'출석·표결 확인',repetition:'구절 반복',low_confidence:'인식 불확실',severe_uncertainty:'원음 대조 필요',segment_review:'해당 구간 재확인'};
  const stamp = value => { const n = Math.max(0, Math.floor(Number(value) || 0)); return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60].map(x => String(x).padStart(2, '0')).join(':'); };
  const date = value => { if (value == null || value === '') return '확인 불가'; const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('ko-KR', {timeZone:'Asia/Seoul',hour12:false}) : '확인 불가'; };
  const {bad, initial} = window.CouncilMinutesFormat;
  function key(cue) { return `council-live-minutes:${meeting.id}:${cue.id}`; }
  function metaKey(cue) { return key(cue) + ':meta'; }
  function meta(cue) { try { return JSON.parse(edits.get(metaKey(cue)) || localStorage.getItem(metaKey(cue)) || '{}'); } catch (_) { return {}; } }
  function saveMeta(cue, value) { const k = metaKey(cue), v = JSON.stringify(value); edits.set(k,v); try { localStorage.setItem(k,v); } catch (_) { el('minutes-status').textContent = '브라우저 저장 공간을 사용할 수 없어 수정 내용이 새로고침 후 사라질 수 있습니다.'; } }
  function read(cue) {
    const k = key(cue);
    if (edits.has(k)) return edits.get(k);
    try {
      const value = localStorage.getItem(k);
      if (value === null) return initial(cue);
      const oldPlaceholder = value === '[음성 인식 오류 · 원음 재확인 필요]' ||
        value === '[인식 구간 오류 · 원본 청크 전체 재확인 필요]';
      const hasEditEvidence = localStorage.getItem(k + ':explicit') === '1' || history(cue).length > 0;
      if (oldPlaceholder && !hasEditEvidence && cue.flags?.includes('segment_review') && !bad(cue) &&
          typeof cue.rawText === 'string' && cue.rawText.trim() && cue.rawText.trim() !== value &&
          !['[음성 인식 오류 · 원음 재확인 필요]', '[인식 구간 오류 · 원본 청크 전체 재확인 필요]', '[original text unavailable]'].includes(cue.rawText.trim())) return initial(cue);
      return value;
    } catch (_) { return initial(cue); }
  }
  function write(cue, value) { edits.set(key(cue), value); try { localStorage.setItem(key(cue), value); localStorage.setItem(key(cue) + ':explicit', '1'); } catch (_) { el('minutes-status').textContent = '브라우저 저장 공간을 사용할 수 없어 수정 내용이 새로고침 후 사라질 수 있습니다.'; } }
  function historyKey(cue) { return key(cue) + ':history'; }
  function history(cue) { try { return JSON.parse(edits.get(historyKey(cue)) || localStorage.getItem(historyKey(cue)) || '[]'); } catch (_) { return []; } }
  function recordHistory(cue, value) {
    const records = history(cue);
    if ((records.at(-1)?.text ?? initial(cue)) === value) return;
    records.push({at:new Date().toISOString(),text:value});
    const k=historyKey(cue), v=JSON.stringify(records); edits.set(k,v);
    try { localStorage.setItem(k,v); } catch (_) { el('minutes-status').textContent = '브라우저 저장 공간을 사용할 수 없어 수정 내용이 새로고침 후 사라질 수 있습니다.'; }
  }
  function coverage() {
    const cues = archive.cues;
    const first = cues[0], last = cues[cues.length - 1];
    const begin = archive.coverageStart ? date(archive.coverageStart) : (first?.observedAt ? date(first.observedAt) : '확인 불가');
    const end = last?.observedAt ? date(last.observedAt) : '확인 불가';
    const gaps = Array.isArray(archive.gaps) && archive.gaps.length ? archive.gaps.map(g => date(g.start) + ' ~ ' + (g.end ? date(g.end) : '수집 재개 대기') + ' (' + (g.reason === 'interrupted' ? '전송 중단' : '갱신 누락') + ')').join('; ') : '서버가 확인한 중단 구간 없음';
    const status = ({live:"수집 중",listening:"수집 대기",ended:"종료",interrupted:"중단"})[archive.status] || "확인 불가";
    return `수집 범위: ${begin} ~ ${end} (한국시간), ${cues.length}개 구간 · 상태: ${status} · 갱신: ${date(archive.updatedAt)}. 확인된 중단: ${gaps}. 중단 시각은 추정치이며 다른 누락도 있을 수 있습니다.`;
  }
  function model() {
    return {minutesLines:window.CouncilMinutesFormat.lines({meeting,archive,read,meta,coverage:coverage(),bad,initial})};
  }
  function preview() { el('minutes-preview').textContent = CouncilExports.minutesText(model()); }
  function render() {
    const container = el('minutes-cues'); container.replaceChildren();
    const cueFields = new Map();
    const guesses = window.CouncilSpeakerReview?.guesses(meeting, archive.cues) || {};
    const candidateCount = archive.cues.filter(cue => !!guesses[String(cue.id)]).length;
    el('minutes-speaker-filter').checked = false;
    el('minutes-speaker-filter-label').textContent = `발언자 후보만 보기 (${candidateCount}건)`;
    el('minutes-speaker-empty').hidden = candidateCount > 0;
    const evidenceById = new Map(archive.cues.map(cue => [String(cue.id), cue]));
    for (const cue of archive.cues) {
      const card = document.createElement('div'); card.className = 'minutes-cue';
      const label = document.createElement('label'), area = document.createElement('textarea'), details = document.createElement('details'), summary = document.createElement('summary'), raw = document.createElement('pre');
      const caption = document.createElement('span');
      function showSpeaker(name) {
        caption.textContent = `[${stamp(cue.start)} ~ ${stamp(cue.end)}] 기록 ${cue.id} · ${name || '발언자·직위 미확인'}`;
      }
      showSpeaker(meta(cue).speaker);
      label.append(caption);
      area.value = read(cue); area.rows = 2; area.setAttribute('aria-label', `기록 ${cue.id} 수정`);
      const reviewNotice = document.createElement('p');
      reviewNotice.className = 'cue-review';
      reviewNotice.textContent = cue.flags?.length ? '검토 필요: ' + cue.flags.map(flag => flags[flag] || '추가 확인').join(', ') : '';
      const metaBox = document.createElement('div'), speaker = document.createElement('input'), kind = document.createElement('select'), confirmed = document.createElement('input'), confirmLabel = document.createElement('label');
      speaker.placeholder = '확인한 발언자 (선택)'; speaker.setAttribute('aria-label','확인한 발언자'); speaker.value = meta(cue).speaker || '';
      kind.setAttribute('aria-label','담당자 분류'); for (const name of ['일반 발언','질의','답변','자료 제출 요청','의결']) { const option = document.createElement('option'); option.value = name; option.textContent = name; kind.append(option); } kind.value = meta(cue).kind || '일반 발언';
      confirmed.type = 'checkbox'; confirmed.checked = !!meta(cue).confirmed; confirmLabel.append(confirmed, document.createTextNode(' 자료 제출 요청 또는 의결 확인'));
      function updateMeta() { saveMeta(cue,{speaker:speaker.value,kind:kind.value,confirmed:confirmed.checked}); showSpeaker(speaker.value); preview(); }
      speaker.addEventListener('input',updateMeta); kind.addEventListener('change',updateMeta); confirmed.addEventListener('change',updateMeta); metaBox.append(speaker,kind,confirmLabel);
      const guess = guesses[String(cue.id)];
      cueFields.set(String(cue.id), {speaker, metaBox, guess, cue});
      card.dataset.speakerCandidate = guess ? 'yes' : 'no';
      if (guess) {
        const hint = document.createElement('div'), accept = document.createElement('button');
        hint.textContent = '발언자 후보 (미확인)　' + [guess.role, guess.name].filter(Boolean).join(' ');
        if (guess.confidence === 'low') hint.append(document.createTextNode(' · 단서가 약함'));
        const evidence = document.createElement('details'), title = document.createElement('summary');
        title.textContent = guess.method || '발언자 후보 근거';
        evidence.append(title);
        for (const sourceId of guess.evidence || []) {
          const source = evidenceById.get(String(sourceId));
          if (!source) continue;
          const line = document.createElement('p');
          line.textContent = `[${stamp(source.start)}] ${source.rawText || source.text}`;
          evidence.append(line);
        }
        hint.append(evidence);
        accept.type = 'button'; accept.textContent = '발언자 확인 후 적용';
        accept.addEventListener('click', () => { speaker.value = [guess.role, guess.name].filter(Boolean).join(' '); speaker.dispatchEvent(new Event('input', {bubbles:true})); });
        metaBox.append(hint,accept);
      }
      const suggestions = document.createElement('div');
      const proposals = [
        ...(window.CouncilCommitteeTerms?.suggestions(meeting, area.value) || []),
        ...(window.CouncilDepartmentReview?.suggestions(area.value, meeting.agenda || []) || [])
      ];
      for (const candidate of proposals) {
        const note = document.createElement('span'), apply = document.createElement('button');
        note.textContent = `표기 확인: ${candidate.heard} → ${candidate.official} `;
        apply.type = 'button'; apply.textContent = '이 표기로 수정';
        apply.addEventListener('click', () => { area.value = area.value.replace(candidate.heard, candidate.official); area.dispatchEvent(new Event('input', {bubbles:true})); area.dispatchEvent(new Event('change', {bubbles:true})); });
        suggestions.append(note, apply);
        try { const url = new URL(candidate.source); if (url.protocol === 'https:') { const link = document.createElement('a'); link.href=url.href; link.textContent=' 공식 근거'; link.target='_blank'; link.rel='noopener noreferrer'; suggestions.append(link); } } catch (_) {}
      }
      const editState = document.createElement('small');
      function markEdit() { const original = String((cue.flags?.includes('segment_review') && cue.rawText) || cue.text || cue.rawText || ''); const corrected = !bad(cue) && window.CouncilKoreanCorrections?.correct(original).changed; editState.textContent = area.value !== initial(cue) ? '담당자 편집됨' : corrected ? '문맥 교정됨 · 원문 대조' : '자동 전사 원문'; }
      markEdit(); area.addEventListener('input', () => { write(cue, area.value); markEdit(); preview(); });
      area.addEventListener('change', () => { recordHistory(cue, area.value); showHistory(); });
      const historyText = document.createElement('pre');
      function showHistory() { historyText.textContent = history(cue).map(item => date(item.at) + ' · 편집: ' + item.text).join('\n') || '저장된 편집 이력 없음'; }
      showHistory();
      summary.textContent = '수집 원문·정리 결과·편집 이력';
      raw.textContent = `수집 시각: ${cue.observedAt ? date(cue.observedAt) : '확인 불가'}\n원문: ${cue.rawText || cue.text || ''}\n검토 표시: ${(cue.flags || []).map(f => flags[f] || f).join(', ') || '없음'}${bad(cue) ? '\n인식 오류 가능: 원문은 저장 문서에서 제외됩니다.' : ''}`;
      const formatted = document.createElement('pre');
      function showFormatted() { const result = window.CouncilMinutesFormat.tidy(area.value); const original = String(cue.rawText || cue.text || ''); formatted.textContent = (result === original ? '원문과 같음' : '원문과 정리 결과가 다름') + '\n문서 정리 결과: ' + result; }
      showFormatted(); area.addEventListener('input', showFormatted);
      details.append(summary,raw,formatted,historyText); label.append(area); card.append(label,reviewNotice,metaBox,suggestions,editState,details); container.append(card);
    }
    preview(); el('minutes-content').hidden = false;
    el('minutes-status').textContent = coverage();
    return cueFields;
  }
  const sampleTime = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  async function loadNameplates(token, cueFields) {
    const status = el('nameplate-status'), list = el('nameplate-list');
    list.replaceChildren();
    if (meeting.provider !== 'hls') { status.textContent = '이 중계에는 명패 수집이 연결되어 있지 않습니다.'; return; }
    status.textContent = '명패 기록을 불러오는 중입니다.';
    try {
      const res = await fetch('/api/live/nameplates?meetingId=' + encodeURIComponent(meeting.id), {cache:'no-store',signal:AbortSignal.timeout(10000)});
      if (!res.ok) throw Error('Nameplate fetch failed');
      const data = await res.json();
      if (token !== version) return;
      const samples = window.CouncilNameplateReview.observations(meeting, archive, data);
      if (!samples.length) { status.textContent = '이 회의에서 수집된 명패 기록이 없습니다.'; return; }
      const found = samples.filter(item => item.names.length);
      status.textContent = `방송 화면 ${samples.length}장 중 ${found.length}장에서 위원 이름을 읽었습니다. 마지막 수집 ${sampleTime.format(samples.at(-1).time)} (한국시간). 화면과 자막의 중계 지연이 달라, 수집 시각 앞뒤 15초의 발언을 함께 대조할 수 있습니다.`;
      const link = document.createElement('a');
      link.href = meeting.officialPage; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '의회 공식 중계 열기';
      status.append(' ', link);
      for (const sample of found.reverse()) {
        const fields = cueFields.get(sample.cueId);
        const time = sampleTime.format(sample.time), names = sample.names.join(' · ');
        const item = document.createElement('li');
        item.textContent = time + '　' + names + ' ';
        function jumpTo(target) {
          const filter = el('minutes-speaker-filter');
          if (filter.checked) { filter.checked = false; filter.dispatchEvent(new Event('change')); }
          target.speaker.focus();
        }
        const shown = new Set();
        function showEvidence(fields) {
          if (shown.has(fields)) return;
          shown.add(fields);
          const note = document.createElement('div');
          note.className = 'cue-nameplate';
          const label = document.createElement('p');
          label.textContent = '발언 근처 화면에서 읽은 이름 · ' + time + ' 수집　' + names;
          if (fields.guess?.name && sample.names.length === 1) {
            label.textContent += fields.guess.name === names ? ' · 발언 내용에서 찾은 후보와 일치' : ' · 발언 내용에서 찾은 후보와 다름';
          }
          note.append(label);
          if (sample.names.length === 1) {
            const apply = document.createElement('button');
            apply.type = 'button'; apply.textContent = '영상 확인 후 ' + names + ' 적용';
            apply.onclick = () => { fields.speaker.value = names; fields.speaker.dispatchEvent(new Event('input', {bubbles:true})); };
            note.append(apply);
          } else note.append(document.createTextNode('여러 이름이 보입니다. 영상을 대조해 발언자를 입력하세요.'));
          fields.metaBox.append(note);
        }
        if (fields) {
          const jump = document.createElement('button');
          jump.type = 'button'; jump.textContent = '수집 시각이 겹치는 발언 보기';
          jump.onclick = () => jumpTo(fields);
          item.append(jump);
          showEvidence(fields);
        } else if (sample.nearbyIds.length) {
          const nearby = document.createElement('details'), title = document.createElement('summary');
          title.textContent = `앞뒤 발언 ${sample.nearbyIds.length}개 대조`;
          nearby.append(title);
          for (const id of sample.nearbyIds) {
            const target = cueFields.get(id), go = document.createElement('button');
            go.type = 'button';
            go.textContent = sampleTime.format(Date.parse(target.cue.observedAt)) + '　' + read(target.cue).slice(0,60);
            go.onclick = () => { showEvidence(target); jumpTo(target); };
            nearby.append(go);
          }
          item.append(nearby);
        } else item.append(document.createTextNode('· 대응 발언 구간 미확인'));
        list.append(item);
      }
    } catch (_) {
      if (token === version) status.textContent = '명패 기록을 불러오지 못했습니다. 기록 새로고침으로 다시 확인할 수 있습니다.';
    }
  }
  el('minutes-speaker-filter').addEventListener('change', event => {
    for (const card of el('minutes-cues').children) {
      card.hidden = event.target.checked && card.dataset.speakerCandidate !== 'yes';
    }
  });
  async function load() {
    if (!meeting) return;
    const token = ++version, id = String(meeting.id);
    el('minutes-status').textContent = '공유 기록을 불러오는 중입니다.'; el('minutes-content').hidden = true; archive = null;
    try {
      const response = await fetch(`/api/live/minutes?meetingId=${encodeURIComponent(id)}`, {cache:'no-store'});
      if (token !== version) return;
      if (response.status === 404) { el('minutes-status').textContent = '이 회의의 공유 기록이 없습니다. 유튜브 중계는 공유 기록이 제공되지 않을 수 있습니다.'; return; }
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (token !== version) return;
      if (String(data.meetingId) !== id || !Array.isArray(data.cues)) throw new Error();
      archive = data;
      if (!archive.cues.length) { el('minutes-status').textContent = '이 회의에 수집된 공유 기록이 없습니다. 유튜브 중계는 공유 기록이 제공되지 않을 수 있습니다.'; return; }
      const fields = render();
      void loadNameplates(token, fields);
    } catch (_) { if (token === version) el('minutes-status').textContent = '공유 기록을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.'; }
  }
  function save(hwpx) {
    if (!archive || !meeting) return;
    const m = model();
    // 내려받는 문서 맨 위(제목 두 줄 다음)에 출처 주소와 내려받은 때를 넣는다
    const header = window.CouncilCitation ? window.CouncilCitation.downloadHeader(window.CouncilCitation.liveLink(location.href, meeting.id), new Date()) : [];
    if (Array.isArray(m.minutesLines)) m.minutesLines = [...m.minutesLines.slice(0, 2), ...header, ...m.minutesLines.slice(2)];
    const blob = hwpx ? CouncilExports.minutesHwpx(m) : new Blob([CouncilExports.minutesText(m)],{type:'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `${meeting.title}_회의록초안.${hwpx ? 'hwpx' : 'txt'}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  el('minutes-open').onclick = () => { el('live-minutes').hidden = false; load(); el('live-minutes').scrollIntoView({behavior:'smooth',block:'start'}); };
  el('minutes-refresh').onclick = load;
  el('minutes-close').onclick = () => { ++version; el('live-minutes').hidden = true; };
  el('minutes-txt').onclick = () => save(false);
  el('minutes-hwpx').onclick = () => save(true);
  window.CouncilLiveMinutes = {select(chosen) { ++version; meeting = chosen; archive = null; el('minutes-content').hidden = true; if (!el('live-minutes').hidden) load(); }};
})();
