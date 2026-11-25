import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {createSite} from '../worker/captions.mjs';
import liveSpeaker from '../dist/live-speaker.js';

const keys = generateKeyPairSync('ed25519');
const now = Date.parse('2026-11-25T05:30:00Z');
const meetings = [
  {id:'2853', members:['조우현','정연화'], scheduledAt:'2026-11-25T04:30:00Z', endsAt:'2026-11-25T14:59:59Z'},
  {id:'2852', members:['김보석','선창선'], scheduledAt:'2026-11-25T04:30:00Z', endsAt:'2026-11-25T14:59:59Z'},
  {id:'plenary',title:'제315회 제1차 본회의',members:['추선미','김보석'],scheduledAt:'2026-11-25T04:30:00Z',endsAt:'2026-11-25T14:59:59Z'},
];
const at = n => new Date(now+n).toISOString();
function setup({failNameplates=false,meetingRows=meetings}={}) {
  const objects = new Map();
  const pageReads = [];
  const BUCKET = {
    async get(key) {
      if (failNameplates && key.startsWith('council-nameplates/')) throw Error('OCR storage unavailable');
      if (key.startsWith('council-pages/')) pageReads.push(key);
      return objects.get(key);
    },
    async put(key, body, options) {
      const old=objects.get(key);
      if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== old?.etag) return null;
      if (options.onlyIf instanceof Headers && options.onlyIf.get('if-none-match') === '*' && old) return null;
      const value={body,etag:String((Number(old?.etag)||0)+1),customMetadata:options.customMetadata};
      objects.set(key,value); return value;
    }
  };
  const site=createSite({assets:{},meetings:meetingRows,publicKey:keys.publicKey.export({format:'jwk'}).x,attributeSpeakers:liveSpeaker.attribute,
    validateAcousticProof:liveSpeaker.acousticProof,validatePodiumProof:liveSpeaker.podiumProof},()=>now);
  async function request(path,id,value) {
    const url=`https://example.org/api/live/${path}?meetingId=${id}`;
    const body=value === undefined ? undefined : JSON.stringify(value);
    const headers=body === undefined ? {} : {'X-Council-Signature':sign(null,Buffer.from(body),keys.privateKey).toString('base64url')};
    return site.fetch(new Request(url,{method:body === undefined ? 'GET' : 'PUT',headers,body}),{BUCKET});
  }
  return {request,objects,pageReads};
}
const cue=(id,start,text,extra={})=>({id:String(id),start,end:start+1,text,rawText:text,flags:[],...extra});
const snapshot=(id,cues,offset=0)=>({meetingId:id,updatedAt:at(offset),status:'live',cues});
async function put(request,path,id,data) { const r=await request(path,id,data); assert.equal(r.status,204,await r.text()); }
async function get(request,path,id) { const r=await request(path,id); assert.equal(r.status,200,await r.clone().text()); return r.json(); }

test('signed caption and nameplate writes: call is not caller identity; intro and minutes are attributed',async()=>{
  const {request}=setup();
  await put(request,'nameplates','2853',{meetingId:'2853',updatedAt:at(0),observations:[{capturedAt:at(-1000),matchedMembers:['조우현']}]});
  const cues=[cue('call',0,'조우현 의원님 질의해 주시기 바랍니다.'),cue('intro',1.5,'조우현 의원입니다.')];
  await put(request,'captions','2853',snapshot('2853',cues));
  for (const path of ['captions','minutes']) {
    const rows=(await get(request,path,'2853')).cues;
    assert.notEqual(rows[0].speaker?.name,'조우현');
    assert.equal(rows[1].speaker?.name,'조우현');
    assert.equal(rows[1].speaker?.role,'의원');
  }
});

test('a same-office follow-up backfills its unfinished preceding question and a correction removes it',async()=>{
  const {request}=setup();
  // Excerpt from the 25 November administration committee live capture, before any official minutes.
  const turn=[
    cue('1795587268636517422',6523.921,'네, 선창선 의원님 말씀해 주십시오.',{end:6525.921}),
    cue('1795587268636517423',6525.921,'안녕하십니까, 선창선 의원입니다.',{end:6527.931}),
    cue('1795587268636517424',6527.931,'공보관님, 저희가 공보관을 개방형 지위로 지금 전환한 지가 2022년인데',{end:6534.931}),
    cue('1795587268636517425',6534.931,'지금 공보관님은 어떤 개방형 공보관이십니까? 아니면 일반 임기주의 개방형이십니까?',{end:6539.931}),
    cue('1795587268636517426',6539.931,'저는 일반 행정직 공보관입니다.',{end:6541.791})
  ].map(row=>({...row,observedAt:at((row.start-6523.921)*1000-20000)}));
  await put(request,'captions','2852',snapshot('2852',turn.slice(0,3)));
  assert.equal((await get(request,'captions','2852')).cues[2].speaker?.name || '', '');
  await put(request,'captions','2852',snapshot('2852',turn,1));
  for(const path of ['captions','minutes']){
    const rows=(await get(request,path,'2852')).cues;
    assert.notEqual(rows[0].speaker?.name,'선창선');
    assert.equal(rows[2].speaker?.name,'선창선');
    assert.equal(rows[3].speaker?.name,'선창선');
    assert.deepEqual(rows[2].speaker.evidence,turn.slice(1,4).map(row=>row.id));
    assert.notEqual(rows[4].speaker?.name,'선창선');
  }
  const changed={...turn[3],text:'지금 감사관님은 어떻게 생각하세요?'};
  await put(request,'captions','2852',snapshot('2852',[...turn.slice(0,3),changed,turn[4]],2));
  assert.equal((await get(request,'minutes','2852')).cues[2].speaker?.name || '', '');
  for(const hazard of ['mixed','overlap','audio_gap','segment_review']){
    const flagged=turn.map((row,i)=>i===3?{...row,flags:[hazard]}:row);
    assert.equal(liveSpeaker.attribute(meetings[1],flagged)[turn[2].id]?.name || '', '',hazard);
  }
  const mixed={...turn[3],text:'지금 공보관님은 일반 임기제이십니까? 네, 맞습니다.'};
  assert.equal(liveSpeaker.attribute(meetings[1],[...turn.slice(0,3),mixed])[turn[2].id]?.name || '', '');
  assert.equal(liveSpeaker.attribute(meetings[1],turn.slice(2))[turn[2].id]?.name || '', '','start without the introduction');
  const breaks=[{start:at(-13000),end:at(-11000)}];
  assert.equal(liveSpeaker.attribute(meetings[1],turn,[],breaks)[turn[2].id]?.name || '', '');
});

test('same cue correction removes sender supplied speaker and stale attribution in captions and minutes',async()=>{
  const {request}=setup();
  await put(request,'captions','2853',snapshot('2853',[cue('a',0,'조우현 의원입니다.')]));
  assert.equal((await get(request,'captions','2853')).cues[0].speaker?.name,'조우현');
  await put(request,'captions','2853',snapshot('2853',[cue('a',0,'자료를 제출해 주세요.',{speaker:{name:'조우현',role:'의원'}})],1));
  for (const path of ['captions','minutes']) {
    const row=(await get(request,path,'2853')).cues[0];
    assert.equal(row.text,'자료를 제출해 주세요.');
    assert.equal(row.speaker,undefined);
  }
});

test('known minutes re-evaluate sealed and recovered labels while unknown archives keep legacy labels',async()=>{
  const {request,objects}=setup(), id='2853', unknownId='1414';
  const oldSpeaker={name:'조우현',role:'의원',method:'이전 자동 추정'};
  const stale=cue('stale',0,'자료를 제출해 주세요.',{speaker:oldSpeaker});
  const recovered=cue('recovered',1,'답변을 확인하겠습니다.',{speaker:oldSpeaker});
  const page='council-pages/'+id+'/legacy';
  objects.set(page,{body:JSON.stringify([stale])});
  objects.set('council-captions/'+id+'.json',{body:JSON.stringify({
    ...snapshot(id,[cue('intro',2,'조우현 의원입니다.')]), pages:[page], gaps:[],
  })});
  for (const meetingId of [id,unknownId]) {
    objects.set('council-recovered/'+meetingId,{body:JSON.stringify({updatedAt:at(0),cues:[recovered],gaps:[]})});
  }
  const current=await get(request,'minutes',id);
  assert.equal(current.speakerAttributionApplied,true);
  assert.deepEqual(current.cues.map(cue=>[cue.id,cue.speaker?.name]),[
    ['stale',undefined],['recovered',undefined],['intro','조우현'],
  ]);
  const legacy=await get(request,'minutes',unknownId);
  assert.equal(legacy.speakerAttributionApplied,undefined);
  assert.deepEqual(legacy.cues[0].speaker,oldSpeaker);
});

test('meeting context and roster do not leak across channels',async()=>{
  const {request}=setup();
  await put(request,'captions','2853',snapshot('2853',[cue('a',0,'조우현 의원님 질의해 주시기 바랍니다.')]));
  await put(request,'captions','2852',snapshot('2852',[cue('b',1.5,'조우현 의원입니다.')]));
  assert.notEqual((await get(request,'captions','2852')).cues[0].speaker?.name,'조우현');
  assert.equal((await get(request,'minutes','2853')).cues.length,1);
});

test('sealed 100 cue page keeps preceding call as context for subsequent answer',async()=>{
  const {request}=setup();
  const cues=Array.from({length:200},(_,i)=>cue(i,i*2,i===99?'조우현 의원님 질의해 주시기 바랍니다.':i===100?'예산 편성 내역을 확인하겠습니다.':'회의를 진행합니다.'));
  await put(request,'captions','2853',snapshot('2853',cues));
  const live=(await get(request,'captions','2853')).cues;
  assert.equal(live.length,100);
  assert.equal(live[0].id,'100');
  assert.equal(live[0].speaker?.name,'조우현');
  assert.ok(live[0].speaker.evidence.includes('99'));
  const minutes=(await get(request,'minutes','2853')).cues;
  assert.equal(minutes.length,200);
  assert.equal(minutes[100].speaker?.name,'조우현');
});

test('signed acoustic chain is revalidated from the named intro after page sealing and on a corrected tail',async()=>{
  const {request}=setup(), id='2853', sessionId='a'.repeat(32), proof={policy:'same-session-1',sessionId};
  const rows=Array.from({length:200},(_,i)=>cue(i,i*4,'회의를 진행합니다.',{end:(i+1)*4,observedAt:at(i*4000)}));
  rows[99]={...rows[99],text:'조우현 의원입니다.',rawText:'조우현 의원입니다.',audioAnchor:proof};
  const text='예산 사업에 들어가는 비용을 다시 계산했습니다.';
  rows[100]={...rows[100],text,rawText:text,audioContinuation:{...proof,anchorId:'99',previousId:'99'}};
  await put(request,'captions',id,snapshot(id,rows));
  for (const path of ['captions','minutes']) {
    const row=(await get(request,path,id)).cues.find(c=>c.id==='100');
    assert.equal(row.speaker?.name,'조우현'); assert.deepEqual(row.speaker.evidence,['99','100']);
  }
  await put(request,'captions',id,snapshot(id,[{...rows[100],audioContinuation:{...rows[100].audioContinuation,sessionId:'b'.repeat(32)},speaker:{name:'조우현'}}],1));
  for (const path of ['captions','minutes']) {
    const row=(await get(request,path,id)).cues.find(c=>c.id==='100');
    assert.equal(row.speaker,undefined);
  }
});

test('publisher cannot supply names or numeric feature arrays as acoustic evidence',async()=>{
  const {request}=setup(),id='2853', base={policy:'same-session-1',sessionId:'a'.repeat(32)};
  for (const data of [{audioAnchor:{...base,name:'조우현'}},{audioAnchor:{...base,vector:[1]}},
      {audioAnchor:base,audioContinuation:{...base,anchorId:'9',previousId:'10'}},{audioAnchor:[]},
      {audioContinuation:{...base,previousId:'0'}},{audioAnchor:null}]) {
    const res=await request('captions',id,snapshot(id,[cue('11',11,'회의 중입니다.',data)]));
    assert.equal(res.status,400);
  }
});

test('signed plenary evidence requires a named call, matching introduction and a second voice sample from the same sitting',async()=>{
  const {request}=setup(), sessionId='a'.repeat(32), policy='plenary-floor-1';
  const proof=(stage,refs={})=>({stage,policy,sessionId,...refs});
  const voice=(id,start,end,text,evidence)=>cue(id,start,text,{end,observedAt:at((start-625)*1000),
    ...(evidence?{audioPodium:evidence}:{})});
  const call=voice('p-call',565.18,571.68,'다음은 추선미 의원님 나오셔서 발언해 주시기 바랍니다.',proof('call'));
  const intro=voice('p-intro',590.85,593.39,'안녕하십니까, 추선미 의원입니다.',proof('intro',{callId:call.id}));
  const confirm=voice('p-confirm',593.39,595.95,'여기 사진 한 장이 있습니다.',proof('confirm',{callId:call.id,anchorId:intro.id}));
  const brief=voice('p-short',595.95,599.63,'안양시의 모습입니다.');
  const matched=voice('p-ongoing',604,609,'지금 보시는 장면은 우리 시민들의 실제 생활 모습입니다.',
    proof('match',{callId:call.id,anchorId:intro.id,confirmationId:confirm.id}));
  const rows=[call,intro,confirm,brief,matched];
  const verify=(group,meeting=meetings[2],gaps=[])=>liveSpeaker.attribute(meeting,group,[],gaps)[matched.id]?.name || '';
  await put(request,'captions','plenary',snapshot('plenary',rows));
  for(const path of ['captions','minutes']){
    const stored=(await get(request,path,'plenary')).cues;
    assert.equal(stored[0].speaker?.name,'');
    assert.equal(stored[0].speaker?.role,'의사진행자');
    assert.equal(stored[1].speaker?.name,'추선미');
    assert.equal(stored[2].speaker?.name,'추선미');
    assert.equal(stored[3].speaker?.name || '','');
    assert.equal(stored[4].speaker?.name,'추선미');
    assert.equal(stored[4].speaker.confidence,'low');
    assert.deepEqual(stored[4].speaker.evidence,[call.id,intro.id,confirm.id,matched.id]);
  }
  const handover='김보석 의원님 수고하셨습니다. '+call.text;
  assert.equal(verify([{...call,text:handover,rawText:handover},...rows.slice(1)]),'추선미');
  for(const prefix of ['다른 사람이 이렇게 말했습니다. ','아무개 의원님 수고하셨습니다. ','추선미 의원님 수고하셨습니다. ']){
    const text=prefix+call.text;
    assert.equal(verify([{...call,text,rawText:text},...rows.slice(1)]),'',prefix);
  }
  assert.equal(verify(rows.slice(1)),'','fresh seek without the call');
  assert.equal(verify([call,intro,brief,matched]),'','second sample is required');
  assert.equal(verify(rows,{...meetings[2],title:'도시건설위원회'}),'','committee questions cannot activate a plenary speech');
  assert.equal(verify(rows,{...meetings[2],members:['김보석']}),'','the caller and intro must match a unique member');
  assert.equal(verify(rows,{...meetings[2],members:['추선미','추선미']}),'');
  assert.equal(verify(rows,meetings[2],[{start:at(-31_000),end:at(-30_000)}]),'','capture gap');
  const alternate=(index,changes)=>rows.map((row,i)=>i===index?{...row,...changes}:row);
  for(const [index,changes] of [
    [0,{end:call.start+3.49}],
    [0,{text:'김보석 의원님 나오셔서 발언해 주시기 바랍니다.',rawText:'김보석 의원님 나오셔서 발언해 주시기 바랍니다.'}],
    [1,{rawText:'안녕하십니까, 다른 의원입니다.'}],
    [2,{audioPodium:{...confirm.audioPodium,sessionId:'b'.repeat(32)}}],
    [3,{text:'김보석 의원님 수고하셨습니다.'}],
    [3,{text:'의장님, 잠깐만요.'}],
    [3,{flags:['mixed']}],
    [4,{start:612.1,end:617,observedAt:at(-12900)}],
    [4,{observedAt:at(-16000)}],
    [4,{audioPodium:{...matched.audioPodium,confirmationId:'missing'}}]
  ]) assert.equal(verify(alternate(index,changes)),'',JSON.stringify(changes));
  for(const invalid of [
    {...matched.audioPodium,name:'추선미'}, {...matched.audioPodium,vector:[0.9]}, {...matched.audioPodium,stage:'other'},
    {...matched.audioPodium,callId:confirm.id}, {...matched.audioPodium,stage:'intro'}, {...matched.audioPodium,anchorId:'__proto__'}
  ]){
    const res=await request('captions','plenary',snapshot('plenary',alternate(4,{audioPodium:invalid})));
    assert.equal(res.status,400);
  }
  const changed={...call,text:'다음은 김보석 의원님 나오셔서 발언해 주시기 바랍니다.',rawText:'다음은 김보석 의원님 나오셔서 발언해 주시기 바랍니다.'};
  await put(request,'captions','plenary',snapshot('plenary',[changed,...rows.slice(1)],1));
  assert.equal((await get(request,'minutes','plenary')).cues.at(-1).speaker?.name || '','');
});

test('unavailable OCR storage leaves text attribution available',async()=>{
  const {request}=setup({failNameplates:true});
  await put(request,'captions','2853',snapshot('2853',[cue('intro',0,'조우현 의원입니다.')]));
  assert.equal((await get(request,'captions','2853')).cues[0].speaker?.name,'조우현');
});

test('an empty camera reading and the last recognized name have separate timestamps',async()=>{
  const {request}=setup();
  const lastMatch={capturedAt:at(-5000),matchedMembers:['조우현']};
  const latest={capturedAt:at(-1000),matchedMembers:[]};
  await put(request,'nameplates','2853',{meetingId:'2853',updatedAt:at(0),observations:[lastMatch,latest]});
  await put(request,'captions','2853',snapshot('2853',[cue('a',0,'자료를 주세요.')]));
  const result=await get(request,'captions','2853');
  assert.deepEqual(result.nameplateStatus,{latest,lastMatch});
  assert.equal(result.cues[0].speaker,undefined);
});

test('an ongoing meeting restores the introduction sealed before a legacy eight-cue context',async()=>{
  const {request,objects}=setup(), id='2853';
  await put(request,'nameplates',id,{meetingId:id,updatedAt:at(0),observations:[{capturedAt:at(-102000),matchedMembers:['조우현']}]});
  const rows=Array.from({length:200},(_,i)=>cue(i,2*i,i===12?'조우현 의원입니다.':i===150?'소장님, 언제 완공되나요?':'자료를 보겠습니다.',{observedAt:at((i*2-400)*1000)}));
  await put(request,'captions',id,snapshot(id,rows));
  const saved=objects.get('council-captions/'+id+'.json'), state=JSON.parse(saved.body);
  state.speakerContext=state.speakerContext.slice(-8); delete state.speakerContextSize;
  saved.body=JSON.stringify(state);
  const live=await get(request,'captions',id);
  assert.equal(live.cues.find(c=>c.id==='150').speaker.name,'조우현');
  assert.equal(live.cues.length,100);
});

test('the actual 2853 oath retains its original evidence across sealing and legacy migration',async()=>{
  const id='2853', meeting={...meetings[0],title:'경제환경위원회',label:'행정사무감사 제1일차',
    staffRoster:[{name:'이종빈',role:'푸른도시사업소장',appointedOn:'2026-07-20',
      source:'https://www.sncouncil.go.kr/record/recordView.do?key=483791be148a634445c8aa53fadd5e6ef18d2f8fee9b7163fcc2a988441a058562a87a7edbd766e4'}]};
  const {request,objects,pageReads}=setup({meetingRows:[meeting]});
  // Same four signed raw capture rows and clocks as the 25 November afternoon oath.
  // Padding rows only move the evidence to a deterministic storage-page boundary.
  const rows=[
    ['1795587268650154355',11074.993,11085.653,'08:32:27.387','그러면 이종빈 부른 도시 사업소장님과 각 과장님께서는 앞으로 나오셔서 선서를 하여 주시기 바랍니다.',[]],
    ['1795587268650154356',11092.333,11111.283,'08:32:44.727','선서 본인은 지방자 집법 제49조와 성남시의 행정 사무감사 및 조사에 관한 조례 제12조의 규정에 의하여 2026년도 행정 사무감사를 실시함에 있어 성실하게 감사를 받을 것이며 양심에 따라 거짓없이 진술할 것이며',['number']],
    ['1795587268650154357',11111.293,11113.893,'08:33:03.687','이것을 소약하고 이에 선서합니다.',[]],
    ['1795587268650154358',11113.893,11118.733,'08:33:06.287','2026년 11월 25일 성남시 푸른 도시 사업소장 이종빈',['number']],
  ].map(([id,start,end,time,text,flags])=>cue(id,start,text,{end,observedAt:'2026-11-25T'+time+'Z',flags}));
  const signature=rows.at(-1);
  const expectedSpeaker=async path=>(await get(request,path,id)).cues.find(c=>c.id===signature.id)?.speaker;
  const padding=Array.from({length:497},(_,i)=>cue('before-'+i,10000+i*2,'자료를 보겠습니다.'));
  await put(request,'captions',id,snapshot(id,[...padding,...rows]));
  const baseline=await expectedSpeaker('captions');
  assert.deepEqual([baseline?.name,baseline?.role,baseline?.evidence],['이종빈','푸른도시사업소장',rows.map(row=>row.id)]);
  await put(request,'captions',id,snapshot(id,Array.from({length:99},(_,i)=>cue('after-'+i,11120+2*i,'자료를 보겠습니다.')),1));
  const key='council-captions/'+id+'.json';
  const saved=objects.get(key), state=JSON.parse(saved.body);
  assert.equal(state.pages.length,5);
  assert.equal(state.speakerContext.length,400);
  assert.deepEqual(state.speakerContext.slice(-3).map(row=>row.rawText),rows.slice(0,-1).map(row=>row.rawText));
  pageReads.length=0;
  assert.deepEqual(await expectedSpeaker('captions'),baseline);
  assert.deepEqual(pageReads,[],'current cache avoids reading sealed pages');
  assert.deepEqual(await expectedSpeaker('minutes'),baseline);

  delete state.speakerContextVersion;
  for(const cached of state.speakerContext) delete cached.rawText;
  state.speakerContext.at(-1).text='수집 원문이 없는 이전 캐시';
  saved.body=JSON.stringify(state);
  pageReads.length=0;
  assert.deepEqual(await expectedSpeaker('captions'),baseline);
  assert.deepEqual(pageReads,state.pages.slice(-4),'migration reads only the four latest immutable pages');

  // If an old object is unavailable, use only the available source evidence.
  const lastPage=state.pages.at(-1), unavailable=objects.get(lastPage);
  objects.delete(lastPage);
  assert.equal(await expectedSpeaker('captions'),undefined);
  assert.equal((await request('minutes',id)).status,503);
  await put(request,'captions',id,snapshot(id,[],2));
  assert.equal(JSON.parse(objects.get(key).body).speakerContextVersion,0,'partial context remains eligible to retry');
  objects.set(lastPage,unavailable);
  await put(request,'captions',id,snapshot(id,[],3));
  const migrated=JSON.parse(objects.get(key).body);
  assert.ok(migrated.speakerContextVersion>0);
  assert.deepEqual(migrated.speakerContext.slice(-3).map(row=>row.rawText),rows.slice(0,-1).map(row=>row.rawText));
  assert.deepEqual(await expectedSpeaker('captions'),baseline);
  assert.deepEqual(await expectedSpeaker('minutes'),baseline);
});

test('a sealed introduced-staff list still vetoes a synthetic role-first name reading',async()=>{
  const id='2853', meeting={...meetings[0],title:'경제환경위원회',staffRoster:[{name:'장미라',role:'자원순환과장',
    source:'https://www.sncouncil.go.kr/record/recordView.do?key=1234abcd'}]};
  const {request,objects}=setup({meetingRows:[meeting]});
  const rows=Array.from({length:200},(_,i)=>cue(i,3*i,'자료를 보겠습니다.'));
  rows[98]=cue(98,294,'환경보건국 간부 공무원을 소개해 드리겠습니다.');
  rows[99]=cue(99,297,'유성희 환경정책과장입니다.');
  rows[100]=cue(100,300,'자원순환과장 장미라입니다.');
  assert.equal(liveSpeaker.attribute(meeting,[rows[100]])['100'].name,'장미라','isolated cue would be misattributed');
  await put(request,'captions',id,snapshot(id,rows));
  async function assertVetoed() {
    for(const path of ['captions','minutes']) {
      const row=(await get(request,path,id)).cues.find(item=>item.id==='100');
      assert.ok(row);
      assert.equal(row.speaker,undefined,path);
    }
  }
  await assertVetoed();
  const saved=objects.get('council-captions/'+id+'.json'), state=JSON.parse(saved.body);
  delete state.speakerContextVersion;
  for(const cached of state.speakerContext) delete cached.rawText;
  saved.body=JSON.stringify(state);
  await assertVetoed();
});
