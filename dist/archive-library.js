(() => {
  'use strict';
  const status = document.getElementById('archive-library-status');
  const list = document.getElementById('archive-library-list');
  const koreanClock = new Intl.DateTimeFormat('ko-KR', {
    timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23',
  });
  const format = value => koreanClock.format(new Date(value));
  const labels = {ended:'수집 종료', interrupted:'수집 중단', unknown:'마지막 수집본 · 종료 여부 미확인'};
  const riskFlags = new Set(['segment_review','low_confidence','severe_uncertainty','repetition','mixed','overlap','mixed_speaker','multi_speaker']);
  const flagLabels = {number:'숫자 확인', name:'이름 확인', proceeding:'출석·표결 확인', segment_review:'구간 원음 대조',
    low_confidence:'인식 불확실', severe_uncertainty:'원음 대조 필요', repetition:'반복 인식 확인', mixed:'겹친 발언', overlap:'겹친 발언'};
  const recordings = new Map();
  let loading = false;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  async function getJson(url) {
    const response = await fetch(url, {cache:'no-store'});
    if (!response.ok) throw Error('unavailable');
    return response.json();
  }

  function verifiedRecording(meeting, index) {
    const matches = (index?.meetings || []).filter(row => row.liveMeetingId === meeting.id);
    if (matches.length !== 1) return null;
    const row = matches[0];
    if (!/^[1-9]\d{0,7}$/.test(row.id) || !row.officialPage ||
        row.officialPage !== 'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=' + row.id + '&position=0') return null;
    // A live ID links this recording to the sitting. Per-cue media positions are not available on this surface.
    return row.officialPage;
  }

  function archiveRow(meeting) {
    const row = element('article', null, 'archive-library-row');
    const details = element('div'), actions = element('div', null, 'archive-library-actions');
    details.append(element('strong', [meeting.title, meeting.label].filter(Boolean).join(' · ')),
      element('p', labels[meeting.status] + ' · 마지막 자막 ' + format(meeting.lastCapturedAt) + ' · ' + format(meeting.expiresAt) + '까지'));
    const recording = recordings.get(meeting.id);
    const source = element('a', recording ? '공식 다시보기 ↗' : '공식 생방송 페이지 ↗');
    source.href = recording || meeting.officialPage;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    actions.append(source);
    for (const kind of ['hwpx','txt']) {
      const button = element('button', '회의록 초안 다운로드 · ' + kind.toUpperCase(), 'button secondary');
      button.type = 'button';
      button.dataset.archiveId = meeting.id;
      button.dataset.archiveKind = kind;
      actions.append(button);
    }
    row.append(details, actions);
    return row;
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    status.textContent = '보관된 자막을 불러오고 있습니다.';
    try {
      const [catalog, index] = await Promise.all([
        getJson('/api/archive/catalog'),
        getJson('/data/vod-index.json').catch(() => null),
      ]);
      if (!Array.isArray(catalog.meetings)) throw Error('invalid catalog');
      const rows = [];
      recordings.clear();
      for (const meeting of catalog.meetings) {
        if (!/^[1-9]\d{0,11}$/.test(meeting.id) || !Object.hasOwn(labels, meeting.status) ||
            ![meeting.expiresAt, meeting.lastCapturedAt].every(value => Number.isFinite(Date.parse(value)))) continue;
        recordings.set(meeting.id, verifiedRecording(meeting, index));
        rows.push(archiveRow(meeting));
      }
      list.replaceChildren(...rows);
      status.textContent = rows.length ? '' : '현재 내려받을 수 있는 수집본이 없습니다.';
    } catch {
      list.replaceChildren();
      status.textContent = '보관함을 불러오지 못했습니다. 잠시 뒤 다시 확인해 주세요.';
    } finally {
      loading = false;
    }
  }

  function elapsedTime(value) {
    const seconds = Math.floor(value);
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(part => String(part).padStart(2, '0')).join(':');
  }

  function documentLines(meeting, minutes) {
    const recording = recordings.get(meeting.id);
    const lines = [meeting.title + ' AI 생성 회의록 초안',
      '공식 회의록이 아닙니다. 공식 영상과 원문을 확인해 주세요.',
      '회의 예정 시각  ' + format(meeting.scheduledAt), '공식 생방송 페이지  ' + meeting.officialPage];
    if (recording) lines.push('공식 다시보기  ' + recording);
    lines.push('수집 상태  ' + labels[meeting.status], '마지막 자막  ' + format(meeting.lastCapturedAt),
      '수록 자막  ' + minutes.cues.length + '건', '', '발언 기록 · 한국시간');
    for (const cue of minutes.cues) {
      const flags = cue.flags || [];
      const reviewed = !flags.some(flag => riskFlags.has(flag));
      let who = '발언자 미확인';
      if (reviewed && cue.speaker?.name) who = [cue.speaker.name, cue.speaker.role].filter(Boolean).join(' ') + ' · 자동 추정';
      else if (reviewed && cue.speaker?.role) who = cue.speaker.role + ' · 역할 추정';
      const observed = Number.isFinite(Date.parse(cue.observedAt)) ? format(cue.observedAt) : '수집 시각 미확인';
      const range = Number.isFinite(cue.start) && Number.isFinite(cue.end) ?
        ' · 수집 경과 ' + elapsedTime(cue.start) + ' ~ ' + elapsedTime(cue.end) : '';
      lines.push('[' + observed + range + '] ' + who, cue.text || '');
      if (flags.length) lines.push('대조 표시  ' + flags.map(flag => flagLabels[flag] || flag).join(', '));
      if (cue.rawText && cue.rawText !== cue.text) lines.push('인식 원문  ' + cue.rawText);
      lines.push('');
    }
    if (minutes.gaps?.length) {
      lines.push('수집 중단 기록');
      for (const gap of minutes.gaps) lines.push(format(gap.start) + ' ~ ' + (gap.end ? format(gap.end) : '재개 시각 미확인'));
    }
    return lines;
  }

  list.addEventListener('click', async event => {
    const button = event.target.closest('button[data-archive-id]');
    if (!button || button.disabled) return;
    const {archiveId:id, archiveKind:kind} = button.dataset;
    button.disabled = true;
    status.textContent = '수집본을 준비하고 있습니다.';
    try {
      const data = await getJson('/api/archive/meetings/' + encodeURIComponent(id));
      if (data.meeting?.id !== id || !Array.isArray(data.minutes?.cues) || !data.minutes.cues.length) throw Error('invalid minutes');
      const documentData = {minutesLines:documentLines(data.meeting, data.minutes)};
      const blob = kind === 'hwpx' ? window.CouncilExports.minutesHwpx(documentData) :
        new Blob([window.CouncilExports.minutesText(documentData)], {type:'text/plain;charset=utf-8'});
      const link = element('a');
      link.href = URL.createObjectURL(blob);
      link.download = '성남시의회_AI_회의록_초안_' + id + '.' + kind;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      status.textContent = 'AI 생성 회의록 초안을 내려받았습니다.';
    } catch {
      status.textContent = '수집본이 만료됐거나 불러오지 못했습니다. 목록을 다시 확인해 주세요.';
    } finally {
      button.disabled = false;
    }
  });
  document.addEventListener('council:tabchange', event => {
    if (event.detail?.tab === 'tab-archive') refresh();
  });
})();
