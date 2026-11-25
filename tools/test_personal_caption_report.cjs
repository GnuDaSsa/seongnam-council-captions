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

test('HTTPS report links prefill only the official GitHub issue form with inert caption excerpts',()=>{
  const url=new URL(reports.issueUrl({...context,meetingTitle:'회의 @someone',
    quote:'@someone\n## 가짜 제목\n<img src=x>',rawQuote:'원래 인식'}));
  assert.equal(reports.modeFor('https://council.example'),'github');
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
