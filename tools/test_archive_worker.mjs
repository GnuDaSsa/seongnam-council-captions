import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {access, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import speaker from '../dist/live-speaker.js';
import {createSite} from '../worker/captions.mjs';

const day = 86_400_000;
const start = Date.parse('2026-11-25T04:00:00Z');
const stamp = value => new Date(value).toISOString();
const captionKey = id => 'council-captions/' + id + '.json';
const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({format:'jwk'}).x;
const archiveEndpoint = id => '/api/archive/meetings/' + id;
const catalogEndpoint = '/api/archive/catalog';

function meeting(id, extra = {}) {
  return {
    id,
    title:'검증위원회',
    scheduledAt:stamp(start),
    endsAt:stamp(start + 3_600_000),
    officialPage:'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=' + id,
    ...extra,
  };
}

function cue(index, text = '회의를 진행합니다.', extra = {}) {
  return {
    id:String(index),
    start:index * 2,
    end:index * 2 + 1,
    text,
    rawText:text,
    flags:[],
    observedAt:stamp(start + index * 2000),
    ...extra,
  };
}

function setup({now = start + 1_000_000, meetings = [], archiveMeetings = [], attributeSpeakers} = {}) {
  const objects = new Map();
  const cursors = [];
  const bucket = {
    async get(name) {
      return objects.get(name) ?? null;
    },
    async put(name, body, {onlyIf, customMetadata} = {}) {
      const previous = objects.get(name);
      if (onlyIf?.etagMatches && onlyIf.etagMatches !== previous?.etag) return null;
      if (onlyIf instanceof Headers && onlyIf.get('if-none-match') === '*' && previous) return null;
      const object = {body, etag:String(Number(previous?.etag || 0) + 1), customMetadata};
      objects.set(name, object);
      return object;
    },
    async list({prefix, cursor}) {
      const entries = [...objects.keys()].filter(name => name.startsWith(prefix)).sort();
      const offset = Number(cursor || '0');
      cursors.push(cursor ?? null);
      return {
        objects:entries.slice(offset, offset + 1).map(name => ({
          key:name, customMetadata:objects.get(name).customMetadata,
        })),
        truncated:offset + 1 < entries.length,
        cursor:String(offset + 1),
      };
    },
  };
  let site;
  function rotate(currentMeetings = meetings) {
    site = createSite({assets:{}, meetings:currentMeetings, archiveMeetings, publicKey, attributeSpeakers,
      validateAcousticProof:speaker.acousticProof, validatePodiumProof:speaker.podiumProof}, () => now);
  }
  rotate();
  return {
    bucket, objects, rotate, cursors,
    get now() { return now; },
    set now(value) { now = value; },
    store(name, data) {
      objects.set(name, {body:JSON.stringify(data), etag:'1', customMetadata:{updatedAt:data.updatedAt}});
    },
    request(path, options = {}) {
      return site.fetch(new Request('https://archive.test' + path, options), {BUCKET:bucket});
    },
    put(path, value) {
      const body = JSON.stringify(value);
      const signature = sign(null, Buffer.from(body), key.privateKey).toString('base64url');
      return this.request(path, {method:'PUT', headers:{'X-Council-Signature':signature}, body});
    },
    write(id, status, cues) {
      return this.put('/api/live/captions?meetingId=' + id, {
        meetingId:id, status, updatedAt:stamp(now), cues,
      });
    },
  };
}

async function readJson(responsePromise) {
  const response = await responsePromise;
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test('catalog uses signed snapshot metadata and falls back to the stored body for older entries', async () => {
  const fixture = setup({meetings:[meeting('108')]});
  assert.equal((await fixture.write('108','ended',[cue(1)])).status,204);
  const stored = fixture.objects.get(captionKey('108'));
  const get = fixture.bucket.get;
  let reads = 0;
  fixture.bucket.get = async name => { reads++; return get(name); };
  const indexed = await readJson(fixture.request(catalogEndpoint));
  assert.equal(indexed.meetings[0].id,'108');
  assert.equal(reads,0);
  stored.customMetadata.archiveV1 = '{invalid';
  const rebuilt = await readJson(fixture.request(catalogEndpoint));
  assert.deepEqual(rebuilt,indexed);
  assert.equal(reads,1);
});

test('read observes a meeting that resumed while its archived pages were assembled', async () => {
  const original = {meetingId:'107', updatedAt:stamp(start + 10000), status:'ended', cues:[cue(3)]};
  for (const [next, status] of [['live',404], ['ended',409]]) {
    const fixture = setup({meetings:[meeting('107')]});
    fixture.store(captionKey('107'), original);
    const get = fixture.bucket.get;
    let triggered = false;
    fixture.bucket.get = async name=>{
      if (!triggered && name === 'council-recovered/107') {
        triggered = true;
        fixture.store(captionKey('107'), {...original, updatedAt:stamp(start + 12000), status:next});
      }
      return get(name);
    };
    assert.equal((await fixture.request(archiveEndpoint('107'))).status,status);
    assert.equal(triggered,true);
  }
});

test('archive lists paginated eligible snapshots and enforces its read and expiry boundaries', async () => {
  const legacy = meeting('101');
  const other = meeting('102');
  const fixture = setup({now:start + 2 * 3_600_000, archiveMeetings:[legacy, other, meeting('103')]});
  fixture.store(captionKey('101'), {meetingId:'101', updatedAt:stamp(start + 2000), status:'live', cues:[cue(1)]});
  fixture.store(captionKey('102'), {
    meetingId:'102', updatedAt:stamp(start + 6000), status:'interrupted', cues:[cue(3)],
  });
  fixture.store(captionKey('103'), {meetingId:'103', updatedAt:stamp(start + 9000), status:'ended', cues:[]});
  fixture.store(captionKey('104'), {meetingId:'104', updatedAt:stamp(start + 9000), status:'ended', cues:[cue(4)]});
  const rows = (await readJson(fixture.request(catalogEndpoint))).meetings;
  assert.deepEqual(rows.map(row => [row.id, row.status, row.completionAt]), [
    ['102', 'interrupted', null], ['101', 'unknown', null],
  ]);
  assert.deepEqual(fixture.cursors, [null, '1', '2', '3']);

  const detail = await readJson(fixture.request(archiveEndpoint('101')));
  assert.deepEqual(detail.minutes.cues, [cue(1)]);
  for (const path of [catalogEndpoint, archiveEndpoint('101')]) {
    const head = await fixture.request(path, {method:'HEAD'});
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fixture.request(path, {method:'POST'})).status, 405);
  }
  assert.equal((await fixture.request(catalogEndpoint + '?extra=1')).status, 400);
  assert.equal((await fixture.request(archiveEndpoint('0101'))).status, 404);
  for (const id of ['103', '104', '999']) assert.equal((await fixture.request(archiveEndpoint(id))).status, 404);

  fixture.now = start + 2000 + 14 * day - 1;
  assert.equal((await fixture.request(archiveEndpoint('101'))).status, 200);
  fixture.now++;
  assert.equal((await fixture.request(archiveEndpoint('101'))).status, 404);
  assert.ok(!(await readJson(fixture.request(catalogEndpoint))).meetings.some(row => row.id === '101'));
});

test('archive tolerates a deleted listing entry and rejects interrupted storage reads', async () => {
  const fixture = setup({archiveMeetings:[meeting('101')]});
  fixture.store(captionKey('101'), {
    meetingId:'101', updatedAt:stamp(start + 2000), status:'interrupted', cues:[cue(1)],
  });
  const list = fixture.bucket.list;
  fixture.bucket.list = async options => {
    const page = await list(options);
    page.objects.push({key:captionKey('102')});
    return page;
  };
  assert.deepEqual((await readJson(fixture.request(catalogEndpoint))).meetings.map(row => row.id), ['101']);
  fixture.bucket.list = async () => { throw new DOMException('Storage was cancelled', 'AbortError'); };
  assert.equal((await fixture.request(catalogEndpoint)).status, 503);
  fixture.bucket.list = async () => ({objects:[], truncated:true, cursor:'same'});
  assert.equal((await fixture.request(catalogEndpoint)).status, 503);
});

test('signed archive metadata survives manifest rotation and missing sealed pages fail closed', async () => {
  const active = meeting('201');
  const fixture = setup({meetings:[active]});
  const cues = Array.from({length:201}, (_, index) => cue(index));
  assert.equal((await fixture.write(active.id, 'live', cues)).status, 204);
  assert.deepEqual((await readJson(fixture.request(catalogEndpoint))).meetings, []);
  fixture.now += 1000;
  assert.equal((await fixture.write(active.id, 'interrupted', cues)).status, 204);
  fixture.rotate([]);
  let detail = await readJson(fixture.request(archiveEndpoint(active.id)));
  assert.equal(detail.meeting.status, 'interrupted');
  assert.deepEqual(detail.minutes.cues, cues);

  const state = JSON.parse(fixture.objects.get(captionKey(active.id)).body);
  const page = state.pages[0];
  assert.ok(page);
  const storedPage = fixture.objects.get(page);
  fixture.objects.delete(page);
  assert.equal((await fixture.request(archiveEndpoint(active.id))).status, 503);
  fixture.objects.set(page, storedPage);

  fixture.rotate();
  fixture.now += 1000;
  assert.equal((await fixture.write(active.id, 'live', cues)).status, 204);
  assert.equal((await fixture.request(archiveEndpoint(active.id))).status, 404);
  fixture.now += 1000;
  assert.equal((await fixture.write(active.id, 'ended', cues)).status, 204);
  const completion = fixture.now;
  detail = await readJson(fixture.request(archiveEndpoint(active.id)));
  assert.equal(detail.meeting.completionAt, stamp(completion));
  fixture.now = completion + 14 * day - 1;
  assert.equal((await fixture.request(archiveEndpoint(active.id))).status, 200);
  const get = fixture.bucket.get;
  fixture.bucket.get = async name => {
    const value = await get(name);
    if (name === page) fixture.now++;
    return value;
  };
  assert.equal((await fixture.request(archiveEndpoint(active.id))).status, 404, 'expires during read');
});

test('archive and live minutes apply the same visual conflict and remove stale speaker labels', async () => {
  const roster = meeting('301', {members:['김가나','이나라']});
  const fixture = setup({now:start + 45_000, meetings:[roster], attributeSpeakers:speaker.attribute});
  const intro = cue(1, '김가나 의원입니다.');
  const stale = cue(20, '자료를 제출해 주세요.', {speaker:{name:'김가나', role:'의원', method:'저장된 이전 추정'}});
  fixture.store(captionKey(roster.id), {
    meetingId:roster.id, updatedAt:stamp(start + 45_000), status:'ended', cues:[intro, stale],
  });
  assert.equal((await readJson(fixture.request('/api/live/minutes?meetingId=301'))).cues[0].speaker?.name, '김가나');
  fixture.now += 1000;
  const plate = {meetingId:roster.id, updatedAt:stamp(fixture.now),
    observations:[{capturedAt:intro.observedAt, matchedMembers:['이나라']}]};
  assert.equal((await fixture.put('/api/live/nameplates?meetingId=301', plate)).status, 204);
  fixture.now += 4000;

  const live = await readJson(fixture.request('/api/live/minutes?meetingId=301'));
  const archive = (await readJson(fixture.request(archiveEndpoint(roster.id)))).minutes;
  assert.match(live.cues[0].speaker?.method || '', /불일치/);
  assert.equal(live.cues[1].speaker, undefined);
  assert.equal(archive.speakerAttributionApplied, true);
  assert.deepEqual(archive.cues, live.cues);
});

test('a completed archive keeps its original meeting roster after the schedule changes', async () => {
  const active=meeting('302',{members:['김가나','이나라']});
  const fixture=setup({now:start+45000,meetings:[active],attributeSpeakers:speaker.attribute});
  const intro=cue(1,'김가나 의원입니다.');
  assert.equal((await fixture.write(active.id,'ended',[intro])).status,204);
  fixture.now+=1000;
  const plate={meetingId:active.id,updatedAt:stamp(fixture.now),observations:[{capturedAt:intro.observedAt,matchedMembers:['이나라']}]};
  assert.equal((await fixture.put('/api/live/nameplates?meetingId=302',plate)).status,204);
  fixture.rotate([meeting('303',{members:['전혀다름']})]);
  const downloaded=await readJson(fixture.request(archiveEndpoint('302')));
  const live=await readJson(fixture.request('/api/live/minutes?meetingId=302'));
  assert.deepEqual(downloaded.minutes,live);
  assert.equal(live.speakerAttributionApplied,true);
  assert.match(live.cues[0].speaker.method,/불일치/);
  assert.equal(downloaded.meeting.members,undefined);
  assert.equal(fixture.objects.get(captionKey('302')).customMetadata.archiveV1.includes('김가나'),false);
});

const packaged = fileURLToPath(new URL('../../evidence/captures/', import.meta.url));
const captures = process.env.COUNCIL_ARCHIVE_CAPTURES || await access(packaged).then(() => packaged, error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

test('integration: packaged historical captures contain 959, 2094 and 1035 cues', {
  skip:captures ? false : 'provide COUNCIL_ARCHIVE_CAPTURES or an adjacent evidence/captures folder',
}, async () => {
  const {meetings} = JSON.parse(await readFile(new URL('../dist/data/archive-seed-meetings.json', import.meta.url), 'utf8'));
  const expected = {'2852':959, '2853':2094, '2855':1035};
  const fixture = setup({now:Date.parse('2026-11-26T12:00:00+09:00'), archiveMeetings:meetings});
  for (const id of Object.keys(expected)) {
    const {minutes} = JSON.parse(await readFile(join(captures, id + '.json'), 'utf8'));
    assert.equal(minutes.meetingId, id);
    fixture.store(captionKey(id), minutes);
  }
  const rows = (await readJson(fixture.request(catalogEndpoint))).meetings;
  assert.deepEqual(new Set(rows.map(row => row.id)), new Set(Object.keys(expected)));
  assert.ok(rows.every(row => row.status === 'unknown' && row.completionAt === null));
  for (const [id, count] of Object.entries(expected)) {
    const {minutes} = await readJson(fixture.request(archiveEndpoint(id)));
    assert.equal(minutes.cues.length, count, id);
  }
});
