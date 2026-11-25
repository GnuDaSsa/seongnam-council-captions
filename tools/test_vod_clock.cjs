'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(href) {
  const workers = [], contexts = [], tracks = [{stopped:false, stop(){this.stopped=true}}];
  class Worker {
    constructor() { this.messages=[]; this.terminated=false; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated=true; }
    reply(data) { this.onmessage({data}); }
  }
  const node = () => ({disconnected:false, connect(){}, disconnect(){this.disconnected=true}});
  class AudioContext {
    constructor() { this.sampleRate=16000; this.destination={}; this.closed=false; contexts.push(this); }
    createMediaStreamSource(){ return this.source=node(); }
    createScriptProcessor(){ return this.processor=node(); }
    createGain(){ const gain=node(); gain.gain={value:1}; return this.silent=gain; }
    resume(){ return Promise.resolve(); }
    close(){ this.closed=true; return Promise.resolve(); }
  }
  const handlers = new Map();
  const stream={getAudioTracks:()=>tracks, getVideoTracks:()=>tracks, getTracks:()=>tracks};
  const video={currentTime:0, playbackRate:1, paused:false, seeking:false, ended:false, readyState:4,
    captureStream:()=>stream,
    addEventListener(name,fn){handlers.set(name,fn)}, removeEventListener(name,fn){if(handlers.get(name)===fn)handlers.delete(name)},
    emit(name){handlers.get(name)?.()}, pause(){this.paused=true}};
  const window={AudioContext, ...(href ? {location:{href}} : {})};
  const context={window, Worker, URL, Float32Array, Math, Date, Number,
    document:{currentScript:{src:'https://example.test/tab-captions.js'}},
    navigator:{}, setTimeout:()=>1, clearTimeout:()=>{}};
  vm.runInNewContext(fs.readFileSync('dist/tab-captions.js','utf8'), context, {filename:'dist/tab-captions.js'});
  function frames(n, speed=1) {
    for(let i=0;i<n;i++) {
      video.currentTime += speed;
      contexts.at(-1).processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(16000).fill(0.1)}});
    }
  }
  return {window,workers,contexts,video,tracks,handlers,frames};
}

(async () => {
  const repair=harness(), repaired=[];
  await repair.window.CouncilTabCapture.startPlayer({video:repair.video,mediaTimeline:true,onCue:c=>repaired.push(c)});
  repair.workers[0].reply({type:'ready'}); repair.frames(8);
  repair.window.CouncilTabCapture.hlsRecovery(repair.video,{details:'bufferSeekOverHole'});
  repair.video.emit('seeking');
  repair.workers[0].reply({type:'result',text:'completed before repair',start:0,end:8});
  assert.equal(repaired.length,1,'completed audio survives verified HLS repair');
  repair.frames(8);
  repair.video.emit('pointerdown');
  repair.window.CouncilTabCapture.hlsRecovery(repair.video,{details:'bufferSeekOverHole'});
  repair.video.emit('seeking');
  repair.workers[0].reply({type:'result',text:'stale user seek',start:8,end:16});
  assert.equal(repaired.length,1,'user interaction takes precedence over HLS recovery');
  repair.window.CouncilTabCapture.stop();
  const mismatch=harness(), mismatchCues=[];
  await mismatch.window.CouncilTabCapture.startPlayer({video:mismatch.video,mediaTimeline:true,onCue:c=>mismatchCues.push(c)});
  mismatch.workers[0].reply({type:'ready'}); mismatch.frames(8);
  mismatch.window.CouncilTabCapture.hlsRecovery(mismatch.video,{details:'bufferSeekOverHole'});
  mismatch.video.currentTime += 0.1; mismatch.video.emit('seeking');
  mismatch.workers[0].reply({type:'result',text:'different target',start:0,end:8});
  assert.equal(mismatchCues.length,0,'unrelated seek target invalidates');
  mismatch.window.CouncilTabCapture.stop();
  const explicit=harness(), explicitCues=[];
  await explicit.window.CouncilTabCapture.startPlayer({video:explicit.video,mediaTimeline:true,onCue:c=>explicitCues.push(c)});
  explicit.workers[0].reply({type:'ready'}); explicit.frames(8);
  explicit.window.CouncilTabCapture.hlsRecovery(explicit.video,{details:'bufferSeekOverHole'});
  explicit.window.CouncilTabCapture.userSeek(explicit.video);
  explicit.workers[0].reply({type:'result',text:'stale before seeking event',start:0,end:8});
  assert.equal(explicitCues.length,0,'explicit seek invalidates immediately even before browser event');
  explicit.window.CouncilTabCapture.stop();
  const h=harness(), cues=[];
  let ended=0;
  await h.window.CouncilTabCapture.startPlayer({video:h.video,mediaTimeline:true,onCue:c=>cues.push(c),onEnd:()=>ended++});
  const w=h.workers[0]; w.reply({type:'ready'});
  h.video.currentTime=12; h.frames(8);
  let audio=w.messages.filter(m=>m.type==='audio');
  assert.equal(audio.length,1); assert.equal(audio[0].start,12); assert.equal(audio[0].end,20);
  h.video.seeking=true; h.video.emit('seeking'); h.video.currentTime=80; h.video.seeking=false;
  h.frames(8); assert.equal(w.messages.filter(m=>m.type==='audio').length,1, 'new chunk waits for prior worker');
  w.reply({type:'result',text:'stale speaker text',start:12,end:20});
  assert.equal(cues.length,0,'prior epoch must never appear after seek');
  audio=w.messages.filter(m=>m.type==='audio');
  assert.equal(audio.length,2); assert.equal(audio[1].start,80); assert.equal(audio[1].end,88);
  w.reply({type:'result',text:'new text',start:80,end:88});
  assert.equal(cues.length,1); assert.equal(cues[0].text,'new text');
  assert.equal(cues[0].start,80); assert.equal(cues[0].end,88); assert.equal(cues[0].observedAt,null);
  assert.equal(Object.hasOwn(cues[0],'speaker'),false,'no inherited speaker label');
  h.video.paused=true; h.video.emit('pause'); h.frames(10); h.video.paused=false;
  h.video.emit('waiting'); h.frames(10); h.video.emit('playing');
  assert.equal(w.messages.filter(m=>m.type==='audio').length,2,'pause/waiting audio must be ignored');
  h.video.emit('ratechange'); h.video.playbackRate=2; h.video.currentTime=100; h.frames(8,2);
  audio=w.messages.filter(m=>m.type==='audio'); assert.equal(audio.length,3);
  assert.equal(audio[2].start,100); assert.equal(audio[2].end,116);
  w.reply({type:'result',text:'fast',start:100,end:116});
  assert.equal(cues.at(-1).start,100); assert.equal(cues.at(-1).end,116);
  const prior=h.contexts[0].processor.onaudioprocess;
  h.window.CouncilTabCapture.stop();
  assert.equal(w.terminated,true); assert.equal(h.contexts[0].processor.onaudioprocess,null);
  assert.equal(h.contexts[0].processor.disconnected,true); assert.equal(h.contexts[0].source.disconnected,true);
  assert.equal(h.contexts[0].silent.disconnected,true); assert.equal(h.contexts[0].closed,true);
  assert.equal(h.handlers.size,0); assert.equal(h.tracks[0].stopped,false,'player stream is not owned');
  assert.equal(ended,1); h.window.CouncilTabCapture.stop(); assert.equal(ended,1);
  w.reply({type:'result',text:'after stop',start:116,end:124}); assert.equal(cues.length,2);
  assert.equal(typeof prior,'function');
  const live=harness(), lc=[];
  await live.window.CouncilTabCapture.startPlayer({video:live.video,onCue:c=>lc.push(c)});
  live.workers[0].reply({type:'ready'}); live.video.currentTime=300; live.frames(8);
  const msg=live.workers[0].messages.find(m=>m.type==='audio'); assert.equal(msg.start,0); assert.equal(msg.end,8);
  live.workers[0].reply({type:'result',text:'live',start:0,end:8});
  assert.equal(lc[0].start,0); assert.equal(lc[0].end,8); assert.ok(Number.isFinite(lc[0].observedAt));
  live.frames(16); // old live tab mode keeps only the newest pending chunk
  live.workers[0].reply({type:'result',text:'prior',start:0,end:8});
  const liveAudio=live.workers[0].messages.filter(m=>m.type==='audio');
  assert.equal(liveAudio.at(-1).start,16,'live capture remains low-latency latest-pending');
  live.window.CouncilTabCapture.stop();
  // Slow inference preserves a bounded, ordered history for VOD; a seek clears it.
  const q=harness(), qc=[], statuses=[];
  await q.window.CouncilTabCapture.startPlayer({video:q.video,mediaTimeline:true,onCue:c=>qc.push(c),onStatus:s=>statuses.push(s)});
  const qw=q.workers[0]; q.video.currentTime=200;
  q.frames(24); // three chunks captured while model loads
  assert.equal(qw.messages.filter(m=>m.type==='audio').length,0);
  qw.reply({type:'ready'});
  let sent=qw.messages.filter(m=>m.type==='audio'); assert.equal(sent[0].start,200);
  qw.reply({type:'result',text:'one',start:200,end:208});
  sent=qw.messages.filter(m=>m.type==='audio'); assert.equal(sent[1].start,208);
  qw.reply({type:'result',text:'two',start:208,end:216});
  sent=qw.messages.filter(m=>m.type==='audio'); assert.equal(sent[2].start,216);
  q.frames(40); // four waiting chunks retained, fifth evicts oldest
  assert.ok(statuses.some(s=>s.includes('건너뜁니다')));
  qw.reply({type:'result',text:'three',start:216,end:224});
  sent=qw.messages.filter(m=>m.type==='audio'); assert.equal(sent[3].start,232);
  q.video.emit('seeking'); q.video.currentTime=500; q.frames(8);
  qw.reply({type:'result',text:'stale',start:232,end:240});
  assert.equal(qc.some(c=>c.text==='stale'),false);
  sent=qw.messages.filter(m=>m.type==='audio'); assert.equal(sent.at(-1).start,500);
  qw.reply({type:'result',text:'after seek',start:500,end:508});
  assert.equal(qc.at(-1).start,500);
  q.window.CouncilTabCapture.stop();
  // Loopback opt-in emits a fast cue, then revises precisely the same ID and clock.
  const hy=harness('http://127.0.0.1:4178/?asr=hybrid'), drafts=[], corrections=[];
  await hy.window.CouncilTabCapture.startPlayer({video:hy.video,mediaTimeline:true,onCue:c=>drafts.push(c),onCorrection:c=>corrections.push(c)});
  assert.equal(hy.workers.length,1); const fast=hy.workers[0]; fast.reply({type:'ready',model:'local-zipformer'});
  assert.equal(hy.workers.length,2); const slow=hy.workers[1]; slow.reply({type:'ready',model:'Xenova/whisper-base'});
  hy.video.currentTime=50;hy.frames(8);fast.reply({type:'result',text:'빠른 자막',start:50,end:58});
  assert.equal(drafts.length,1);assert.equal(drafts[0].stage,'draft');
  const slowChunk=slow.messages.find(m=>m.type==='audio');assert.equal(slowChunk.start,50);assert.equal(slowChunk.end,58);
  hy.video.emit('waiting'); // buffering must not discard a completed cue's refinement
  slow.reply({type:'result',text:'정정 자막',start:50,end:58});
  hy.video.emit('playing');
  assert.equal(corrections.length,1);assert.equal(corrections[0].id,drafts[0].id);assert.equal(corrections[0].start,50);assert.equal(corrections[0].end,58);
  hy.frames(8);fast.reply({type:'result',text:'이전 구간',start:58,end:66});
  hy.video.emit('seeking');hy.video.currentTime=400;hy.frames(8);
  slow.reply({type:'result',text:'탐색 이전 정정',start:58,end:66});
  assert.equal(corrections.length,1,'a result from before seeking cannot revise a cue');
  fast.reply({type:'result',text:'새 위치',start:400,end:408});assert.equal(drafts.at(-1).start,400);
  const beforeError=drafts.length;slow.reply({type:'error',message:'model unavailable'});
  hy.frames(8);fast.reply({type:'result',text:'빠른 자막 계속',start:408,end:416});assert.equal(drafts.length,beforeError+1,'refiner failure must not end the fast stream');
  hy.window.CouncilTabCapture.stop();assert.equal(fast.terminated,true);assert.equal(slow.terminated,true);
  slow.reply({type:'result',text:'종료 후 정정',start:400,end:408});assert.equal(corrections.length,1,'stopped sessions reject late corrections');
  const interrupted=harness(), interruptedCues=[];
  await interrupted.window.CouncilTabCapture.startPlayer({video:interrupted.video,mediaTimeline:true,onCue:c=>interruptedCues.push(c)});
  const iw=interrupted.workers[0];iw.reply({type:'ready'});interrupted.frames(4);interrupted.video.emit('waiting');interrupted.frames(4);interrupted.video.emit('playing');interrupted.video.currentTime=20;interrupted.frames(8);
  const im=iw.messages.filter(m=>m.type==='audio');assert.equal(im.length,1);assert.equal(im[0].start,20);assert.equal(im[0].end,28,'partial samples across buffering must not be merged');
  interrupted.video.emit('emptied');iw.reply({type:'result',text:'old source',start:20,end:28});assert.equal(interruptedCues.length,0,'emptied source invalidates completed work');interrupted.window.CouncilTabCapture.stop();
  const blank=harness('http://localhost:4178/?asr=hybrid'), recovered=[];
  await blank.window.CouncilTabCapture.startPlayer({video:blank.video,mediaTimeline:true,onCue:c=>recovered.push(c)});
  blank.workers[0].reply({type:'ready',model:'local-zipformer'});blank.workers[1].reply({type:'ready',model:'Xenova/whisper-base'});
  blank.frames(8);blank.workers[0].reply({type:'result',text:'',start:0,end:8});assert.equal(recovered.length,0);
  blank.workers[1].reply({type:'result',text:'후속 음성',start:0,end:8});assert.equal(recovered[0].stage,'refined');assert.equal(recovered[0].start,0);
  blank.window.CouncilTabCapture.stop();
  const liveOpt=harness('http://localhost:4178/?asr=hybrid');await liveOpt.window.CouncilTabCapture.startPlayer({video:liveOpt.video});liveOpt.workers[0].reply({type:'ready'});assert.equal(liveOpt.workers.length,1,'live mode never starts local hybrid');liveOpt.window.CouncilTabCapture.stop();
  const remote=harness('https://example.test/?asr=hybrid');await remote.window.CouncilTabCapture.startPlayer({video:remote.video,mediaTimeline:true});
  assert.equal(remote.workers[0].messages[0].assetMode,'public','HTTPS replay loads the pinned public model');
  remote.workers[0].reply({type:'ready'});
  assert.equal(remote.workers.length,2,'an opted-in replay starts the refinement worker');
  remote.window.CouncilTabCapture.stop();
  console.log('PASS VOD seek epochs, pending, pause/waiting, rate, no speaker carry, stop and live clock');
})().catch(error=>{console.error(error); process.exitCode=1});
