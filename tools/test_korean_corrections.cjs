const assert = require('node:assert/strict');
const correction = require('../dist/korean-corrections.js');
const format = require('../dist/minutes-format.js');
const fixture = require('./garum_public_fixture.json');
const result = text => correction.correct(text).text;
for (const word of ['자료로', '서면으로', '유인물로']) {
  assert.equal(result(`${word} 가름하겠습니다.`), `${word} 갈음하겠습니다.`);
}
assert.equal(result('유인물로 설명을 가름하겠습니다.'), '유인물로 설명을 갈음하겠습니다.');
assert.equal(result('서면으로 보고를 가름하겠습니다.'), '서면으로 보고를 갈음하겠습니다.');
assert.equal(result('자료로 답변을 가름하여 주시기 바랍니다.'), '자료로 답변을 갈음하여 주시기 바랍니다.');
assert.equal(result('서면으로 보고을 가름하겠습니다.'), '서면으로 보고을 가름하겠습니다.');
for (const sentence of ['두 사업의 우열을 자료로 가름하겠습니다.', '진위는 서면으로 가름합니다.']) {
  assert.equal(result(sentence), sentence);
}
assert.equal(result('당락을 자료로 가름합니다. 답변은 서면으로 가름합니다.'),
  '당락을 자료로 가름합니다. 답변은 서면으로 갈음합니다.');
assert.equal(result('유인물로 가름하도록 하겠습니다.'), '유인물로 갈음하도록 하겠습니다.');
assert.equal(result('먼저 성패를 가름하는 조건입니다. 설명은 자료로 가름하겠습니다. 다음 안건입니다.'), '먼저 성패를 가름하는 조건입니다. 설명은 자료로 갈음하겠습니다. 다음 안건입니다.');
for (const text of ['기업의 성패를 가름하는 핵심 요소', '식물으로 가름하겠습니다.', '유인물로 이후 가름하겠습니다.', '자료로 평가를 가름하겠습니다.', '자료 가름하겠습니다.', '자료로 가름하는 기준입니다.']) assert.equal(result(text),text);
const changed = fixture.filter(row => correction.correct(row.text).changed);
assert.equal(fixture.length,9); assert.equal(changed.length,8);
assert.equal(fixture.find(row => !correction.correct(row.text).changed).id,'1795587268650153586');
const cue={text:'유인물로 가름하겠습니다.',rawText:'유인물로 가름하겠습니다.',flags:[]};
assert.equal(format.initial(cue),'유인물로 갈음하겠습니다.');
assert.equal(cue.rawText,'유인물로 가름하겠습니다.');
const manual='유인물로 가름하겠습니다.';
const lines=format.lines({meeting:{title:'시험'},archive:{cues:[cue],gaps:[]},read:()=>manual,meta:()=>({}),coverage:'시험',bad:format.bad,initial:format.initial});
assert.ok(lines.join('\n').includes(manual), 'staff text must not be rewritten');
console.log('PASS: 8 public archive cues corrected, unrelated term unchanged, original and surrounding text preserved');
