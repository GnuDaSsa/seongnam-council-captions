import assert from 'node:assert/strict';
import {resolveVod,resolveVodTranscript} from '../worker/vod.mjs';

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
  '<span id="contents_view_1">안건 설명만으로 이름을 추측하지 않습니다.<br/>○부위원장 윤한별  다음 질문입니다.</span>',
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
console.log('PASS official VOD transcript identity, speaker boundaries, chapter timing, safe fallback and bounds');
