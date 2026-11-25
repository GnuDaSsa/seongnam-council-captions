const test=require('node:test');
const assert=require('node:assert/strict');
const {attribute}=require('../dist/live-speaker.js');
const meeting={id:'5488',title:'제2차 본회의',members:['민영미','김종환'],staffRoster:[]};
const base=Date.parse('2026-10-08T00:00:00+09:00');
const row=(id,start,end,text,flags=[])=>({id,start,end,text,rawText:text,flags,observedAt:new Date(base+start*1000).toISOString()});
const originalCall='그러면 민영미 의원님 나오셔서 발언하여 주시기 바랍니다.';
const originalIntro='2매 1, 2동, 3평동 민영미 의원입니다. 오늘 저는 20년이 가까이 비어든 땅.';
function run({call=originalCall,intro=originalIntro,flags=['number','name'],start=160.91,extras=[],gaps=[],m=meeting}={}){
 const cues=[row('call',126.50,131.14,call,['name']),...extras,row('intro',start,start+6.83,intro,flags)];
 return attribute(m,cues,[],gaps).intro;
}
test('5488 raw call and introduction produce an explicitly low confidence candidate',()=>{
 const got=run();assert.equal(got?.name,'민영미');assert.equal(got?.role,'의원');assert.equal(got?.basis,'plenary-first-person-topic');assert.equal(got?.confidence,'low');assert.deepEqual(got?.evidence,['call','intro']);
});
test('name conflict, missing roster, bad district or changed context never take the topic shortcut',()=>{
 const options=[
  {intro:originalIntro.replace('민영미','김종환')},
  {call:originalCall.replace('민영미','김종환')},
  {m:{...meeting,members:['김종환']}},
  {m:{...meeting,members:['민영미','민영미']}},
  {intro:originalIntro.replace('2매 1, 2동, 3평동','가짜 1, 2동, 3평동')},
  {intro:originalIntro.replace('오늘 저는 20년이 가까이 비어든 땅','오늘 저는 김종환 의원님께 말씀하겠습니다')},
  {intro:originalIntro+' 네, 그렇습니다.'},
  {intro:originalIntro.replace('20년이 가까이 비어든 땅','대신 발언을 전해 드립니다')},
  {flags:['mixed']}, {flags:['low_confidence']},
  {extras:[row('other',145,150,'네 그렇습니다.')]},
  {gaps:[{start:new Date(base+140000).toISOString(),end:new Date(base+145000).toISOString(),reason:'interrupted'}]},
  {start:225},
 ];
 for(const item of options) assert.notEqual(run(item)?.basis,'plenary-first-person-topic',JSON.stringify(item));
});
