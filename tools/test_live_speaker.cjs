const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {attribute}=require('../dist/live-speaker.js');
const members=['\uC548\uAD11\uD658','\uC7A5\uC77C\uB0A8','\uAE40\uC625\uC218','\uC11C\uC740\uACBD','\uC815\uBD09\uADDC','\uC815\uC5F0\uD654','\uC870\uC6B0\uD604'];
const meeting={id:'2853',members};
const cue=(id,text,start,end,flags=[],observedAt)=>({id,text,start,end,flags,observedAt});

{
  const roster=[{name:'이종빈',role:'푸른도시사업소장',source:'https://example.org/1',appointedOn:'2026-07-20'}, {name:'장미라',role:'자원순환과장',source:'https://example.org/2'}, {name:'정연달',role:'공원과장',source:'https://example.org/3'}];
  const m={...meeting,staffRoster:roster};
  for (const [id,text,name] of [['a','안녕하십니까. 부른 도시 사업소장 이종빈입니다.','이종빈'],['b','안녕하십니까, 자원순환 과장 장미라입니다.','장미라'],['c','네, 공원과장 정연달입니다.','정연달']]) {
    const c=cue(id,text,0,3); const value=attribute(m,[c])[id];
    assert.equal(value?.name,name); assert.match(value.method,/공식 명부/); assert.deepEqual(Object.keys(value).sort(),['confidence','evidence','method','name','role']);
    const flagged=attribute(m,[{...c,flags:['name']}])[id];
    assert.equal(flagged?.name,name); assert.equal(flagged.confidence,'low'); assert.match(flagged.method,/원음 확인/);
    assert.notEqual(attribute(meeting,[c])[id]?.method?.includes('공식 명부'),true);
    assert.notEqual(attribute({...m,staffRoster:[...roster,{...roster.find(x=>x.name===name)}]},[c])[id]?.method?.includes('공식 명부'),true);
  }
  for (const text of ['온몸을 소개하겠습니다. 정연달 공원과장입니다.','정연달 공원과장입니다라고 소개했습니다.','네, 공원과장 정연달입니다. 자원순환과장 장미라입니다.','대리로 공원과장 정연달입니다.']) {
    assert.notEqual(attribute(m,[cue('no',text,0,3)]).no?.method?.includes('공식 명부'),true,text);
  }
  assert.notEqual(attribute(m,[cue('wrong','안녕하십니까. 맑은물관리사업소장 이종빈입니다.',0,3)]).wrong?.method?.includes('공식 명부'),true);
  const expanded={...m,staffRoster:[...roster,{name:'김가나',role:'재난안전관',source:'https://example.org'},{name:'박가나',role:'성남문화재단대표이사',source:'https://example.org'}]};
  assert.equal(attribute(expanded,[cue('office','안녕하십니까. 재난안전관 김가나입니다.',0,3)]).office?.name,'김가나');
  assert.equal(attribute(expanded,[cue('culture','네, 대표이사 박가나입니다.',0,3)]).culture?.name,'박가나');
  const q=cue('q','소장님 그 자리에 오신 지 얼마나 되셨어요?',0,3,[],'2026-11-25T08:41:03Z');
  const a=cue('a','지난 7월 20일날 발령받았습니다.',3,5,[],'2026-11-25T08:41:06Z');
  assert.equal(attribute(m,[q,a]).a?.name,'이종빈');
  assert.notEqual(attribute({...m,staffRoster:roster.map(r=>({...r,appointedOn:'2026-07-21'}))},[q,a]).a?.name,'이종빈');
  assert.notEqual(attribute(m,[q,{...a,text:'지난 7월 20일에 회의했습니다.'}]).a?.name,'이종빈');
  const altQ={...q,text:'소장님 언제 부임하셨습니까?'};
  const altA={...a,text:'7월 20일 자로 부임했습니다.'};
  assert.equal(attribute(m,[altQ,altA]).a?.name,'이종빈');
  assert.notEqual(attribute(m,[altQ,{...altA,text:'내년 7월 20일 자로 부임했습니다.'}]).a?.name,'이종빈');
  assert.notEqual(attribute({...m,staffRoster:[...roster,{name:'동명이',role:'다른 사업소장',source:'https://example.org',appointedOn:'2026-07-20'}]},[q,a]).a?.name,'이종빈');
  const member=cue('member','네, 과장님 장일남입니다. 203페이지고요.',0,3);
  assert.equal(attribute(m,[member]).member?.name,'장일남');
  assert.notEqual(attribute({...m,staffRoster:[...roster,{name:'장일남',role:'과장',source:'https://example.org'}]},[member]).member?.name,'장일남');
  for (const text of ['네, 과장님 장일남입니다라고 소개했습니다.','네, 과장님 장일남입니다. 소장 김철수입니다.','네, 과장님 장일남입니다. 정연화 의원입니다.']) assert.notEqual(attribute(m,[cue('no',text,0,3)]).no?.method?.includes('직책 호칭 뒤'),true,text);
  const committee={id:'2852',members:['순선영']};
  const call=cue('1795584783028762084','네, 순선영 위원님 말씀해 주십시오.',0,3);
  const response=cue('1795584783028762085','네, 안녕하십니까? 순선영입니다.',3,6);
  assert.equal(attribute(committee,[call,response])[response.id]?.name,'순선영');
  const alternateCall={...call,text:'다음은 순선영 의원님 질의하시기 바랍니다.',flags:['name']};
  assert.equal(attribute(committee,[alternateCall,{...response,text:'안녕하세요, 순선영입니다.'}])[response.id]?.name,'순선영');
  assert.notEqual(attribute(committee,[{...alternateCall,text:'김철수 의원님 질의하시기 바랍니다.'},response])[response.id]?.name,'순선영');
  assert.equal(attribute(m,[{...member,text:'안녕하세요? 과장님. 장일남입니다.'}]).member?.name,'장일남');
  assert.notEqual(attribute(committee,[call,{...response,start:7,end:9}])[response.id]?.method?.includes('호명 직후'),true);
  assert.notEqual(attribute(committee,[call,{...response,text:'네, 안녕하십니까? 순선영입니다. 김보석 의원입니다.'}])[response.id]?.method?.includes('호명 직후'),true);
}

const browserWindow={CouncilSpeakerReview:require('../dist/speaker-review.js'),CouncilNameplateReview:require('../dist/nameplate-review.js')};
vm.runInNewContext(fs.readFileSync(require.resolve('../dist/live-speaker.js'),'utf8'),{window:browserWindow});
assert.equal(typeof browserWindow.CouncilLiveSpeaker.attribute,'function','browser UMD consumes injected globals');

// Actual 2853 live sample: the called member confirms their name in the next cue.
const called=cue('1795587268650154061','\uC870\uC6B0\uD604 \uC758\uC6D0\uB2D8 \uC9C8\uC758\uD574 \uC8FC\uC2ED\uC2DC\uC624.',995.617,999.257);
const intro=cue('1795587268650154062','\uC870\uC6B0\uD604 \uC758\uC6D0\uC785\uB2C8\uB2E4. \uACFC\uC7A5\uB2D8 ...',999.257,1004.1);
let result=attribute(meeting,[called,intro]);
assert.equal(result[called.id],undefined,'do not assign the chair calling the next member');
assert.equal(result[intro.id].name,'\uC870\uC6B0\uD604');
assert.deepEqual(result[intro.id].evidence,[called.id,intro.id]);
assert.equal(result[intro.id].confidence,'medium');

// Actual 2853 short response after a direct call; a narrow immediate response can be reviewed.
const call=cue('1795584783050047742','\uC870 \uC758\uC6D0\uB2D8 \uC218\uACE0\uD558\uC168\uC2B5\uB2C8\uB2E4. \uB610 \uC9C8\uC758\uD558\uC2E4 \uC758\uC6D0\uB2D8. \uC815\uC5F0\uD654 \uC758\uC6D0\uB2D8 \uC9C8\uC758\uD574 \uC8FC\uC2DC\uACE0.',617.131,622.231);
const ack=cue('1795584783050047743','\uB124, \uACFC\uC7A5\uB2D8.',622.231,624.231);
result=attribute(meeting,[call,ack]);
assert.equal(result[ack.id]?.name,'\uC815\uC5F0\uD654');
assert.deepEqual(result[ack.id]?.evidence,[call.id,ack.id]);

// Do not transfer a named questioner's identity to a staff answer.
const answerCall=cue('answer-call','\uC7A5\uC77C\uB0A8 \uC758\uC6D0\uB2D8 \uC9C8\uC758\uC5D0 \uB300\uD574 \uACFC\uC7A5\uB2D8 \uB2F5\uBCC0\uD574 \uC8FC\uC2ED\uC2DC\uC624.',10,14);
const answer=cue('answer','\uC608\uC0B0 \uD3B8\uC131 \uB0B4\uC5ED\uC744 \uD655\uC778\uD558\uACA0\uC2B5\uB2C8\uB2E4.',14,19);
assert.equal(attribute(meeting,[answerCall,answer])[answer.id],undefined);

// A named staff role is offered only on its own explicit self-introduction cue.
const staff=cue('staff','\uD658\uACBD\uC815\uCC45 \uACFC\uC7A5\uC785\uB2C8\uB2E4.',1,3);
const staffNameInRole=cue('staff-single','김정아 자원행정팀장입니다.',3,5);
const twoOfficials=cue('two-officials','구본양 녹취과장입니다. 오제성 생태하점과장입니다.',5,9);
assert.equal(attribute(meeting,[staffNameInRole])['staff-single'].role,'팀장');
assert.equal(attribute(meeting,[twoOfficials])['two-officials'],undefined);
const {displayCandidate}=require('../dist/live-speaker.js');
assert.equal(displayCandidate(twoOfficials,{name:'',role:'구본양 녹취과장',method:'직책 자기소개'}),undefined);
assert.equal(displayCandidate(staffNameInRole,{name:'',role:'김정아 자원행정팀장',method:'직책 자기소개'}).role,'팀장');
const question=cue('question','\uD658\uACBD\uC815\uCC45 \uACFC\uC7A5\uC774 \uB4E4\uC5B4\uAC00\uC694?',3,5);
result=attribute(meeting,[staff,question]);
assert.equal(result.staff.name,''); assert.ok(result.staff.role); assert.equal(result.staff.confidence,'medium'); assert.ok(result.staff.method); assert.deepEqual(result.staff.evidence,['staff']);
assert.equal(result.question,undefined,'do not carry a role-only self-introduction into the next question');
const namedStaff=cue('named-staff','\uC800\uB294 \uD658\uACBD\uBCF4\uAC74\uAD6D\uC7A5 \uD64D\uAE38\uB3D9\uC785\uB2C8\uB2E4.',6,10);
result=attribute(meeting,[namedStaff]);
assert.equal(result[namedStaff.id]?.name,'\uD64D\uAE38\uB3D9');
assert.equal(result[namedStaff.id]?.role,'\uC9D1\uD589\uBD80(\uC9C1\uC704 \uD655\uC778 \uD544\uC694)');

// Proceedings role can be suggested without borrowing a member name.
const chair=cue('chair','\uC131\uC6D0\uC774 \uB418\uC5C8\uC73C\uBBC0\uB85C \uD68C\uC758\uB97C \uAC1C\uD68C\uD558\uACA0\uC2B5\uB2C8\uB2E4.',20,27);
result=attribute({id:'x',members:[]},[chair]);
assert.equal(result.chair?.role,'\uC758\uC0AC\uC9C4\uD589\uC790');
assert.equal(result.chair?.name,'');

// Review flags, gaps, or an OCR-only name never create attribution.
for (const flag of ['severe_uncertainty','repetition','segment_review','low_confidence']) {
  assert.equal(attribute(meeting,[call,{...ack,flags:[flag]}])[ack.id],undefined,flag);
}
const observedCall={...call,observedAt:'2026-11-25T07:00:00.000Z'};
const observedAck={...ack,observedAt:'2026-11-25T07:00:05.100Z'};
assert.equal(attribute(meeting,[observedCall,observedAck],[],[{start:'2026-11-25T07:00:02.000Z',end:'2026-11-25T07:00:04.000Z'}])[ack.id],undefined);
assert.deepEqual(attribute(meeting,[cue('ocr-only','\uC608\uC0B0 \uD3B8\uC131 \uB0B4\uC5ED\uC744 \uD655\uC778\uD558\uACA0\uC2B5\uB2C8\uB2E4.',1,5)],
  [{capturedAt:'2026-11-25T07:00:02.000Z',matchedMembers:['\uC815\uC5F0\uD654']}]),{});

// If textual cues independently point to a name, a uniquely aligned nameplate may corroborate it.
const observedIntro={...intro,observedAt:'2026-11-25T07:00:00.000Z'};
const obs=[{capturedAt:'2026-11-25T07:00:02.000Z',matchedMembers:['\uC870\uC6B0\uD604']}];
result=attribute(meeting,[called,observedIntro],obs);
assert.equal(result[observedIntro.id].confidence,'medium');
assert.ok(result[observedIntro.id].method);
assert.deepEqual(result[observedIntro.id].evidence,[called.id,observedIntro.id]);

// Specific direct-address questions and their immediate answer support role-only attribution.
const qRole=cue('1795587268650154168','\uACFC\uC7A5\uB2D8 \uC544\uC2DC\uACA0\uC5B4\uC694? \uB300\uB2F5\uC744 \uC548 \uD558\uC2DC\uB124.',0,3.64);
const aRole=cue('1795587268650154169','\uC774 \uBD80\uBD84\uC5D0 \uC880 \uC81C\uAC00 \uB300\uB2F5\uB4DC\uB9AC\uAE30\uAC00 \uC5B4\uB824\uC6B4 \uBD80\uBD84\uC774 \uC0AC\uC2E4\uC740 \uC758\uC6D0\uB2D8\uAED8\uC11C \uB9D0\uC500\uD558\uC2E0 \uB73B\uC740 \uC81C\uAC00 \uCDA9\uBD84\uD788 \uC54C\uC544\uB4E4\uC5C8\uB294\uB370\uC694.',3.64,8.64,['name']);
result=attribute(meeting,[qRole,aRole]);
assert.deepEqual(result[qRole.id],{name:'',role:'\uC9C8\uC758\uC790',confidence:'low',method:result[qRole.id].method,evidence:[qRole.id]});
assert.equal(result[aRole.id].name,'');
assert.equal(result[aRole.id].role,'\uACFC\uC7A5');
assert.equal(result[aRole.id].confidence,'low');
assert.deepEqual(result[aRole.id].evidence,[qRole.id,aRole.id]);
const standaloneAnswer=cue('answer-only','\uC758\uC6D0\uB2D8\uAED8\uC11C \uB9D0\uC500\uD558\uC2E0 \uB73B\uC740 \uC81C\uAC00 \uCDA9\uBD84\uD788 \uC54C\uC544\uB4E4\uC5C8\uACE0 \uC81C\uAC00 \uB2F5\uBCC0\uB4DC\uB9AC\uACA0\uC2B5\uB2C8\uB2E4.',12,17);
assert.equal(attribute(meeting,[standaloneAnswer])[standaloneAnswer.id]?.role,'\uB2F5\uBCC0\uC790');
const staleQuestion=cue('stale-q','\uACFC\uC7A5\uB2D8 \uC544\uC2DC\uACA0\uC5B4\uC694? \uB300\uB2F5\uC744 \uC548 \uD558\uC2DC\uB124.',0,2);
const intervening=cue('intervening','\uC774\uC81C \uB2E4\uC74C \uC548\uAC74\uC73C\uB85C \uB118\uC5B4\uAC00\uACA0\uC2B5\uB2C8\uB2E4.',2,5);
const lateAnswer=cue('late-answer','\uC758\uC6D0\uB2D8\uAED8\uC11C \uB9D0\uC500\uD558\uC2E0 \uB73B\uC740 \uC81C\uAC00 \uB2F5\uBCC0\uB4DC\uB9AC\uACA0\uC2B5\uB2C8\uB2E4.',5,9);
assert.equal(attribute(meeting,[staleQuestion,intervening,lateAnswer])[lateAnswer.id].role,'\uB2F5\uBCC0\uC790');

const staleCaller={...called,id:'stale-caller',start:20,end:24};
const staleIntro={...intro,id:'stale-intro',start:40,end:45};
result=attribute(meeting,[staleCaller,staleIntro]);
assert.equal(result[staleIntro.id]?.name,'\uC870\uC6B0\uD604');
assert.deepEqual(result[staleIntro.id]?.evidence,[staleIntro.id],'a stale call cannot upgrade a self-introduction');
const gapCaller={...called,id:'gap-caller',start:0,end:4,observedAt:'2026-11-25T05:30:00.000Z'};
const gapIntro={...intro,id:'gap-intro',start:4,end:8,observedAt:'2026-11-25T05:30:05.000Z'};
result=attribute(meeting,[gapCaller,gapIntro],[],[{start:'2026-11-25T05:30:04.100Z',end:'2026-11-25T05:30:04.900Z'}]);
assert.deepEqual(result[gapIntro.id]?.evidence,[gapIntro.id],'a cross-gap call is not corroborating evidence');
assert.equal(attribute(meeting,[{...staff,flags:['severe_uncertainty']}]).staff,undefined,'unreliable staff self-introduction is withheld');

const baseCall=cue('continuation-call','\uC815\uC5F0\uD654 \uC758\uC6D0\uB2D8 \uC9C8\uC758\uD574 \uC8FC\uC2DC\uAE30 \uBC14\uB78D\uB2C8\uB2E4.',0,2);
const baseAnswer=cue('continuation-base','\uC800\uB294 \uD658\uACBD\uC815\uCC45\uC5D0 \uB300\uD574 \uB9D0\uC500\uB4DC\uB9AC\uACA0\uC2B5\uB2C8\uB2E4',2,4);
const oneExtension=cue('continuation-one','\uADF8\uB9AC\uACE0 \uC81C\uAC00 \uC0DD\uAC01\uD558\uB294 \uC810\uC740 \uB2E4\uB985\uB2C8\uB2E4',4,5);
const chainedExtension=cue('continuation-two','\uADF8\uB9AC\uACE0 \uC800\uB294 \uCD94\uAC00 \uC758\uACAC\uC774 \uC788\uC2B5\uB2C8\uB2E4',5,6);
result=attribute(meeting,[baseCall,baseAnswer,oneExtension,chainedExtension]);
assert.equal(result[oneExtension.id]?.name,'\uC815\uC5F0\uD654');
assert.equal(result[chainedExtension.id],undefined,'speaker is not carried through repeated continuation cues');

// Names cited from someone else's earlier remarks, an answer, or a corrupted call remain withheld.
const citeCall=cue('cite-call','\uC815\uBD09\uADDC \uC758\uC6D0\uB2D8, \uC9C0\uB9AC\uD558\uC2DC\uB7EC.',1067.771,1069.771);
const cite=cue('cite','\uC544\uAE4C \uC55E\uC11C \uC7A5\uC77C\uB0A8 \uC758\uC6D0\uB2D8 \uB9D0\uC500\uD558\uC168\uB358 \uC0AC\uC548\uC740 ...',1069.771,1074.771);
assert.equal(attribute(meeting,[citeCall,cite])[cite.id]?.name,'\uC815\uBD09\uADDC');
const badCall=cue('bad-call','\uC815\uC5F0\uD654 \uC758\uC6D0\uB2D8 \uC9C8\uC758\uD558\uC2DC\uB7EC.',1548.231,1553.561,['name']);
const badAck=cue('bad-ack','\uACFC\uC7A5\uB2D8 \uACE0\uC0DD \uB9CE\uC73C\uC2ED\uB2C8\uB2E4.',1554.821,1557.331);
assert.equal(attribute(meeting,[badCall,badAck])[badAck.id],undefined);
const corruptedCall=cue('1795584783050047937','\uB124. \uC218\uACE0\uD558\uC168\uC2B5\uB2C8\uB2E4. \uB610 \uC9C0\uB9AC\uD558\uC2DC\uB77C\uC694. \uC11C\uC740\uACBD\uC774 \uD615\uB2D8.',1548.231,1553.561);
const corruptedAck=cue('1795584783050047938','\uACFC\uC7A5\uB2D8 \uACE0\uC0DD \uB9CE\uC73C\uC2ED\uB2C8\uB2E4.',1554.821,1557.331);
assert.equal(attribute(meeting,[corruptedCall,corruptedAck])[corruptedAck.id],undefined,'a corrupted name call is not repaired into an identity');
assert.equal(attribute(meeting,[observedCall,observedAck],[],[{start:'2026-11-25T07:00:02.000Z',end:'2026-11-25T07:00:04.000Z'}])[observedAck.id],undefined,'unknown cue timestamps with archive gaps must abstain');

// The exported result is an ordinary object; values have only the public contract fields.
assert.equal(Object.getPrototypeOf(result),Object.prototype);
for (const value of Object.values(result)) assert.deepEqual(Object.keys(value).sort(),['confidence','evidence','method','name','role']);
console.log('PASS live speaker attribution: actual 2853 turns, self-intros, staff/proceedings roles, gaps, flags, and OCR corroboration');

// Reproduce the split-screen member / director exchange seen in the public feed.
{
  const clock = sec => new Date(Date.parse('2026-11-25T08:35:02Z')+1000*sec).toISOString();
  const turn = (id,sec,length,text,flags=[])=>cue(id,text,sec,sec+length,flags,clock(sec));
  const opening=turn('4372',0,3,'초장님 서원경 의원입니다.',['name']);
  const acknowledge=turn('4373',3,1,'네, 의원님.');
  const question=turn('q',18,6,'소장님, 언제 완공되나요?');
  const reply=turn('a',24,3,'27년 11월으로 알고 있습니다.',['number']);
  const mixed=turn('mixed',27,7,'그렇죠? 네. 저도 이 자료를 받았습니다.');
  const later=turn('4435',34,4,'공원을 지키는 게 트론 도시 사업소의 큰 일 아닙니까?');
  const rows=[opening,acknowledge,question,reply,mixed,later];
  const plate=(sec,...names)=>({capturedAt:clock(sec),matchedMembers:names});
  const out=attribute(meeting,rows,[plate(10,'서은경')],[]);
  assert.equal(out['4372'].name,'서은경');
  assert.equal(out['4373'].name,''); assert.equal(out['4373'].role,'답변자');
  assert.equal(out.q.name,'서은경'); assert.equal(out.a.name,''); assert.equal(out.a.role,'소장');
  assert.equal(out.mixed,undefined); assert.equal(out['4435'].name,'서은경');
  const distant=attribute(meeting,[opening],[plate(53,'서은경'),plate(116,'서은경')],[]);
  assert.equal(distant['4372'].name,'서은경');
  for (const samples of [[],[plate(53,'서은경')],[plate(10,'서은경','김옥수')],[plate(8,'김옥수'),plate(11,'서은경')],[plate(160,'서은경')]]) {
    assert.equal(attribute(meeting,rows,samples,[])['4372'].name,'');
  }
  assert.equal(attribute({...meeting,members:[...meeting.members,'서완경']},rows,[plate(10,'서은경')],[])['4372']?.name || '','');
  assert.equal(attribute(meeting,rows,[plate(10,'서은경')],[{start:clock(6),end:clock(9)}])['4372'].name,'');
  const handoff=turn('handoff',8,2,'다음 위원님 질의해 주십시오.');
  assert.equal(attribute(meeting,[opening,handoff,question],[plate(10,'서은경')],[])['4372'].name,'');
  assert.equal(attribute(meeting,[question],[plate(15,'서은경')],[]).q.name,'');
  const checkQuestion=turn('again',34,4,'여기는 해제돼서는 안 될 곳이라고 생각하는데 과장임은 어떠세요?');
  const handBack=turn('ask',27,6,'제가 여쭤볼게요. 그러면 어차피...');
  const twoTurns=turn('both',40,5,'총 13개소가 남아있습니다. 그런데 왜 다른 건 안 올라왔어요?');
  const candidates=attribute(meeting,[...rows.slice(0,4),handBack,checkQuestion,twoTurns],[plate(10,'서은경')],[]);
  assert.equal(candidates.ask.name,'서은경'); assert.equal(candidates.again.name,'서은경'); assert.equal(candidates.both,undefined);
}
