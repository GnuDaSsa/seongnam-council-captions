(() => {
  'use strict';
  const el = id => document.getElementById(id);
  let meeting = null, meetingId = '', source = '', playlist = '', selection = 0, meetings = [];
  let pollTimer, scheduleTimer, liveVisible = true;
  const video = el('live-video'), frame = el('live-video-placeholder'), captions = el('live-captions');
  let hls, retry, mode = '', generation = 0, lastShared = null, localCues = [];
  let historyGeneration = 0;

  function report(text) { el('caption-status').textContent = text; }
  function stopPlayer() { clearTimeout(retry); hls?.destroy(); hls = null; }
  function openBroadcast() {
    stopPlayer(); clearTimeout(scheduleTimer);
    if (!liveVisible || mode === 'tab' || !meeting) return;
    const inlineFrame = el('live-inline-frame');
    const now = Date.now(), startAt = Date.parse(meeting.scheduledAt), endAt = Date.parse(meeting.endsAt);
    const boundary = Number.isFinite(startAt) && now < startAt ? startAt : endAt;
    if (Number.isFinite(boundary) && boundary > now) {
      const currentSelection = selection;
      scheduleTimer = setTimeout(() => {
        if (currentSelection !== selection) return;
        video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
        openBroadcast();
      }, Math.min(boundary - now + 1, 2147483647));
    }
    if ((Number.isFinite(startAt) && now < startAt) || (Number.isFinite(endAt) && now > endAt)) {
      inlineFrame.hidden = true; inlineFrame.removeAttribute('src'); video.hidden = false;
      frame.hidden = false;
      const ended = Number.isFinite(endAt) && now > endAt;
      el('live-status').textContent = ended ? '방송 일정 종료' : '방송 예정';
      frame.querySelector('p').textContent = ended ? '지난 회의는 공식 중계 페이지에서 확인하세요.' : '방송 예정 시간 전입니다.';
      return;
    }
    if (meeting.provider === 'youtube' && meeting.youtubeId) {
      video.hidden = true;
      inlineFrame.hidden = false;
      inlineFrame.src = `https://www.youtube.com/embed/${encodeURIComponent(meeting.youtubeId)}`;
      frame.hidden = true;
      el('live-status').textContent = '유튜브 중계';
      el('live-note').textContent = '영상이 표시되지 않으면 유튜브에서 시청하세요. 개인 자막은 다른 탭 공유를 이용하세요.';
      return;
    }
    inlineFrame.hidden = true; inlineFrame.removeAttribute('src'); video.hidden = false;
    if (!playlist) {
      el('live-status').textContent = '영상 주소 확인 불가';
      frame.querySelector('p').textContent = '공식 중계 페이지에서 확인하세요.';
      return;
    }
    const currentSelection = selection;
    el('live-status').textContent = '영상 연결 중';
    video.crossOrigin = 'anonymous';
    if (window.Hls?.isSupported()) {
      hls = new Hls({lowLatencyMode:false,liveSyncDurationCount:2});
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal || currentSelection !== selection) return;
        stopPlayer(); el('live-status').textContent = '영상 재연결 중';
        retry = setTimeout(() => { if (currentSelection === selection) openBroadcast(); }, 7000);
      });
      hls.loadSource(playlist); hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = playlist;
    else {
      el('live-status').textContent = '공식 페이지에서 시청';
      frame.querySelector('p').textContent = '아래 공식 중계 보기에서 재생하세요.';
      return;
    }
    video.play().catch(() => { el('live-note').textContent = '플레이어의 재생 버튼을 눌러 주세요.'; });
  }
  video.addEventListener('playing', () => {
    frame.hidden = true; el('live-status').textContent = mode === 'tab' ? '공유 탭 재생 중' : '영상 재생 중';
    el('live-note').textContent = video.muted ? '소리를 들으려면 플레이어의 음소거를 해제하세요.' : '';
  });
  video.addEventListener('loadeddata', () => { frame.hidden = true; });
  function stamp(seconds) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${String(Math.floor(n / 3600)).padStart(2,'0')}:${String(Math.floor(n / 60) % 60).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}`;
  }
  const flagNames = {number:'숫자 확인', name:'이름 확인', proceeding:'출석·표결 확인', repetition:'구절 반복', low_confidence:'인식 불확실', severe_uncertainty:'원음 대조 필요', segment_review:'해당 구간 재확인'};
  function reviewFlags(cue) { return Array.isArray(cue.flags) ? cue.flags.map(flag => flagNames[flag] || '추가 확인') : []; }
  function rejected(cue) {
    return !!cue.rejected || cue.flags?.includes('severe_uncertainty') || cue.flags?.includes('repetition') ||
      (cue.flags?.includes('low_confidence') && cue.text === '[음성 재확인]') ||
      !!window.CouncilQuality?.repeated(cue.text) || !!window.CouncilQuality?.repeated(cue.rawText);
  }
  function safeText(cue) {
    if (!rejected(cue)) {
      const value = String((cue.flags?.includes('segment_review') && cue.rawText) || cue.text || '');
      return window.CouncilKoreanCorrections ? window.CouncilKoreanCorrections.correct(value).text : value;
    }
    return cue.flags?.includes('low_confidence') || cue.flags?.includes('segment_review') ? '[음성 재확인 필요]' : '[음성 인식 반복 오류 · 해당 구간 재확인 필요]';
  }
  function hasSpeaker(cue) {
    return !!(String(cue.speaker?.name || '').trim() || String(cue.speaker?.role || '').trim());
  }
  function speakerLabel(cue) {
    const speaker = cue.speaker;
    if (!speaker) return '발언자 미확인';
    const name = typeof speaker.name === 'string' ? speaker.name.trim() : '';
    const role = typeof speaker.role === 'string' ? speaker.role.trim() : '';
    if (!name && !role) return '발언자 미확인';
    const identity = [name,role].filter(Boolean).join(' ') + (!name ? ' (실명 미확인)' : '');
    const selfIntro = /자기소개|self[_ -]?intro/i.test(String(speaker.method || ''));
    return `${identity} · ${selfIntro ? '자기소개 단서 · ' : ''}추정`;
  }
  function uniqueCues(cues) {
    const result = [], positions = new Map();
    for (const cue of cues) {
      const id = cue?.id == null ? '' : String(cue.id);
      if (id && positions.has(id)) result[positions.get(id)] = cue;
      else { if (id) positions.set(id, result.length); result.push(cue); }
    }
    return result;
  }
  function speakerEvidence(cue, byId) {
    const evidence = cue.speaker?.evidence;
    const ids = Array.isArray(evidence) ? evidence : [];
    return ids.map(value => {
      const id = typeof value === 'object' && value !== null ? String(value.id ?? value.cueId ?? '') : String(value);
      const source = byId.get(id);
      if (!source) return id ? `기록 ${id} · 현재 표시 범위 밖` : '';
      const at = source.observedAt && Number.isFinite(Date.parse(source.observedAt)) ? new Date(source.observedAt).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}) : stamp(source.start);
      return `[${at}] ${String(source.rawText || source.text || '').slice(0,280)}`;
    }).filter(Boolean);
  }
  function render(cues) {
    const follow = captions.scrollHeight-captions.scrollTop-captions.clientHeight < 80;
    const expanded = new Set(Array.from(captions.querySelectorAll('details[open]'), item => item.dataset.cue));
    captions.replaceChildren();
    const latest = cues.at(-1);
    el('live-speaker-name').textContent = latest ? speakerLabel(latest) : '발언자 미확인';
    const latestTime = latest ? (latest.observedAt && Number.isFinite(Date.parse(latest.observedAt)) ? new Date(latest.observedAt).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul',hour12:false}) : stamp(latest.start)) : '';
    const method = latest && hasSpeaker(latest) ? String(latest.speaker.method || '').slice(0, 100) : '';
    el('live-speaker-meta').textContent = latest ? [latestTime, method, hasSpeaker(latest) ? '자동 추정 · 확인 필요' : '확인된 이름·직책 없음'].filter(Boolean).join(' · ') : '자막을 기다리는 중';
    const named = cues.filter(cue => String(cue.speaker?.name || '').trim()).length;
    const roles = cues.filter(cue => !String(cue.speaker?.name || '').trim() && String(cue.speaker?.role || '').trim()).length;
    const filtered = el('live-speaker-filter').checked;
    const shown = filtered ? cues.filter(hasSpeaker) : cues;
    const byId = new Map(cues.map(item => [String(item.id), item]));
    el('live-speaker-count').textContent = `전체 ${cues.length}건 중 이름 ${named}건 · 역할만 ${roles}건${filtered ? ` · 표시 ${shown.length}건` : ''}`;
    if (filtered && !shown.length) {
      const empty = document.createElement('p'); empty.className = 'cue-speaker-empty'; empty.textContent = '이름이나 직책이 표시된 발언이 없습니다.'; captions.append(empty);
    }
    for (const cue of shown) {
      const line = document.createElement('p'), time = document.createElement('time'), content = document.createElement('span');
      const interval = `수집 구간 ${stamp(cue.start)} ~ ${stamp(cue.end)}`;
      time.textContent = cue.observedAt ? new Date(cue.observedAt).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul',hour12:false}) : stamp(cue.start);
      time.title = interval;
      const person = document.createElement('strong'); person.className = 'cue-speaker'; person.textContent = speakerLabel(cue); content.append(person);
      if (cue.speaker && speakerLabel(cue) !== '발언자 미확인') {
        const details = document.createElement('details'), summary = document.createElement('summary'), reason = document.createElement('small');
        details.className = 'cue-speaker-evidence'; details.dataset.cue = String(cue.id) + ':speaker'; details.open = expanded.has(details.dataset.cue);
        summary.textContent = '발언자 추정 근거';
        const method = typeof cue.speaker.method === 'string' ? cue.speaker.method.slice(0, 200) : '';
        reason.textContent = [method, ...speakerEvidence(cue, byId)].filter(Boolean).join('\n');
        details.append(summary, reason); content.append(details);
      }
      const text = document.createElement('span'); text.className = 'cue-content'; text.textContent = safeText(cue); content.append(text);
      const sourceText = String((cue.flags?.includes('segment_review') && cue.rawText) || cue.text || '');
      const corrected = !rejected(cue) && safeText(cue) !== sourceText;
      if (corrected) { const label = document.createElement('small'); label.className = 'cue-review'; label.textContent = '문맥 교정됨 · 원문 대조'; content.append(label); }
      if (Array.isArray(cue.flags) && cue.flags.length) {
        const flag = document.createElement('small'); flag.className = 'cue-review'; flag.textContent = `검토 필요: ${reviewFlags(cue).join(', ')}`; content.append(flag);
      }
      if (rejected(cue)) {
        const details = document.createElement('details'), summary = document.createElement('summary'), raw = document.createElement('small');
        details.dataset.cue = cue.id;
        details.open = expanded.has(cue.id);
        summary.textContent = '인식 원문 대조'; raw.textContent = cue.rawText || cue.text || '';
        details.append(summary, raw); content.append(details);
      } else if ((cue.rawText || cue.text) && ((cue.rawText && cue.rawText !== cue.text) || corrected)) {
        const raw = document.createElement('small'); raw.className = 'cue-raw'; raw.textContent = `인식 원문: ${cue.rawText || cue.text}`; content.append(raw);
      }
      line.append(time, content); captions.append(line);
    }
    if (follow && !expanded.size) captions.scrollTop = captions.scrollHeight;
    el('live-save').disabled = !cues.length;
  }
  el('live-speaker-filter').addEventListener('change', () => render(mode ? localCues : (lastShared?.cues || [])));
  async function loadSpeakerHistory() {
    const panel = el('live-speaker-history'), status = el('live-speaker-history-status'), list = el('live-speaker-history-list');
    const ticket = ++historyGeneration, selected = selection, id = meetingId;
    list.replaceChildren();
    if (!panel.open || mode === 'tab' || !meeting) return;
    status.textContent = '이전 발언을 불러오는 중입니다.';
    try {
      const response = await fetch(`/api/live/minutes?meetingId=${encodeURIComponent(id)}`, {cache:'no-store'});
      if (ticket !== historyGeneration || selected !== selection || mode === 'tab' || !panel.open) return;
      if (!response.ok) throw new Error('회의록을 불러오지 못했습니다.');
      const archive = await response.json();
      if (ticket !== historyGeneration || selected !== selection || mode === 'tab' || !panel.open) return;
      if (String(archive.meetingId) !== id || !Array.isArray(archive.cues)) throw new Error('회의록을 확인할 수 없습니다.');
      let candidates = {};
      try { candidates = window.CouncilLiveSpeaker?.attribute(meeting, archive.cues, [], archive.gaps || []) || {}; } catch (_) {}
      const matches = uniqueCues(archive.cues).map(cue => ({...cue, speaker:cue.speaker || candidates[String(cue.id)]})).filter(hasSpeaker);
      const rows = matches.slice(-30).reverse();
      if (!rows.length) { status.textContent = '이름이나 역할이 추정된 이전 발언이 없습니다.'; return; }
      status.textContent = `이 회의에서 추정한 발언 ${matches.length}건 · 최근 ${rows.length}건 표시`;
      const byId = new Map(archive.cues.map(cue => [String(cue.id),cue]));
      for (const cue of rows) {
        const item = document.createElement('li');
        const time = cue.observedAt && Number.isFinite(Date.parse(cue.observedAt)) ? new Date(cue.observedAt).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul',hour12:false}) : stamp(cue.start);
        const heading = document.createElement('strong'), excerpt = document.createElement('span');
        heading.textContent = time + ' · ' + speakerLabel(cue);
        excerpt.textContent = safeText(cue).slice(0,120);
        const details = document.createElement('details'), summary = document.createElement('summary'), evidence = document.createElement('small');
        summary.textContent = '발언자 추정 근거';
        evidence.textContent = [cue.speaker.method,...speakerEvidence(cue,byId)].filter(Boolean).join('\n');
        details.append(summary,evidence);
        item.append(heading,excerpt,details);
        list.append(item);
      }
    } catch (_) {
      if (ticket === historyGeneration && selected === selection && mode !== 'tab' && panel.open) status.textContent = '이전 발언을 불러오지 못했습니다.';
    }
  }
  el('live-speaker-history').addEventListener('toggle', () => { if (el('live-speaker-history').open) loadSpeakerHistory(); else ++historyGeneration; });
  function sharedStatus(data) {
    if (data.status === 'ended') return '공유 자막 제공 종료';
    if (data.status === 'interrupted') return '공유 자막 제공이 중단되었습니다. 마지막으로 받은 자막을 표시합니다.';
    const age = Date.now() - Date.parse(data.updatedAt);
    if (!Number.isFinite(age) || age > 30000 || age < -60000) return '공유 자막 갱신이 지연되고 있습니다. 마지막으로 받은 자막을 표시합니다.';
    return ({listening:'공유 자막 연결됨 · 발언을 기다리는 중',live:'공유 자막 제공 중 · 자동 생성, 검토 필요',ended:'공유 자막 제공 종료'})[data.status] || '공유 자막 상태를 확인할 수 없습니다.';
  }
  async function poll(currentSelection) {
    if (currentSelection !== selection) return;
    try {
      const response = await fetch(`/api/live/captions?meetingId=${encodeURIComponent(meetingId)}`, {cache:'no-store'});
      if (currentSelection !== selection) return;
      if (response.status === 404) { if (!mode) report('이 회의의 공유 자막이 아직 제공되지 않습니다.'); }
      else if (!response.ok) { if (!mode) report('공유 자막 서버에 연결할 수 없습니다. 마지막으로 받은 자막을 표시합니다.'); }
      else {
        const data = await response.json();
        if (currentSelection !== selection) return;
        if (String(data.meetingId) !== meetingId || !Array.isArray(data.cues)) {
          if (!mode) report('이 회의의 공유 자막을 확인할 수 없습니다.');
        } else {
          const changed = !lastShared || JSON.stringify(lastShared.cues) !== JSON.stringify(data.cues);
          data.cues = uniqueCues(data.cues);
          lastShared = data;
          if (!mode) { if (changed) render(data.cues); report(sharedStatus(data)); }
        }
      }
    } catch (_) { if (currentSelection === selection && !mode) report('공유 자막 서버에 연결할 수 없습니다. 마지막으로 받은 자막을 표시합니다.'); }
    if (currentSelection === selection) pollTimer = setTimeout(() => poll(currentSelection), 3000);
  }
  function updateLocalSpeakers() {
    if (mode !== 'player' || meeting?.provider !== 'hls' || !window.CouncilLiveSpeaker?.attribute) return;
    try {
      const candidates = window.CouncilLiveSpeaker.attribute(meeting, localCues, [], []);
      if (!candidates || typeof candidates !== 'object' || Array.isArray(candidates)) return;
      localCues = localCues.map(cue => ({...cue, speaker:candidates[String(cue.id)] || undefined}));
    } catch (_) {
      // Personal transcription remains available if the optional local attribution cannot run.
      localCues = localCues.map(cue => ({...cue, speaker:undefined}));
    }
  }
  function controls(busy) {
    el('player-captions').hidden = busy; el('capture-start').hidden = busy; el('capture-stop').hidden = !busy;
  }
  async function start(which) {
    if (mode) return;
    if (which === 'player' && (meeting?.provider === 'youtube' || !video.readyState)) { report('영상을 재생한 뒤 개인 자막을 켜 주세요. 유튜브는 다른 탭 공유를 이용하세요.'); return; }
    const session = ++generation;
    mode = which; ++historyGeneration; el('live-speaker-history').hidden = which === 'tab'; controls(true); localCues = []; el('local-save').disabled = true; el('local-save-txt').disabled = true; render(localCues);
    if (which === 'tab') stopPlayer();
    else { video.muted = false; video.play().catch(() => {}); }
    try {
      const recognizer = window.CouncilTabCapture;
      const handler = which === 'tab' ? recognizer.start : recognizer.startPlayer;
      await handler({video, onCue: cue => {
        if (session !== generation || !String(cue.text || '').trim()) return;
        localCues.push({id:String(localCues.length+1),start:Number(cue.start),end:Number(cue.end),observedAt:cue.observedAt,text:cue.text,rawText:cue.rawText || cue.text,rejected:cue.rejected,flags:[]}); updateLocalSpeakers(); el('local-save').disabled = false; el('local-save-txt').disabled = false; render(localCues);
      }, onStatus: text => { if (session === generation) report(`개인 자막 · ${text}`); },
      onEnd: () => { if (session !== generation) return; mode=''; el('live-speaker-history').hidden = false; if (el('live-speaker-history').open) loadSpeakerHistory(); controls(false); if (lastShared) { render(lastShared.cues); report(sharedStatus(lastShared)); } else { render([]); report('공유 자막을 확인하는 중입니다.'); } if (which === 'tab') openBroadcast(); }});
    } catch (error) {
      if (session !== generation) return;
      mode=''; el('live-speaker-history').hidden = false; if (el('live-speaker-history').open) loadSpeakerHistory(); controls(false); report(error.message || '개인 음성 인식을 시작하지 못했습니다.');
      if (lastShared) render(lastShared.cues);
      if (which === 'tab') openBroadcast();
    }
  }
  el('player-captions').onclick = () => start('player');
  el('capture-start').onclick = () => start('tab');
  el('capture-stop').onclick = () => { window.CouncilTabCapture.stop(); };
  function saveCues(cues, personal, textOnly = false) {
    if (!cues.length) return;
    const segments = cues.map(cue => ({id:cue.id,start:cue.start,end:cue.end,speaker:speakerLabel(cue),text:[cue.observedAt ? `수집 시각: ${new Date(cue.observedAt).toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})}` : '', safeText(cue), !rejected(cue) && safeText(cue) !== String((cue.flags?.includes('segment_review') && cue.rawText) || cue.text || '') ? '문맥 교정됨' : '', !rejected(cue) && (cue.rawText || cue.text) && ((cue.rawText && cue.rawText !== cue.text) || safeText(cue) !== String(cue.text || '')) ? `인식 원문: ${cue.rawText || cue.text}` : '', reviewFlags(cue).length ? `검토 필요: ${reviewFlags(cue).join(', ')}` : ''].filter(Boolean).join('\n'),status:rejected(cue) ? '인식 오류 · 재확인 필요' : 'AI 전사 · 미검토'}));
    const doc={title:`${meeting.title} ${meeting.label}`,date:meeting.scheduledAt?.slice(0,10) || '',body:`성남시의회 ${meeting.title}`,sourceUrl:source,coverage:personal ? '이 브라우저에서 수집한 자동 자막.' : '저장 시 표시된 공유 자동 자막.',segments};
    const blob = textOnly ? new Blob([CouncilExports.minutesText(doc)], {type:'text/plain;charset=utf-8'}) : CouncilExports.minutesHwpx(doc);
    const url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url; a.download=`${meeting.title}_${meeting.label}_자막초안.${textOnly ? "txt" : "hwpx"}`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),3000);
  }
  el('live-save').onclick = () => saveCues(mode ? localCues : (lastShared?.cues || []), !!mode);
  el('local-save').onclick = () => saveCues(localCues, true);
  el('local-save-txt').onclick = () => saveCues(localCues, true, true);
  video.muted=true;
  document.addEventListener?.('council:tabchange', event => {
    const visible = event.detail?.tab === 'tab-live';
    if (visible === liveVisible) return;
    liveVisible = visible;
    if (visible) { if (!mode && meeting) openBroadcast(); return; }
    if (mode) window.CouncilTabCapture?.stop();
    stopPlayer(); clearTimeout(scheduleTimer);
    video.pause();
    video.removeAttribute('src'); video.load();
    const inline = el('live-inline-frame');
    if (inline && !inline.hidden) { inline.removeAttribute('src'); inline.hidden = true; }
  });
  report('공유 자막을 확인하는 중입니다.');
  function selectMeeting(id) {
    const chosen = meetings.find(item => String(item.id) === String(id)) || meetings.find(item => String(item.id) === '2853') || meetings[0];
    if (!chosen) return;
    ++selection; ++generation; ++historyGeneration; clearTimeout(pollTimer); clearTimeout(scheduleTimer);
    if (mode) { mode = ''; window.CouncilTabCapture?.stop(); controls(false); }
    stopPlayer(); video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load(); video.muted = true;
    frame.hidden = false; frame.querySelector('p').textContent = '공유 자막을 확인하는 중입니다.';
    meeting = chosen; meetingId = String(chosen.id); source = chosen.source; playlist = chosen.playlist;
    window.CouncilLiveMinutes.select(chosen);
    el('live-inline-frame').hidden = true; el('live-inline-frame').removeAttribute('src');
    lastShared = null; localCues = []; el('live-speaker-history').hidden = false; el('live-speaker-history-list').replaceChildren(); el('live-speaker-history-status').textContent = ''; el('local-save').disabled = true; el('local-save-txt').disabled = true; render([]);
    if (el('live-speaker-history').open) loadSpeakerHistory();
    el('live-meeting-select').value = meetingId;
    el('live-title').textContent = `${chosen.title} ${chosen.label}`;
    const when = chosen.scheduledAt ? new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',month:'numeric',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(chosen.scheduledAt)) : '';
    el('live-meeting-date').textContent = [when, ...(chosen.agenda || [])].filter(Boolean).join(' · ');
    el('live-source').href = source;
    el('live-source').textContent = chosen.provider === 'youtube' ? '유튜브에서 보기 ↗' : '공식 중계 보기 ↗';
    el('live-official').href = chosen.officialPage || source;
    el('live-official').hidden = !chosen.officialPage || chosen.officialPage === source;
    const url = new URL(location.href); url.searchParams.set('live', meetingId); history.replaceState(null, '', url);
    report('공유 자막을 확인하는 중입니다.'); openBroadcast(); poll(selection);
  }
  el('live-meeting-select').addEventListener('change', event => selectMeeting(event.target.value));
  fetch('/data/live-meetings.json', {cache:'no-store'}).then(response => {
    if (!response.ok) throw new Error('회의 목록을 불러오지 못했습니다.');
    return response.json();
  }).then(data => {
    meetings = Array.isArray(data.meetings) ? data.meetings : [];
    if (!meetings.length) throw new Error('등록된 생중계가 없습니다.');
    for (const item of meetings) { const option = document.createElement('option'); option.value = String(item.id); option.textContent = item.title; el('live-meeting-select').append(option); }
    selectMeeting(new URL(location.href).searchParams.get('live') || '2853');
  }).catch(error => { report(error.message || '회의 목록을 불러오지 못했습니다.'); el('live-status').textContent = '회의 목록 확인 불가'; });
})();
