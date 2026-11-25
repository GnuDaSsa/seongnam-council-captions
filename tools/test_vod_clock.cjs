'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
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
  const window={AudioContext};
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
  live.window.CouncilTabCapture.stop();
  console.log('PASS VOD seek epochs, pending, pause/waiting, rate, no speaker carry, stop and live clock');
})().catch(error=>{console.error(error); process.exitCode=1});
