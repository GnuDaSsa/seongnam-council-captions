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
    return result;
  }
  return Object.freeze({attribute,displayCandidate});
});
