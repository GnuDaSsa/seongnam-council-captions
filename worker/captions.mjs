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

function validate(data, meeting, now, validateAcousticProof, validatePodiumProof) {
  const time = Date.parse(data?.updatedAt);
  if (data?.meetingId !== meeting.id || !Number.isFinite(time) || Math.abs(now - time) > 120000) return false;
  if (time < Date.parse(meeting.scheduledAt) || time > Date.parse(meeting.endsAt) + 120000) return false;
  if (!['live', 'listening', 'ended', 'interrupted'].includes(data.status) || !Array.isArray(data.cues) || data.cues.length > 700) return false;
  for (const field of ['captureGapStart','captureGapEnd']) {
    if (!Object.hasOwn(data, field)) continue;
    const boundary = data[field], instant = typeof boundary === 'string' ? Date.parse(boundary) : NaN;
    if (!Number.isFinite(instant) || new Date(instant).toISOString() !== boundary ||
        instant < Date.parse(meeting.scheduledAt) || instant > time || data.purpose ||
        (field === 'captureGapStart' ? data.status !== 'interrupted' : !['live','listening'].includes(data.status))) return false;
  }
  const ids = new Set();
  const validText = s => typeof s === 'string' && s.trim().length > 0 && s.length <= 2000;
  let lastStart = -1;
  for (const cue of data.cues) {
    if (!cue || typeof cue.id !== 'string' || !cue.id || cue.id.length > 100 || ids.has(cue.id)) return false;
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || cue.start < lastStart || cue.end > 86400) return false;
    if (!validText(cue.rawText) || !validText(cue.text) || !Array.isArray(cue.flags) || cue.flags.length > 12 || cue.flags.some(f => !validText(f) || f.length > 80)) return false;
    const anchor=Object.hasOwn(cue,'audioAnchor'), continuation=Object.hasOwn(cue,'audioContinuation');
    if (anchor || continuation) {
      if ((anchor && continuation) || !validateAcousticProof ||
          !validateAcousticProof(anchor ? cue.audioAnchor : cue.audioContinuation, continuation)) return false;
    }
    if (Object.hasOwn(cue,'audioPodium') && !validatePodiumProof?.(cue.audioPodium)) return false;
    ids.add(cue.id);
    lastStart = cue.start;
  }
  return true;
}

const pageSize = 100;
const speakerContextPages = 4;
const speakerContextSize = speakerContextPages * pageSize;
const speakerContextVersion = 1;
const jsonBody = async object => object ? new Response(object.body).json() : null;
function combine(...groups) {
  const cues = new Map();
  for (const group of groups) for (const cue of group || []) cues.set(cue.id, cue);
  return [...cues.values()].sort((a,b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
}
function retainSpeakerContext(cues) {
  return cues.slice(-speakerContextSize).map(cue=>{
    const {id,start,end,text,flags,observedAt,rejected,rawText,audioAnchor,audioContinuation,audioPodium}=cue;
    return {id,start,end,text,flags,observedAt,rejected,rawText,audioAnchor,audioContinuation,audioPodium};
  });
}
async function recentSpeakerContext(bucket,state) {
  const existing=Array.isArray(state?.speakerContext) ? state.speakerContext.slice(-speakerContextSize) : [];
  const pages=state?.pages || [];
  if (!pages.length || (state.speakerContextSize===speakerContextSize &&
      state.speakerContextVersion===speakerContextVersion)) return {cues:existing,ready:true};
  // Earlier caches may be short or lack the original words. The immutable
  // pages take precedence, and a later request can retry unavailable pages.
  const reads=await Promise.allSettled(pages.slice(-speakerContextPages).map(async key=>jsonBody(await bucket.get(key))));
  const restored=reads.filter(result=>result.status==='fulfilled' && Array.isArray(result.value) &&
    result.value.length && result.value.every(cue=>typeof cue?.id==='string')).map(result=>result.value);
  return {cues:retainSpeakerContext(combine(existing,...restored)),ready:restored.length===reads.length};
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
const invalidCaptureGap = Symbol('invalid capture gap');
function recordCaptureGap(gaps, old, data) {
  const last = gaps.at(-1);
  if (data.captureGapStart) {
    // Previously acknowledged audio can end before its HTTP publication time.
    // The cue clock is rounded to milliseconds in the publisher.
    const boundary = Date.parse(data.captureGapStart);
    const overlaps = (old?.cues || []).some(cue =>
      Date.parse(cue.observedAt) + Math.round((cue.end - cue.start) * 1000) > boundary + 2);
    if (overlaps || (last?.end && Date.parse(last.end) > boundary)) return false;
    if (last && !last.end) return last.start === data.captureGapStart;
  }
  if (data.captureGapEnd) {
    if (old?.status !== 'interrupted') return last?.end === data.captureGapEnd;
    if (Date.parse(data.captureGapEnd) < Date.parse(last?.start || old.updatedAt)) return false;
  }
  if (data.status === 'interrupted' && old?.status !== 'interrupted') {
    const start = data.captureGapStart || old?.updatedAt;
    if (start) gaps.push({start, end:null, reason:'interrupted'});
  } else if (old?.status === 'interrupted' && ['listening','live'].includes(data.status)) {
    const end = data.captureGapEnd || data.updatedAt;
    if (last && !last.end) last.end = end;
    else gaps.push({start:old.updatedAt, end, reason:'interrupted'});
  } else if (old && old.status !== 'interrupted' && Date.parse(data.updatedAt) - Date.parse(old.updatedAt) > 120000) {
    gaps.push({start:old.updatedAt, end:data.updatedAt, reason:'updates_missing'});
  }
  return true;
}
async function writeSnapshot(bucket, key, previous, data, decorate, meeting) {
  const old = await jsonBody(previous);
  const pages = [...(old?.pages || [])], gaps = [...(old?.gaps || [])];
  // The producer repeats the tail on every heartbeat. Sealed pages always end
  // before the oldest of the most recent 100 cues, including on restart.
  let tail = combine(old?.cues, data.cues);
  if (old?.sealedThrough != null) tail = tail.filter(c => c.start >= old.sealedThrough);
  if (!recordCaptureGap(gaps, old, data)) return invalidCaptureGap;
  let sealedThrough = old?.sealedThrough ?? null;
  const context=await recentSpeakerContext(bucket,old);
  let speakerContext = context.cues;
  tail = await decorate(tail, speakerContext, gaps);
  while (tail.length >= pageSize * 2) {
    let cut = pageSize;
    while (cut < tail.length - pageSize && tail[cut - 1].start === tail[cut].start) cut++;
    if (tail[cut - 1].start === tail[cut].start) break;
    pages.push(await sealPage(bucket, data.meetingId, tail.slice(0,cut)));
    // Retain enough raw dialogue to recover the active questioner after sealing.
    speakerContext = retainSpeakerContext([...speakerContext,...tail.slice(0,cut)]);
    tail = tail.slice(cut);
    sealedThrough = tail[0].start;
  }
  const state = {...snapshot(data,tail),pages,sealedThrough,gaps,speakerContext,speakerContextSize:context.ready?speakerContextSize:0,
    speakerContextVersion:context.ready?speakerContextVersion:0,
    archiveMeeting:old?.archiveMeeting || archiveMetadata(meeting)};
  if (state.archiveMeeting && Array.isArray(meeting.members)) {
    // Retain the roster supplied by this site's schedule when the next meeting replaces it.
    const {members,staffRoster,registeredVodStaffRoster,date,vodId,liveMeetingId}=meeting;
    state.archiveSpeakerRoster={members,staffRoster,registeredVodStaffRoster,date,vodId,liveMeetingId};
  } else if (old?.archiveSpeakerRoster) state.archiveSpeakerRoster=old.archiveSpeakerRoster;
  const customMetadata = {updatedAt:data.updatedAt};
  if (state.archiveMeeting && state.cues.length) {
    const last = latestCaptureTime(state.cues);
    if (Number.isFinite(last)) {
      const summary = {meetingId:state.meetingId, updatedAt:state.updatedAt, status:state.status,
        archiveMeeting:state.archiveMeeting, lastCapturedAt:new Date(last).toISOString()};
      const encoded = JSON.stringify(summary);
      if (new TextEncoder().encode(encoded).length < 1500) customMetadata.archiveV1 = encoded;
    }
  }
  return bucket.put(key, JSON.stringify(state), {onlyIf:condition(previous), customMetadata, httpMetadata:{contentType:jsonHeaders['Content-Type']}});
}
const archiveLifetime = 14 * 24 * 60 * 60 * 1000;
function archiveMetadata(meeting) {
  if (!meeting || !/^[1-9]\d{0,11}$/.test(meeting.id || '') || typeof meeting.title !== 'string' ||
      !meeting.title.trim() || meeting.title.length>240 || !Number.isFinite(Date.parse(meeting.scheduledAt))) return null;
  try {
    const url=new URL(meeting.officialPage);
    if (url.origin!=='https://cast.sncouncil.go.kr' || url.pathname!=='/live/flashPlayer.jsp' ||
        url.username || url.password || url.searchParams.getAll('live_no').length!==1 || url.searchParams.get('live_no')!==meeting.id) return null;
    return {id:meeting.id,title:meeting.title.trim(),label:typeof meeting.label==='string'?meeting.label.slice(0,240):'',
      scheduledAt:meeting.scheduledAt,endsAt:Number.isFinite(Date.parse(meeting.endsAt))?meeting.endsAt:null,
      officialPage:'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no='+meeting.id};
  } catch { return null; }
}
function latestCaptureTime(cues) {
  let last = -Infinity;
  for (const cue of cues) {
    const time = Date.parse(cue.observedAt);
    if (time > last) last = time;
  }
  return last;
}
function archiveListingState(object) {
  if (typeof object.customMetadata?.archiveV1 !== 'string') return null;
  try {
    const record = JSON.parse(object.customMetadata.archiveV1);
    if (!record || object.key !== 'council-captions/' + record.meetingId + '.json' ||
        archiveMetadata(record.archiveMeeting)?.id !== record.meetingId ||
        !['ended','interrupted','live','listening'].includes(record.status) ||
        !Number.isFinite(Date.parse(record.updatedAt)) || !Number.isFinite(Date.parse(record.lastCapturedAt))) return null;
    return {...record, cues:[{observedAt:record.lastCapturedAt}]};
  } catch { return null; }
}
function archiveRecord(state, meeting, now) {
  if (!state || !['ended','interrupted','live','listening'].includes(state.status) || !Array.isArray(state.cues) || !state.cues.length) return null;
  const metadata=archiveMetadata(state.archiveMeeting) || archiveMetadata(meeting);
  if (!metadata || metadata.id!==state.meetingId) return null;
  const stale=['live','listening'].includes(state.status);
  if (stale && (!Number.isFinite(Date.parse(metadata.endsAt)) || now<=Date.parse(metadata.endsAt)+120000)) return null;
  const last = latestCaptureTime(state.cues);
  const updated=Date.parse(state.updatedAt);
  if (!Number.isFinite(last) || !Number.isFinite(updated) || last>updated+120000) return null;
  const anchor=state.status==='ended' ? updated : last;
  if (anchor>now+120000 || now>=anchor+archiveLifetime) return null;
  return {...metadata,status:stale?'unknown':state.status,lastCapturedAt:new Date(last).toISOString(),
    completionAt:state.status==='ended'?new Date(updated).toISOString():null,expiresAt:new Date(anchor+archiveLifetime).toISOString()};
}
async function minutes(bucket, state, id, attribute) {
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
  const gaps = [...gapMap.values()].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
  const labeled = attribute ? await attribute(cues, [], gaps) : cues;
  const data = snapshot(state || {meetingId:id,updatedAt:initial.updatedAt,status:'interrupted'},labeled);
  if (attribute) data.speakerAttributionApplied = true;
  return Response.json({...data,coverageStart:cues[0]?.observedAt || null,gaps},{headers:jsonHeaders});
}

const nameplateMaxBytes = 128 * 1024;
const nameplateMaxBatch = 100;
const nameplateMaxObservations = 24 * 60 * 3; // one sample per 20 seconds for a full day
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

export function createSite({assets, meetings, archiveMeetings = [], publicKey, attributeSpeakers, validateAcousticProof, validatePodiumProof, resolveArchiveVideo, resolveArchiveTranscript, dailyCatalog, reportHandler}, clock = Date.now) {
  let verifier;
  const visualCache = new Map();
  const archiveMetadataById = new Map([...archiveMeetings,...meetings].map(archiveMetadata).filter(Boolean).map(m=>[m.id,m]));
  function historicalDecorator(bucket, id, state) {
    if (!attributeSpeakers) return null;
    const active=meetings.find(item=>item.id===id);
    if (active) return createDecorator(bucket, active);
    const metadata=archiveMetadata(state?.archiveMeeting), roster=state?.archiveSpeakerRoster;
    return metadata?.id===id && Array.isArray(roster?.members) ? createDecorator(bucket, {...roster,...metadata}) : null;
  }
  async function archive(request, bucket, url) {
    if (!bucket || typeof bucket.list !== 'function') return error(503,'Archive storage unavailable');
    if (!['GET','HEAD'].includes(request.method)) return error(405,'Read only');
    if (url.search) return error(400,'Invalid archive request');
    if (url.pathname==='/api/archive/catalog') {
      let cursor, count=0, objects=[], pages=0;
      try {
        do {
          if (++pages>100) return error(503,'Archive listing limit reached');
          const page=await bucket.list({prefix:'council-captions/',limit:1000,include:['customMetadata'],...(cursor?{cursor}:{})});
          if (!Array.isArray(page.objects)) throw Error('invalid listing');
          count+=page.objects.length;
          if (count>10000) return error(503,'Archive listing limit reached');
          objects.push(...page.objects.filter(o=>/^council-captions\/[1-9]\d{0,11}\.json$/.test(o.key) &&
            (!Number.isFinite(Date.parse(o.customMetadata?.updatedAt)) || Date.parse(o.customMetadata.updatedAt)+archiveLifetime>clock())));
          cursor=page.truncated?page.cursor:null;
          if (page.truncated && !cursor) throw Error('missing cursor');
        } while (cursor);
        if (objects.length>2000) return error(503,'Archive request limit reached');
        const rows=[];
        for (let i=0;i<objects.length;i+=20) {
          const states=await Promise.all(objects.slice(i,i+20).map(async object=>
            archiveListingState(object) || jsonBody(await bucket.get(object.key))));
          for (const state of states) {
            if (!state) continue;
            const row=archiveRecord(state,archiveMetadataById.get(state.meetingId),clock());
            if (row) rows.push(row);
          }
        }
        rows.sort((a,b)=>Date.parse(b.lastCapturedAt)-Date.parse(a.lastCapturedAt)||a.id.localeCompare(b.id));
        return request.method==='HEAD' ? new Response(null,{headers:jsonHeaders}) : Response.json({meetings:rows},{headers:jsonHeaders});
      } catch { return error(503,'Archive listing unavailable'); }
    }
    const match=url.pathname.match(/^\/api\/archive\/meetings\/([1-9]\d{0,11})$/);
    if (!match) return error(404,'Archive not found');
    try {
      const id = match[1], key = 'council-captions/' + id + '.json';
      const original = await bucket.get(key), state = await jsonBody(original);
      const row=archiveRecord(state,archiveMetadataById.get(id),clock());
      if (!row) return error(404,'Archive unavailable or expired');
      if (request.method==='HEAD') return new Response(null,{headers:jsonHeaders});
      const response=await minutes(bucket,state,id,historicalDecorator(bucket,id,state));
      if (!response.ok) return response;
      const data=await response.json();
      const latest = await bucket.get(key);
      const current = await jsonBody(latest);
      if (!archiveRecord(current,archiveMetadataById.get(id),clock())) return error(404,'Archive unavailable or expired');
      if (current.updatedAt !== state.updatedAt || current.status !== state.status ||
          (original.etag && latest.etag !== original.etag)) return error(409,'Archive changed during read');
      return Response.json({meeting:row,minutes:data},{headers:jsonHeaders});
    } catch { return error(503,'Archive unavailable'); }
  }
  async function visualEvidence(bucket, meeting) {
    const cached = visualCache.get(meeting.id);
    if (cached && clock() < cached.expires) return cached.rows;
    let rows = [];
    try {
      const data = await jsonBody(await bucket.get(nameplateKey(meeting.id)));
      if (data && validStoredNameplates(data, meeting)) rows = data.observations;
    } catch { /* Text-based attribution still works when camera evidence is unavailable. */ }
    visualCache.set(meeting.id, {expires:clock() + 3000, rows});
    return rows;
  }
  function createDecorator(bucket, meeting) {
    return async function decorate(cues, context, gaps, visual) {
      const raw = cues.map(({speaker, ...cue}) => cue);
      if (!attributeSpeakers || !raw.length) return raw;
      try {
        const speakers = attributeSpeakers(meeting, [...context, ...raw], visual ?? await visualEvidence(bucket, meeting), gaps);
        return raw.map(cue => Object.hasOwn(speakers, cue.id) && speakers[cue.id] ? {...cue, speaker:speakers[cue.id]} : cue);
      } catch { return raw; }
    };
  }
  async function verifySignature(key, signature, bytes) {
    verifier ??= crypto.subtle.importKey('raw', fromBase64url(key), 'Ed25519', false, ['verify']);
    return crypto.subtle.verify('Ed25519', await verifier, fromBase64url(signature), bytes);
  }
  async function captions(request, bucket, url, scheduledMeetings) {
    const id = url.searchParams.get('meetingId') ?? scheduledMeetings[0]?.id;
    const meeting = scheduledMeetings.find(item => item.id === id);
    const isMinutes = url.pathname === '/api/live/minutes';
    const isRecovery = url.pathname === '/api/live/minutes/recover';
    if (!meeting && !(isMinutes && request.method === 'GET' && /^\d{1,12}$/.test(id))) return error(404, 'Unknown meeting');
    if (!bucket) return error(503, 'Captions storage unavailable');
    const storageKey = 'council-captions/' + id + '.json';
    if (isMinutes) {
      if (request.method !== 'GET') return error(405,'Read only');
      const state=await jsonBody(await bucket.get(storageKey));
      return minutes(bucket,state,id,historicalDecorator(bucket,id,state));
    }
    const decorate = createDecorator(bucket, meeting);
    if (!isRecovery && (request.method === 'GET' || request.method === 'HEAD')) {
      const object = await bucket.get(storageKey);
      if (!object) return error(404, 'Captions have not started');
      if (request.method === 'HEAD') return new Response(null,{headers:jsonHeaders});
      const current = await jsonBody(object);
      const [context, visual] = await Promise.all([recentSpeakerContext(bucket,current), visualEvidence(bucket,meeting)]);
      const labeled = await decorate(current.cues,context.cues,current.gaps || [],visual);
      const live=snapshot(current,labeled.slice(-pageSize));
      if (visual.length) live.nameplateStatus={latest:visual.at(-1),lastMatch:visual.findLast(row=>row.matchedMembers.length>0)||null};
      return Response.json(live,{headers:jsonHeaders});
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
      if (data?.purpose !== 'restore-captured-cues' || !validate(data,meeting,clock(),validateAcousticProof,validatePodiumProof)) return error(400,'Invalid recovery');
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
    if (data?.purpose || !validate(data, meeting, clock(),validateAcousticProof,validatePodiumProof)) return error(400, 'Invalid captions');
    const previous = await bucket.get(storageKey);
    if (previous && Date.parse(previous.customMetadata.updatedAt) >= Date.parse(data.updatedAt)) return error(409, 'A newer snapshot is available');
    const saved = await writeSnapshot(bucket, storageKey, previous, data, decorate, meeting);
    if (saved === invalidCaptureGap) return error(400, 'Invalid capture gap');
    return saved ? new Response(null, {status:204, headers}) : error(409, 'Concurrent update');
  }
  return {async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/reports' || url.pathname.startsWith('/api/reports/')) {
      return reportHandler ? reportHandler(request,env,clock) : error(503,'Reports unavailable');
    }
    if (url.pathname.startsWith('/api/archive/')) return archive(request,env.BUCKET,url);
    if (url.pathname === '/api/vod/resolve') return resolveArchiveVideo ? resolveArchiveVideo(request) : error(503,'VOD lookup unavailable');
    if (url.pathname === '/api/vod/transcript') return resolveArchiveTranscript ? resolveArchiveTranscript(request) : error(503,'VOD transcript unavailable');
    const isSchedule = url.pathname === '/api/live/schedule' || (dailyCatalog && url.pathname === '/data/live-meetings.json');
    const isCaption = ['/api/live/captions','/api/live/minutes','/api/live/minutes/recover'].includes(url.pathname);
    const isNameplate = url.pathname === '/api/live/nameplates';
    let scheduledMeetings = meetings;
    if (dailyCatalog && (isSchedule || isCaption || isNameplate)) {
      if (isSchedule && !['GET','HEAD'].includes(request.method)) return error(405,'Read only');
      const id = url.searchParams.get('meetingId');
      if (id !== null && !/^[1-9]\d{0,11}$/.test(id)) return error(400,'Invalid meeting');
      // Stored minutes already contain their original roster and date.
      if (!(id && url.pathname === '/api/live/minutes' && request.method === 'GET')) {
        let catalog;
        try { catalog = id ? await dailyCatalog.forId(env.BUCKET,id) : await dailyCatalog.today(env.BUCKET); }
        catch { return error(503,'Official schedule unavailable'); }
        if (!catalog) return error(404,'Unknown meeting');
        if (isSchedule) return request.method === 'HEAD' ? new Response(null,{headers:jsonHeaders}) : Response.json(catalog,{headers:jsonHeaders});
        scheduledMeetings = catalog.meetings;
      }
    }
    if (isNameplate) {
      const result = await nameplates(request, env.BUCKET, url, scheduledMeetings, publicKey, clock, verifySignature);
      if (request.method === 'PUT' && result.ok) visualCache.delete(url.searchParams.get('meetingId'));
      return result;
    }
    if (isCaption) return captions(request, env.BUCKET, url, scheduledMeetings);
    if (!['HEAD', 'GET'].includes(request.method)) return error(405, 'Method not allowed');
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!Object.hasOwn(assets, path)) return error(404, 'Not found');
    const asset = assets[path];
    const bytes = request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.body), c => c.charCodeAt(0));
    return new Response(bytes, {headers:{'Content-Type':asset.type,'X-Content-Type-Options':'nosniff'}});
  }};
}
