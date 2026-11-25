(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const source = 'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=2853';
  const playlist = 'https://cast.sncouncil.go.kr:4443/live/ch2.sdp/playlist.m3u8';
  const endOfBroadcast = Date.parse('2026-11-25T23:59:59+09:00');
  const video = el('live-video');
  const frame = el('live-video-placeholder');
  const captions = el('live-captions');
  const timeFormat = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const records = [];
  let hls, retry, mode = '', started = 0, lastOffset = 0, generation = 0;
  el('live-source').href = source;
  function report(text) { el('caption-status').textContent = text; }
  function stopPlayer() { clearTimeout(retry); hls?.destroy(); hls = null; }
  function openBroadcast() {
    stopPlayer();
    if (Date.now() > endOfBroadcast) {
      el('live-status').textContent = '방송 일정 종료';
      frame.hidden = false;
      frame.querySelector('p').textContent = '지난 회의는 회의 기록에서 확인하세요.';
      return;
    }
    if (mode === 'tab') return;
    el('live-status').textContent = '영상 연결 중';
    video.crossOrigin = 'anonymous';
    if (window.Hls?.isSupported()) {
      hls = new Hls({lowLatencyMode:false,liveSyncDurationCount:2});
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        stopPlayer(); el('live-status').textContent = '영상 재연결 중';
        retry = setTimeout(openBroadcast, 7000);
      });
      hls.loadSource(playlist); hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playlist;
    } else {
      el('live-status').textContent = '공식 페이지에서 시청';
      frame.querySelector('p').textContent = '아래 공식 중계 보기에서 재생하세요.';
      return;
    }
    video.play().catch(() => { el('live-note').textContent = '플레이어의 재생 버튼을 눌러 주세요.'; });
  }
  video.addEventListener('playing', () => {
    frame.hidden = true; el('live-status').textContent = mode === 'tab' ? '공유 탭 재생 중' : '생중계';
    el('live-note').textContent = video.muted ? '소리를 들으려면 플레이어의 음소거를 해제하세요.' : '';
  });
  video.addEventListener('loadeddata', () => { frame.hidden = true; });
  function controls(busy) {
    el('player-captions').hidden = busy;
    el('capture-start').hidden = busy;
    el('capture-stop').hidden = !busy;
  }
  function appendCue(cue, offset) {
    const text = String(cue.text || '').trim();
    if (!text) return;
    const start = offset + Number(cue.start), end = offset + Number(cue.end);
    const at = started + Number(cue.start)*1000;
    records.push({id:String(records.length+1),start,end,speaker:'',text,status:'AI 전사 · 미검토'});
    lastOffset = end;
    const follow = captions.scrollHeight-captions.scrollTop-captions.clientHeight < 80;
    const line = document.createElement('p'), stamp = document.createElement('time'), body = document.createElement('span');
    stamp.textContent = timeFormat.format(at); body.textContent = text;
    line.append(stamp,body); captions.append(line);
    if (follow) captions.scrollTop = captions.scrollHeight;
    el('live-save').disabled = false;
  }
  async function start(which) {
    if (mode) return;
    if (which === 'player' && (!video.readyState || Date.now() > endOfBroadcast)) { report('영상을 재생한 뒤 자막을 켜 주세요.'); return; }
    const session = ++generation;
    mode = which; controls(true); started = Date.now();
    const offset = lastOffset;
    if (which === 'tab') stopPlayer();
    else { video.muted = false; video.play().catch(() => {}); }
    try {
      const recognizer = window.CouncilTabCapture;
      const handler = which === 'tab' ? recognizer.start : recognizer.startPlayer;
      await handler({video, onCue: cue => { if (session === generation) appendCue(cue,offset); },
        onStatus: text => { if (session === generation) report(text); },
        onEnd: () => {
          if (session !== generation) return;
          mode=''; controls(false);
          if (which === 'tab') openBroadcast();
        }});
    } catch (error) {
      mode=''; controls(false);
      report(error.message || '브라우저에서 음성을 읽지 못했습니다. 다른 탭 자막을 이용할 수 있습니다.');
      if (which === 'tab') openBroadcast();
    }
  }
  el('player-captions').onclick = () => start('player');
  el('capture-start').onclick = () => start('tab');
  el('capture-stop').onclick = () => { window.CouncilTabCapture.stop(); report('자막을 중지했습니다.'); };
  el('live-save').onclick = () => {
    if (!records.length) return;
    const blob=CouncilExports.minutesHwpx({title:'경제환경위원회 행정사무감사 제1일차',date:'2026-11-25',body:'성남시의회 경제환경위원회',sourceUrl:source,coverage:'이 브라우저에서 들은 구간의 자동 자막. 시간은 자막 수집 기준.',segments:records});
    const url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url; a.download='경제환경위원회_행정사무감사_자막초안.hwpx'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),3000);
  };
  video.muted=true;
  report('자막을 켜면 이 기기에서 방송 음성을 받아씁니다.');
  openBroadcast();
})();
