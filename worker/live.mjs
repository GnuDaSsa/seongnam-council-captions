// Only these fixed live-meeting objects can be written. The hash is injected at build time.
const WRITE_HASH = __LIVE_WRITE_HASH__;
const ASSETS = __STATIC_ASSETS__;
const DEADLINE = Date.parse('2026-11-25T15:00:00Z'); // midnight, 26 November, Seoul
const rules = {
  'captions': { type: 'application/json; charset=utf-8', max: 200 * 1024 },
  'playlist.m3u8': { type: 'application/vnd.apple.mpegurl', max: 32 * 1024 },
  'snapshot.jpg': { type: 'image/jpeg', max: 2 * 1024 * 1024 }
};
const segment = /^(?:[0-9]|1[01])\.ts$/;
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
async function authorized(request) {
  const header = request.headers.get('Authorization') || '';
  if (!/^Bearer [A-Za-z0-9_+/=-]{32,256}$/.test(header) || !/^[a-f0-9]{64}$/.test(WRITE_HASH)) return false;
  const actual = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(header.slice(7))));
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= actual.charCodeAt(i) ^ WRITE_HASH.charCodeAt(i);
  return difference === 0;
}
async function boundedBody(request, max) {
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader(), chunks = []; let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  if (!size) return null;
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
function validPayload(name, bytes) {
  if (name === 'captions') { try { JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); return true; } catch { return false; } }
  if (name === 'playlist.m3u8') {
    try {
      const text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
      return text.startsWith('#EXTM3U') && text.split(/\r?\n/).every(line => !line.trim() || line.startsWith('#') || segment.test(line.trim()));
    } catch { return false; }
  }
  if (name === 'snapshot.jpg') return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes[0] === 0x47;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname;
    if (path.startsWith('/api/live/')) {
      const name = path.slice('/api/live/'.length);
      const rule = Object.hasOwn(rules, name) ? rules[name] : (segment.test(name) ? {type:'video/mp2t', max:8 * 1024 * 1024} : null);
      if (!rule) return new Response('Not found', {status:404});
      if (Date.now() >= DEADLINE) return new Response('Not found', {status:404, headers:{'Cache-Control':'no-store'}});
      if (!env.BUCKET) return new Response('Storage unavailable', {status:503, headers:{'Cache-Control':'no-store'}});
      if (request.method === 'PUT') {
        if (!await authorized(request)) return new Response('Unauthorized', {status:401, headers:{'Cache-Control':'no-store'}});
        const body = await boundedBody(request, rule.max);
        if (!body) return new Response('Invalid or oversized body', {status:413});
        if (!validPayload(name, body)) return new Response('Invalid content', {status:400});
        await env.BUCKET.put('live-20261125/' + name, body, {httpMetadata:{contentType:rule.type}});
        return new Response(null, {status:204, headers:{'Cache-Control':'no-store'}});
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', {status:405, headers:{Allow:'GET, HEAD, PUT'}});
      const object = await env.BUCKET.get('live-20261125/' + name);
      if (!object || (name === 'playlist.m3u8' && Date.now() - new Date(object.uploaded).getTime() > 60000)) return new Response('Not found', {status:404, headers:{'Cache-Control':'no-store'}});
      return new Response(request.method === 'HEAD' ? null : object.body, {headers:{'Content-Type':rule.type, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}});
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', {status:405, headers:{Allow:'GET, HEAD'}});
    const asset = ASSETS[path === '/' ? '/index.html' : path];
    if (!asset) return new Response('Not found', {status:404});
    const bytes = Uint8Array.from(atob(asset.body), c => c.charCodeAt(0));
    return new Response(request.method === 'HEAD' ? null : bytes, {headers:{'Content-Type':asset.type, 'X-Content-Type-Options':'nosniff'}});
  }
};

