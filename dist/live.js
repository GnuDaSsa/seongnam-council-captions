(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const video = el('live-video');
  const placeholder = el('live-video-placeholder');
  const captions = el('live-captions');
  const liveUrl = '/api/live/playlist.m3u8';
  el('live-source').href = 'https://cast.sncouncil.go.kr/live/live_list.jsp#room4_btn';
  const time = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false});
  let hls, attached = false, local = false, updating = false, latest = '', retryAt = 0;
  function videoStatus(message) { el('live-status').textContent = message; }
  function row(text, at) {
    const line = document.createElement('p');
    const stamp = document.createElement('time');
    stamp.textContent = time.format(new Date(at));
    const body = document.createElement('span');
    body.textContent = text;
    line.append(stamp, body);
    return line;
  }
  function detach() {
    hls?.destroy(); hls = null; attached = false;
    video.removeAttribute('src'); video.load();
  }
  function failed() {
    if (local) return;
    detach(); retryAt = Date.now() + 5000;
    placeholder.hidden = false;
    videoStatus('중계 재연결 중');
    placeholder.querySelector('p').textContent = '경제환경위원회 영상 신호를 기다리고 있습니다.';
  }
  async function attach() {
    if (attached || local || Date.now() < retryAt) return;
    const response = await fetch(liveUrl, {cache:'no-store'});
    if (!response.ok || !(await response.text()).startsWith('#EXTM3U')) {
      videoStatus('영상 신호 대기'); return;
    }
    if (attached || local) return;
    if (window.Hls?.isSupported()) {
      attached = true;
      hls = new Hls({lowLatencyMode:false, liveSyncDurationCount:2, maxLiveSyncPlaybackRate:1.08});
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) failed(); });
      hls.loadSource(liveUrl); hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = liveUrl; attached = true;
    } else {
      videoStatus('공식 중계에서 시청'); return;
    }
    placeholder.hidden = true; video.muted = true;
    video.play().catch(() => { el('live-note').textContent = '재생 버튼을 눌러 중계를 시작하세요.'; });
  }
  video.addEventListener('playing', () => {
    placeholder.hidden = true; videoStatus(local ? '공유 탭 재생 중' : '생중계');
    el('live-note').textContent = local ? '선택한 탭의 화면입니다.' : '소리를 들으려면 플레이어의 음소거를 해제하세요.';
  });
  video.addEventListener('error', () => { if (attached && !local) failed(); });
  async function update() {
    if (local || updating) return;
    updating = true;
    try {
      await attach();
      const response = await fetch('/api/live/captions', {cache:'no-store'});
      if (!response.ok) throw Error();
      const feed = await response.json();
      if (local) return;
      if (feed.meetingId !== '20261125-economy' || !Array.isArray(feed.segments)) throw Error();
      const fresh = Date.now() - Date.parse(feed.updatedAt) < 75000;
      el('caption-status').textContent = !fresh ? '자막 연결 대기' : feed.status === 'ended' ? '자막 중계 종료' : feed.status === 'live' ? (feed.segments.length ? '자동 자막 · 한국어' : '음성 수신 중 · 발언을 기다립니다') : '방송 음성을 기다립니다';
      const key = feed.segments.at(-1)?.id || '';
      if (key !== latest) {
        const follow = captions.scrollHeight - captions.scrollTop - captions.clientHeight < 60;
        const rows = feed.segments.filter(s => s.text && Number.isFinite(Date.parse(s.at)));
        captions.replaceChildren(...rows.map(s => row(s.text, s.at))); latest = key;
        if (follow) captions.scrollTop = captions.scrollHeight;
      }
    } catch {
      if (!local) el('caption-status').textContent = '자막 연결 대기';
    } finally { updating = false; }
  }
  el('live-refresh').onclick = update;
  el('capture-start').onclick = async () => {
    if (local) return;
    local = true; detach(); latest = ''; captions.replaceChildren();
    el('capture-start').hidden = true; el('capture-stop').hidden = false;
    const restore = () => {
      local = false; el('capture-start').hidden = false; el('capture-stop').hidden = true; update();
    };
    try {
      await CouncilTabCapture.start({ video, onStatus: text => { el('caption-status').textContent = text; },
        onCue: cue => { captions.append(row(cue.text, Date.now())); captions.scrollTop = captions.scrollHeight; },
        onEnd: restore });
    } catch (error) { restore(); el('live-note').textContent = error.message; }
  };
  el('capture-stop').onclick = () => window.CouncilTabCapture?.stop();
  update(); setInterval(update, 6000);
})();
