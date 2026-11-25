const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {attribute}=require('../dist/live-speaker.js');
const members=['\uC548\uAD11\uD658','\uC7A5\uC77C\uB0A8','\uAE40\uC625\uC218','\uC11C\uC740\uACBD','\uC815\uBD09\uADDC','\uC815\uC5F0\uD654','\uC870\uC6B0\uD604'];
const meeting={id:'2853',members};
const cue=(id,text,start,end,flags=[],observedAt)=>({id,text,start,end,flags,observedAt});

{
  const roster = [{name:'장미라',role:'자원순환과장',source:'https://www.sncouncil.go.kr/record/recordView.do?key=1234abcd'}];
  const m = {title:'경제환경위원회', members:[], staffRoster:roster};
  const make = (id,text,start,end) => ({...cue(id,text,start,end,[]),rawText:text});
  const announce=make('list','먼저 설명에 앞서 환경보건국 소속 간부 공무원을 소개해 드리겠습니다.',0,5);
  const first=make('first','유성희 환경정책과장입니다.',5,8);
  const target=make('target','장미라 자원순환과장입니다.',8,12);
  for (const words of [target.text,'자원순환과장 장미라입니다.']) {
    const listed=make('target',words,8,12);
    assert.ok(!attribute(m,[announce,first,listed]).target);
  }
  assert.ok(!attribute(m,[make('joined',announce.text+' 자원순환과장 장미라입니다.',0,8)]).joined);
  assert.ok(!attribute(m,[announce,make('lead','안녕하십니까 자원순환과장',5,8),make('name','장미라입니다.',8,11)]).name);
  const longList=[announce];
  for (let i=0;i<9;i++) longList.push(make('item'+i,'유성희 환경정책과장입니다.',5+i*5,10+i*5));
  longList.push(make('last','자원순환과장 장미라입니다.',50,54));
  assert.ok(!attribute(m,longList).last);
  const self=make('self','안녕하십니까. 자원순환과장 장미라입니다.',100,104);
  assert.equal(attribute(m,[announce,self]).self.name,'장미라');
}

{
  const m = {id:'5418', title:'도시건설위원회', date:'2026-08-28', members:[]};
  const label = (id,text,start,end) => ({...cue(id,text,start,end,['name']), rawText:text});
  const call = label('request','이어서 집행부 기원을 듣겠습니다. 양윤기 교통기획과장님 나오셔서 검토기원을 말씀해 주시기 바랍니다.',266.55,272.95);
  const reply = label('reply','안녕하십니까 교통기획과장님 양윤기입니다.',274,277);
  const result = attribute(m,[call,reply]);
  assert.deepEqual([result.reply.name,result.reply.role,result.reply.evidence],['','교통기획과장',['request','reply']]);
  assert.ok(!result.request?.name);
  const rankMeeting = {title:'경제환경위원회', members:[], staffRoster:[{name:'이종빈',role:'푸른도시사업소장',
    source:'https://www.sncouncil.go.kr/record/recordView.do?key=1234abcd'}]};
  const rankCall = label('q','그러면 이종빈 부른 도시 사업소장님 나오셔서 종갈 설명해 주시기 바랍니다.',20,25);
  const rankReply = label('a','안녕하십니까. 부른 도시 사업소장 이종빈입니다.',26,30);
  const rankResult = attribute(rankMeeting,[rankCall,rankReply]).a;
  assert.deepEqual([rankResult?.name,rankResult?.role],['이종빈','푸른도시사업소장']);
  const damaged = row => ({...row, text:row.text.replace('부른 도시','다른 도서'), rawText:row.rawText.replace('부른 도시','다른 도서')});
  const rankOnly = attribute(rankMeeting,[damaged(rankCall),damaged(rankReply)]).a;
  assert.deepEqual([rankOnly?.name,rankOnly?.role],['','사업소장']);
  assert.ok(!attribute({...rankMeeting,staffRoster:[]},[rankCall,rankReply]).a);
  assert.ok(!attribute({...m,date:'2026-04-17'},[call,reply]).reply);
  const permittedRole = (first,second) => attribute(m,[first,second]).reply?.method === result.reply.method;
  for (const other of [call.text.replace('양윤기','양윤희'),call.text.replace('교통기획과장','도시계획과장'),
                       '교통기획과장님을 소개해 드리겠습니다.',call.text.replace('집행부 기원을 듣겠습니다','간부를 소개하겠습니다')]) {
    assert.equal(permittedRole(label('other',other,266.55,272.95),reply),false);
  }
  assert.equal(permittedRole(call,{...reply,flags:['overlap']}),false);
  assert.equal(permittedRole(call,{...reply,rawText:'교통계획과장입니다.'}),false);
  assert.equal(permittedRole(call,label('reply',reply.text,288,291)),false);
}

{
  const m = {title:'제2차 본회의', members:['박기범','강상태','민영미']};
  const iso = t => new Date(Date.UTC(2026,8,7) + t * 1000).toISOString();
  const spoken = (id, words, start, end) => ({...cue(id,words,start,end,['name'],iso(start)), rawText:words});
  const call = spoken('call','그러면 박기범 의원님 나오셔서 발언해 주시기 바랍니다.',171.12,175.28);
  const greeting = '존경하는 92만 성남시민 여러분, 강상태 의장님과 선배 동료 의원 여러분, 그리고 공기자와 언론인 여러분, 유래복정 양지산성동지역구시위원 박기범입니다.';
  const reply = spoken('reply',greeting,200.05,211.61);
  const result = (rows, meta=m, gaps=[]) => attribute(meta,rows,[],gaps);
  assert.equal(result([call,reply]).reply.name,'박기범');
  assert.deepEqual(result([call,reply]).reply.evidence,['call','reply']);
  assert.ok(!result([call,reply]).call?.name);
  for (const replacement of [
    '민영미입니다.', '박기범입니다. 이상입니다.', '박기범님입니다.',
  ]) {
    const changed=spoken('reply',greeting.replace('박기범입니다.',replacement),200.05,211.61);
    assert.equal(result([call,changed]).reply?.name,undefined);
  }
  for (const text of [greeting.replace('강상태 의장님과','강상태가 말한'),
                       greeting.replace('언론인 여러분','대신 소개하는 여러분'),
                       greeting.replace('산성동','강상태동'), '“'+greeting+'”']) {
    assert.equal(result([call,spoken('reply',text,200.05,211.61)]).reply?.name,undefined);
  }
  const interrupted=spoken('other','잠시 정정하겠습니다.',181,184);
  for (const rows of [[reply],[call,interrupted,reply],[call,{...reply,observedAt:iso(199)}],
                      [call,{...reply,rawText:greeting.replace('박기범','박기봉')}],
                      [call,{...reply,flags:['overlap']}],[{...call,flags:['low_confidence']},reply]]) {
    assert.equal(result(rows).reply?.name,undefined);
  }
  assert.equal(result([call,reply],{...m,title:'제1차 도시건설위원회'}).reply?.name,undefined);
  assert.equal(result([call,reply],m,[{start:iso(180),end:iso(190)}]).reply?.name,undefined);
  assert.equal(result([call,reply],{...m,staffRoster:[{name:'박기범'}]}).reply?.name,undefined);
}

{
  const current={id:'5404',title:'제1차 경제환경위원회',date:'2026-07-08',members:[]};
  const words='동료 의원 여러분 반갑습니다. 이번 제10대 전반기 경제환경위원회 위원장으로 선출된 안광환입니다.';
  const intro={...cue('chair',words,21.37,29.18,['name']),rawText:words};
  const get=(m=current,c=intro,rows=[c])=>attribute(m,rows).chair;
  assert.deepEqual([get().name,get().role,get().registeredVodReference.position],['안광환','위원장',7229]);
  for (const meta of [{date:'2026-07-07'},{date:'2026-07-32'},{date:'2028-07-01'},{date:''},
                      {title:'경제환경위원회와 문화복지체육위원회'}, {members:['다른이']},
                      {staffRoster:[{name:'안광환',role:'사무과장'}]}])
    assert.equal(get({...current,...meta})?.registeredVodReference,undefined);
  for (const wrong of [words.replace('안광환','안광한'),words.replace('전반기','후반기'),
                        words.replace('경제환경','문화복지체육'),words+'이라고 그가 말했습니다.'])
    assert.equal(get(current,{...intro,text:wrong,rawText:wrong})?.registeredVodReference,undefined);
  assert.equal(get(current,{...intro,rawText:words.replace('안광환','안광한')})?.registeredVodReference,undefined);
  assert.equal(get(current,{...intro,flags:['overlap']})?.registeredVodReference,undefined);
  assert.equal(get(current,intro,[intro,cue('mixed','그게 맞습니까?',24,31)])?.registeredVodReference,undefined);
}
{
  const session={id:'5415',title:'제312회 제1차 의회운영위원회',members:[],staffRoster:[]};
  const callText='최필규 의회 사무과장님 나오셔서 보고해 주시기 바랍니다.';
  const introText='안녕하십니까. 의회 사무과장 최필규입니다.';
  const call={...cue('call',callText,16.52,20),rawText:callText};
  const intro={...cue('intro',introText,21.68,24.68),rawText:introText};
  const result=(rows)=>attribute(session,rows).intro;
  assert.equal(result([call,intro])?.role,'의회사무과장');
  assert.equal(result([call,intro]).name,'');
  assert.deepEqual(result([call,intro]).evidence,['call','intro']);
  for (const changed of [
    {...call,flags:['low_confidence']},
    {...call,rawText:'미확인 호명'},
    {...call,start:1,end:2},
    {...call,text:callText.replace('최필규','강동혁'),rawText:callText.replace('최필규','강동혁')},
  ]) assert.equal(result([changed,intro]),undefined);
  assert.equal(result([call,{...intro,flags:['overlap']}]),undefined);
  assert.equal(result([call,{...intro,text:'“'+introText+'”',rawText:'“'+introText+'”'}]),undefined);
  assert.equal(result([call,intro,cue('over','다른 발언이 있습니다.',22,25)]),undefined);
}
{
  const row={name:'류예지',role:'의회운영위원회 담당',officialRole:'주무관',roleBasis:'recorded-self-introduction',
    source:'https://www.sncouncil.go.kr/record/recordView.do?key=abc123',basis:'official-recorded-committee-contact',
    candidateOnly:true,committee:'의회운영위원회'};
  const current={id:'5480',title:'제313회 제1차 의회운영위원회',members:[],staffRoster:[row]};
  const rawText='안녕하십니까 의회 운영위원회 담당 류예지입니다.';
  const original={...cue('staff',rawText,27.79,31.89),rawText};
  const name=(meeting,utterance)=>attribute(meeting,[utterance]).staff?.name || '';
  assert.equal(name(current,original),'류예지');
  for (const changes of [{flags:['mixed']},{flags:['overlap']},{rawText:'다른 문장입니다.'},
                         {start:0,end:18},{text:'의회 운영위원회 담당 류예지입니다?'}])
    assert.equal(name(current,{...original,...changes}),'');
  assert.equal(name({...current,title:'도시건설위원회'},original),'');
  assert.equal(name({...current,staffRoster:[row,row]},original),'');
  assert.equal(name({...current,staffRoster:[{...row,source:'https://example.org/'}]},original),'');
  assert.equal(name({...current,members:['류예지']},original),'');
}

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


{
  const appClock=Date.parse('2026-11-25T01:00:00Z'), sessionId='a'.repeat(32);
  const base={policy:'same-session-1',sessionId}, chain={...base,anchorId:'voice1',previousId:'voice1'};
  const make=(id,start,text,extra={})=>({...cue(id,text,start,start+4,[],appClock+start*1000),rawText:text,...extra});
  const first=make('voice1',0,'서은경 의원입니다.',{audioAnchor:base});
  const next=make('voice2',4.25,'올해 사업 예산의 집행 내역을 살펴보았습니다.',{audioContinuation:chain});
  const third=make('voice3',8.5,'지난 분기에 쓴 금액도 함께 정리했습니다.',{audioContinuation:{...chain,previousId:'voice2'}});
  const match=(rows,m=meeting,observations=[],gaps=[])=>attribute(m,rows,observations,gaps);
  const byId=match([first,next,third]);
  assert.equal(byId.voice2?.name,'서은경'); assert.deepEqual(byId.voice2.evidence,['voice1','voice2']);
  assert.equal(byId.voice3?.name,'서은경'); assert.deepEqual(byId.voice3.evidence,['voice1','voice2','voice3']);
  assert.equal(match([first,{...next,observedAt:new Date(next.observedAt).toISOString()}]).voice2?.name,'서은경');
  const staff={...meeting,staffRoster:[{name:'차광승',role:'AI혁신국장',source:'https://www.sncouncil.go.kr/record/recordView.do?key=adec'}]};
  assert.equal(match([make('voice1',0,'안녕하십니까 AI 혁신국장 차광승입니다.',{audioAnchor:base}),next],staff).voice2?.name,'차광승');
  const office=make('office',0,'안녕하십니까 AI 혁신국장 차광승입니다.');
  assert.equal(match([office],staff).office?.name,'차광승');
  assert.notEqual(match([{...office,text:'안녕하십니까 IT 혁신국장 차광승입니다.'}],staff).office?.name,'차광승');
  for (const wrong of [
    {...first,audioAnchor:undefined},{...first,audioAnchor:{...base,sessionId:'a'}},
    {...first,audioAnchor:{...base,name:'서은경'}},{...first,rawText:'박가나 의원입니다.'},
    make('voice1',0,'서은경 의원님 질의해 주십시오.',{audioAnchor:base}),
    make('voice1',0,'“서은경 의원입니다.”라고 소개했습니다.',{audioAnchor:base}),
    make('voice1',0,'의원 서은경입니다. 조우현 의원입니다.',{audioAnchor:base}),
    {...first,flags:['overlap']},{...first,observedAt:null}
  ]) assert.doesNotMatch(match([wrong,next]).voice2?.method || '',/연속 음성/);
  for (const wrong of [
    {...next,start:4.5},{...next,start:3.8},{...next,observedAt:next.observedAt+2000},
    {...next,audioContinuation:{...chain,previousId:'stale'}},{...next,audioContinuation:{...chain,anchorId:'stale'}},
    {...next,audioContinuation:{...chain,sessionId:'b'.repeat(32)}},{...next,audioContinuation:{...chain,policy:'test'}},
    {...next,audioContinuation:{...chain,name:'서은경'}},{...next,flags:['low_confidence']},
    make('voice2',4.25,'네, 맞습니다.',{audioContinuation:chain}),
    make('voice2',4.25,'조우현 의원님께서 질문을 하셨습니다.',{audioContinuation:chain})
  ]) assert.doesNotMatch(match([first,wrong,third]).voice3?.method || '',/연속 음성/);
  assert.doesNotMatch(match([first,{...next,audioContinuation:undefined},third]).voice3?.method || '',/연속 음성/);
  assert.doesNotMatch(match([first,next],meeting,[],[{start:appClock+4050,end:appClock+4200}]).voice2?.method || '',/연속 음성/);
  const shortBase={...base,policy:'same-session-2'},shortChain={...chain,policy:'same-session-2'};
  const shortAnchor={...first,end:2.54,audioAnchor:shortBase};
  const shortCue={...make('voice2',2.54,'여기 사진 한 장이 있습니다.'),end:5.1,audioContinuation:shortChain};
  assert.equal(match([shortAnchor,shortCue]).voice2?.name,'서은경');
  assert.equal(match([shortAnchor,{...shortCue,audioContinuation:chain}]).voice2,undefined);
  assert.equal(match([shortAnchor,{...shortCue,text:'네, 잘 알겠습니다 감사합니다.',rawText:'네, 잘 알겠습니다 감사합니다.'}]).voice2,undefined);
  assert.equal(match([shortAnchor,{...shortCue,end:4.9}]).voice2,undefined);
  const aged=[first];
  for (let i=1;i<=30;i++) aged.push(make('v'+i,4*i,next.text,{audioContinuation:{...chain,previousId:aged.at(-1).id}}));
  assert.match(match(aged).v29.method,/연속 음성/); assert.doesNotMatch(match(aged).v30?.method || '',/연속 음성/);
}

const browserWindow={CouncilSpeakerReview:require('../dist/speaker-review.js'),CouncilNameplateReview:require('../dist/nameplate-review.js'),CouncilSpeakerPolicy:require('../dist/speaker-policy.js')};
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

// Actual 2853 short response after a direct call; the addressee alone cannot identify this voice.
const call=cue('1795584783050047742','\uC870 \uC758\uC6D0\uB2D8 \uC218\uACE0\uD558\uC168\uC2B5\uB2C8\uB2E4. \uB610 \uC9C8\uC758\uD558\uC2E4 \uC758\uC6D0\uB2D8. \uC815\uC5F0\uD654 \uC758\uC6D0\uB2D8 \uC9C8\uC758\uD574 \uC8FC\uC2DC\uACE0.',617.131,622.231);
const ack=cue('1795584783050047743','\uB124, \uACFC\uC7A5\uB2D8.',622.231,624.231);
result=attribute(meeting,[call,ack]);
assert.equal(result[ack.id],undefined,'a brief acknowledgement cannot establish the next speaker');

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
assert.equal(result[namedStaff.id]?.name,'');
assert.equal(result[namedStaff.id]?.role,'환경보건국장');

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
assert.equal(attribute(meeting,[citeCall,cite])[cite.id],undefined);
const badCall=cue('bad-call','\uC815\uC5F0\uD654 \uC758\uC6D0\uB2D8 \uC9C8\uC758\uD558\uC2DC\uB7EC.',1548.231,1553.561,['name']);
const badAck=cue('bad-ack','\uACFC\uC7A5\uB2D8 \uACE0\uC0DD \uB9CE\uC73C\uC2ED\uB2C8\uB2E4.',1554.821,1557.331);
assert.equal(attribute(meeting,[badCall,badAck])[badAck.id],undefined);
const corruptedCall=cue('1795584783050047937','\uB124. \uC218\uACE0\uD558\uC168\uC2B5\uB2C8\uB2E4. \uB610 \uC9C0\uB9AC\uD558\uC2DC\uB77C\uC694. \uC11C\uC740\uACBD\uC774 \uD615\uB2D8.',1548.231,1553.561);
const corruptedAck=cue('1795584783050047938','\uACFC\uC7A5\uB2D8 \uACE0\uC0DD \uB9CE\uC73C\uC2ED\uB2C8\uB2E4.',1554.821,1557.331);
assert.equal(attribute(meeting,[corruptedCall,corruptedAck])[corruptedAck.id],undefined,'a corrupted name call is not repaired into an identity');
assert.equal(attribute(meeting,[observedCall,observedAck],[],[{start:'2026-11-25T07:00:02.000Z',end:'2026-11-25T07:00:04.000Z'}])[observedAck.id],undefined,'unknown cue timestamps with archive gaps must abstain');

{
  const invite=cue('invite','예, 수고하셨습니다. 또 질의하시는 의원님 없으시죠?',7252.133,7255.743,['name'],'2026-11-25T07:28:44.527Z');
  const self=cue('self','네, 서은경입니다.',7256.793,7259.533,[],'2026-11-25T07:28:49.187Z');
  for(const asNumber of [false,true]){
    const rows=[invite,self].map(c=>asNumber?{...c,observedAt:Date.parse(c.observedAt)}:c);
    assert.equal(attribute(meeting,rows).self?.name,'서은경');
    assert.equal(attribute(meeting,rows,[],[{start:'2026-11-25T07:28:47Z',end:'2026-11-25T07:28:49Z'}]).self?.name,undefined);
    assert.notEqual(attribute(meeting,[{...rows[0],text:'그 발언을 하신 분은 누구십니까?'},rows[1]]).self?.name,'서은경');
    assert.notEqual(attribute(meeting,[rows[0],{...rows[1],text:'네, 서은경입니다라고 답했습니다.'}]).self?.name,'서은경');
  }
}
// The exported result is an ordinary object; values have only the public contract fields.
assert.equal(Object.getPrototypeOf(result),Object.prototype);
for (const value of Object.values(result)) assert.deepEqual(Object.keys(value).sort(),['confidence','evidence','method','name','role']);
// Archived 5398: original production-style ASR knows the whole name after a district phrase.
{
  const roster={id:'5398',title:'본회의',members:['고병용','김보석'],staffRoster:[]};
  const original='상대원 1지 3등을 지역구로 하는 무소속 고병용 의원입니다.';
  const input=(text,flags=[])=>({...cue('district-self',text,392.42,400.42,flags,'2026-04-22T05:06:32.420Z'),rawText:text});
  const guess=(text,selected=roster,extra={})=>attribute(selected,[{...input(text),...extra}])['district-self']?.name || '';
  assert.equal(guess(original),'고병용');
  assert.equal(guess('저는 서현1동과 서현2동을 지역구로 둔 고병용 의원입니다.'),'고병용');
  assert.equal(guess('안녕하십니까. 저는 성남시 중원구 상대원2동을 지역구로 하는 고병용 의원입니다.'),'고병용');
  assert.equal(guess('삼평동, 백현동을 지역구로 둔 더불어 민주당 고병용 위원입니다.'),'고병용');
  for(const text of [
    '다음은 '+original, '소개할 분은 '+original,
    '상대원 1지 3등을 지역구로 하는 무소속 고병용 의원입니다라고 소개했습니다.',
    '“'+original+'”', original+' 다음 발언자를 소개합니다.',original.replace('고병용','고병영'),
    '오늘 이 회의에서 발언하게 될 무소속 고병용 의원입니다.',
    original.replace('상대원 1지 3등','김보석 의원의 자녀'), original.replace('상대원 1지 3등','상대원 4동'),
    original.replace('상대원 1지 3등','그친구'), original.replace('무소속','발언할'),
  ]) assert.equal(guess(text),'',text);
  assert.equal(guess(original,{...roster,members:['고병용','고병용']}),'');
  assert.equal(guess(original,{...roster,staffRoster:[{name:'고병용',role:'과장'}]}),'');
  assert.equal(guess(original,roster,{flags:['mixed']}),'');
  assert.equal(guess(original,roster,{rawText:original.replace('고병용','고병영')}),'');
  const observation={capturedAt:'2026-04-22T05:06:34.420Z',matchedMembers:['김보석']};
  assert.equal(attribute(roster,[input(original)],[observation])['district-self']?.name || '','');
}
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
  assert.equal(out.mixed,undefined); assert.ok(!out['4435']?.name,'a mixed turn ends the named floor');
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

// Reconstructed boundaries from 2026-10-13 official minutes. Overlap, dropped
// punctuation, split greetings and acoustic stamps below are synthetic.
{
  const roster = {title:'경제환경위원회', members:[], staffRoster:[{
    name:'장미라', role:'자원순환과장', source:'https://www.sncouncil.go.kr/record/recordView.do?key=1234abcd'
  }]};
  const make = (id,text,start,end) => ({
    ...cue(id,text,start,end,[],new Date(Date.UTC(2026,9,13,6)+start*1000).toISOString()),rawText:text
  });
  const lead = '2026년도 제4회 추가경정예산안 및 2025회계연도 결산 승인안 설명에 앞서 환경보건국 간부 공무원을 소개해 드리겠습니다.';
  const firstItem = '유성희 환경정책과장입니다.';
  const announcement = make('staff-list',lead,0,4);
  const first = make('staff-first',firstItem,3.97,8);
  const roleFirst = make('staff-intro','자원순환과장 장미라입니다.',8,12);
  assert.equal(attribute(roster,[announcement,first,roleFirst])[roleFirst.id],undefined,
    '30ms caption overlap inside a list does not turn a named listed person into its speaker');
  const droppedPeriod = make('staff-list-merged',lead.slice(0,-1)+' '+firstItem,0,8);
  assert.equal(attribute(roster,[droppedPeriod,roleFirst])[roleFirst.id],undefined,
    'a merged list announcement still blocks following entries when ASR drops the separating period');

  const list = [announcement,make('staff-1',firstItem,4,8),
    make('staff-2','신인섭 고용과장입니다.',8,12),make('staff-3','정진찬 지역경제상권과장입니다.',12,16)];
  const greeting = make('staff-split-greeting','안녕하십니까 자원순환과장',16,20);
  const name = make('staff-split-name','장미라입니다.',20,24);
  assert.equal(attribute(roster,[...list,greeting,name])[name.id],undefined,
    'a greeting and bare name split inside a longer list must not bypass its veto');
  const call = make('staff-call','장미라 자원순환과장님 나오셔서 일괄 세부 설명 해 주시기 바랍니다.',12,16);
  assert.equal(attribute(roster,[call,greeting,name])[name.id]?.name,'장미라',
    'a clean separate introductory turn can still match a split staff introduction');

  const proof = {policy:'same-session-2',sessionId:'0'.repeat(32)};
  const anchor = {...make('staff-stamp','장미라 자원순환과장입니다.',8,12),audioAnchor:proof};
  const continuation = {...make('staff-cont','오늘 추가경정예산안의 전체 사업 내용을 설명드리겠습니다.',12,16),
    audioContinuation:{...proof,anchorId:anchor.id,previousId:anchor.id}};
  const denied = attribute(roster,[announcement,first,anchor,continuation]);
  assert.equal(denied[anchor.id],undefined,'a listed name with overlapped context cannot seed acoustic identification');
  assert.equal(denied[continuation.id],undefined,'the listed name must not carry to the next speaking turn');
  const accepted = attribute(roster,[anchor,continuation]);
  assert.equal(accepted[anchor.id]?.name,'장미라');
  assert.equal(accepted[continuation.id]?.name,'장미라');
}
