const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
class Element {
  constructor() { this.children=[]; this.handlers={}; this.dataset={}; this.scrollHeight=0; this.scrollTop=0; this.clientHeight=0; this.readyState=1; this.srcObject=null; }
  addEventListener(name, fn) { this.handlers[name]=fn; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children=items; }
  querySelector() { return this.child ||= new Element(); }
  querySelectorAll() { return []; }
  removeAttribute(key) { delete this[key]; }
  pause() {}
  load() {}
  play() { return Promise.resolve(); }
  canPlayType() { return ''; }
  click() {}
  get allText() { return (this.textContent || '') + this.children.map(x => x.allText).join(''); }
}
const ids = new Map();
const el = id => { if (!ids.has(id)) ids.set(id,new Element()); return ids.get(id); };
const timers = new Map(); let timerId=0;
const calls=[]; const pending=[];
const meeting = id => ({id,title:'위원회'+id,label:'감사',scheduledAt:'2020-01-01T00:00:00Z',endsAt:'2099-01-01T00:00:00Z',source:'https://example.com',playlist:'https://example.com/a.m3u8',agenda:[]});
const response = data => ({ok:true,status:200,json:async()=>data});
const feed = (id,text,status='live') => ({meetingId:id,updatedAt:new Date().toISOString(),status,cues:[{id:'x',start:1,end:2,text,rawText:'원문',flags:['number','name']}]});
const location = {href:'https://example.test/?live=invalid'};
const context = {
  document:{getElementById:el,createElement:()=>new Element()},
  window:{CouncilTabCapture:{stop(){}},CouncilLiveMinutes:{select(){}}}, URL, Date, Intl, console, location,
  history:{replaceState(_a,_b,url){location.href=String(url)}},
  fetch(url) {
    calls.push(url);
    if (url.includes('live-meetings')) return Promise.resolve(response({meetings:[meeting('2852'),meeting('2853')]}));
    return new Promise((resolve,reject)=>pending.push({url,resolve,reject}));
  },
  setTimeout(fn, delay) { const id=++timerId; timers.set(id,{fn,delay}); return id; },
  clearTimeout(id) { timers.delete(id); },
  CouncilExports:{minutesHwpx(data){context.exported=data; return new Blob(['test']);}}
};
vm.runInNewContext(fs.readFileSync('dist/asr/quality.js','utf8'),context);
context.window.CouncilQuality = context.CouncilQuality;
context.window.CouncilKoreanCorrections = require('../dist/korean-corrections.js');
assert.equal(context.CouncilQuality.repeated('-그러니까요.'.repeat(41)),true);
assert.equal(context.CouncilQuality.repeated('이 제품은 '.repeat(80)),true);
assert.equal(context.CouncilQuality.repeated('네 네, 그렇습니다. 네 네, 알겠습니다.'),false);
assert.equal(context.CouncilQuality.repeated('사업은 중요합니다. 사업이 필요한 이유와 사업 추진 방향을 설명하겠습니다.'),false);
vm.runInNewContext(fs.readFileSync('dist/live.js','utf8'),context);
const flush = () => new Promise(resolve=>setImmediate(resolve));
async function settle() { for(let i=0;i<5;i++) await flush(); }
async function run() {
  await settle();
  assert.match(pending[0].url,/2853/,'invalid link uses economic committee');
  pending.shift().resolve(response(feed('2853','첫 번째')));
  await settle();
  assert.match(el('live-captions').allText,/첫 번째/);
  assert.match(el('live-captions').allText,/숫자 확인, 이름 확인/);
  const timer=[...timers.entries()].find(([,t])=>t.delay===3000);
  assert.ok(timer,'next poll scheduled'); timers.delete(timer[0]); timer[1].fn();
  assert.match(pending[0].url,/2853/,'second poll uses selected generation');
  const old=pending.shift();
  el('live-meeting-select').handlers.change({target:{value:'2852'}});
  assert.match(pending[0].url,/2852/);
  const ended = feed('2852','새 회의','ended'); ended.updatedAt='2000-01-01T00:00:00Z';
  pending.shift().resolve(response(ended));
  await settle();
  old.resolve(response(feed('2853','늦은 이전 회의')));
  await settle();
  assert.match(el('live-captions').allText,/새 회의/);
  assert.doesNotMatch(el('live-captions').allText,/늦은 이전 회의/);
  assert.equal(el('caption-status').textContent,'공유 자막 제공 종료');
  el('live-save').onclick();
  assert.match(context.exported.segments[0].text,/검토 필요: 숫자 확인, 이름 확인/);
  assert.match(context.exported.segments[0].text,/인식 원문: 원문/);
  assert.equal(context.exported.segments[0].end,2);
  const next=[...timers.entries()].find(([,t])=>t.delay===3000); timers.delete(next[0]); next[1].fn();
  const noisy=feed('2852','-그러니까요.'.repeat(41)); noisy.cues[0].rawText=noisy.cues[0].text;
  pending.shift().resolve(response(noisy)); await settle();
  assert.match(el('live-captions').allText,/반복 오류/);
  el('live-save').onclick();
  assert.match(context.exported.segments[0].text,/재확인 필요/);
  assert.doesNotMatch(context.exported.segments[0].text,/그러니까요/);
  for (const [id,timer] of [...timers.entries()].filter(([,t])=>t.delay===3000)) { timers.delete(id); timer.fn(); }
  const publicCue=require('./garum_public_fixture.json').find(item=>item.meetingId==='2852').text;
  const observed=feed('2852',publicCue); observed.cues[0].rawText=publicCue; observed.cues[0].flags=[];
  pending.shift().resolve(response(observed)); await settle();
  assert.match(el('live-captions').allText,/갈음하겠습니다/);
  assert.match(el('live-captions').allText,/문맥 교정됨/);
  assert.match(el('live-captions').allText,/가름하겠습니다/);
  el('live-save').onclick();
  assert.match(context.exported.segments[0].text,/갈음하겠습니다/);
  assert.match(context.exported.segments[0].text,/인식 원문:.*가름하겠습니다/);
  console.log('PASS: second polling, late response isolation, default selection, status, flags and export');
}
run().catch(error=>{console.error(error);process.exitCode=1});
