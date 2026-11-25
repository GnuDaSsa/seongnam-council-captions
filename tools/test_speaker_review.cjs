const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const guesses = require('../dist/speaker-review.js').guesses;
const meeting = { id: '2853', members: ['안광환', '장일남', '김옥수', '서은경', '정봉규', '정연화', '조우현'] };
const cue = (id, text, start = Number(id) * 10) => ({ id, text, start, end: start + 8 });
const liveCue = (id, text, start, end, flags) => ({ id, text, start, end, flags });

function run() {
  let result = guesses(meeting, [
    cue('1', '장일남 의원님 질의해 주시기 바랍니다.'),
    cue('2', '감사합니다.'),
    cue('3', '안광환 의원님 발언하시기 바랍니다.'),
    cue('4', '네, 알겠습니다.'),
    cue('5', '장일남 의원님 말씀해 주세요.'),
    cue('6', '먼저 환경 정책에 대해 말씀드리고, 이어서 예산 자료도 말씀드리겠습니다.'),
  ]);
  assert.deepEqual(Object.keys(result), ['6']);
  assert.equal(result['6'].name, '장일남');
  assert.equal(result['6'].role, '의원');
  assert.equal(result['6'].confidence, 'low');
  assert.deepEqual(Array.from(result['6'].evidence), ['5', '6']);
  assert.equal(result['5'], undefined, 'called speaker must not be assigned to the caller cue');

  result = guesses(meeting, [cue('10', '김옥수 의원입니다. 안녕하십니까. 저는 김옥수입니다.')]);
  assert.equal(result['10'].name, '김옥수');
  assert.equal(result['10'].confidence, 'medium');
  result = guesses(meeting, [cue('11', '저는 환경보건국장 홍길동입니다.')]);
  assert.equal(result['11'].name, '');
  assert.equal(result['11'].role, '환경보건국장');
  assert.equal(result['11'].confidence, 'low');
  // Selected 2026-10-07 follow-up case: the transcript contains the official name,
  // but ASR corrupts the department title. This is a regression fixture, not an
  // independent accuracy measurement; the name is checked against the public record.
  result = guesses(meeting, [cue('historical-intro', '안녕하십니까. 자원수란과장 장미라입니다.', 74.5)]);
  assert.equal(result['historical-intro'].name, '');
  assert.equal(result['historical-intro'].role, '자원수란과장');
  assert.equal(result['historical-intro'].confidence, 'low');
  result = guesses(meeting, [cue('12', '장일남 위원장님 발언해 주시기 바랍니다.'), cue('13', '안건에 관해 말씀드리겠습니다.')]);
  assert.equal(result['13'].role, '위원장');

  const procedural = [
    liveCue('open-full', '성원이 되었으므로 제313회 성남시의회 제1차 정례회 제1차 행정교육위원회를 개회하겠습니다. 존경하는 동료위원 여러분, 안녕하십니까?', 0, 10),
    liveCue('open-short', '제1차 경제환경위원회를 개회하겠습니다.', 10, 15),
    liveCue('adjourn', '이상으로 오늘의 안건 심사를 마치고 산회를 선포합니다.', 20, 25),
    liveCue('passed', '위 원안이 가결되었음을 선포합니다.', 30, 35),
  ];
  result = guesses(meeting, procedural);
  for (const id of ['open-full', 'open-short', 'adjourn', 'passed']) {
    assert.equal(result[id].role, '의사진행자');
    assert.equal(result[id].name, '', 'procedural form must never borrow a roster name');
    assert.deepEqual(Array.from(result[id].evidence), [id]);
  }
  result = guesses({ id:'unknown-meeting', members:[] }, [cue('open-no-roster', '제1차 본회의를 개의하겠습니다.')]);
  assert.equal(result['open-no-roster'].role, '의사진행자');
  assert.equal(result['open-no-roster'].name, '');

  for (const cases of [
    [cue('20', '안광환 의원님 질문해 주시기 바랍니다.'), cue('21', '네.')],
    [cue('30', '안광환 의원님 발언해 주세요.'), cue('31', '장일남 의원님도 의견이 있습니다. 김옥수 의원님께서 보충해 주세요.')],
    [cue('40', '안광환 의원님 질의해 주시기 바랍니다.'), cue('41', '잠깐만요, 제가 먼저 한 말씀 보태겠습니다.')],
    [cue('50', '안광환 의원님, 장일남 의원님 질의해 주시기 바랍니다.'), cue('51', '도시주택국과 건축과 등 여러 부서의 업무를 확인하겠습니다.')],
    [cue('60', '도시주택국, 건축과, 주택과 및 공동주택과 보고 바랍니다.'), cue('61', '관련 내용을 확인하겠습니다.')],
    [cue('64', '장일남 의원님 질의해 주시기 바랍니다.'), { ...cue('65', '예산 편성 내역을 확인하겠습니다.'), flags: ['severe_uncertainty'] }],
    [cue('66', '장일남 의원님 질의해 주시기 바랍니다.'), { ...cue('67', '예산 편성 내역을 확인하겠습니다.'), flags: ['repetition'] }],
    [cue('68', '장일남 의원님 질의해 주시기 바랍니다.'), { ...cue('69', '예산 편성 내역을 확인하겠습니다.'), flags: ['segment_review'] }],
    [cue('70', '장일남 의원님 질의에 대해 과장님 답변해 주시기 바랍니다.'), cue('71', '답변드리겠습니다. 관련 자료를 확인해서 말씀드리겠습니다.')],
    [cue('72', '정봉규 의원님 수고하셨습니다. 다음 질의하실 의원님 말씀해 주세요.'), cue('73', '예산 편성 내역을 확인하겠습니다.')],
    [cue('74', '장일남 부위원장님 질의해 주시기 바랍니다.'), cue('75', '예산 편성 내역을 확인하겠습니다.')],
    [cue('74a', '정봉규 의원님 지리하시러.'), cue('74b', '예산 편성 내역을 확인하겠습니다.')],
    [cue('76', '장일남 의원님 질의해 주시기 바랍니다.', 0), cue('77', '예산 편성 내역을 확인하겠습니다.', 68)],
    [cue('78', '장일남 의원님 질의해 주시기 바랍니다.', 0), { id: '79', text: '예산 편성 내역을 확인하겠습니다.' }],
    [cue('80', '장일남 의원님 질의해 주시기 바랍니다.'), cue('81', '장일남 의원입니다라고 소개하셨다.')],
    [cue('82', '위원장님, 저는 장일남 의원입니다라고 소개하셨습니다.')],
    [cue('83', '산회 선포가 가능한가요?')],
    [cue('84', '의장이 산회를 선포했다고 합니다.')],
    [cue('85', '네, 산회를 선포합니다.')],
    [cue('86', '정연화 의원님, 산회를 선포합니다.')],
    [cue('87', '성원이 되었으므로 회의를 개회하겠습니다. 네, 감사합니다.')],
  ]) {
    assert.deepEqual(Object.keys(guesses(meeting, cases)), [], 'ambiguous, brief, interrupted, or listed names must remain unassigned');
  }
  result = guesses(meeting, [
    liveCue('75a', '정봉규 의원님, 지리하시러.', 0, 10),
    liveCue('75b', '아까 앞서 장일남 의원님 말씀하셨던 예산 편성 내역 관련해서 질문드립니다.', 10, 18),
  ]);
  assert.equal(result['75b'], undefined, 'a distorted handoff and third-party citation cannot establish identity');
  result = guesses(meeting, [{ ...cue('62', '장일남 의원님 질의해 주시기 바랍니다.'), flags: ['name'] }, cue('63', '예산 편성 내역을 확인하겠습니다.')]);
  assert.equal(result['63'].name, '장일남', 'a name review flag can still surface a direct-call candidate for human verification');

  assert.deepEqual(Object.keys(guesses({ id: 'x', members: [] }, [cue('70', '저는 안광환 의원입니다.')])).length, 0);
  assert.deepEqual(Object.keys(guesses(meeting, [{ id: '80', text: '저는 안광환 의원입니다.' }])).length, 1);
  const noId = guesses(meeting, [{ text: '저는 안광환 의원입니다.' }]);
  assert.deepEqual(Object.keys(noId), []);

  // Public 2853 sample cues from the 2026-11-25 live archive. This evaluates the
  // cue evidence only; it is not a human speaker-identity/audio ground truth set.
  const live2853 = [
    liveCue('1795584783050047742', '조 의원님 수고하셨습니다. 또 질의하실 의원님. 정연화 의원님 질의해 주시고.', 617.131, 622.231, ['name']),
    liveCue('1795584783050047743', '네, 과장님.', 622.231, 624.231),
    liveCue('1795584783050047744', '우리 야생동물에 대한 피해 보상조래는 농업기술센터 거의 소관인가요?', 624.701, 630.301),
    liveCue('1795584783050047819', '정봉규 의원님, 지리하시러.', 1067.771, 1069.771, ['name']),
    liveCue('1795584783050047820', '아까 앞서 장일남 의원님 말씀하셨던 1인차 소음 단속 관련해서요.', 1069.771, 1074.771, ['number', 'name']),
    liveCue('1795584783050047937', '네. 수고하셨습니다. 또 지리하시라요. 서은경이 형님.', 1548.231, 1553.561),
    liveCue('1795584783050047938', '과장님 고생 많으십니다.', 1554.821, 1557.331),
  ];
  const actualSample = guesses(meeting, live2853);
  assert.equal(actualSample['1795584783050047743'], undefined);
  assert.equal(actualSample['1795584783050047820'], undefined);
  assert.equal(actualSample['1795584783050047938'], undefined, 'a corrupted name call must not be repaired into an identity');
  assert.equal(live2853.length, 7);
  const snapshot = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'SeongnamCouncilDesk', 'evaluation-20261125', 'economic-live-1513.json');
  if (snapshot && fs.existsSync(snapshot)) {
    const archive = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
    assert.equal(String(archive.meetingId), '2853');
    const wholeCapture = guesses(meeting, archive.cues);
    assert.equal(wholeCapture['1795584783050047743'], undefined);
    assert.equal(wholeCapture['1795584783050047820'], undefined);
    assert.equal(wholeCapture['1795584783050047938'], undefined);
    const proposals = Object.values(wholeCapture);
    const named = proposals.filter(candidate => candidate.name).length;
    const roleOnly = proposals.filter(candidate => !candidate.name).length;
    console.log(`PASS public 2853 ambiguous handoffs withheld. Current ${archive.cues.length}-cue capture: ${named} named, ${roleOnly} role-only proposals (informational).`);
  }
  console.log('PASS speaker-review conservative roster/turn tests');
}

run();
