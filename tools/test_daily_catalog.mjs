import test from 'node:test';
import assert from 'node:assert/strict';
import {createDailyCatalog, readScheduleMirror} from '../worker/daily-catalog.mjs';
import {createSite} from '../worker/captions.mjs';

const dateA='2026-11-25', dateB='2026-11-26', dateC='2026-11-27';
const dayStart=d=>Date.parse(d+'T00:00:00+09:00');
const schedule=(date,id)=>({date,schedule:'https://cast.sncouncil.go.kr/schedule/live_schedule.jsp?d='+date,
  meetings:id?[{id,title:'경제환경위원회',scheduledAt:date+'T09:30:00+09:00',endsAt:date+'T23:59:00+09:00',
    officialPage:'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no='+id}]:[]});
function storage() {
  const objects=new Map();
  return {get:async k=>objects.has(k)?{json:async()=>JSON.parse(objects.get(k))}:null,
    put:async(k,body)=>{objects.set(k,body);}};
}
test('today changes at Seoul midnight, even in a warm worker; explicit archive ID survives a cold start',async()=>{
  let now=dayStart(dateB)-1, calls=0;
  const bucket=storage(), seed=schedule(dateA,'2853'), next=schedule(dateB,'2857');
  const options={seed,clock:()=>now,load:async date=>{calls++;return date===dateA?seed:date===dateB?next:schedule(dateC);}};
  let catalog=createDailyCatalog(options);
  await Promise.all([catalog.today(bucket),catalog.today(bucket)]);
  assert.equal(calls,1);
  now+=1;
  assert.equal((await catalog.today(bucket)).meetings[0].id,'2857');
  assert.equal((await catalog.forId(bucket,'2853')).date,dateA);
  catalog=createDailyCatalog(options);
  assert.equal((await catalog.today(bucket)).meetings[0].id,'2857');
  assert.equal(calls,2);
  now=dayStart(dateC);
  assert.deepEqual((await catalog.today(bucket)).meetings,[]);
  assert.equal((await catalog.forId(bucket,'2857')).date,dateB);
});
test('fallback requires the same day, and a verified empty day supersedes the fallback',async()=>{
  let now=dayStart(dateB), fail=true;
  const seed=schedule(dateA,'2853'), backup=schedule(dateB,'2857'), bucket=storage();
  const load=async date=>{if(fail)throw Error('upstream offline');return schedule(date);};
  const catalog=createDailyCatalog({load,mirror:async()=>seed,seed,datedSeeds:[backup],clock:()=>now});
  assert.equal((await catalog.today(bucket)).meetings[0].id,'2857');
  now+=30001; fail=false;
  assert.deepEqual((await catalog.today(bucket)).meetings,[]);
  now=dayStart(dateC); fail=true;
  await assert.rejects(catalog.today(bucket),/offline/);
});
test('HTTP live and legacy schedule routes, caption and camera lookups share today’s IDs',async()=>{
  const seed=schedule(dateA,'2853'), current=schedule(dateB,'2857'), bucket=storage();
  const clock=()=>dayStart(dateB);
  const dailyCatalog=createDailyCatalog({seed,clock,load:async()=>current});
  const app=createSite({assets:{},meetings:seed.meetings,dailyCatalog},clock);
  const get=path=>app.fetch(new Request('https://test.local'+path),{BUCKET:bucket});
  for(const path of ['/api/live/schedule','/data/live-meetings.json']) assert.equal((await (await get(path)).json()).date,dateB);
  assert.equal((await (await get('/api/live/schedule?meetingId=2853')).json()).date,dateA);
  assert.equal((await (await get('/api/live/nameplates?meetingId=2857')).json()).meetingId,'2857');
  assert.equal(await (await get('/api/live/captions?meetingId=2857')).text(),'Captions have not started');
  assert.equal((await get('/api/live/schedule?meetingId=unknown')).status,400);
  assert.equal((await get('/api/live/schedule?meetingId=777')).status,404);
});
test('a stale mirror cannot replace today’s schedule',async()=>{
  const remote=async()=>Response.json(schedule(dateA,'2853'));
  assert.equal(await readScheduleMirror(dateB,remote),null);
});
