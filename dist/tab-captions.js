(function () {
  'use strict';
  const workerUrl = new URL('asr/worker.js', document.currentScript.src);
  let session = null;
  function stop() {
    const s = session;
    if (!s) return;
    session = null;
    s.stopped = true;
    clearTimeout(s.loadTimer);
    s.removeMediaEvents?.();
    s.worker?.terminate();
    if (s.processor) { s.processor.onaudioprocess = null; s.processor.disconnect(); }
    s.source?.disconnect();
    s.silent?.disconnect();
    if (s.context) s.context.close().catch(() => {});
    if (!s.playerMode) s.stream?.getTracks().forEach(t => t.stop());
    if (s.video && s.video.srcObject === s.stream) { s.video.pause(); s.video.srcObject = null; }
    s.onEnd?.();
  }
  async function start({video, onCue = () => {}, onStatus = () => {}, onEnd = () => {}, playerMode = false, mediaTimeline = false}) {
    if (session) stop();
    if (!playerMode && !navigator.mediaDevices?.getDisplayMedia) throw new Error('이 브라우저에서는 화면 공유를 사용할 수 없습니다.');
    const s = {video, onCue, onStatus, onEnd, playerMode, stopped:false, busy:false, ready:false, pending:null};
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
      s.worker = new Worker(workerUrl, {type:'module'});
      s.loadTimer = setTimeout(() => {
        if (session === s && !s.ready) {
          onStatus('음성 인식 모델을 불러오지 못했습니다. 네트워크와 브라우저 보안 설정을 확인해 주세요.');
          stop();
        }
      }, 120000);
      let blocks = [], length = 0, position = 0, firstFrameWallTime = null;
      let epoch = 0, dispatchedEpoch = 0, mediaStart = null, waiting = false;
      if (mediaTimeline) {
        function invalidate() { ++epoch; s.pending = null; blocks = []; length = 0; mediaStart = null; }
        function wait() { waiting = true; invalidate(); }
        function resume() { waiting = false; }
        const events = {seeking:invalidate,ratechange:invalidate,pause:invalidate,waiting:wait,playing:resume,emptied:wait};
        for (const [name, handler] of Object.entries(events)) video.addEventListener(name,handler);
        s.removeMediaEvents = () => { for (const [name, handler] of Object.entries(events)) video.removeEventListener(name,handler); };
      }
      const rate = s.context.sampleRate, chunkSamples = Math.round(rate * 8);
      function dispatch(chunk) {
        s.busy = true;
        dispatchedEpoch = epoch;
        s.worker.postMessage({type:'audio', ...chunk}, [chunk.samples.buffer]);
      }
      s.worker.onmessage = ({data}) => {
        if (s.stopped) return;
        if (data.type === 'progress') {
          const p = data.progress;
          if (p.status === 'progress' && Number.isFinite(p.progress)) onStatus(`음성 인식 모델 다운로드 중: ${Math.round(p.progress)}%`);
          else if (p.status === 'initiate') onStatus('음성 인식 모델을 준비하고 있습니다.');
        } else if (data.type === 'ready') {
          clearTimeout(s.loadTimer);
          s.ready = true; onStatus(playerMode ? '영상 오디오를 듣고 있습니다.' : '탭 오디오를 듣고 있습니다.');
          if (s.pending) { const next=s.pending; s.pending=null; dispatch(next); }
        } else if (data.type === 'result') {
          s.busy = false;
          if (dispatchedEpoch === epoch && data.text.trim()) onCue({text:data.text.trim(), rawText:data.text.trim(), rejected:!!data.rejected, start:data.start, end:data.end, observedAt:mediaTimeline || firstFrameWallTime === null ? null : firstFrameWallTime + Number(data.start) * 1000});
          if (s.pending) { const next=s.pending; s.pending=null; dispatch(next); }
        } else if (data.type === 'error') {
          onStatus('음성 인식 오류: ' + data.message); stop();
        }
      };
      s.worker.onerror = e => { onStatus('음성 인식 모듈 오류: ' + e.message); stop(); };
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
        else { if (s.pending) onStatus('인식 속도가 느려 일부 구간을 건너뜁니다.'); s.pending=chunk; }
      };
      onStatus('음성 인식 모델을 내려받고 있습니다. 처음에는 시간이 걸릴 수 있습니다.');
      s.worker.postMessage({type:'init'});
    } catch (error) {
      if (session === s) stop();
      throw error;
    }
  }
  window.CouncilTabCapture = {start, startPlayer: options => start({...options, playerMode:true}), stop};
})();

