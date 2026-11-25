// Resolve only official Seongnam VOD metadata; do not proxy arbitrary URLs.
const CAST_VOD_BASE = 'https://cast.sncouncil.go.kr/vod/';
const PAGE_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const TIMELINE_LIMIT = 64 * 1024;
const TIMELINE_TIMEOUT_MS = 2500;
const TURN_LIMIT = 1000;
const TURN_TEXT_LIMIT = 8000;
const TRANSCRIPT_TEXT_LIMIT = 240000;

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

async function boundedBody(response, limit = PAGE_LIMIT) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limit) throw new Error('oversize');
  if (!response.body) throw new Error('missing body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('oversize'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
  return new TextDecoder('utf-8').decode(bytes);
}

const castPage = id => `${CAST_VOD_BASE}vod_view.jsp?pk_vod_no=${id}&position=0`;

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
  const officialPage=castPage(id);
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

async function readTranscriptSource(fetcher, url, limit, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
    });
    const task = (async () => {
      const response = await fetcher(url, {method:'GET', redirect:'manual', signal:controller.signal});
      if (response.status === 404 || response.status === 410) return null;
      if (!response.ok || response.redirected || (response.url && response.url !== url)) throw new Error('unavailable');
      return boundedBody(response, limit);
    })();
    return await Promise.race([task, deadline]);
  } finally { clearTimeout(timer); }
}

const NAMED_ENTITIES = {
  amp:'&', nbsp:' ', lt:'<', gt:'>', quot:'"', apos:"'", middot:'·',
  lsquo:'‘', rsquo:'’', ldquo:'“', rdquo:'”', ndash:'–', mdash:'—', hellip:'…',
};

function transcriptText(markup) {
  return markup.replace(/<br\b[^<>]*>|<\/(?:p|div|li)\s*>/gi, '\n').replace(/<[^<>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, value) => {
      const key = value.toLowerCase();
      if (Object.hasOwn(NAMED_ENTITIES,key)) return NAMED_ENTITIES[key];
      if (!key.startsWith('#')) return entity;
      const point = key.startsWith('#x') ? Number.parseInt(key.slice(2),16) : Number(key.slice(1));
      if (point < 1 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return entity;
      return String.fromCodePoint(point);
    })
    .replace(/[\u00a0\t]/g, ' ').replace(/\r\n?/g, '\n');
}

function transcriptChapters(html) {
  const sanitized = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const chapters = new Map();
  let active = null, depth = 0;
  for (const token of sanitized.matchAll(/<\/?span\b(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/gi)) {
    const tag = token[0];
    if (tag.startsWith('</')) {
      if (active && --depth === 0) {
        active.chapter[active.field] = transcriptText(sanitized.slice(active.start,token.index));
        active = null;
      }
      continue;
    }
    const match = tag.match(/\sid\s*=\s*(["'])contents_(title|view)_(\d{1,4})\1/i);
    if (active) {
      if (match) return [];
      depth++;
      continue;
    }
    if (!match) continue;
    const index = Number(match[3]), field = match[2].toLowerCase();
    let chapter = chapters.get(index);
    if (!chapter) { chapter = {index}; chapters.set(index,chapter); }
    if (Object.hasOwn(chapter,field)) return [];
    active = {chapter,field,start:token.index + tag.length};
    depth = 1;
  }
  if (active) return [];
  return [...chapters.values()].filter(chapter => typeof chapter.view === 'string').sort((a,b) => a.index - b.index);
}

const MEMBER_TITLES = '부위원장|위원장|부의장|의장|의원|위원';
const SPEAKER_TITLES = MEMBER_TITLES + '|시장|부시장|담당관|주무관|센터장|팀장|과장|국장|부장|실장|소장|단장|관장|본부장|대표이사|이사장|사장|전문위원';
const ROLE_THEN_NAME = new RegExp('^([가-힣·ㆍ ]{0,30}(?:' + SPEAKER_TITLES + ')) ([가-힣]{2,4})$');
const NAME_THEN_ROLE = new RegExp('^([가-힣]{2,4}) ?(' + MEMBER_TITLES + ')$');

function speakerHeading(label) {
  const value = label.trim().replace(/\s+/g, ' ');
  const roleFirst = value.match(ROLE_THEN_NAME);
  if (roleFirst) return {name:roleFirst[2],role:roleFirst[1]};
  const nameFirst = value.match(NAME_THEN_ROLE);
  if (nameFirst) return {name:nameFirst[1],role:nameFirst[2]};
}

function transcriptTurns(chapters) {
  const turns = [];
  let remaining = TRANSCRIPT_TEXT_LIMIT;
  for (const chapter of chapters) {
    let speaker = chapter.title?.trim().startsWith('○') ? speakerHeading(chapter.title.trim().slice(1)) : null;
    let lines = [];
    function appendTurn() {
      if (!speaker || remaining <= 0 || turns.length >= TURN_LIMIT) return;
      const text = lines.join('\n').trim().slice(0,Math.min(TURN_TEXT_LIMIT,remaining));
      if (!text) return;
      turns.push({index:chapter.index,...speaker,text});
      remaining -= text.length;
    }
    for (const line of chapter.view.split('\n')) {
      const value = line.trimStart();
      if (!value.startsWith('○')) { lines.push(line); continue; }
      appendTurn();
      const heading = value.slice(1).trimStart(), separator = heading.search(/ {2,}/);
      speaker = speakerHeading(separator < 0 ? heading : heading.slice(0,separator));
      lines = separator < 0 ? [] : [heading.slice(separator).trimStart()];
    }
    appendTurn();
    if (!remaining || turns.length >= TURN_LIMIT) break;
  }
  return turns;
}

function officialTimeline(html, chapters, data) {
  const starts = data?.start_times, ends = data?.end_times;
  if (data?.success !== true || !Array.isArray(starts) || !Array.isArray(ends) ||
      starts.length !== chapters.length || ends.length !== chapters.length) return null;
  const positions = [];
  for (const [,quoted,singleQuoted] of html.matchAll(/<li\b[^<>]*?\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const classes = quoted ?? singleQuoted;
    if (!/\bgoto_chapter_btn\b/.test(classes)) continue;
    const match = classes.match(/\bposition:\s*['"](\d+)['"]/);
    positions.push(match ? Number(match[1]) : NaN);
  }
  if (positions.length && positions.length !== starts.length) return null;
  for (const [index,chapter] of chapters.entries()) {
    if (chapter.index !== index || !Number.isSafeInteger(starts[index]) || !Number.isSafeInteger(ends[index]) ||
        starts[index] < 0 || ends[index] <= starts[index] || ends[index] > 86400 ||
        (index > 0 && starts[index] < starts[index-1]) || (positions.length && positions[index] !== starts[index])) return null;
  }
  return {starts,ends};
}

export async function resolveVodTranscript(request, fetcher = fetch) {
  if (request.method !== 'GET') return json(405,{error:'method_not_allowed'});
  const url = new URL(request.url);
  const ids = url.searchParams.getAll('id');
  if (url.pathname !== '/api/vod/transcript' || ids.length !== 1 ||
      [...url.searchParams.keys()].some(key => key !== 'id') || !/^[1-9][0-9]{0,7}$/.test(ids[0]))
    return json(400,{error:'invalid_id'});
  const meetingId = ids[0], sourceUrl = castPage(meetingId);
  const result = {meetingId,sourceUrl,turns:[]};
  let html;
  try {
    html = await readTranscriptSource(fetcher,sourceUrl,PAGE_LIMIT,REQUEST_TIMEOUT_MS);
  } catch (error) {
    const timedOut = error?.message === 'timeout' || error?.name === 'AbortError';
    return json(timedOut ? 504 : 502,{error:timedOut ? 'official_source_timeout' : 'official_source_unavailable'});
  }
  if (!html) return json(200,result);
  // The official player binds its timeline to the video ID rendered in the page.
  const pageIds = [...html.matchAll(/\bgetTimelineList\s*\(\s*(?:(["'])(\d+)\1|(\d+))\s*\)/g)]
    .map(match => match[2] || match[3]);
  if (!pageIds.length || pageIds.some(id => id !== meetingId)) return json(200,result);
  const chapters = transcriptChapters(html), turns = transcriptTurns(chapters);
  if (!turns.length) return json(200,result);
  let timing = null;
  try {
    const timelineUrl = CAST_VOD_BASE + 'get_timeline_list_json.jsp?vod_no=' + meetingId;
    const data = await readTranscriptSource(fetcher,timelineUrl,TIMELINE_LIMIT,TIMELINE_TIMEOUT_MS);
    timing = officialTimeline(html,chapters,JSON.parse(data));
  } catch { /* An unavailable timeline leaves the published turn text untimed. */ }
  result.turns = turns.map(({index,...turn}) => timing ? {...turn,start:timing.starts[index],end:timing.ends[index]} : turn);
  return json(200,result);
}
