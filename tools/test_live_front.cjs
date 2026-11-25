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
  setAttribute(key,value) { this[key]=value; }
  scrollIntoView() { this.scrolled=(this.scrolled || 0)+1; }
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
const meeting = (id,title='위원회'+id) => ({id,title,label:'감사',scheduledAt:'2020-01-01T00:00:00Z',endsAt:'2099-01-01T00:00:00Z',provider:'hls',source:'https://example.com',playlist:'https://example.com/a.m3u8',agenda:[]});
const response = data => ({ok:true,status:200,json:async()=>data});
const feed = (id,text,status='live') => ({meetingId:id,updatedAt:new Date().toISOString(),status,cues:[{id:'x',start:1,end:2,text,rawText:'원문',flags:['number','name']}]});
const location = {href:'https://example.test/?live=invalid'};
const context = {
  document:{getElementById:el,createElement:()=>new Element()},
  window:{CouncilTabCapture:{stop(){}},CouncilLiveMinutes:{select(){}}}, URL, Date, Intl, console, location,
  history:{replaceState(_a,_b,url){location.href=String(new URL(url,location.href))}},
  fetch(url) {
    calls.push(url);
    if (url.includes('live-meetings')) return Promise.resolve(response({meetings:[meeting('2852'),meeting('2853','경제환경위원회')]}));
    return new Promise((resolve,reject)=>pending.push({url,resolve,reject}));
  },
  setTimeout(fn, delay) { const id=++timerId; timers.set(id,{fn,delay}); return id; },
  clearTimeout(id) { timers.delete(id); },
  CouncilExports:{minutesHwpx(data){context.exported=data; return new Blob(['test']);}}
};
vm.runInNewContext(fs.readFileSync('dist/asr/quality.js','utf8'),context);
context.window.CouncilQuality = context.CouncilQuality;
context.window.CouncilKoreanCorrections = require('../dist/korean-corrections.js');
context.window.CouncilLiveSpeaker = require('../dist/live-speaker.js');
const officialVod='https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5403';
const priorSpeech={vodId:'5403',sourceUrl:officialVod,registeredOn:'2026-07-07',position:7229};
const {registeredVodHref}=context.window.CouncilLiveSpeaker;
assert.equal(registeredVodHref(priorSpeech),officialVod+'&position=7229');
assert.equal(registeredVodHref({...priorSpeech,sourceUrl:officialVod+'&position=0',position:71.44}),officialVod+'&position=71');
for (const sourceUrl of ['https://evil.example/vod/vod_view.jsp?pk_vod_no=5403',
  'https://cast.sncouncil.go.kr.evil.example/vod/vod_view.jsp?pk_vod_no=5403',
  officialVod+'&redirect=https://evil.example',officialVod+'&pk_vod_no=5403',officialVod+'#',officialVod+'&']) {
  assert.equal(registeredVodHref({...priorSpeech,sourceUrl}),'');
}
for (const update of [{vodId:'5418'},{position:-1},{position:Infinity},{position:86401},{position:'12'},
  {registeredOn:'2026-02-30'},{registeredOn:undefined}]) {
  assert.equal(registeredVodHref({...priorSpeech,...update}),'');
}
assert.equal(context.CouncilQuality.repeated('-그러니까요.'.repeat(41)),true);
assert.equal(context.CouncilQuality.repeated('이 제품은 '.repeat(80)),true);
assert.equal(context.CouncilQuality.repeated('네 네, 그렇습니다. 네 네, 알겠습니다.'),false);
assert.equal(context.CouncilQuality.repeated('사업은 중요합니다. 사업이 필요한 이유와 사업 추진 방향을 설명하겠습니다.'),false);
vm.runInNewContext(fs.readFileSync('dist/live.js','utf8'),context);
const flush = () => new Promise(resolve=>setImmediate(resolve));
async function settle() { for(let i=0;i<5;i++) await flush(); }
async function checkMeetingSelection(manifest, url, expected, past) {
  const elements = new Map();
  const find = id => {
    if (!elements.has(id)) elements.set(id,new Element());
    return elements.get(id);
  };
  const testLocation = {href:url};
  const opened = [];
  const fetches = [];
  vm.runInNewContext(fs.readFileSync('dist/live.js','utf8'),{
    ...context,
    document:{getElementById:find,createElement:()=>new Element()},
    window:{CouncilLiveMinutes:{select(row){opened.push(row.id);}}},
    location:testLocation,
    history:{replaceState(_a,_b,next){testLocation.href=String(next);}},
    fetch(path){
      if (path.includes('live-meetings')) return Promise.resolve(response(manifest));
      fetches.push(path);
      return new Promise(()=>{});
    },
  });
  await settle();
  assert.deepEqual(opened,[expected]);
  assert.equal(find('live-meeting-select').value,expected);
  assert.equal(find('live-today').hidden,!past);
  assert.equal(find('live-source').href,'https://example.com');
  assert.ok(fetches[0].includes('meetingId='+expected));
}
async function run() {
  await settle();
  assert.match(pending[0].url,/2853/,'invalid link uses economic committee');
  assert.equal(el('live-today').hidden,false);
  const future = {date:'2098-01-15',defaultMeetingId:'4361',
    meetings:[meeting('4360','경제환경위원회'),meeting('4361','행정교육위원회')]};
  await checkMeetingSelection(future,'https://example.test/','4361',false);
  await checkMeetingSelection(future,'https://example.test/?live=4360','4360',false);
  await checkMeetingSelection({date:'2020-01-01',defaultMeetingId:'4361',
    meetings:[meeting('bad'),meeting('4362'),meeting('4363')]},
  'https://example.test/?live=9999','4362',true);
  const first=feed('2853','첫 번째');
  first.nameplateStatus={latest:{capturedAt:new Date().toISOString(),matchedMembers:[]},lastMatch:{capturedAt:new Date().toISOString(),matchedMembers:['테스트 의원']}};
  pending.shift().resolve(response(first));
  await settle();
  assert.match(el('live-captions').allText,/첫 번째/);
  assert.match(el('live-speaker-visual').textContent,/최근 명패 판독/);
  assert.match(el('live-speaker-visual').textContent,/읽힌 이름 없음/);
  assert.doesNotMatch(el('live-speaker-visual').textContent,/테스트 의원/,'a recent empty reading is distinct from the previous name read');
  assert.match(el('live-captions').allText,/숫자 확인, 이름 확인/);
  const timer=[...timers.entries()].find(([,t])=>t.delay===3000);
  assert.ok(timer,'next poll scheduled'); timers.delete(timer[0]); timer[1].fn();
  assert.match(pending[0].url,/2853/,'second poll uses selected generation');
  const old=pending.shift();
  el('live-meeting-select').handlers.change({target:{value:'2852'}});
  assert.match(pending[0].url,/2852/);
  const ended = feed('2852','새 회의','ended'); ended.updatedAt='2000-01-01T00:00:00Z';
  ended.nameplateStatus={latest:{capturedAt:new Date(Date.now()-600000).toISOString(),matchedMembers:[]},lastMatch:{capturedAt:new Date(Date.now()-300000).toISOString(),matchedMembers:['과거 의원']}};
  pending.shift().resolve(response(ended));
  await settle();
  assert.match(el('live-speaker-visual').textContent,/마지막 이름 판독/);
  assert.match(el('live-speaker-visual').textContent,/과거 의원/);
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
  for (const [id,timer] of [...timers.entries()].filter(([,t])=>t.delay===3000)) { timers.delete(id); timer.fn(); }
  const speakerFeed=feed('2852','발언 내용');
  speakerFeed.cues[0].speaker={name:'정연화',role:'위원',confidence:'low',method:'호명 단서',evidence:['x'],
    registeredVodReference:priorSpeech};
  speakerFeed.cues.push({...speakerFeed.cues[0]});
  pending.shift().resolve(response(speakerFeed)); await settle();
  assert.match(el('live-captions').allText,/정연화 위원 · 추정/);
  assert.match(el('live-speaker-name').textContent,/정연화 위원 · 추정/);
  assert.equal(el('live-speaker-recent').hidden,false);
  assert.match(el('live-speaker-recent').href,/live=2852.*cue=x/);
  let prevented=false;
  el('live-speaker-recent').handlers.click({button:0,preventDefault(){prevented=true;}});
  assert.equal(prevented,true,'ordinary click opens history without navigation');
  assert.equal(new URL(location.href).searchParams.get('cue'),'x');
  el('live-speaker-history').handlers.toggle();
  for (let i=pending.length-1;i>=0;i--) {
    if (pending[i].url.includes('/api/live/minutes?'))
      pending.splice(i,1)[0].resolve(response({meetingId:'2852',speakerAttributionApplied:true,cues:speakerFeed.cues}));
    else if (pending[i].url.includes('/api/live/nameplates?'))
      pending.splice(i,1)[0].resolve(response({meetingId:'2852',observations:[]}));
  }
  await settle();
  assert.equal((el('live-speaker-history-list').allText.match(/발언자 근거 영상/g)||[]).length,1);
  el('live-speaker-history').open=false;
  el('live-speaker-history').handlers.toggle();
  for (let i=pending.length-1;i>=0;i--) if (/\/api\/live\/(minutes|nameplates)/.test(pending[i].url)) pending.splice(i,1);
  assert.match(el('live-speaker-meta').textContent,/호명 단서.*자동 추정/);
  assert.match(el('live-speaker-count').textContent,/전체 1건 중 이름 1건 · 역할만 0건/);
  el('live-speaker-filter').checked=true; el('live-speaker-filter').handlers.change();
  assert.match(el('live-captions').allText,/정연화/);
  assert.match(el('live-captions').allText,/발언자 추정 근거/);
  assert.match(el('live-captions').allText,/호명 단서/);
  assert.equal((el('live-captions').allText.match(/정연화 위원 · 추정/g)||[]).length,1);
  const [,content]=el('live-captions').children[0].children;
  const [proofLink]=content.children.find(child=>child.className==='cue-speaker-evidence').children.filter(child=>child.href);
  assert.equal(proofLink.href,officialVod+'&position=7229');
  assert.equal(proofLink.textContent,'발언자 근거 영상');
  assert.equal(proofLink.target,'_blank');
  assert.equal(proofLink.rel,'noopener noreferrer');
  assert.equal((el('live-captions').allText.match(/발언자 근거 영상/g)||[]).length,1);
  el('live-save').onclick();
  assert.equal(context.exported.segments.length,1);
  assert.equal(context.exported.segments[0].speaker,'정연화 위원 · 추정');
  for (const [id,timer] of [...timers.entries()].filter(([,t])=>t.delay===3000)) { timers.delete(id); timer.fn(); }
  const changedSpeaker=feed('2852','발언 내용');
  changedSpeaker.cues[0].speaker={name:'김정아',role:'과장',confidence:'medium',method:'self_intro',evidence:['x'],
    registeredVodReference:{...priorSpeech,sourceUrl:officialVod+'&redirect=https://evil.example'}};
  pending.shift().resolve(response(changedSpeaker)); await settle();
  assert.match(el('live-captions').allText,/김정아 과장 · 자기소개 단서 · 추정/);
  assert.doesNotMatch(el('live-captions').allText,/정연화/);
  assert.doesNotMatch(el('live-captions').allText,/발언자 근거 영상/);
  for (const [id,timer] of [...timers.entries()].filter(([,t])=>t.delay===3000)) { timers.delete(id); timer.fn(); }
  const roleOnly=feed('2852','환경정책 과장입니다.');
  roleOnly.cues[0].speaker={name:'',role:'환경정책 과장',method:'직책 자기소개',evidence:['x']};
  pending.shift().resolve(response(roleOnly)); await settle();
  assert.match(el('live-captions').allText,/환경정책 과장 \(실명 미확인\)/);
  assert.match(el('live-speaker-count').textContent,/이름 0건 · 역할만 1건 · 표시 1건/);
  for (const [id,timer] of [...timers.entries()].filter(([,t])=>t.delay===3000)) { timers.delete(id); timer.fn(); }
  const cleared=feed('2852','발언 내용','interrupted'); cleared.updatedAt='2000-01-01T00:00:00Z';
  pending.shift().resolve(response(cleared)); await settle();
  assert.equal(el('live-speaker-name').textContent,'발언자 미확인');
  assert.equal(el('live-speaker-visual').hidden,true,'absent nameplate is hidden');
  assert.equal(el('live-speaker-recent').hidden,false);
  assert.match(el('live-speaker-recent').href,/speaker=recent/);
  assert.match(el('live-captions').allText,/이름이나 직책이 표시된 발언이 없습니다/);
  assert.match(el('live-speaker-count').textContent,/표시 0건/);
  el('live-speaker-filter').checked=false; el('live-speaker-filter').handlers.change();
  assert.match(el('live-captions').allText,/발언자 미확인/);
  assert.doesNotMatch(el('live-captions').allText,/김정아|현재 발언/);
  assert.match(el('caption-status').textContent,/중단/);
  let localOptions, attributionCalls=0;
  context.window.CouncilLiveSpeaker={attribute(_meeting, cues) {
    attributionCalls++;
    return {[String(cues[0].id)]:{name:'박정민',role:'의원',confidence:'low',method:'자기소개 단서',evidence:[String(cues[0].id)]}};
  }};
  context.window.CouncilTabCapture={
    async startPlayer(options) { localOptions=options; }, async start(options) { localOptions=options; },
    stop() { localOptions.onEnd(); }
  };
  await el('player-captions').onclick();
  assert.equal(el('live-speaker-visual').textContent,'','personal transcription hides shared screen nameplate observations');
  localOptions.onCue({text:'영상 발언',start:0,end:1,observedAt:Date.now()});
  assert.equal(attributionCalls,1);
  assert.match(el('live-captions').allText,/박정민 의원 · 자기소개 단서 · 추정/);
  el('local-save').onclick();
  assert.equal(context.exported.segments[0].speaker,'박정민 의원 · 자기소개 단서 · 추정');
  el('capture-stop').onclick();
  await el('capture-start').onclick();
  localOptions.onCue({text:'다른 탭 발언',start:0,end:1,observedAt:Date.now()});
  assert.equal(attributionCalls,1,'unrelated tab audio never uses the council roster');
  assert.equal(el('live-speaker-name').textContent,'발언자 미확인');
  el('live-speaker-filter').checked=true; el('live-speaker-filter').handlers.change();
  assert.match(el('live-captions').allText,/이름이나 직책이 표시된 발언이 없습니다/);
  el('live-speaker-filter').checked=false; el('live-speaker-filter').handlers.change();
  assert.match(el('live-captions').allText,/발언자 미확인/);
  assert.doesNotMatch(el('live-captions').allText,/박정민/);
  el('local-save').onclick();
  assert.equal(context.exported.segments[0].speaker,'발언자 미확인');
  el('capture-stop').onclick();
  const history=el('live-speaker-history'); history.open=true; history.handlers.toggle();
  const historyCall=pending.find(item=>item.url.includes('minutes?meetingId=2852'));
  const nameplateCall=pending.find(item=>item.url.includes('nameplates?meetingId=2852'));
  assert.ok(historyCall,'history fetches the archived minutes');
  assert.ok(nameplateCall,'history optionally fetches nameplate observations');
  let attributionArgs;
  const historicSpeaker={name:'조우현',role:'의원',method:'자기소개',evidence:['historic']};
  context.window.CouncilLiveSpeaker={attribute(...args) { attributionArgs=args; return {historic:historicSpeaker}; }};
  historyCall.resolve(response({meetingId:'2852',gaps:[{start:10,end:11}],cues:[
    {id:'historic',start:9,end:10,observedAt:new Date().toISOString(),text:'조우현 의원입니다.',rawText:'조우현 의원입니다.',flags:[]},
    {id:'retired',start:12,end:13,text:'원문 발언',speaker:{name:'옛이름',role:'의원'}},
  ]}));
  nameplateCall.resolve(response({meetingId:'2852',observations:[{capturedAt:new Date().toISOString(),matchedMembers:['조우현']}] }));
  await settle();
  assert.equal(attributionArgs[2].length,1,'archived OCR observations are passed to the speaker core');
  assert.equal(attributionArgs[3].length,1,'archived gaps are passed to the speaker core');
  assert.match(el('live-speaker-history-list').allText,/조우현 의원/);
  assert.doesNotMatch(el('live-speaker-history-list').allText,/옛이름/);
  assert.match(el('live-speaker-history-list').allText,/명패 판독\(발언자 확정 아님\)/);
  assert.match(el('live-speaker-history-status').textContent,/이 회의에서 추정한 발언 1건/);
  assert.equal(el('live-speaker-name').textContent,'발언자 미확인');
  history.handlers.toggle(); const stale=pending.filter(item=>item.url.includes('minutes?meetingId=2852') || item.url.includes('nameplates?meetingId=2852'));
  el('live-meeting-select').handlers.change({target:{value:'2853'}});
  assert.equal(el('live-speaker-history-list').allText,'');
  for (const request of stale) request.resolve(response({meetingId:'2852',cues:[{id:'old',start:1,end:2,text:'old',speaker:{name:'옛이름'}}]}));
  await settle(); assert.doesNotMatch(el('live-speaker-history-list').allText,/옛이름/);
  const nextHistory=pending.find(item=>item.url.includes('minutes?meetingId=2853'));
  const nextNameplates=pending.find(item=>item.url.includes('nameplates?meetingId=2853'));
  nextHistory.resolve(response({meetingId:'2853',cues:[]})); await settle();
  nextNameplates?.resolve({ok:false,status:404,json:async()=>({})}); await settle();
  assert.match(el('live-speaker-history-status').textContent,/없습니다/);
  history.open=false;
  location.href='https://example.test/?live=2853&cue=unlabeled';
  el('live-meeting-select').handlers.change({target:{value:'2853'}});
  assert.equal(history.open,true,'deep link opens the archive');
  history.handlers.toggle();
  const deepMinutes=pending.filter(item=>item.url.includes('minutes?meetingId=2853')).at(-1);
  const deepNames=pending.filter(item=>item.url.includes('nameplates?meetingId=2853')).at(-1);
  deepMinutes.resolve(response({meetingId:'2853',cues:[{id:'unlabeled',start:11,end:12,text:'옛 원문 발언',rawText:'옛 원문 발언',flags:[]}]}));
  deepNames.resolve({ok:false,status:404,json:async()=>({})}); await settle();
  assert.match(el('live-speaker-history-list').allText,/옛 원문 발언/);
  assert.equal(el('live-speaker-history-list').children[0]['aria-current'],'true');
  assert.equal(el('live-speaker-history-list').children[0].scrolled,1);
  assert.match(el('live-speaker-history-list').allText,/발언자 미확인/);
  assert.equal(el('live-speaker-name').textContent,'발언자 미확인');
  el('live-meeting-select').handlers.change({target:{value:'2852'}});
  assert.equal(new URL(location.href).searchParams.has('cue'),false,'meeting change clears cue');
  location.href='https://example.test/?live=2852&cue=missing';
  el('live-meeting-select').handlers.change({target:{value:'2852'}});
  const missingMinutes=pending.filter(item=>item.url.includes('minutes?meetingId=2852')).at(-1);
  const missingNames=pending.filter(item=>item.url.includes('nameplates?meetingId=2852')).at(-1);
  missingMinutes.resolve(response({meetingId:'2852',cues:[]}));
  missingNames.resolve({ok:false,status:404,json:async()=>({})}); await settle();
  assert.match(el('live-speaker-history-status').textContent,/요청한 자막을 찾을 수 없습니다/);
  location.href='https://example.test/?live=2852&speaker=recent&vod=5483';
  el('live-meeting-select').handlers.change({target:{value:'2852'}});
  const recentMinutes=pending.filter(item=>item.url.includes('minutes?meetingId=2852')).at(-1);
  const recentNames=pending.filter(item=>item.url.includes('nameplates?meetingId=2852')).at(-1);
  attributionArgs=undefined;
  recentMinutes.resolve(response({meetingId:'2852',speakerAttributionApplied:true,cues:[{id:'real-last',start:13,end:14,text:'자기소개',rawText:'원문 자기소개',flags:[],speaker:{name:'조우현',role:'의원'}}]}));
  recentNames.resolve({ok:false,status:404,json:async()=>({})}); await settle();
  assert.equal(new URL(location.href).searchParams.get('cue'),'real-last');
  assert.equal(new URL(location.href).searchParams.has('speaker'),false);
  assert.equal(el('live-speaker-history-list').children[0]['aria-current'],'true');
  assert.equal(el('live-speaker-history-list').children[0].scrolled,1);
  assert.match(el('live-speaker-history-list').allText,/원문 자기소개/);
  assert.equal(attributionArgs,undefined,'archive attribution from the server is used once');
  location.href='https://example.test/?live=2852&speaker=recent';
  el('live-meeting-select').handlers.change({target:{value:'2852'}});
  pending.filter(item=>item.url.includes('minutes?meetingId=2852')).at(-1).resolve(response({meetingId:'2852',cues:[]}));
  pending.filter(item=>item.url.includes('nameplates?meetingId=2852')).at(-1).resolve({ok:false,status:404,json:async()=>({})}); await settle();
  assert.match(el('live-speaker-history-status').textContent,/아직 이름이 추정된 발언이 없습니다/);
  console.log('PASS: second polling, late response isolation, default selection, status, flags and export');
}
run().catch(error=>{console.error(error);process.exitCode=1});
