import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {copyFile,mkdir,mkdtemp,rename,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';

function fixture(id,date) {
  // These IDs only address the in-process preview. The official URLs are never fetched.
  const source='https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no='+id;
  return {date,defaultMeetingId:id,meetings:[{id,title:'편성 전환 검증',label:'합성 시험',source,officialPage:source,
    provider:'hls',playlist:'https://cast.sncouncil.go.kr:4443/live/ch1.sdp/playlist.m3u8',
    scheduledAt:date+'T09:30:00+09:00',endsAt:date+'T23:59:59+09:00'}]};
}

test('running preview rotates validated live schedules and keeps earlier captured minutes', {timeout:12000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'council-live-rotation-'));
  const old=fixture('900001','2026-11-25'), next=fixture('900002','2026-11-26');
  const manifestPath=join(root,'dist/data/live-meetings.json');
  const captures=join(root,'captures');
  const files=['tools/serve_local.mjs','worker/captions.mjs','worker/vod.mjs','dist/live-speaker.js',
    'dist/speaker-review.js','dist/nameplate-review.js','dist/speaker-policy.js'];
  let child, exited;
  t.after(async()=>{
    if (child?.exitCode===null && child.signalCode===null) child.kill();
    if (exited) await exited;
    await rm(root,{recursive:true,force:true});
  });
  for (const file of files) {
    const dest=join(root,file);
    await mkdir(dirname(dest),{recursive:true});
    await copyFile(new URL('../'+file,import.meta.url),dest);
  }
  await mkdir(dirname(manifestPath),{recursive:true});
  await mkdir(captures);
  for (const [name,data] of Object.entries({'vod-rosters':{},'registered-vod-staff':{},'vod-index':{meetings:[]},
    'archive-seed-meetings':{meetings:[]}})) await writeFile(join(dirname(manifestPath),name+'.json'),JSON.stringify(data));
  await writeFile(manifestPath,JSON.stringify(old));
  await writeFile(join(root,'clock.cjs'),"Date.now=()=>Date.parse('2026-11-26T01:00:00Z');\n");
  const cue={id:'1',text:'이전 회의의 원문입니다.',rawText:'이전 회의의 원문입니다.',flags:[],
    start:12,end:15,observedAt:'2026-11-25T01:00:12.000Z'};
  await writeFile(join(captures,'900001.json'),JSON.stringify({minutes:{meetingId:'900001',status:'ended',
    updatedAt:'2026-11-25T01:00:16.000Z',cues:[cue]}}));
  const probe=createServer().listen(0,'127.0.0.1');
  await once(probe,'listening');
  const {port}=probe.address();
  await new Promise(resolve=>probe.close(resolve));
  child=spawn(process.execPath,['--require',join(root,'clock.cjs'),join(root,'tools/serve_local.mjs'),
    '--port',String(port),'--captures',captures],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  exited=new Promise(resolve=>child.once('exit',resolve));
  await Promise.race([once(child.stdout,'data'),once(child.stderr,'data').then(([error])=>assert.fail(String(error))),
    exited.then(code=>assert.fail('Preview exited before startup: '+code))]);
  const get=path=>fetch('http://127.0.0.1:'+port+path,{signal:AbortSignal.timeout(2500)});
  const live=id=>get('/api/live/captions?meetingId='+id);
  const catalog=()=>get('/data/live-meetings.json').then(r=>r.json());
  assert.deepEqual(await catalog(),old);
  assert.equal((await live('900001')).status,200);
  assert.match(await (await live('900002')).text(),/Unknown meeting/);

  await writeFile(manifestPath,'{"date":"2026-11-26","meetings":');
  assert.deepEqual(await catalog(),old);
  await writeFile(manifestPath,JSON.stringify({...next,meetings:[{...next.meetings[0],source:undefined}]}));
  assert.deepEqual(await catalog(),old);
  assert.equal((await live('900001')).status,200);

  const replacement=manifestPath+'.new';
  await writeFile(replacement,JSON.stringify(next));
  await rename(replacement,manifestPath);
  const [actual,future,previous]=await Promise.all([catalog(),live('900002'),live('900001')]);
  assert.deepEqual(actual,next);
  assert.match(await future.text(),/Captions have not started/);
  assert.match(await previous.text(),/Unknown meeting/);
  const record=await get('/api/archive/meetings/900001');
  assert.equal(record.status,200);
  assert.equal((await record.json()).minutes.cues[0].text,cue.text);
  assert.equal((await get('/api/live/minutes?meetingId=900001')).status,200);
});
