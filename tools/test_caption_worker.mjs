import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {createSite} from '../worker/captions.mjs';

const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const now = Date.parse('2026-11-25T05:30:00Z');
const meetings = ['2852', '2853'].map(id => ({id, scheduledAt:'2026-11-25T04:30:00Z', endsAt:'2026-11-25T14:59:59Z'}));
const site = createSite({assets:{}, meetings, publicKey:publicKey.export({format:'jwk'}).x}, () => now);
function storage() {
  const objects = new Map();
  return {
    get:async key => objects.get(key),
    head:async key => objects.get(key),
    async put(key, body, options) {
      const old = objects.get(key);
      if (old && options.onlyIf?.etagMatches !== old.etag) return null;
      if (!old) assert.equal(options.onlyIf.get('if-none-match'), '*');
      const obj = {body, customMetadata:options.customMetadata, etag:String((old ? Number(old.etag) : 0)+1)};
      objects.set(key,obj); return obj;
    }
  };
}
const cue = {id:'1',start:0,end:2,text:'성남시의회',rawText:'성남시의회',flags:[]};
const snapshot = (meetingId, ms=now) => ({meetingId,updatedAt:new Date(ms).toISOString(),status:'live',cues:[cue]});
function request(id, data, signed = true) {
  const url = 'https://example.org/api/live/captions?meetingId=' + id;
  if (!data) return new Request(url);
  const body = JSON.stringify(data);
  return new Request(url, {method:'PUT',body,headers:signed ? {'X-Council-Signature':sign(null, Buffer.from(body), privateKey).toString('base64url')} : {}});
}
test('channels never share snapshots; reject unsigned, old, and mismatched updates', async () => {
  const BUCKET = storage();
  const call = request => site.fetch(request, {BUCKET});
  assert.equal((await call(request('2853'))).status, 404);
  assert.equal((await call(request('2853', snapshot('2853'), false))).status, 401);
  assert.equal((await call(request('2853', snapshot('2853')))).status, 204);
  assert.deepEqual(await (await call(request('2853'))).json(), snapshot('2853'));
  assert.equal((await call(request('2852'))).status, 404);
  assert.equal((await call(request('2852', snapshot('2853')))).status, 400);
  assert.equal((await call(request('2853', snapshot('2853',now-1000)))).status, 409);
  assert.equal((await call(request('2853', snapshot('2853',now+1000)))).status, 204);
  assert.equal((await call(request('9999'))).status, 404);
});
test('rejects repeated cue IDs, reversed times, and expired publications', async () => {
  const BUCKET = storage();
  const bad = [snapshot('2852',now-121000),{...snapshot('2852'),cues:[cue,cue]},{...snapshot('2852'),cues:[{...cue,end:-1}]}];
  for (const value of bad) assert.equal((await site.fetch(request('2852',value),{BUCKET})).status,400);
});
