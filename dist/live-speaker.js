/* Conservative live speaker suggestions. Every result is a review lead, never a verified identity. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./speaker-review.js'), require('./nameplate-review.js'));
  } else root.CouncilLiveSpeaker = factory(root.CouncilSpeakerReview, root.CouncilNameplateReview);
})(typeof window === 'undefined' ? globalThis : window, function (speakerReview, nameplateReview) {
  'use strict';
  const UNCERTAIN = new Set(['low_confidence','severe_uncertainty','repetition','segment_review']);
  const ANSWER_TO_OTHER = /(?:의원님?\s*질의(?:에\s*대해|에\s*대한|하신\s*내용)|(?:질의|질문)\s*답변|답변(?:을|은|드리)|답해\s*드리)/;
  const OBSERVED_MISHEARD_CALL = /지리하시러/;
  const ROLE_SUFFIXES = ['과장','국장','팀장','부장','소장','센터장','담당관','주무관'];
  const INTRO_TITLES = /(?:센터장|담당관|주무관|과장|국장|팀장|부장|소장|위원장|의원|위원)(?:\s+[가-힣]{2,4})?\s*입니다/g;
  const QUOTED = /(?:라고\s*(?:소개|말씀|하|했)|라며\s*(?:소개|말씀|하|했)|라고\s*전했)/;
  const CONTINUATION = /^(?:그리고\s*(?:저는|제가)|또\s*(?:저는|제가)|추가로\s*(?:말씀드리면|제가)|이어서\s*(?:제가|말씀드리면))/;
  const TERMINAL = /[.!?。！？]$/;
  const ROLE_MEDIUM = '의원';
  const ADDRESSED_TITLE = /(?:과장|국장|팀장|부장|소장|주무관)님/;
  const CLEAR_QUESTION = /(?:아시겠어요|어떻게\s*생각하세요|대답을\s*안\s*하시네)/;
  const ANSWER_SELF = /(?=.*의원님께서)(?=.*제가)(?=.*(?:대답드리|답변드리))/;
  function clean(value) { return String(value ?? '').replace(/\s+/g,' ').trim(); }
  function idOf(cue) { return cue && cue.id != null ? String(cue.id) : ''; }
  function safeId(id) { return !!id && !['__proto__','constructor','prototype'].includes(id); }
  function textOf(cue) { return clean(cue?.text); }
  function uncertain(cue) { return !!cue?.rejected || (Array.isArray(cue?.flags) && cue.flags.some(flag=>UNCERTAIN.has(flag))) || (textOf(cue).match(INTRO_TITLES) || []).length>1; }
  function displayCandidate(cue,candidate) {
    if (!candidate || uncertain(cue)) return undefined;
    if (!candidate.name && /직책 자기소개/.test(candidate.method || '')) {
      const role = ROLE_SUFFIXES.find(suffix=>clean(candidate.role).endsWith(suffix));
      return role ? {...candidate,role} : undefined;
    }
    return candidate;
  }
  function number(cue,key) { const n=Number(cue?.[key]); return Number.isFinite(n)?n:NaN; }
  function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
  function orderedCues(cues) {
    return cues.map((cue,index)=>({cue,index,id:idOf(cue),start:number(cue,'start')})).filter(row=>safeId(row.id))
      .sort((a,b)=>Number.isFinite(a.start)&&Number.isFinite(b.start)?a.start-b.start||a.index-b.index:a.index-b.index);
  }
  function gapTouches(a,b,gaps) {
    const as=Date.parse(a?.observedAt), bs=Date.parse(b?.observedAt);
    if (!Number.isFinite(as)||!Number.isFinite(bs)) return false;
    const ae=as+Math.max(0,number(a,'end')-number(a,'start'))*1000;
    const be=bs+Math.max(0,number(b,'end')-number(b,'start'))*1000;
    return gaps.some(g=>{const s=Date.parse(g?.start),e=g?.end==null?Infinity:Date.parse(g.end);return Number.isFinite(s)&&(e===Infinity||Number.isFinite(e))&&s<Math.max(ae,be)&&e>Math.min(as,bs);});
  }
  function hasOtherMember(cue,meeting,name) {
    const text=textOf(cue);
    return (meeting.members||[]).map(clean).some(other=>other && other!==name && text.includes(other));
  }
  function staffIntro(cue) {
    const text=textOf(cue);
    if (!text||QUOTED.test(text)) return null;
    const sentence=clean(text.split(/[.!?。！？]/,1)[0]);
    const copula='입니다';
    if (sentence.length>30||!sentence.endsWith(copula)) return null;
    let phrase=sentence.slice(0,-copula.length).trim();
    const firstPerson='저는';
    if (phrase.startsWith(firstPerson+' ')) phrase=phrase.slice(firstPerson.length).trim();
    const words=phrase.split(/\s+/),title=words.at(-1)||'';
    if (words.length>3||words.some(word=>!/^[가-힣]{1,12}$/.test(word))||!ROLE_SUFFIXES.some(suffix=>title.endsWith(suffix))) return null;
    if (/(?:제가|그분|저분|그쪽|저쪽|우리|저희|말씀|담당자는|사람은|분은|분이|현재는|당시에는)/.test(phrase)||words.slice(0,-1).some(word=>/[은는이가을를]$/.test(word))) return null;
    return {name:'',role:phrase,confidence:'medium',method:'직책 자기소개 (원음 확인 필요)',evidence:[idOf(cue)]};
  }
  function rosterStaffIntro(meeting, cue) {
    if (uncertain(cue)) return null;
    const text = textOf(cue);
    if (QUOTED.test(text)) return null;
    const match = text.match(/^(?:(?:안녕하십니까|안녕하세요|네|예|저는)[,.!?\s]+){1,3}([가-힣\s]{1,24})\s+([가-힣]{2,4})입니다[.!?\s]*$/);
    if (!match) return null;
    const spokenRole = match[1].replace(/\s/g,''), name = match[2];
    if ((meeting.members || []).map(clean).includes(name)) return null;
    const roster = Array.isArray(meeting.staffRoster) ? meeting.staffRoster : [];
    const matches = roster.filter(row => {
      const role = clean(row?.role).replace(/\s/g,'');
      const oneSubstitution = spokenRole.endsWith('사업소장') && role.endsWith('사업소장') && role.length === spokenRole.length &&
        [...role].filter((letter,index) => letter !== spokenRole[index]).length === 1;
      return row && clean(row.name) === name && row.source && (role === spokenRole || oneSubstitution || (role.startsWith('성남문화재단') && role.slice('성남문화재단'.length) === spokenRole));
    });
    if (matches.length !== 1 || roster.filter(row => clean(row?.name) === name).length !== 1) return null;
    return {name,role:clean(matches[0].role),confidence:'low',method:'명시적 자기소개와 공식 명부 직책·성명 대조 (원음 확인 필요)',evidence:[idOf(cue)]};
  }
  function rosterAppointmentAnswer(meeting, cue, previous, candidate, gaps) {
    if (!previous || uncertain(cue) || uncertain(previous) || cue.flags?.includes('name') || QUOTED.test(textOf(cue))) return null;
    const q = textOf(previous), text = textOf(cue);
    const question = q.match(/^(사업소장|센터장|담당관|주무관|과장|국장|팀장|부장|소장)님\s*(?:그\s*자리에\s+오신\s*지\s+얼마나\s+되셨어요|언제\s+부임하셨습니까)[?？]$/);
    const answer = text.match(/^(?:지난\s*)?(\d{1,2})월\s*(\d{1,2})일(?:날|\s*자로)?\s*(?:발령받았습니다|부임했습니다)[.!]?$/);
    if (!question || !answer || !candidate || candidate.name || candidate.role !== question[1]) return null;
    const delta = number(cue,'start') - number(previous,'end');
    if (!Number.isFinite(delta) || delta < 0 || delta > 5 || gapTouches(previous,cue,gaps)) return null;
    if (gaps.length && (!Number.isFinite(Date.parse(previous.observedAt)) || !Number.isFinite(Date.parse(cue.observedAt)))) return null;
    const date = cue.observedAt && new Date(cue.observedAt);
    if (!date || !Number.isFinite(date.getTime())) return null;
    const meetingDay = new Date(date.getTime() + 9 * 3600000).toISOString().slice(0,10);
    const expected = `${meetingDay.slice(0,4)}-${answer[1].padStart(2,'0')}-${answer[2].padStart(2,'0')}`;
    if (expected > meetingDay) return null;
    const roster = Array.isArray(meeting.staffRoster) ? meeting.staffRoster : [];
    const matches = roster.filter(row => row?.source && clean(row.role).replace(/\s/g,'').endsWith(question[1]) && row.appointedOn === expected);
    if (matches.length !== 1 || roster.filter(row => clean(row?.name) === clean(matches[0].name)).length !== 1) return null;
    return {name:clean(matches[0].name),role:clean(matches[0].role),confidence:'low',method:'직전 직책 질문·발령 답변과 공식 명부 인사일 대조 (원음 확인 필요)',evidence:[idOf(previous),idOf(cue)]};
  }
  function memberIntro(cue,meeting,previous) {
    const text=textOf(cue);
    if (!text||QUOTED.test(text)) return null;
    for (const raw of Array.isArray(meeting.members)?meeting.members:[]) {
      const name=clean(raw);
      if (!name) continue;
      const re=new RegExp('(?:^|[.!?,\\s])(?:저는\\s*)?'+escapeRegExp(name)+'\\s*의원입니다(?=[.!?,\\s]|$)');
      if (!re.test(text)) continue;
      const evidence=[idOf(cue)];
      const call=new RegExp(escapeRegExp(name)+'\\s*의원님?\\s*(?:질의|질문|발언|말씀)');
      if (previous && call.test(textOf(previous))) evidence.unshift(idOf(previous));
      return {name,role:ROLE_MEDIUM,confidence:'medium',method:evidence.length>1?'직접 호명 뒤 동일 의원 자기소개 (원음 확인 필요)':'명부 의원의 명시적 자기소개 (원음 확인 필요)',evidence};
    }
    return null;
  }
  function addressedMemberIntro(cue, meeting) {
    const text=textOf(cue);
    if (uncertain(cue) || cue.flags?.includes('name') || QUOTED.test(text)) return null;
    const match=text.match(/^(?:(?:네|예|안녕하세요|안녕하십니까)[,.!?\s]+){0,2}(?:과장|국장|소장|팀장|센터장|담당관)님[,.\s]+([가-힣]{2,4})입니다[.!?](?:\s|$)/);
    if (!match) return null;
    const name=match[1], members=Array.isArray(meeting.members) ? meeting.members.map(clean) : [];
    if (members.filter(value=>value===name).length!==1 || (meeting.staffRoster || []).some(row=>clean(row?.name)===name)) return null;
    const rest=text.slice(match[0].length);
    if (/(?:의원|위원|과장|국장|소장|팀장|센터장|담당관)\s*[가-힣]{2,4}입니다|[가-힣]{2,4}\s*(?:의원|위원|과장|국장|소장)입니다|라고\s*(?:말|소개|했)/.test(rest)) return null;
    return {name,role:'의원',confidence:'low',method:'직책 호칭 뒤 이름 자기소개와 회의 의원 명부 대조 (원음 확인 필요)',evidence:[idOf(cue)]};
  }
  function calledMemberIntro(cue, previous, meeting, gaps) {
    if (!previous || uncertain(cue) || uncertain(previous)) return null;
    const text=textOf(cue), call=textOf(previous);
    if (QUOTED.test(text) || QUOTED.test(call)) return null;
    const intro=text.match(/^(?:(?:네|예|안녕하세요|안녕하십니까|저는)[,.!?\s]+){0,3}([가-힣]{2,4})입니다[.!?\s]*$/);
    if (!intro) return null;
    const name=intro[1], members=Array.isArray(meeting.members) ? meeting.members.map(clean) : [];
    if (members.filter(value=>value===name).length!==1 || (meeting.staffRoster || []).some(row=>clean(row?.name)===name)) return null;
    const callPattern=new RegExp('^(?:(?:네|예|다음은)[,.!?\\s]+){0,2}'+escapeRegExp(name)+'\\s*(?:의원|위원)님[,\\s]*(?:말씀|질의|질문|발언)\\s*(?:해\\s*(?:주십시오|주시기\\s*바랍니다|주세요)|하시기\\s*바랍니다)[.!?\\s]*$');
    const delta=number(cue,'start')-number(previous,'end');
    if (!callPattern.test(call) || !Number.isFinite(delta) || delta<0 || delta>3 || gapTouches(previous,cue,gaps)) return null;
    if (gaps.length && (!Number.isFinite(Date.parse(previous.observedAt)) || !Number.isFinite(Date.parse(cue.observedAt)))) return null;
    return {name,role:'의원',confidence:'low',method:'명부 의원 호명 직후 같은 이름 자기소개 (원음 확인 필요)',evidence:[idOf(previous),idOf(cue)]};
  }
  function roleTurn(cue,previous,byId,gaps,meeting) {
    const text=textOf(cue);
    if (!text||uncertain(cue)||hasOtherMember(cue,meeting,'')) return null;
    if (ADDRESSED_TITLE.test(text)&&CLEAR_QUESTION.test(text)) {
      return {name:'',role:'질의자',confidence:'low',method:'직책을 호칭하고 질문한 cue (실명 미확인)',evidence:[idOf(cue)]};
    }
    if (!ANSWER_SELF.test(text)) return null;
    if (previous&&ADDRESSED_TITLE.test(textOf(previous))&&CLEAR_QUESTION.test(textOf(previous))) {
      const delta=number(cue,'start')-number(previous,'end');
      if (!uncertain(previous)&&Number.isFinite(delta)&&delta>=0&&delta<=5&&!gapTouches(previous,cue,gaps)&&
          (!gaps.length||Number.isFinite(Date.parse(previous.observedAt))&&Number.isFinite(Date.parse(cue.observedAt)))) {
        const role=(textOf(previous).match(ADDRESSED_TITLE)||[])[0]?.replace(/님$/,'');
        if (role) return {name:'',role,confidence:'low',method:'직책을 호칭한 질문 뒤 바로 이어진 답변 cue (실명 미확인)',evidence:[idOf(previous),idOf(cue)]};
      }
    }
    return {name:'',role:'답변자',confidence:'low',method:'의원님의 말씀을 지칭하고 제가 답변하는 cue (실명 미확인)',evidence:[idOf(cue)]};
  }
  function validate(candidate,id,byId,ordered,gaps,meeting) {
    const cue=byId.get(id);
    if (!candidate||!cue||uncertain(cue)||!textOf(cue)) return null;
    const evidence=[...new Set((candidate.evidence||[]).map(String))].filter(key=>byId.has(key));
    if (!evidence.includes(id)) evidence.push(id);
    if (evidence.some(key=>uncertain(byId.get(key)))) return null;
    const name=clean(candidate.name);
    if (evidence.length>1) {
      const source=byId.get(evidence[0]);
      const delta=number(cue,'start')-number(source,'end');
      const ix=ordered.findIndex(row=>row.id===id);
      if (!source||ix<1||ordered[ix-1].id!==evidence[0]||!Number.isFinite(delta)||delta<0||delta>5||gapTouches(source,cue,gaps)) return null;
      if (gaps.length && (!Number.isFinite(Date.parse(source.observedAt))||!Number.isFinite(Date.parse(cue.observedAt)))) return null;
      if (ANSWER_TO_OTHER.test(textOf(source))) return null;
      if (name && hasOtherMember(cue,meeting,name) && !OBSERVED_MISHEARD_CALL.test(textOf(source))) return null;
    }
    else if (name && hasOtherMember(cue,meeting,name)) return null;
    return {name,role:clean(candidate.role),confidence:['high','medium'].includes(candidate.confidence)?candidate.confidence:'low',method:clean(candidate.method),evidence};
  }
  function visibleNames(meeting,cues,observations,gaps) {
    if (!nameplateReview?.observations||!Array.isArray(observations)||!observations.length) return new Map();
    try {
      const rows=nameplateReview.observations(meeting,{cues,gaps},{meetingId:String(meeting.id),observations});
      return new Map(rows.filter(row=>row.cueId&&row.names?.length===1).map(row=>[String(row.cueId),row.names[0]]));
    } catch (_) { return new Map(); }
  }
  // A roster name and an audible question/answer are separate evidence. A seat in
  // a split screen can corroborate the questioner, but never identifies a reply.
  const SELF_NAME = /^(?:(?:네|예|안녕하십니까|저는|[가-힣]{1,8}님)[,.!?\s]+){0,3}([가-힣]{2,4})\s*(?:의원|위원)입니다(?:[.!,?\s]|$)/;
  const TITLED = /(센터장|담당관|주무관|과장|국장|팀장|부장|소장)님/g;
  const QUESTION = /(?:아닙니까|맞습니까|있습니까|없습니까|아시나요|아십니까|인가요|아닌가요|했나요|되나요|되셨어요|계시죠|지요|이죠|신가요|주실래요|(?:과장|국장|소장|팀장)님이세요)[?？.\s]*$/;
  const EXPLICIT_QUESTION = /(?:습니까|입니까|딥니까|아시나요|아닌가요|했나요|되나요|있나요|없나요|건가요|거예요|되셨어요|신가요|아니에요|어떠세요)[?？]$|(?:언제|어디|어떻|어떠|어떻게|왜|뭐가|무엇|얼마|누가|몇|어느).{0,65}(?:어요|아요|해요|돼요|세요)[?？]$/;
  const AUDIT_QUESTION = /(?:질의|질문)(?:를|을)?\s*드리겠습니다[.\s]*$|^(?:네[,.]?\s*)?제가\s*(?:여쭤볼게요|질문드리겠습니다|질의하겠습니다)[.!\s]/;
  const RESPONSE = /^(?:(?:네|예)[,.!\s]*(?:맞습니다|그렇습니다|들었습니다|알겠습니다|의원님|위원님|그 부분은)|(?:(?:최근|현재)(?:에는|는)\s*)?(?:있습니다|없습니다)[.!\s]*$|(?:지난|작년|올해|오는|내년|\d).{0,70}(?:발령받았습니다|부임했습니다|알고 있습니다)|그(?:건|것은)\s*아닙니다|아직까지는\s*(?:안|못)|저희(?:가|는|도)\s)/;
  const TRANSFER = /(?:다음.{0,16}(?:위원|의원)|(?:위원|의원)님.{0,12}질의해\s*주|보충\s*질의하실|질의를?\s*(?:마치|마치겠)|(?:정회|산회|감사\s*중지)를?\s*(?:선포|선언))/;
  function nearRosterName(a,b) {
    if (a.length!==3 || b.length!==3 || a[0]!==b[0] || a===b) return false;
    const one=a.normalize('NFD'),two=b.normalize('NFD');
    return one.length===two.length && [...one].filter((ch,i)=>ch!==two[i]).length===1;
  }
  function dialogueTurns(meeting,ordered,result,observations,gaps) {
    const roster=Array.isArray(meeting.members)?meeting.members:[];
    const plates=(Array.isArray(observations)?observations:[]).map(row=>({time:Date.parse(row.capturedAt),names:row.matchedMembers}))
      .filter(p=>Number.isFinite(p.time)&&Array.isArray(p.names)&&p.names.length).sort((a,b)=>a.time-b.time);
    const mixed = /[?？]\s*(?:네|예)[.,!\s]|[?？]\s*(?:그렇습니다|맞습니다)|(?:라고|라며)\s*(?:했|답|말|물)|위원장님|(?:있습니다|없습니다|했습니다|하겠습니다)[.]\s*(?:그런데\s*왜|저는요)/;
    let floor=null, lastQuestion=null, prior=null;
    for (const [idx,{cue,id}] of ordered.entries()) {
      const t=textOf(cue),at=Date.parse(cue.observedAt), start=number(cue,'start');
      if (!Number.isFinite(at)) { floor=null; lastQuestion=null; prior=null; continue; }
      const interrupted=prior && (start-number(prior,'end')>20 || start<number(prior,'start') || gapTouches(prior,cue,gaps));
      const delta=prior?start-number(prior,'end'):Infinity;
      if (interrupted || TRANSFER.test(t) || (floor && (at-floor.at>45*60000 || hasOtherMember(cue,meeting,floor.name)))) { floor=null; lastQuestion=null; }
      const previous=prior; prior=cue;
      if (uncertain(cue)||QUOTED.test(t)||mixed.test(t)||TRANSFER.test(t)) { lastQuestion=null; continue; }
      const spoken=t.match(SELF_NAME)?.[1];
      const beforeLast=lastQuestion; lastQuestion=null;
      // If ASR itself flags a staff name, use the spoken office title until the
      // official's name can be checked independently.
      const staff=t.match(/^(?:(?:네|예|안녕하십니까)[,.!\s]+)?([가-힣]{1,10}(?:과장|국장|팀장|소장|담당관|주무관))\s+[가-힣]{2,4}입니다(?:[.!,?\s]|$)/);
      if (staff && cue.flags?.includes('name')) {
        result[id]={name:'',role:staff[1],confidence:'low',method:'직책 자기소개. 인식한 실명은 확인 필요',evidence:[id]};
        continue;
      }
      if (spoken) {
        floor=null;
        const exact=roster.includes(spoken);
        const matches=exact?[spoken]:roster.filter(name=>nearRosterName(spoken,name));
        if (matches.length!==1) continue;
        const name=matches[0];
        let nextTurn=Infinity;
        for (let j=idx+1;j<ordered.length;j++) {
          const future=ordered[j].cue, when=Date.parse(future.observedAt);
          if (!Number.isFinite(when)||when-at>125000) break;
          if (TRANSFER.test(textOf(future))||SELF_NAME.test(textOf(future))) { nextTurn=when; break; }
        }
        // A seat alone cannot identify a voice. For a close phonetic match in an
        // explicit introduction, accept one close reading or two independent ones.
        const near=plates.filter(p=>Math.abs(p.time-at)<=125000 && p.time<nextTurn &&
          !gaps.some(g=>Date.parse(g.start)<Math.max(at,p.time) && (g.end==null || Date.parse(g.end)>Math.min(at,p.time))));
        const unique=near.every(p=>p.names.length===1&&p.names[0]===name);
        const repeated=unique&&near.length>1&&near.at(-1).time-near[0].time>=10000;
        const close=unique && near.some(p=>Math.abs(p.time-at)<=15000);
        if (exact || repeated || close) {
          floor={name,id,at};
          if (!result[id]) result[id]={name,role:'의원',confidence:exact?'medium':'low',method:exact?'명부 이름과 자기소개 일치':'자기소개에서 ‘'+spoken+'’로 인식. 위원회 명부와 '+(repeated?'인접 시간대 반복 판독':'자기소개 전후 15초 내 판독')+' 명패 ‘'+name+'’를 대조한 추정',evidence:[id]};
        } else if (!result[id]) result[id]={name:'',role:'의원',confidence:'low',method:'의원 자기소개. 인식한 이름과 명부가 달라 실명 보류',evidence:[id]};
        lastQuestion={id,role:'',intro:true};
        continue;
      }
      const titles=[...t.matchAll(TITLED)].map(match=>match[1]);
      const address=titles.at(-1)||'';
      const explicit=EXPLICIT_QUESTION.test(t);
      const question=explicit||QUESTION.test(t)||AUDIT_QUESTION.test(t);
      if (question && (explicit||address||floor) && !/(?:의원|위원)님/.test(t) && !/(?:라고|라며|냐고).{0,12}(?:묻|말|물)/.test(t)) {
        const seen=floor ? plates.filter(p=>p.time<=at && at-p.time<=150000 && p.time>=floor.at-15000) : [];
        const matches=seen.length && seen.every(p=>p.names.length===1&&p.names[0]===floor.name) &&
          (at-floor.at<=8*60000 || (seen.length>=2 && at-seen.at(-1).time<=45000));
        if (!result[id]||result[id].role==='질의자') {
          const named=Boolean(floor && matches && !hasOtherMember(cue,meeting,floor.name));
          result[id]={name:named?floor.name:'',role:named?'의원':'질의자',confidence:'low',
            method:named?'앞선 자기소개, 같은 이름의 명패 관측, 담당자에게 이어지는 질의 표현':'질문 종결 또는 담당자 호칭이 있는 질의 표현. 실명 미확인',
            evidence:named?[floor.id,id]:[id]};
        }
        lastQuestion={id,role:address,intro:false};
        continue;
      }
      if (!result[id] && previous && !interrupted && beforeLast && delta>=-0.05 && delta<=3 && RESPONSE.test(t) &&
          !t.includes('?') && (!beforeLast.intro || /(?:위원|의원)님/.test(t))) {
        result[id]={name:'',role:beforeLast.role||'답변자',confidence:'low',
          method:'직전 질의 또는 자기소개에 바로 이어진 응답 표현. 실명 미확인',evidence:[beforeLast.id,id]};
      }
    }
  }
  function attribute(meeting,cues,observations=[],gaps=[]) {
    const result={};
    if (!meeting||!Array.isArray(cues)||!speakerReview?.guesses) return result;
    const ordered=orderedCues(cues),byId=new Map();
    for (const row of ordered) { if (byId.has(row.id)) return result; byId.set(row.id,row.cue); }
    const safeGaps=Array.isArray(gaps)?gaps:[],raw=speakerReview.guesses(meeting,cues);
    const visible=visibleNames(meeting,cues,observations,safeGaps),ocrConflicts=new Set();
    for (let ix=0;ix<ordered.length;ix++) {
      const {id,cue}=ordered[ix],candidate=raw[id],previous=ix?ordered[ix-1].cue:null;
      const staff=staffIntro(cue);
      if (staff) { if (!uncertain(cue)) result[id]=displayCandidate(cue,staff); continue; }
      const intro=memberIntro(cue,meeting,previous);
      if (intro) {
        if (uncertain(cue)) continue;
        if (intro.evidence.length>1) {
          const delta=number(cue,'start')-number(previous,'end');
          if (uncertain(previous)||!Number.isFinite(delta)||delta<0||delta>5||gapTouches(previous,cue,safeGaps)) {
            intro.evidence=[id];
            intro.method='의원 명시적 자기소개 (원음 확인 필요)';
          }
        }
        const seen=visible.get(id);
        if (seen===intro.name) intro.method+='; 명패 시각 대응 관측과 의원이름 일치 (단일 화면, 수동 확인 필요)';
        else if (seen&&seen!==intro.name) { intro.method+='; 명패 시각 대응 관측과 의원이름 불일치 (단일 화면, 수동 확인 필요)'; ocrConflicts.add(id); }
        result[id]=intro; continue;
      }
      const roleSuggestion=roleTurn(cue,previous,byId,safeGaps,meeting);
      if (roleSuggestion) { result[id]=roleSuggestion; continue; }
      if (!candidate) continue;
      const evidence=(candidate.evidence||[]).map(String);
      const single=evidence.length===1&&evidence[0]===id;
      const procedure=single&&!candidate.name;
      const self=single&&!!candidate.name;
      const target=validate({...candidate,nameCueId:id},id,byId,ordered,safeGaps,meeting);
      if (!target) continue;
      if (!procedure&&!self&&evidence.length<2) continue;
      if (!procedure&&!self) {
        const index=ordered.findIndex(row=>row.id===id),caller=byId.get(evidence[0]);
        if (index<1||ordered[index-1].id!==evidence[0]) continue;
        if (ANSWER_TO_OTHER.test(textOf(caller))) continue;
      }
      const seen=visible.get(id);
      if (target.name&&seen===target.name) {
        if (target.confidence==='low') target.confidence='medium';
        target.method+='; 명패 시각 대응 관측과 의원이름 일치 (단일 화면, 수동 확인 필요)';
      } else if (target.name&&seen&&seen!==target.name) continue;
      result[id]=target;
    }
    const continued=new Set();
    for (let i=0;i<ordered.length-1;i++) {
      const prior=ordered[i],next=ordered[i+1],base=result[prior.id];
      if (!base?.name||continued.has(prior.id)||ocrConflicts.has(prior.id)||uncertain(prior.cue)||uncertain(next.cue)||result[next.id]||!CONTINUATION.test(textOf(next.cue))||TERMINAL.test(textOf(prior.cue))) continue;
      const delta=number(next.cue,'start')-number(prior.cue,'end');
      if (!Number.isFinite(delta)||delta<0||delta>1.5||gapTouches(prior.cue,next.cue,safeGaps)||hasOtherMember(next.cue,meeting,base.name)||ANSWER_TO_OTHER.test(textOf(next.cue))) continue;
      if (visible.has(next.id)&&visible.get(next.id)!==base.name) continue;
      result[next.id]={name:base.name,role:base.role,confidence:'low',method:'앞 발언과 연속형 연결 표현이 있는 인접 발언 (수동 확인 필요)',evidence:[...new Set([...base.evidence,next.id])]};
      continued.add(next.id);
    }
    dialogueTurns(meeting,ordered,result,observations,safeGaps);
    for (let i=0;i<ordered.length;i++) {
      const {cue,id}=ordered[i], previous=i ? ordered[i-1].cue : null;
      const official = rosterStaffIntro(meeting,cue) || rosterAppointmentAnswer(meeting,cue,previous,result[id],safeGaps) || addressedMemberIntro(cue,meeting) || calledMemberIntro(cue,previous,meeting,safeGaps);
      if (official) result[id]=official;
    }
    return result;
  }
  return Object.freeze({attribute,displayCandidate});
});
