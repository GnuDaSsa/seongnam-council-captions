const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const names = require('../dist/name-correction.js');
// 2026-11-25 경제환경위원회 명단 (dist/data/live-meetings.json)
const ROSTER = ['안광환', '장일남', '김옥수', '서은경', '정봉규', '정연화', '조우현'];
const fix = text => names.correct(text, ROSTER).text;

describe('명단 기반 의원 이름 교정', () => {
  it('2853 생중계에서 실제로 틀린 호칭 이름을 바로잡는다', () => {
    assert.equal(fix('정봉구 의원님, 질의하시러.'), '정봉규 의원님, 질의하시러.');
    assert.equal(fix('성경 의원님, 수고하셨습니다.'), '서은경 의원님, 수고하셨습니다.');
    assert.equal(fix('네, 조희원 의원입니다.'), '네, 조우현 의원입니다.');
    assert.equal(fix('서은경이 의원님'), '서은경 의원님');
    assert.equal(fix('김옥소 위원님'), '김옥수 위원님');
  });
  it('위원장·부위원장 호칭도 같은 규칙으로 바로잡는다', () => {
    assert.equal(fix('안광한 위원장님'), '안광환 위원장님');
    assert.equal(fix('장일람 부위원장님'), '장일남 부위원장님');
  });
  it('호칭이 없거나 집행부 직위면 바꾸지 않는다', () => {
    for (const text of ['장미라 과장님 나오셔서', '정봉구 씨가', '부위원장님 말씀대로', '본 의원이 보기에는', '우리 의원님들이']) {
      assert.equal(fix(text), text, text);
    }
  });
  it('이미 맞는 이름은 그대로 두고 변경 목록을 비운다', () => {
    const result = names.correct('정연화 의원님 수고하셨습니다', ROSTER);
    assert.equal(result.changed, false);
    assert.deepEqual(result.changes, []);
  });
  it('두 위원과 비슷해 모호하면 바꾸지 않는다', () => {
    assert.equal(names.matchMember('김정후', ['김정호', '김정우']), null);
  });
  it('명단이 비면 아무것도 바꾸지 않는다', () => {
    assert.equal(names.correct('정봉구 의원님', []).text, '정봉구 의원님');
  });
});
