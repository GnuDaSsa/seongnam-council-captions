const headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'};
const jsonHeaders = {...headers, 'Content-Type': 'application/json; charset=utf-8'};
const maxBytes = 256 * 1024;
const fromBase64url = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const error = (status, message) => new Response(message, {status, headers});

async function readBytes(request) {
  if (!request.body || Number(request.headers.get('Content-Length')) > maxBytes) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function validate(data, meeting, now) {
  const time = Date.parse(data?.updatedAt);
  if (data?.meetingId !== meeting.id || !Number.isFinite(time) || Math.abs(now - time) > 120000) return false;
  if (time < Date.parse(meeting.scheduledAt) || time > Date.parse(meeting.endsAt) + 120000) return false;
  if (!['live', 'listening', 'ended', 'interrupted'].includes(data.status) || !Array.isArray(data.cues) || data.cues.length > 700) return false;
  const ids = new Set();
  const validText = s => typeof s === 'string' && s.trim().length > 0 && s.length <= 2000;
  let lastStart = -1;
  for (const cue of data.cues) {
    if (!cue || typeof cue.id !== 'string' || !cue.id || cue.id.length > 100 || ids.has(cue.id)) return false;
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || cue.start < lastStart || cue.end > 86400) return false;
    if (!validText(cue.rawText) || !validText(cue.text) || !Array.isArray(cue.flags) || cue.flags.length > 12 || cue.flags.some(f => !validText(f) || f.length > 80)) return false;
    ids.add(cue.id);
    lastStart = cue.start;
  }
  return true;
}

const pageSize = 100;
const jsonBody = async object => object ? new Response(object.body).json() : null;
function combine(...groups) {
  const cues = new Map();
  for (const group of groups) for (const cue of group || []) cues.set(cue.id, cue);
  return [...cues.values()].sort((a,b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
}
function condition(previous) {
  return previous ? {etagMatches:previous.etag} : new Headers({'If-None-Match':'*'});
}
function snapshot(data, cues) {
  return {meetingId:data.meetingId, updatedAt:data.updatedAt, status:data.status, cues};
}
async function sealPage(bucket, id, cues) {
  const body = JSON.stringify(cues);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  const key = 'council-pages/' + id + '/' + Array.from(digest, byte => byte.toString(16).padStart(2,'0')).join('');
  await bucket.put(key, body, {onlyIf:new Headers({'If-None-Match':'*'})});
  return key;
}
async function writeSnapshot(bucket, key, previous, data, decorate) {
  const old = await jsonBody(previous);
  const pages = [...(old?.pages || [])], gaps = [...(old?.gaps || [])];
  // The producer repeats the tail on every heartbeat. Sealed pages always end
  // before the oldest of the most recent 100 cues, including on restart.
  let tail = combine(old?.cues, data.cues);
  if (old?.sealedThrough != null) tail = tail.filter(c => c.start >= old.sealedThrough);
  if (old && old.status !== 'interrupted' && data.status === 'interrupted') {
    gaps.push({start:old.updatedAt, end:null, reason:'interrupted'});
  } else if (old && old.status === 'interrupted' && data.status !== 'interrupted') {
    if (gaps.length && !gaps.at(-1).end) gaps.at(-1).end = data.updatedAt;
    else gaps.push({start:old.updatedAt, end:data.updatedAt, reason:'interrupted'});
  } else if (old && old.status !== 'interrupted' && Date.parse(data.updatedAt) - Date.parse(old.updatedAt) > 120000) {
    gaps.push({start:old.updatedAt, end:data.updatedAt, reason:'updates_missing'});
  }
  let sealedThrough = old?.sealedThrough ?? null;
  let speakerContext = old?.speakerContext || [];
  tail = await decorate(tail, speakerContext, gaps);
  while (tail.length >= pageSize * 2) {
    let cut = pageSize;
    while (cut < tail.length - pageSize && tail[cut - 1].start === tail[cut].start) cut++;
    if (tail[cut - 1].start === tail[cut].start) break;
    pages.push(await sealPage(bucket, data.meetingId, tail.slice(0,cut)));
    speakerContext = tail.slice(Math.max(0,cut - 8),cut);
    tail = tail.slice(cut);
    sealedThrough = tail[0].start;
  }
  const state = {...snapshot(data,tail),pages,sealedThrough,gaps,speakerContext};
  return bucket.put(key, JSON.stringify(state), {onlyIf:condition(previous), customMetadata:{updatedAt:data.updatedAt}, httpMetadata:{contentType:jsonHeaders['Content-Type']}});
}
async function minutes(bucket, state, id) {
  const pages = [];
  for (const key of state?.pages || []) {
    const part = await jsonBody(await bucket.get(key));
    if (!part) return error(503,'A minutes page is unavailable');
    pages.push(part);
  }
  const initial = await jsonBody(await bucket.get('council-recovered/' + id));
  const cues = combine(initial?.cues,...pages,state?.cues);
  if (!state && !initial) return error(404,'Minutes have not started');
  const gapMap = new Map();
  for (const gap of [...(initial?.gaps || []),...(state?.gaps || [])]) gapMap.set(gap.start, gap);
  const data = snapshot(state || {meetingId:id,updatedAt:initial.updatedAt,status:'interrupted'},cues);
  return Response.json({...data,coverageStart:cues[0]?.observedAt || null,gaps:[...gapMap.values()].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start))},{headers:jsonHeaders});
}

const nameplateMaxBytes = 128 * 1024;
const nameplateMaxBatch = 100;
const nameplateMaxObservations = 1440;
const nameplateMaxAgeMs = 10 * 60 * 1000;
function nameplateKey(id) { return 'council-nameplates/' + id + '.json'; }
function exactKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function dateTime(value) { return typeof value === 'string' ? Date.parse(value) : NaN; }
function canonicalUtcTime(value) {
  const time = dateTime(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}
function validMemberList(names, meeting) {
  if (!Array.isArray(names) || names.length > 20) return false;
  const roster = Array.isArray(meeting.members) && meeting.members.length ? new Set(meeting.members) : null;
  const seen = new Set();
  for (const raw of names) {
    if (typeof raw !== 'string') return false;
    const name = raw.normalize('NFC');
    if (name !== raw) return false;
    if (!/^[가-힣]{2,4}$/.test(name) || seen.has(name) || roster && !roster.has(name)) return false;
    seen.add(name);
  }
  return true;
}
function validObservation(observation, meeting, updatedTime) {
  if (!exactKeys(observation, ['capturedAt', 'matchedMembers']) || !validMemberList(observation.matchedMembers, meeting)) return false;
  const capturedTime = canonicalUtcTime(observation.capturedAt);
  const scheduledAt = dateTime(meeting.scheduledAt), endsAt = dateTime(meeting.endsAt);
  if (!Number.isFinite(capturedTime) || !Number.isFinite(scheduledAt) || !Number.isFinite(endsAt)) return false;
  if (capturedTime < scheduledAt || capturedTime > endsAt || capturedTime > updatedTime + 10000 || updatedTime - capturedTime > nameplateMaxAgeMs) return false;
  return true;
}
function validateNameplateUpdate(data, meeting, now) {
  if (!exactKeys(data, ['meetingId', 'updatedAt', 'observations']) || data.meetingId !== meeting.id || !Array.isArray(data.observations) ||
      data.observations.length < 1 || data.observations.length > nameplateMaxBatch) return false;
  const updatedTime = canonicalUtcTime(data.updatedAt);
  const scheduledAt = dateTime(meeting.scheduledAt), endsAt = dateTime(meeting.endsAt);
  if (!Number.isFinite(updatedTime) || Math.abs(now - updatedTime) > 120000 ||
      !Number.isFinite(scheduledAt) || !Number.isFinite(endsAt) || updatedTime < scheduledAt || updatedTime > endsAt + 120000) return false;
  return data.observations.every(observation => validObservation(observation, meeting, updatedTime));
}
function validStoredNameplates(data, meeting) {
  if (!exactKeys(data, ['meetingId', 'updatedAt', 'observations']) || data.meetingId !== meeting.id ||
      !Array.isArray(data.observations) || data.observations.length > nameplateMaxObservations) return false;
  const updatedTime = data.updatedAt == null ? NaN : canonicalUtcTime(data.updatedAt);
  if (data.updatedAt != null && !Number.isFinite(updatedTime)) return false;
  const seen = new Set();
  let lastTime = -Infinity;
  for (const observation of data.observations) {
    if (!exactKeys(observation, ['capturedAt', 'matchedMembers']) || !validMemberList(observation.matchedMembers, meeting)) return false;
    const capturedTime = canonicalUtcTime(observation.capturedAt);
    if (!Number.isFinite(capturedTime) || capturedTime < dateTime(meeting.scheduledAt) || capturedTime > dateTime(meeting.endsAt) || capturedTime < lastTime || seen.has(observation.capturedAt)) return false;
    seen.add(observation.capturedAt);
    lastTime = capturedTime;
  }
  return data.observations.length === 0 ? data.updatedAt == null : Number.isFinite(updatedTime);
}
function mergeNameplateObservations(previous, incoming) {
  const byTime = new Map();
  for (const observation of [...(previous || []), ...incoming]) {
    const old = byTime.get(observation.capturedAt);
    byTime.set(observation.capturedAt, old
      ? {capturedAt:observation.capturedAt, matchedMembers:[...new Set([...old.matchedMembers, ...observation.matchedMembers])].sort()}
      : {capturedAt:observation.capturedAt, matchedMembers:[...observation.matchedMembers].sort()});
  }
  return [...byTime.values()].sort((a,b)=>dateTime(a.capturedAt)-dateTime(b.capturedAt));
}
async function nameplates(request, bucket, url, meetings, publicKey, clock, verify) {
  const id = url.searchParams.get('meetingId') || '';
  const meeting = meetings.find(item => item.id === id);
  if (!meeting) return error(404, 'Unknown meeting');
  if (!bucket) return error(503, 'Nameplate storage unavailable');
  const key = nameplateKey(id);
  if (request.method === 'GET' || request.method === 'HEAD') {
    const object = await bucket.get(key);
    if (!object) {
      if (request.method === 'HEAD') return new Response(null, {headers:jsonHeaders});
      return Response.json({meetingId:id, updatedAt:null, observations:[]}, {headers:jsonHeaders});
    }
    let stored;
    try { stored = await jsonBody(object); } catch { return error(503, 'Nameplate archive is unavailable'); }
    if (!validStoredNameplates(stored, meeting)) return error(503, 'Nameplate archive is invalid');
    if (request.method === 'HEAD') return new Response(null, {headers:jsonHeaders});
    return Response.json(stored, {headers:jsonHeaders});
  }
  if (request.method !== 'PUT') return new Response(null, {status:405, headers:{...headers, Allow:'GET, HEAD, PUT'}});
  const signature = request.headers.get('X-Council-Signature') || '';
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return error(401, 'Invalid signature');
  const bytes = await readBytes(request);
  if (!bytes || bytes.byteLength > nameplateMaxBytes) return error(413, 'Invalid body size');
  if (!await verify(publicKey, signature, bytes)) return error(401, 'Invalid signature');
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
  catch { return error(400, 'Invalid JSON'); }
  if (!validateNameplateUpdate(data, meeting, clock())) return error(400, 'Invalid nameplate observations');

  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = await bucket.get(key);
    let old = {meetingId:id, updatedAt:null, observations:[]};
    if (previous) {
      try { old = await jsonBody(previous); } catch { return error(503, 'Nameplate archive is unavailable'); }
      if (!validStoredNameplates(old, meeting)) return error(503, 'Nameplate archive is invalid');
    }
    const observations = mergeNameplateObservations(old.observations, data.observations);
    if (observations.length > nameplateMaxObservations) return error(413, 'Nameplate archive limit reached');
    const oldUpdateTime = dateTime(old.updatedAt), incomingUpdateTime = dateTime(data.updatedAt);
    const updatedAt = Number.isFinite(oldUpdateTime) && oldUpdateTime > incomingUpdateTime ? old.updatedAt : data.updatedAt;
    const next = {meetingId:id, updatedAt, observations};
    if (previous && JSON.stringify(old) === JSON.stringify(next)) return new Response(null, {status:204, headers});
    const saved = await bucket.put(key, JSON.stringify(next), {
      onlyIf:condition(previous), customMetadata:{updatedAt}, httpMetadata:{contentType:jsonHeaders['Content-Type']},
    });
    if (saved) return new Response(null, {status:204, headers});
  }
  return error(409, 'Concurrent nameplate update');
}

export function createSite({assets, meetings, publicKey, attributeSpeakers, resolveArchiveVideo}, clock = Date.now) {
  let verifier;
  const visualCache = new Map();
  async function visualEvidence(bucket, meeting) {
    const cached = visualCache.get(meeting.id);
    if (cached && clock() < cached.expires) return cached.rows;
    let rows = [];
    try {
      const data = await jsonBody(await bucket.get(nameplateKey(meeting.id)));
      if (data && validStoredNameplates(data, meeting)) rows = data.observations.filter(o => o.matchedMembers.length);
    } catch { /* Text-based attribution still works when camera evidence is unavailable. */ }
    visualCache.set(meeting.id, {expires:clock() + 3000, rows});
    return rows;
  }
  async function verifySignature(key, signature, bytes) {
    verifier ??= crypto.subtle.importKey('raw', fromBase64url(key), 'Ed25519', false, ['verify']);
    return crypto.subtle.verify('Ed25519', await verifier, fromBase64url(signature), bytes);
  }
  async function captions(request, bucket, url) {
    const id = url.searchParams.get('meetingId') ?? meetings[0]?.id;
    const meeting = meetings.find(item => item.id === id);
    const isMinutes = url.pathname === '/api/live/minutes';
    const isRecovery = url.pathname === '/api/live/minutes/recover';
    if (!meeting && !(isMinutes && request.method === 'GET' && /^\d{1,12}$/.test(id))) return error(404, 'Unknown meeting');
    if (!bucket) return error(503, 'Captions storage unavailable');
    const storageKey = 'council-captions/' + id + '.json';
    async function decorate(cues, context, gaps) {
      const raw = cues.map(({speaker, ...cue}) => cue);
      if (!attributeSpeakers || !raw.length) return raw;
      const speakers = attributeSpeakers(meeting, [...context,...raw], await visualEvidence(bucket,meeting), gaps);
      return raw.map(cue => Object.hasOwn(speakers,cue.id) ? {...cue,speaker:speakers[cue.id]} : cue);
    }
    if (isMinutes) {
      if (request.method !== 'GET') return error(405,'Read only');
      return minutes(bucket, await jsonBody(await bucket.get(storageKey)), id);
    }
    if (!isRecovery && (request.method === 'GET' || request.method === 'HEAD')) {
      const object = await bucket.get(storageKey);
      if (!object) return error(404, 'Captions have not started');
      if (request.method === 'HEAD') return new Response(null,{headers:jsonHeaders});
      const current = await jsonBody(object);
      const labeled = await decorate(current.cues,current.speakerContext || [],current.gaps || []);
      return Response.json(snapshot(current,labeled.slice(-pageSize)),{headers:jsonHeaders});
    }
    if (request.method !== 'PUT') return new Response(null, {status:405, headers:{...headers, Allow:'GET, HEAD, PUT'}});
    const signature = request.headers.get('X-Council-Signature') || '';
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return error(401, 'Invalid signature');
    const bytes = await readBytes(request);
    if (!bytes) return error(413, 'Invalid body size');
    if (!await verifySignature(publicKey, signature, bytes)) return error(401, 'Invalid signature');
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
    catch { return error(400, 'Invalid JSON'); }
    if (isRecovery) {
      if (data?.purpose !== 'restore-captured-cues' || !validate(data,meeting,clock())) return error(400,'Invalid recovery');
      if (!Array.isArray(data.gaps) || data.gaps.some(g => !g || !['interrupted','updates_missing'].includes(g.reason) || !Number.isFinite(Date.parse(g.start)) || !Number.isFinite(Date.parse(g.end)) || Date.parse(g.start)>Date.parse(g.end) || Date.parse(g.start)<Date.parse(meeting.scheduledAt) || Date.parse(g.end)>Date.parse(meeting.endsAt))) return error(400,'Invalid gaps');
      const key = 'council-recovered/' + id;
      const previous = await bucket.get(key);
      const old = await jsonBody(previous);
      const gapMap = new Map([...(old?.gaps || []), ...data.gaps].map(g => [g.start,g]));
      const gaps = [...gapMap.values()];
      const value = {updatedAt:data.updatedAt, cues:await decorate(combine(old?.cues,data.cues),[],gaps), gaps};
      const saved = await bucket.put(key,JSON.stringify(value),{onlyIf:condition(previous), httpMetadata:{contentType:jsonHeaders['Content-Type']}});
      return saved ? new Response(null,{status:204,headers}) : error(409,'Concurrent recovery');
    }
    if (data?.purpose || !validate(data, meeting, clock())) return error(400, 'Invalid captions');
    const previous = await bucket.get(storageKey);
    if (previous && Date.parse(previous.customMetadata.updatedAt) >= Date.parse(data.updatedAt)) return error(409, 'A newer snapshot is available');
    const saved = await writeSnapshot(bucket, storageKey, previous, data, decorate);
    return saved ? new Response(null, {status:204, headers}) : error(409, 'Concurrent update');
  }
  return {async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/vod/resolve') return resolveArchiveVideo ? resolveArchiveVideo(request) : error(503,'VOD lookup unavailable');
    if (url.pathname === '/api/live/nameplates') {
      const result = await nameplates(request, env.BUCKET, url, meetings, publicKey, clock, verifySignature);
      if (request.method === 'PUT' && result.ok) visualCache.delete(url.searchParams.get('meetingId'));
      return result;
    }
    if (['/api/live/captions','/api/live/minutes','/api/live/minutes/recover'].includes(url.pathname)) return captions(request, env.BUCKET, url);
    if (!['HEAD', 'GET'].includes(request.method)) return error(405, 'Method not allowed');
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!Object.hasOwn(assets, path)) return error(404, 'Not found');
    const asset = assets[path];
    const bytes = request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.body), c => c.charCodeAt(0));
    return new Response(bytes, {headers:{'Content-Type':asset.type,'X-Content-Type-Options':'nosniff'}});
  }};
}
