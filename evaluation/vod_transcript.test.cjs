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
test('an archived live caption uses its own source, including unnamed competitors, and is independent of the VOD clock',()=>{
  const {prepareCaptured,assessCaptured}=require('../dist/vod-transcript.js');
  const liveMatcher=require('../dist/live-speaker.js');
  const vod={...meeting,liveMeetingId:'2853',members:['조우현'],staffRoster:[]};
  const real=(id,start,text)=>({id,start,end:start+6,text,rawText:text,flags:[]});
  const text='조우현 의원입니다. 오늘은 예산 편성에 관해 질의하겠습니다.';
  const row=real('live1',4000,text), other=real('live2',4008,'지금 말씀하신 사항을 확인해서 별도로 제출하겠습니다.');
  const archive={meetingId:'2853',cues:[row,other]};
  const ref=prepareCaptured(vod,archive,liveMatcher), heard=local('오늘은 예산 편성에 관해 질의하겠습니다',19);
  const match=assessCaptured(vod,{...heard,text,rawText:text},ref)?.speaker;
  assert.equal(match?.name,'조우현'); assert.equal(match.officialReference,undefined);
  assert.equal(match.liveReference.cueId,'live1'); assert.equal(match.liveReference.meetingId,'2853');
  assert.equal(prepareCaptured(vod,{...archive,meetingId:'2852'},liveMatcher),undefined);
  assert.equal(assessCaptured({...vod,liveMeetingId:'2852'},heard,ref),undefined);
  const repeated='오늘은 예산 편성에 관해 질의하겠습니다. 여러 위원님들도 자료를 보셨습니다.';
  const repeatedArchive={...archive,cues:[real('intro',0,'조우현 의원입니다. '+repeated),real('repeat',800,repeated)]};
  assert.equal(assessCaptured(vod,{...heard,text:repeated,rawText:repeated},prepareCaptured(vod,repeatedArchive,liveMatcher)),undefined);
  const forged=real('forged',1000,repeated); forged.speaker={name:'조우현',role:'의원'};
  assert.equal(prepareCaptured(vod,{...archive,cues:[forged]},liveMatcher),undefined);
});

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
  assert.deepEqual(assess(meeting, local(repeated, 130), reference([first, second])), { blocked: true, reason:'ambiguous-speaker' });
  assert.equal(match(meeting, local(repeated, 130), reference([first, { ...second, start: 250, end: 320 }]))?.name,
    chair.name);
  const nearRepeat = { ...second, text: '자료를 검토하고 위원님들께 따로 말씀드리도록 하겠습니다.' };
  assert.deepEqual(assess(meeting, local(repeated, 130), reference([first, nearRepeat])), { blocked: true, reason:'ambiguous-speaker' });
  assert.equal(match(meeting, local('이 사업에 관한 자료를 검토한 뒤 평가할 예정입니다.', 130), reference([first])), undefined);
  assert.equal(match(meeting, local(repeated, 450), reference([first, second])), undefined);
});

test('mixed speaker text and a contrary explicit introduction block a name', () => {
  const main = '상임위 담당 직원으로부터 보고를 들은 후 의사 일정에 따라 회의를 진행하도록 하겠습니다.';
  const full = reference([chair, officer, other]);
  assert.deepEqual(assess(meeting, local(main + ' 환경정책과장 김가나입니다.'), full), { blocked: true });
  for (const role of ['공보관','위원장대리','분당구청장직무대리']) {
    assert.deepEqual(assess(meeting, local(main + ' ' + role + ' 김가나입니다.'), full), { blocked: true });
  }
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

test('25 November replay recovers an actual noisy Chrome cue without inheriting the name into the reply',()=>{
  const api=require('../dist/vod-transcript.js'), live=require('../dist/live-speaker.js');
  const vod=require('../dist/data/vod-index.json').meetings.find(row=>row.id==='5554');
  const utterances=[
    '네, 선창선 의원님 말씀해 주십시오.',
    '안녕하십니까, 선창선 의원입니다.',
    '공보관님, 저희가 공보관을 개방형 지위로 지금 전환한 지가 2022년인데',
    '지금 공보관님은 어떤 개방형 공보관이십니까? 아니면 일반 임기주의 개방형이십니까?',
    '저는 일반 행정직 공보관입니다.'
  ];
  const times=[6523.921,6525.921,6527.931,6534.931,6539.931,6541.791];
  const ids=['1795587268636517422','1795587268636517423','1795587268636517424','1795587268636517425','1795587268636517426'];
  const captured=utterances.map((text,i)=>({id:ids[i],text,rawText:text,start:times[i],end:times[i+1],flags:[]}));
  const ref=rows=>api.prepareCaptured(vod,{meetingId:'2852',cues:rows},live);
  const query=(text,reference)=>api.assessCaptured(vod,{id:'chrome-6096',meetingId:vod.id,source:'local',start:6096,end:6104,flags:[],text,rawText:text},reference);
  const heard='공부가님 저희가 공부가는 개방용주의로 전환한 지가 2022년인데';
  const result=query(heard,ref(captured))?.speaker;
  assert.equal(result?.name,'선창선');
  assert.equal(result.confidence,'low');
  assert.equal(result.liveReference.cueId,ids[2]);
  assert.deepEqual(result.liveReference.evidence,ids.slice(1,4));
  assert.equal(query(heard,ref(captured.slice(0,3))),undefined);
  const duplicate={...captured[2],id:'another-unknown-voice',start:8888,end:8895};
  assert.equal(query(heard,ref([...captured,duplicate])),undefined,'unidentified competitor has equal weight');
  assert.equal(query('전환한 지가 2022년인데 공부가님 저희가 공부가는 개방용주의로',ref(captured)),undefined);
  assert.equal(query('공부가님 저희가 전혀 다른 이유를 들어서 2022년도에 했는데',ref(captured)),undefined);
  assert.equal(query(heard+'? 네, 맞습니다.',ref(captured)),undefined);
});

test('a later official passage identifies the preceding 5479 sentence while the intervening separate reply remains unassigned',()=>{
  const api=require('../dist/vod-transcript.js');
  const vod=require('../dist/data/vod-index.json').meetings.find(m=>m.id==='5479');
  const ref=require('../dist/data/vod-transcripts/5479.json');
  const row=(id,start,text)=>({id,meetingId:'5479',source:'local',flags:[],start,end:start+8,text,rawText:text});
  const first=row('first',1213,'지리하실 위원이 많기시고요 과장님 그러면 제가 몇 가지만 좀 지리지 못 드리겠습니다. 보니까 7월 21일');
  const second=row('second',1221,'사고발생이되었습니다. 그 24일이다보니까얘가원보고라고되어있는데요. 그러면성당시에서도 24일날');
  assert.equal(api.assess(vod,first,ref)?.speaker,undefined);
  second.speaker=api.assess(vod,second,ref,[first,second])?.speaker;
  const delayed=api.previousSpeaker(vod,first,second,ref);
  assert.equal(delayed?.name,'윤혜선');
  assert.deepEqual(delayed.evidence,['first','second']);
  assert.equal(api.previousSpeaker(vod,first,{...second,speaker:undefined},ref),undefined);
  assert.equal(api.previousSpeaker(vod,first,{...second,start:second.start+2},ref),undefined);
  assert.equal(api.previousSpeaker(vod,{...first,speakerConflict:true},second,ref),undefined);
  const mixed=row('third',1229,'이 사실을 알았나요. 그렇습니다. 그렇더라면 지금 3일 뒤에 사망한 이후에 사고가 발생되었다라고');
  const next=row('fourth',1237,'실제적으로는 어떻게 보면 경찰이 신고가 된 이후에 성남시에 보고가 됐습니다. 보통 이런 사건 사고들이 생겼을 때는');
  next.speaker=api.assess(vod,next,ref)?.speaker;
  assert.equal(next.speaker?.name,'윤혜선');
  assert.equal(api.assess(vod,mixed,ref)?.blocked,true);
  assert.equal(api.previousSpeaker(vod,mixed,next,ref),undefined);
});
test('a local replay honors the authoritative archive veto and requires a complete oath signature',()=>{
  const api=require('../dist/vod-transcript.js'), matcher=require('../dist/live-speaker.js');
  const vod={...meeting,liveMeetingId:'2853',members:['조우현']};
  const text='조우현 의원입니다. 오늘은 새 문화예술 예산안에 관해 질의하겠습니다.';
  const row={id:'v',start:1,end:7,flags:[],text,rawText:text};
  const build=cues=>api.prepareCaptured(vod,{meetingId:'2853',speakerAttributionApplied:true,cues},matcher);
  assert.ok(api.prepareCaptured(vod,{meetingId:'2853',cues:[row]},matcher));
  assert.equal(build([row]),undefined,'canonical abstention, even with a self-introduction recognizable to the browser');
  const words='2026년 11월 25일 성남시 푸른 도시 사업소장 이종빈';
  const oath={...row,text:words,rawText:words,speaker:{name:'이종빈',role:'푸른도시사업소장',
    confidence:'low',basis:'oath-signature',method:'감사 선서 직후 날짜·직책·서명 낭독과 공식 명부 대조',evidence:['called','v']}};
  const call={...row,id:'called',text:'앞으로 나오셔서 선서하여 주시기 바랍니다.',rawText:'앞으로 나오셔서 선서하여 주시기 바랍니다.'};
  assert.equal(build([oath]),undefined,'evidence must exist in the same archive');
  const reference=build([call,oath]);
  function assess(words,rawText=words) { return api.assessCaptured(vod,{...local(words,50),rawText},reference)?.speaker; }
  assert.equal(assess(words)?.name,'이종빈');
  assert.equal(assess(words.replace('이종빈','이정빈')),undefined);
  assert.equal(assess(words,words.replace('이종빈','이정빈')),undefined);
  assert.equal(assess(words.replace('푸른 도시 사업소장','환경정책과장')),undefined);
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

test('5476 does not absorb an independently confirmed short official response into either adjacent question fragment',()=>{
  const video=require('../dist/data/vod-index.json').meetings.find(row=>row.id==='5476');
  const official=require('../dist/data/vod-transcripts/5476.json');
  const before=local('받으라고 요청하는 것이 부당합니까? 시장님께 실정 나오셔서 실정 질문을 받으시니까',1411,
    {id:'previous',meetingId:'5476',end:1419});
  // Captured browser draft; independent original audio places the response at 1424.26–1424.82.
  const draftText='사립니다라고말하는것이의외에서부당한요청을하는겁니까? 그거는아니죠. 저희가';
  const draft=local(draftText,1419,
    {id:'draft',meetingId:'5476',end:1427,rawText:draftText});
  const refined={...draft,text:'가야 됩니다라고 말하는 것이 의외에서 부당한 요청을 하는 겁니까?',
    rawText:'가야 됩니다라고 말하는 것이 의외에서 부당한 요청을 하는 겁니까?'};
  assert.equal(assess(video,before,official)?.speaker?.name,'윤혜선');
  assert.deepEqual(assess(video,draft,official,[before,draft]),{blocked:true});
  assert.equal(assess(video,refined,official,[before,refined])?.speaker?.name,'윤혜선');
  const noReply={...official,turns:official.turns.filter(turn=>turn.id!=='5476-turn-0099')};
  assert.equal(assess(video,draft,noReply,[before,draft])?.speaker?.name,'윤혜선');
  const changed=draft.text.replace('저희가','제가');
  assert.notEqual(assess(video,{...draft,text:changed,rawText:changed},official,[before])?.blocked,true);
});
