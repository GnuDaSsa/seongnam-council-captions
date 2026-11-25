(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const video = el('vod-video');
  let meetings = [], meeting = null, hls = null, loaded = false, resolveGeneration = 0;
  let initialSeekCleanup = null;
  let capture = false, generation = 0, generated = [], catalogCues = [], track = 'existing', canGenerate = false;
  let renderedCues = null, cueButtons = [], activeButton = null, recentCue = null, captureError = '';
  let speechContext = [];
  let reference = null, referenceRequest = null, referenceState = 'idle';
  let attributionMeeting = null, capturedReference = null, capturedRequest = null;
  const captureContexts = new WeakMap(), followingCue = new WeakMap();
  const reportTools=window.CouncilPersonalCaptionReport;
  const reportMode=reportTools?.modeFor?.(location.origin);
  const reportDrafts=new WeakMap();
  let selectedReport=null;
  const pageUrl=new URL(location.href);
  const loopback=pageUrl.protocol==='http:' && ['127.0.0.1','localhost'].includes(pageUrl.hostname);
  const hybrid=pageUrl.searchParams.get('asr')==='hybrid';

  function updateAsrOptions() {
    const options=el('vod-asr-options'), toggle=el('vod-asr-toggle'), label=el('vod-asr-current');
    if (!options || !toggle || !label) return;
    const id=String(meeting?.id || '');
    options.hidden=!(canGenerate && /^[1-9][0-9]{0,7}$/.test(id) && (loopback || pageUrl.protocol==='https:'));
    if (options.hidden) return;
    const next=new URL(pageUrl);
    next.searchParams.set('view','vod');
    next.searchParams.set('vod',id);
    next.searchParams.set('track','personal');
    const pending=initialSeekCleanup && pageUrl.searchParams.get('vod')===id ? Number(pageUrl.searchParams.get('t')) : null;
    const position=pending ?? Number(video.currentTime);
    if (Number.isFinite(position) && position>=0) next.searchParams.set('t',String(Math.round(position*1000)/1000));
    else next.searchParams.delete('t');
    if (!hybrid) next.searchParams.set('asr','hybrid');
    else if (loopback) next.searchParams.set('asr','whisper');
    else next.searchParams.delete('asr');
    const current=hybrid ? '빠른 자막 선택됨' : '기본 인식 선택됨';
    const action=hybrid ? '기본 인식으로 돌아가기' : '빠른 자막 사용';
    if (label.textContent!==current) label.textContent=current;
    if (toggle.textContent!==action) toggle.textContent=action;
    if (toggle.href!==next.href) toggle.href=next.href;
  }

  function stamp(value) {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60]
      .map(part => String(part).padStart(2, '0')).join(':');
  }
  function cueList() { return track === 'existing' ? catalogCues : generated; }
  function updateTrackSummary() {
    const personal = track === 'personal';
    const sourceStatus = {loading:'발언자 대조 자료를 불러오는 중입니다.', ready:'이 회의의 공식 발언록과 인식한 문장을 대조합니다.',
      empty:'공식 발언록이 아직 없습니다.', error:'공식 발언록을 불러오지 못했습니다.'};
    const sharedStatus = capturedReference ? ' 당시 생중계 자막과도 대조합니다.' : meeting?.liveMeetingId ? ' 당시 회의 명부와 자기소개를 대조합니다.' : '';
    el('vod-track-summary').textContent = personal
      ? '현재 재생 위치의 음성을 받아씁니다. ' + (sourceStatus[referenceState] || '') + sharedStatus
      : '영상에 미리 준비한 자막입니다. 각 발언에 회의록 대조 여부를 표시합니다.';
  }
  function updateTrackUI(message) {
    updateTrackSummary();
    updateAsrOptions();
    const personal = track === 'personal';
    el('vod-mode-existing').checked = !personal;
    el('vod-mode-personal').checked = personal;
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
  function referenceDecision(cue, context) {
    const aligned = window.CouncilVodSpeaker?.assess(meeting,cue);
    if (aligned) return aligned;
    const official=reference && window.CouncilVodTranscript?.assess(meeting,cue,reference,context);
    return official || window.CouncilVodTranscript?.assessCaptured?.(meeting,cue,capturedReference);
  }
  function withReferenceRoster(selected, data) {
    const candidateOnly=!!selected.memberRoster?.candidateOnly;
    const members = new Set(candidateOnly ? [] : (selected.members || []));
    const currentStaff = candidateOnly ? [] : (selected.staffRoster || []).filter(row => !row.candidateOnly);
    const staff = new Map(currentStaff.map(row => [row.name + '|' + row.role, row]));
    for (const {name,role} of data.turns) {
      if (!/^[가-힣]{2,4}$/.test(name) || typeof role !== 'string' || !role.trim()) continue;
      if (/^(?:의원|위원|(?:부)?의장|(?:부)?위원장|위원장대리|의장직무대리)$/.test(role)) members.add(name);
      else if (!staff.has(name + '|' + role)) staff.set(name + '|' + role,{name,role,source:data.sourceUrl});
    }
    return {...selected, members:[...members], staffRoster:[...staff.values()]};
  }
  function reconcileHybrid(item,context) {
    if (!item.hybridDraft || !item.hybridRefinement) return;
    const draft={...item,...item.hybridDraft,stage:'draft',speakerConflict:false};
    const refined={...item,...item.hybridRefinement,stage:'refined',speakerConflict:false};
    const draftContext=context.map(row=>row===item ? draft : row);
    const refinedContext=context.map(row=>row===item ? refined : row);
    const beforeDecision=referenceDecision(draft,draftContext), afterDecision=referenceDecision(refined,refinedContext);
    const before=inferFromContext(draft,draftContext,beforeDecision || null), after=inferFromContext(refined,refinedContext,afterDecision || null);
    const afterConflict=!!afterDecision?.blocked || !!(before?.name && after?.name && before.name!==after.name);
    const beforeConflict=!!beforeDecision?.blocked && (afterConflict || beforeDecision.reason!=='ambiguous-speaker' ||
      window.CouncilVodTranscript?.resolvePredicateAmbiguity?.(
        meeting,draft,refined,reference,refinedContext,afterDecision?.speaker)!==true);
    const conflict=beforeConflict || afterConflict;
    if (conflict) Object.assign(item,item.hybridRefinement,{stage:'refined',speaker:undefined,speakerConflict:true});
    else if (before?.name && !after?.name) Object.assign(item,item.hybridDraft,{stage:'draft_retained',speaker:before,speakerConflict:false});
    else Object.assign(item,item.hybridRefinement,{stage:'refined',speaker:after,speakerConflict:false});
  }
  function liveContext(context, cue) {
    const lastBreak=context.findLastIndex(row=>row!==cue && (!generated.includes(row) || row.speakerConflict));
    return context.slice(lastBreak+1);
  }
  function attachedPredicate(cue) {
    const accepts=window.CouncilVodTranscript?.attachedPredicate;
    return !!(cue && accepts && (accepts(cue) ||
      (cue.hybridRefinement && accepts({...cue,...cue.hybridRefinement}))));
  }
  function speakerContextFor(cue) {
    const context=liveContext(captureContexts.get(cue) || [cue],cue);
    const prior=context.at(-2);
    if (!attachedPredicate(cue) || !prior) return context;
    // A retained draft can still be shown, but an unsupported refinement does not back the next cue.
    if (prior.stage==='draft_retained') return [cue];
    // Consecutive hybrid audio blocks do not share samples, but their independent video clock
    // reads can report a small overlap. Correct only the private attribution interval.
    const clockOverlap=prior.end-cue.start;
    if (!(clockOverlap>0 && clockOverlap<=0.01)) return context;
    const localChunk=/^(local-\d+-\d+)-(\d+)$/;
    const left=localChunk.exec(prior.id), right=localChunk.exec(cue.id);
    if (left && right && left[1]===right[1] && Number(left[2])+1===Number(right[2])) {
      return context.with(-2,{...prior,end:cue.start});
    }
    return context;
  }
  function refreshCueSpeaker(cue) {
    cue.laterSpeaker=undefined;
    const context=speakerContextFor(cue);
    if (cue.hybridRefinement) reconcileHybrid(cue,context);
    else cue.speaker=inferFromContext(cue,context);
  }
  function updatePreviousSpeaker(cue) {
    const prior=cue && captureContexts.get(cue)?.at(-2);
    if (!prior || followingCue.get(prior)!==cue || !generated.includes(prior)) return;
    prior.laterSpeaker=undefined;
    if (!reference || prior.speaker || prior.speakerConflict || cue.speakerConflict || !cue.speaker?.officialReference ||
        !generated.includes(cue) || referenceDecision(prior,speakerContextFor(prior))?.blocked) return;
    prior.laterSpeaker=window.CouncilVodTranscript?.previousSpeaker?.(meeting,prior,cue,reference);
  }
  function refreshGenerated() {
    for (const cue of generated) refreshCueSpeaker(cue);
    for (const cue of generated) updatePreviousSpeaker(cue);
    renderedCues=null;
  }
  async function loadCapturedReference() {
    if (!meeting?.liveMeetingId || capturedRequest || capturedReference || !window.CouncilVodTranscript?.prepareCaptured) return;
    const selected=meeting, controller=new AbortController();
    capturedRequest=controller;
    const timeout=setTimeout(()=>controller.abort(),16000);
    try {
      const response=await fetch('/api/live/minutes?meetingId='+encodeURIComponent(selected.liveMeetingId),{signal:controller.signal});
      if (!response.ok) return;
      const archive=await response.json();
      if (capturedRequest!==controller || meeting!==selected) return;
      capturedReference=window.CouncilVodTranscript.prepareCaptured(selected,archive,window.CouncilLiveSpeaker);
      if (capturedReference) { refreshGenerated(); updateTrackSummary(); render(); }
    } catch (_) { /* Video playback and local captioning remain available. */ }
    finally { clearTimeout(timeout); if (capturedRequest===controller) capturedRequest=null; }
  }
  async function loadReference() {
    void loadCapturedReference();
    if (!meeting || referenceRequest || ['ready','empty'].includes(referenceState)) return;
    const selected = meeting, controller = new AbortController();
    referenceRequest = controller; referenceState = 'loading'; updateTrackSummary();
    const timeout = setTimeout(() => controller.abort(), 22000);
    const query = encodeURIComponent(selected.id);
    try {
      const urls = selected.speakerTranscript ? ['/data/vod-transcripts/' + query + '.json', '/api/vod/transcript?id=' + query] : ['/api/vod/transcript?id=' + query];
      let data;
      for (const url of urls) {
        const response = await fetch(url, {signal:controller.signal});
        if (response.ok) { data = await response.json(); break; }
      }
      if (!data || String(data.meetingId) !== String(selected.id) || !Array.isArray(data.turns)) throw Error('Invalid meeting transcript');
      if (referenceRequest !== controller) return;
      if (!data.turns.length) { referenceState = 'empty'; return; }
      if (!window.CouncilVodTranscript?.validatesSource(selected,data)) throw Error('Unlinked meeting transcript');
      reference = data;
      referenceState = 'ready';
      attributionMeeting = withReferenceRoster(selected,data);
      // An official record can arrive after recognition has already emitted a cue.
      refreshGenerated();
    } catch (_) {
      if (referenceRequest === controller) referenceState = 'error';
    } finally {
      clearTimeout(timeout);
      if (referenceRequest === controller) {
        referenceRequest = null;
        updateTrackSummary(); render();
      }
    }
  }
  function inferPersonalSpeaker(cue) {
    speechContext = liveContext([...speechContext.slice(-7),cue],cue);
    captureContexts.set(cue,speechContext);
    const context=speakerContextFor(cue);
    const decision=referenceDecision(cue,context);
    if (decision?.blocked) { speechContext=[]; return; }
    return inferFromContext(cue,context,decision || null);
  }
  function inferFromContext(cue,context,decision=referenceDecision(cue,context)) {
    if (!meeting || cue.rejected || decision?.blocked) return;
    if (decision?.speaker) return decision.speaker;
    if (!window.CouncilLiveSpeaker?.attribute) return;
    try {
      const identity = attributionMeeting || meeting;
      const candidate = window.CouncilLiveSpeaker.attribute(identity,context,[],[])[cue.id];
      if (!candidate) return;
      if (identity.members?.length || identity.staffRoster?.length || candidate.registeredVodReference) return candidate;
      // Unknown archives can still show a role without implying a roster match.
      const role = String(candidate.role || '').trim().match(/(센터장|위원장|의사진행자|질의자|답변자|담당관|주무관|과장|국장|팀장|부장|소장|의원|위원)$/)?.[1] || '';
      if (role) return {...candidate,name:'',role};
    } catch (_) { return undefined; }
  }
  function sourceLabel(cue) {
    if (cue.source === 'minutes_aligned') return '공식 회의록 대조';
    if (cue.source === 'asr') return '사전 자동 전사 · 미검토';
    const prefix=cue.stage==='draft' ? '빠른 초안' : cue.stage==='refined' ? '재인식' : cue.stage==='draft_retained' ? '빠른 초안 · 보강 보류' : '개인 자막';
    if (cue.source === 'local' && !cue.speaker && cue.laterSpeaker) return prefix + ' · 다음 자막 수신 후 공식 회의록 대조';
    if (cue.source === 'local' && cue.speaker?.officialReference) return prefix + ' · 공식 회의록 대조 추정';
    if (cue.source === 'local' && cue.speaker?.liveReference) return prefix + ' · 당시 생중계 자막 대조 추정';
    if (cue.source === 'local') return cue.stage ? prefix + ' · 미검토' : '지금 음성 인식 · 미검토';
    return '제공 자막';
  }
  function safeText(cue) {
    const text = String(cue.text || '');
    if (cue.source === 'minutes_aligned') return text;
    if (cue.rejected || window.CouncilQuality?.repeated(text)) return '[음성 재확인 필요]';
    const isDraft = cue.stage === 'draft' || cue.stage === 'draft_retained';
    const display = (isDraft && cue.draftDisplayText) || text;
    return window.CouncilKoreanCorrections?.correct(display).text || display;
  }
  function speaker(cue) {
    if (typeof cue.speaker === 'string' && cue.speaker.trim()) {
      return cue.speaker.trim() + (cue.source === 'minutes_aligned' ? ' · 기록 확인' : ' · 추정');
    }
    const label=cue.speaker || cue.laterSpeaker;
    if (label && (label.name || label.role)) {
      const who = [label.name,label.role].filter(Boolean).join(' ');
      return who + (cue.source === 'minutes_aligned' && !label.confidence ? ' · 기록 확인' : ' · 추정');
    }
    return '발언자 미확인';
  }
  function part(tag, className, text) {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  }
  function updateReportControl() {
    if (!reportMode) return;
    const panel=el('vod-report'), action=el('vod-report-open');
    if (!panel || !action) return;
    panel.hidden=track!=='personal' || (!generated.length && !selectedReport);
    const href=selectedReport?.url || '', disabled=String(!href);
    const cancel=el('vod-report-cancel'), issues=el('vod-report-issues');
    if (cancel) cancel.hidden=!selectedReport;
    if (issues) { issues.hidden=reportMode!=='github'; issues.href=reportTools.issuesUrl; }
    const actionText=reportMode==='github' ? 'GitHub에서 이슈 작성 ↗' : '선택한 자막 신고 ↗';
    if (action.textContent!==actionText) action.textContent=actionText;
    if ((action.getAttribute('href')||'')!==href) {
      if (href) action.href=href;
      else action.removeAttribute('href');
    }
    if (action.getAttribute('aria-disabled')!==disabled) action.setAttribute('aria-disabled',disabled);
    const status=el('vod-report-status'), message=selectedReport?.status || '신고할 자막 줄을 선택하세요.';
    if (status.textContent!==message) status.textContent=message;
  }
  function chooseReportCue(cue) {
    const meetingId=String(meeting?.id||'');
    if (parseVodId(meeting?.officialPage||'')!==meetingId || !meetingId) return;
    video.pause();
    const quote=safeText(cue), input={meetingId,meetingTitle:meeting.title,cueId:String(cue.id),
      start:cue.start,end:cue.end,speaker:speaker(cue),quote,rawQuote:String(cue.rawText||cue.text||'')};
    const signature=JSON.stringify(input), existing=reportDrafts.get(cue);
    const url=existing?.signature===signature ? existing.url : reportMode==='github' ? reportTools.issueUrl(input) :
      reportTools.reportUrl(input,{id:crypto.randomUUID(),kind:'자막 내용 오류',note:''});
    if (url) reportDrafts.set(cue,{signature,url});
    const message=reportMode==='github' ? ' 자막을 선택했습니다. GitHub 로그인 후 내용을 확인하고 제출하세요.' :
      ' 자막을 선택했습니다. 연결 화면이 열리지 않으면 GitHub_이슈_연결.cmd를 실행하세요.';
    const draft={id:cue.id,url,status:url ? stamp(cue.start)+message :
      '이 자막의 신고 정보를 준비할 수 없습니다.'};
    selectedReport=draft; renderedCues=null;
    if (url && reportMode==='local') void reportTools.bridgeReady().then(available=>{
      if (selectedReport!==draft) return;
      draft.status=stamp(cue.start)+(available ? ' 자막을 선택했습니다.' :
        ' 자막을 선택했습니다. 먼저 GitHub_이슈_연결.cmd를 실행한 뒤 신고 양식을 열어 주세요.');
      updateReportControl();
    });
  }
  el('vod-report-cancel')?.addEventListener('click',()=>{
    selectedReport=null;
    renderedCues=null;
    render();
  });
  function render() {
    const cues = cueList(), now = video.currentTime || 0, box = el('vod-captions');
    if (renderedCues !== cues) {
      const savedScroll=box.scrollTop, focused=box.contains(document.activeElement) ? document.activeElement : null;
      const focusedId=focused?.dataset?.cueId, focusedReference=focused?.dataset?.cueAction==='reference';
      let referenceToFocus=null;
      renderedCues = cues; cueButtons = []; activeButton = null; box.replaceChildren();
      for (const cue of cues) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'vod-cue'; button.dataset.cueId=String(cue.id);
        button.append(part('span','vod-cue-time',stamp(cue.start)), part('strong','vod-cue-speaker',speaker(cue)),
          part('span','vod-cue-text',safeText(cue)), part('small','vod-cue-source',sourceLabel(cue)));
        if (reportMode && track==='personal') button.setAttribute('aria-pressed',String(selectedReport?.id===cue.id));
        button.onclick = () => {
          if (reportMode && track==='personal' && cue.source==='local') chooseReportCue(cue);
          window.CouncilTabCapture?.userSeek?.(video); video.currentTime = Number(cue.start);
          updateAsrOptions();
          if (reportMode && track==='personal') render();
        };
        const href=window.CouncilLiveSpeaker?.registeredVodHref?.(cue.speaker?.registeredVodReference);
        if (href) {
          const row=part('div','vod-cue-row',''), link=part('a','registered-vod-reference','발언자 근거 영상');
          link.href=href; link.target='_blank'; link.rel='noopener noreferrer';
          link.dataset.cueId=button.dataset.cueId; link.dataset.cueAction='reference';
          row.append(button,link); box.append(row);
          if (focusedReference && link.dataset.cueId===focusedId) referenceToFocus=link;
        } else box.append(button);
        cueButtons.push(button);
      }
      box.scrollTop=savedScroll;
      if (focusedId) (referenceToFocus || cueButtons.find(button=>button.dataset.cueId===focusedId))?.focus({preventScroll:true});
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
    updateReportControl();
    const output = el('vod-caption-now');
    const fresh = track === 'personal' && capture && !video.paused && !video.seeking && recentCue &&
      Date.now() - recentCue.receivedAt <= 15000 && now >= recentCue.cue.start && now - recentCue.cue.end <= 60;
    const recent = fresh && current !== recentCue.cue ? recentCue.cue : null;
    const signature = JSON.stringify([current?.id, current && speaker(current), current && sourceLabel(current), current && safeText(current), recent?.id, recent && speaker(recent), recent && sourceLabel(recent), recent && safeText(recent), track, cues.length]);
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
  function selectMeeting(id, initialLink = false) {
    initialSeekCleanup?.(); initialSeekCleanup=null;
    referenceRequest?.abort(); referenceRequest = null; reference = null; referenceState = 'idle'; attributionMeeting = null;
    capturedRequest?.abort(); capturedRequest=null; capturedReference=null;
    ++resolveGeneration; stopPlayer(); meeting = meetings.find(item => String(item.id) === String(id)) || null;
    generated = []; catalogCues = []; track = initialLink && pageUrl.searchParams.get('track')==='personal' ? 'personal' : 'existing';
    canGenerate = false; recentCue = null; selectedReport=null;
    const placeholder = el('vod-placeholder'); placeholder.hidden = false;
    el('vod-video-status').textContent = '';
    el('vod-stop').hidden = true; el('vod-generate').hidden = true;
    if (!meeting) { placeholder.querySelector('p').textContent = '회의를 선택해 주세요.'; updateAsrOptions(); render(); return; }
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
    if (initialLink) {
      const q=new URL(location.href).searchParams, ids=q.getAll('vod'), values=q.getAll('t');
      if (ids.length===1 && ids[0]===String(meeting.id) && values.length===1 && /^(?:\d+)(?:\.\d+)?$/.test(values[0])) {
        const target=Number(values[0]), selected=meeting, token=resolveGeneration;
        if (Number.isFinite(target)) {
          const apply=()=>{
            if (meeting!==selected || resolveGeneration!==token || !Number.isFinite(video.duration)) return;
            initialSeekCleanup?.(); initialSeekCleanup=null;
            if (target>=0 && target<=video.duration) video.currentTime=target;
          };
          const cancel=()=>{initialSeekCleanup?.(); initialSeekCleanup=null;};
          video.addEventListener('loadedmetadata',apply);
          video.addEventListener('seeking',cancel);
          initialSeekCleanup=()=>{video.removeEventListener('loadedmetadata',apply);video.removeEventListener('seeking',cancel);};
        }
      }
    }
    updateAsrOptions();
    if (track==='personal') void loadReference();
    video.crossOrigin = 'anonymous';
    if (window.Hls?.isSupported()) {
      const current = meeting;
      hls = new window.Hls();
      hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (meeting === current && !data.fatal) window.CouncilTabCapture?.hlsRecovery?.(video, data);
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
    void loadReference();
    updateTrackUI('개인 음성 인식을 준비하고 있습니다.');
    try {
      await window.CouncilTabCapture.startPlayer({video, mediaTimeline:true,
        onCue: cue => {
          if (!capture || token !== generation) return;
          const start = Number(cue.start), end = Number(cue.end);
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 30 || !String(cue.text || '').trim()) return;
          const item = {id:`local-${token}-${cue.id || cue.start}`, meetingId:String(meeting.id), start, end, text:cue.text, rawText:cue.rawText || cue.text, rejected:cue.rejected, flags:cue.flags, source:'local', ...(cue.stage ? {stage:cue.stage} : {})};
          if (cue.stage==='draft') {
            item.hybridDraft={text:item.text,rawText:item.rawText,rejected:!!item.rejected};
            item.draftDisplayText=cue.displayText;
          }
          const changedFollowers=new Set();
          generated = generated.filter(old => {
            if (Math.abs(old.start-item.start)>0.5 || Math.abs(old.end-item.end)>0.5) return true;
            const prior=captureContexts.get(old)?.at(-2);
            if (prior && followingCue.get(prior)===old) {
              prior.laterSpeaker=undefined;
              followingCue.delete(prior);
            }
            const following=followingCue.get(old);
            if (attachedPredicate(following)) changedFollowers.add(following);
            followingCue.delete(old);
            return false;
          });
          item.speaker = inferPersonalSpeaker(item);
          generated.push(item); generated.sort((a,b) => a.start - b.start);
          const prior=captureContexts.get(item)?.at(-2);
          if (prior) followingCue.set(prior,item);
          updatePreviousSpeaker(item);
          for (const following of changedFollowers) if (generated.includes(following)) {
            refreshCueSpeaker(following);
            updatePreviousSpeaker(following);
          }
          if (changedFollowers.size) renderedCues=null;
          recentCue = {cue:item, receivedAt:Date.now()}; render();
        },
        onCorrection: cue => {
          if (!capture || token !== generation || !cue?.id || cue.rejected || !String(cue.text || '').trim()) return;
          const item=generated.find(row=>row.id===`local-${token}-${cue.id}`);
          if (!item || item.start!==Number(cue.start) || item.end!==Number(cue.end)) return;
          item.hybridRefinement={text:cue.text,rawText:cue.rawText || cue.text,rejected:false};
          refreshCueSpeaker(item);
          updatePreviousSpeaker(item);
          const following=followingCue.get(item);
          if (attachedPredicate(following) && generated.includes(following)) refreshCueSpeaker(following);
          updatePreviousSpeaker(following);
          renderedCues=null;
          if (recentCue?.cue===item) recentCue.receivedAt=Date.now();
          render();
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
  async function resolveMeeting(event, initialLink = false) {
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
    el('vod-meeting-select').value = id; selectMeeting(id,initialLink);
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
      select.value = String(chosen.id); selectMeeting(chosen.id,requested === String(chosen.id));
      if (requested && requested !== String(chosen.id) && parseVodId(requested) && !el('vod-panel').hidden) {
        el('vod-resolve-input').value = requested;
        await resolveMeeting(null,true);
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
      track = value; recentCue = null; selectedReport=null;
      if (value === 'personal') void loadReference();
      updateTrackUI(); render();
    });
  }
  el('vod-generate').addEventListener('click', generate);
  el('vod-stop').addEventListener('click', () => stopCapture('자막 생성을 중지했습니다.'));
  el('vod-asr-toggle')?.addEventListener('click', updateAsrOptions);
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
    updateAsrOptions();
    render();
  });
  video.addEventListener('timeupdate', () => { updateAsrOptions(); render(); });
  video.addEventListener('loadeddata', () => { el('vod-placeholder').hidden = true; });
  video.addEventListener('error', () => { canGenerate = false; stopCapture('영상 오류로 자막 생성을 중지했습니다.'); updateTrackUI('영상 오류로 자막 생성을 중지했습니다.'); el('vod-video-status').textContent = '영상을 재생할 수 없습니다. 공식 영상 보기에서 확인해 주세요.'; });
  document.addEventListener('council:tabchange', event => {
    if (event.detail?.tab === 'tab-vod') loadCatalog();
    else { ++resolveGeneration; stopCapture('다시보기 탭을 벗어나 자막 생성을 중지했습니다.'); video.pause(); }
  });
})();
