const reportKinds = new Set(['자막 내용 오류','발언자 오류','시각 오류','기타']);
const reportId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const pendingPrefix = 'caption-reports/v1/pending/';
const receiptKey = id => 'caption-reports/v1/receipts/' + id;
const pendingKey = row => pendingPrefix + row.deliveryDay + '/' + row.id;
const createOnly = () => ({onlyIf:new Headers({'If-None-Match':'*'})});
const maxBody = 32 * 1024;
const maxPage = 20;
const encoder = new TextEncoder();
const reportHeaders = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};

class ReportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new ReportError(status, message); }
function json(value,status=200) { return Response.json(value,{status,headers:reportHeaders}); }
function fields(value, keys) {
  return value && typeof value==='object' && !Array.isArray(value) &&
    Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));
}
function textField(value,max,required=true) {
  if (typeof value!=='string' || value.length>max || /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value)) fail(400,'Invalid text');
  const text=value.trim();
  if (required && !text) fail(400,'Missing text');
  return text;
}
function normalize(input) {
  if (!fields(input,['id','kind','note','context']) || typeof input.id!=='string' || !reportId.test(input.id) ||
      !reportKinds.has(input.kind)) fail(400,'Invalid report');
  const c=input.context, live=Object.hasOwn(c??{},'observedAt');
  const hasSource=Object.hasOwn(c??{},'source');
  if (!fields(c,[...(hasSource?['source']:[]),'meetingId','cueId','meetingTitle','speaker','quote','rawQuote',...(live?['observedAt']:['start','end'])]) ||
      typeof c.meetingId!=='string' || !/^[1-9]\d{0,11}$/.test(c.meetingId) ||
      typeof c.cueId!=='string' || !/^[A-Za-z0-9_.:-]{1,150}$/.test(c.cueId)) fail(400,'Invalid caption');
  const context={meetingId:c.meetingId,cueId:c.cueId,meetingTitle:textField(c.meetingTitle,240),speaker:textField(c.speaker,120,false),
    quote:textField(c.quote,1600),rawQuote:textField(c.rawQuote,1600)};
  if (hasSource) {
    if (!(live?['live-shared','live-personal']:['vod-existing','vod-personal']).includes(c.source)) fail(400,'Invalid caption source');
    context.source=c.source;
  }
  if (live) {
    if (typeof c.observedAt!=='string' || !/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(c.observedAt)) fail(400,'Invalid live time');
    const canonical=c.observedAt.length===20 ? c.observedAt.slice(0,-1)+'.000Z' : c.observedAt;
    const stamp=Date.parse(canonical);
    if (!Number.isFinite(stamp) || new Date(stamp).toISOString()!==canonical) fail(400,'Invalid live time');
    context.observedAt=canonical;
  } else {
    if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start<0 || c.end<=c.start || c.end>604800) fail(400,'Invalid media time');
    context.start=c.start; context.end=c.end;
  }
  return {id:input.id,kind:input.kind,note:textField(input.note,1200),context};
}
async function readJSON(request) {
  if (request.headers.get('Content-Type')?.split(';',1)[0].trim().toLowerCase()!=='application/json') fail(415,'JSON required');
  if (!request.body) fail(400,'Missing body');
  if (Number(request.headers.get('Content-Length'))>maxBody) fail(413,'Request too large');
  const reader=request.body.getReader(), chunks=[];
  let length=0;
  try {
    while (true) {
      const {value,done}=await reader.read();
      if (done) break;
      length+=value.length;
      if (length>maxBody) { await reader.cancel(); fail(413,'Request too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes=new Uint8Array(length);
  let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { fail(400,'Invalid JSON'); }
}
function hex(buffer) { return Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,'0')).join(''); }
async function rateLimit(bucket,secret,ip,id,now) {
  const hour=Math.floor(now/3600000);
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=hex(await crypto.subtle.sign('HMAC',key,encoder.encode('report-rate/'+hour+'/'+ip)));
  // Fixed shards are reused; only an hour-specific digest is retained for each client.
  const path='caption-reports/v1/rate/'+digest.slice(0,2);
  for (let attempt=0;attempt<6;attempt++) {
    const previous=await bucket.get(path);
    let ledger=previous ? await previous.json() : null;
    if (ledger?.hour>hour) fail(503,'Please retry');
    if (ledger?.hour!==hour) ledger={hour,clients:{}};
    const ids=ledger.clients[digest] || [];
    if (ids.includes(id)) return;
    if (ids.length>=30 || (!ids.length && Object.keys(ledger.clients).length>=128)) fail(429,'Too many reports');
    ledger.clients[digest]=[...ids,id];
    const options=previous ? {onlyIf:{etagMatches:previous.etag}} : createOnly();
    if (await bucket.put(path,JSON.stringify(ledger),options)) return;
  }
  fail(503,'Please retry');
}
const halfDay=12*3600000;
// 21:00 Asia/Seoul is 12:00 UTC. The exact boundary belongs to the next digest.
const dueDay=now=>new Date(now+halfDay).toISOString().slice(0,10);
const closedDay=now=>new Date(now-halfDay).toISOString().slice(0,10);
async function getReceipt(bucket,id) {
  const obj=await bucket.get(receiptKey(id));
  return obj && {row:await obj.json(),etag:obj.etag};
}
async function submit(request,bucket,secret,now,url) {
  if (request.headers.get('Origin')!==url.origin) fail(403,'Same origin required');
  const input=normalize(await readJSON(request));
  const fingerprint=hex(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(input))));
  let entry=await getReceipt(bucket,input.id);
  let created=false;
  if (!entry) {
    await rateLimit(bucket,secret,request.headers.get('CF-Connecting-IP') || 'shared-gateway',input.id,now);
    const row={...input,deliveryDay:dueDay(now),receivedAt:new Date(now).toISOString(),fingerprint};
    const saved=await bucket.put(receiptKey(input.id),JSON.stringify(row),createOnly());
    created=Boolean(saved);
    entry=saved ? {row,etag:saved.etag} : await getReceipt(bucket,input.id);
  }
  if (!entry) fail(503,'Please retry');
  const {row}=entry;
  if (row.fingerprint!==fingerprint) fail(409,'Report ID already used');
  // A retry can repair a failed queue write after the receipt was stored.
  if (!row.issueNumber) await bucket.put(pendingKey(row),'1',createOnly());
  return json({id:row.id,receipt:true,deliveryDay:row.deliveryDay},created?201:200);
}
function bearerMatches(header,secret) {
  const expected='Bearer '+secret;
  if (!header || header.length!==expected.length) return false;
  let diff=0;
  for (let i=0;i<header.length;i++) diff|=header.charCodeAt(i)^expected.charCodeAt(i);
  return diff===0;
}
async function pending(bucket,now) {
  const page=await bucket.list({prefix:pendingPrefix,limit:maxPage});
  const cutoff=closedDay(now), reports=[], obsolete=[];
  let future=false;
  for (const obj of page.objects) {
    const suffix=obj.key.slice(pendingPrefix.length);
    const [day,id]=suffix.split('/');
    if (day>cutoff) { future=true; break; }
    const entry=await getReceipt(bucket,id);
    if (!entry || pendingKey(entry.row)!==obj.key) fail(503,'Report queue inconsistent');
    if (entry.row.issueNumber) { obsolete.push(obj.key); continue; }
    const {receivedAt,deliveryDay,kind,note,context}=entry.row;
    reports.push({id,receivedAt,deliveryDay,kind,note,context});
  }
  if (obsolete.length) await bucket.delete(obsolete);
  return json({reports,more:!future && Boolean(page.truncated)});
}
async function acknowledge(request,bucket,now) {
  const data=await readJSON(request);
  if (!fields(data,['ids','issueNumber']) || !Number.isSafeInteger(data.issueNumber) || data.issueNumber<1 ||
      !Array.isArray(data.ids) || !data.ids.length || data.ids.length>maxPage || new Set(data.ids).size!==data.ids.length ||
      !data.ids.every(id=>typeof id==='string' && reportId.test(id))) fail(400,'Invalid acknowledgement');
  const cutoff=closedDay(now), entries=[];
  for (const id of data.ids) {
    const entry=await getReceipt(bucket,id);
    if (!entry) fail(404,'Unknown report');
    if (entry.row.deliveryDay>cutoff) fail(409,'Report is not due');
    if (entry.row.issueNumber && entry.row.issueNumber!==data.issueNumber) fail(409,'Already delivered to another issue');
    entries.push(entry);
  }
  for (const {row,etag} of entries) {
    if (row.issueNumber) continue;
    const {id,deliveryDay,receivedAt,fingerprint}=row;
    const receipt={id,deliveryDay,receivedAt,fingerprint,issueNumber:data.issueNumber};
    if (!await bucket.put(receiptKey(id),JSON.stringify(receipt),{onlyIf:{etagMatches:etag}})) fail(409,'Concurrent acknowledgement');
  }
  await bucket.delete(entries.map(({row})=>pendingKey(row)));
  return json({acknowledged:entries.length});
}
export async function handleCaptionReports(request,env,clock=Date.now) {
  const url=new URL(request.url), path=url.pathname;
  try {
    if (!['/api/reports','/api/reports/pending','/api/reports/ack'].includes(path)) fail(404,'Not found');
    const secret=env.CAPTION_REPORT_DIGEST_KEY;
    if (!env.BUCKET || typeof secret!=='string' || secret.length<32) fail(503,'Reports unavailable');
    if (path!=='/api/reports' && !bearerMatches(request.headers.get('Authorization'),secret)) fail(401,'Authorization required');
    if (url.search) fail(400,'Unexpected query');
    if (request.method!==(path==='/api/reports/pending'?'GET':'POST')) fail(405,'Method not allowed');
    const now=clock();
    if (path==='/api/reports') return await submit(request,env.BUCKET,secret,now,url);
    if (path==='/api/reports/pending') return await pending(env.BUCKET,now);
    return await acknowledge(request,env.BUCKET,now);
  } catch (err) {
    return err instanceof ReportError ? json({error:err.message},err.status) : json({error:'Storage unavailable'},503);
  }
}
