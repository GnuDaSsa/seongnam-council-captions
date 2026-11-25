// Resolve only official Seongnam VOD metadata; do not proxy arbitrary URLs.
const CAST_VOD_BASE = 'https://cast.sncouncil.go.kr/vod/';
const CAST_LIVE_PLAYER = 'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=';
const PAGE_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const TIMELINE_LIMIT = 64 * 1024;
const TIMELINE_TIMEOUT_MS = 2500;
const TURN_LIMIT = 2048;
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
  const value = transcriptText(header[1]).replace(/\s+/g, ' ').trim();
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

const ARCHIVE_BODIES = new Map([
  ['A0001','본회의'], ['A0002','의회운영위원회'], ['A0003','행정교육위원회'],
  ['A0004','경제환경위원회'], ['A0005','문화복지체육위원회'], ['A0006','도시건설위원회']
]);
const ARCHIVE_ROSTER_MAX_AGE_DAYS = 90;
const ARCHIVE_ROSTER_PUBLICATION_BUFFER_DAYS = 31;
const ARCHIVE_ROSTER_AVAILABILITY_BASIS = 'final-record-publication-allowance-plus-one-day';
const ARCHIVE_STAFF_BASIS = 'official-assigned-committee-support-team';
const ARCHIVE_STAFF_CONTACT_BASIS = 'official-recorded-committee-contact';
const ARCHIVE_FINAL_MINUTES_URL = /^https:\/\/(?:www\.)?sncouncil\.go\.kr\/record\/recordView\.do\?key=[a-f0-9]+$/;

function isoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(day) && new Date(day).toISOString().slice(0,10)===value ? day/86_400_000 : null;
}

function archiveRosterBody(meeting) {
  const folder=/^https:\/\/cast\.sncouncil\.go\.kr:4443\/vod\/_definst_\/mp4:(A\d{4})\/[\w-]+\.mp4\/playlist\.m3u8$/.exec(meeting.playlist||'')?.[1];
  const body=ARCHIVE_BODIES.get(folder);
  if (!body || typeof meeting.title!=='string') return null;
  const title=meeting.title.trim().replace(/\s+/g,' ').replace(/^제\s*\d+회(?:\s+(?:제\d+차\s+)?(?:임시회|정례회|임시|정례))?\s+/,'');
  const explicit=body==='본회의'
    ? /^(?:개회식 및 )?제\d+차 본회의(?: 및 폐회식)?$/.test(title)
    : new RegExp(`^(?:제\\d+차 ${body}(?: \\[폐회중\\])?|${body} 행정사무감사 제\\d+일차)$`).test(title);
  return explicit ? body : null;
}

function priorAssignedStaff(roster) {
  const staff=roster.staffRoster;
  if (roster.body==='본회의' || !Array.isArray(staff) || !staff.length || staff.length>20) return [];
  const officialRoles=new Set(['전문위원','주무관']);
  const named=new Set(roster.members);
  for (const row of staff) {
    if (typeof row?.name!=='string' || !/^[가-힣]{2,4}$/.test(row.name) || named.has(row.name) ||
        row.source!==roster.sourceUrl || row.candidateOnly!==true ||
        !officialRoles.has(row.officialRole)) return [];
    const exactAssignment=row.basis===ARCHIVE_STAFF_BASIS && row.roleBasis==='chair-assigned-role' && row.role===row.officialRole;
    const exactSelfIntro=(row.basis===ARCHIVE_STAFF_BASIS || row.basis===ARCHIVE_STAFF_CONTACT_BASIS) &&
      row.roleBasis==='recorded-self-introduction' && row.role===roster.body+' 담당';
    if (!exactAssignment && !exactSelfIntro) return [];
    named.add(row.name);
  }
  return staff.map(({name,role,officialRole,roleBasis,source,basis,candidateOnly})=>
    ({name,role,officialRole,roleBasis,source,basis,candidateOnly,committee:roster.body}));
}

const REGISTERED_STAFF_BASIS='public-registered-vod';

function withRegisteredVodStaff(meeting, body, date, rosters, registry) {
  if (!registry) return meeting;
  const {registeredVodStaffRoster:oldRegistry,...remaining}=meeting;
  const base=oldRegistry===undefined ? meeting : remaining;
  const day=isoDay(date);
  const terms=(rosters?.schemaVersion===1 && Array.isArray(rosters.terms) ? rosters.terms : []).filter(term=>{
    const first=isoDay(term?.start), last=isoDay(term?.end);
    return Number.isInteger(term?.number) && first!==null && last!==null && day!==null && first<=day && day<=last;
  });
  if (!body || body==='본회의' || base.staffRoster?.length || terms.length!==1 ||
      registry.schemaVersion!==1 || !Array.isArray(registry.snapshots)) return base;
  const [code]=[...ARCHIVE_BODIES].find(([,officialBody])=>officialBody===body)||[];
  const term=terms[0];
  const eligible=registry.snapshots.filter(row=>{
    if (row?.basis!==REGISTERED_STAFF_BASIS || row.body!==body || row.term!==term.number ||
        typeof row.vodId!=='string' || !/^[1-9]\d{0,7}$/.test(row.vodId) ||
        [base.id,base.liveMeetingId,base.vodId].some(id=>String(id)===row.vodId) ||
        !/^[가-힣]{2,4}$/.test(row.name||'') || base.members?.includes(row.name) ||
        !['주무관','전문위원'].includes(row.officialRole)) return false;
    const recorded=isoDay(row.recordedOn), registered=isoDay(row.registeredOn);
    if (recorded===null || registered===null || recorded<isoDay(term.start) || recorded>registered ||
        registered>=day || day-recorded>ARCHIVE_ROSTER_MAX_AGE_DAYS) return false;
    if (!code || typeof row.registryUrl!=='string' ||
        !new RegExp('^https://cast\\.sncouncil\\.go\\.kr/vod/simple_vod_list\\.jsp\\?sch_sub_bunru_no='+code+
          '(?:&pageNo=[1-9][0-9]{0,2})?$').test(row.registryUrl)) return false;
    const office=row.officeEvidence;
    return /^[a-f0-9]{64}$/.test(row.registryEntrySha256||'') && /^[a-f0-9]{64}$/.test(row.sourcePcmSha256||'') &&
      Number.isFinite(row.position) && Number.isFinite(row.end) && row.position>=0 && row.end<=86400 &&
      row.end-row.position>=1 && row.end-row.position<=12 &&
      row.sourceUrl===`${CAST_VOD_BASE}vod_view.jsp?pk_vod_no=${row.vodId}&position=${Math.floor(row.position)}` &&
      row.selfIntroduction===body+' 담당 '+row.name+'입니다.' &&
      office?.text===row.name+' '+row.officialRole+' 나오셔서 보고해 주시기 바랍니다.' &&
      Number.isFinite(office.start) && Number.isFinite(office.end) && office.start>=0 &&
      office.start<office.end && office.end<=row.position && row.position-office.end<=12;
  });
  if (eligible.length!==1) return base;
  const row=eligible[0];
  return {...base,registeredVodStaffRoster:[{
    basis:row.basis,body:row.body,term:row.term,termStart:term.start,termEnd:term.end,vodId:row.vodId,
    recordedOn:row.recordedOn,registeredOn:row.registeredOn,registryUrl:row.registryUrl,
    registryEntrySha256:row.registryEntrySha256,sourceUrl:row.sourceUrl,sourcePcmSha256:row.sourcePcmSha256,
    position:row.position,end:row.end,name:row.name,selfIntroduction:row.selfIntroduction,officialRole:row.officialRole,
    officeEvidence:row.officeEvidence,candidateOnly:true
  }]};
}

function eligiblePriorRoster(body, date, rosters) {
  const day=isoDay(date);
  if (day===null || !body || rosters?.schemaVersion!==1 ||
      !Array.isArray(rosters.terms) || !Array.isArray(rosters.snapshots)) return null;
  const terms=rosters.terms.filter(term=>{
    if (!Number.isInteger(term?.number)) return false;
    const start=isoDay(term.start), end=isoDay(term.end);
    return start!==null && end!==null && start<=day && day<=end;
  });
  if (terms.length!==1) return null;
  const term=terms[0];
  const termStart=isoDay(term.start), termEnd=isoDay(term.end);
  const eligible=rosters.snapshots.filter(row=>{
    if (row?.body!==body || row.term!==term.number || row.availabilityBasis!==ARCHIVE_ROSTER_AVAILABILITY_BASIS) return false;
    const sourceDay=isoDay(row.sourceDate), sessionEnd=isoDay(row.sessionEnd), availableDay=isoDay(row.availableFrom);
    return sourceDay!==null && sessionEnd!==null && availableDay!==null &&
      sourceDay>=termStart && sourceDay<=sessionEnd && sessionEnd<=termEnd &&
      availableDay===sessionEnd+ARCHIVE_ROSTER_PUBLICATION_BUFFER_DAYS && availableDay<day &&
      day-sourceDay<=ARCHIVE_ROSTER_MAX_AGE_DAYS && row.basis==='official-final-minutes-attendance' &&
      ARCHIVE_FINAL_MINUTES_URL.test(row.sourceUrl||'') && ARCHIVE_FINAL_MINUTES_URL.test(row.sessionEndSourceUrl||'') &&
      Array.isArray(row.members) && row.members.length>0 && row.members.length<=40 &&
      row.members.every(name=>typeof name==='string' && /^[가-힣]{2,4}$/.test(name)) && new Set(row.members).size===row.members.length;
  });
  const latest=eligible.reduce((date,row)=>row.sourceDate>date ? row.sourceDate : date,'');
  const sameDay=eligible.filter(row=>row.sourceDate===latest);
  return sameDay.length===1 ? sameDay[0] : null;
}

function priorRosterProvenance(roster, rosters) {
  return {basis:roster.basis,body:roster.body,term:roster.term,sourceDate:roster.sourceDate,sessionEnd:roster.sessionEnd,
    sessionEndSourceUrl:roster.sessionEndSourceUrl,availableFrom:roster.availableFrom,availabilityBasis:roster.availabilityBasis,
    availabilityRuleSource:rosters.availabilityRuleSource,candidateOnly:true};
}

function withWrittenPriorVodRoster(meeting, rosters) {
  if (meeting.speakerTranscript || meeting.liveMeetingId || meeting.members?.length || meeting.staffRoster?.length) return meeting;
  const roster=eligiblePriorRoster(archiveRosterBody(meeting),meeting.date,rosters);
  if (!roster) return meeting;
  const staff=priorAssignedStaff(roster);
  return {...meeting,members:roster.members,memberSource:roster.sourceUrl,
    ...(staff.length ? {staffRoster:staff} : {}),
    memberRoster:priorRosterProvenance(roster,rosters)};
}

export function withPriorVodRoster(meeting, rosters, registry) {
  return withRegisteredVodStaff(withWrittenPriorVodRoster(meeting,rosters),archiveRosterBody(meeting),meeting.date,rosters,registry);
}

export function withPriorLiveStaffRoster(meeting, rosters, date, body, registry) {
  if (!meeting || meeting.title!==body || ![...ARCHIVE_BODIES.values()].includes(body) || body==='본회의' ||
      meeting.speakerTranscript || (meeting.staffRoster!=null && (!Array.isArray(meeting.staffRoster) || meeting.staffRoster.length)) ||
      !/^[1-9]\d{0,7}$/.test(meeting.id) || meeting.officialPage!==CAST_LIVE_PLAYER+meeting.id ||
      !/^https:\/\/cast\.sncouncil\.go\.kr:4443\/live\/ch\d+\.sdp\/playlist\.m3u8$/.test(meeting.playlist||'')) return meeting;
  const scheduled=meeting.scheduledAt;
  const scheduledEnd=meeting.endsAt;
  const zonedTimestamp=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/;
  if (![scheduled,scheduledEnd].every(value=>typeof value==='string' && zonedTimestamp.test(value) && isoDay(value.slice(0,10))!==null))
    return meeting;
  const starts=Date.parse(scheduled), ends=Date.parse(scheduledEnd);
  if (!Number.isFinite(starts) || !(ends>starts) || new Date(starts+9*3600_000).toISOString().slice(0,10)!==date) return meeting;
  const roster=eligiblePriorRoster(body,date,rosters);
  if (!roster) return withRegisteredVodStaff(meeting,body,date,rosters,registry);
  const activeMembers=new Set(Array.isArray(meeting.members) ? meeting.members.map(name=>String(name).trim()) : []);
  const staff=priorAssignedStaff(roster).filter(row=>!activeMembers.has(row.name));
  if (!staff.length) return withRegisteredVodStaff(meeting,body,date,rosters,registry);
  return {...meeting,staffRoster:staff,priorStaffRoster:{...priorRosterProvenance(roster,rosters),sourceUrl:roster.sourceUrl}};
}

function liveRosterForVod(html,date,sittings) {
  if (!date || !Array.isArray(sittings) || !sittings.length) return null;
  const section=/<div\b[^>]*class=["'][^"']*\bconfer_view\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/i.exec(html);
  if (!section) return null;
  const lines=transcriptText(section[1]).split('\n').map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);
  const headings=lines.filter(line=>line.startsWith('□'));
  if (headings.length!==1) return null;
  const heading=headings[0].slice(1).trim(), topics=lines.slice(lines.indexOf(headings[0])+1)
    .flatMap(line=>line.split(/[【】•]/)).map(s=>s.trim()).filter(Boolean);
  const matches=sittings.filter(m=>{
    if (typeof m?.scheduledAt!=='string' || !Number.isFinite(Date.parse(m.scheduledAt))) return false;
    const day=new Date(Date.parse(m.scheduledAt)+9*3600_000).toISOString().slice(0,10);
    return day===date && heading===m.title+' '+m.label && Array.isArray(m.agenda) && m.agenda.length>0 &&
      m.agenda.length===topics.length && m.agenda.every((topic,i)=>topic===topics[i]) &&
      /^[1-9]\d{0,7}$/.test(m.id) && Array.isArray(m.members) && m.members.length>0;
  });
  if (matches.length!==1) return null;
  const m=matches[0];
  return {title:heading,liveMeetingId:m.id,members:m.members,memberSource:m.memberSource,staffRoster:m.staffRoster || []};
}

export async function resolveVod(request, fetcher=fetch, index, sittings=[], rosters, registry) {
  if (request.method !== 'GET') return json(405,{error:'method_not_allowed'});
  let url;
  try { url = new URL(request.url); } catch { return json(400,{error:'invalid_request'}); }
  const values=url.searchParams.getAll('id');
  if (url.pathname !== '/api/vod/resolve' || values.length !== 1 ||
      [...url.searchParams.keys()].some(key=>key !== 'id') || !/^[1-9][0-9]{0,7}$/.test(values[0]))
    return json(400,{error:'invalid_id'});
  const id=values[0];
  const indexed=index?.get(id);
  if (indexed) return json(200,withPriorVodRoster({...indexed,members:indexed.members || [],cues:[]},rosters,registry));
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
      const roster=liveRosterForVod(html,date,sittings);
      const meeting={id,title,date,officialPage,playlist,members:[],...roster,cues:[]};
      const prior=withWrittenPriorVodRoster(meeting,rosters);
      const selected=prior!==meeting && transcriptPageMatches(html,id) && transcriptTurns(transcriptChapters(html)).length ? meeting : prior;
      return json(200,withRegisteredVodStaff(selected,archiveRosterBody(meeting),date,rosters,registry));
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

const MEMBER_TITLES = '의장직무대리|위원장대리|예산결산특별위원회장|부위원장|위원장|부의장|의장|의원|위원';
const ADMIN_TITLES = '시장|부시장|구청장|담당관|주무관|센터장|팀장|과장|국장|부장|실장|소장|단장|관장|본부장|대표이사|이사장|사장|전문위원|공보관|감사관|재난안전관|소통관|공공의료정책관';
// The published heading includes the acting title. Retain it verbatim for the player.
const SPEAKER_TITLES = MEMBER_TITLES + '|(?:' + ADMIN_TITLES + ')(?:직무대리)?|의회사무국 ?직원';
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

function transcriptPageMatches(html,id) {
  // The official player binds its timeline to the video ID rendered in the page.
  const pageIds = [...html.matchAll(/\bgetTimelineList\s*\(\s*(?:(["'])(\d+)\1|(\d+))\s*\)/g)]
    .map(match => match[2] || match[3]);
  return pageIds.length>0 && pageIds.every(pageId=>pageId===id);
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
  if (!html || !transcriptPageMatches(html,meetingId)) return json(200,result);
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
