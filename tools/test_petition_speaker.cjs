const {test}=require('node:test');
const assert=require('node:assert/strict');
const {attribute}=require('../dist/live-speaker.js');
const meeting={title:'제312회 제1차 도시건설위원회',members:['김종환','박기범']};
const date=Date.parse('2026-08-28T01:00:00Z');
function row(id,text,start,end,flags=[]) {
  return {id,text,rawText:text,start,end,flags,observedAt:new Date(date+Math.round(start*1000)).toISOString()};
}
const agenda=row('a','다음은 교통기획과 소관 김종환 의원님께서 발의한 성남역 백현동 복합환승센터 건립에 관한 청원을 상정합니다.',0,11.52,['name']);
const call=row('b','김종환 의원님 나오셔서 제안 설명해 주시기 바랍니다.',11.52,14.8,['name']);
const greeting=row('c','안녕하십니까? 본청원은 나.',20.72,26.23);
const presentation=row('d','청원에 대해서 제안 설명드리겠습니다. 백현동 성남역 복합환승센터 건립 청원에 대하여 제안 설명드리겠습니다.',28.69,39.69);
const next=row('e','본 청원은 수도권 남부의 교통을 다루고 있습니다.',40,44);
const hearing=[agenda,call,greeting,presentation,next];
const replace=(record,other)=>hearing.map(r=>r.id===record.id ? other : r);
const edit=(record,text)=>({...record,text,rawText:text});
test('petition explanation matches the repeated name, chair invitation and specific petition subject',()=>{
  const result=attribute(meeting,hearing);
  assert.equal(result.d?.name,'김종환');
  assert.deepEqual(result.d.evidence,['a','b','c','d']);
  for(const id of ['a','b','c','e']) assert.ok(!result[id]?.name);
});
test('a split petition title identifies only the second delivered fragment',()=>{
  const pref=row('first','청원에 대해서 제안 설명드리겠습니다. 백현동 신보시 등 35명이 서명 청원한',28.69,34.61,['number']);
  const title=row('last','백현동 성남역 복합환승센터 건립 청원에 대하여 제안 설명드리겠습니다. 본청원은 수도권 남부의 핵심 교통 거점인',34.69,46.13);
  const first=[agenda,call,edit(greeting,'안녕하십니까? 본청원은 나...'),pref];
  assert.ok(!attribute(meeting,first).first?.name);
  assert.deepEqual(attribute(meeting,[...first,title]).last?.evidence,['a','b','c','first','last']);
  const thirdParty=edit(title,title.text.replace('본청원은','위원장님께서 대신 '));
  assert.ok(!attribute(meeting,[...first,thirdParty]).last?.name);
  assert.ok(!attribute(meeting,[...first,{...title,start:36.61}]).last?.name);
});
test('common legislative language, mixed turns, a proxy and clock gaps cannot provide the presenter name',()=>{
  for(const [source,cues,gaps] of [
    [meeting,hearing.slice(1)],
    [meeting,replace(call,edit(call,call.text.replace('김종환','박기범')))],
    [meeting,replace(greeting,edit(greeting,'제가 대신 읽겠습니다.'))],
    [meeting,replace(presentation,edit(presentation,presentation.text.replace('백현동','판교동')))],
    [meeting,replace(presentation,edit(presentation,presentation.text.replace('복합환승센터','복지센터')))],
    [meeting,replace(presentation,edit(presentation,'청원에 대해서 대신 읽겠습니다. '+presentation.text))],
    [meeting,replace(presentation,edit(presentation,'청원에 대해서 자료가 있습니까? '+presentation.text))],
    [meeting,replace(agenda,edit(agenda,agenda.text.replace('성남역 백현동 복합환승센터 건립','성남시의 지역주민 개선방안 건립')))],
    [meeting,replace(presentation,{...presentation,flags:['segment_review']})],
    [meeting,replace(agenda,{...agenda,rawText:agenda.rawText.replace('김종환','김종안')})],
    [meeting,replace(greeting,{...greeting,observedAt:new Date(date+150000).toISOString()})],
    [meeting,hearing,[{start:call.observedAt,end:presentation.observedAt}]],
    [{...meeting,members:['김종환','김종환']},hearing],
    [{...meeting,title:'본회의'},hearing],
  ]) assert.ok(!attribute(source,cues,[],gaps).d?.name);
});

