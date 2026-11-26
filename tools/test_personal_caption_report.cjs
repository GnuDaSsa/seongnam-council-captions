'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const reports=require('../dist/personal-caption-report.js');

const context={meetingId:'5551',meetingTitle:'도시건설위원회 행정사무감사 제1일차',cueId:'local-1-5.47',
  start:2400.47,end:2403.18,speaker:'발언자 미확인',quote:'이제 이 부분을 확인해 주세요.',rawQuote:'이제 이 부분을 화긴해 주세요.'};
const draft={kind:'발언자 오류',note:'원음 확인을 부탁합니다.',id:'099391fb-c2e1-4d7c-a3c5-c3082f00bd69'};

test('personal report keeps generated caption, original text and clip timing in a localhost fragment',()=>{
  const packed=new URL(reports.reportUrl(context,draft));
  assert.equal(packed.origin,'http://127.0.0.1:48193');
  assert.equal(packed.search,'');
  assert.deepEqual(reports.fromHash(packed.hash),{context,draft});
  assert.equal(reports.officialUrl(context),'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5551&position=2400');
  assert.equal(reports.localPlayback('http://127.0.0.1:4186'),true);
  assert.equal(reports.localPlayback('http://localhost:4186'),true);
  for(const other of ['https://example.com','http://localhost:48193','http://127.0.0.1:41860','null'])
    assert.equal(reports.localPlayback(other),false);
});

test('bad positions, oversized captions and caller-supplied target URLs cannot enter the form',()=>{
  for(const change of [{meetingId:'5551&position=0'},{cueId:'../cue'}, {start:'2400'}, {end:2400},
    {end:2460},{meetingTitle:'\x01bad'},{quote:'가'.repeat(1601)},{rawQuote:''},
    {sourceUrl:'https://third-party.invalid/'}]){
    const bad={...context,...change};
    assert.equal(reports.reportUrl(bad),'');
    assert.equal(reports.fromHash(reports.prefix+encodeURIComponent(JSON.stringify({context:bad}))),null);
  }
  assert.equal(reports.fromHash(reports.prefix+'%E2%80'),null);
  assert.equal(reports.reportUrl(context,{...draft,id:'mismatch'}),'');
  const textOnly={...context,quote:'<img src=x onerror="alert(0)"> @contact'};
  assert.equal(reports.fromHash(new URL(reports.reportUrl(textOnly)).hash).context.quote,textOnly.quote);
});

test('shared reports carry a real wall timestamp and cannot encode a VOD seek',()=>{
  const {start,end,...text}=context;
  const shared={...text,meetingId:'2853',cueId:'1795587268650155068',observedAt:'2026-11-25T09:50:07.687Z'};
  const packed=new URL(reports.reportUrl(shared,draft));
  assert.ok(packed.hash.startsWith('#shared-report='));
  assert.deepEqual(reports.fromHash(packed.hash),{context:shared,draft});
  assert.equal(reports.koreanWallTime(shared.observedAt),'2026-11-25 18:50:07 (한국시간)');
  assert.equal(reports.officialUrl(shared),'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=2853');
  assert.equal(reports.fromHash(packed.hash.replace('#shared-report=',reports.prefix)),null);
  assert.equal(reports.reportUrl({...shared,start,end}),'');
  assert.equal(reports.reportUrl({...shared,observedAt:'2026-02-30T12:32:15.000Z'}),'');
  assert.equal(reports.reportUrl({...shared,observedAt:'2026-11-25T18:50:07+09:00'}),'');
});

test('legacy issue links preserve inert caption excerpts and hosted HTTPS selects the site form',()=>{
  const url=new URL(reports.issueUrl({...context,meetingTitle:'회의 @someone',
    quote:'@someone\n## 가짜 제목\n<img src=x>',rawQuote:'원래 인식'}));
  assert.equal(reports.modeFor('https://council.example'),'hosted');
  assert.equal(reports.modeFor('http://127.0.0.1:4186'),'local');
  assert.equal(reports.modeFor('http://example.test'),'');
  assert.equal(reports.modeFor('https://user@example.test'),'');
  assert.equal(url.origin+url.pathname,reports.issuesUrl+'/new');
  assert.deepEqual([...url.searchParams.keys()],['title','body']);
  assert.match(url.searchParams.get('title'),/＠someone · 00:40:00–00:40:03$/);
  assert.match(url.searchParams.get('body'),/\n\n    @someone\n    ## 가짜 제목\n    <img src=x>\n/);
  assert.ok(url.searchParams.get('body').includes(reports.officialUrl(context)));
  assert.equal(reports.issueUrl({...context,sourceUrl:'https://third-party.invalid'}),'');
});

test('bounded public issue links retain source and headings for long multilingual cues',()=>{
  const full=reports.issueUrl({...context,quote:'오'.repeat(1600),rawQuote:'원'.repeat(1600)});
  assert.ok(full && full.length<=7500);
  const body=new URL(full).searchParams.get('body');
  assert.match(body,/오…\n/);
  assert.match(body,/원…\n/);
  assert.ok(body.includes(reports.officialUrl(context)));
  const {start,end,...text}=context;
  const shared=new URL(reports.issueUrl({...text,meetingId:'2853',observedAt:'2026-11-25T09:50:07.687Z'}));
  assert.match(shared.searchParams.get('body'),/live_no=2853\)/);
  assert.match(shared.searchParams.get('body'),/2026-11-25 18:50:07 \(한국시간\)/);
  assert.ok(!shared.searchParams.get('body').includes('position='));
});

test('site stores validated reports with the observed source, allows a long VOD cue and waits for a matching receipt',async()=>{
  assert.equal(reports.hostedDraft(context,'live-personal'),null);
  assert.equal(reports.hostedDraft({...context,sourceUrl:'https://other.invalid'},'vod-existing'),null);
  const entry=reports.hostedDraft({...context,end:context.start+85},'vod-existing');
  const sent=[];
  const accepted=async(url,opts)=>{
    assert.equal(url,'/api/reports'); assert.equal(opts.method,'POST');
    assert.equal(opts.headers['Content-Type'],'application/json');
    const data=JSON.parse(opts.body); sent.push(data);
    return Response.json({receipt:true,id:data.id,deliveryDay:'2026-11-27'});
  };
  await reports.submit(entry,accepted);
  assert.equal(sent.length,0);
  entry.note='기관명 확인'; entry.kind='자막 내용 오류';
  await reports.submit(entry,async(url,opts)=>{sent.push(JSON.parse(opts.body)); return new Response(null,{status:503});});
  assert.equal(entry.deliveryDay,''); assert.equal(entry.note,'기관명 확인');
  await reports.submit(entry,async(url,opts)=>{sent.push(JSON.parse(opts.body));return Response.json({id:'wrong',receipt:true,deliveryDay:'2026-11-27'});});
  assert.equal(entry.deliveryDay,'');
  await reports.submit(entry,accepted);
  await reports.submit(entry,accepted);
  assert.equal(sent.length,3); assert.deepEqual(sent[0],sent[1]); assert.deepEqual(sent[1],sent[2]);
  assert.equal(sent[0].context.source,'vod-existing');
  assert.equal(sent[0].context.end,context.start+85);
  assert.equal(entry.deliveryDay,'2026-11-27');
});

test('concurrent submit is suppressed; a changed payload after a failed send gets a new key',async()=>{
  const {start,end,...rest}=context;
  const value={...rest,observedAt:'2026-11-26T01:00:00.000Z'};
  const draft=reports.hostedDraft(value,'live-personal');
  assert.equal(draft.context.source,'live-personal');
  const id=draft.id;
  draft.note='첫 제보';
  let resolve, calls=0;
  const delayed=() => {calls++;return new Promise(done=>{resolve=done;});};
  const a=reports.submit(draft,delayed);
  await reports.submit(draft,delayed);
  assert.equal(calls,1);
  resolve(new Response(null,{status:503})); await a;
  draft.note='수정한 의견';
  await reports.submit(draft,async()=>new Response(null,{status:429}));
  assert.notEqual(draft.id,id);assert.match(draft.message,/잠시 후/);
});

test('editing the site form preserves a selected cue and restores its receipt after switching cues',async t=>{
  const field=()=>({value:'',events:{},addEventListener(type,handler){this.events[type]=handler;}});
  const kind=field(),note=field(),status={},button={},excerpt={};
  const form={...field(),elements:{namedItem:key=>key==='kind'?kind:note},
    querySelector:selector=>selector==='[role=status]'?status:selector==='[type=submit]'?button:excerpt};
  const show=reports.bindForm({append(){}},{content:{firstElementChild:{cloneNode:()=>form}}});
  const first=reports.hostedDraft(context,'vod-existing');
  const second=reports.hostedDraft({...context,cueId:'other',quote:'다른 자막'},'vod-existing');
  show(first); assert.equal(button.disabled,true);
  note.value='이 구간의 발언자를 확인해 주세요.';note.events.input();
  kind.value='발언자 오류';kind.events.change();
  let resolve,body;
  t.mock.method(globalThis,'fetch',(url,opts)=>{
    assert.equal(url,'/api/reports');body=JSON.parse(opts.body);
    return new Promise(done=>{resolve=done;});
  });
  const result=form.events.submit({preventDefault(){}});
  assert.equal(button.disabled,true);assert.deepEqual(body.context,first.context);
  assert.equal(body.note,'이 구간의 발언자를 확인해 주세요.');assert.equal(body.kind,'발언자 오류');
  show(second);assert.equal(note.value,'');assert.equal(excerpt.textContent,'다른 자막');
  resolve(Response.json({receipt:true,id:body.id,deliveryDay:'2026-11-27'}));await result;
  assert.equal(status.textContent,'');show(first);
  assert.match(status.textContent,/접수했습니다. 2026-11-27 오후 9시/);assert.equal(button.disabled,true);
  assert.equal(note.value,body.note);
});
