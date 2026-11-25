// Offline soak backend: ephemeral signature key, in-memory Worker and no network.
import {createInterface} from 'node:readline';
import {appendFileSync, writeFileSync} from 'node:fs';
import {generateKeyPairSync, sign} from 'node:crypto';
import {createSite} from '../worker/captions.mjs';
import live from '../dist/live-speaker.js';

const output = process.argv[2];
if (!output) throw Error('output directory required');
const eventFile = output + '/worker-events.jsonl';
const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const objects = new Map();
const captureUrl = 'https://soak.invalid/api/live/captions?meetingId=5418';
const archiveUrl = 'https://soak.invalid/api/archive/meetings/5418';
const writeEvent = (kind, detail = {}) => appendFileSync(eventFile,
  JSON.stringify({kind, wall:new Date().toISOString(), ...detail}) + '\n');

// Model only the conditional writes and paginated listing used by the Worker.
const bucket = {
  async get(key) { return objects.get(key) || null; },
  async put(key, body, options) {
    const old = objects.get(key);
    if (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== old?.etag) return null;
    if (options?.onlyIf instanceof Headers && options.onlyIf.get('if-none-match') === '*' && old) return null;
    const value = {body, etag:String((Number(old?.etag) || 0) + 1), customMetadata:options?.customMetadata};
    objects.set(key, value);
    return value;
  },
  async list({prefix, cursor}) {
    const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
    const offset = cursor ? Number(cursor) : 0;
    return {objects:keys.slice(offset,offset + 1000).map(key => ({key,customMetadata:objects.get(key).customMetadata})),
      truncated:offset + 1000 < keys.length, cursor:String(offset + 1000)};
  },
};

// Override join times only for a short test; production runs use 10 and 30 minutes.
const testJoins = process.env.COUNCIL_SOAK_TEST_JOINS?.split(',').map(Number);
if (testJoins && (testJoins.length !== 2 || testJoins.some(n => !Number.isFinite(n) || n < 0))) {
  throw Error('invalid test join times');
}
const joins = testJoins || [600,1800];
const subscribers = joins.map((join,index) => ({id:index ? 'late30' : 'late10',join,
  joinedAt:null,seen:new Set(),polls:0,errors:0,notStarted:0,maxTail:0,duplicateRows:0}));
let site, meeting, startWall, tail = [], lastUpdate = 0, updates = 0;
let polling = false, done = false, fakeNow = null, pollFailures = 0;
const published = new Map();

async function poll(force = false) {
  if (!site || polling || done) return;
  polling = true;
  try {
    const elapsed = (Date.now() - startWall) / 1000;
    for (const subscriber of subscribers) {
      if (elapsed < subscriber.join) continue;
      if (subscriber.joinedAt === null) {
        subscriber.joinedAt = Date.now();
        writeEvent('subscriber_join',{id:subscriber.id,elapsed});
      }
      const response = await site.fetch(new Request(captureUrl),{BUCKET:bucket});
      subscriber.polls++;
      if (response.status === 404) { subscriber.notStarted++; continue; }
      if (!response.ok) { subscriber.errors++; continue; }
      const data = await response.json();
      subscriber.maxTail = Math.max(subscriber.maxTail,data.cues.length);
      if (data.cues.length > 100) subscriber.errors++;
      subscriber.duplicateRows += data.cues.length - new Set(data.cues.map(cue=>cue.id)).size;
      for (const cue of data.cues) subscriber.seen.add(cue.id);
      if (force) writeEvent('subscriber_final_poll',{id:subscriber.id,seen:subscriber.seen.size});
    }
  } catch (error) {
    pollFailures++;
    writeEvent('poll_error',{message:String(error)});
  } finally { polling = false; }
}
setInterval(() => void poll(),5000).unref();

async function publish(message) {
  if (!site || done || !Array.isArray(message.cues) || !['live','listening','interrupted'].includes(message.status)) {
    throw Error('invalid publish request');
  }
  const incoming = new Set();
  for (const cue of message.cues) {
    if (!cue?.id || incoming.has(cue.id) || published.has(cue.id)) throw Error('duplicate producer cue ' + cue?.id);
    incoming.add(cue.id);
  }
  const nextTail = [...tail,...message.cues].slice(-100);
  const timestamp = Math.max(Date.now(),lastUpdate + 1);
  const body = JSON.stringify({meetingId:meeting.id,updatedAt:new Date(timestamp).toISOString(),
    status:message.status,cues:nextTail});
  const request = new Request(captureUrl,{method:'PUT',body,
    headers:{'X-Council-Signature':sign(null,Buffer.from(body),privateKey).toString('base64url')}});
  const response = await site.fetch(request,{BUCKET:bucket});
  if (response.status !== 204) throw Error('signed PUT ' + response.status + ' ' + await response.text());
  tail = nextTail;
  lastUpdate = timestamp;
  updates++;
  for (const cue of message.cues) published.set(cue.id,Date.now());
  writeEvent('publish',{mediaEnd:message.mediaEnd,lagSeconds:message.lagSeconds,
    cues:message.cues.length,total:published.size,tail:tail.length,status:message.status});
}

async function finish(message) {
  if (!site || done) throw Error('invalid finish request');
  while (polling) await new Promise(resolve => setTimeout(resolve,20));
  await poll(true);
  const response = await site.fetch(new Request('https://soak.invalid/api/live/minutes?meetingId=5418'),{BUCKET:bucket});
  if (!response.ok) throw Error('minutes ' + response.status);
  const data = await response.json();
  const ids = data.cues.map(cue=>cue.id), unique = new Set(ids);
  const subscriberResults = subscribers.map(subscriber => {
    const expected = [...published].filter(([,at]) => subscriber.joinedAt !== null && at >= subscriber.joinedAt).map(([id])=>id);
    return {id:subscriber.id,joinedAt:subscriber.joinedAt,polls:subscriber.polls,errors:subscriber.errors,notStarted:subscriber.notStarted,
      maxTail:subscriber.maxTail,duplicateRows:subscriber.duplicateRows,expectedAfterJoin:expected.length,
      missed:expected.filter(id=>!subscriber.seen.has(id))};
  });
  const catalog = await site.fetch(new Request('https://soak.invalid/api/archive/catalog'),{BUCKET:bucket});
  if (!catalog.ok) throw Error('archive catalog ' + catalog.status);
  const catalogData = await catalog.json(), record = catalogData.meetings?.find(row=>row.id==='5418');
  if (!record) throw Error('finished archive record missing');
  const archive = await site.fetch(new Request(archiveUrl),{BUCKET:bucket});
  const archiveData = archive.ok ? await archive.json() : null;
  fakeNow = Date.parse(record.expiresAt) - 1;
  const justBefore = (await site.fetch(new Request(archiveUrl),{BUCKET:bucket})).status;
  fakeNow = Date.parse(record.expiresAt);
  const atExpiry = (await site.fetch(new Request(archiveUrl),{BUCKET:bucket})).status;
  fakeNow = null;
  const result = {expiryBoundary:{justBefore,atExpiry},startedAt:new Date(startWall).toISOString(),
    finishedAt:new Date().toISOString(),wallSeconds:(Date.now()-startWall)/1000,mediaSeconds:message.mediaEnd,
    updates,pollFailures,published:published.size,archiveCues:ids.length,duplicateArchiveIds:ids.length-unique.size,
    missingArchive:[...published.keys()].filter(id=>!unique.has(id)),
    unexpectedArchive:ids.filter(id=>!published.has(id)),subscribers:subscriberResults,finalStatus:data.status,
    archiveStatus:archive.status,archiveCuesViaDownload:archiveData?.minutes?.cues?.length ?? null,
    archiveRecord:record,objects:objects.size};
  writeFileSync(output+'/worker-summary.json',JSON.stringify(result,null,2));
  writeEvent('finish',{wallSeconds:result.wallSeconds,published:result.published,archiveCues:ids.length});
  done = true;
  return result;
}

async function handle(message) {
  if (message.type === 'init') {
    if (site || !Number.isFinite(message.startWall)) throw Error('invalid initialization');
    startWall = message.startWall;
    meeting = {id:'5418',title:'도시건설위원회',scheduledAt:new Date(startWall-10000).toISOString(),
      endsAt:new Date(startWall+4*3600000).toISOString(),
      officialPage:'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=5418',members:[],staffRoster:[]};
    site = createSite({assets:{},meetings:[meeting],publicKey:publicKey.export({format:'jwk'}).x,
      attributeSpeakers:live.attribute},()=>fakeNow ?? Date.now());
    writeEvent('init',{startWall});
    return {ok:true};
  }
  if (message.type === 'publish') { await publish(message); return {ok:true}; }
  if (message.type === 'finish') return {ok:true,result:await finish(message)};
  throw Error('unknown command');
}

let chain = Promise.resolve();
createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line => {
  chain = chain.then(async () => {
    try { process.stdout.write(JSON.stringify(await handle(JSON.parse(line)))+'\n'); }
    catch (error) {
      writeEvent('error',{message:String(error)});
      process.stdout.write(JSON.stringify({ok:false,error:String(error)})+'\n');
    }
  });
});
