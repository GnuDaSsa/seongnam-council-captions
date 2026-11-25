(function () {
  'use strict';
  const scriptUrl = new URL(document.currentScript.src);
  const workerUrl = new URL('asr/worker.js', scriptUrl);
  workerUrl.search = scriptUrl.search;
  function hybridAssets(playerMode, mediaTimeline) {
    if (!playerMode || !mediaTimeline || !window.location) return null;
    const page = new URL(window.location.href);
    if (page.searchParams.get('asr') !== 'hybrid') return null;
    if (page.protocol === 'http:' && ['127.0.0.1','localhost'].includes(page.hostname)) return 'local';
    return page.protocol === 'https:' ? 'public' : null;
  }
  let session = null;
  function stop() {
    const s = session;
    if (!s) return;
    session = null;
    s.stopped = true;
    clearTimeout(s.loadTimer);
    s.removeMediaEvents?.();
    s.worker?.terminate();
    s.refiner?.terminate();
    if (s.processor) { s.processor.onaudioprocess = null; s.processor.disconnect(); }
    s.source?.disconnect();
    s.silent?.disconnect();
    if (s.context) s.context.close().catch(() => {});
    if (!s.playerMode) s.stream?.getTracks().forEach(t => t.stop());
    if (s.video && s.video.srcObject === s.stream) { s.video.pause(); s.video.srcObject = null; }
    s.onEnd?.();
  }
  async function start({video, onCue = () => {}, onCorrection = () => {}, onStatus = () => {}, onEnd = () => {}, playerMode = false, mediaTimeline = false}) {
    if (session) stop();
    if (!playerMode && !navigator.mediaDevices?.getDisplayMedia) throw new Error('이 브라우저에서는 화면 공유를 사용할 수 없습니다.');
    const assetMode=hybridAssets(playerMode,mediaTimeline);
    let hybrid=!!assetMode;
    const s = {video, onCue, onStatus, onEnd, playerMode, hybrid, stopped:false, busy:false, ready:false, pending:[]};
    session = s;
    try {
      if (playerMode) {
        if (typeof video.captureStream !== 'function') throw new Error('이 브라우저는 영상 오디오 캡처를 지원하지 않습니다. 탭 공유를 이용해 주세요.');
        s.stream = video.captureStream();
        if (!s.stream.getAudioTracks().length) throw new Error('영상 오디오가 아직 준비되지 않았습니다. 재생을 확인한 후 다시 시작해 주세요.');
      } else {
        // Called before any awaits so the browser can use the user's click activation.
        s.stream = await navigator.mediaDevices.getDisplayMedia({video:true, audio:true});
        if (s.stopped) { s.stream.getTracks().forEach(t => t.stop()); return; }
        if (!s.stream.getAudioTracks().length) throw new Error('공유된 오디오가 없습니다. 브라우저 탭과 탭 오디오 공유를 선택해 주세요.');
        s.stream.getVideoTracks()[0].addEventListener('ended', () => { if (session === s) stop(); });
        video.srcObject = s.stream;
        video.muted = true; // Prevent a captured tab from being fed back into itself.
        video.playsInline = true;
        await video.play();
        if (s.stopped) return;
      }
      s.context = new (window.AudioContext || window.webkitAudioContext)();
      s.source = s.context.createMediaStreamSource(s.stream);
      s.processor = s.context.createScriptProcessor(4096, 1, 1);
      s.silent = s.context.createGain(); s.silent.gain.value = 0;
      s.source.connect(s.processor); s.processor.connect(s.silent); s.silent.connect(s.context.destination);
      await s.context.resume();
      if (s.stopped) return;
      const fastUrl = new URL('asr/hybrid-worker.js', scriptUrl);
      fastUrl.search=scriptUrl.search;
      let blocks = [], length = 0, position = 0, firstFrameWallTime = null;
      let epoch = 0, dispatchedEpoch = 0, mediaStart = null, waiting = false, serial = 0, active = null;
      const refine={ready:false,busy:false,disabled:false,pending:[],active:null};
      if (mediaTimeline) {
        function invalidate() { ++epoch; s.pending = []; refine.pending = []; blocks = []; length = 0; mediaStart = null; }
        // Buffering only interrupts the partial PCM block; completed chunks keep their
        // original clock and may finish. A real seek/source reset still invalidates them.
        function wait() { waiting = true; blocks = []; length = 0; mediaStart = null; }
        function empty() { waiting = true; invalidate(); }
        function resume() { waiting = false; }
        let recovery = null, userUntil = 0;
        s.hlsRecovery = data => {
          if (Date.now() < userUntil || !data || !['bufferSeekOverHole','bufferNudgeOnStall'].includes(data.details)) return;
          recovery = {at:Date.now(), target:video.currentTime};
        };
        function userAction() { recovery = null; userUntil = Date.now()+1000; }
        s.userSeek = () => { userAction(); invalidate(); };
        function seek() {
          const safe = recovery && Date.now()-recovery.at <= 100 && Math.abs(video.currentTime-recovery.target)<0.01;
          recovery = null;
          if (!safe) return invalidate();
          // Never join audio across even an internally repaired discontinuity.
          blocks = []; length = 0; mediaStart = null;
        }
        const events = {seeking:seek,ratechange:invalidate,pause:invalidate,waiting:wait,playing:resume,emptied:empty,pointerdown:userAction,keydown:userAction};
        for (const [name, handler] of Object.entries(events)) video.addEventListener(name,handler);
        s.removeMediaEvents = () => { for (const [name, handler] of Object.entries(events)) video.removeEventListener(name,handler); };
      }
      const rate = s.context.sampleRate, chunkSamples = Math.round(rate * 8);
      function dispatch(chunk) {
        s.busy = true;
        dispatchedEpoch = epoch;
        active = hybrid ? {id:`${epoch}-${++serial}`,epoch,start:chunk.start,end:chunk.end,samples:chunk.samples.slice()} : null;
        s.worker.postMessage({type:'audio', ...chunk}, [chunk.samples.buffer]);
      }
      function dispatchNext() {
        if (s.ready && !s.busy && s.pending.length) dispatch(s.pending.shift());
      }
      function dispatchRefinement() {
        if (!hybrid || refine.disabled || !refine.ready || refine.busy || !refine.pending.length) return;
        const item=refine.pending.shift();
        if (item.epoch !== epoch) return dispatchRefinement();
        refine.busy=true; refine.active=item;
        s.refiner.postMessage({type:'audio',samples:item.samples,start:item.start,end:item.end},[item.samples.buffer]);
      }
      function startRefiner() {
        if (!hybrid || s.refiner || refine.disabled) return;
        try {
          s.refiner=new Worker(workerUrl,{type:'module'});
          s.refiner.onmessage=({data}) => {
            if (s.stopped || refine.disabled) return;
            if (data.type==='ready') { refine.ready=true; dispatchRefinement(); }
            else if (data.type==='result') {
              const item=refine.active; refine.active=null; refine.busy=false;
              if (item && item.epoch===epoch && typeof data.text==='string' && data.text.trim() && !data.rejected) {
                const result={id:item.id,start:item.start,end:item.end,text:data.text.trim(),rawText:data.text.trim(),rejected:false,stage:'refined',observedAt:null};
                if (item.emitted) onCorrection(result); else onCue(result);
              }
              dispatchRefinement();
            } else if (data.type==='error') { refine.disabled=true; refine.pending=[]; s.refiner?.terminate(); onStatus('빠른 자막은 계속 표시하며 추가 재인식은 중지했습니다.'); }
          };
          s.refiner.onerror=()=>{
            if (s.stopped || refine.disabled) return;
            refine.disabled=true; refine.pending=[]; s.refiner?.terminate();
            onStatus('빠른 자막은 계속 표시하며 추가 재인식은 중지했습니다.');
          };
          s.refiner.postMessage({type:'init',mediaTimeline:true});
        } catch (_) { refine.disabled=true; refine.pending=[]; onStatus('빠른 자막은 계속 표시하며 추가 재인식은 중지했습니다.'); }
      }
      function workerFailed(message) {
        if (s.stopped) return;
        if (!hybrid) { onStatus(message); stop(); return; }
        clearTimeout(s.loadTimer);
        s.worker?.terminate();
        s.refiner?.terminate();
        if (active?.epoch===epoch) {
          s.pending.unshift({samples:active.samples,start:active.start,end:active.end});
          if (s.pending.length>4) s.pending.pop();
        }
        active=null;
        refine.disabled=true; refine.pending=[]; refine.active=null;
        hybrid=false; s.hybrid=false; s.ready=false; s.busy=false;
        onStatus('빠른 자막을 불러오지 못해 기본 음성 인식으로 전환합니다.');
        startWorker();
      }
      function workerMessage({data}) {
        if (data.type === 'progress') {
          const p = data.progress;
          if (p.status === 'progress' && Number.isFinite(p.progress)) onStatus(`음성 인식 모델 다운로드 중: ${Math.round(p.progress)}%`);
          else if (p.status === 'initiate') onStatus('음성 인식 모델을 준비하고 있습니다.');
        } else if (data.type === 'ready') {
          clearTimeout(s.loadTimer);
          s.ready = true;
          if (hybrid) startRefiner();
          onStatus(hybrid ? '빠른 자막을 표시하고 추가 재인식을 준비합니다.' : mediaTimeline && data.model === 'Xenova/whisper-tiny'
            ? '경량 음성 모델로 영상 오디오를 듣고 있습니다.'
            : playerMode ? '영상 오디오를 듣고 있습니다.' : '탭 오디오를 듣고 있습니다.');
          dispatchNext();
        } else if (data.type === 'result') {
          s.busy = false;
          const item=active; active=null;
          if (dispatchedEpoch === epoch) {
            const text=typeof data.text==='string' ? data.text.trim() : '';
            if (text) onCue({...(hybrid ? {id:item.id,stage:'draft',displayText:data.displayText?.trim()} : {}),text,rawText:text,rejected:!!data.rejected,start:data.start,end:data.end,observedAt:mediaTimeline || firstFrameWallTime === null ? null : firstFrameWallTime + Number(data.start) * 1000});
            if (hybrid && item && !refine.disabled) {
              item.emitted=!!text;
              if (refine.pending.length>=2) refine.pending.shift();
              refine.pending.push(item); dispatchRefinement();
            }
          }
          dispatchNext();
        } else if (data.type === 'error') {
          workerFailed('음성 인식 오류: ' + data.message);
        }
      }
      function startWorker() {
        try {
          const worker=hybrid ? new Worker(fastUrl) : new Worker(workerUrl,{type:'module'});
          s.worker=worker;
          worker.onmessage=event=>{ if (!s.stopped && s.worker===worker) workerMessage(event); };
          worker.onerror=event=>{
            if (!s.stopped && s.worker===worker) workerFailed('음성 인식 모듈 오류: '+event.message);
          };
          s.loadTimer=setTimeout(()=>{
            if (!s.stopped && s.worker===worker && !s.ready)
              workerFailed('음성 인식 모델을 불러오지 못했습니다. 네트워크와 브라우저 보안 설정을 확인해 주세요.');
          }, hybrid && assetMode==='public' ? 180000 : 120000);
          worker.postMessage({type:'init',mediaTimeline,...(hybrid ? {assetMode} : {})});
        } catch (error) {
          workerFailed('음성 인식 모듈 오류: '+error.message);
        }
      }
      s.processor.onaudioprocess = e => {
        const input = e.inputBuffer.getChannelData(0);
        if (mediaTimeline) {
          if (waiting || video.paused || video.seeking || video.ended || video.readyState < 2) return;
          if (mediaStart === null) mediaStart = Math.max(0, video.currentTime - input.length / rate * video.playbackRate);
        }
        // The callback receives a completed input block; anchor its first sample, then use the sample clock.
        if (firstFrameWallTime === null) firstFrameWallTime = Date.now() - input.length / rate * 1000;
        blocks.push(new Float32Array(input)); length += input.length;
        if (length < chunkSamples) return;
        const joined = new Float32Array(length); let off=0;
        for (const b of blocks) { joined.set(b,off); off += b.length; }
        blocks=[]; length=0;
        const output = new Float32Array(Math.floor(joined.length * 16000 / rate));
        let energy=0;
        for (let i=0; i<output.length; i++) {
          const x=i*rate/16000, j=Math.floor(x), f=x-j;
          output[i]=joined[j]*(1-f)+(joined[Math.min(j+1,joined.length-1)]||0)*f;
          energy += output[i]*output[i];
        }
        const start = mediaTimeline ? mediaStart : position;
        const end = mediaTimeline ? video.currentTime : position + joined.length/rate;
        mediaStart = null; position += joined.length/rate;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
        if (Math.sqrt(energy/output.length) < 0.003) return;
        const chunk={samples:output, start, end};
        if (s.ready && !s.busy) dispatch(chunk);
        else {
          // Retain a short FIFO for VOD: inference is often slower than playback.
          // Live tab capture keeps its low-latency latest-chunk policy.
          const capacity = mediaTimeline ? 4 : 1;
          if (s.pending.length >= capacity) {
            s.pending.shift();
            onStatus('인식 속도가 느려 일부 구간을 건너뜁니다.');
          }
          s.pending.push(chunk);
        }
      };
      onStatus('음성 인식 모델을 내려받고 있습니다. 처음에는 시간이 걸릴 수 있습니다.');
      startWorker();
    } catch (error) {
      if (session === s) stop();
      throw error;
    }
  }
  window.CouncilTabCapture = {start, startPlayer: options => start({...options, playerMode:true}), stop,
    userSeek: video => { if (session?.video === video) session.userSeek?.(); },
    hlsRecovery: (video, data) => { if (session?.video === video) session.hlsRecovery?.(data); }};
})();

