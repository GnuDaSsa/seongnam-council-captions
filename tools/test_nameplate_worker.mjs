import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync, sign} from 'node:crypto';
import {createSite} from '../worker/captions.mjs';

const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const now = Date.parse('2026-11-25T05:30:00.000Z');
const catalog = JSON.parse(readFileSync(new URL('../dist/data/live-meetings.json',import.meta.url),'utf8'));
const meeting = catalog.meetings.find(item => item.id === '2853') ?? {
  id:'2853',scheduledAt:'2026-11-25T13:30:00+09:00',endsAt:'2026-11-25T23:59:59+09:00',
  members:['\uC548\uAD11\uD658','\uC7A5\uC77C\uB0A8','\uAE40\uC625\uC218','\uC11C\uC740\uACBD','\uC815\uBD09\uADDC','\uC815\uC5F0\uD654','\uC870\uC6B0\uD604'],
};
const rosterName = '\uAE40\uC625\uC218';
const meetings = [meeting,{id:'test-no-roster',scheduledAt:meeting.scheduledAt,endsAt:meeting.endsAt,members:[]}];
const publicKeyRaw = publicKey.export({format:'jwk'}).x;
const site = () => createSite({assets:{},meetings,publicKey:publicKeyRaw},() => now);
const at = delta => new Date(now + delta).toISOString();
const sample = (capturedAt=at(-30000),matchedMembers=[rosterName]) => ({
  meetingId:'2853',updatedAt:new Date(now).toISOString(),observations:[{capturedAt,matchedMembers}],
});

function storage({raceArchive}={}) {
  const objects = new Map();
  let raced = false;
  return {objects,get:async key=>objects.get(key),head:async key=>objects.get(key),async put(key,body,options) {
    const old=objects.get(key);
    if (!raced && raceArchive && key==='council-nameplates/2853.json') {
      raced=true; objects.set(key,{body:JSON.stringify(raceArchive),etag:'1',customMetadata:{updatedAt:raceArchive.updatedAt}}); return null;
    }
    if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches!==old?.etag) return null;
    if (options.onlyIf instanceof Headers && options.onlyIf.get('if-none-match')==='*' && old) return null;
    const object={body,customMetadata:options.customMetadata,httpMetadata:options.httpMetadata,etag:String((Number(old?.etag)||0)+1)};
    objects.set(key,object); return object;
  }};
}

function request(path,id,body,{signed=true,signBody=body,key=privateKey,method='PUT'}={}) {
  const headers={};
  if (signed) headers['X-Council-Signature']=sign(null,Buffer.from(signBody),key).toString('base64url');
  if (method==='PUT') headers['Content-Type']='application/json';
  return new Request(`https://site.example/api/live/${path}?meetingId=${id}`,{method,headers,body:method==='GET'||method==='HEAD'?undefined:body});
}
const put=(id,value,options={})=>{const body=options.body??JSON.stringify(value);return request('nameplates',id,body,{...options,signBody:options.signBody??body});};
const get=id=>new Request(`https://site.example/api/live/nameplates?meetingId=${id}`);

test('known and unknown meeting reads, methods, real offset catalog schedule',async()=>{
  const BUCKET=storage(),app=site();
  assert.equal((await app.fetch(get('2853'),{BUCKET})).status,200);
  assert.equal((await app.fetch(get('9999'),{BUCKET})).status,404);
  assert.equal((await app.fetch(request('nameplates','2853','',{method:'POST'}),{BUCKET})).status,405);
  assert.equal((await app.fetch(put('2853',sample()),{BUCKET})).status,204);
});

test('requires Ed25519 signature over exact bytes and rejects invalid input',async()=>{
  const BUCKET=storage(),app=site(),data=sample(),body=JSON.stringify(data);
  assert.equal((await app.fetch(put('2853',data,{signed:false}),{BUCKET})).status,401);
  const other=generateKeyPairSync('ed25519');
  assert.equal((await app.fetch(put('2853',data,{key:other.privateKey}),{BUCKET})).status,401);
  assert.equal((await app.fetch(put('2853',data,{body:body+' ',signBody:body}),{BUCKET})).status,401);
  const bad=[{...sample(),meetingId:'2852'},{...sample(),updatedAt:at(-121000)},
    {...sample(at(-11*60*1000))},{...sample(at(-30000),['<script>'])}];
  for (const value of bad) assert.equal((await app.fetch(put('2853',value),{BUCKET})).status,400);
  assert.equal((await app.fetch(put('2853',sample(),{body:JSON.stringify({...data,padding:'x'.repeat(130*1024)})}),{BUCKET})).status,413);
});

test('appends sorted observations, merges duplicate capture time, and persists',async()=>{
  const BUCKET=storage(),app=site();
  assert.equal((await app.fetch(put('2853',sample(at(-60000))),{BUCKET})).status,204);
  assert.equal((await app.fetch(put('2853',sample(at(-30000),[])),{BUCKET})).status,204);
  assert.equal((await app.fetch(put('2853',sample(at(-60000),['\uC815\uC5F0\uD654'])),{BUCKET})).status,204);
  const saved=await (await site().fetch(get('2853'),{BUCKET})).json();
  assert.equal(saved.observations.length,2);
  assert.deepEqual(saved.observations[0].matchedMembers,[rosterName,'\uC815\uC5F0\uD654'].sort());
  assert.deepEqual(saved.observations.map(row=>row.capturedAt),[at(-60000),at(-30000)]);
});

test('CAS retry merges concurrent writes and day cap never trims old evidence',async()=>{
  const concurrent={meetingId:'2853',updatedAt:new Date(now).toISOString(),observations:[{capturedAt:at(-30000),matchedMembers:[rosterName]}]};
  const BUCKET=storage({raceArchive:concurrent}),app=site();
  assert.equal((await app.fetch(put('2853',sample(at(-30000),['\uC815\uC5F0\uD654'])),{BUCKET})).status,204);
  const saved=await (await app.fetch(get('2853'),{BUCKET})).json();
  assert.deepEqual(saved.observations[0].matchedMembers,[rosterName,'\uC815\uC5F0\uD654'].sort());
  const observations=Array.from({length:4320},(_,i)=>({capturedAt:new Date(Date.parse('2026-11-25T04:30:00.000Z')+i*500).toISOString(),matchedMembers:[]}));
  BUCKET.objects.set('council-nameplates/2853.json',{body:JSON.stringify({meetingId:'2853',updatedAt:new Date(now).toISOString(),observations}),etag:'9'});
  assert.equal((await app.fetch(put('2853',sample()),{BUCKET})).status,413);
  assert.equal((await (await app.fetch(get('2853'),{BUCKET})).json()).observations.length,4320);
});

test('nameplate evidence stays separate from caption snapshots; roster fallback is bounded',async()=>{
  const BUCKET=storage(),app=site();
  const caption={meetingId:'2853',updatedAt:new Date(now).toISOString(),status:'live',cues:[{id:'c1',start:0,end:2,text:'\uC758\uD68C',rawText:'\uC758\uD68C',flags:[]}]};
  const body=JSON.stringify(caption);
  assert.equal((await app.fetch(request('captions','2853',body),{BUCKET})).status,204);
  const unknown={meetingId:'test-no-roster',updatedAt:new Date(now).toISOString(),observations:[{capturedAt:at(-30000),matchedMembers:['\uAE40\uAE38\uB3D9']}]};
  assert.equal((await app.fetch(put('test-no-roster',unknown),{BUCKET})).status,204);
  const nonNfc={...unknown,observations:[{capturedAt:at(-30000),matchedMembers:['\u1100\u1175\u11B7\u1100\u1175\u11AF\u1103\u1169\u11BC']}]};
  assert.equal((await app.fetch(put('test-no-roster',nonNfc),{BUCKET})).status,400);
  assert.equal((await app.fetch(put('2853',sample()),{BUCKET})).status,204);
  assert.deepEqual((await (await app.fetch(new Request('https://site.example/api/live/captions?meetingId=2853'),{BUCKET})).json()).cues,caption.cues);
  assert.ok(BUCKET.objects.has('council-captions/2853.json'));
  assert.ok(BUCKET.objects.has('council-nameplates/2853.json'));
});
