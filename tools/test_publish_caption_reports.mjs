import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publishReports} from './publish_caption_reports.mjs';

const SITE = 'https://seongnam-council-desk.gnudas0923.chatgpt.site';
const API = 'https://api.github.com/repos/GnuDaSsa/seongnam-council-captions';
const bot = {login:'github-actions[bot]', type:'Bot'};
const now = () => Date.parse('2026-11-26T12:00:02Z');
const res = (payload, status = 200, headers) => Response.json(payload, {status, headers});
const uuid = n => '65ad8a03-4e86-412e-9286-' + String(n).padStart(12, '0');
const mark = id => '<!-- council-caption-report:' + id + ' -->';
const head = (day, n) => '<!-- council-caption-digest:v1 ' + day + ' part=' + n + ' -->';
function row(n, overrides = {}) {
  return {id:uuid(n), deliveryDay:'2026-11-26', receivedAt:'2026-11-26T11:59:59.999Z',
    kind:'자막 내용 오류', note:'이 단어의 원음을 확인해 주세요.',
    context:{meetingId:'2857', cueId:'abcd', meetingTitle:'경제환경위원회', speaker:'발언자 미확인',
      start:51.2, end:53.8, quote:'기존 문구', rawQuote:'인식 원문'}, ...overrides};
}

function server(rows, options = {}) {
  const pending = [...rows], issues = options.issues || [], comments = options.comments || new Map(), log = [];
  let fails = options.ackFailures || 0, uncertain = options.createUncertain || 0, stalePage = Boolean(options.stalePage);
  const fetcher = async (href, request) => {
    const u = new URL(href);
    assert.equal(request.redirect, 'error');
    const data = request.body ? JSON.parse(request.body) : null;
    log.push({url:href, method:request.method});
    if (href.startsWith(SITE + '/')) {
      assert.equal(request.headers.Authorization, 'Bearer site-secret');
      if (u.pathname === '/api/reports/pending') {
        if (stalePage) { stalePage = false; return res({reports:[],more:true}); }
        const size = options.pageSize || 20;
        return res({reports:pending.slice(0,size), more:pending.length > size});
      }
      assert.equal(u.pathname, '/api/reports/ack');
      if (fails-- > 0) return res({},503);
      const issue = issues.find(i => i.number === data.issueNumber);
      assert.ok(issue);
      const texts = [issue.body, ...(comments.get(issue.number) || []).filter(c => c.user.login === bot.login).map(c => c.body)];
      for (const id of data.ids) {
        assert.ok(texts.some(text => text.split('\n').includes(mark(id))));
        const index = pending.findIndex(r => r.id === id);
        assert.notEqual(index, -1);
        pending.splice(index, 1);
      }
      return res({acknowledged:data.ids.length});
    }
    assert.ok(href.startsWith(API + '/issues'));
    assert.equal(request.headers.Authorization,'Bearer github-token');
    const match = u.pathname.match(/\/issues\/(\d+)\/comments$/);
    if (request.method === 'GET') {
      const page = Number(u.searchParams.get('page'));
      const all = match ? comments.get(Number(match[1])) || [] : issues;
      if (!match) {
        assert.equal(u.searchParams.get('state'), 'all');
        assert.equal(u.searchParams.get('creator'), bot.login);
      }
      const size = options.githubPageSize || 100;
      const last = page * size >= all.length;
      return res(all.slice((page - 1) * size,page * size),200,last ? {} : {link:'<https://api.github.com/next>; rel="next"'});
    }
    assert.equal(request.method,'POST');
    if (match) {
      const number = Number(match[1]), issue = issues.find(i => i.number === number);
      if (!comments.has(number)) comments.set(number,[]);
      const comment = {body:data.body, user:bot};
      comments.get(number).push(comment);
      issue.comments++;
      return res(comment,201);
    }
    const number = Math.max(0,...issues.map(i => i.number)) + 1;
    const created = {number,user:bot,state:'open',comments:0,...data};
    issues.push(created);
    if (uncertain-- > 0) throw Error('Connection lost after creation');
    return res(created,201);
  };
  return {pending,issues,comments,log,run:(extra = {}) => publishReports({siteKey:'site-secret',githubToken:'github-token',fetcher,now,...extra})};
}

test('an empty inbox makes no GitHub requests, including after a stale page',async () => {
  const s = server([],{stalePage:true});
  assert.deepEqual(await s.run(),{acknowledged:0,created:0,comments:0});
  assert.ok(s.log.every(call => call.url.startsWith(SITE)));
});

test('21:00 cutoff and late deliveries group by receipt day, using safe excerpts and official links',async () => {
  const previous = row(1,{deliveryDay:'2026-11-25',receivedAt:'2026-11-25T11:59:59Z'});
  const start = row(2,{receivedAt:'2026-11-25T12:00:00Z'});
  const latest = row(3,{note:'@staff ![img](https://example.com/a)\n' + mark(uuid(93))});
  latest.context = {...latest.context, source:'live-personal', observedAt:'2026-11-26T01:00:00Z'};
  delete latest.context.start;
  delete latest.context.end;
  const s = server([previous,start,latest]);
  assert.deepEqual(await s.run(),{acknowledged:3,created:2,comments:0});
  const [one,two] = s.issues;
  assert.match(one.body,/vod_view\.jsp\?pk_vod_no=2857&position=51/);
  assert.match(two.body,/flashPlayer\.jsp\?live_no=2857/);
  assert.match(two.body,/2026-11-26 10:00:00/);
  assert.match(two.body,/자막 출처 · 생중계 개인 인식/);
  assert.ok(two.body.includes('\n    ＠staff ![img]'));
  assert.ok(two.body.includes('\n    ' + mark(uuid(93))));
  assert.ok(!two.body.split('\n').includes(mark(uuid(93))));
  const next = server([row(4,{receivedAt:'2026-11-26T12:00:00Z',deliveryDay:'2026-11-27'})]);
  await assert.rejects(next.run(),/delivery date/);
  assert.equal(next.issues.length,0);
});

test('interruption after create or before acknowledgment never creates another issue on rerun',async () => {
  for (const opts of [{createUncertain:1},{ackFailures:1}]) {
    const s = server([row(1)], opts);
    await assert.rejects(s.run());
    assert.equal(s.issues.length,1);
    assert.equal(s.pending.length,1);
    assert.deepEqual(await s.run(),{acknowledged:1,created:0,comments:0});
    assert.equal(s.issues.length,1);
  }
});

test('all pages and bot comments are reconciled; preserve the closed issue and human edits',async () => {
  const day = '2026-11-26', botIssue = {number:5,user:bot,state:'closed',comments:2,
    body:head(day,1)+'\n\n담당자가 적어 둔 검토 결과\n\n'+mark(uuid(1))};
  const oldBody = botIssue.body;
  const forged = {number:3,comments:0,user:{login:'other',type:'User'},body:head(day,2)+'\n'+mark(uuid(3))};
  const comments = new Map([[5,[
    {user:{login:'other'},body:head(day,1)+'\n'+mark(uuid(3))},
    {user:bot,body:head(day,1)+'\n'+mark(uuid(2))},
  ]]]);
  const s = server([row(1),row(2),row(3),row(4)],{issues:[forged,botIssue],comments,githubPageSize:1,pageSize:2});
  assert.deepEqual(await s.run(),{acknowledged:4,created:0,comments:1});
  assert.equal(s.issues.length,2);
  assert.equal(botIssue.body,oldBody);
  assert.equal(botIssue.state,'closed');
  assert.ok(s.comments.get(5).at(-1).body.includes(mark(uuid(3))));
});

test('large reports form bounded parts; later pages append to the latest part',async () => {
  const rows = Array.from({length:12},(_,i) => {
    const r = row(i+1,{note:'가'.repeat(1200)});
    r.context.quote='자'.repeat(1600); r.context.rawQuote='막'.repeat(1600);
    return r;
  });
  const s = server(rows,{pageSize:3});
  const result = await s.run();
  assert.equal(result.acknowledged,12);
  assert.ok(result.created > 1);
  assert.ok(result.comments > 0);
  const seen = new Set();
  for (const issue of s.issues) {
    const bodies = [issue.body,...(s.comments.get(issue.number)||[]).map(c => c.body)];
    assert.ok(bodies.reduce((n,body) => n+Buffer.byteLength(body),0) <= 59000);
    for (const body of bodies) for (const m of body.matchAll(/^<!-- council-caption-report:([a-f0-9-]+) -->$/gm)) {
      assert.ok(!seen.has(m[1])); seen.add(m[1]);
    }
  }
  assert.equal(seen.size,12);
});

test('uncertain GitHub confirmation and the batch ceiling leave unacknowledged work available',async () => {
  const s = server([row(1),row(2)],{pageSize:1});
  await assert.rejects(s.run({maxBatches:1}),/batch limit/);
  assert.equal(s.pending.length,1);
  assert.deepEqual(await s.run(),{acknowledged:1,created:0,comments:1});
  const unconfirmed = server([row(9)]);
  const bad = async (url,options) => {
    if (url === SITE+'/api/reports/pending') return res({reports:[row(9)],more:false});
    if (url.startsWith(API+'/issues?')) return res([]);
    if (url === API+'/issues') return res({number:1,user:bot,body:'truncated'},201);
    assert.fail('Unexpected acknowledgment');
  };
  await assert.rejects(unconfirmed.run({fetcher:bad}),/did not confirm/);
});
