const test=require('node:test');
const assert=require('node:assert/strict');
require('../dist/asr/quality.js');
const {attribute}=require('../dist/live-speaker.js');

test('fast Korean captions use token boundaries without changing a recognized character', () => {
  const format = globalThis.CouncilQuality.koreanTokenSpacing;
  // Output from the same eight-second council recording in the Sherpa browser runtime.
  const raw = '그공부가저희가그공부간을개방형지로지금전환한지가 2022년인데지금';
  const tokens = [' 그',' 공부','가',' 저희','가',' 그',' 공부','간','을',' 개','방','형','지','로',
    ' 지금',' 전','환','한',' 지','가',' 20','2','2','년','인데',' 지금'];
  const expected = '그 공부가 저희가 그 공부간을 개방형지로 지금 전환한 지가 2022년인데 지금';
  assert.equal(format(raw, tokens), expected);
  assert.equal(format(expected, tokens), expected);
  assert.equal(format('교통사고예방및 이동지원', ['▁교통','사고','▁예방','▁및','이동','▁지원']), '교통사고 예방 및 이동 지원');
  for (const unavailable of [null,[],[null],['그',' 공부라고'],['<unk>']]) {
    assert.equal(format(raw, unavailable), raw);
  }
  assert.equal(format('예산 3.5%입니다.', [' 예산',' 3','.','5','%','입니다']), '예산 3.5%입니다.');
});
test('a standalone non-speech marker cannot replace an existing spoken caption',()=>{
  const speech=globalThis.CouncilQuality.spokenText;
  for (const marker of ['(인트로)','（음악）','[music]','[박수]','(silence)']) assert.equal(speech(marker),'');
  for (const words of ['인트로','(박수) 위원장님, 말씀드리겠습니다.','[의장] 시작합니다.','(새 사업입니다)']) assert.equal(speech(words),words);
});
test('a request for assurance identifies the question only when the original addresses the addressee directly',()=>{
  const words='지금까지 저 과장님 저한테 하신 말씀 그대로 지금 잘 이행하고 있다고 장담할 수 있어요.';
  const cue={id:'q',start:6883,end:6891,text:words,rawText:words,flags:[]};
  const meeting={title:'행정교육위원회',members:['김선임']};
  const answer={id:'a',start:6894,end:6902,text:'여러 가지 의견을 서로 공유하면서 검토합니다.',flags:[]};
  const result=attribute(meeting,[cue,answer]);
  assert.equal(result.q.role,'질의자');
  assert.equal(result.q.name,'');
  assert.ok(!result.a?.role);
  for(const text of [words.replace('장담','제가 장담'),words.replace('과장님','그분은'),words.replace('있어요.','있어요라고 말씀하셨습니다.')]){
    assert.ok(!attribute(meeting,[{...cue,text,rawText:text}]).q?.role);
  }
  assert.ok(!attribute(meeting,[{...cue,flags:['segment_review']}]).q?.role);
});

test('the observed opening hesitation keeps the assurance question role-only', () => {
  const words = '그지금까지저과장님저한테하신말씀그대로지금잘이응하고있다고장담할수있어요?';
  const cue = {id:'q', start:6883.896165666667, end:6892.074489, text:words, rawText:words, flags:[]};
  const meeting = {id:'5547', title:'행정교육위원회', members:['김선임']};
  const direct = attribute(meeting,[cue]).q;
  assert.deepEqual([direct?.name,direct?.role,direct?.evidence],['','질의자',['q']]);

  for (const text of [
    `“${words}”`,
    `김선임 위원이 ${words} 라고 물었습니다.`,
    `다른 위원이 ${words} 라고 물었습니다.`,
    `${words}라는 다른 위원의 질문을 읽었습니다.`,
    words.replace(/^그지금까지/,'그'),
  ]) {
    assert.equal(attribute(meeting,[{...cue,text,rawText:text}]).q,undefined);
  }
  assert.equal(attribute(meeting,[{...cue,rawText:'다른 위원 질문을 대신 읽겠습니다.'}]).q,undefined);
});

