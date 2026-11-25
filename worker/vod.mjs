// Resolve only official Seongnam VOD metadata; do not proxy arbitrary URLs.
const PAGE_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'}
  });
}

function parseHeader(html, id) {
  const header = html.match(/<div\b[^>]*class\s*=\s*["'][^"']*\bplay_area\b[^"']*["'][^>]*>[\s\S]*?<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/i);
  if (!header) return {title:`성남시의회 회의 ${id}`, date:null};
  const value = header[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
  const match = value.match(/\[\s*(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:\s+[^\]]*)?\s*\]/);
  let date = null;
  if (match) {
    const year=Number(match[1]), month=Number(match[2]), day=Number(match[3]);
    const parsed = new Date(Date.UTC(year,month-1,day));
    if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month-1 && parsed.getUTCDate() === day)
      date = `${match[1]}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  const title = (match ? value.replace(match[0], '') : value).trim();
  return {title: title && title.length <= 150 ? title : `성남시의회 회의 ${id}`, date};
}

function parsePlayer(html) {
  // Capture quoted literal arguments only; never execute official page scripts.
  const pattern = /\bplayer\s*\(\s*(["'])[^"'\r\n]{1,256}\1\s*,\s*(["'])mp4:\2\s*,\s*(["'])([A-Z][0-9]{4}\/)\3\s*,\s*(["'])([A-Za-z0-9_-]{1,100}\.mp4)\5\s*,/g;
  const matches = [...html.matchAll(pattern)];
  if (matches.length !== 1) return null;
  return `https://cast.sncouncil.go.kr:4443/vod/_definst_/mp4:${matches[0][4]}${matches[0][6]}/playlist.m3u8`;
}

async function boundedBody(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > PAGE_LIMIT) throw new Error('oversize');
  if (!response.body) throw new Error('missing body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PAGE_LIMIT) { await reader.cancel(); throw new Error('oversize'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
  return new TextDecoder('utf-8').decode(bytes);
}

export async function resolveVod(request, fetcher=fetch, index) {
  if (request.method !== 'GET') return json(405,{error:'method_not_allowed'});
  let url;
  try { url = new URL(request.url); } catch { return json(400,{error:'invalid_request'}); }
  const values=url.searchParams.getAll('id');
  if (url.pathname !== '/api/vod/resolve' || values.length !== 1 ||
      [...url.searchParams.keys()].some(key=>key !== 'id') || !/^[1-9][0-9]{0,7}$/.test(values[0]))
    return json(400,{error:'invalid_id'});
  const id=values[0];
  const indexed=index?.get(id);
  if (indexed) return json(200,{...indexed,members:[],cues:[]});
  const officialPage=`https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=${id}&position=0`;
  const controller=new AbortController();
  let timer;
  try {
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort(); reject(new Error('timeout'));},REQUEST_TIMEOUT_MS);});
    const task=(async()=>{
      const response=await fetcher(officialPage,{method:'GET',redirect:'manual',signal:controller.signal});
      if (response.status === 404 || response.status === 410) return json(404,{error:'vod_not_found'});
      if (!response.ok || response.redirected || (response.status >= 300 && response.status < 400))
        return json(502,{error:'official_source_unavailable'});
      const html=await boundedBody(response);
      const playlist=parsePlayer(html);
      if (!playlist) return json(404,{error:'vod_not_found'});
      const {title,date}=parseHeader(html,id);
      return json(200,{id,title,date,officialPage,playlist,members:[],cues:[]});
    })();
    return await Promise.race([task,timeout]);
  } catch (error) {
    return json(error?.message === 'timeout' || error?.name === 'AbortError' ? 504 : 502,
      {error:error?.message === 'timeout' || error?.name === 'AbortError' ? 'official_source_timeout' : 'official_source_unavailable'});
  } finally { clearTimeout(timer); }
}
