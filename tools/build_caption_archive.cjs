'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {parseArgs} = require('node:util');

const catalogName = 'catalog.json';
const castOrigin = 'https://cast.sncouncil.go.kr';
const meetingId = /^[1-9]\d{0,11}$/;
const isoTimestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const reviewFlags = new Set(['segment_review','low_confidence','severe_uncertainty','repetition']);
const mixedFlags = new Set(['mixed','overlap','mixed_speaker','multi_speaker']);
const cacheStart = '/* ARCHIVE CACHE START */';
const cacheEnd = '/* ARCHIVE CACHE END */';
const types = ['txt','hwpx'];
const catalogLimit = 4 * 1024 * 1024;
const fileLimit = 128 * 1024 * 1024;
const flagLabels = {
  number:'숫자 확인',name:'이름 확인',low_confidence:'인식 불확실',
  segment_review:'구간 원음 대조',proceeding:'출석·표결 확인',
  severe_uncertainty:'원음 대조 필요',repetition:'반복 인식 확인',
};
const sessionStates = {live:'수집 중',listening:'수집 대기',interrupted:'수집 중단',ended:'수집 종료'};
const gapReasons = {interrupted:'수집 중단',updates_missing:'갱신 누락'};
const wallClock = new Intl.DateTimeFormat('ko-KR', {
  timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
});

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const kst = value => wallClock.format(Date.parse(value));
const koreanDate = new Intl.DateTimeFormat('en-CA', {
  timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',
});
const timestamp = value => typeof value === 'string' && isoTimestamp.test(value) && Number.isFinite(Date.parse(value));
const safeTitle = value => typeof value === 'string' && Boolean(value.trim()) && !/[\x00-\x1f\x7f]/u.test(value) && value.length <= 240;
const mixed = (cue, ids) => ids.has(cue.id) || cue.flags.some(flag => mixedFlags.has(flag));

function jsonFile(file) {
  if (fs.statSync(file).size > 64 * 1024 * 1024) throw Error('입력 파일이 너무 큽니다. ' + file);
  const bytes = fs.readFileSync(file);
  return {bytes, value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};
}

function officialUrl(value, type, id) {
  const url = new URL(value);
  const isVod = type === 'vod';
  const pathname = isVod ? '/vod/vod_view.jsp' : '/live/flashPlayer.jsp';
  const key = isVod ? 'pk_vod_no' : 'live_no';
  const number = url.searchParams.get(key);
  if (url.origin !== castOrigin || url.username || url.password || url.pathname !== pathname ||
      url.searchParams.getAll(key).length !== 1 || !meetingId.test(number) || (!isVod && number !== id)) {
    throw Error(isVod ? '성남시의회 공식 다시보기 주소를 입력해 주세요.' : '회의 ID와 같은 성남시의회 공식 생중계 주소가 필요합니다.');
  }
  return castOrigin + pathname + '?' + key + '=' + number;
}

function loadExporter() {
  const bundled = path.join(__dirname, 'exports.js');
  const source = fs.existsSync(bundled) ? bundled : path.join(__dirname,'../dist/exports.js');
  global.window = {};
  require(source);
  return window.CouncilExports;
}

function loadCatalog(directory) {
  const file = path.join(directory, catalogName);
  if (!fs.existsSync(file)) return [];
  if (fs.statSync(file).size > catalogLimit) throw Error('보관 목록의 크기 한도를 넘었습니다.');
  const rows = jsonFile(file).value;
  if (!Array.isArray(rows) || new Set(rows.map(row => row?.id)).size !== rows.length ||
      rows.some(row => typeof row?.id !== 'string' || !meetingId.test(row.id) || !timestamp(row.snapshotAt) ||
        !timestamp(row.lastCapturedAt) || (row.completionAt !== null && !timestamp(row.completionAt)) ||
        !Number.isInteger(row.cueCount) || row.cueCount < 1)) {
    throw Error('기존 보관 목록을 읽을 수 없습니다. ' + file);
  }
  return rows;
}
function publisherClock(value) {
  const ms = Math.round(value * 1000);
  const pad = n => String(n).padStart(2,'0');
  return [pad(Math.floor(ms/3600000)),pad(Math.floor(ms/60000)%60),pad(Math.floor(ms/1000)%60)].join(':') +
    '.' + String(ms%1000).padStart(3,'0');
}

function speaker(cue, mixedCues) {
  if (mixed(cue,mixedCues) || cue.flags.some(flag => reviewFlags.has(flag))) {
    return '발언자 미확인';
  }
  const name = safeTitle(cue.speaker?.name) ? cue.speaker.name.trim() : '';
  const role = safeTitle(cue.speaker?.role) ? cue.speaker.role.trim() : '';
  if (name) return [name,role].filter(Boolean).join(' ') + ' · 자동 추정';
  if (role) return role + ' · 역할 자동 추정 · 실명 미확인';
  return '발언자 미확인';
}

function loadArchive(options, catalog) {
  const {value:snapshot, bytes} = jsonFile(options.minutes);
  const minutes = snapshot?.minutes || snapshot;
  const id = minutes?.meetingId;
  if (typeof id !== 'string' || !meetingId.test(id) || !Array.isArray(minutes.cues) || !minutes.cues.length ||
      !timestamp(minutes.updatedAt) || !Object.hasOwn(sessionStates,minutes.status) || !Array.isArray(minutes.gaps)) {
    throw Error('Worker /api/live/minutes에서 받은 자막 수집본이 필요합니다.');
  }
  const supplied = jsonFile(options.metadata).value;
  const meetings = supplied?.meetings ?? (Array.isArray(supplied) ? supplied : [supplied]);
  const matches = Array.isArray(meetings) ? meetings.filter(row => row?.id === id) : [];
  const [meeting] = matches;
  if (matches.length !== 1 || !safeTitle(meeting.title) || !timestamp(meeting.scheduledAt) ||
      (meeting.label != null && meeting.label !== '' && !safeTitle(meeting.label))) {
    throw Error('같은 ID의 회의명과 예정 시각이 있는 메타데이터가 필요합니다. ' + id);
  }
  const seen = new Set();
  for (const cue of minutes.cues) {
    if (!safeTitle(cue?.id) || seen.has(cue.id) || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) ||
        cue.start < 0 || cue.end <= cue.start || !Array.isArray(cue.flags) || cue.flags.some(flag => !safeTitle(flag)) ||
        typeof cue.text !== 'string' || !cue.text.trim() || !timestamp(cue.observedAt)) {
      throw Error('유효하지 않은 자막 구간입니다. ' + id + '/' + (cue?.id ?? ''));
    }
    seen.add(cue.id);
  }
  if (minutes.gaps.some(gap => !timestamp(gap?.start) || (gap.end != null &&
        (!timestamp(gap.end) || Date.parse(gap.end) < Date.parse(gap.start))))) {
    throw Error('유효하지 않은 수집 중단 기록입니다. ' + id);
  }
  const previous = catalog.find(row => row.id === id);
  const mixedList = options['mixed-cues'] ? jsonFile(options['mixed-cues']).value : (previous?.mixedCueIds || []);
  if (!Array.isArray(mixedList) || mixedList.some(cueId => !seen.has(cueId))) {
    throw Error('발화가 섞인 구간 ID는 이 수집본에서 확인되어야 합니다.');
  }
  const mixedCues = new Set(mixedList);
  let first = Infinity, last = -Infinity;
  for (const cue of minutes.cues) {
    const observed = Date.parse(cue.observedAt);
    first = Math.min(first,observed);
    last = Math.max(last,observed);
  }
  const complete = minutes.status === 'ended' && Date.parse(minutes.updatedAt) >= last;
  const completedAt = complete ? minutes.updatedAt : null;
  const lastCapturedAt = new Date(last).toISOString();
  const date = koreanDate.format(Date.parse(meeting.scheduledAt));
  const label = [meeting.title.trim(),meeting.label?.trim()].filter(Boolean).join(' ');
  const video = options.vod || previous?.officialVideo;
  const liveSource = officialUrl(meeting.officialPage, 'live', id);
  const localName = meeting.title.trim().replace(/[<>:"/\\|?*]/g, '_').slice(0,80);
  const metadata = {
    id,title:label,date,
    completionAt:completedAt,lastCapturedAt,firstCapturedAt:new Date(first).toISOString(),snapshotAt:minutes.updatedAt,
    cueCount:minutes.cues.length,gapCount:minutes.gaps.length,
    officialVideo:video ? officialUrl(video, 'vod', id) : null,
    liveSource,filename:previous?.filename || [date,localName,'AI_회의록_초안',id].join('_'),
    status:sessionStates[minutes.status] || '상태 미확인',
    snapshotSha256:digest(bytes),
  };
  if (mixedCues.size) metadata.mixedCueIds = [...mixedCues].sort();
  return {metadata,minutes,previous,mixedCues};
}

function archiveLines({metadata,minutes,mixedCues}) {
  const lines = [
    metadata.title, 'AI 생성 회의록 초안 · 미검토',
    '', '성남시의회 생중계 공유 자막 수집본', '회의일  ' + metadata.date,
    '수집 시각(한국시간)  ' + kst(metadata.firstCapturedAt) + ' ~ ' + kst(metadata.lastCapturedAt),
    '수집본 갱신(한국시간)  ' + kst(metadata.snapshotAt) + ' · 당시 상태 ' + metadata.status,
    '기록 구간  ' + metadata.cueCount + '개',
    '보관 기준(한국시간)  ' + (metadata.completionAt
      ? '공유 자막 수집 종료 ' + kst(metadata.completionAt) : '마지막 수집 시각 ' + kst(metadata.lastCapturedAt)),
    ...(metadata.officialVideo ? ['같은 회의 공식 영상  ' + metadata.officialVideo] : []),
    '공식 생중계 출처  ' + metadata.liveSource, '',
    '수집된 구간을 모두 실었습니다. 수집 시작 전과 마지막 수집 이후, 기록에 없는 중단은 빠졌을 수 있습니다.',
    '자동 인식 원문, 자동 추정과 대조 표시를 공식 영상에서 확인해 주세요.',
    '구간의 경과 시간은 자막 수집 시스템 기준입니다. 공식 다시보기 재생 위치와 차이가 있습니다.',
    '', '기록된 수집 중단 (' + metadata.gapCount + '건)',
  ];
  for (const gap of minutes.gaps) {
    lines.push(kst(gap.start) + ' ~ ' + (gap.end ? kst(gap.end) : '수집본에서 재개 시각 미확인') +
      ' · ' + (Object.hasOwn(gapReasons,gap.reason) ? gapReasons[gap.reason] : '수집 중단'));
  }
  lines.push('','발언 기록');
  for (const cue of minutes.cues) {
    const flags = cue.flags.map(flag => Object.hasOwn(flagLabels,flag) ? flagLabels[flag] : flag);
    if (mixedCues.has(cue.id)) flags.unshift('질문과 답변이 같은 구간에 포함 · 공식 영상 대조');
    else if (mixed(cue,mixedCues)) flags.unshift('두 발화 이상 가능 · 공식 영상 대조');
    lines.push('['+publisherClock(cue.start)+' ~ '+publisherClock(cue.end)+'] 기록 '+cue.id+' · '+speaker(cue,mixedCues));
    lines.push('수집 시각(한국시간)  '+kst(cue.observedAt));
    if (flags.length) lines.push('대조 표시  '+flags.join(' · '));
    lines.push(cue.text);
    if (typeof cue.rawText === 'string' && cue.rawText !== cue.text) lines.push('인식 원문  '+cue.rawText);
    lines.push('');
  }
  return lines;
}

function atomicWrite(target, bytes) {
  const temp = target + '.' + randomUUID() + '.tmp';
  try {
    const file = fs.openSync(temp, 'wx');
    try {
      fs.writeFileSync(file, bytes);
      fs.fsyncSync(file);
    } finally {
      fs.closeSync(file);
    }
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function fileName(record, extension) {
  const name = record.files?.[extension]?.name ?? record.id + '.' + extension;
  const valid = new RegExp('^'+record.id+'(?:-[0-9a-f]{64})?\\.'+extension+'$');
  if (!valid.test(name)) throw Error('보관 파일 이름을 확인해 주세요. ' + record.id);
  return name;
}

function documentMatches(target, expected) {
  try {
    const info = fs.lstatSync(target);
    return info.isFile() && info.size > 0 && info.size <= fileLimit &&
      (!expected || (info.size === expected.size && digest(fs.readFileSync(target)) === expected.sha256));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function writeEdition(directory, id, extension, bytes) {
  const sha256 = digest(bytes);
  const name = id + '-' + sha256 + '.' + extension;
  const target = path.join(directory,name);
  const descriptor = {name,sha256,size:bytes.length};
  if (!documentMatches(target,descriptor)) atomicWrite(target,bytes);
  return descriptor;
}

function refreshHtml(file, catalog) {
  const html = fs.readFileSync(file,'utf8');
  const start = html.indexOf(cacheStart), end = html.indexOf(cacheEnd);
  if (start < 0 || end <= start || html.indexOf(cacheStart,start+1) >= 0 || html.indexOf(cacheEnd,end+1) >= 0) {
    throw Error('보관 목록을 갱신할 수 있는 최신 미리보기 HTML이 필요합니다.');
  }
  const payload = JSON.stringify(catalog).replaceAll('<','\\u003c');
  atomicWrite(file, html.slice(0,start+cacheStart.length) +
    '\nwindow.PREVIEW_ARCHIVE_MEETINGS=' + payload + ';\n' + html.slice(end));
}

async function saveArchive(directory, options, catalog) {
  const input = loadArchive(options,catalog);
  const {metadata,previous} = input;
  if (previous && (Date.parse(metadata.snapshotAt) < Date.parse(previous.snapshotAt) ||
      Date.parse(metadata.lastCapturedAt) < Date.parse(previous.lastCapturedAt) || metadata.cueCount < previous.cueCount)) {
    throw Error('보관 중인 자료보다 오래되었거나 수집 기록이 적습니다. ' + metadata.id);
  }
  if (previous && ['title','date','officialVideo','liveSource','snapshotSha256'].every(key => previous[key] === metadata[key]) &&
      JSON.stringify(previous.mixedCueIds || []) === JSON.stringify(metadata.mixedCueIds || []) &&
      types.every(extension => documentMatches(path.join(directory,fileName(previous,extension)),previous.files?.[extension]))) {
    console.log('이미 같은 수집본이 보관되어 있습니다. ' + metadata.id);
    return catalog;
  }
  const {minutesText,minutesHwpx} = loadExporter();
  const model = {minutesLines:archiveLines(input)};
  const documents = {txt:Buffer.from(minutesText(model),'utf8'),hwpx:Buffer.from(await minutesHwpx(model).arrayBuffer())};
  if (types.some(extension => documents[extension].length > fileLimit)) {
    throw Error('회의록 다운로드 파일의 크기 한도를 넘었습니다. ' + metadata.id);
  }
  metadata.files = Object.fromEntries(types.map(ext => [ext,writeEdition(directory,metadata.id,ext,documents[ext])]));
  const rows = [...catalog.filter(row => row.id !== metadata.id),metadata];
  rows.sort((a,b) => Date.parse(b.completionAt || b.lastCapturedAt) - Date.parse(a.completionAt || a.lastCapturedAt) ||
    a.id.localeCompare(b.id));
  const serialized = JSON.stringify(rows,null,2)+'\n';
  if (Buffer.byteLength(serialized) > catalogLimit) throw Error('보관 목록의 크기 한도를 넘었습니다.');
  atomicWrite(path.join(directory,catalogName),serialized);
  console.log('보관했습니다. 회의 ' + metadata.id + ' · 자막 ' + metadata.cueCount + '개');
  return rows;
}

async function main() {
  const {values:options} = parseArgs({options:{
    minutes:{type:'string'},metadata:{type:'string'},vod:{type:'string'},'mixed-cues':{type:'string'},
    archive:{type:'string'},'refresh-html':{type:'string'},help:{type:'boolean',short:'h'},
  }});
  if (options.help) {
    console.log('node build-archive.cjs --minutes <Worker JSON> --metadata <회의 JSON> [--vod <공식 VOD URL>] [--mixed-cues <구간 ID 배열 JSON>] [--archive <폴더>] [--refresh-html <시안 HTML>]');
    console.log('node build-archive.cjs --refresh-html <시안 HTML> [--archive <폴더>]');
    return;
  }
  if (Boolean(options.minutes) !== Boolean(options.metadata) || (!options.minutes && !options['refresh-html']) ||
      (!options.minutes && (options.vod || options['mixed-cues']))) {
    throw Error('자막 JSON과 회의 JSON을 함께 입력해 주세요. 사용법은 --help에서 확인할 수 있습니다.');
  }
  const directory = options.archive ? path.resolve(options.archive) : path.join(__dirname,'archive');
  fs.mkdirSync(directory,{recursive:true});
  const lock = path.join(directory,'.catalog.lock');
  let fd;
  try {
    fd = fs.openSync(lock,'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw Error('다른 보관 갱신이 진행 중입니다. 작업이 끝난 뒤 다시 실행해 주세요.');
    throw error;
  }
  try {
    let catalog = loadCatalog(directory);
    if (options.minutes) catalog = await saveArchive(directory,options,catalog);
    if (options['refresh-html']) refreshHtml(path.resolve(options['refresh-html']),catalog);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
