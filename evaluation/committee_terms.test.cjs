const assert = require('node:assert/strict');
require('../dist/committee-terms.js');
const { suggestions } = globalThis.CouncilCommitteeTerms;
const good = {id:'2853',agenda:['환경정책과','생태하천과','기후에너지과']};
for (const [text,heard,official] of [
 ['맨사 환경 생태학 수본 관리에 관하여','맨사 환경 생태학 수본','맹산환경생태학습원'],
 ['탄전습지생태원 공사 현황','탄전습지생태원','탄천습지생태원'],
 ['1윤 차 소음 단속','1윤 차','이륜차'],
 ['이른 차 오토바이 단속','이른 차','이륜차'],
 ['야생 멧돼지 아프리카 대지 열병 방역','아프리카 대지 열병','아프리카돼지열병']]) {
 const result=suggestions(good,text); assert.equal(result.length,1); assert.equal(result[0].heard,heard); assert.equal(result[0].official,official); assert.match(result[0].source,/^https:\/\//);
}
assert.deepEqual(suggestions(good,'이른 차를 타고 출근합니다'),[]);
assert.deepEqual(suggestions(good,'1윤 차 회사 매출'),[]);
assert.deepEqual(suggestions({id:'2852',agenda:good.agenda},'탄전습지생태원'),[]);
assert.deepEqual(suggestions({id:'2853',agenda:[]},'탄전습지생태원'),[]);
assert.deepEqual(suggestions(null,'탄전습지생태원'),[]);
assert.deepEqual(suggestions(good,null),[]);
assert.deepEqual(suggestions(good,'탄천습지생태원 자원순환과 최민수 2027 제9조'),[]);
const text='탄전습지생태원'; const result=suggestions(good,text); result[0].official='변경'; assert.equal(suggestions(good,text)[0].official,'탄천습지생태원'); assert.equal(text,'탄전습지생태원');
console.log('committee terms: five source-linked cases and eight negative/immutability checks passed');
