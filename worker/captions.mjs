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

export function createSite({assets, meetings, publicKey}, clock = Date.now) {
  let verifier;
  async function captions(request, bucket, url) {
    const id = url.searchParams.get('meetingId') ?? meetings[0]?.id;
    const meeting = meetings.find(item => item.id === id);
    if (!meeting) return error(404, 'Unknown meeting');
    if (!bucket) return error(503, 'Captions storage unavailable');
    const storageKey = 'council-captions/' + id + '.json';
    if (request.method === 'GET' || request.method === 'HEAD') {
      const object = await bucket.get(storageKey);
      if (!object) return error(404, 'Captions have not started');
      return new Response(request.method === 'HEAD' ? null : object.body, {headers: jsonHeaders});
    }
    if (request.method !== 'PUT') return new Response(null, {status:405, headers:{...headers, Allow:'GET, HEAD, PUT'}});
    const signature = request.headers.get('X-Council-Signature') || '';
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return error(401, 'Invalid signature');
    const bytes = await readBytes(request);
    if (!bytes) return error(413, 'Invalid body size');
    verifier ??= crypto.subtle.importKey('raw', fromBase64url(publicKey), 'Ed25519', false, ['verify']);
    if (!await crypto.subtle.verify('Ed25519', await verifier, fromBase64url(signature), bytes)) return error(401, 'Invalid signature');
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
    catch { return error(400, 'Invalid JSON'); }
    if (!validate(data, meeting, clock())) return error(400, 'Invalid captions');
    const previous = await bucket.head(storageKey);
    if (previous && Date.parse(previous.customMetadata.updatedAt) >= Date.parse(data.updatedAt)) return error(409, 'A newer snapshot is available');
    const onlyIf = previous ? {etagMatches:previous.etag} : new Headers({'If-None-Match':'*'});
    const saved = await bucket.put(storageKey, bytes, {onlyIf, customMetadata:{updatedAt:data.updatedAt}, httpMetadata:{contentType:jsonHeaders['Content-Type']}});
    return saved ? new Response(null, {status:204, headers}) : error(409, 'Concurrent update');
  }
  return {async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/live/captions') return captions(request, env.BUCKET, url);
    if (!['HEAD', 'GET'].includes(request.method)) return error(405, 'Method not allowed');
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!Object.hasOwn(assets, path)) return error(404, 'Not found');
    const asset = assets[path];
    const bytes = request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.body), c => c.charCodeAt(0));
    return new Response(bytes, {headers:{'Content-Type':asset.type,'X-Content-Type-Options':'nosniff'}});
  }};
}
