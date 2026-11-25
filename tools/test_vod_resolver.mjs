import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolveVod,resolveVodTranscript,withPriorVodRoster,withPriorLiveStaffRoster} from '../worker/vod.mjs';
import liveSpeaker from '../dist/live-speaker.js';

const request=(id='5482')=>new Request('https://example.invalid/api/vod/resolve?id='+id);
const player=(folder='A0006/',file='20261008140254947.mp4')=>`player("/skin.xml", "mp4:", "${folder}", "${file}", "host");`;
const page=(inside=player())=>`<div class="play_area"><h3> 제1차 도시건설위원회 [2026.10.7 수] </h3></div><script>${inside}</script>`;
const fetchHtml=html=>async(url,opts)=>{
  assert.equal(url,'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5482&position=0');
  assert.equal(opts.redirect,'manual'); assert.equal(opts.method,'GET'); assert.ok(opts.signal);
  return new Response(html,{status:200});
};
let response=await resolveVod(request(),fetchHtml(page()));
assert.equal(response.status,200);
const indexedRow=await response.clone().json();
const staticIndex=new Map([[indexedRow.id,indexedRow]]);
const offline=()=>{throw Error('offline')};
assert.deepEqual(await (await resolveVod(request(),offline,staticIndex)).json(),indexedRow);
assert.equal((await resolveVod(request('999999'),offline,staticIndex)).status,502);
assert.deepEqual(await response.json(),{
  id:'5482',title:'제1차 도시건설위원회',date:'2026-10-07',
  officialPage:'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5482&position=0',
  playlist:'https://cast.sncouncil.go.kr:4443/vod/_definst_/mp4:A0006/20261008140254947.mp4/playlist.m3u8',
  members:[],cues:[]
});
response=await resolveVod(request(),fetchHtml(player()));
assert.equal((await response.json()).title,'성남시의회 회의 5482');
for(const id of ['abc','-1','0','001','123456789','5482%26x%3D1']){
  let called=false; response=await resolveVod(request(id),async()=>{called=true;});
  assert.equal(response.status,400,id); assert.equal(called,false,id);
}
response=await resolveVod(new Request('https://example.invalid/api/vod/resolve?id=5482&id=1'),fetchHtml(page()));
assert.equal(response.status,400);
response=await resolveVod(new Request('https://example.invalid/api/vod/resolve?id=5482',{method:'POST'}),fetchHtml(page()));
assert.equal(response.status,405);
for(const body of ['',page(player('../../','evil.mp4')),page(player('A0006/','../evil.mp4')),page(player()+player())]){
  response=await resolveVod(request(),fetchHtml(body)); assert.equal(response.status,404);
}
response=await resolveVod(request(),async()=>new Response('',{status:302,headers:{Location:'https://evil.invalid/'}}));
assert.equal(response.status,502);
response=await resolveVod(request(),async()=>new Response('',{status:404})); assert.equal(response.status,404);
response=await resolveVod(request(),async()=>{throw new Error('offline')}); assert.equal(response.status,502);
response=await resolveVod(request(),async()=>{throw new DOMException('aborted','AbortError')}); assert.equal(response.status,504);
response=await resolveVod(request(),async()=>new Response('x'.repeat(1024*1024+1),{status:200})); assert.equal(response.status,502);
console.log('PASS VOD validation, official fixed URL, metadata, bounds, redirects and failures');

{
  const sitting={id:'2855',scheduledAt:'2026-10-07T09:30:00+09:00',title:'도시건설위원회',label:'행정사무감사 제1일차',
    agenda:['도시주택국','건축과'],members:['김가나'],memberSource:'https://www.sncouncil.go.kr/committee/C085/main.do',staffRoster:[]};
  const actual=page()+'<div class="confer_view">□ 도시건설위원회 행정사무감사 제1일차<br/>【도시주택국】<br/> • 건축과</div>';
  const resolve=(html,sittings)=>resolveVod(request(),fetchHtml(html),undefined,sittings).then(res=>res.json());
  const linked=await resolve(actual,[sitting]);
  assert.equal(linked.liveMeetingId,'2855'); assert.deepEqual(linked.members,['김가나']);
  for (const [html,manifest] of [
    [actual.replace('□ 도시건설위원회','□ 행정교육위원회'),[sitting]],
    [actual.replace('제1일차','제2일차'),[sitting]],
    [actual.replace('• 건축과','• 주택과'),[sitting]],
    [actual.replace('2026.10.7','2026.10.8'),[sitting]],
    [actual,[sitting,{...sitting,id:'999'}]],
    [actual,[]]
  ]) assert.equal((await resolve(html,manifest)).liveMeetingId,undefined);
  const {cues,...record}=linked;
  assert.deepEqual(await (await resolveVod(request(),offline,new Map([[record.id,record]]))).json(),linked);
}

{
  const readData=async name=>JSON.parse(await readFile(new URL('../dist/data/'+name,import.meta.url),'utf8'));
  const rosters=await readData('vod-rosters.json'), index=await readData('vod-index.json');
  const pastPage='<div class="play_area"><h3>제2차 본회의 [2026.4.22 수]</h3></div>'+
    '<script>getTimelineList(5398);'+player('A0001/','20260422144119774.mp4')+'</script>';
  const fetchPast=html=>async url=>{
    assert.equal(url,'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5398&position=0');
    return new Response(html);
  };
  const resolvePast=async html=>(await resolveVod(request('5398'),fetchPast(html),undefined,[],rosters)).json();
  const older=await resolvePast(pastPage);
  assert.equal(older.members.length,33);
  assert.ok(older.members.includes('황금석'));
  assert.equal(older.memberSource,rosters.snapshots.find(row=>row.sourceDate==='2026-03-18').sourceUrl);
  assert.deepEqual(older.memberRoster,{
    basis:'official-final-minutes-attendance',body:'본회의',term:9,sourceDate:'2026-03-18',sessionEnd:'2026-03-18',
    sessionEndSourceUrl:older.memberSource,availableFrom:'2026-04-18',availabilityBasis:'final-record-publication-allowance-plus-one-day',
    availabilityRuleSource:rosters.availabilityRuleSource,candidateOnly:true
  });
  const recognized=text=>({id:'cue',start:1,end:3,text,rawText:text});
  assert.equal(liveSpeaker.attribute(older,[recognized('저는 황금석 의원입니다.')]).cue?.name,'황금석');
  for (const text of ['황금석 의원님 발언해 주십시오.','황금석 의원이 제출한 자료를 보겠습니다.',
    '황금석 의원을 부위원장으로 추천합니다.','교통 문제를 설명하겠습니다.']) {
    assert.equal(liveSpeaker.attribute(older,[recognized(text)]).cue?.name || '', '');
  }
  const officialTurn='<span id="contents_title_0">○의장 안광림</span>'+
    '<span id="contents_view_0">성원이 되었으므로 개의하겠습니다.</span>';
  assert.deepEqual((await resolvePast(pastPage+officialTurn)).members,[]);
  assert.equal((await resolvePast(pastPage.replace('getTimelineList(5398)','getTimelineList(5547)')+officialTurn)).members.length,33);

  const rows=new Map(index.meetings.map(row=>[row.id,row]));
  for (const [id,body,expected,other] of [
    ['5545','의회운영위원회','정봉규','김선임'],
    ['5546','문화복지체육위원회','윤혜선','김선임'],
    ['5547','행정교육위원회','김선임','윤혜선'],
  ]) {
    const meeting=await (await resolveVod(request(id),offline,rows,[],rosters)).json();
    assert.equal(meeting.memberRoster?.body,body);
    assert.equal(meeting.memberRoster?.term,10);
    assert.equal(meeting.memberRoster?.sourceDate,'2026-10-07');
    assert.ok(meeting.members.includes(expected) && !meeting.members.includes(other));
  }
  const earlyAdmin={...rows.get('5547'),date:'2026-11-20'};
  const {memberRoster,memberSource,...base}={...older,members:[]};
  for (const meeting of [
    {...base,date:'2026-04-18'}, {...base,date:'2026-03-17'}, {...base,date:'2026-06-17'},
    {...base,date:'2026-07-01'}, {...base,date:null}, {...base,date:'2026-04-31'},
    {...base,title:'본회의 일반 행사'}, {...base,title:'제1차 행정교육위원회'},
    {...base,speakerTranscript:true}, {...base,liveMeetingId:'2855'}, earlyAdmin,
  ]) assert.strictEqual(withPriorVodRoster(meeting,rosters),meeting);
  const source=rosters.snapshots.find(row=>row.term===9);
  for (const snapshots of [[source,source],[{...source,members:['황금석','황금석']}],
    [{...source,availableFrom:'2026-03-21'}],[{...source,sourceUrl:'https://example.invalid'}]]) {
    assert.strictEqual(withPriorVodRoster(base,{...rosters,snapshots}),base);
  }
  assert.equal(withPriorVodRoster({...base,date:'2026-06-16'},rosters).members.length,33);
  const cast5418='https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5418&position=0';
  const cityPage='<div class="play_area"><h3>제1차 도시건설위원회 [2026.8.28 금]</h3></div>'+
    '<script>getTimelineList(5418);'+player('A0006/','20260901153431877.mp4')+'</script>';
  const resolveCity=async html=>(await resolveVod(request('5418'),async url=>{
    assert.equal(url,cast5418);
    return new Response(html);
  },undefined,[],rosters)).json();
  const city=await resolveCity(cityPage);
  assert.equal(city.memberRoster?.sourceDate,'2026-07-08');
  assert.equal(city.memberRoster?.availableFrom,'2026-08-08');
  assert.equal(city.staffRoster?.length,4);
  assert.equal(city.staffRoster.find(row=>row.name==='김숙경').officialRole,'주무관');
  assert.ok(city.staffRoster.every(row=>row.candidateOnly && row.committee==='도시건설위원회' &&
    row.source===city.memberSource && !row.appointedOn));
  const {staffRoster,...cityRosterless}={...city,members:[]};
  assert.ok(!withPriorVodRoster({...cityRosterless,date:'2026-08-08'},rosters).staffRoster?.length);
  assert.ok(!withPriorVodRoster({...cityRosterless,date:'2026-10-07'},rosters).staffRoster?.length);
  assert.ok(!withPriorVodRoster({...cityRosterless,title:'제1차 행정교육위원회'},rosters).staffRoster?.length);
  assert.ok(!withPriorVodRoster({...cityRosterless,speakerTranscript:true},rosters).staffRoster?.length);
  assert.ok(!withPriorVodRoster({...cityRosterless,members:['파나다']},rosters).staffRoster?.length);
  const citySource=rosters.snapshots.find(row=>row.sourceDate==='2026-07-08' && row.body==='도시건설위원회');
  for (const badStaff of [
    [...citySource.staffRoster,citySource.staffRoster[0]],
    [{...citySource.staffRoster[0],name:citySource.members[0]}],
    [{...citySource.staffRoster[1],role:'문화복지체육위원회 담당'}],
    [{...citySource.staffRoster[0],source:'https://example.invalid'}],
  ]) {
    const malformed={...rosters,snapshots:[{...citySource,staffRoster:badStaff}]};
    assert.ok(!withPriorVodRoster(cityRosterless,malformed).staffRoster?.length);
  }
  assert.equal(liveSpeaker.attribute(city,[recognized('도시건설위원회 담당 김숙경입니다.')]).cue?.name,'김숙경');
  assert.ok(!liveSpeaker.attribute(cityRosterless,[recognized('도시건설위원회 담당 김숙경입니다.')]).cue?.name);
  for (const text of ['김숙경 주무관 나오셔서 보고해 주시기 바랍니다.','행정교육위원회 담당 김숙경입니다.',
    '도시건설위원회 담당 김숙경이라고 말씀하셨습니다.','도시건설위원회 담당 김숙경 님이 말씀하십니다.']) {
    assert.ok(!liveSpeaker.attribute(city,[recognized(text)]).cue?.name);
  }
  assert.ok(!(await resolveCity(cityPage+officialTurn)).staffRoster?.length);
  const audit={...rows.get('5547'),title:'행정교육위원회 행정사무감사 제1일차'};
  assert.ok(withPriorVodRoster(audit,rosters).members.includes('김선임'));
  const unidentifiedAudit={...audit,title:'행정사무감사 제1일차'};
  assert.strictEqual(withPriorVodRoster(unidentifiedAudit,rosters),unidentifiedAudit);
  const ops={...rows.get('5545'),date:'2026-10-07',speakerTranscript:false};
  const opsCandidates=withPriorVodRoster(ops,rosters);
  assert.deepEqual(opsCandidates.staffRoster.map(row=>row.name),['류예지']);
  assert.equal(opsCandidates.memberRoster.sourceDate,'2026-08-20');
  assert.equal(opsCandidates.memberRoster.availableFrom,'2026-09-20');
  assert.equal(liveSpeaker.attribute(opsCandidates,[recognized('안녕하십니까 의회 운영위원회 담당 류예지입니다.')]).cue?.name,'류예지');
  assert.ok(!withPriorVodRoster({...ops,date:'2026-09-20'},rosters).staffRoster?.length);

  const liveOps={id:'98765',title:'의회운영위원회',members:['정봉규'],staffRoster:[],scheduledAt:'2026-10-07T00:30:00Z',
    endsAt:'2026-10-07T11:40:00+09:00',officialPage:'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=98765',
    playlist:'https://cast.sncouncil.go.kr:4443/live/ch1.sdp/playlist.m3u8'};
  const prepare=(meeting,date='2026-10-07',body='의회운영위원회')=>withPriorLiveStaffRoster(meeting,rosters,date,body);
  const prepared=prepare(liveOps);
  assert.deepEqual(prepared.members,liveOps.members);
  assert.deepEqual(prepared.staffRoster,opsCandidates.staffRoster);
  assert.equal(prepared.priorStaffRoster.candidateOnly,true);
  assert.equal(prepared.priorStaffRoster.sourceUrl,opsCandidates.memberSource);
  assert.deepEqual(liveOps.staffRoster,[]);
  for (const untrusted of [
    {...liveOps,staffRoster:[{name:'다른이',role:'주무관'}]}, {...liveOps,members:['류예지']},
    {...liveOps,officialPage:liveOps.officialPage.replace('98765','98766')}, {...liveOps,playlist:ops.playlist},
    {...liveOps,scheduledAt:'2026-10-06T14:59:59Z'}, {...liveOps,endsAt:'2026-10-07T09:00:00+09:00'},
    {...liveOps,scheduledAt:'2026-10-07T09:30:00'}, {...liveOps,endsAt:'2026-10-07T11:40:00'}, {...liveOps,speakerTranscript:true},
  ]) assert.strictEqual(prepare(untrusted),untrusted);
  assert.strictEqual(prepare(liveOps,'2026-10-06'),liveOps);
  assert.strictEqual(prepare(liveOps,'2026-10-07','도시건설위원회'),liveOps);
  console.log('PASS prior VOD member and assigned staff candidates: exact self-intro, publication buffer, term, body and transcript priority');
}

const transcriptRequest=(query='id=5482', options) => new Request('https://example.invalid/api/vod/transcript?'+query, options);
const sourceUrl='https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5482&position=0';
const timelineUrl='https://cast.sncouncil.go.kr/vod/get_timeline_list_json.jsp?vod_no=5482';
const published = [
  '<script>getTimelineList(5482); const template = "<span id=\'contents_view_2\'>○가나다의원  예제</span>";</script>',
  '<li class="goto_chapter_btn {position:\'10\'}"><span id="chapter_0">위원장 다른이</span></li>',
  '<li class="goto_chapter_btn {position:\'50\'}"><span id="chapter_1">박을영 의원 안건</span></li>',
  '<span id="contents_title_0">○위원장 김갑수 </span>',
  '<span id="contents_view_0"><span><b>개회합니다.</b></span><br/>예산 &amp; 안건을 검토합니다.<br/>',
  '○박을영의원&nbsp;&nbsp;자료를 요청합니다.<br/>○ 의결 안건<br/>이 문장에는 발언자 근거가 없습니다.<br/>',
  '○환경정책과장 남은아<br/>해당 자료를 제출하겠습니다.</span>',
  '<span id="contents_title_1">박을영 의원 제안설명</span>',
  '<span id="contents_view_1">안건 설명만으로 이름을 추측하지 않습니다.<br/>○부위원장 윤한별  다음 질문입니다.<br/>',
  '○의회사무국직원 김숙경  도시건설위원회 소집에 관하여 보고드리겠습니다.</span>',
].join('');
const ranges={success:true,start_times:[10,50],end_times:[48,63]};
function transcriptFetch(html, timeline=ranges) {
  const seen=[];
  const fn=async (url, opts) => {
    assert.equal(opts.redirect,'manual'); assert.equal(opts.method,'GET'); assert.ok(opts.signal);
    seen.push(url);
    if (url === sourceUrl) return new Response(html);
    assert.equal(url,timelineUrl);
    return timeline instanceof Response ? timeline : Response.json(timeline);
  };
  return {fn,seen};
}
const fixture=transcriptFetch(published);
response=await resolveVodTranscript(transcriptRequest(),fixture.fn);
assert.equal(response.status,200);
assert.deepEqual(fixture.seen,[sourceUrl,timelineUrl]);
const expected=[
  {name:'김갑수',role:'위원장',text:'개회합니다.\n예산 & 안건을 검토합니다.',start:10,end:48},
  {name:'박을영',role:'의원',text:'자료를 요청합니다.',start:10,end:48},
  {name:'남은아',role:'환경정책과장',text:'해당 자료를 제출하겠습니다.',start:10,end:48},
  {name:'윤한별',role:'부위원장',text:'다음 질문입니다.',start:50,end:63},
  {name:'김숙경',role:'의회사무국직원',text:'도시건설위원회 소집에 관하여 보고드리겠습니다.',start:50,end:63},
];
assert.deepEqual(await response.json(),{meetingId:'5482',sourceUrl,turns:expected});
for (const upstream of [{...ranges,start_times:[11,50]}, {...ranges,end_times:[9,63]},
    new Response('x'.repeat(65537)), new Response('missing',{status:404}),new Response('',{status:302})]) {
  const unaligned=transcriptFetch(published,upstream);
  response=await resolveVodTranscript(transcriptRequest(),unaligned.fn);
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).turns,expected.map(({start,end,...turn})=>turn));
}
for (const html of [
  page(), published.replace('getTimelineList(5482)','getTimelineList(9999)'),
  published + '<span id="contents_view_1">duplicate</span>',
  '<script>getTimelineList(5482)</script><div class="confer_view">○위원장 김갑수<br/>안건 안내</div>',
]) {
  const unavailable=transcriptFetch(html);
  response=await resolveVodTranscript(transcriptRequest(),unavailable.fn);
  assert.deepEqual(await response.json(),{meetingId:'5482',sourceUrl,turns:[]});
  assert.deepEqual(unavailable.seen,[sourceUrl]);
}
response=await resolveVodTranscript(transcriptRequest(),async()=>new Response('',{status:404}));
assert.deepEqual(await response.json(),{meetingId:'5482',sourceUrl,turns:[]});
for (const query of ['id=5482&id=5483','id=5482&redirect=elsewhere','id=0','id=https%3A%2F%2Felsewhere']) {
  assert.equal((await resolveVodTranscript(transcriptRequest(query),offline)).status,400);
}
assert.equal((await resolveVodTranscript(transcriptRequest('id=5482',{method:'POST'}),offline)).status,405);
assert.equal((await resolveVodTranscript(transcriptRequest(),async()=>new Response('',{status:302}))).status,502);
assert.equal((await resolveVodTranscript(transcriptRequest(),async()=>new Response('x'.repeat(1024*1024+1)))).status,502);
assert.equal((await resolveVodTranscript(transcriptRequest(),async()=>{throw new DOMException('aborted','AbortError');})).status,504);
const longTurn=transcriptFetch('<script>getTimelineList(5482)</script><span id="contents_title_0">○위원장 김갑수</span>' +
  '<span id="contents_view_0">' + '긴'.repeat(9000) + '</span>',new Response('',{status:404}));
response=await resolveVodTranscript(transcriptRequest(),longTurn.fn);
assert.equal((await response.json()).turns[0].text.length,8000);
const officesPage=transcriptFetch('<script>getTimelineList(5482)</script><span id="contents_title_0">안건</span>' +
  '<span id="contents_view_0">○위원장대리 이정아  다음 안건을 상정하겠습니다.<br/>' +
  '○공보관 황순남  공보관 소관 자료입니다.<br/>○분당구청장 정상철  구청의 계획을 말씀드리겠습니다.<br/>' +
  '○분당구보건소감염병관리센터장직무대리 이채엽  사업 진행 상황을 보고드립니다.<br/>' +
  '○일반 안내  회의 진행 안내입니다.<br/>○의장직무대리 안광림  회의를 마치겠습니다.</span>',
  new Response('',{status:404}));
const offices=await (await resolveVodTranscript(transcriptRequest(),officesPage.fn)).json();
assert.deepEqual(offices.turns.map(row=>[row.role,row.name]),[
  ['위원장대리','이정아'],['공보관','황순남'],['분당구청장','정상철'],
  ['분당구보건소감염병관리센터장직무대리','이채엽'],['의장직무대리','안광림']]);
assert.ok(offices.turns.every(row=>!row.text.includes('회의 진행 안내')));
console.log('PASS official VOD transcript identity, speaker boundaries, chapter timing, safe fallback and bounds');
