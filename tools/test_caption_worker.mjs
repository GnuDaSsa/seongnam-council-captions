import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {createSite} from '../worker/captions.mjs';

const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const now = Date.parse('2026-11-25T05:30:00Z');
const meetings = ['2852', '2853'].map(id => ({id, scheduledAt:'2026-11-25T04:30:00Z', endsAt:'2026-11-25T14:59:59Z'}));
const site = createSite({assets:{}, meetings, publicKey:publicKey.export({format:'jwk'}).x}, () => now);
function storage() {
  const objects = new Map();
  return {
    get:async key => objects.get(key),
    head:async key => objects.get(key),
    async put(key, body, options) {
      const old = objects.get(key);
      if (old && options.onlyIf?.etagMatches !== old.etag) return null;
      if (!old) assert.equal(options.onlyIf.get('if-none-match'), '*');
      const obj = {body, customMetadata:options.customMetadata, etag:String((old ? Number(old.etag) : 0)+1)};
      objects.set(key,obj); return obj;
    }
  };
}
const cue = {id:'1',start:0,end:2,text:'성남시의회',rawText:'성남시의회',flags:[]};
const snapshot = (meetingId, ms=now) => ({meetingId,updatedAt:new Date(ms).toISOString(),status:'live',cues:[cue]});
function request(id, data, signed = true) {
  const url = 'https://example.org/api/live/captions?meetingId=' + id;
  if (!data) return new Request(url);
  const body = JSON.stringify(data);
  return new Request(url, {method:'PUT',body,headers:signed ? {'X-Council-Signature':sign(null, Buffer.from(body), privateKey).toString('base64url')} : {}});
}
test('channels never share snapshots; reject unsigned, old, and mismatched updates', async () => {
  const BUCKET = storage();
  const call = request => site.fetch(request, {BUCKET});
  assert.equal((await call(request('2853'))).status, 404);
  assert.equal((await call(request('2853', snapshot('2853'), false))).status, 401);
  assert.equal((await call(request('2853', snapshot('2853')))).status, 204);
  assert.deepEqual(await (await call(request('2853'))).json(), snapshot('2853'));
  assert.equal((await call(request('2852'))).status, 404);
  assert.equal((await call(request('2852', snapshot('2853')))).status, 400);
  assert.equal((await call(request('2853', snapshot('2853',now-1000)))).status, 409);
  assert.equal((await call(request('2853', snapshot('2853',now+1000)))).status, 204);
  assert.equal((await call(request('9999'))).status, 404);
});
test('rejects repeated cue IDs, reversed times, and expired publications', async () => {
  const BUCKET = storage();
  const bad = [snapshot('2852',now-121000),{...snapshot('2852'),cues:[cue,cue]},{...snapshot('2852'),cues:[{...cue,end:-1}]}];
  for (const value of bad) assert.equal((await site.fetch(request('2852',value),{BUCKET})).status,400);
});
const jsonMinutes = id => new Request('https://example.org/api/live/minutes?meetingId='+id);
test('rolling live view and complete ordered minutes survive rotation, duplicate deliveries, and restarts',async()=>{
  const BUCKET=storage();
  const call=r=>site.fetch(r,{BUCKET});
  const all=Array.from({length:331},(_,i)=>({...cue,id:String(i),start:i*2,end:i*2+1,observedAt:new Date(now+i*2).toISOString()}));
  for (let end=60;end<=360;end+=60) {
    const actual=Math.min(end,all.length);
    assert.equal((await call(request('2853',{...snapshot('2853',now+end),cues:all.slice(Math.max(0,actual-100),actual)}))).status,204);
  }
  assert.equal((await (await call(request('2853'))).json()).cues.length,100);
  const draft=await (await call(jsonMinutes('2853'))).json();
  assert.deepEqual(draft.cues,all);
  assert.equal(draft.coverageStart,all[0].observedAt);
  assert.equal((await call(jsonMinutes('2852'))).status,404);
  await call(request('2853',{...snapshot('2853',now+1000),status:'interrupted',cues:[]}));
  await call(request('2853',{...snapshot('2853',now+2000),status:'listening',cues:[]}));
  const resumed=await (await call(jsonMinutes('2853'))).json();
  assert.equal(resumed.cues.length,all.length);
  assert.equal(resumed.gaps.length,1);
  assert.equal(resumed.gaps[0].end,new Date(now+2000).toISOString());
});
test('signed PCM boundaries describe discarded audio independently of publication latency',async()=>{
  const BUCKET=storage(), id='2853', call=r=>site.fetch(r,{BUCKET});
  const stamp=offset=>new Date(now+offset).toISOString();
  const write=(at,status,fields={})=>call(request(id,{...snapshot(id,now+at),cues:[],status,...fields}));
  const prior={...cue,start:2,end:4,observedAt:stamp(-52000)};
  assert.equal((await write(-10000,'live',{cues:[prior]})).status,204);
  for (const fields of [{captureGapStart:stamp(-51000)}, {captureGapStart:stamp(90000)},
      {captureGapStart:'2026-11-25'}, {captureGapStart:stamp(-4000000)}, {captureGapEnd:stamp(-20000)}]) {
    assert.equal((await write(0,'interrupted',fields)).status,400);
  }
  assert.equal((await write(0,'interrupted',{captureGapStart:stamp(-48000)})).status,204);
  assert.equal((await write(1000,'interrupted',{captureGapStart:stamp(-47000)})).status,400);
  assert.equal((await write(2000,'interrupted',{captureGapStart:stamp(-48000)})).status,204);
  assert.equal((await write(3000,'live',{captureGapEnd:stamp(-49000)})).status,400);
  assert.equal((await write(54000,'listening',{captureGapEnd:stamp(8000)})).status,204);
  assert.equal((await write(55000,'listening',{captureGapEnd:stamp(8000)})).status,204);
  assert.equal((await write(56000,'live',{captureGapEnd:stamp(7000)})).status,400);
  const result=await (await call(jsonMinutes(id))).json();
  assert.deepEqual(result.gaps,[{start:stamp(-48000),end:stamp(8000),reason:'interrupted'}]);
  assert.deepEqual(result.cues,[prior]);
});
test('an ending status alone does not identify a resumed audio boundary',async()=>{
  const BUCKET=storage(),id='2852',call=r=>site.fetch(r,{BUCKET});
  const start=new Date(now-12000).toISOString();
  assert.equal((await call(request(id,{...snapshot(id),status:'interrupted',captureGapStart:start}))).status,204);
  assert.equal((await call(request(id,{...snapshot(id,now+20000),status:'ended'}))).status,204);
  assert.deepEqual((await (await call(jsonMinutes(id))).json()).gaps,[{start,end:null,reason:'interrupted'}]);
});
test('signed historical import preserves latest live state and deduplicates repeated imports',async()=>{
  const BUCKET=storage(), call=r=>site.fetch(r,{BUCKET});
  await call(request('2853',snapshot('2853')));
  const missing={...cue,id:'earlier',start:0,end:1};
  const payload={...snapshot('2853'),purpose:'restore-captured-cues',cues:[missing,cue],gaps:[]};
  for (let i=0;i<2;i++) {
    const orig=request('2853',payload);
    const restore=new Request(orig.url.replace('live/captions','live/minutes/recover'),{method:'PUT',headers:orig.headers,body:await orig.text()});
    assert.equal((await call(restore)).status,204);
  }
  assert.deepEqual(await (await call(request('2853'))).json(),snapshot('2853'));
  assert.equal((await (await call(jsonMinutes('2853'))).json()).cues.length,2);
  assert.equal((await call(request('2853',payload))).status,400);
});
