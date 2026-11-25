const assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
let now = 100000, processor, worker, context;
class Clock extends Date { static now() { return now; } }
class AudioContext {
  constructor() { this.sampleRate = 1000; context = this; }
  createMediaStreamSource() { return {connect(){}, disconnect(){}}; }
  createScriptProcessor() { return processor = {connect(){},disconnect(){}}; }
  createGain() { return {gain:{},connect(){},disconnect(){}}; }
  resume() { return Promise.resolve(); } close() { return Promise.resolve(); }
}
class Worker { constructor(){ worker=this; this.messages=[]; } postMessage(m) {this.messages.push(m);} terminate(){} }
const track={addEventListener(){},stop(){}};
const stream={getAudioTracks:()=>[track],getVideoTracks:()=>[track],getTracks:()=>[track]};
let release;
const navigator={mediaDevices:{getDisplayMedia:()=>new Promise(r=>release=r)}};
const window={AudioContext}, video={play:()=>Promise.resolve(),pause(){}};
const ctx={window,navigator,Worker,URL,Date:Clock,Float32Array,Math,console,setTimeout,clearTimeout,document:{currentScript:{src:'https://example.test/tab-captions.js'}}};
vm.runInNewContext(fs.readFileSync('dist/tab-captions.js','utf8'),ctx);
(async()=>{
 let cue; const promise=window.CouncilTabCapture.start({video,onCue:c=>cue=c});
 now=160000; release(stream); await promise;
 worker.onmessage({data:{type:'ready'}});
 const block=new Float32Array(1000).fill(.1);
 for(let i=0;i<8;i++) { now=161000+i*1000; processor.onaudioprocess({inputBuffer:{getChannelData:()=>block}}); }
 const chunk=worker.messages.find(m=>m.type==='audio');
 assert.equal(chunk.start,0); assert.equal(chunk.end,8);
 now=180000; worker.onmessage({data:{type:'result',text:'hello',start:chunk.start,end:chunk.end}});
 assert.equal(cue.observedAt,160000, 'permission and inference delays must not shift first PCM time');
 window.CouncilTabCapture.stop();
 console.log('PASS: delayed permission and inference anchor at first PCM sample');
})().catch(e=>{console.error(e);process.exitCode=1});
