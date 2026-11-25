const {test} = require('node:test');
const assert = require('node:assert/strict');
const {attribute} = require('../dist/live-speaker.js');

// Observed generic ASR excerpts from the 5467 development capture (selected rows 20–77).
// Official transcript turns 0005–0006 corroborate the close and chair's handover.
// A shared synthetic clock preserves the decoded offsets without implying an archive wall time.
const meeting = {title:'제312회 성남시의회 임시회 제2차 본회의',members:['강상태','박기범','추선미','장일남']};
const clock = Date.parse('2026-09-07T01:00:00Z');
const observedAt = seconds => new Date(clock+Math.round(seconds*1000)).toISOString();
function cue(id,start,end,text,flags=[]) {
  return {id,start,end,text,rawText:text,flags,observedAt:observedAt(start)};
}
const call = cue('call',171.12,175.28,'그러면 박기범 의원님 나오셔서 발언해 주시기 바랍니다.',['name']);
const intro = cue('intro',200.05,211.61,'존경하는 92만 성남시민 여러분, 강상태 의장님과 선배 동료 의원 여러분, 그리고 공기자와 언론인 여러분, 유래복정 양지산성동지역구시위원 박기범입니다.',['number','name']);
const bridge = [
  ['23',216,227.64,'사실 잘해서 재선되었다고 생각하는 시민을 거의 본 적이 없기에 남은 4년 우려와 걱정 속에 시장에게 시민이 바라는 행정을 촉구하고자 이 자리에 섰습니다.',['number','name','low_confidence']],
  ['26',241.23,246.23,'민간위탁의 불꽃쇼는 터지지 않았고 볼거리 없는 쇼로 끝났습니다.'],
  ['29',256,261,'어떤 정부도 복원복지부가 민간위탁을 승인한 사례와 설레 자체가 없습니다.'],
  ['30',262,280.04,'시장은 애초에 가능하지도 않았고 불가능한 민간위탁 추진으로 시민들을 분열시킨 정과, 지난 몇 년간 원정과 의사, 간호사, 인력 충원을 미루며 의료원을 정상화하기는커녕, 역행한 점을 시민들에게 사과하고 민간위탁 포기를 선언하십시오.'],
  ['33',293,297,'우리 성남시 공공의료의 자부심이자 보류입니다.',['low_confidence']],
  ['36',308.82,315.87,'보안대척을 마련하십시오. 신상지시장은 지난 지방선거 당시 도촌 야탑력신설',['name']],
  ['40',328.32,334.74,'수치였습니다. 용역착수가 2025년 6월 14일이었던 만큼 현직시장으로서',['number','name','low_confidence']],
  ['44',347.6,354.22,'간전한 영원을 이용한 도적적 해위입니다. 도촌 야탑력신설은 시장이 시민에게',['name']],
  ['48',362,382,'셋째, 신상지 시장은 투명하고 전문성을 갖춘 검증된 인사를 하십시오. 시장이 최근에 인사시장에서',['segment_review','name']],
  ['50',392.04,402,'인수위원장 출신을 도시개개발공사사장과 시정연구원장으로 임명은 누가 판단해도 본인사고 엽관인사입니다.',['number','name']],
  ['54',402,422,'인사청문의 검증을 통과할 수 있습니다.',['segment_review','low_confidence']],
  ['57',436.51,442,'이 사거리 코너에 스토리박스 부지에 기업이 들어온다면 시민의 불편함을'],
  ['61',455.29,460.21,'스토리박스 부지를 땅파라 먹지 말고 주민들이 원하는 대규모 도서관,',['number']],
  ['64',467.04,475.65,'스토리박스 부지 3분의 2 정도 대부분의 땅을 팔아 먹으니 문화부값 시설 1개 동밖에 줄 수 없는 것입니다.',['number']],
  ['67',488.22,494.3,'신상진 시장은 내로남부리고 이것이 국민의힘이 내세우는 공정입니까?',['name']],
  ['71',508.65,515.89,'이번 행정감사에서 스토리박스 부지 매각의 철차와 내용의 유법성과 부당함을 철저히 따지겠습니다.'],
  ['73',527.21,536.81,'신상진 시장이 선거때만 외친 도덕적 혜의 공약, 무능하거나 책임의 핏성 행정은 성남시 발전을 가로막는 시민에게 상처만 남깁니다.',['name']],
].map(value=>cue(...value));
const body = cue('body',547.02,550.62,'성남시의 직각적이고 전향적인 결단을 촉구합니다.',['low_confidence']);
const observedClose = cue('close',550.62,552.62,'끝까지 경청해 주셔서 감사합니다.',['low_confidence']);
const receipt = cue('receipt',565.18,571.74,'박기범 의원님 수고하셨습니다. 다음은 추선미 의원님 나오셔서 발견해 주시기 바랍니다.',['name']);
const close = {...observedClose,flags:[]};
const rows = [call,intro,...bridge,body,close,receipt];
const revise = (row,text) => ({...row,text,rawText:text});
const replace = (row,updated) => rows.map(original => original.id===row.id ? updated : original);
const shift = (row,start) => ({...row,start,end:start+(row.end-row.start),observedAt:observedAt(start)});

test('the original 5467 low-confidence close is withheld, while the introduction is still named',()=>{
  const result = attribute(meeting,replace(close,observedClose));
  assert.equal(result.intro?.name,'박기범');
  assert.equal(result.intro?.basis,'plenary-called-introduction');
  assert.ok(!result.close?.name);
  assert.ok(!result.receipt?.name);
});

test('with reliable recognition, a matching chair receipt retroactively marks only the closing greeting',()=>{
  assert.ok(!attribute(meeting,rows.slice(0,-1)).close?.name);
  const result = attribute(meeting,rows);
  assert.equal(result.close?.name,'박기범');
  assert.equal(result.close?.role,'의원');
  assert.equal(result.close?.confidence,'low');
  assert.equal(result.close?.basis,'plenary-acknowledged-close');
  assert.deepEqual(result.close?.evidence,['call','intro','close','receipt']);
  for (const {id} of [call,...bridge,body,receipt]) assert.ok(!result[id]?.name,id);
  assert.deepEqual(attribute(meeting,[...rows].reverse()).close,result.close,'arrival order does not change real cue chronology');
  const last = revise(receipt,'박기범 의원님 수고하셨습니다. 이것으로 5분 자유 발언이 모두 끝났습니다.');
  assert.deepEqual(attribute(meeting,replace(receipt,last)).close,result.close);
});

test('wrong, reversed and non-unique roster names cannot act as a receipt',()=>{
  const changed = (before,after) => replace(receipt,revise(receipt,receipt.text.replace(before,after)));
  for (const [label,source,clips] of [
    ['wrong outgoing',meeting,changed('박기범','장일남')],
    ['unregistered incoming',meeting,changed('추선미','가나다')],
    ['same speaker twice',meeting,changed('추선미','박기범')],
    ['outgoing and incoming reversed',meeting,replace(receipt,revise(receipt,'추선미 의원님 수고하셨습니다. 다음은 박기범 의원님 나오셔서 발언해 주시기 바랍니다.'))],
    ['duplicate incoming',{...meeting,members:[...meeting.members,'추선미']},rows],
    ['other imperative',meeting,replace(receipt,revise(receipt,'박기범 의원님 수고하셨습니다. 다음은 추선미 의원님 나오셔서 마이크를 꺼 주시기 바랍니다.'))],
    ['wrong meeting type',{...meeting,title:'경제환경위원회'},rows],
    ['no introduction',meeting,rows.filter(row=>row!==intro)],
  ]) assert.ok(!attribute(source,clips).close?.name,label);
});

test('edits, mixed turns, and incompatible order or clocks withhold the closing name',()=>{
  for (const [label,clips,gaps] of [
    ['received out of time',[call,intro,...bridge,body,shift(receipt,550.62),shift(close,565.18)]],
    ['closing spans two utterances',replace(close,revise(close,close.text+' 네, 다음 순서입니다.'))],
    ['receipt spans two utterances',replace(receipt,revise(receipt,receipt.text+' 네, 안녕하십니까.'))],
    ['edited close',replace(close,{...close,rawText:'경청 부탁드립니다.'})],
    ['edited receipt',replace(receipt,{...receipt,rawText:receipt.text.replace('박기범','추선미')})],
    ['close flagged mixed',replace(close,{...close,flags:['mixed']})],
    ['receipt flagged overlap',replace(receipt,{...receipt,flags:['overlap']})],
    ['gap during speech',rows,[{start:observedAt(300),end:observedAt(301)}]],
    ['open gap before receipt',rows,[{start:observedAt(553),end:null}]],
    ['receipt after silence limit',replace(receipt,shift(receipt,567.63))],
    ['fast clock jump',replace(receipt,{...receipt,observedAt:observedAt(receipt.start+0.51)})],
    ['missing closing clock',replace(close,{...close,observedAt:null})],
    ['competing floor call',[...rows,cue('interruption',495,498,'다음은 추선미 의원님 나오셔서 발언해 주시기 바랍니다.')]],
  ]) assert.ok(!attribute(meeting,clips,[],gaps).close?.name,label);
});

const middle = bridge.find(row=>row.id==='54');
const preceding = bridge.find(row=>row.id==='50');
for (const [label,clips] of [
    ['unreported gap',rows.filter(row=>row!==middle)],
    ['intermediate clock jump',replace(middle,{...middle,observedAt:observedAt(middle.start+2)})],
    ['malformed intermediate clock',replace(middle,{...middle,observedAt:'not-a-date'})],
    ['mixed intermediate',replace(middle,{...middle,flags:[...middle.flags,'mixed']})],
    ['interrupted intermediate',replace(middle,{...middle,flags:[...middle.flags,'interrupted']})],
    ['overlap with greeting',replace(body,{...body,end:close.start+0.03})],
    ['overlap of chair and greeting',replace(receipt,shift(receipt,close.end-0.03))],
]) test(label+' prevents a closing name',()=>assert.ok(!attribute(meeting,clips).close?.name));

test('an earlier decoder overlap flagged for review is compatible with a clean closing greeting',()=>{
  const reviewedMiddle = replace(middle,{...middle,start:preceding.end-0.04,observedAt:observedAt(preceding.end-0.04)});
  assert.equal(attribute(meeting,reviewedMiddle).close?.name,'박기범');
});
