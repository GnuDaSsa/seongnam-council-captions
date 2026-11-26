import {pathToFileURL} from 'node:url';

const SITE = 'https://seongnam-council-desk.gnudas0923.chatgpt.site';
const REPO = 'GnuDaSsa/seongnam-council-captions';
const API = 'https://api.github.com/repos/' + REPO;
const BODY_LIMIT = 59000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TYPES = new Set(['자막 내용 오류', '발언자 오류', '시각 오류', '기타']);
const SOURCES = new Map([['live-shared','생중계 공유 자막'], ['live-personal','생중계 개인 인식'],
  ['vod-existing','다시보기 기존 자막'], ['vod-personal','다시보기 개인 인식']]);
const DAY_HEADER = /^<!-- council-caption-digest:v1 (\d{4}-\d{2}-\d{2}) part=(\d+) -->$/m;
const REPORT_MARKER = /^<!-- council-caption-report:([a-f0-9-]{36}) -->$/gm;
const marker = id => '<!-- council-caption-report:' + id + ' -->';
const header = (day, part) => '<!-- council-caption-digest:v1 ' + day + ' part=' + part + ' -->';
const bytes = value => Buffer.byteLength(value, 'utf8');
const isBot = item => item?.user?.login === 'github-actions[bot]' && item.user.type === 'Bot';
const shiftedDay = (ms, hours) => new Date(ms + hours * 3600000).toISOString().slice(0, 10);

function literal(value) {
  // Indent every input line as code. Keep mentions inert even in notification clients.
  return String(value ?? '').replace(/\r\n?|\u0085|\u2028|\u2029/g, '\n').replace(/@/g, '＠')
    .split('\n').map(line => '    ' + line).join('\n');
}
function stamp(seconds) {
  const s = Math.floor(seconds);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
}
function koreaStamp(iso) {
  return new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + ' (한국시간)';
}
function reportEntry(row, lastDay) {
  const c = row.context, received = Date.parse(row.receivedAt);
  if (!UUID.test(row.id) || !TYPES.has(row.kind) || !Number.isFinite(received) ||
      row.deliveryDay !== shiftedDay(received, 12) || row.deliveryDay > lastDay ||
      !/^[1-9]\d{0,11}$/.test(c?.meetingId) || typeof row.note !== 'string' || !row.note.trim()) {
    throw Error('Invalid pending report or delivery date');
  }
  const live = Object.hasOwn(c, 'observedAt');
  if (live ? !Number.isFinite(Date.parse(c.observedAt)) :
      !(Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.start < c.end && c.end <= 604800)) {
    throw Error('Invalid caption time');
  }
  const url = live ? 'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=' + c.meetingId :
    'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=' + c.meetingId + '&position=' + Math.floor(c.start);
  const lines = [marker(row.id), '### ' + row.kind, '', literal(c.meetingTitle), '',
    (live ? koreaStamp(c.observedAt) : stamp(c.start) + '–' + stamp(c.end)) + ' · [공식 영상](' + url + ')',
    '', '자막 ID', '', literal(c.cueId), ''];
  if (SOURCES.has(c.source)) lines.push('자막 출처 · ' + SOURCES.get(c.source), '');
  if (c.speaker) lines.push('발언자 표기', '', literal(c.speaker), '');
  lines.push('표시된 자막', '', literal(c.quote), '');
  if (c.rawQuote && c.rawQuote !== c.quote) lines.push('인식 원문', '', literal(c.rawQuote), '');
  lines.push('제보 의견', '', literal(row.note));
  return lines.join('\n');
}

export async function publishReports({siteKey, githubToken, fetcher = fetch, now = Date.now, maxBatches = 100}) {
  if (!siteKey || !githubToken) throw Error('Digest credentials are missing');
  const days = new Map();
  const lastDay = shiftedDay(now(), -12);
  let indexed = false, acknowledged = 0, created = 0, comments = 0;

  async function request(root, path, method = 'GET', payload) {
    const headers = root === API ?
      {Authorization:'Bearer ' + githubToken, Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28'} :
      {Authorization:'Bearer ' + siteKey, Accept:'application/json'};
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(root + path, {
      method, headers, body:payload === undefined ? undefined : JSON.stringify(payload),
      redirect:'error', signal:AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error((root === API ? 'GitHub' : 'Site') + ' ' + method + ' ' + path.split('?')[0] + ' returned HTTP ' + response.status);
    return response;
  }
  async function* pages(path) {
    for (let page = 1; page <= 200; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await request(API, path + separator + 'per_page=100&page=' + page);
      const list = await response.json();
      if (!Array.isArray(list)) throw Error('Invalid GitHub page');
      yield* list;
      if (!/<[^>]+>;\s*rel="next"/.test(response.headers.get('link') || '')) return;
    }
    throw Error('GitHub pagination limit reached before all issues were checked');
  }
  function recordText(part, body) {
    part.size += bytes(body);
    for (const match of body.matchAll(REPORT_MARKER)) part.ids.add(match[1]);
  }
  async function indexIssues() {
    for await (const issue of pages('/issues?state=all&creator=github-actions%5Bbot%5D&sort=created&direction=asc')) {
      if (issue.pull_request || !isBot(issue)) continue;
      const match = (issue.body || '').match(DAY_HEADER);
      if (!match) continue;
      const day = match[1], seq = Number(match[2]);
      if (!Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(issue.number)) throw Error('Invalid digest issue metadata');
      if (!days.has(day)) days.set(day, []);
      const parts = days.get(day);
      if (parts.some(p => p.seq === seq)) throw Error('Multiple digest issues have the same day and part');
      const part = {seq, number:issue.number, size:0, ids:new Set(), hasComments:issue.comments > 0};
      recordText(part, issue.body);
      parts.push(part);
    }
    indexed = true;
  }
  async function loadDay(day) {
    if (!days.has(day)) days.set(day, []);
    const parts = days.get(day);
    for (const part of parts) {
      if (!part.hasComments) continue;
      for await (const comment of pages('/issues/' + part.number + '/comments')) {
        if (isBot(comment) && comment.body?.split('\n', 1)[0] === header(day, part.seq)) recordText(part, comment.body);
      }
      part.hasComments = false;
    }
    return parts.sort((a, b) => a.seq - b.seq);
  }
  async function ack(ids, issueNumber) {
    const result = await (await request(SITE, '/api/reports/ack', 'POST', {ids, issueNumber})).json();
    if (result?.acknowledged !== ids.length) throw Error('Site did not confirm every published report');
    acknowledged += ids.length;
  }
  async function publishDay(day, reports) {
    const parts = await loadDay(day);
    const remaining = new Map(reports);
    for (const part of parts) {
      const included = [...remaining.keys()].filter(id => part.ids.has(id));
      if (included.length) {
        await ack(included, part.number);
        for (const id of included) remaining.delete(id);
      }
    }
    while (remaining.size) {
      let last = parts.at(-1);
      const firstEntry = remaining.values().next().value;
      if (last && last.size + bytes(header(day, last.seq) + '\n\n' + firstEntry) > BODY_LIMIT) last = null;
      const part = last || {seq:(parts.at(-1)?.seq || 0) + 1, size:0, ids:new Set(), hasComments:false};
      let body = header(day, part.seq);
      const ids = [];
      for (const [id, entry] of remaining) {
        if (part.size + bytes(body) + bytes(entry) + 2 > BODY_LIMIT) break;
        body += '\n\n' + entry;
        ids.push(id);
      }
      if (!ids.length) throw Error('Single caption report exceeds GitHub digest size');
      const title = day + ' 자막 오류 제보' + (part.seq > 1 ? ' (' + part.seq + ')' : '');
      const saved = await (await request(API, last ? '/issues/' + part.number + '/comments' : '/issues',
        'POST', last ? {body} : {title, body})).json();
      if (!isBot(saved) || saved.body !== body) throw Error('GitHub did not confirm the submitted report text');
      if (!last) {
        if (!Number.isSafeInteger(saved.number) || saved.number < 1) throw Error('GitHub issue number missing');
        part.number = saved.number;
        parts.push(part);
        created++;
      } else comments++;
      recordText(part, saved.body);
      await ack(ids, part.number);
      for (const id of ids) remaining.delete(id);
    }
  }
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await (await request(SITE, '/api/reports/pending')).json();
    if (!Array.isArray(result?.reports) || result.reports.length > 20 || typeof result.more !== 'boolean') throw Error('Invalid pending report page');
    if (!result.reports.length) {
      if (!result.more) return {acknowledged, created, comments};
      continue;
    }
    const grouped = new Map(), ids = new Set();
    for (const row of result.reports) {
      const entry = reportEntry(row, lastDay);
      if (ids.has(row.id)) throw Error('Duplicate report ID in pending page');
      ids.add(row.id);
      if (!grouped.has(row.deliveryDay)) grouped.set(row.deliveryDay, new Map());
      grouped.get(row.deliveryDay).set(row.id, entry);
    }
    if (!indexed) await indexIssues();
    for (const [day, rows] of grouped) await publishDay(day, rows);
    if (!result.more) return {acknowledged, created, comments};
  }
  throw Error('Digest batch limit reached; pending reports remain for the next run');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== REPO || process.env.GITHUB_REF !== 'refs/heads/main') throw Error('Run the digest from the main branch workflow');
    const result = await publishReports({siteKey:process.env.CAPTION_REPORT_DIGEST_KEY, githubToken:process.env.GITHUB_TOKEN});
    console.log('Reports acknowledged: %d; new issues: %d; new comments: %d', result.acknowledged, result.created, result.comments);
  } catch (error) {
    console.error('Caption report digest failed:', error.message);
    process.exitCode = 1;
  }
}
