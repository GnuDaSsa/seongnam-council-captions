import assert from 'node:assert/strict';
import {resolveVod} from '../worker/vod.mjs';

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
