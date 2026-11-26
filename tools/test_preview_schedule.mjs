import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

// Exercise the request handler with a fake listener, offline sources, and the bundled schedules.
test('local playback serves the Seoul day, record links and matching captures', async t => {
  let handle;
  t.mock.method(http,'createServer',callback=>{
    handle=callback;
    return {listen() {}};
  });
  let now=Date.parse('2026-11-26T10:00:00+09:00');
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:503}));
  await import('./serve_local.mjs');
  async function get(url,method='GET') {
    let status,body;
    await handle({method,url,headers:{host:'127.0.0.1:4186'}},{
      writeHead(code){ status=code; },
      end(bytes){ body=bytes==null?'':Buffer.from(bytes).toString(); },
    });
    return {status,body};
  }
  assert.equal(JSON.parse((await get('/data/live-meetings.json')).body).date,'2026-11-25');
  const result=await get('/api/live/schedule');
  assert.equal(result.status,200);
  const catalog=JSON.parse(result.body);
  assert.equal(catalog.date,'2026-11-26');
  assert.ok(catalog.meetings.some(row=>row.id==='2857'));
  assert.equal((await get('/api/live/captions?meetingId=2857')).body,'Captions have not started');
  assert.deepEqual(await get('/api/live/schedule','HEAD'),{status:200,body:''});
  assert.equal(JSON.parse((await get('/api/live/schedule?meetingId=2853')).body).date,'2026-11-25');
  assert.equal((await get('/api/live/schedule?meetingId=2853&meetingId=2857')).status,400);
  assert.equal((await get('/api/live/schedule?meetingId=777')).status,404);
  now=Date.parse('2026-11-27T00:00:00+09:00');
  assert.equal((await get('/api/live/schedule')).status,503);
  assert.equal(JSON.parse((await get('/api/live/schedule?meetingId=2857')).body).date,'2026-11-26');
});
