const {test}=require('node:test');
const assert=require('node:assert/strict');
const {attribute}=require('../dist/live-speaker.js');
const {meetings}=require('../dist/data/live-meetings.json');
const original=meetings.find(meeting=>meeting.id==='2853');
const staff=original.staffRoster.find(member=>member.name==='이종빈');
const meeting={title:'경제환경위원회',label:'행정사무감사 제1일차',scheduledAt:'2026-11-25T13:30:00+09:00',
  members:[],staffRoster:[staff]};
const startTime=Date.parse('2026-11-25T08:32:27.387Z');
function cue(id,start,end,text,flags=[]) {
  return {id, start,end,text,rawText:text,flags,observedAt:new Date(startTime+start*1000).toISOString()};
}
const call=cue('call',0,10.66,'그러면 이종빈 부른 도시 사업소장님과 각 과장님께서는 앞으로 나오셔서 선서를 하여 주시기 바랍니다.');
const opening=cue('opening',17.34,36.29,'선서 본인은 행정사무감사를 실시함에 있어 성실하게 감사를 받을 것이며 양심에 따라 거짓없이 진술할 것이며');
const closing=cue('closing',36.3,38.9,'이것을 소약하고 이에 선서합니다.');
const signature=cue('signature',38.9,43.74,'2026년 11월 25일 성남시 푸른 도시 사업소장 이종빈',['number']);
const after=cue('after',45,47,'이어서 말씀드리겠습니다.');
const rows=[call,opening,closing,signature,after];
function replace(row,clip) {
  return rows.map(current=>current.id===row.id ? clip : current);
}
function withText(row,text) {
  return {...row,text,rawText:text};
}
test('an audit witness signs the completed oath with the matching date, city, office and name',()=>{
  const found=attribute(meeting,rows);
  assert.equal(found.signature?.name,'이종빈');
  assert.equal(found.signature.role,'푸른도시사업소장');
  assert.deepEqual(found.signature.evidence,['call','opening','closing','signature']);
  assert.ok(!found.call?.name && !found.opening?.name && !found.closing?.name && !found.after?.name);
});
test('a repeated oath, other witness, edited caption or lost continuity cannot identify the signatory',()=>{
  for (const [source,clips,gaps] of [
    [meeting,rows.slice(1)], [meeting,rows.filter(row=>row!==opening)],
    [meeting,replace(call,withText(call,call.text.replace('이종빈','다른이')))],
    [meeting,replace(call,withText(call,call.text.replace('부른 도시 사업소장','직원')))],
    [meeting,replace(signature,withText(signature,signature.text.replace('25일','24일')))],
    [meeting,replace(signature,withText(signature,signature.text.replace('이종빈','이정빈')))],
    [meeting,replace(signature,withText(signature,signature.text.replace('푸른','부른')))],
    [meeting,replace(signature,{...signature,rawText:'2026년 11월 25일 성남시 사업소장 이정빈'})],
    [meeting,replace(signature,{...signature,flags:['overlap']})],
    [meeting,replace(closing,{...closing,observedAt:'2026-11-25T08:35:00.000Z'})],
    [meeting,[...rows,cue('overlap',39,42,'다음입니다.')]],
    [meeting,rows,[{start:closing.observedAt,end:signature.observedAt}]],
    [{...meeting,staffRoster:[staff,staff]},rows],
    [{...meeting,staffRoster:[{...staff,appointedOn:'2026-11-26'}]},rows],
    [{...meeting,staffRoster:[{...staff,candidateOnly:true}]},rows],
    [{...meeting,members:[staff.name]},rows],
    [{...meeting,label:'임시회'},rows],
  ]) assert.ok(!attribute(source,clips,[],gaps).signature?.name);
});

