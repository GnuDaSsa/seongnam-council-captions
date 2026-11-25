const assert=require('node:assert/strict'), f=require('../dist/minutes-format.js');
const cues=[
 {id:'a',start:0,end:4,observedAt:'2026-11-25T04:00:00Z',text:'예, 예. 2027년 사업입니다.',rawText:'예, 예. 2027년 사업입니다.',flags:[]},
 {id:'b',start:0,end:8,observedAt:'2026-11-25T04:00:00Z',text:'[인식 구간 오류]',rawText:'예, 예. 2027년 사업입니다.',flags:['segment_review']},
 {id:'c',start:10,end:16,observedAt:'2026-11-25T04:00:20Z',text:'[인식 구간 오류]',rawText:'정상 원문입니다.',flags:['segment_review']},
 {id:'d',start:20,end:25,observedAt:'2026-11-25T04:00:30Z',text:'반복'.repeat(80),rawText:'반복'.repeat(80),flags:['segment_review','repetition']}
];
const meeting={title:'시험',source:'https://example.org',agenda:[]}, archive={cues,gaps:[{start:'2026-11-25T04:00:10Z',end:'2026-11-25T04:00:15Z'}]};
const read=f.initial, meta=()=>({}), coverage='범위 확인';
const out=f.lines({meeting,archive,read,meta,coverage,bad:f.bad,initial:f.initial}).join('\n');
assert.equal((out.match(/2027년 사업입니다/g)||[]).length,1);
assert.ok(out.includes('예, 예. 2027년')); assert.ok(out.includes('정상 원문입니다.')); assert.ok(!out.includes('반복'.repeat(80)));
assert.ok(out.indexOf('2027년 사업') < out.indexOf('수집 중단') && out.indexOf('수집 중단') < out.indexOf('정상 원문'));
assert.ok(!out.includes('기록 ID:')); assert.ok(out.includes('시간 불확실'));
assert.equal(f.tidy('네. 네. 3건 정연화'), '네. 네. 3건 정연화');
assert.equal(f.isDuplicate(cues[1],cues,true,f.bad),false);
console.log('PASS: exact overlap only, gap placement, uncertain source retained, severe repetition blocked, names/numbers/acknowledgements preserved');
const make = (id, start, end, text) => ({id,start,end,text,rawText:text,flags:[],observedAt:new Date(Date.parse('2026-11-25T04:00:00Z') + start*1000).toISOString()});
const chunks=[make('x',0,2,'2027년 사업을'),make('y',2.5,4,'추진합니다.'),make('z',4.5,5,'네.')];
const signed=()=>({speaker:'담당자'});
const build=(list, extra=[], getMeta=signed, getText=f.initial)=>f.lines({meeting,archive:{cues:list,gaps:extra},read:getText,meta:getMeta,coverage,bad:f.bad,initial:f.initial}).join('\n');
const joined=build(chunks);
assert.match(joined,/2027년 사업을 추진합니다\./);
assert.equal((joined.match(/○담당자/g)||[]).length,2,'acknowledgement remains independent');
assert.equal((build(chunks,[],()=>({})).match(/○발언자 미확인/g)||[]).length,3);
assert.equal((build(chunks,[{start:'2026-11-25T04:00:02Z',end:'2026-11-25T04:00:03Z'}]).match(/○담당자/g)||[]).length,3);
assert.equal((build(chunks,[],c=>({speaker:'담당자',kind:c.id==='y'?'질의':'일반 발언'})).match(/○담당자/g)||[]).length,3);
const edited=build(chunks,[],signed,c=>c.id==='x'?'첫 발언\n둘째 발언':f.initial(c));
assert.match(edited,/첫 발언\n둘째 발언/);
assert.equal((edited.match(/○담당자/g)||[]).length,3);
assert.equal(f.tidy('첫 발언\n둘째 발언'),'첫 발언\n둘째 발언');
console.log('PASS: confirmed speaker only, fragment joining excludes gaps/classification/acknowledgements; manual line breaks retained');
