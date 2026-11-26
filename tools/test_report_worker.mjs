import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {handleCaptionReports} from '../worker/reports.mjs';
import {createSite} from '../worker/captions.mjs';

const secret='test-fixture-only-secret-32-characters-long';
const origin='https://example.test';
const cutoff=Date.parse('2026-11-26T21:00:00+09:00');
const pendingPrefix='caption-reports/v1/pending/';
const receipts='caption-reports/v1/receipts/';
class Bucket {
  data=new Map(); version=0;
  async get(key) {
    const existing=this.data.get(key);
    return existing ? {etag:existing.etag,json:async()=>JSON.parse(existing.body)} : null;
  }
  async put(key,body,options) {
    if (this.failPut && key.startsWith(this.failPut)) { this.failPut=null; throw new Error('R2 temporarily unavailable'); }
    const old=this.data.get(key), cond=options?.onlyIf;
    if (cond instanceof Headers) {
      assert.equal(cond.get('If-None-Match'),'*');
      if (old) return null;
    } else if (cond) {
      assert.deepEqual(Object.keys(cond),['etagMatches']);
      if (old?.etag!==cond.etagMatches) return null;
    }
    const etag=String(++this.version);
    this.data.set(key,{etag,body}); return {etag};
  }
  async delete(keys) {
    if (this.failDelete) { this.failDelete=false; throw new Error('R2 temporarily unavailable'); }
    for (const key of Array.isArray(keys)?keys:[keys]) this.data.delete(key);
  }
  async list({prefix,limit}) {
    const all=[...this.data.keys()].filter(k=>k.startsWith(prefix)).sort();
    return {objects:all.slice(0,limit).map(key=>({key})),truncated:all.length>limit};
  }
}
function setup() {
  const bucket=new Bucket(), env={BUCKET:bucket,CAPTION_REPORT_DIGEST_KEY:secret};
  let now=cutoff-1;
  const app=createSite({assets:{},meetings:[],reportHandler:handleCaptionReports},()=>now);
  async function api(path,options){
    const response=await app.fetch(new Request(origin+path,options),env);
    return {status:response.status,body:await response.json()};
  }
  function send(data,extra={}) {
    return api('/api/reports',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...extra},body:JSON.stringify(data)});
  }
  const auth={Authorization:'Bearer '+secret};
  return {bucket,env,api,send,time:value=>{now=value;},
    pending:()=>api('/api/reports/pending',{headers:auth}),
    ack:(ids,issueNumber=123)=>api('/api/reports/ack',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({ids,issueNumber})})};
}
function sample(){
  return {id:randomUUID(),kind:'발언자 오류',note:' 발언자 이름이 다릅니다. ',context:{meetingId:'2857',cueId:'1795587268650155068',meetingTitle:'경제환경위원회',speaker:'발언자 미확인',quote:'표시된 자막',rawQuote:'원래 자막',observedAt:'2026-11-26T01:02:03.000Z'}};
}
test('same-origin public intake, duplicate retry, 21:00 boundary, overdue catch-up and authenticated ack',async()=>{
  const x=setup(), a=sample(), b=sample();
  assert.equal((await x.pending()).body.reports.length,0);
  assert.equal((await x.api('/api/reports/pending')).status,401);
  assert.equal((await x.api('/api/reports/ack',{method:'POST'})).status,401);
  assert.equal((await x.send(a,{Origin:'https://elsewhere.test'})).status,403);
  assert.deepEqual(await x.send(a),{status:201,body:{receipt:true,id:a.id,deliveryDay:'2026-11-26'}});
  assert.equal((await x.send(a)).status,200);
  assert.equal((await x.send({...a,note:'다른 의견'})).status,409);
  assert.equal((await x.ack([a.id])).status,409);
  assert.deepEqual((await x.pending()).body.reports,[]);
  x.time(cutoff);
  assert.equal((await x.send(b)).body.deliveryDay,'2026-11-27');
  assert.equal((await x.send(a)).body.deliveryDay,'2026-11-26');
  const pending=(await x.pending()).body.reports;
  assert.deepEqual(pending.map(r=>r.id),[a.id]);
  assert.equal(pending[0].note,'발언자 이름이 다릅니다.');
  assert.equal(pending[0].receivedAt,new Date(cutoff-1).toISOString());
  assert.equal(Object.hasOwn(pending[0],'fingerprint'),false);
  assert.equal((await x.ack([a.id,b.id])).status,409);
  assert.deepEqual(await x.ack([a.id]),{status:200,body:{acknowledged:1}});
  assert.equal((await x.ack([a.id])).status,200);
  assert.equal((await x.ack([a.id],124)).status,409);
  assert.equal((await x.send(a)).status,200);
  assert.deepEqual((await x.pending()).body.reports,[]);
  assert.equal(Object.hasOwn(JSON.parse(x.bucket.data.get(receipts+a.id).body),'note'),false);
  x.time(cutoff+7*86400000);
  assert.deepEqual((await x.pending()).body.reports.map(r=>r.id),[b.id]);
});
test('medium, timestamps, fields, invalid request and streaming body limits',async()=>{
  const x=setup(), a=sample();
  const {observedAt,...context}=a.context;
  const vod={...context,start:1,end:145,cueId:'5483-minutes-0',source:'vod-existing'};
  assert.equal((await x.send({...a,context:vod})).status,201);
  assert.equal((await x.send({...a,id:randomUUID(),context:{...a.context,source:'live-personal'}})).status,201);
  for (const patch of [{note:' '},{note:'a'.repeat(1201)},{kind:'other'},{id:'invalid'},{sourceUrl:'https://extra.test'},{note:'bad\x01text'},{context:{...vod,source:'live-personal'}},
      {context:{...vod,start:-1}},{context:{...vod,end:604801}},{context:{...vod,observedAt}},{context:{...vod,quote:''}},{context:{...vod,meetingId:'0'}},
      {context:{...vod,cueId:'../p'}},{context:{...a.context,observedAt:'2026-02-30T00:00:00Z'}}]) {
    assert.equal((await x.send({...a,id:randomUUID(),...patch})).status,400,JSON.stringify(patch));
  }
  assert.equal((await x.send(a,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await x.send({...a,note:'a'.repeat(33000)})).status,413);
  assert.equal((await x.api('/api/reports',{method:'GET'})).status,405);
  assert.equal((await x.api('/api/reports/anything')).status,404);
  x.env.CAPTION_REPORT_DIGEST_KEY='';
  assert.equal((await x.send(a)).status,503);
});
test('repair after pointer failure, handle cancelled ack, conflicting retry and stale pointers',async()=>{
  const x=setup(), a=sample(), path=pendingPrefix+'2026-11-26/'+a.id;
  x.bucket.failPut=pendingPrefix;
  assert.equal((await x.send(a)).status,503);
  assert.ok(x.bucket.data.has(receipts+a.id));
  assert.ok(!x.bucket.data.has(path));
  await Promise.all([x.send(a),x.send(a)]);
  assert.ok(x.bucket.data.has(path));
  x.time(cutoff);
  x.bucket.failDelete=true;
  assert.equal((await x.ack([a.id])).status,503);
  assert.equal(JSON.parse(x.bucket.data.get(receipts+a.id).body).issueNumber,123);
  assert.deepEqual((await x.pending()).body.reports,[]);
  assert.ok(!x.bucket.data.has(path));
  assert.equal((await x.ack([a.id])).status,200);
  await x.bucket.put(path,'1');
  assert.deepEqual((await x.pending()).body.reports,[]);
  assert.ok(!x.bucket.data.has(path));
});
test('competing deliveries of the same UUID create a single logical report',async()=>{
  const x=setup(), a=sample();
  const both=await Promise.all([x.send(a),x.send(a)]);
  assert.deepEqual(both.map(r=>r.status).sort(),[200,201]);
  const b=sample();
  const clash=await Promise.all([x.send(b),x.send({...b,note:'a distinct submitted note'})]);
  assert.deepEqual(clash.map(r=>r.status).sort(),[201,409]);
  x.time(cutoff);
  assert.equal((await x.pending()).body.reports.length,2);
});
test('radix-ordered batches drain without skipping and per-client limits store no raw IP',async()=>{
  const x=setup(), ids=[];
  const ip={'CF-Connecting-IP':'192.0.2.145'};
  for (let i=0;i<30;i++) {const a=sample(); ids.push(a.id); assert.equal((await x.send(a,ip)).status,201);}
  assert.equal((await x.send(sample(),ip)).status,429);
  for (const [key,obj] of x.bucket.data) { assert.ok(!key.includes(ip['CF-Connecting-IP']));assert.ok(!obj.body.includes(ip['CF-Connecting-IP'])); }
  x.time(cutoff);
  const first=(await x.pending()).body;
  assert.equal(first.more,true);
  assert.deepEqual(first.reports.map(r=>r.id),ids.sort().slice(0,20));
  assert.equal((await x.ack(first.reports.map(r=>r.id))).status,200);
  const second=(await x.pending()).body;
  assert.deepEqual(second.reports.map(r=>r.id),ids.slice(20));
  assert.equal(second.more,false);
  assert.equal((await x.send(sample(),ip)).status,201);
});
