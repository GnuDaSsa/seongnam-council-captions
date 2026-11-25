const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {test}=require('node:test');
const vm=require('node:vm');

function preview(href,failConstructor=false){
  const workers=[], statuses=[];
  let processor;
  const stream={getAudioTracks:()=>[{}]};
  const noop=()=>{};
  class Microphone {
    sampleRate=1000;
    createMediaStreamSource(){ return {connect:noop,disconnect:noop}; }
    createScriptProcessor(){ return processor={connect:noop,disconnect:noop}; }
    createGain(){ return {gain:{},connect:noop,disconnect:noop}; }
    async resume(){}
    async close(){}
  }
  class Worker {
    constructor(url,options){
      if(failConstructor && url.pathname.endsWith('/hybrid-worker.js')) throw Error('blocked by runtime');
      this.url=url; this.options=options; this.messages=[]; workers.push(this);
    }
    postMessage(message){ this.messages.push(message); }
    terminate(){ this.terminated=true; }
    message(data){ this.onmessage({data}); }
  }
  const window={location:{href},AudioContext:Microphone};
  const video={captureStream:()=>stream,addEventListener:noop,removeEventListener:noop,paused:false,seeking:false,ended:false,
    playbackRate:1,readyState:4,currentTime:20};
  const context={window,Worker,URL,Date,Float32Array,Math,setTimeout,clearTimeout,
    document:{currentScript:{src:new URL('/tab-captions.js?v=source-bundle',href).href}}};
  vm.runInNewContext(readFileSync('dist/tab-captions.js','utf8'),context);
  return {
    workers,statuses,
    start:()=>window.CouncilTabCapture.startPlayer({video,mediaTimeline:true,onStatus:message=>statuses.push(message)}),
    stop:window.CouncilTabCapture.stop,
    queueAudio(){ for(let i=0;i<8;i++) processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(1000).fill(.1)}}); },
  };
}

test('the public VOD flag opts into the pinned worker and a loading failure reuses queued audio through Whisper',async t=>{
  const app=preview('https://example.test/?vod=5482&asr=hybrid');
  t.after(app.stop);
  await app.start();
  const fast=app.workers[0];
  assert.equal(fast.url.href,'https://example.test/asr/hybrid-worker.js?v=source-bundle');
  assert.equal(fast.messages[0].assetMode,'public');
  app.queueAudio();
  fast.message({type:'error',message:'invalid checksum'});
  assert.ok(fast.terminated);
  const base=app.workers[1];
  assert.equal(base.url.pathname,'/asr/worker.js');
  assert.equal(base.options.type,'module');
  assert.equal(base.messages[0].assetMode,undefined);
  fast.message({type:'ready'}); // An already queued message from the dead worker cannot select it again.
  assert.equal(app.workers.length,2);
  base.message({type:'ready',model:'Xenova/whisper-base'});
  assert.equal(base.messages[1].type,'audio');
  assert.ok(app.statuses.some(message=>message.includes('기본 음성 인식으로 전환')));
});

test('local keeps verified assets, public without flag remains Whisper, and worker creation failures recover',async t=>{
  for (const [href,mode,fail] of [
    ['http://127.0.0.1:4186/?asr=hybrid','local',false],
    ['https://example.test/?vod=5482',undefined,false],
    ['https://example.test/?vod=5482&asr=hybrid',undefined,true],
  ]){
    const app=preview(href,fail);
    t.after(app.stop);
    await app.start();
    assert.equal(app.workers[0].messages[0].assetMode,mode);
    assert.equal(app.workers[0].url.pathname,mode?'/asr/hybrid-worker.js':'/asr/worker.js');
  }
});
