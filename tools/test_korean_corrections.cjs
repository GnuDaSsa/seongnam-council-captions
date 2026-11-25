const assert = require('node:assert/strict');
const correction = require('../dist/korean-corrections.js');
const format = require('../dist/minutes-format.js');
const fixture = require('./garum_public_fixture.json');
const result = text => correction.correct(text).text;
const substitutions = [
  ['서면으로 가름.', '서면으로 갈음.'],
  ['답변은 배부해 드린 자료로 가름', '답변은 배부해 드린 자료로 갈음'],
  ['보고는 이것으로 가름을 하겠습니다', '보고는 이것으로 갈음을 하겠습니다'],
  ['브리핑은 설명서로 가름됩니다', '브리핑은 설명서로 갈음됩니다'],
  ['서면으로가름하겠습니다', '서면으로갈음하겠습니다'],
  ['승패를 가름하면 자료로 갈음하겠습니다', '승패를 가름하면 자료로 갈음하겠습니다'],
  ['성패를 가름하며 보고는 서면으로 가름하겠습니다', '성패를 가름하며 보고는 서면으로 갈음하겠습니다'],
  ['우열을 가름하면 보고는 서면으로 가름', '우열을 가름하면 보고는 서면으로 갈음'],
  ['먼저 서면으로 가름. 성패를 가름하고 끝냅니다.', '먼저 서면으로 갈음. 성패를 가름하고 끝냅니다.'],
  ['자료로 가름하겠습니다.', '자료로 갈음하겠습니다.'],
  ['서면으로 보고를 가름하겠습니다.', '서면으로 보고를 갈음하겠습니다.'],
  ['유인물로 설명을 가름하겠습니다.', '유인물로 설명을 갈음하겠습니다.'],
  ['식물으로 가름하겠습니다.', '식물으로 갈음하겠습니다.'],
  ['자료로 상세한 내용을 가름하도록 하겠습니다.', '자료로 상세한 내용을 갈음하도록 하겠습니다.'],
  ['보고는 가름 합니다!', '보고는 갈음 합니다!'],
  ['보고는 가름했으며, 이후 안건입니다.', '보고는 갈음했으며, 이후 안건입니다.'],
  ['가름하여 주시기 바랍니다.', '갈음하여 주시기 바랍니다.'],
  ['기업의 성패를 가름하는 핵심 요소입니다. 보고는 가름하겠습니다.', '기업의 성패를 가름하는 핵심 요소입니다. 보고는 갈음하겠습니다.'],
  ['자료로 가름하겠습니다. 다음 안건을 상정합니다.', '자료로 갈음하겠습니다. 다음 안건을 상정합니다.']
];
for (const [input, expected] of substitutions) {
  assert.equal(result(input), expected, input);
  assert.equal(correction.correct(input).changed, input !== expected, input);
}
const protectedText = [
  '기업의 성패를 가름하는 핵심 요소', '승패를 가름하겠습니다.', '우열을 자료로 가름하겠습니다.',
  '진위는 서면으로 가름합니다.', '당락을 가름하는 기준입니다.', '책임 소재를 가름하겠습니다.',
  '자리 가름하겠습니다.', '자리 가름을 하겠습니다.', '길을 가름하겠습니다.',
  '경계를 가름합니다.', '판가름하겠습니다.', '편가름하지 맙시다.', '가름끈과 가름선입니다.',
  '우열을 가름.', '길을 가름', '서면으로 가름선입니다.', '판가름합니다.', '서면으로가름끈', '가름을 설명합니다.',
  '가름하여 성패를 결정합니다.', '가름을 설명하겠습니다.', '가름선 표시입니다.', '앞판가름하겠습니다.'
];
for (const text of protectedText) {
  assert.equal(result(text), text, text);
  assert.equal(correction.correct(text).changed, false, text);
}
assert.equal(result('당락을 가름합니다. 답변은 가름합니다.'), '당락을 가름합니다. 답변은 갈음합니다.');
const changed = fixture.filter(row => correction.correct(row.text).changed);
assert.equal(fixture.length, 10);
assert.equal(changed.length, 10);
const uncertain = fixture.find(row => row.id === '1795587268650153586');
assert.equal(result(uncertain.text), uncertain.text.replace('가름', '갈음'));
const cue = {text:'유인물로 가름하겠습니다.', rawText:'유인물로 가름하겠습니다.', flags:[]};
assert.equal(format.initial(cue), '유인물로 갈음하겠습니다.');
assert.equal(cue.rawText, '유인물로 가름하겠습니다.');
const manual = '유인물로 가름하겠습니다.';
const lines = format.lines({meeting:{title:'시험'}, archive:{cues:[cue],gaps:[]}, read:()=>manual,
  meta:()=>({}), coverage:'시험', bad:format.bad, initial:format.initial});
assert.ok(lines.join('\n').includes(manual), 'staff text must not be rewritten');
console.log('PASS: meeting-default correction, protected distinctions, ten captured cues, raw and staff edits');
