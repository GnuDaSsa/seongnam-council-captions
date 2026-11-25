const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const checks = require('../dist/caption-checks.js');

describe('표결 인원 숫자 표기', () => {
  it('한자어 수사로 들린 표결 인원을 숫자로 바꾼다', () => {
    assert.equal(checks.voteNumbers('재석의원 육인 중 찬성 오인 반대 일인으로 가결되었음을 선포합니다.').text,
      '재석의원 6인 중 찬성 5인 반대 1인으로 가결되었음을 선포합니다.');
    assert.equal(checks.voteNumbers('재석 십오 명 중 찬성 십이 명 반대 삼 명').text, '재석 15명 중 찬성 12명 반대 3명');
  });
  it('고유어 수사도 숫자로 바꾼다', () => {
    assert.equal(checks.voteNumbers('출석의원 열한 명').text, '출석의원 11명');
    assert.equal(checks.voteNumbers('찬성 스무 명 반대 두 명').text, '찬성 20명 반대 2명');
    assert.equal(checks.voteNumbers('반대 일곱 표').text, '반대 7표');
  });
  it('조사나 일반 낱말과 겹치면 바꾸지 않는다', () => {
    for (const text of ['찬성이 인정됩니다', '찬성 이 인원', '찬성 오 명입니다', '반대 의견이 있습니까']) {
      assert.equal(checks.voteNumbers(text).text, text, text);
    }
  });
  it('원문 문자열 자체는 바꾸지 않는다', () => {
    const text = '재석의원 칠인';
    checks.voteNumbers(text);
    assert.equal(text, '재석의원 칠인');
  });
});

describe('표결 합계 확인', () => {
  it('찬성·반대·기권 합이 재석과 다르면 숫자 확인을 붙인다', () => {
    const result = checks.review('재석 7인 중 찬성 4인 반대 1인 기권 1인');
    assert.deepEqual(result.checks.map(c => c.kind), ['number_check']);
  });
  it('합이 맞으면 표시하지 않는다', () => {
    assert.deepEqual(checks.review('재석의원 육인 중 찬성 오인 반대 일인').checks, []);
  });
  it('일부만 들렸고 합이 재석을 넘지 않으면 표시하지 않는다', () => {
    assert.deepEqual(checks.review('재석 7인 중 찬성 5인').checks, []);
  });
  it('일부만 들렸어도 합이 재석을 넘으면 표시한다', () => {
    assert.equal(checks.review('재석 5인 중 찬성 6인').checks[0].kind, 'number_check');
  });
});

describe('낱말 확인', () => {
  it('안건 설명 문맥의 제한은 제안 오인식 가능성으로 표시한다', () => {
    assert.equal(checks.wordChecks('이 조례안을 제한합니다').length, 1);
    assert.equal(checks.wordChecks('제한 설명을 드리겠습니다').length, 0);
  });
  it('문맥 단서가 없으면 표시하지 않는다', () => {
    assert.deepEqual(checks.wordChecks('출입을 제한합니다'), []);
    assert.deepEqual(checks.wordChecks('다음과 같이 제안합니다'), []);
  });
  it('금지·구역 문맥의 제안은 제한 오인식 가능성으로 표시한다', () => {
    assert.equal(checks.wordChecks('이 구역 출입을 제안합니다').length, 1);
  });
});
