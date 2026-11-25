const assert = require('node:assert/strict');
const test = require('node:test');
const { assess, match } = require('../dist/vod-speaker.js');
const { meetings } = require('../dist/data/vod-catalog.json');

const vod = meetings.find(meeting => meeting.id === '5483');
const samples = vod.cues.flatMap(reference => (reference.rawSegments || []).map(raw => ({
  reference, local: { ...raw, source: 'local', meetingId: vod.id },
})));
const source = id => samples.find(sample => sample.local.id === '5483-asr-' + id);
const expected = new Map([
  ['5483-asr-0', '안광환'],
  ['5483-asr-1', '안광환'],
  ['5483-asr-4', '안광환'],
  ['5483-asr-5', '안광환'],
  ['5483-asr-7', '최민수'],
  ['5483-asr-8', '최민수'],
  ['5483-asr-9', '최민수'],
]);

test('VOD 5483 personal ASR excerpts use checked catalog labels with speaker provenance', () => {
  assert.equal(samples.length, 12);
  assert.equal(vod.members.length, 0);
  assert.equal(source(6).reference.speaker, '최민수 주무관');
  assert.match(source(6).local.text, /채민수 주무관입니다/);
  for (const { reference, local } of samples) {
    const speaker = match(vod, local);
    const name = expected.get(local.id);
    assert.equal(speaker?.name, name, local.id);
    if (!name) continue;
    assert.equal([speaker.name, speaker.role].join(' '), reference.speaker, local.id);
    assert.equal(speaker.confidence, 'low', local.id);
    assert.match(speaker.method, /회의록.*추정/, local.id);
    assert.deepEqual(speaker.evidence, [local.id]);
    assert.deepEqual(speaker.officialReference, {
      vodId: vod.id, minutesUrl: vod.minutesUrl, cueIds: [reference.id],
    });
  }
});

test('VOD attribution requires timing, matching text, and an official passage from the same video', () => {
  const { reference, local } = source(4);
  assert.equal(match(vod, { ...local, start: 60, end: 67 }), undefined, 'right words, wrong time');
  assert.equal(match(vod, { ...local, text: '사업지원금 비율에 관한 작년도 예산개요를 설명하겠습니다.' }), undefined,
    'right time, wrong words');
  assert.equal(match(vod, { ...local, meetingId: '5481' }), undefined);
  assert.equal(match(vod, { ...local, start: 20, end: 20 }), undefined);
  assert.equal(match({ ...vod, officialPage: vod.officialPage.replace('5483', '5481') }, local), undefined);
  assert.equal(match({ ...vod, minutesUrl: 'https://example.com/minutes' }, local), undefined);
  assert.equal(match({ ...vod, cues: [{ ...reference, source: 'asr' }] }, local), undefined);
  assert.equal(match({ ...vod, cues: [{ ...reference, speaker: '발언자 미확인' }] }, local), undefined);
  assert.equal(match({ ...vod, cues: [{ ...reference, id: '5481-minutes-4' }] }, local), undefined);
});

test('VOD attribution withholds names on ambiguous boundaries, shared chapters, and weak recognition', () => {
  const { reference, local } = source(5);
  const next = source(6).reference;
  assert.equal(match(vod, { ...local, start: 29.22, end: 45, text: reference.text + next.text }), undefined);
  assert.equal(match({ ...vod, cues: [reference, { ...reference, id: '5483-ambiguous', speaker: '최민수 주무관' }] },
    local), undefined);
  assert.equal(match({ ...vod, cues: [{ ...reference, timingPrecision: 'chapter' }] }, local), undefined);
  assert.equal(match(vod, { ...local, text: '네 알겠습니다.' }), undefined);
  assert.equal(match(vod, { ...local, rejected: true }), undefined);
  assert.equal(match(vod, { ...local, flags: ['low_confidence'] }), undefined);
  assert.equal(match(vod, { ...local, text: reference.text + ' 저는 김가나입니다.' }), undefined);
  assert.equal(match(vod, { ...local, rawText: reference.text + ' 김가나 위원장입니다.' }), undefined);
  const longer = source(4).local;
  assert.deepEqual(assess(vod, { ...longer, text: longer.text + ' 환경정책과장 김가나입니다.' }),
    { blocked: true });
  assert.deepEqual(assess(vod, { ...longer, text: longer.text + '? 네, 맞습니다.' }), { blocked: true });
  assert.equal(assess(vod, { ...longer, start: 125, end: 130 }), undefined,
    'no checked reference leaves ordinary inference available');
});

test('adjacent checked passages from the same speaker can support a longer local caption', () => {
  const first = source(0).reference;
  const second = source(1).reference;
  const local = { ...source(0).local, end: second.end, text: first.text + ' ' + second.text };
  const speaker = match(vod, local);
  assert.equal(speaker?.name, '안광환');
  assert.deepEqual(speaker.officialReference.cueIds, [first.id, second.id]);
});
