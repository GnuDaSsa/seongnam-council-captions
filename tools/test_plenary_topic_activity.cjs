const {test} = require('node:test');
const assert = require('node:assert/strict');
const {attribute,registeredVodHref} = require('../dist/live-speaker.js');

// Unchanged text/timing from recorded 5488 generic ASR cues 20 and 21.
const meeting = {title:'제2차 본회의',members:[],date:'2026-10-08',scheduledAt:'2026-10-07T15:00:00.000Z'};
const origin = Date.parse(meeting.scheduledAt);
const at = (seconds, time=origin) => new Date(time+Math.round(seconds*1000)).toISOString();
const make = (id,start,end,text,flags) => ({id,start,end,text,rawText:text,flags,observedAt:at(start)});
const call = make('call',126.5,131.14,'그러면 민영미 의원님 나오셔서 발언하여 주시기 바랍니다.',['name']);
const intro = make('intro',160.91,167.74,'2매 1, 2동, 3평동 민영미 의원입니다. 오늘 저는 20년이 가까이 비어든 땅.',['number','name']);
const rows = [call,intro];
const edit = (row,text) => ({...row,text,rawText:text});

test('pre-meeting official activity and election corroborate only the exact plenary first-person topic',()=>{
  const result=attribute(meeting,rows);
  assert.ok(!result.call?.name);
  assert.equal(result.intro?.name,'민영미');
  assert.equal(result.intro?.role,'의원');
  assert.equal(result.intro?.confidence,'low');
  assert.equal(result.intro?.basis,'plenary-first-person-topic');
  assert.deepEqual(result.intro.evidence,['call','intro']);
  assert.match(result.intro.method,/사전 의정활동 공고/);
  assert.equal(registeredVodHref(result.intro.registeredVodReference),'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no=5403&position=7594');
  assert.deepEqual(result.intro.officialActivityReferences.map(row=>row.publishedOn),['2026-07-30','2026-08-05']);
  assert.ok(result.intro.officialActivityReferences.every(row=>new URL(row.sourceUrl).hostname==='www.sncouncil.go.kr'));
  assert.ok(!attribute(meeting,[call]).intro);
  const normal=attribute({...meeting,members:['민영미','추선미']},rows).intro;
  assert.equal(normal?.name,'민영미');
  assert.equal(normal.registeredVodReference,undefined);
});

test('authority conflict, ambiguity and unrelated intro shapes leave the name blank',()=>{
  for (const [source,cues] of [
    [{...meeting,members:['추선미']},rows],
    [{...meeting,members:['민영미','민영미']},rows],
    [{...meeting,staffRoster:[{name:'민영미',role:'주무관'}]},rows],
    [{...meeting,registeredVodStaffRoster:[{name:'민영미',role:'전문위원'}]},rows],
    [{...meeting,title:'문화복지체육위원회'},rows],
    [meeting,[edit(call,'추선미 의원님 수고하셨습니다. 다음은 민영미 의원님 나오셔서 발언해 주시기 바랍니다.'),intro]],
    [meeting,[edit(call,call.text.replace('민영미','추선미')),intro]],
    [meeting,[call,edit(intro,'존경하는 성남시민 여러분, 이매동지역구 시의원 민영미입니다.')]],
    [meeting,[call,edit(intro,intro.text.replace('오늘 저는','오늘 제가 대신 전해 드릴 내용은'))]],
    [meeting,[call,{...intro,flags:['mixed']}]],
  ]) assert.ok(!attribute(source,cues).intro?.name);
});

test('corroboration uses a valid Korean meeting date inside both authority windows',()=>{
  const changeDay = date => {
    const start = Date.parse(date+'T00:00:00+09:00');
    return [{...meeting,date,scheduledAt:at(0,start)},rows.map(row=>({...row,observedAt:at(row.start,start)}))];
  };
  for (const [source,cues] of [
    [{...meeting,date:'2026-10-07'},rows],
    [{...meeting,date:'2026-02-30'},rows],
    [{...meeting,term:9},rows],
    [{...meeting,councilTerm:11},rows],
    [{...meeting,memberRoster:{term:9}},rows],
    [meeting,rows.map(row=>({...row,observedAt:at(row.start,origin-86400_000)}))],
    changeDay('2026-07-29'),
    changeDay('2026-11-04'), // 91 days since the most recent prior activity.
    changeDay('2028-07-01'),
  ]) assert.ok(!attribute(source,cues).intro?.name);
});
