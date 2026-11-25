(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const video = el('vod-video');
  let meetings = [], meeting = null, hls = null, loaded = false, resolveGeneration = 0;
  let capture = false, generation = 0, generated = [], catalogCues = [], track = 'existing', canGenerate = false;
  let renderedCues = null, cueButtons = [], activeButton = null, recentCue = null, captureError = '';
  let speechContext = [];

  function stamp(value) {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60]
      .map(part => String(part).padStart(2, '0')).join(':');
  }
  function cueList() { return track === 'existing' ? catalogCues : generated; }
  function updateTrackUI(message) {
    const personal = track === 'personal';
    el('vod-mode-existing').checked = !personal;
    el('vod-mode-personal').checked = personal;
    el('vod-track-summary').textContent = personal
      ? '현재 재생 위치의 음성을 이 브라우저에서 받아씁니다.'
      : '영상에 미리 준비한 자막입니다. 각 발언에 회의록 대조 여부를 표시합니다.';
    el('vod-generate').hidden = !personal || capture || !canGenerate;
    el('vod-stop').hidden = !personal || !capture;
    if (message) el('vod-caption-status').textContent = message;
    else if (!personal) el('vod-caption-status').textContent = catalogCues.length
      ? `현재 영상에 기존 자막 ${catalogCues.length}개 구간이 있습니다.`
      : '이 영상에 기존 자막이 없습니다. 지금 음성 인식을 선택해 생성할 수 있습니다.';
    else if (!canGenerate) el('vod-caption-status').textContent = '영상 연결을 확인할 수 없어 음성 인식을 시작할 수 없습니다.';
    else if (!capture) el('vod-caption-status').textContent = generated.length
      ? '생성한 개인 자막이 있습니다. 재생 중 다시 생성할 수 있습니다.'
      : '영상을 재생한 뒤 ‘음성 인식 시작’을 누르세요.';
  }
  function inferPersonalSpeaker(cue) {
    speechContext = [...speechContext.slice(-7),cue];
    if (!window.CouncilLiveSpeaker?.attribute || !meeting) return;
    try {
      const candidate = window.CouncilLiveSpeaker.attribute(meeting,speechContext,[],[])[cue.id];
      if (!candidate || cue.rejected) return;
      const members = new Set(Array.isArray(meeting.members) ? meeting.members : []);
      const name = members.has(candidate.name) ? candidate.name : '';
      // Keep only the role suffix when the candidate label itself contains a name.
      const role = String(candidate.role || '').trim().match(/(센터장|위원장|질의자|답변자|담당관|주무관|과장|국장|팀장|부장|소장|의원|위원)$/)?.[1] || '';
      if (name || role) return {...candidate,name,role};
    } catch (_) { return undefined; }
  }
  function sourceLabel(cue) {
    if (cue.source === 'minutes_aligned') return '공식 회의록 대조';
    if (cue.source === 'asr') return '사전 자동 전사 · 미검토';
    if (cue.source === 'local') return '지금 음성 인식 · 미검토';
    return '제공 자막';
  }
  function safeText(cue) {
    const text = String(cue.text || '');
    if (cue.source === 'minutes_aligned') return text;
    if (cue.rejected || window.CouncilQuality?.repeated(text)) return '[음성 재확인 필요]';
    return window.CouncilKoreanCorrections?.correct(text).text || text;
  }
  function speaker(cue) {
    if (typeof cue.speaker === 'string' && cue.speaker.trim()) {
      return cue.speaker.trim() + (cue.source === 'minutes_aligned' ? ' · 기록 확인' : ' · 추정');
    }
    if (cue.speaker && (cue.speaker.name || cue.speaker.role)) {
      const who = [cue.speaker.name,cue.speaker.role].filter(Boolean).join(' ');
      return who + (cue.source === 'minutes_aligned' && !cue.speaker.confidence ? ' · 기록 확인' : ' · 추정');
    }
    return '발언자 미확인';
  }
  function part(tag, className, text) {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  }
  function render() {
    const cues = cueList(), now = video.currentTime || 0, box = el('vod-captions');
    if (renderedCues !== cues) {
      renderedCues = cues; cueButtons = []; activeButton = null; box.replaceChildren();
      for (const cue of cues) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'vod-cue';
        button.append(part('span','vod-cue-time',stamp(cue.start)), part('strong','vod-cue-speaker',speaker(cue)),
          part('span','vod-cue-text',safeText(cue)), part('small','vod-cue-source',sourceLabel(cue)));
        button.onclick = () => { video.currentTime = Number(cue.start); };
        box.append(button); cueButtons.push(button);
      }
    }
    let index = -1;
    for (let i = 0; i < cues.length; i++) {
      if (Number(cues[i].start) <= now && now < Number(cues[i].end)) {
        index = i;
        if (cues[i].source === 'minutes_aligned') break;
      }
    }
    const current = index < 0 ? null : cues[index];
    const nextButton = index < 0 ? null : cueButtons[index];
    if (nextButton !== activeButton) {
      activeButton?.removeAttribute('aria-current');
      nextButton?.setAttribute('aria-current', 'true'); activeButton = nextButton;
    }
    const output = el('vod-caption-now');
    const fresh = track === 'personal' && capture && !video.paused && !video.seeking && recentCue &&
      Date.now() - recentCue.receivedAt <= 15000 && now >= recentCue.cue.start && now - recentCue.cue.end <= 60;
    const recent = fresh && current !== recentCue.cue ? recentCue.cue : null;
    const signature = JSON.stringify([current?.id, current && speaker(current), current && safeText(current), recent?.id, recent && speaker(recent), track, cues.length]);
    if (output.dataset.signature !== signature) {
      output.dataset.signature = signature; output.replaceChildren();
      if (current) output.append(part('strong','vod-now-speaker',speaker(current)), part('span','vod-now-text',safeText(current)), part('small','vod-now-source',sourceLabel(current)));
      else output.append(part('span','vod-now-text',cues.length ? '현재 재생 위치에 자막이 없습니다.' : '표시할 자막이 없습니다.'));
      if (recent) {
        const note = document.createElement('div'); note.className = 'vod-now-recent';
        note.append(part('small','vod-now-source',`최근 인식 [${stamp(recent.start)}] · 인식 지연 · ${sourceLabel(recent)}`),
          part('strong','vod-now-speaker',speaker(recent)), part('span','vod-now-text',safeText(recent)));
        output.append(note);
      }
    }
  }
  function stopCapture(message) {
    if (!capture) return;
    capture = false; ++generation; recentCue = null;
    window.CouncilTabCapture?.stop();
    updateTrackUI(message); render();
  }
  function stopPlayer() {
    stopCapture(); video.pause();
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src'); video.load();
  }
  function validSource(value) {
    try { const url = new URL(value, location.href); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; }
    catch (_) { return ''; }
  }
  function selectMeeting(id) {
    ++resolveGeneration; stopPlayer(); meeting = meetings.find(item => String(item.id) === String(id)) || null;
    generated = []; catalogCues = []; track = 'existing'; canGenerate = false; recentCue = null;
    const placeholder = el('vod-placeholder'); placeholder.hidden = false;
    el('vod-video-status').textContent = '';
    el('vod-stop').hidden = true; el('vod-generate').hidden = true;
    if (!meeting) { placeholder.querySelector('p').textContent = '회의를 선택해 주세요.'; render(); return; }
    el('vod-source').href = validSource(meeting.officialPage);
    const minutesLink = el('vod-minutes');
    minutesLink.hidden = true; minutesLink.removeAttribute('href');
    if (/^https:\/\/www\.sncouncil\.go\.kr\/record\/recordView\.do\?key=[a-f0-9]+$/.test(meeting.minutesUrl || '')) {
      minutesLink.href = meeting.minutesUrl;
      minutesLink.hidden = false;
    }
    catalogCues = (Array.isArray(meeting.cues) ? meeting.cues : []).filter(cue => Number.isFinite(Number(cue.start)) && Number.isFinite(Number(cue.end)) && Number(cue.end) > Number(cue.start) && typeof cue.text === 'string').sort((a,b) => Number(a.start) - Number(b.start));
    updateTrackUI();
    const playlist = validSource(meeting.playlist);
    if (!playlist) { placeholder.querySelector('p').textContent = '영상 주소를 확인할 수 없습니다. 공식 영상에서 확인하세요.'; render(); return; }
    canGenerate = true; updateTrackUI();
    placeholder.querySelector('p').textContent = '영상 연결 중입니다.';
    video.crossOrigin = 'anonymous';
    if (window.Hls?.isSupported()) {
      const current = meeting;
      hls = new window.Hls();
      hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (meeting !== current || !data.fatal) return;
        canGenerate = false; stopCapture('영상 연결이 끊겨 자막 생성을 중지했습니다.'); updateTrackUI('영상 연결에 실패했습니다. 공식 영상에서 확인해 주세요.');
        el('vod-video-status').textContent = '영상 연결에 실패했습니다. 공식 영상 보기에서 확인해 주세요.';
        placeholder.hidden = false; placeholder.querySelector('p').textContent = '영상을 불러오지 못했습니다.';
      });
      hls.loadSource(playlist); hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = playlist;
    else { canGenerate = false; updateTrackUI(); el('vod-video-status').textContent = '이 브라우저에서 영상을 재생할 수 없습니다. 공식 영상에서 확인해 주세요.'; }
    render();
  }
  async function generate() {
    if (capture || !meeting || track !== 'personal' || !canGenerate) return;
    if (video.paused || video.ended || !video.readyState) { el('vod-caption-status').textContent = '영상을 재생한 뒤 ‘음성 인식 시작’을 누르세요.'; return; }
    const token = ++generation; capture = true; captureError = ''; speechContext = [];
    updateTrackUI('개인 음성 인식을 준비하고 있습니다.');
    try {
      await window.CouncilTabCapture.startPlayer({video, mediaTimeline:true,
        onCue: cue => {
          if (!capture || token !== generation) return;
          const start = Number(cue.start), end = Number(cue.end);
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 30 || !String(cue.text || '').trim()) return;
          const item = {id:`local-${token}-${cue.start}`, start, end, text:cue.text, rawText:cue.rawText || cue.text, rejected:cue.rejected, flags:cue.flags, source:'local'};
          generated = generated.filter(old => Math.abs(old.start - item.start) > 0.5 || Math.abs(old.end - item.end) > 0.5);
          item.speaker = inferPersonalSpeaker(item);
          generated.push(item); generated.sort((a,b) => a.start - b.start); recentCue = {cue:item, receivedAt:Date.now()}; render();
        },
        onStatus: text => { if (capture && token === generation) { if (/오류|못했습니다/.test(text)) captureError = text; el('vod-caption-status').textContent = `개인 자막 · ${text}`; } },
        onEnd: () => { if (!capture || token !== generation) return; capture = false; recentCue = null; updateTrackUI(captureError || '자막 생성이 종료되었습니다. 재생 중 다시 시작할 수 있습니다.'); render(); }
      });
    } catch (error) {
      if (token !== generation) return;
      capture = false; updateTrackUI(error.message || '이 영상의 음성을 가져오지 못했습니다. 공식 영상에서 확인해 주세요.');
    }
  }
  function parseVodId(value) {
    const text = value.trim();
    if (/^\d{1,12}$/.test(text)) return text;
    try {
      const url = new URL(text);
      const ids = url.searchParams.getAll('pk_vod_no');
      if (url.protocol !== 'https:' || url.hostname !== 'cast.sncouncil.go.kr' ||
          (url.port && url.port !== '443') || url.username || url.password ||
          url.pathname !== '/vod/vod_view.jsp' || ids.length !== 1 || !/^\d{1,12}$/.test(ids[0])) return '';
      return ids[0];
    } catch (_) { return ''; }
  }
  function validMeeting(row, id) {
    if (!row || String(row.id) !== id || typeof row.title !== 'string' || !row.title.trim()) return false;
    try {
      const page = new URL(row.officialPage);
      const playlist = new URL(row.playlist, location.href);
      return parseVodId(page.href) === id && !playlist.username && !playlist.password &&
        ((playlist.protocol === 'https:' && playlist.hostname === 'cast.sncouncil.go.kr') || playlist.origin === location.origin);
    } catch (_) { return false; }
  }
  async function resolveMeeting(event) {
    event?.preventDefault();
    const id = parseVodId(el('vod-resolve-input').value);
    const status = el('vod-resolve-status');
    const token = ++resolveGeneration;
    if (!id) { status.textContent = '성남시의회 공식 영상 주소 또는 숫자 영상 번호를 입력해 주세요.'; return; }
    let found = meetings.find(item => String(item.id) === id);
    if (!found) {
      status.textContent = '공식 영상을 확인하고 있습니다.';
      try {
        const response = await fetch('/api/vod/resolve?id=' + encodeURIComponent(id), {cache:'no-store'});
        if (!response.ok) throw Error(response.status === 404 ? '영상을 찾지 못했습니다. 공식 영상 주소를 확인해 주세요.' : '공식 영상 목록에 연결할 수 없습니다. 잠시 후 다시 열어 주세요.');
        const data = await response.json();
        if (token !== resolveGeneration || el('vod-panel').hidden) return;
        if (!validMeeting(data, id)) throw Error('공식 영상 정보를 확인할 수 없습니다.');
        found = data; meetings.push(found);
        const option = document.createElement('option'); option.value = id;
        option.textContent = [found.date, found.title].filter(Boolean).join(' · ');
        el('vod-meeting-select').append(option);
      } catch (error) {
        if (token === resolveGeneration && !el('vod-panel').hidden) status.textContent = error.message || '영상을 불러오지 못했습니다.';
        return;
      }
    }
    if (token !== resolveGeneration || el('vod-panel').hidden) return;
    el('vod-meeting-select').value = id; selectMeeting(id);
    status.textContent = '선택한 영상을 열었습니다.';
  }
  async function loadCatalog() {
    if (loaded) return;
    loaded = true;
    try {
      const [response,index] = await Promise.all([
        fetch('/data/vod-catalog.json', {cache:'no-store'}),
        fetch('/data/vod-index.json').then(r=>r.ok?r.json():null).catch(()=>null)
      ]);
      if (!response.ok) throw Error('목록을 불러올 수 없습니다.');
      const data = await response.json(); meetings = Array.isArray(data.meetings) ? data.meetings : [];
      const existing = new Set(meetings.map(item=>String(item.id)));
      for (const row of index?.meetings || []) {
        if (!existing.has(row.id) && validMeeting(row,row.id)) { meetings.push(row); existing.add(row.id); }
      }
      const select = el('vod-meeting-select'); select.replaceChildren();
      for (const item of meetings) { const option = document.createElement('option'); option.value = String(item.id); option.textContent = [item.date,item.title].filter(Boolean).join(' · '); select.append(option); }
      if (!meetings.length) throw Error('등록된 다시보기 영상이 없습니다.');
      const requested = new URL(location.href).searchParams.get('vod');
      const chosen = meetings.find(item => String(item.id) === requested) || meetings[0];
      select.value = String(chosen.id); selectMeeting(chosen.id);
      if (requested && requested !== String(chosen.id) && parseVodId(requested) && !el('vod-panel').hidden) {
        el('vod-resolve-input').value = requested;
        await resolveMeeting();
      }
    } catch (error) { loaded = false; el('vod-caption-status').textContent = error.message || '회의 목록을 불러올 수 없습니다.'; }
    finally { el('vod-resolve-form').querySelector('button').disabled = false; }
  }
  el('vod-resolve-form').addEventListener('submit', resolveMeeting);
  el('vod-resolve-input').addEventListener('input', () => { ++resolveGeneration; el('vod-resolve-status').textContent = ''; });
  el('vod-meeting-select').addEventListener('change', event => selectMeeting(event.target.value));
  for (const value of ['existing','personal']) {
    el('vod-mode-' + value).addEventListener('change', event => {
      if (!event.target.checked) return;
      if (value === 'existing') stopCapture();
      track = value; recentCue = null;
      updateTrackUI(); render();
    });
  }
  el('vod-generate').addEventListener('click', generate);
  el('vod-stop').addEventListener('click', () => stopCapture('자막 생성을 중지했습니다.'));
  for (const event of ['pause','seeking','ratechange','waiting','stalled','ended']) {
    video.addEventListener(event, () => {
      recentCue = null; speechContext = [];
      if (capture && track === 'personal') el('vod-caption-status').textContent =
        event === 'ended' ? '재생이 끝났습니다. 다시 재생하면 인식을 이어갑니다.' :
        event === 'pause' ? '영상이 일시정지되어 음성 인식이 대기 중입니다.' :
        event === 'waiting' || event === 'stalled' ? '영상 연결을 기다리는 동안 음성 인식이 대기 중입니다.' :
        '재생 위치나 속도가 바뀌어 음성 인식 구간을 다시 맞추고 있습니다.';
      render();
    });
  }
  for (const event of ['seeked','playing']) video.addEventListener(event, () => {
    if (event === 'playing' && capture && track === 'personal') el('vod-caption-status').textContent = '영상 재생 중 · 음성 인식을 진행합니다.';
    render();
  });
  video.addEventListener('timeupdate', render);
  video.addEventListener('loadeddata', () => { el('vod-placeholder').hidden = true; });
  video.addEventListener('error', () => { canGenerate = false; stopCapture('영상 오류로 자막 생성을 중지했습니다.'); updateTrackUI('영상 오류로 자막 생성을 중지했습니다.'); el('vod-video-status').textContent = '영상을 재생할 수 없습니다. 공식 영상 보기에서 확인해 주세요.'; });
  document.addEventListener('council:tabchange', event => {
    if (event.detail?.tab === 'tab-vod') loadCatalog();
    else { ++resolveGeneration; stopCapture('다시보기 탭을 벗어나 자막 생성을 중지했습니다.'); video.pause(); }
  });
})();
