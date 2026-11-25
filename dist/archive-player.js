(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const video = el('vod-video');
  let meetings = [], meeting = null, hls = null, loaded = false, resolveGeneration = 0;
  let capture = false, generation = 0, generated = [], catalogCues = [], mergedCues = [];
  let renderedCues = null, cueButtons = [], activeButton = null, recentCue = null, captureError = '';

  function stamp(value) {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60]
      .map(part => String(part).padStart(2, '0')).join(':');
  }
  function updateCues() {
    const sameRange = (a, b) => Math.abs(Number(a.start) - Number(b.start)) <= 0.5 && Math.abs(Number(a.end) - Number(b.end)) <= 0.5;
    const official = catalogCues.filter(cue => cue.source !== 'asr');
    const fresh = generated.filter(cue => !official.some(item => sameRange(item, cue)));
    const cached = catalogCues.filter(cue => cue.source !== 'asr' || !fresh.some(item => sameRange(item, cue)));
    mergedCues = [...cached, ...fresh].sort((a,b) => Number(a.start) - Number(b.start));
  }
  function cueList() { return mergedCues; }
  function sourceLabel(cue) {
    if (cue.source === 'minutes_aligned') return '공식 회의록 대조';
    if (cue.source === 'asr') return '기존 자동 전사 · 미검토';
    if (cue.source === 'local') return '개인 자동 전사 · 미검토';
    return '제공 자막';
  }
  function safeText(cue) {
    const text = String(cue.text || '');
    if (cue.rejected || window.CouncilQuality?.repeated(text)) return '[음성 재확인 필요]';
    return window.CouncilKoreanCorrections?.correct(text).text || text;
  }
  function speaker(cue) {
    if (typeof cue.speaker === 'string') return cue.speaker;
    if (cue.speaker && typeof cue.speaker.name === 'string') return [cue.speaker.name,cue.speaker.role].filter(Boolean).join(' ') + (cue.speaker.confidence ? ' · 추정' : '');
    return '';
  }
  function render() {
    const cues = cueList(), now = video.currentTime || 0, box = el('vod-captions');
    if (renderedCues !== cues) {
      renderedCues = cues; cueButtons = []; activeButton = null; box.replaceChildren();
      for (const cue of cues) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'vod-cue';
        button.textContent = `[${stamp(cue.start)}] ${speaker(cue) ? speaker(cue) + '  ' : ''}${safeText(cue)} · ${sourceLabel(cue)}`;
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
    const main = current ? [speaker(current), safeText(current), sourceLabel(current)].filter(Boolean).join(' · ')
      : cues.length ? '현재 재생 위치에 자막이 없습니다.' : '표시할 자막이 없습니다.';
    const fresh = current?.source !== 'minutes_aligned' && capture && !video.paused && !video.seeking && recentCue &&
      Date.now() - recentCue.receivedAt <= 15000 && now >= recentCue.cue.start && now - recentCue.cue.end <= 60;
    const message = fresh && current !== recentCue.cue
      ? `${main}\n최근 인식 [${stamp(recentCue.cue.start)}] · 인식 지연: ${safeText(recentCue.cue)}` : main;
    if (output.textContent !== message) output.textContent = message;
  }
  function stopCapture(message) {
    if (!capture) return;
    capture = false; ++generation; recentCue = null;
    window.CouncilTabCapture?.stop();
    el('vod-stop').hidden = true;
    el('vod-generate').hidden = false;
    if (message) el('vod-caption-status').textContent = message;
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
    generated = []; catalogCues = []; mergedCues = []; recentCue = null;
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
    updateCues();
    el('vod-caption-status').textContent = catalogCues.length ? '기존 자막이 일부 구간에 제공됩니다. 영상을 재생하며 자막을 추가 생성할 수 있습니다.' : '시간별 자막이 없습니다. 영상을 재생한 뒤 자막을 생성할 수 있습니다.';
    el('vod-generate').hidden = false;
    const playlist = validSource(meeting.playlist);
    if (!playlist) { placeholder.querySelector('p').textContent = '영상 주소를 확인할 수 없습니다. 공식 영상에서 확인하세요.'; el('vod-generate').hidden = true; render(); return; }
    placeholder.querySelector('p').textContent = '영상 연결 중입니다.';
    video.crossOrigin = 'anonymous';
    if (window.Hls?.isSupported()) {
      const current = meeting;
      hls = new window.Hls();
      hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (meeting !== current || !data.fatal) return;
        stopCapture('영상 연결이 끊겨 자막 생성을 중지했습니다.');
        el('vod-video-status').textContent = '영상 연결에 실패했습니다. 공식 영상 보기에서 확인해 주세요.';
        placeholder.hidden = false; placeholder.querySelector('p').textContent = '영상을 불러오지 못했습니다.';
      });
      hls.loadSource(playlist); hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = playlist;
    else { el('vod-video-status').textContent = '이 브라우저에서 영상을 재생할 수 없습니다. 공식 영상에서 확인해 주세요.'; el('vod-generate').hidden = true; }
    render();
  }
  async function generate() {
    if (capture || !meeting) return;
    if (video.paused || video.ended || !video.readyState) { el('vod-caption-status').textContent = '영상을 재생한 뒤 자막 생성을 눌러 주세요.'; return; }
    const token = ++generation; capture = true; captureError = '';
    el('vod-generate').hidden = true; el('vod-stop').hidden = false;
    try {
      await window.CouncilTabCapture.startPlayer({video, mediaTimeline:true,
        onCue: cue => {
          if (!capture || token !== generation) return;
          const start = Number(cue.start), end = Number(cue.end);
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 30 || !String(cue.text || '').trim()) return;
          const item = {id:`local-${token}-${cue.start}`, start, end, text:cue.text, rawText:cue.rawText || cue.text, rejected:cue.rejected, source:'local'};
          generated = generated.filter(old => Math.abs(old.start - item.start) > 0.5 || Math.abs(old.end - item.end) > 0.5);
          generated.push(item); generated.sort((a,b) => a.start - b.start); recentCue = {cue:item, receivedAt:Date.now()}; updateCues(); render();
        },
        onStatus: text => { if (capture && token === generation) { if (/오류|못했습니다/.test(text)) captureError = text; el('vod-caption-status').textContent = `개인 자막 · ${text}`; } },
        onEnd: () => { if (!capture || token !== generation) return; capture = false; recentCue = null; el('vod-stop').hidden = true; el('vod-generate').hidden = false; el('vod-caption-status').textContent = captureError || '자막 생성이 종료되었습니다. 재생 중 다시 시작할 수 있습니다.'; render(); }
      });
    } catch (error) {
      if (token !== generation) return;
      capture = false; el('vod-stop').hidden = true; el('vod-generate').hidden = false;
      el('vod-caption-status').textContent = error.message || '이 영상의 음성을 가져오지 못했습니다. 공식 영상에서 확인해 주세요.';
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
    event.preventDefault();
    const id = parseVodId(el('vod-resolve-input').value);
    const status = el('vod-resolve-status');
    const token = ++resolveGeneration;
    if (!id) { status.textContent = '성남시의회 공식 영상 주소 또는 숫자 영상 번호를 입력해 주세요.'; return; }
    let found = meetings.find(item => String(item.id) === id);
    if (!found) {
      status.textContent = '공식 영상을 확인하고 있습니다.';
      try {
        const response = await fetch('/api/vod/resolve?id=' + encodeURIComponent(id), {cache:'no-store'});
        if (!response.ok) throw Error('영상을 찾지 못했습니다. 공식 영상 주소를 확인해 주세요.');
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
      const response = await fetch('/data/vod-catalog.json', {cache:'no-store'});
      if (!response.ok) throw Error('목록을 불러올 수 없습니다.');
      const data = await response.json(); meetings = Array.isArray(data.meetings) ? data.meetings : [];
      const select = el('vod-meeting-select'); select.replaceChildren();
      for (const item of meetings) { const option = document.createElement('option'); option.value = String(item.id); option.textContent = [item.date,item.title].filter(Boolean).join(' · '); select.append(option); }
      if (!meetings.length) throw Error('등록된 다시보기 영상이 없습니다.');
      const requested = new URL(location.href).searchParams.get('vod');
      const chosen = meetings.find(item => String(item.id) === requested) || meetings[0];
      select.value = String(chosen.id); selectMeeting(chosen.id);
    } catch (error) { loaded = false; el('vod-caption-status').textContent = error.message || '회의 목록을 불러올 수 없습니다.'; }
    finally { el('vod-resolve-form').querySelector('button').disabled = false; }
  }
  el('vod-resolve-form').addEventListener('submit', resolveMeeting);
  el('vod-resolve-input').addEventListener('input', () => { ++resolveGeneration; el('vod-resolve-status').textContent = ''; });
  el('vod-meeting-select').addEventListener('change', event => selectMeeting(event.target.value));
  el('vod-generate').addEventListener('click', generate);
  el('vod-stop').addEventListener('click', () => stopCapture('자막 생성을 중지했습니다.'));
  for (const event of ['pause','seeking','ratechange','waiting','stalled','ended']) video.addEventListener(event, () => { recentCue = null; render(); });
  for (const event of ['seeked','playing']) video.addEventListener(event, render);
  video.addEventListener('timeupdate', render);
  video.addEventListener('loadeddata', () => { el('vod-placeholder').hidden = true; });
  video.addEventListener('error', () => { stopCapture('영상 오류로 자막 생성을 중지했습니다.'); el('vod-video-status').textContent = '영상을 재생할 수 없습니다. 공식 영상 보기에서 확인해 주세요.'; });
  document.addEventListener('council:tabchange', event => {
    if (event.detail?.tab === 'tab-vod') loadCatalog();
    else { ++resolveGeneration; stopCapture('다시보기 탭을 벗어나 자막 생성을 중지했습니다.'); video.pause(); }
  });
})();
