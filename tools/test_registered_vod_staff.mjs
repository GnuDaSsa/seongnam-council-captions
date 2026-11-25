import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {createSite} from '../worker/captions.mjs';
import {resolveVod,withPriorLiveStaffRoster,withPriorVodRoster} from '../worker/vod.mjs';
import speaker from '../dist/live-speaker.js';

const readData=async name=>JSON.parse(await readFile(new URL('../dist/data/'+name+'.json',import.meta.url),'utf8'));
const [index,rosters,registry]=await Promise.all(['vod-index','vod-rosters','registered-vod-staff'].map(readData));
const unprepared=index.meetings.find(row=>row.id==='5482');
const reference={vodId:'5418',sourceUrl:'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5418&position=71',
  registeredOn:'2026-08-28',position:71.44};
const prior=meeting=>withPriorVodRoster(meeting,rosters,registry);
const prepared=prior(unprepared);
const scheduleMs=Date.parse('2026-10-07T09:00:00+09:00');
const at=milliseconds=>new Date(scheduleMs+milliseconds).toISOString();
const asCue=(id,start,end,text)=>({id,meetingId:'5482',start,end,text,rawText:text,flags:[],observedAt:at(start*1000)});
const call=asCue('staff-call',21.69,26.09,'의회 사무국 김숙경 주무관 나오셔서 보고해 주시기 바랍니다.');
const intro=asCue('staff-intro',29.93,33.77,'안녕하십니까. 도시건설위원회 담당 김숙경입니다.');
const live={id:'3451',title:'도시건설위원회',label:'제1차 회의',scheduledAt:'2026-10-07T09:00:00+09:00',
  endsAt:'2026-10-07T11:00:00+09:00',
  officialPage:'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=3451',
  playlist:'https://cast.sncouncil.go.kr:4443/live/ch2.sdp/playlist.m3u8'};
const resolveRequest=id=>new Request('https://local.invalid/api/vod/resolve?id='+id);
const resolveIndex=new Map(index.meetings.map(meeting=>[meeting.id,meeting]));
resolveIndex.set('5418',{...unprepared,id:'5418',date:'2026-08-28'});

test('registered archive proof is earlier, same committee and term, unique, and separate from staff roster',async()=>{
  assert.equal(prepared.registeredVodStaffRoster[0].name,'김숙경');
  assert.equal(prepared.registeredVodStaffRoster[0].sourceUrl,reference.sourceUrl);
  assert.equal(prepared.staffRoster,undefined);
  assert.equal(prior({...unprepared,id:'5490',date:'2026-09-22'}).registeredVodStaffRoster?.length,1);
  for (const changed of [
    {id:'5418'}, {liveMeetingId:'5418'}, {date:'2026-08-28'}, {date:'2026-11-27'}, {date:'2030-07-01'},
    {title:'제1차 경제환경위원회'}, {playlist:unprepared.playlist.replace('A0006','A0004')},
    {members:['김숙경']}, {staffRoster:[{name:'다른이름'}]}
  ]) assert.equal(prior({...unprepared,...changed}).registeredVodStaffRoster,undefined);
  const row=registry.snapshots[0];
  for (const snapshots of [[row,row], [{...row,term:9}], [{...row,registryUrl:row.registryUrl.replace('A0006','A0004')}],
    [{...row,registeredOn:'2026-10-07'}], [{...row,sourceUrl:row.sourceUrl.replace('position=71','position=73')}],
    [{...row,sourceUrl:row.sourceUrl.replace('cast.sncouncil.go.kr','example.org')}],
    [{...row,officeEvidence:{...row.officeEvidence,text:'김숙경 과장 나오셔서 보고해 주시기 바랍니다.'}}]]) {
    assert.equal(withPriorVodRoster(prepared,rosters,{schemaVersion:1,snapshots}).registeredVodStaffRoster,undefined);
  }
  const neverFetch=()=>assert.fail('Indexed archive must not need a network request');
  const archive=await resolveVod(resolveRequest('5482'),neverFetch,resolveIndex,[],rosters,registry);
  const source=await resolveVod(resolveRequest('5418'),neverFetch,resolveIndex,[],rosters,registry);
  assert.equal(archive.status,200);
  assert.equal((await archive.json()).registeredVodStaffRoster[0].sourceUrl,reference.sourceUrl);
  assert.equal(source.status,200);
  assert.equal((await source.json()).registeredVodStaffRoster,undefined);
});

test('future live preparation accepts an exact official same-day scope and keeps the ASR roster empty',()=>{
  const enriched=withPriorLiveStaffRoster(live,rosters,'2026-10-07',live.title,registry);
  assert.equal(enriched.staffRoster,undefined);
  assert.equal(enriched.registeredVodStaffRoster?.[0].name,'김숙경');
  for (const bad of [{...live,title:'다른위원회'},{...live,officialPage:live.officialPage+'x'},
    {...live,scheduledAt:'2026-10-06T09:00:00+09:00'},{...live,endsAt:'2026-10-07T08:00:00+09:00'}])
    assert.equal(withPriorLiveStaffRoster(bad,rosters,'2026-10-07',live.title,registry),bad);
  const cues=[call,intro].map(cue=>({...cue,meetingId:live.id}));
  assert.equal(speaker.attribute(enriched,cues)[intro.id]?.name,'김숙경');
});

test('exact current intro is needed, role needs the matching current call, and original-source attribution cannot recurse',()=>{
  const candidate=(meeting,cues=[call,intro],gaps=[])=>speaker.attribute(meeting,cues,[],gaps)[intro.id];
  assert.equal(candidate(unprepared)?.name||'','');
  assert.deepEqual(candidate(prepared)?.registeredVodReference,reference);
  assert.deepEqual(candidate(prepared)?.evidence,[call.id,intro.id]);
  assert.equal(candidate(prepared)?.role,'주무관');
  assert.equal(candidate(prepared)?.confidence,'low');
  assert.equal(candidate(prepared,[intro])?.name,'김숙경');
  assert.equal(candidate(prepared,[intro])?.role,'');
  assert.equal(speaker.attribute(prepared,[call])[call.id]?.name||'','');
  for (const text of ['안녕하십니까. 김숙경입니다.','안녕하십니까. 경제환경위원회 담당 김숙경입니다.',
    '도시건설위원회 담당 김숙경이라고 소개했습니다.','“도시건설위원회 담당 김숙경입니다.”',
    '도시건설위원회 담당 김소경입니다.','질의가 있으십니까? 네, 도시건설위원회 담당 김숙경입니다.']) {
    assert.equal(candidate(prepared,[call,{...intro,text,rawText:text}])?.name||'','');
  }
  for (const change of [{rawText:'도시건설위원회 담당 김숙정입니다.'},{flags:['overlap']},{flags:['low_confidence']},
    {rejected:true},{end:30},{end:42.5}])
    assert.equal(candidate(prepared,[call,{...intro,...change}])?.name||'','');
  for (const meeting of [{...prepared,id:'5418'}, {...prepared,date:'2026-08-28'}, {...prepared,date:'2026-11-27'},
    {...prepared,title:'제1차 경제환경위원회'}])
    assert.equal(candidate(meeting)?.name||'','');
  assert.equal(candidate(prepared,[call,intro,asCue('overlap',31,34,'다른 음성')])?.name||'','');
  assert.equal(candidate(prepared,[call,intro],[{start:at(30000),end:at(31500)}])?.name||'','');
  const otherName=call.text.replace('김숙경','김소경');
  assert.equal(candidate(prepared,[{...call,text:otherName,rawText:otherName},intro])?.name||'','');
  const irrelevant=asCue('interruption',26.10,29.50,'잠시 준비해 주시기 바랍니다.');
  assert.equal(candidate(prepared,[call,irrelevant,intro])?.role,'');
});

test('personal archive name survives the canonical resolver even without ordinary roster data',async()=>{
  const script=await readFile(new URL('../dist/archive-player.js',import.meta.url),'utf8');
  const start=script.indexOf('function inferFromContext('), end=script.indexOf('function sourceLabel(',start);
  assert.ok(start>=0 && end>start);
  const attributeWith=meeting=>runInNewContext(script.slice(start,end)+'\ninferFromContext(cue,context,decision)',
    {window:{CouncilLiveSpeaker:speaker},meeting,attributionMeeting:null,cue:intro,context:[call,intro],decision:null});
  assert.equal(attributeWith(prepared)?.name,'김숙경');
  assert.deepEqual(attributeWith(prepared)?.registeredVodReference,reference);
  assert.equal(attributeWith(unprepared)?.name||'','');
});

test('a forewarned list of officials blocks a third-person statement in both prior source paths',()=>{
  const setup=asCue('setup',23.5,26.7,'설명이 앞서 의회 사무국 감보 공무원을 소개해 드리겠습니다.');
  const firstListing=asCue('listed',27,29,'다음은 의회사무과장 최필규입니다.');
  const plain=asCue(intro.id,intro.start,intro.end,'도시건설위원회 담당 김숙경입니다.');
  const historical={...unprepared,staffRoster:[{name:'김숙경',role:'도시건설위원회 담당',officialRole:'주무관',
    roleBasis:'recorded-self-introduction',committee:'도시건설위원회',basis:'official-recorded-committee-contact',
    source:'https://www.sncouncil.go.kr/record/recordView.do?key=123abc',candidateOnly:true}]};
  for (const source of [prepared,historical]) {
    const candidate=cues=>speaker.attribute(source,cues)[intro.id]?.name||'';
    assert.equal(candidate([plain]),'김숙경');
    assert.equal(candidate([setup,firstListing,plain]),'');
    const secondExample='총괄 설명에 앞서 과장을 소개해 드리겠습니다.';
    assert.equal(candidate([{...setup,text:secondExample,rawText:secondExample},firstListing,plain]),'');
    assert.equal(candidate([setup,firstListing,intro]),'');
    const firstPerson='안녕하십니까. 저는 도시건설위원회 담당 김숙경입니다.';
    assert.equal(candidate([setup,firstListing,{...intro,text:firstPerson,rawText:firstPerson}]),'김숙경');
    const close=asCue('end-list',27,29,'이상으로 간부 소개를 마치겠습니다.');
    assert.equal(candidate([setup,close,intro]),'김숙경');
    const move=(row,start,end)=>({...row,start,end,observedAt:at(start*1000)});
    assert.equal(candidate([move(setup,16,19),move(firstListing,19.1,21.1),call,intro]),'김숙경');
    const wrongName=call.text.replace('김숙경','김소경');
    assert.equal(candidate([move(setup,16,19),move(firstListing,19.1,21.1),{...call,text:wrongName,rawText:wrongName},intro]),'');
  }
});

test('a signed live batch retains the same guarded result and provenance in captions and minutes',async()=>{
  const meeting={...prepared,scheduledAt:at(0),endsAt:at(7200000)}, {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const objects=new Map(), revision={value:0}, clock=Date.parse(at(35000));
  const worker=createSite({assets:{},meetings:[meeting],publicKey:publicKey.export({format:'jwk'}).x,
    attributeSpeakers:speaker.attribute},()=>clock);
  const env={BUCKET:{
    async get(key){ return objects.get(key); },
    async put(key,body,options={}){
      const entry={body,etag:String(++revision.value),customMetadata:options.customMetadata};
      objects.set(key,entry);
      return entry;
    }
  }};
  const route=kind=>'https://local.invalid/api/live/'+kind+'?meetingId=5482';
  const body=JSON.stringify({meetingId:'5482',status:'live',updatedAt:at(35000),cues:[call,intro]});
  const headers={'X-Council-Signature':sign(null,Buffer.from(body),privateKey).toString('base64url')};
  const saved=await worker.fetch(new Request(route('captions'),{method:'PUT',headers,body}),env);
  assert.equal(saved.status,204,await saved.text());
  for (const kind of ['captions','minutes']) {
    const response=await worker.fetch(new Request(route(kind)),env);
    assert.equal(response.status,200);
    const {cues}=await response.json(), attributed=cues.find(cue=>cue.id===intro.id);
    assert.equal(attributed.rawText,intro.rawText);
    assert.equal(attributed.speaker.name,'김숙경');
    assert.deepEqual(attributed.speaker.registeredVodReference,reference);
    assert.equal(cues.find(cue=>cue.id===call.id).speaker?.name||'','');
  }
});
