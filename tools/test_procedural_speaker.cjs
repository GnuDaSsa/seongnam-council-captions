const test=require('node:test');
const assert=require('node:assert/strict');
const {attribute}=require('../dist/live-speaker.js');
const committee={id:'5418',title:'제312회 제1차 도시건설위원회',members:['김종환']};
const stamp='2026-08-28T01:00:00.000Z';
function role(words,changes={},meeting=committee) {
  const cue={id:'c',start:1,end:12,observedAt:stamp,text:words,rawText:words,flags:[],...changes};
  return attribute(meeting,[cue]).c;
}
const intro='자석을 정돈해 주시기 바랍니다. 성원이 되었음으로 제312회 성남시의회 임시의 제1차 도시건설위원회를 계획하겠습니다.';
const agenda='먼저 교통기획관 소관, 김종안 의원님 등 연례 분께서 발휘한 성남시 철도기금, 철도건설기금의 설치 및 운영에 관한 조례 일부 개정안을 상정합니다.';
const decision='없으시면 성남시 철도 건설 기금의 설침이 운영에 관한 조례 일부 개정 조례안은 원한 가게를 되었음을 선포합니다.';
test('an explicit live opening, motion or declaration identifies only the person presiding',()=>{
  for(const line of [intro,agenda,decision,'다음은 성남시 조례 일부 개정 조례안 등 세 건을 일괄 상정합니다.']){
    assert.deepEqual([role(line)?.role,role(line)?.name,role(line)?.evidence],['의사진행자','',['c']]);
  }
});
test('reports, requests, quoted minutes, off-body openings and a mixed vote remain unassigned',()=>{
  for(const line of [
    '원안 가결하였습니다.', '의결해 주실 것을 당부드립니다.',
    '먼저 위원장께서 “조례안을 상정합니다”라고 말씀했습니다.',
    '다음은 과거 회의록을 낭독합니다. 의사일정 제1항 조례안을 상정합니다.',
    '다음은 가결되었음을 선포해 주시기 바랍니다.', '없으시면 이 청원을 취하하겠습니다.',
    '집행부에서는 다른 의견이 있습니까? 없습니다. 없으시면 청원이 채택되었음을 선포합니다.',
    '다음은 조례안을 상정하는 대신 제가 대안을 제안합니다.',intro.replace('도시건설위원회','경제환경위원회')]){
    assert.notEqual(role(line)?.method,'회의 개의·안건 상정·의결을 직접 알린 문장 (실명 미확인)');
  }
  assert.equal(role(agenda,{rawText:'먼저 제가 발표하는 안건입니다.'}),undefined);
  for(const flag of ['mixed','overlap','segment_review']) assert.equal(role(agenda,{flags:[flag]}),undefined);
  assert.equal(role(agenda,{},{id:'x',title:'교통부서 실무회의',members:[]}),undefined);
  const cue={id:'c',start:1,end:10,observedAt:stamp,text:agenda,rawText:agenda,flags:[]};
  assert.equal(attribute(committee,[cue],[],[{start:stamp,end:null}]).c,undefined);
});

