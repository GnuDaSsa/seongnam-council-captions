import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, readdir, rm, rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {refresh, parseArgs} from './refresh_schedule.mjs';

const html = await readFile(new URL('./fixtures/schedule-2026-11-26.html', import.meta.url), 'utf8');
const now = new Date('2026-11-25T15:01:00Z');
const fixture = async url => url.includes('live_schedule.jsp')
  ? new Response(html) : new Response('', {status:404});
const dir = await mkdtemp(join(tmpdir(), 'schedule-snapshot-'));
const prior = join(dir, 'prior.json');
const output = join(dir, 'new.json');
const priorData = JSON.stringify({meetings:[{title:'경제환경위원회', members:[]}]});
try {
  await writeFile(prior, priorData, {flag:'wx'});
  await assert.rejects(() => refresh({if:prior, output}, {
    now, fetcher:async () => new Response('', {status:503}),
  }), /official_source_unavailable/);
  assert.deepEqual(await readdir(dir), ['prior.json']);

  await assert.rejects(() => refresh({output:prior}, {now, fetcher:fixture}), {code:'EEXIST'});
  assert.equal(await readFile(prior, 'utf8'), priorData);

  const result = await refresh({if:prior, output}, {now, fetcher:fixture});
  assert.equal(result.date, '2026-11-26');
  assert.equal(result.meetings.length, 4);
  assert.ok(result.meetings.find(m => m.committee === '경제환경위원회').members.length);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result);
  assert.equal(await readFile(prior, 'utf8'), priorData);
  assert.throws(() => parseArgs(['--output','x','--date','2026-11-25']));
  assert.deepEqual(parseArgs(['--if','a','--output','b']), {if:'a',output:'b'});
  console.log('PASS: exclusive output, prior snapshot preserved, KST date and roster evidence');
} finally {
  await rm(output, {force:true});
  await rm(prior, {force:true});
  await rmdir(dir);
}
