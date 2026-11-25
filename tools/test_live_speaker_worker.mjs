import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {createSite} from '../worker/captions.mjs';
import liveSpeaker from '../dist/live-speaker.js';

const keys = generateKeyPairSync('ed25519');
const now = Date.parse('2026-11-25T05:30:00Z');
const meetings = [
  {id:'2853', members:['조우현','정연화'], scheduledAt:'2026-11-25T04:30:00Z', endsAt:'2026-11-25T14:59:59Z'},
  {id:'2852', members:['김보석'], scheduledAt:'2026-11-25T04:30:00Z', endsAt:'2026-11-25T14:59:59Z'},
];
const at = n => new Date(now+n).toISOString();
function setup({failNameplates=false}={}) {
  const objects = new Map();
  const BUCKET = {
    async get(key) { if (failNameplates && key.startsWith('council-nameplates/')) throw Error('OCR storage unavailable'); return objects.get(key); },
    async put(key, body, options) {
      const old=objects.get(key);
      if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== old?.etag) return null;
      if (options.onlyIf instanceof Headers && options.onlyIf.get('if-none-match') === '*' && old) return null;
      const value={body,etag:String((Number(old?.etag)||0)+1),customMetadata:options.customMetadata};
      objects.set(key,value); return value;
    }
  };
  const site=createSite({assets:{},meetings,publicKey:keys.publicKey.export({format:'jwk'}).x,attributeSpeakers:liveSpeaker.attribute},()=>now);
  async function request(path,id,value) {
    const url=`https://example.org/api/live/${path}?meetingId=${id}`;
    const body=value === undefined ? undefined : JSON.stringify(value);
    const headers=body === undefined ? {} : {'X-Council-Signature':sign(null,Buffer.from(body),keys.privateKey).toString('base64url')};
    return site.fetch(new Request(url,{method:body === undefined ? 'GET' : 'PUT',headers,body}),{BUCKET});
  }
  return {request};
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

test('unavailable OCR storage leaves text attribution available',async()=>{
  const {request}=setup({failNameplates:true});
  await put(request,'captions','2853',snapshot('2853',[cue('intro',0,'조우현 의원입니다.')]));
  assert.equal((await get(request,'captions','2853')).cues[0].speaker?.name,'조우현');
});
