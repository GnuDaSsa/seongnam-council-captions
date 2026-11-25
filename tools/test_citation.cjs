const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const citation = require('../dist/citation.js');

describe('인용 출처', () => {
  it('장면 링크는 기존 쿼리를 지우고 회의와 기록 번호만 남긴다', () => {
    assert.equal(citation.liveLink('https://example.test/?live=2852&speaker=recent#x', '2853', '17955'),
      'https://example.test/?live=2853&cue=17955');
  });
  it('복사한 글 뒤에 발언자·회의·시각·검수 상태·링크를 붙인다', () => {
    const text = citation.copied(' 확인 후 자료로 제출하도록 하겠습니다. ', {
      speaker: '', meeting: '경제환경위원회 행정사무감사 제1일차', time: '14:37:09', url: 'https://example.test/?live=2853&cue=1'});
    assert.equal(text, '“확인 후 자료로 제출하도록 하겠습니다.”\n출처: 발언자 미확인 · 경제환경위원회 행정사무감사 제1일차 14:37:09 (음성인식 자막 · 검수 전)\nhttps://example.test/?live=2853&cue=1');
  });
  it('선택이 비면 출처를 만들지 않는다', () => {
    assert.equal(citation.copied('   ', {}), null);
  });
  it('내려받은 문서 머리에 출처 주소와 한국시간 내려받은 때를 적는다', () => {
    const lines = citation.downloadHeader('https://example.test/?live=2853', new Date('2026-11-25T06:00:00Z'));
    assert.equal(lines[0], '출처 주소  https://example.test/?live=2853');
    assert.equal(lines[1], '내려받은 때  2026-11-25 15:00:00 (한국시간)');
  });
  it('시각이 잘못되면 내려받은 때를 생략한다', () => {
    assert.deepEqual(citation.downloadHeader('', 'not-a-date'), []);
  });
});
