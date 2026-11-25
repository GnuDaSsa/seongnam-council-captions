const test=require('node:test'); const assert=require('node:assert/strict');
const {assess}=require('../dist/vod-transcript.js');
const rows=require('../dist/data/vod-index.json').meetings;
const meeting=rows.find(x=>x.id==='5478');
const reference=require('../dist/data/vod-transcripts/5478.json');
const cue=(id,start,end,text)=>({id,meetingId:'5478',source:'local',start,end,text,rawText:text,flags:[]});
const prior=cue('prior',1589,1597,'더 중요한 일이 어디있습니까 제발 의외를 무시하는 행동을 말아주시길 간곡하게');
const end=cue('end',1597,1605,'부탁드립니다.');
function probe(a=prior,b=end,ref=reference){return assess(meeting,b,ref,[a,b])?.speaker;}
test('real 5478 text joins exact official sentence only behind independently matched prior',()=>{
 assert.equal(assess(meeting,prior,reference)?.speaker?.name,'장정현');
 assert.equal(probe()?.name,'장정현');assert.deepEqual(probe().evidence,['prior','end']);
});
test('short predicate declines absent anchor, mismatch, gap, overlap, changed speaker or risky text',()=>{
 const bad=[
  [null,end,reference],
  [{...prior,text:'다른 완전히 별개의 의회 진행과 관련된 간곡하게',rawText:'다른 완전히 별개의 의회 진행과 관련된 간곡하게'},end,reference],
  [{...prior,speaker:{name:'다른사람'}},end,reference],
  [prior,{...end,start:prior.end-0.1},reference],
  [prior,{...end,start:prior.end+100},reference],
  [{...prior,flags:['mixed']},end,reference],
  [prior,{...end,rawText:'다른 답변입니다.'},reference],
  [prior,{...end,text:'“부탁드립니다.”',rawText:'“부탁드립니다.”'},reference],
  [prior,{...end,meetingId:'5482'},reference],
  [prior,end,{...reference,sourceUrl:'https://example.invalid/not-official'}],
  [prior,end,{...reference,meetingId:'5482'}],
  [prior,{...end,flags:['overlap']},reference],
 ];
 for(const [a,b,r] of bad)assert.equal(probe(a,b,r),undefined,JSON.stringify([a,b]));
 const old=reference.turns.find(t=>t.id==='5478-turn-0016');
 const phrase='무시하는 행동을 말아 주시길 간곡하게 부탁드립니다';
 assert.ok(old.text.includes(phrase));
 const replaced={...reference,turns:reference.turns.map(t=>t.id===old.id?{...t,text:t.text.replace(phrase,'무시하는 행동을 말아 주시길 간곡하게 말씀드립니다')}:t)};
 assert.equal(probe(prior,end,replaced),undefined);
 const quoted={...reference,turns:reference.turns.map(t=>t.id===old.id?{...t,text:t.text.replace(phrase,'“'+phrase+'”')}:t)};
 assert.equal(probe(prior,end,quoted),undefined);
 const duplicate={...reference,turns:[...reference.turns,{...old,id:'duplicate',name:'김가나',text:'제발 '+phrase+'.'}]};
 assert.equal(probe(prior,end,duplicate),undefined);
});

