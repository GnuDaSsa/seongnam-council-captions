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
const completionCases = [
  ['중공검사', '준공검사'], ['중공 승인', '준공 승인'],
  ['올해 중공 예정', '올해 준공 예정'], ['올해중공예정', '올해준공예정'],
  ['착공부터 중공까지', '착공부터 준공까지'],
  ['언제 중공이 됩니까?', '언제 준공이 됩니까?'],
  ['34년의 중 공이 되더라도', '34년의 준공이 되더라도'],
  ['자료로 가름하고 올해 중공 예정입니다.', '자료로 갈음하고 올해 준공 예정입니다.']
];
for (const [input, expected] of completionCases) assert.equal(result(input), expected, input);
for (const input of [
  '중공 슬래브', '중공 구조', '중공축', '중공 정부', '중공업',
  '중공 슬래브 중공 검사', '속이 중공이 됩니다.',
  '중공을 할 수 있는 가공 공법', '중공하고 심지어는 골조까지 끝났는데'
]) assert.equal(result(input), input, input);
// Captured public ASR cues, not an official transcript or audio verification.
const observedCompletion = [
  ['1795587268650154077', '기후 에너지 환경부에서 사업 허가를 받는 걸 28년까지 끝내야만 34년의 중공을 할 수가 있습니다.', true],
  ['1795587268650154081', '34년의 중공이 되더라도', true],
  ['1795585934998639647', '일단 아직 중공이 되지 않아서요.', true],
  ['1795585934998639649', '저희가 중공된 다음에 지속적으로', true],
  ['1795587269017471438', '그 그 중공 이후에 건축...', true],
  ['1795587269017471484', '승인 착공, 중공, 애정인 단지들입니다.', true],
  ['1795587269017471551', '중공하고 심지어는 골조까지 끝났는데', false],
  ['1795587269017471729', '이제 곧 중공을 앞두고 나서', true]
];
for (const [id, text, changed] of observedCompletion) {
  assert.equal(correction.correct(text).changed, changed, id);
}
const completionCue = {text:'올해 중공 예정', rawText:'올해 중공 예정', flags:[]};
assert.equal(format.initial(completionCue), '올해 준공 예정');
assert.equal(completionCue.rawText, '올해 중공 예정');
const inquiryCases = [
  ['관원 질의에 대한 회신', '관원질의에 대한 회신'],
  ['그런데 늦었다고 하는 건 관원질이 부분에 있어서 저희가 회신을 못 받고 있는 거, 그거를 늦었다고 표현하시는 것 같은데, 사실은 관원질이는 해도 되고 안 해도 되는 사항입니다.',
   '그런데 늦었다고 하는 건 관원질의 부분에 있어서 저희가 회신을 못 받고 있는 거, 그거를 늦었다고 표현하시는 것 같은데, 사실은 관원질의는 해도 되고 안 해도 되는 사항입니다.'],
  ['그런데 저희가 작년에 관원질을 해놓은 거에 대해서 답변을 아직까지 못 받고 있기 때문에...',
   '그런데 저희가 작년에 관원질의를 해놓은 거에 대해서 답변을 아직까지 못 받고 있기 때문에...'],
  ['그 부분에 있어서 좀 관원질이가 늦어졌다는 거지 행정 절차가 지금 늦지는 않습니다.',
   '그 부분에 있어서 좀 관원질의가 늦어졌다는 거지 행정 절차가 지금 늦지는 않습니다.'],
  ['아니, 관원질이가 늦어지는데 아직까지 답을 못 받았다는 거는...',
   '아니, 관원질의가 늦어지는데 아직까지 답을 못 받았다는 거는...']
];
for (const [input, expected] of inquiryCases) assert.equal(result(input), expected, input);
for (const input of [
  '의원 질의에 답변합니다.', '위원 질의에 답변합니다.', '공원 질의에 답변합니다.',
  '관원 질이 좋습니다.', '관언 질의는 불명확합니다.', '관용 질의는 불명확합니다.',
  '관원 지리를 살펴봅니다.', '관원질이가 늦어졌습니다.'
]) assert.equal(result(input), input, input);
const inquiryCue = {text:'관원질이가 늦어졌다는 거지 행정 절차가 지금 늦지는 않습니다.',
  rawText:'관원질이가 늦어졌다는 거지 행정 절차가 지금 늦지는 않습니다.', flags:[]};
assert.equal(format.initial(inquiryCue), '관원질의가 늦어졌다는 거지 행정 절차가 지금 늦지는 않습니다.');
assert.equal(inquiryCue.rawText, '관원질이가 늦어졌다는 거지 행정 절차가 지금 늦지는 않습니다.');
console.log('PASS: meeting-default correction, protected distinctions, ten captured cues, raw and staff edits');
