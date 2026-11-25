const assert = require('node:assert/strict');
const test = require('node:test');
const { assess, match, validatesSource } = require('../dist/vod-transcript.js');
const { meetings } = require('../dist/data/vod-catalog.json');
const meeting = meetings.find(row => row.id === '5483');
const chair = {
  id: 'opening', name: '안광환', role: '위원장',
  text: '회의 진행에 앞서 상임위 담당 직원으로부터 보고를 들은 후 의사일정에 따라 회의를 진행하도록 하겠습니다.',
};
const officer = {
  id: 'report', name: '최민수', role: '주무관',
  text: '2027년도 경기도 중소기업육성기금 출연안 등 총 여덟 건의 조례안 및 일반의안 심사와 제4회 추가경정예산안 예비 심사, 2025회계연도 결산 승인안 예비 심사를 위하여 본 위원회가 소집되었습니다.',
};
const other = {
  id: 'discussion', name: '김가나', role: '환경정책과장',
  text: '우리 시 폐기물 처리시설의 사업비 편성 자료를 위원님들께 별도로 제출하도록 하겠습니다. 세부 항목은 연말에 다시 정리하겠습니다.',
};
const reference = (turns, sourceUrl = meeting.officialPage) => ({ meetingId: meeting.id, sourceUrl, turns });
const local = (text, start = 3701, metadata = {}) => ({
  id: 'local-cue', meetingId: meeting.id, source: 'local', text, start, end: start + 5, ...metadata,
});

test('matches five-second partial Korean VOD excerpts after arbitrary seeks without a clock-aligned label', () => {
  const full = reference([chair, officer, other]);
  const openingExcerpt = local('상임위 담당 직원으로부터 보고를 들은 후 의사 일정에 따라', 7);
  assert.equal(match(meeting, openingExcerpt, full)?.name, chair.name);
  const heard = local('제 4회 추가 경정 예산안 예비 심사 2025회계 연도 결산 승인안');
  const result = match(meeting, heard, full);
  assert.equal(result?.name, officer.name);
  assert.equal(result.role, officer.role);
  assert.equal(result.confidence, 'low');
  assert.match(result.method, /공식 회의록.*추정/);
  assert.deepEqual(result.evidence, ['local-cue']);
  assert.deepEqual(result.officialReference, { vodId: meeting.id, sourceUrl: meeting.officialPage, cueIds: ['report'] });
  assert.equal(match(meeting, local('결산 승인안 예비 심사를 위하여 본 위원회가 소집되었습니다', 2201), full)?.name, officer.name);
  assert.equal(match(meeting, local('제4회 추가 경정 예산안 예비 심사 2025회계연도 결산 승인이'), full)?.name, officer.name);
});

test('identical or nearly repeated speaker wording is ambiguous within the same compatible chapters', () => {
  const repeated = '자료를 확인하고 위원님들께 따로 말씀드리도록 하겠습니다.';
  const first = { ...chair, text: repeated, start: 100, end: 220 };
  const second = { ...officer, text: repeated, start: 100, end: 220 };
  assert.deepEqual(assess(meeting, local(repeated, 130), reference([first, second])), { blocked: true });
  assert.equal(match(meeting, local(repeated, 130), reference([first, { ...second, start: 250, end: 320 }]))?.name,
    chair.name);
  const nearRepeat = { ...second, text: '자료를 검토하고 위원님들께 따로 말씀드리도록 하겠습니다.' };
  assert.deepEqual(assess(meeting, local(repeated, 130), reference([first, nearRepeat])), { blocked: true });
  assert.equal(match(meeting, local('이 사업에 관한 자료를 검토한 뒤 평가할 예정입니다.', 130), reference([first])), undefined);
  assert.equal(match(meeting, local(repeated, 450), reference([first, second])), undefined);
});

test('mixed speaker text and a contrary explicit introduction block a name', () => {
  const main = '상임위 담당 직원으로부터 보고를 들은 후 의사 일정에 따라 회의를 진행하도록 하겠습니다.';
  const full = reference([chair, officer, other]);
  assert.deepEqual(assess(meeting, local(main + ' 환경정책과장 김가나입니다.'), full), { blocked: true });
  assert.deepEqual(assess(meeting, local(main, 7, { rawText: main + ' 저는 김가나입니다.' }), full), { blocked: true });
  assert.deepEqual(assess(meeting, local(main + '? 네, 맞습니다.'), full), { blocked: true });
  const mixed = local('상임위 담당 직원으로부터 보고를 들은 후 시 폐기물 처리시설의 사업비 편성 자료를');
  assert.deepEqual(assess(meeting, mixed, full), { blocked: true });
});

test('ignores generic and uncertain cues and rejects an unlinked or off-meeting official source', () => {
  const healthy = local('상임위 담당 직원으로부터 보고를 들은 후 의사 일정에 따라');
  const full = reference([chair]);
  assert.equal(match(meeting, local('네 알겠습니다.'), full), undefined);
  assert.equal(match(meeting, { ...healthy, rejected: true }, full), undefined);
  assert.equal(match(meeting, { ...healthy, flags: ['low_confidence'] }, full), undefined);
  assert.equal(match(meeting, { ...healthy, meetingId: '5481' }, full), undefined);
  assert.equal(match(meeting, healthy, { ...full, meetingId: '5481' }), undefined);
  assert.equal(match(meeting, healthy, reference([chair], meeting.officialPage.replace('5483', '5481'))), undefined);
  assert.equal(match(meeting, healthy, reference([chair], 'https://www.sncouncil.go.kr/record/recordView.do?key=123')), undefined);
  assert.equal(match(meeting, healthy, reference([chair], meeting.minutesUrl))?.name, chair.name);
  assert.equal(match(meeting, healthy, reference([{ ...chair, name: '' }])), undefined);
  assert.equal(validatesSource(meeting, reference([chair], meeting.minutesUrl)), true);
  assert.equal(validatesSource(meeting, { ...full, turns: null }), false);
  const sectionUrl = 'https://www.sncouncil.go.kr/record/recordView.do?key=123';
  const combined = reference([{ ...chair, sourceUrl: sectionUrl }]);
  assert.equal(match(meeting, healthy, combined)?.officialReference.sourceUrl, meeting.officialPage);
  assert.equal(match({ ...meeting, minutesUrls: [sectionUrl] }, healthy, combined)?.officialReference.sourceUrl, sectionUrl);
});

test('two noisy Chrome cues support a speaker only in an ordered, nearby passage of one official turn', () => {
  const official = require('../dist/data/vod-transcripts/5483.json');
  const passage = official.turns.find(turn => turn.id === '5483-turn-0007');
  assert.equal(passage.name, '안광환');
  assert.match(passage.text, /경기신용보증재단 출연안을 일괄 상정하겠습니다.*기업혁신과장님 나오셔서.*중소기업육성기금 출연안에 대해 제안 설명/);

  // Frozen real recognition texts. Starts are retained as shown in Chrome.
  // Simulated end for the earlier chunk supplies a contiguous input boundary.
  const before = local('경기 신형 보장재단 출연화를 1부할 상전화하겠습니다.', 214, { id: 'chrome-214', end: 222 });
  const after = local('-이건 기업 10과장에 나오셔서 2017년도 경기도 중석의업 6성 기급 출연한에 대한 설명이 있습니다.',
    222, { id: 'chrome-222', end: 231 });
  assert.equal(match(meeting, before, official), undefined);
  assert.equal(match(meeting, after, official, [after]), undefined, 'after seek: previous context is gone');
  const result = match(meeting, after, official, [before, after]);
  assert.equal(result?.name, '안광환');
  assert.equal(result?.role, '위원장');
  assert.deepEqual(result.evidence, ['chrome-214', 'chrome-222']);
  assert.deepEqual(result.officialReference.cueIds, ['5483-turn-0007']);
  assert.equal(match(meeting, after, official, [{ ...before, start: 200, end: 209 }, after]), undefined, 'gap over 12 seconds');
  assert.equal(match(meeting, { ...after, text: '네, 아주 잘 알겠습니다.' }, official, [before, after]), undefined);
  assert.equal(match(meeting, after, official, [{ ...before, text: '2027년도 6억 원 7억 9100만 원 2026년도' }, after]), undefined);

  const noChair = { ...official, turns: official.turns.filter(turn => turn.name !== '안광환') };
  assert.equal(match(meeting, after, noChair, [before, after]), undefined, 'addressee and similar agenda wording do not establish a match');
  const parts = passage.text.split('유미령 기업혁신과장님');
  const split = reference([{ ...passage, text: parts[0] }, { ...passage, id: 'separate-turn', text: '유미령 기업혁신과장님' + parts[1] }]);
  assert.equal(match(meeting, after, split, [before, after]), undefined, 'the evidence belongs to different official turns');
});

test('published transcripts have an official source and unique named turns', () => {
  const index = require('../dist/data/vod-index.json').meetings;
  const catalog = new Map([...index, ...meetings].map(row => [row.id, row]));
  const files = require('node:fs').readdirSync(require('node:path').join(__dirname, '../dist/data/vod-transcripts'));
  const supported = [...catalog.values()].filter(row => row.speakerTranscript);
  assert.deepEqual(files.sort(), supported.map(row => row.id + '.json').sort());
  for (const row of supported) {
    const official = require('../dist/data/vod-transcripts/' + row.id + '.json');
    assert.ok(validatesSource(row, official), row.id);
    assert.ok(official.turns.length > 0);
    assert.equal(new Set(official.turns.map(turn => turn.id)).size, official.turns.length);
    assert.ok(official.turns.every(turn => turn.id && turn.name && turn.text));
  }
});

test('real browser ASR after a fresh seek matches the linked speaker or abstains', () => {
  const index = require('../dist/data/vod-index.json').meetings;
  // Original Whisper Base output from 8-second slices of the official public audio.
  const excerpts = [
    ['5481', 495, '아 모범 공원은 나름 그 모범 공원이기 때문에 선정됐지만 장기 근소 30년', '최은미'],
    ['5481', 503, '이상이나 티직을 예정했다고 해서 일루적으로 보냈면 안 된다.', '최은미'],
    ['5467', 845, '끝날 수는 설거지는 성남시인의 목숨니까?', undefined],
    ['5467', 853, '도비가 줄어드는 사운마다 12편 성류구가 파도처럼 몰려올 것입니다. 우리도 우리가 갇진 채', '추선미'],
    ['5483', 1200, '그리고 주민들이 악지와 환경 문제로 인해 피해를 많이 받고 있는 상황입니다.', '백진규'],
    ['5483', 1208, '도심 이관을 신각히', undefined],
  ];
  for (const [id, start, text, expected] of excerpts) {
    const row = [...meetings, ...index].find(entry => entry.id === id);
    const official = require('../dist/data/vod-transcripts/' + id + '.json');
    const cue = local(text, start, { meetingId: id, end: start + 8 });
    assert.equal(match(row, cue, official)?.name, expected, id + ' at ' + start);
  }
});
