(() => {
  'use strict';
  const el = id => document.getElementById(id);
  let meeting = null, meetingId = '', source = '', playlist = '', selection = 0, meetings = [];
  let defaultMeeting = null;
  const councilDate = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'});
  let pollTimer, scheduleTimer, refreshTimer, liveVisible = true;
  let scheduleDate = '', scheduleGeneration = 0, scheduleLoading = false, linkedHistorical = false;
  const video = el('live-video'), frame = el('live-video-placeholder'), captions = el('live-captions');
  let hls, retry, mode = '', generation = 0, lastShared = null, localCues = [];
  let historyGeneration = 0, historyScrollPending = false;
  const reportTools=window.CouncilPersonalCaptionReport;
  const reportMode=reportTools?.modeFor?.(location.origin);
  const showReportForm=reportMode==='hosted' ? reportTools.bindForm(el('live-report'),el('caption-report-template')) : null;
  const reportDrafts=new Map();
  let sharedHold=null, selectedReport=null;
  const historySize=220, historyOverlap=56;
  let sharedArchive=null, historyWindow=null, historyLoad=null, historyError='';

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
      frame.hidden = false;
      el('live-status').textContent = '공식 페이지에서 시청';
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
    if (!sharedHold) video.play().catch(() => { el('live-note').textContent = '플레이어의 재생 버튼을 눌러 주세요.'; });
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
  function reportSupported() {
    return !!reportMode && (!mode || (mode==='player' && !!showReportForm && meeting?.provider==='hls')) && !!meetingId &&
      meeting?.officialPage===reportTools.officialLiveUrl(meetingId);
  }
  function sharedTail() { return sharedHold?.cues || lastShared?.cues || []; }
  function shownShared() { return historyWindow?.cues || sharedTail(); }
  function updateSharedHistoryControl() {
    const panel=el('live-history-controls');
    if (!panel) return;
    panel.hidden=!meeting || !!mode;
    const {first=0,end=0}=historyWindow || {};
    el('live-history-first').disabled=!!historyLoad || !!historyWindow && first===0;
    el('live-history-earlier').disabled=!!historyLoad || !!historyWindow && first===0;
    el('live-history-newer').disabled=!!historyLoad || !historyWindow || end>=sharedArchive.length;
    el('live-history-latest').disabled=!historyWindow;
    const status=el('live-history-range');
    const message=historyLoad?'앞선 자막을 불러오는 중입니다.':historyError ||
      (historyWindow?`${first+1}–${end} / ${sharedArchive.length}개 수집 자막`:'최근 공유 자막');
    if (status.textContent!==message) status.textContent=message;
  }
  function resetSharedHistory() {
    historyLoad?.abort();
    historyLoad=sharedArchive=historyWindow=null;
    historyError='';
  }
  async function loadSharedArchive() {
    const request=new AbortController(), chosen=selection, id=meetingId;
    const timeout=setTimeout(()=>request.abort(),15000);
    historyLoad=request;historyError='';updateSharedHistoryControl();
    try {
      const response=await fetch('/api/live/minutes?meetingId='+encodeURIComponent(id),{cache:'no-store',signal:request.signal});
      if (!response.ok) throw Error('회의의 누적 자막을 불러오지 못했습니다.');
      const archive=await response.json();
      if (historyLoad!==request || selection!==chosen || mode) return false;
      if (String(archive.meetingId)!==id || !Array.isArray(archive.cues)) throw Error('회의의 누적 자막을 확인할 수 없습니다.');
      const rows=archive.cues.filter(cue=>typeof cue?.id==='string' && Number.isFinite(cue.start) && Number.isFinite(cue.end) &&
        cue.end>cue.start && typeof cue.text==='string');
      const trusted=archive.speakerAttributionApplied===true ? rows : rows.map(cue=>({...cue,speaker:undefined}));
      sharedArchive=uniqueCues([...trusted,...sharedTail()]);
      if (!sharedArchive.length) { historyError='아직 쌓인 공유 자막이 없습니다.'; return false; }
      return true;
    } catch (_) {
      if (historyLoad===request && selection===chosen && !mode) historyError='회의의 누적 자막을 불러오지 못했습니다.';
      return false;
    } finally {
      clearTimeout(timeout);
      if (historyLoad===request) { historyLoad=null; updateSharedHistoryControl(); }
    }
  }
  async function browseSharedHistory(direction) {
    if (!meeting || mode || historyLoad) return;
    if (direction==='latest') {
      resetSharedHistory();selectedReport=null;render(sharedTail());captions.scrollTop=captions.scrollHeight;return;
    }
    const anchor=direction==='earlier' ? captions.querySelector('[data-live-cue]') : null;
    const anchorId=anchor?.dataset.liveCue, anchorTop=anchor?.getBoundingClientRect().top;
    const firstId=shownShared()[0]?.id, chosen=selection;
    if (!sharedArchive && !await loadSharedArchive()) return;
    if (chosen!==selection || mode || !sharedArchive?.length) return;
    const length=sharedArchive.length;
    const before=historyWindow ? historyWindow.first : sharedArchive.findIndex(cue=>cue.id===firstId);
    let end;
    if (direction==='first') end=Math.min(historySize,length);
    else if (direction==='newer') end=Math.min(length,historyWindow.end+historySize-historyOverlap);
    else end=Math.min(length,Math.max(historySize,(before<0 ? length : before)+historyOverlap));
    const first=Math.max(0,end-historySize);
    historyWindow={first,end,cues:sharedArchive.slice(first,end)};
    render(shownShared());
    const matched=anchorId && Array.from(captions.querySelectorAll('[data-live-cue]')).find(row=>row.dataset.liveCue===anchorId);
    if (matched) captions.scrollTop+=matched.getBoundingClientRect().top-anchorTop;
    else captions.scrollTop=direction==='earlier' ? captions.scrollHeight : 0;
  }
  for (const direction of ['first','earlier','newer','latest'])
    el('live-history-'+direction)?.addEventListener('click',()=>void browseSharedHistory(direction));
  captions.addEventListener('wheel',event=>{
    if (!historyError && event.deltaY<0 && captions.scrollTop<3 && (!historyWindow || historyWindow.first>0))
      void browseSharedHistory('earlier');
  },{passive:true});
  function reportContext(cue) {
    if (!reportSupported()) return null;
    const observed=mode==='player' && Number.isFinite(cue.observedAt) ? cue.observedAt : Date.parse(cue.observedAt);
    const at=new Date(observed);
    if (!Number.isFinite(at.getTime())) return null;
    const observedAt=mode==='player' ? at.toISOString() : cue.observedAt;
    if (!reportTools.koreanWallTime(observedAt)) return null;
    const scheduled=Date.parse(meeting.scheduledAt), ended=Date.parse(meeting.endsAt);
    if (!Number.isFinite(scheduled) || !Number.isFinite(ended) || observed<scheduled-3600000 || observed>ended+3600000) return null;
    return {meetingId,meetingTitle:[meeting.title,meeting.label].filter(Boolean).join(' '),cueId:String(cue.id||''),
      observedAt,speaker:speakerLabel(cue),quote:safeText(cue),rawQuote:String(cue.rawText||cue.text||'')};
  }
  function updateSharedReportControl() {
    if (!reportMode) return;
    const panel=el('live-report'), hold=el('live-report-hold'), action=el('live-report-open'), status=el('live-report-status');
    if (!panel || !hold || !action || !status) return;
    const personal=mode==='player';
    const available=reportSupported() && (personal ? localCues.length>0 : shownShared().some(cue=>reportTools.koreanWallTime(cue.observedAt)));
    panel.hidden=!available && !selectedReport;
    hold.hidden=!available || personal;
    hold.setAttribute('aria-pressed',String(!!sharedHold));
    hold.textContent=sharedHold?'재생 재개':'자막 멈추기';
    const href=selectedReport?.url||'', disabled=String(!href);
    const cancel=el('live-report-cancel'), issues=el('live-report-issues');
    if (cancel) cancel.hidden=!selectedReport;
    action.hidden=!!showReportForm;
    if (issues) { issues.hidden=!showReportForm; issues.href=reportTools.issuesUrl; }
    if (showReportForm) showReportForm(selectedReport?.form);
    if ((action.getAttribute('href')||'')!==href) {
      if (href) action.href=href; else action.removeAttribute('href');
    }
    if (action.getAttribute('aria-disabled')!==disabled) action.setAttribute('aria-disabled',disabled);
    const message=selectedReport?.status || (personal?'제보할 개인 자막 줄을 선택하세요.':sharedHold?'멈춘 목록에서 신고할 자막 줄을 선택하세요.':'신고할 자막 줄을 선택하면 목록이 멈춥니다.');
    if (status.textContent!==message) status.textContent=message;
  }
  function holdShared() {
    if (sharedHold || !shownShared().length || !reportSupported()) return;
    sharedHold={cues:lastShared?.cues||[],wasPlaying:!video.paused && !video.hidden};
    if (sharedHold.wasPlaying) video.pause();
  }
  function toggleSharedHold() {
    if (!reportSupported()) return;
    if (!sharedHold) { holdShared(); updateSharedReportControl(); return; }
    const resume=sharedHold.wasPlaying;
    sharedHold=null;selectedReport=null;
    render(shownShared());
    if (resume && liveVisible) video.play().catch(()=>{});
  }
  el('live-report-hold')?.addEventListener('click',toggleSharedHold);
  el('live-report-cancel')?.addEventListener('click',()=>{
    selectedReport=null;
    render(mode==='player' ? localCues : shownShared());
  });
  function chooseSharedReport(cue,context) {
    const personal=mode==='player';
    if (!personal) { holdShared(); if (!sharedHold) return; }
    const key=(personal?'personal:':'shared:')+context.cueId;
    const signature=JSON.stringify(context), existing=reportDrafts.get(key);
    const time=reportTools.koreanWallTime(context.observedAt);
    let recent=existing;
    if (recent?.signature!==signature) {
      const form=showReportForm ? reportTools.hostedDraft(context,personal ? 'live-personal' : 'live-shared') : null;
      const url=showReportForm ? '' : reportTools.reportUrl(context,{id:crypto.randomUUID(),kind:'자막 내용 오류',note:''});
      recent={id:cue.id,signature,form,url,status:form || url ? time+(personal?' 개인 자막을 선택했습니다.':' 자막을 선택했습니다.') : '이 자막의 신고 정보를 준비할 수 없습니다.'};
      if (!existing && reportDrafts.size>=200) reportDrafts.delete(reportDrafts.keys().next().value);
      reportDrafts.set(key,recent);
    }
    selectedReport=recent;
    render(personal ? localCues : shownShared());
    if (recent.url && reportMode==='local') void reportTools.bridgeReady().then(available=>{
      if (selectedReport!==recent || available) return;
      recent.status=time+' 자막을 선택했습니다. 먼저 GitHub_이슈_연결.cmd를 실행한 뒤 신고 양식을 열어 주세요.';
      updateSharedReportControl();
    });
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
  function appendRosterSource(details, speaker) {
    if (!speaker?.name || !meeting) return;
    const staff = meeting.staffRoster?.find(row => row.name === speaker.name && row.role === speaker.role);
    const member = meeting.members?.includes(speaker.name);
    const url = staff?.source || (member && meeting.memberSource);
    if (!url || !/^https:\/\/(?:www\.)?sncouncil\.go\.kr\//.test(url)) return;
    const link = document.createElement('a');
    link.href = url;
    link.textContent = staff ? '직책과 이름을 확인한 공식 회의록' : '공식 위원회 명단';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    details.append(link);
  }
  function appendRegisteredVodSource(details, speaker) {
    const href=window.CouncilLiveSpeaker?.registeredVodHref?.(speaker?.registeredVodReference);
    if (!href) return false;
    const link=document.createElement('a');
    link.className='registered-vod-reference'; link.textContent='발언자 근거 영상';
    link.href=href; link.target='_blank'; link.rel='noopener noreferrer';
    details.append(link);
    return true;
  }
  function speakerEvidence(cue, byId) {
    const evidence = cue.speaker?.evidence;
    const ids = Array.isArray(evidence) ? evidence : [];
    return ids.map(value => {
      const id = typeof value === 'object' && value !== null ? String(value.id ?? value.cueId ?? '') : String(value);
      const source = byId.get(id);
      if (!source) return id ? `기록 ${id} · 현재 표시 범위 밖` : '';
      const at = source.observedAt && Number.isFinite(new Date(source.observedAt).getTime()) ? new Date(source.observedAt).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}) : stamp(source.start);
      return `[${at}] ${String(source.rawText || source.text || '').slice(0,280)}`;
    }).filter(Boolean);
  }
  function nameplateDisplay(value, selectedMeeting, historical = false) {
    if (!value || !Number.isFinite(Date.parse(value.capturedAt))) return null;
    const captured = Date.parse(value.capturedAt), now = Date.now();
    if (captured > now + 60000 || (!historical && captured < now - 86400000)) return null;
    const start = Date.parse(selectedMeeting?.scheduledAt), end = Date.parse(selectedMeeting?.endsAt);
    if (Number.isFinite(start) && captured < start - 4 * 3600000) return null;
    if (Number.isFinite(end) && captured > end + 4 * 3600000) return null;
    const roster = new Set((selectedMeeting?.members || []).map(item => typeof item === 'string' ? item : item?.name).filter(Boolean).map(String));
    const names = Array.isArray(value.matchedMembers) ? [...new Set(value.matchedMembers.filter(name => typeof name === 'string' && name.length <= 24 && (!roster.size || roster.has(name))))] : [];
    return {time:new Date(captured).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}), names, captured};
  }
  function renderNameplateStatus() {
    const target = el('live-speaker-visual');
    if (!target) return;
    target.textContent = ''; target.hidden = true;
    if (mode || !lastShared || String(lastShared.meetingId) !== meetingId) return;
    const state = lastShared.nameplateStatus;
    if (!state || !state.latest) return;
    const latest = nameplateDisplay(state.latest, meeting);
    if (!latest) return;
    const fresh = Date.now() - latest.captured <= 120000;
    let label;
    if (fresh) {
      label = `최근 명패 판독 ${latest.time} · ${latest.names.length ? latest.names.join(', ') : '읽힌 이름 없음'}`;
      const lastMatch = nameplateDisplay(state.lastMatch, meeting);
      if (!latest.names.length && lastMatch?.names.length && lastMatch.captured<latest.captured)
        label += ` / 마지막 이름 판독 ${lastMatch.time} · ${lastMatch.names.join(', ')}`;
    } else {
      const lastMatch = nameplateDisplay(state.lastMatch, meeting);
      label = lastMatch?.names.length ? `마지막 이름 판독 ${lastMatch.time} · ${lastMatch.names.join(', ')}` : `마지막 판독 ${latest.time} · 읽힌 이름 없음`;
    }
    target.textContent = label; target.hidden = false;
  }
  function render(cues) {
    renderNameplateStatus();
    const scrollTop=captions.scrollTop;
    const follow = captions.scrollHeight-captions.scrollTop-captions.clientHeight < 80;
    const box=captions.getBoundingClientRect?.();
    const anchor=box && (!follow || historyWindow || sharedHold) ?
      Array.from(captions.querySelectorAll('[data-live-cue]')).find(row=>row.getBoundingClientRect().bottom>box.top) : null;
    const anchorTop=anchor?.getBoundingClientRect().top;
    const focusedId=captions.contains?.(document.activeElement) ? document.activeElement?.dataset?.reportCue : undefined;
    let restoreFocus, scrollAnchor;
    const expanded = new Set(Array.from(captions.querySelectorAll('details[open]'), item => item.dataset.cue));
    captions.replaceChildren();
    const latest = cues.at(-1);
    el('live-speaker-name').textContent = latest ? speakerLabel(latest) : '발언자 미확인';
    const recentLink = el('live-speaker-recent');
    if (recentLink) {
      const recent = !mode && [...cues].reverse().find(cue => String(cue.speaker?.name || '').trim() && cue.id != null);
      const available = !mode && lastShared && String(lastShared.meetingId) === meetingId;
      recentLink.hidden = !available;
      if (available) {
        const url = new URL(location.href);
        url.search = ''; url.hash = '';
        url.searchParams.set('live', meetingId);
        if (recent) url.searchParams.set('cue', String(recent.id)); else url.searchParams.set('speaker','recent');
        recentLink.href = url.pathname + url.search + url.hash;
        const time = recent && (recent.observedAt && Number.isFinite(new Date(recent.observedAt).getTime()) ? new Date(recent.observedAt).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul',hour12:false}) : stamp(recent.start));
        recentLink.textContent = recent ? `이름이 추정된 최근 발언 · ${time} · ${speakerLabel(recent)} · 원문 보기` : '이 회의에서 이름이 추정된 최근 발언 보기';
      } else { recentLink.removeAttribute('href'); recentLink.textContent = ''; }
    }
    const latestTime = latest ? (latest.observedAt && Number.isFinite(new Date(latest.observedAt).getTime()) ? new Date(latest.observedAt).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul',hour12:false}) : stamp(latest.start)) : '';
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
      line.dataset.liveCue=String(cue.id);
      if (anchor?.dataset.liveCue===line.dataset.liveCue) scrollAnchor=line;
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
        details.append(summary, reason);
        appendRosterSource(details, cue.speaker);
        appendRegisteredVodSource(details, cue.speaker);
        content.append(details);
      }
      const context=reportContext(cue);
      const text = document.createElement(context?'button':'span'); text.className = 'cue-content'; text.textContent = safeText(cue); content.append(text);
      if (context) {
        const selected=selectedReport?.id===cue.id;
        text.type='button';text.classList.add('live-cue-select');
        text.dataset.reportCue=context.cueId; text.setAttribute('aria-pressed',String(selected));
        line.classList.add('live-cue-reportable');
        if (selected) line.classList.add('live-cue-selected');
        text.onclick=()=>chooseSharedReport(cue,context);
        line.onclick=event=>{if(!event.target.closest?.('a,button,summary,details')) chooseSharedReport(cue,context);};
        if (focusedId===context.cueId) restoreFocus=text;
      }
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
    if (follow && !expanded.size && !sharedHold && !historyWindow) captions.scrollTop = captions.scrollHeight;
    else {
      captions.scrollTop=scrollTop;
      if (scrollAnchor) captions.scrollTop+=scrollAnchor.getBoundingClientRect().top-anchorTop;
    }
    restoreFocus?.focus({preventScroll:true});
    updateSharedReportControl();
    updateSharedHistoryControl();
    el('live-save').disabled = !cues.length;
  }
  el('live-speaker-filter').addEventListener('change', () => render(mode ? localCues : shownShared()));
  async function loadSpeakerHistory() {
    if (!/^[1-9]\d{0,7}$/.test(meetingId)) return;
    const panel = el('live-speaker-history'), status = el('live-speaker-history-status'), list = el('live-speaker-history-list');
    const ticket = ++historyGeneration, selected = selection, id = meetingId;
    list.replaceChildren();
    if (!panel.open || mode === 'tab' || !meeting) return;
    status.textContent = '이전 발언을 불러오는 중입니다.';
    try {
      const [minutesResult, nameplatesResult] = await Promise.allSettled([
        fetch(`/api/live/minutes?meetingId=${encodeURIComponent(id)}`, {cache:'no-store'}),
        fetch(`/api/live/nameplates?meetingId=${encodeURIComponent(id)}`, {cache:'no-store'})
      ]);
      if (ticket !== historyGeneration || selected !== selection || mode === 'tab' || !panel.open) return;
      if (minutesResult.status !== 'fulfilled' || !minutesResult.value.ok) throw new Error('회의록을 불러오지 못했습니다.');
      const archive = await minutesResult.value.json();
      if (ticket !== historyGeneration || selected !== selection || mode === 'tab' || !panel.open) return;
      if (String(archive.meetingId) !== id || !Array.isArray(archive.cues)) throw new Error('회의록을 확인할 수 없습니다.');
      let observations = [];
      if (nameplatesResult.status === 'fulfilled' && nameplatesResult.value.ok) {
        try {
          const nameplates = await nameplatesResult.value.json();
          if (String(nameplates.meetingId) === id && Array.isArray(nameplates.observations)) observations = nameplates.observations;
        } catch (_) { /* Nameplate history is optional. */ }
      }
      if (ticket !== historyGeneration || selected !== selection || mode === 'tab' || !panel.open) return;
      let all = uniqueCues(archive.cues);
      if (archive.speakerAttributionApplied !== true) {
        let candidates = {};
        try { candidates = window.CouncilLiveSpeaker?.attribute(meeting, all, observations, archive.gaps || []) || {}; } catch (_) {}
        all = all.map(cue => ({...cue, speaker:Object.hasOwn(candidates,cue.id) ? candidates[cue.id] : undefined}));
      }
      const matches = all.filter(hasSpeaker);
      const url = new URL(location.href);
      let requestedId = url.searchParams.get('cue');
      if (!requestedId && url.searchParams.get('speaker') === 'recent') {
        const recent = [...all].reverse().find(cue => String(cue.speaker?.name || '').trim());
        if (!recent) { status.textContent = '아직 이름이 추정된 발언이 없습니다.'; return; }
        requestedId = String(recent.id); url.searchParams.delete('speaker'); url.searchParams.set('cue', requestedId);
        history.replaceState(null, '', url);
      }
      const requested = requestedId ? all.find(cue => String(cue.id) === requestedId) : null;
      const rows = matches.slice(-30).reverse();
      if (requested) {
        const index = rows.findIndex(cue => String(cue.id) === requestedId);
        if (index >= 0) rows.splice(index,1);
        rows.unshift(requested);
      }
      if (!rows.length) { status.textContent = requestedId ? '요청한 자막을 찾을 수 없습니다.' : '이름이나 역할이 추정된 이전 발언이 없습니다.'; return; }
      status.textContent = `${requestedId && !requested ? '요청한 자막을 찾을 수 없습니다. · ' : ''}이 회의에서 추정한 발언 ${matches.length}건 · 최근 ${Math.min(matches.length,30)}건 표시`;
      const byId = new Map(archive.cues.map(cue => [String(cue.id),cue]));
      let selectedItem = null;
      for (const cue of rows) {
        const item = document.createElement('li');
        const isSelected = requestedId && String(cue.id) === requestedId;
        if (isSelected) { item.setAttribute('aria-current','true'); selectedItem = item; }
        const time = cue.observedAt && Number.isFinite(new Date(cue.observedAt).getTime()) ? new Date(cue.observedAt).toLocaleTimeString('ko-KR', {timeZone:'Asia/Seoul',hour12:false}) : stamp(cue.start);
        const heading = document.createElement('strong'), excerpt = document.createElement('span');
        heading.textContent = time + ' · ' + speakerLabel(cue);
        excerpt.textContent = isSelected ? String(cue.rawText || cue.text || '').slice(0,280) : safeText(cue).slice(0,120);
        const details = document.createElement('details'), summary = document.createElement('summary'), evidence = document.createElement('small');
        summary.textContent = '발언자 추정 근거';
        details.open = !!isSelected;
        evidence.textContent = [cue.speaker?.method,...speakerEvidence(cue,byId)].filter(Boolean).join('\n');
        const observedAt = cue.observedAt && new Date(cue.observedAt).getTime();
        const nearby = Number.isFinite(observedAt) ? observations.filter(item => Math.abs(Date.parse(item.capturedAt) - observedAt) <= 5000) : [];
        if (nearby.length) evidence.textContent += '\n명패 판독(발언자 확정 아님): ' + nearby.map(item => {
          const reading = nameplateDisplay(item, meeting, true);
          return reading ? `${reading.time} · ${reading.names.join(', ') || '읽힌 이름 없음'}` : '';
        }).filter(Boolean).join(' / ');
        details.append(summary,evidence);
        appendRosterSource(details,cue.speaker);
        const hasRegisteredVod=appendRegisteredVodSource(details,cue.speaker);
        item.append(heading,excerpt);
        if (evidence.textContent.trim() || hasRegisteredVod) item.append(details);
        list.append(item);
      }
      if (selectedItem && historyScrollPending) { historyScrollPending = false; selectedItem.scrollIntoView?.({block:'nearest'}); }
    } catch (_) {
      if (ticket === historyGeneration && selected === selection && mode !== 'tab' && panel.open) status.textContent = '이전 발언을 불러오지 못했습니다.';
    }
  }
  el('live-speaker-history').addEventListener('toggle', () => { if (el('live-speaker-history').open) loadSpeakerHistory(); else ++historyGeneration; });
  el('live-speaker-recent')?.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const href = el('live-speaker-recent').href;
    if (!href) return;
    event.preventDefault();
    history.replaceState(null, '', href);
    historyScrollPending = true;
    const panel = el('live-speaker-history');
    if (panel.open) loadSpeakerHistory(); else panel.open = true;
  });
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
          const changed = !lastShared || JSON.stringify(lastShared.cues) !== JSON.stringify(data.cues) || JSON.stringify(lastShared.nameplateStatus) !== JSON.stringify(data.nameplateStatus);
          data.cues = uniqueCues(data.cues);
          lastShared = data;
          if (!mode) {
            if (!sharedHold && !historyWindow) { if (changed) render(data.cues); else renderNameplateStatus(); }
            report(sharedStatus(data));
          }
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
    sharedHold=null;selectedReport=null;resetSharedHistory();
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
  function selectMeeting(id, updateUrl = true) {
    const chosen = meetings.find(item => String(item.id) === String(id)) || defaultMeeting;
    if (!chosen) return;
    ++selection; ++generation; ++historyGeneration; clearTimeout(pollTimer); clearTimeout(scheduleTimer);
    if (mode) { mode = ''; window.CouncilTabCapture?.stop(); controls(false); }
    stopPlayer(); video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load(); video.muted = true;
    frame.hidden = false; frame.querySelector('p').textContent = '공유 자막을 확인하는 중입니다.';
    meeting = chosen; meetingId = String(chosen.id);
    const identified = /^[1-9]\d{0,7}$/.test(meetingId);
    source = chosen.allExternal ? (chosen.externalBroadcastUrl || chosen.officialPage || '') : (chosen.officialPage || chosen.source || chosen.broadcastUrl || chosen.externalBroadcastUrl || ''); playlist = chosen.playlist;
    sharedHold=null;selectedReport=null;reportDrafts.clear();resetSharedHistory();
    el('live-minutes').hidden = true; window.CouncilLiveMinutes.select(identified ? chosen : null);
    el('player-captions').disabled = false; el('capture-start').disabled = false; el('minutes-open').disabled = !identified;
    el('live-inline-frame').hidden = true; el('live-inline-frame').removeAttribute('src');
    lastShared = null; localCues = []; el('live-speaker-history').hidden = !identified; el('live-speaker-history-list').replaceChildren(); el('live-speaker-history-status').textContent = ''; el('local-save').disabled = true; el('local-save-txt').disabled = true; render([]);
    const linkUrl = new URL(location.href);
    if (linkUrl.searchParams.has('live') && String(linkUrl.searchParams.get('live')) !== meetingId) { linkUrl.searchParams.delete('live'); linkUrl.searchParams.delete('cue'); linkUrl.searchParams.delete('speaker'); history.replaceState(null, '', linkUrl); }
    if (updateUrl) { linkUrl.searchParams.set('live', meetingId); history.replaceState(null, '', linkUrl); }
    const panel = el('live-speaker-history');
    const linked = linkUrl.searchParams.has('cue') || linkUrl.searchParams.get('speaker') === 'recent';
    historyScrollPending = linked;
    if (identified && linked && !panel.open) panel.open = true;
    else if (identified && panel.open) loadSpeakerHistory();
    el('live-meeting-select').value = meetingId;
    el('live-title').textContent = [chosen.title, chosen.label].filter(Boolean).join(' ');
    const when = chosen.scheduledAt ? new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',month:'numeric',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(chosen.scheduledAt)) : '';
    el('live-meeting-date').textContent = [when, ...(chosen.agenda || [])].filter(Boolean).join(' · ');
    el('live-source').href = source; el('live-source').hidden = !source;
    el('live-source').textContent = (chosen.provider === 'youtube' || chosen.allExternal) ? '유튜브에서 보기 ↗' : '공식 중계 보기 ↗';
    el('live-official').href = chosen.externalBroadcastUrl || '';
    el('live-official').hidden = !chosen.externalBroadcastUrl || chosen.externalBroadcastUrl === source;
    el('live-official').textContent = '외청 유튜브 보기 ↗';
    report(identified ? '공유 자막을 확인하는 중입니다.' : '회의 식별자 확인 전입니다. 공식 일정을 확인하세요.'); openBroadcast(); if (identified) poll(selection);
  }
  el('live-meeting-select').addEventListener('change', event => { if (String(event.target.value) !== meetingId) linkedHistorical = false; selectMeeting(event.target.value); });
  function clearMeeting(message) {
    ++selection; ++generation; ++historyGeneration; clearTimeout(pollTimer); clearTimeout(scheduleTimer);
    if (mode) { mode = ''; window.CouncilTabCapture?.stop(); controls(false); }
    sharedHold=null; selectedReport=null; reportDrafts.clear(); resetSharedHistory();
    stopPlayer(); video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
    const inline = el('live-inline-frame'); inline.hidden = true; inline.removeAttribute('src');
    meeting = null; meetingId = ''; source = ''; playlist = ''; lastShared = null; localCues = [];
    el('live-minutes').hidden = true; window.CouncilLiveMinutes.select(null);
    render([]); el('live-save').disabled = true; el('local-save').disabled = true; el('local-save-txt').disabled = true;
    el('live-speaker-history-list').replaceChildren(); el('live-speaker-history-status').textContent = '';
    el('live-speaker-history').hidden = true;
    frame.hidden = false; frame.querySelector('p').textContent = message;
    el('live-title').textContent = '생중계'; el('live-meeting-date').textContent = '';
    el('live-source').hidden = true; el('live-official').hidden = true; el('live-note').textContent = '';
    el('player-captions').disabled = true; el('capture-start').disabled = true; el('minutes-open').disabled = true;
    el('live-source').removeAttribute('href'); el('live-official').removeAttribute('href');
    el('live-status').textContent = message; report(message);
  }
  async function refreshSchedule(initial = false) {
    if (scheduleLoading) return;
    scheduleLoading = true;
    const ticket = ++scheduleGeneration;
    try {
      const response = await fetch('/api/live/schedule', {cache:'no-store'});
      if (!response.ok) throw new Error('일정을 불러오지 못했습니다.');
      const data = await response.json();
      if (!data || data.date !== councilDate.format(new Date()) || !Array.isArray(data.meetings)) throw new Error('일정을 확인할 수 없습니다.');
      const valid = data.meetings.filter(item => item && (/^[1-9]\d{0,7}$/.test(String(item.id)) || new RegExp('^schedule-' + data.date + '-[1-9]\\d*$').test(String(item.id))) && typeof item.title === 'string' && item.title.trim());
      const counts = new Map(); for (const item of valid) counts.set(String(item.id), (counts.get(String(item.id)) || 0) + 1);
      let next = valid.filter(item => counts.get(String(item.id)) === 1);
      let requested = initial ? new URL(location.href).searchParams.get('live') : null;
      let replaceAutoLink = false;
      const link = new URL(location.href);
      const recordLink = link.searchParams.has('cue') || link.searchParams.has('speaker');
      if (requested && !next.some(item => String(item.id) === requested)) {
        try {
          const linkedResponse = await fetch(`/api/live/schedule?meetingId=${encodeURIComponent(requested)}`, {cache:'no-store'});
          if (linkedResponse.ok) {
            const linked = await linkedResponse.json();
            const found = Array.isArray(linked.meetings) && linked.meetings.find(item => String(item.id) === requested);
            if (found && recordLink) { next = [...next, found]; linkedHistorical = true; }
            else if (found) { const equivalent = next.find(item => (item.committee || item.title) === (found.committee || found.title)); requested = equivalent ? String(equivalent.id) : null; replaceAutoLink = true; }
            else { requested = null; replaceAutoLink = true; }
          } else { requested = null; replaceAutoLink = true; }
        } catch (_) { requested = null; replaceAutoLink = true; }
      }
      if (ticket !== scheduleGeneration) return;
      const sameDay = scheduleDate === data.date;
      if (sameDay && linkedHistorical && meeting && new URL(location.href).searchParams.get('live') === meetingId && !next.some(item => String(item.id) === meetingId)) next = [...next, meeting];
      const old = meeting && JSON.stringify(meeting);
      if (!sameDay && !initial) linkedHistorical = false;
      meetings = next;
      const now = Date.now();
      const rank = item => { const start=Date.parse(item.scheduledAt), end=Date.parse(item.endsAt); return Number.isFinite(start) && start > now ? 1 : (Number.isFinite(end) && end < now ? 2 : 0); };
      defaultMeeting = [...meetings].sort((a,b) => rank(a)-rank(b) ||
        (String(b.id) === String(data.defaultMeetingId)) - (String(a.id) === String(data.defaultMeetingId)) ||
        (b.title === '경제환경위원회') - (a.title === '경제환경위원회'))[0] || null;
      scheduleDate = data.date;
      const officialSchedule = typeof data.schedule === 'string' ? data.schedule : '';
      let scheduleUrl; try { scheduleUrl = new URL(officialSchedule); } catch (_) {}
      const validSchedule = scheduleUrl?.protocol === 'https:' && scheduleUrl.hostname === 'cast.sncouncil.go.kr' && scheduleUrl.pathname === '/schedule/live_schedule.jsp';
      el('live-today').hidden = !validSchedule;
      if (validSchedule) el('live-today').href = scheduleUrl.href;
      el('live-session-title').textContent = data.sessionTitle || ''; el('live-schedule-status').textContent = '';
      const select = el('live-meeting-select'); select.replaceChildren();
      for (const item of meetings) { const option = document.createElement('option'); option.value = String(item.id); option.textContent = item.title; select.append(option); }
      select.disabled = !meetings.length;
      const nextCommittee = !sameDay && !initial && meeting ? meetings.find(item => (item.committee || item.title) === (meeting.committee || meeting.title)) : null;
      const desired = (initial && requested) || (sameDay && meetingId) || (nextCommittee && String(nextCommittee.id)) || '';
      const chosen = meetings.find(item => String(item.id) === desired) || defaultMeeting;
      if (!chosen) { const url = new URL(location.href); url.searchParams.delete('live'); url.searchParams.delete('cue'); url.searchParams.delete('speaker'); history.replaceState(null, '', url); clearMeeting('오늘 예정된 회의가 없습니다.'); return; }
      el('live-source').hidden = false;
      if (!meeting || String(chosen.id) !== meetingId || old !== JSON.stringify(chosen)) {
        if (!sameDay && !initial) { const url = new URL(location.href); url.searchParams.delete('live'); url.searchParams.delete('cue'); url.searchParams.delete('speaker'); history.replaceState(null, '', url); }
        selectMeeting(chosen.id, !!(replaceAutoLink || (initial && requested && String(chosen.id) === requested) || (!sameDay && !initial && nextCommittee)));
      }
      else select.value = meetingId;
    } catch (_) {
      if (ticket !== scheduleGeneration) return;
      if (scheduleDate === councilDate.format(new Date())) { el('live-schedule-status').textContent = '일정 갱신에 실패해 마지막으로 확인한 오늘 일정을 표시합니다.'; return; }
      meetings = []; el('live-meeting-select').replaceChildren(); el('live-meeting-select').disabled = true;
      el('live-session-title').textContent = ''; el('live-today').hidden = true; clearMeeting('회의 일정을 불러오지 못했습니다. 잠시 후 다시 확인합니다.');
    } finally {
      scheduleLoading = false; clearTimeout(refreshTimer);
      const now = Date.now(), untilMidnight = 86400000 - ((now + 9 * 3600000) % 86400000);
      refreshTimer = setTimeout(() => refreshSchedule(), Math.min(60000, untilMidnight + 1));
    }
  }
  window.addEventListener?.('online', () => refreshSchedule());
  refreshSchedule(true);
})();
