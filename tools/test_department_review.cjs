const test = require('node:test');
const assert = require('node:assert/strict');
require('../dist/department-review.js');
const {suggestions} = globalThis.CouncilDepartmentReview;
test('reviewed department variant needs the official current agenda', () => {
  const heard = '자원수란과에서 자료를 제출합니다.';
  assert.deepEqual(suggestions(heard,['자원순환과']), [{heard:'자원수란과',official:'자원순환과'}]);
  assert.deepEqual(suggestions(heard,['도시계획과']), []);
  assert.deepEqual(suggestions('자원순환과에서 2억 원을 제출합니다.',['자원순환과']), []);
  assert.deepEqual(suggestions('김 의원님이 말씀하신 제9조입니다.',['자원순환과']), []);
});
