/* Conservative live speaker suggestions. Every result is a review lead, never a verified identity. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./speaker-review.js'), require('./nameplate-review.js'), require('./speaker-policy.js'));
  } else root.CouncilLiveSpeaker = factory(root.CouncilSpeakerReview, root.CouncilNameplateReview, root.CouncilSpeakerPolicy);
})(typeof window === 'undefined' ? globalThis : window, function (speakerReview, nameplateReview, policy) {
  'use strict';
  const captureTime = nameplateReview?.captureTime || (value => typeof value === 'number' || typeof value === 'string' ? new Date(value).getTime() : NaN);
  const UNCERTAIN = new Set(['low_confidence','severe_uncertainty','repetition','segment_review']);
  const ANSWER_TO_OTHER = /(?:의원님?\s*질의(?:에\s*대해|에\s*대한|하신\s*내용)|(?:질의|질문)\s*답변|답변(?:을|은|드리)|답해\s*드리)/;
  const MIXED_TURN = /[?？]\s*(?:(?:네|예)(?:[.,!\s]|$)|그렇습니다|맞습니다)|(?:있습니다|없습니다|했습니다|하겠습니다)[.]\s*(?:그런데\s*왜|저는요)/;
  const ROLE_SUFFIXES = ['과장','국장','팀장','부장','소장','센터장','담당관','주무관'];
  const INTRO_TITLES = /(?:센터장|담당관|주무관|과장|국장|팀장|부장|소장|위원장|의원|위원)(?:\s+[가-힣]{2,4})?\s*입니다/g;
  const QUOTED = /(?:라고|라며|다고)\s*(?:소개|말씀|하셨|했|전했|답했|말했)|[“「『][^”」』]*(?:입니다|의원|위원)[^”」』]*[”」』]/;
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
  function uncertain(cue) {
    const text = textOf(cue);
    return !!cue?.rejected || (Array.isArray(cue?.flags) && cue.flags.some(flag => UNCERTAIN.has(flag))) ||
      MIXED_TURN.test(text) || (text.match(INTRO_TITLES) || []).length > 1;
  }
  function displayCandidate(cue,candidate) {
    if (!candidate || uncertain(cue)) return undefined;
    if (!candidate.name && /직책 자기소개/.test(candidate.method || '')) {
      const role = ROLE_SUFFIXES.find(suffix=>clean(candidate.role).endsWith(suffix));
      return role ? {...candidate,role} : undefined;
    }
    return candidate;
  }
  function number(cue,key) {
    const value = cue?.[key];
    return value == null || value === '' || !Number.isFinite(Number(value)) ? NaN : Number(value);
  }
  function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
  function orderedCues(cues) {
    return cues.map((cue,index)=>({cue,index,id:idOf(cue),start:number(cue,'start')})).filter(row=>safeId(row.id))
      .sort((a,b)=>Number.isFinite(a.start)&&Number.isFinite(b.start)?a.start-b.start||a.index-b.index:a.index-b.index);
  }
  function gapTouches(a,b,gaps) {
    const as=captureTime(a?.observedAt), bs=captureTime(b?.observedAt);
    if (!Number.isFinite(as)||!Number.isFinite(bs)) return false;
    const ae=as+Math.max(0,number(a,'end')-number(a,'start'))*1000;
    const be=bs+Math.max(0,number(b,'end')-number(b,'start'))*1000;
    return gaps.some(g=>{const s=captureTime(g?.start),e=g?.end==null?Infinity:captureTime(g.end);return Number.isFinite(s)&&(e===Infinity||Number.isFinite(e))&&s<Math.max(ae,be)&&e>Math.min(as,bs);});
  }
  function adjacent(previous, cue, gaps, limit, overlap=0) {
    if (!previous || uncertain(previous) || uncertain(cue)) return false;
    const before = number(previous, 'start'), end = number(previous, 'end');
    const start = number(cue, 'start'), after = number(cue, 'end');
    const delta = start - end;
    if (!(end > before && after > start && delta >= -overlap && delta <= limit)) return false;
    const a = captureTime(previous.observedAt), b = captureTime(cue.observedAt);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return !gaps.length;
    // The wall clock can jump when the publisher reconnects even if media time is contiguous.
    const elapsed = (b - a) / 1000;
    return elapsed >= 0 && elapsed <= end - before + limit && !gapTouches(previous, cue, gaps);
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
  function electedChairIntro(meeting,cue,ordered,observedName,gaps) {
    const text=textOf(cue), start=number(cue,'start'), end=number(cue,'end');
    if (!text.includes('선출') || text.length>130 || text!==clean(cue.rawText) || uncertain(cue) || QUOTED.test(text) ||
        !Number.isFinite(start) || !Number.isFinite(end) || end-start<2 || end-start>15 ||
        (cue.flags || []).some(flag=>acousticBadFlags.has(flag))) return null;
    const config=policy.chairElection;
    const date=clean(meeting.date || meeting.scheduledAt).slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date<=config.registeredOn || date>config.through) return null;
    const instant=Date.parse(date+'T00:00:00Z');
    if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0,10)!==date ||
        (gaps.length && (!Number.isFinite(captureTime(cue.observedAt)) || gapTouches(cue,cue,gaps)))) return null;
    const intro=text.replace(/\s+/g,'').match(/^(?:동료(?:의원|위원)여러분반갑습니다[.!。！]|안녕하십니까[.!?。！？]?)?(?:이번)?제(\d{1,2})대(전반기|후반기)([가-힣]{2,15}위원회)위원장으로선출된([가-힣]{2,4})(?:의원)?입니다[.!。！]?$/);
    if (!intro || Number(intro[1])!==config.term || intro[2]!==config.half) return null;
    const [, , ,body,name]=intro, elected=config.offices[body];
    if (!elected || elected.name!==name || (observedName && observedName!==name)) return null;
    const session=new RegExp('^(?:성남시의회)?(?:제\\d+회(?:(?:제\\d+차)?(?:정례회|임시회))?)?(?:제\\d+차)?'+body+'$');
    if (!session.test(clean(meeting.title).replace(/\s/g,'')) ||
        (meeting.members?.length && meeting.members.filter(member=>clean(member)===name).length!==1) ||
        (meeting.staffRoster || []).some(row=>clean(row?.name)===name) ||
        ordered.some(({cue:other})=>other!==cue && number(other,'start')<end && number(other,'end')>start)) return null;
    return {name,role:'위원장',confidence:'low',method:'위원장 선출 자기소개와 앞서 등록된 당선 인사 방송 대조 (원음 확인 필요)',
      evidence:[idOf(cue)],registeredVodReference:{vodId:config.vodId,sourceUrl:config.sourceUrl,
        registeredOn:config.registeredOn,position:elected.position}};
  }
  const spokenOffice = policy.spokenStaffOffices.join('|');
  const officeFirst = new RegExp('^('+spokenOffice+')([가-힣]{2,4})입니다$');
  const nameFirst = new RegExp('^([가-힣]{2,4})('+spokenOffice+')입니다$');
  function attestedOffice(meeting, spokenRole, name) {
    const roster = (meeting.staffRoster || []).filter(row => !row.candidateOnly &&
      /^https:\/\/www\.sncouncil\.go\.kr\/record\/recordView\.do\?key=[a-f0-9]+$/.test(row.source || ''));
    if (roster.some(row => clean(row.role).replace(/\s/g,'') === spokenRole)) return spokenRole;
    const date = meeting.date || (Number.isFinite(Date.parse(meeting.scheduledAt)) ?
      new Date(Date.parse(meeting.scheduledAt) + 9 * 3600_000).toISOString().slice(0,10) : '');
    if (policy.recordedExecutiveOffices.some(row => row.role === spokenRole && clean(meeting.title).includes(row.body) &&
        staffIsoDate(date) > staffIsoDate(row.registeredOn))) return spokenRole;
    // Only the rank is reliable when the two ASR passages repeat the same misspelled department.
    const rank = spokenRole.match(/(?:사업소장|센터장|본부장|담당관|과장|국장|소장)$/)?.[0];
    const sameName = roster.filter(row => row.name === name);
    return rank && sameName.length === 1 && clean(sameName[0].role).endsWith(rank) ? rank : '';
  }
  function calledOfficeOnly(meeting, previous, cue, ordered, gaps) {
    if (!previous || !textOf(cue).includes('입니다') || !adjacent(previous,cue,gaps,8)) return null;
    for (const row of [previous,cue]) {
      if (textOf(row)!==clean(row.rawText) || QUOTED.test(textOf(row)) ||
          (row.flags || []).some(flag=>acousticBadFlags.has(flag))) return null;
    }
    const start=number(cue,'start'), end=number(cue,'end');
    if (end-start<1 || end-start>12) return null;
    const words = textOf(cue), call = textOf(previous);
    const executive = /^(?:안녕하십니까|안녕하세요)[,.!?。！？\s]+([가-힣][가-힣 ]{1,16}?(?:과장|국장|소장|담당관|센터장|본부장))님?\s+([가-힣]{2,4})입니다[.!。！]?$/.exec(words);
    if (executive && !/(?:소개|대신|인용|전해\s*달|라[고며])/.test(call)) {
      const [, office, name] = executive;
      const spokenRole = office.replace(/\s/g,'');
      const role = attestedOffice(meeting, spokenRole, name);
      const lastSentence = (call.split(/[.!?。！？]/).map(clean).filter(Boolean).at(-1) || '').replace(/\s/g,'');
      const request = new RegExp('^(?:이어서|다음은|그러면)?' + name + spokenRole +
        '님(?:나오셔서|나와서)[가-힣]{0,22}(?:말씀|설명|보고)(?:해|하여)주시기바랍니다$');
      if (role && request.test(lastSentence) && !ordered.some(({cue:other}) =>
          other !== cue && number(other,'start') < end && number(other,'end') > start)) {
        return {name:'', role, confidence:'low', method:'직전 발언 요청과 본인 소개에 나온 같은 부서 직책',
          evidence:[idOf(previous),idOf(cue)]};
      }
    }
    const intro=textOf(cue).replace(/^(?:안녕하십니까|안녕하세요)[,.!?。！？\s]+/,'')
      .replace(/^저는\s+/,'').replace(/\s+/g,'')
      .replace(/[.。]소집보고에앞서위원회선임상황을말씀드리겠습니다[.。]?$/,'')
      .replace(/^[가-힣]{2,15}위원회담당(?=주무관)/,'').replace(/[.!。！]$/,'');
    const first=officeFirst.exec(intro), last=first?null:nameFirst.exec(intro);
    if (!first && !last) return null;
    const role=first?first[1]:last[2], name=first?first[2]:last[1];
    const address=new RegExp('^(?:다음은|그러면|이어서|먼저)?(?:의회사무국)?'+name+role+'님?나오셔서(?:보고|설명)해주시기바랍니다[.!。！]?$');
    if (!address.test(textOf(previous).replace(/\s+/g,'')) ||
        ordered.some(({cue:other})=>other!==cue && number(other,'start')<end && number(other,'end')>start)) return null;
    return {name:'',role,confidence:'low',method:'직전 호명과 본인 소개에서 같은 직책 확인 (실명 미확인)',
      evidence:[idOf(previous),idOf(cue)]};
  }
  function historicalStaffIntro(meeting, row, cue, observedName) {
    const name=clean(row.name), body=clean(row.committee).replace(/\s/g,''), role=clean(row.role).replace(/\s/g,'');
    const title=clean(meeting.title).replace(/\s/g,''), duration=cue.end-cue.start;
    if (!/^[가-힣]{2,15}위원회$/.test(body) || !/^[가-힣]{2,4}$/.test(name) ||
        !policy.priorStaff.bases.includes(row.basis) || !policy.priorStaff.offices.includes(row.officialRole) ||
        !/^https:\/\/www\.sncouncil\.go\.kr\/record\/recordView\.do\?key=[a-f0-9]+$/.test(row.source || '') ||
        (observedName && observedName!==name) || !Number.isFinite(duration) ||
        duration<policy.priorStaff.minCueSeconds || duration>policy.priorStaff.maxCueSeconds ||
        textOf(cue)!==clean(cue.rawText) || uncertain(cue) || (cue.flags || []).some(flag=>acousticBadFlags.has(flag)))
      return false;
    const sitting=new RegExp('^(?:성남시의회)?(?:제\\d+회(?:(?:제\\d+차)?(?:정례회|임시회))?)?(?:제\\d+차)?'+body+
      '(?:\\[폐회중\\]|행정사무감사제\\d+일차)?$');
    if (!sitting.test(title)) return false;
    const expectedRole=row.roleBasis==='recorded-self-introduction' ? body+'담당' :
      row.roleBasis==='chair-assigned-role' ? row.officialRole : '';
    if (!expectedRole || role!==expectedRole) return false;
    const words=textOf(cue).replace(/^(?:안녕하십니까|안녕하세요)[,.!?。！？\s]+/,'')
      .replace(/^저는\s+/,'').replace(/[.!。！]$/,'');
    return words.replace(/\s/g,'')===expectedRole+name+'입니다';
  }
  function staffIsoDate(value) {
    if (typeof value!=='string' || !/^\d{4}-\d\d-\d\d$/.test(value)) return NaN;
    const time=Date.parse(value+'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0,10)===value ? time : NaN;
  }
  function registeredStaffText(cue) {
    const text=textOf(cue);
    return text && text===clean(cue.rawText) && !uncertain(cue) &&
      !QUOTED.test(text) && !/["'“”‘’「」『』]/.test(text) &&
      !(cue.flags || []).some(flag=>acousticBadFlags.has(flag)) ? text : '';
  }
  function staffIntroductionGate(ordered,gaps) {
    // Match an actual announcement even when ASR removes the stop before the first name.
    const otherIntroduction=/(?:간부(?:공무원)?|참석(?:자|직원)|직원|공무원|과장|국장|팀장|주무관|전문위원|정책지원관)(?:님)?(?:들)?(?:을|를)?(?:위원님들?께)?(?:먼저)?소개(?:해드리(?:겠습니다|도록하겠습니다)|올리겠습니다|하겠습니다)/;
    const introductionEnd=/(?:이상(?:으로)?)?(?:직원|공무원|간부)?소개(?:를)?마치겠습니다[.!。！]?$/;
    const namedInvitation=/^(?:다음은|그러면|이어서|먼저)?(?:의회사무국)?([가-힣]{2,4})(?:주무관|전문위원)님?(?:나오셔서|나와서)(?:보고|설명)해주시기바랍니다[.!。！]?$/;
    const denied=new Map();
    for (let i=0;i<ordered.length;i++) {
      const cue=ordered[i].cue, text=textOf(cue);
      const parts=registeredStaffText(cue).split(/[.!?。！？]/).map(line=>line.replace(/\s+/g,'')).filter(Boolean);
      if (parts.some(line=>otherIntroduction.test(line))) {
        denied.set(ordered[i].id,'');
        continue;
      }
      if (i===0) continue;
      const afterGreeting=text.replace(/^(?:안녕하십니까|안녕하세요)[,.!?。！？\s]+/,'');
      if (/^저는\s+/.test(afterGreeting)) continue;
      const immediate=ordered[i-1].cue, introTime=number(cue,'start');
      const invited=adjacent(immediate,cue,gaps,8) ?
        namedInvitation.exec(registeredStaffText(immediate).replace(/\s+/g,''))?.[1] : '';
      let next=cue;
      for (let j=i-1;j>=Math.max(0,i-4);j--) {
        const before=ordered[j].cue;
        if (introTime-number(before,'end')>24 || !adjacent(before,next,gaps,8,policy.acousticMaxOverlapSeconds)) break;
        const previous=registeredStaffText(before).replace(/\s+/g,'');
        if (text!==afterGreeting && introductionEnd.test(previous)) break;
        if (otherIntroduction.test(previous)) {
          denied.set(ordered[i].id,invited || '');
          break;
        }
        next=before;
      }
    }
    // A roll call can run for dozens of names. Extend it only across adjacent, standalone list entries.
    const namedOffice = /^(?:[가-힣]{2,4}\s+[가-힣A-Za-z ]{1,24}(?:국장|과장|팀장|소장|관장|담당관|주무관|전문위원|본부장|센터장)|[가-힣A-Za-z ]{1,24}(?:국장|과장|팀장|소장|관장|담당관|주무관|전문위원|본부장|센터장)\s+[가-힣]{2,4})입니다$/;
    const splitOffice=/^(?:안녕하십니까|안녕하세요)[ ,.!?。！？]+[가-힣A-Za-z ]{1,24}(?:국장|과장|팀장|소장|관장|담당관|주무관|전문위원|본부장|센터장)$/;
    const splitName=/^[가-힣]{2,4}입니다[.!?。！？]?$/;
    let inList=false, previous=null, pendingName=false;
    for (const {cue,id} of ordered) {
      const words=clean(cue?.rawText) || textOf(cue);
      const parts=words.split(/[.!?。！？]/).map(clean).filter(Boolean);
      const announced=otherIntroduction.test(words.replace(/\s/g,''));
      const entry=parts.length>0 && parts.every(part=>namedOffice.test(part));
      const follows=inList && adjacent(previous,cue,gaps,8,policy.acousticMaxOverlapSeconds);
      const titleFragment=follows && splitOffice.test(words);
      const listedName=follows && pendingName && splitName.test(words);
      if (announced || (follows && entry) || titleFragment || listedName) denied.set(id,'');
      inList=announced || titleFragment || listedName || (entry && denied.get(id)==='');
      pendingName=titleFragment;
      previous=cue;
    }
    return (cue,name)=>!denied.has(idOf(cue)) || (!!name && denied.get(idOf(cue))===name);
  }
  function registeredStaffIntro(meeting,cue,previous,ordered,gaps,observedName,mayUsePriorStaff) {
    const rows=meeting.registeredVodStaffRoster;
    if (!Array.isArray(rows) || rows.length!==1) return null;
    const row=rows[0];
    if (!row || row.basis!=='public-registered-vod' || row.candidateOnly!==true ||
        !/^[가-힣]{2,15}위원회$/.test(row.body||'') || !/^[가-힣]{2,4}$/.test(row.name||'') ||
        !policy.priorStaff.offices.includes(row.officialRole) || !/^[1-9]\d{0,7}$/.test(row.vodId||''))
      return null;
    const {body,name,vodId,sourceUrl,registeredOn,position}=row;
    if (!mayUsePriorStaff(cue,name)) return null;
    const scheduled=captureTime(meeting.scheduledAt);
    const liveDate=Number.isFinite(scheduled) ? new Date(scheduled+9*3600000).toISOString().slice(0,10) : '';
    const [first,recorded,registered,day,last]=[row.termStart,row.recordedOn,registeredOn,meeting.date||liveDate,row.termEnd].map(staffIsoDate);
    if (!(first<=recorded && recorded<=registered && registered<day && day<=last && day-recorded<=90*86400000) ||
        (meeting.date && liveDate && meeting.date!==liveDate) || [meeting.id,meeting.vodId,meeting.liveMeetingId].some(id=>String(id)===vodId) ||
        !Number.isFinite(position) || position<0 || position>=86400 ||
        sourceUrl!=='https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no='+vodId+'&position='+Math.floor(position) ||
        row.selfIntroduction!==body+' 담당 '+name+'입니다.' || (observedName && observedName!==name) ||
        (meeting.members || []).includes(name) || (meeting.staffRoster || []).some(item=>item?.name===name)) return null;
    const sitting=new RegExp('^(?:성남시의회)?(?:제\\d+회(?:(?:제\\d+차)?(?:정례회|임시회))?)?(?:제\\d+차)?'+body+
      '(?:\\[폐회중\\]|행정사무감사제\\d+일차)?$');
    const start=number(cue,'start'), end=number(cue,'end'), duration=end-start;
    if (!sitting.test(clean(meeting.title).replace(/\s/g,'')) || start<0 || gapTouches(cue,cue,gaps) ||
        !(duration>=policy.priorStaff.minCueSeconds && duration<=policy.priorStaff.maxCueSeconds) ||
        ordered.some(({cue:other})=>other!==cue && number(other,'start')<end && number(other,'end')>start)) return null;
    const intro=registeredStaffText(cue).replace(/^(?:안녕하십니까|안녕하세요)[,.!?。！？\s]+/,'')
      .replace(/^저는\s+/,'').replace(/[.!。！]$/,'').replace(/\s+/g,'');
    if (intro!==body+'담당'+name+'입니다') return null;
    const call=/^(?:다음은|그러면|이어서|먼저)?의회사무국([가-힣]{2,4})(주무관|전문위원)님?(?:나오셔서|나와서)보고해주시기바랍니다[.!。！]?$/
      .exec(registeredStaffText(previous).replace(/\s+/g,''));
    const hasCall=call && adjacent(previous,cue,gaps,8);
    if (hasCall && (call[1]!==name || call[2]!==row.officialRole)) return null;
    return {name,role:hasCall ? row.officialRole : '',confidence:'low',
      method:'현재 위원회 담당 자기소개와 앞서 등록된 방송 원음 대조 (원음 확인 필요)',
      evidence:hasCall ? [idOf(previous),idOf(cue)] : [idOf(cue)],
      registeredVodReference:{vodId,sourceUrl,registeredOn,position}};
  }
  function spokenOfficeMatches(spoken, role) {
    if (spoken===role) return true;
    return spoken.endsWith('사업소장') && role.endsWith('사업소장') && role.length===spoken.length &&
      [...role].filter((letter,index)=>letter!==spoken[index]).length===1;
  }
  function rosterStaffIntro(meeting, cue, observedName, mayUsePriorStaff=()=>true) {
    if (uncertain(cue)) return null;
    const text = textOf(cue);
    if (QUOTED.test(text)) return null;
    const match = text.match(/^(?:(?:안녕하십니까|안녕하세요|네|예|저는)[,.!?\s]+){0,3}([A-Za-z가-힣\s]{1,24})\s+([가-힣]{2,4})입니다[.!?\s]*$/);
    if (!match) return null;
    const spokenRole = match[1].replace(/\s/g,''), name = match[2];
    if ((meeting.members || []).map(clean).includes(name)) return null;
    const roster = Array.isArray(meeting.staffRoster) ? meeting.staffRoster : [];
    const matches = roster.filter(row => {
      if (!mayUsePriorStaff(cue,name) || (row?.candidateOnly && !historicalStaffIntro(meeting,row,cue,observedName))) return false;
      const role = clean(row?.role).replace(/\s/g,'');
      return row && clean(row.name) === name && row.source && (spokenOfficeMatches(spokenRole,role) ||
        (role.startsWith('성남문화재단') && role.slice('성남문화재단'.length) === spokenRole));
    });
    if (matches.length !== 1 || roster.filter(row => clean(row?.name) === name).length !== 1) return null;
    return {name,role:clean(matches[0].role),confidence:'low',
      method:matches[0].candidateOnly ? '현재 자기소개와 이전 위원회 담당 기록 대조 (원음 확인 필요)' :
        '명시적 자기소개와 공식 명부 직책·성명 대조 (원음 확인 필요)',evidence:[idOf(cue)]};
  }
  function splitStaffIntro(meeting, cue, previous, gaps, mayUseStaff) {
    if (!/^[가-힣]{2,4}입니다[.!]?$/.test(textOf(cue)) ||
        !adjacent(previous, cue, gaps, policy.splitIntroSeconds)) return null;
    const prefix = textOf(previous);
    if (!/^(?:(?:안녕하십니까|안녕하세요|저는)[,.!?\s]+)[가-힣\s]{1,24}$/.test(prefix)) return null;
    const joined = rosterStaffIntro(meeting, {...cue, text: prefix + ' ' + textOf(cue)}, undefined, mayUseStaff);
    return joined && {...joined, evidence: [idOf(previous), idOf(cue)],
      method: '연속된 두 자막의 자기소개와 공식 명부 직책·성명 대조 (원음 확인 필요)'};
  }
  function rosterAppointmentAnswer(meeting, cue, previous, candidate, gaps) {
    if (!previous || uncertain(cue) || uncertain(previous) || cue.flags?.includes('name') || QUOTED.test(textOf(cue))) return null;
    const q = textOf(previous), text = textOf(cue);
    const question = q.match(/^(사업소장|센터장|담당관|주무관|과장|국장|팀장|부장|소장)님\s*(?:그\s*자리에\s+오신\s*지\s+얼마나\s+되셨어요|언제\s+부임하셨습니까)[?？]$/);
    const answer = text.match(/^(?:지난\s*)?(\d{1,2})월\s*(\d{1,2})일(?:날|\s*자로)?\s*(?:발령받았습니다|부임했습니다)[.!]?$/);
    if (!question || !answer || !candidate || candidate.name || candidate.role !== question[1]) return null;
    if (!adjacent(previous, cue, gaps, policy.handoffSeconds)) return null;
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
  function petitionPresentation(meeting, ordered, i, gaps, visible) {
    const cue=ordered[i].cue, words=registeredStaffText(cue).replace(/\s/g,'');
    if (!clean(meeting.title).includes('위원회') || !words.includes('제안설명')) return null;
    const prior=i ? registeredStaffText(ordered[i-1].cue).replace(/\s/g,'') : '';
    const split=/^청원에(?:대하여|대해(?:서)?)제안설명(?:을)?드리겠습니다[.!].{2,55}서명청원한$/.test(prior) &&
      adjacent(ordered[i-1].cue,cue,gaps,policy.petition.splitSeconds);
    const replyStart=split ? i-1 : i;
    const full=split ? prior+words : words;
    const explanation=full.replace(/^(?:안녕하십니까|안녕하세요|네|예)[,.!?。！？]+/,'');
    if (!/^(?:본의원은|본청원은|청원에대(?:해서|하여|해))/.test(explanation) ||
        !/청원에(?:대하여|대해(?:서)?)제안설명(?:을)?드리겠습니다(?:[.!]?|[.!]본청원은[가-힣A-Za-z0-9]{2,70}[.]?)$/.test(explanation) ||
        /[?？]|대리|대신|대독|인용|질의|집행부|검토의견/.test(explanation)) return null;
    // Allow one short greeting which starts the same petition. Never skip an unrelated turn.
    const greeting=/^(?:안녕하십니까|안녕하세요)[?.!,。！？]?(?:본청원(?:은|에)?[가-힣]?[.]{0,3})?$/;
    const introduction=replyStart ? registeredStaffText(ordered[replyStart-1].cue).replace(/\s/g,'') : '';
    const callIndex=greeting.test(introduction) ? replyStart-2 : replyStart-1;
    if (callIndex<1) return null;
    const sequence=ordered.slice(callIndex-1,i+1).map(item=>item.cue);
    if (number(cue,'end')-number(sequence[0],'start')>policy.petition.maxSeconds) return null;
    const call=/^(?:그러면|다음은)?([가-힣]{2,4})(?:의원|위원)님(?:나오셔서|나와서)제안설명(?:을)?해주시기바랍니다[.!]?$/
      .exec(registeredStaffText(sequence[1]).replace(/\s/g,''));
    if (!call || !uniqueMember(meeting,call[1])) return null;
    const name=call[1];
    const agenda=registeredStaffText(sequence[0]);
    const introduced=new RegExp(escapeRegExp(name)+'\\s*(?:의원|위원)님께서\\s*(?:발의|발휘|소개)한\\s+(.{5,100}?)\\s*청원을\\s*상[정장]합니다[.!]?$').exec(agenda);
    if (!introduced || /(?:대신|대리|대독|인용)/.test(agenda)) return null;
    for (let j=0;j<sequence.length;j++) {
      const current=sequence[j], prior=sequence[j-1];
      if (hasOtherMember(current,meeting,name) || (j>=2 && visible.has(idOf(current)) && visible.get(idOf(current))!==name)) return null;
      if (j===0) continue;
      const elapsed=(captureTime(current.observedAt)-captureTime(prior.observedAt))/1000;
      if (!Number.isFinite(elapsed) || Math.abs(elapsed-(number(current,'start')-number(prior,'start')))>policy.acousticMaxClockDriftSeconds ||
          !adjacent(prior,current,gaps,j===2 ? policy.petition.podiumWaitSeconds : policy.petition.maxPauseSeconds)) return null;
    }
    const topics=[...new Set((introduced[1].match(/[가-힣A-Za-z0-9]+/g) || [])
      .map(word=>word.replace(/(?:에관한|에대한|에서|의|에)$/,''))
      .filter(word=>word.length>=3 && !policy.petition.commonWords.includes(word)))];
    if (topics.length<2 || !topics.some(word=>word.length>=4) || topics.join('').length<policy.petition.minTopicLength ||
        !topics.every(word=>explanation.includes(word))) return null;
    return {name,role:'의원',confidence:'low',method:'청원 상정·의원 호명과 같은 청원명의 제안설명 대조 (원음 확인 필요)',
      evidence:sequence.map(idOf)};
  }
  function oathSignature(meeting, ordered, i, gaps, visibleName) {
    const cue=ordered[i].cue, signature=registeredStaffText(cue);
    const ending=/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s+성남시\s+([가-힣A-Za-z ]{2,25})\s+([가-힣]{2,4})[.]?$/.exec(signature);
    if (!ending || i<2 || !(meeting.label+' '+meeting.title).includes('행정사무감사') ||
        (cue.flags || []).includes('name')) return null;
    const [,year,month,day,office,name]=ending;
    const date=year+'-'+month.padStart(2,'0')+'-'+day.padStart(2,'0');
    const recorded=captureTime(cue.observedAt), planned=captureTime(meeting.scheduledAt);
    if (!Number.isFinite(recorded) || !Number.isFinite(planned) || (visibleName && visibleName!==name) ||
        [recorded,planned].some(t=>new Date(t+9*3600000).toISOString().slice(0,10)!==date) ||
        (meeting.members || []).includes(name)) return null;
    const roster=(meeting.staffRoster || []).filter(row=>row?.name===name);
    if (roster.length!==1) return null;
    const row=roster[0], role=office.replace(/\s/g,'');
    if (row.candidateOnly || clean(row.role).replace(/\s/g,'')!==role ||
        !/^https:\/\/www\.sncouncil\.go\.kr\/record\/recordView\.do\?key=[a-f0-9]+$/.test(row.source || '') ||
        !(staffIsoDate(row.appointedOn)<=staffIsoDate(date))) return null;
    const compact=other=>registeredStaffText(other).replace(/\s/g,'');
    const last=ordered[i-1].cue, lastWords=compact(last);
    if (!/선서합니다[.!]?$/.test(lastWords)) return null;
    const firstIndex=lastWords.startsWith('선서본인은') ? i-1 : i-2;
    if (firstIndex<1) return null;
    const evidence=ordered.slice(firstIndex-1,i+1).map(item=>item.cue);
    const oath=evidence.slice(1,-1).map(compact).join('');
    if (!oath.startsWith('선서본인은') || !oath.includes('행정사무감사') || !oath.includes('거짓없이') ||
        evidence.some(other=>(other.flags || []).some(flag=>flag!=='number'))) return null;
    const call=new RegExp('^(?:그러면|다음은)?'+escapeRegExp(name)+
      '([가-힣A-Za-z]{2,20}?)님(?:과각과장님)?(?:께서는|은|는)?(?:앞으로)?나오셔서선서(?:를)?(?:하여|해)주시기바랍니다[.!]?$').exec(compact(evidence[0]));
    if (!call || !spokenOfficeMatches(call[1],role)) return null;
    for (let j=1;j<evidence.length;j++) {
      const prior=evidence[j-1], current=evidence[j];
      const drift=(captureTime(current.observedAt)-captureTime(prior.observedAt))/1000-
        (number(current,'start')-number(prior,'start'));
      if (!Number.isFinite(drift) || Math.abs(drift)>policy.acousticMaxClockDriftSeconds ||
          !adjacent(prior,current,gaps,j===1 ? policy.oath.podiumWaitSeconds : policy.oath.maxPauseSeconds)) return null;
    }
    if (number(cue,'end')-number(evidence[0],'start')>policy.oath.maxSeconds ||
        ordered.some(item=>item.cue!==cue && number(item.cue,'start')<number(cue,'end') &&
          number(item.cue,'end')>number(cue,'start'))) return null;
    return {name,role:row.role,confidence:'low',basis:'oath-signature',method:'감사 선서 직후 날짜·직책·서명 낭독과 공식 명부 대조 (원음 확인 필요)',
      evidence:evidence.map(idOf)};
  }
  function memberIntro(cue,meeting,previous) {
    const text=textOf(cue);
    if (!text||QUOTED.test(text)) return null;
    const spoken = spokenMember(text);
    if (spoken && uniqueMember(meeting, spoken)) {
      const name = spoken;
      const evidence=[idOf(cue)];
      const call=new RegExp(escapeRegExp(name)+'\\s*(?:의원|위원)님?\\s*(?:질의|질문|발언|말씀)');
      if (previous && call.test(textOf(previous))) evidence.unshift(idOf(previous));
      return {name,role:ROLE_MEDIUM,confidence:cue.flags?.includes('name')?'low':'medium',method:evidence.length>1?'직접 호명 뒤 동일 의원 자기소개 (원음 확인 필요)':'명부 의원의 명시적 자기소개 (원음 확인 필요)',evidence};
    }
    return null;
  }
  function uniqueMember(meeting, name) {
    return (meeting.members || []).filter(member => clean(member) === name).length === 1 &&
      !(meeting.staffRoster || []).some(row => clean(row?.name) === name);
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
    if (!callPattern.test(call) || !adjacent(previous, cue, gaps, policy.calledIntroSeconds)) return null;
    return {name,role:'의원',confidence:'low',method:'명부 의원 호명 직후 같은 이름 자기소개 (원음 확인 필요)',evidence:[idOf(previous),idOf(cue)]};
  }
  // A direct question about somebody's identity can also elicit “이름입니다”.
  // Only a floor invitation immediately followed by a roster name can seed a turn.
  function openFloorIntroduction(meeting, previous, cue, gaps) {
    if (!previous || !adjacent(previous, cue, gaps, policy.calledIntroSeconds)) return null;
    const invitation = textOf(previous), reply = textOf(cue);
    if (QUOTED.test(invitation) || QUOTED.test(reply) || cue.flags?.includes('name')) return null;
    const lastSentence = invitation.split(/[.!。！]/).map(clean).filter(Boolean).at(-1) || '';
    const invite = /^(?:(?:네|예|또|다음|혹시|그럼|그러면)[,\s]*)*(?:(?:더\s*)?질의(?:하실|하시는)\s*(?:의원|위원)님(?:들)?|다른\s*(?:의원|위원)님(?:들)?)(?:은|는|이)?\s*(?:더\s*)?(?:없으(?:십니까|시죠)|(?:안\s*)?계(?:십니까|시죠)|있으십니까)[?？.!\s]*$/;
    if (!invite.test(lastSentence)) return null;
    const answer = reply.match(/^(?:(?:네|예|안녕하십니까|안녕하세요|짧게|저는)[,.!?\s]+){0,2}([가-힣]{2,4})입니다[.!\s]*$/);
    if (!answer || !uniqueMember(meeting, answer[1])) return null;
    return {name:answer[1],role:'의원',confidence:'low',method:'질의 신청 직후 밝힌 본인 이름과 회의 명부 대조',evidence:[idOf(previous),idOf(cue)]};
  }
  function roleTurn(cue,previous,byId,gaps,meeting) {
    const text=textOf(cue);
    if (!text||uncertain(cue)||hasOtherMember(cue,meeting,'')) return null;
    const words=text.replace(/\s/g,'');
    const assurance=/^(?:(?:그?지금까지|지금|그런데|그러면|저기|저|우리|아니|그리고)[,.]?){0,3}(?:과장|국장|소장|팀장|센터장|담당관)님[,.]?(?:저(?:한테|에게)|위원회에)(?:하신|해주신|주신)말씀[가-힣0-9]{1,50}(?:장담|확답)(?:하실|할)수있(?:어요|습니까|나요|으세요)[?.!？]?$/;
    const asksForAssurance=assurance.test(words) && !/저는|제가|라고|대신|["“”‘’]/.test(words) &&
      registeredStaffText(cue)===text;
    if (asksForAssurance || (ADDRESSED_TITLE.test(text)&&CLEAR_QUESTION.test(text))) {
      return {name:'',role:'질의자',confidence:'low',method:'직책을 호칭하고 질문한 cue (실명 미확인)',evidence:[idOf(cue)]};
    }
    if (!ANSWER_SELF.test(text)) return null;
    if (previous&&ADDRESSED_TITLE.test(textOf(previous))&&CLEAR_QUESTION.test(textOf(previous))) {
      if (adjacent(previous, cue, gaps, policy.handoffSeconds)) {
        const role=(textOf(previous).match(ADDRESSED_TITLE)||[])[0]?.replace(/님$/,'');
        if (role) return {name:'',role,confidence:'low',method:'직책을 호칭한 질문 뒤 바로 이어진 답변 cue (실명 미확인)',evidence:[idOf(previous),idOf(cue)]};
      }
    }
    return {name:'',role:'답변자',confidence:'low',method:'의원님의 말씀을 지칭하고 제가 답변하는 cue (실명 미확인)',evidence:[idOf(cue)]};
  }
  function validate(candidate,id,byId,previous,gaps,meeting) {
    const cue=byId.get(id);
    if (!candidate||!cue||uncertain(cue)||!textOf(cue)||QUOTED.test(textOf(cue))) return null;
    const evidence=[...new Set((candidate.evidence||[]).map(String))].filter(key=>byId.has(key));
    if (!evidence.includes(id)) evidence.push(id);
    if (evidence.some(key=>uncertain(byId.get(key)))) return null;
    const name=clean(candidate.name);
    if (name && !uniqueMember(meeting, name)) return null;
    if (evidence.length>1) {
      const source=byId.get(evidence[0]);
      if (source!==previous || !adjacent(source,cue,gaps,policy.handoffSeconds)) return null;
      if (ANSWER_TO_OTHER.test(textOf(source))) return null;
      if (name && hasOtherMember(cue,meeting,name)) return null;
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
  const SELF_NAME = /^(?:(?:네|예|안녕하십니까|안녕하세요|저는|[가-힣]{1,8}님)[,.!?\s]+){0,3}([가-힣]{2,4})\s*(?:의원|위원)입니다(?:[.!,?\s]|$)/;
  // A courtesy or first-person opening can be a sentence of its own before the introduction.
  const INTRO_LEAD = /^(?:(?:네|예)[,\s]+)?(?:(?:[가-힣]{1,8}님\s+)?(?:수고하십니다|고생\s*많으십니다)|제가\s+(?:간단히\s+)?(?:준비했습니다|말씀드리겠습니다))\s*[.!。]\s*/;
  function spokenMember(text) { return text.replace(INTRO_LEAD, '').match(SELF_NAME)?.[1]; }
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
    const plates=(Array.isArray(observations)?observations:[]).map(row=>({time:captureTime(row.capturedAt),names:row.matchedMembers}))
      .filter(p=>Number.isFinite(p.time)&&Array.isArray(p.names)).sort((a,b)=>a.time-b.time);
    const interjection = /위원장님|잠깐만요|제가\s*(?:한\s*말씀|끼어)/;
    let floor=null, lastQuestion=null, prior=null;
    for (const [idx,{cue,id}] of ordered.entries()) {
      const t=textOf(cue),at=captureTime(cue.observedAt), start=number(cue,'start');
      if (!Number.isFinite(at)) floor=null;
      const interrupted=prior && !adjacent(prior,cue,gaps,policy.dialogueBreakSeconds);
      const delta=prior?start-number(prior,'end'):Infinity;
      if (interrupted || TRANSFER.test(t) || (floor && (at < floor.at || at-floor.at>policy.floorLifetimeMs || hasOtherMember(cue,meeting,floor.name)))) { floor=null; lastQuestion=null; }
      const previous=prior; prior=cue;
      if (uncertain(cue)||QUOTED.test(t)||interjection.test(t)||TRANSFER.test(t)) { floor=null; lastQuestion=null; continue; }
      const spoken=spokenMember(t);
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
        if (matches.length!==1 || !uniqueMember(meeting,matches[0])) continue;
        const name=matches[0];
        let nextTurn=Infinity;
        for (let j=idx+1;j<ordered.length;j++) {
          const future=ordered[j].cue, when=captureTime(future.observedAt);
          if (!Number.isFinite(when)||when-at>policy.plateSearchMs) break;
          if (TRANSFER.test(textOf(future))||spokenMember(textOf(future))||
              !adjacent(ordered[j-1].cue,future,gaps,policy.dialogueBreakSeconds)) { nextTurn=when; break; }
        }
        // A seat alone cannot identify a voice. For a close phonetic match in an
        // explicit introduction, accept one close reading or two independent ones.
        const near=plates.filter(p=>p.time >= at-policy.plateNearIntroMs && p.time-at<=policy.plateSearchMs && p.time<nextTurn &&
          !gaps.some(g=>captureTime(g.start)<Math.max(at,p.time) && (g.end==null || captureTime(g.end)>Math.min(at,p.time))));
        const unique=near.every(p=>p.names.length===1&&p.names[0]===name);
        const repeated=unique&&near.length>1&&near.at(-1).time-near[0].time>=policy.independentPlateMs;
        const close=unique && near.some(p=>Math.abs(p.time-at)<=policy.plateNearIntroMs);
        if (exact || repeated || close) {
          if (Number.isFinite(at)) floor={name,id,at};
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
        const seen=floor ? plates.filter(p=>p.time<=at && at-p.time<=policy.plateBeforeQuestionMs && p.time>=floor.at-policy.plateNearIntroMs) : [];
        const matches=seen.length && seen.every(p=>p.names.length===1&&p.names[0]===floor.name);
        if (!result[id]||result[id].role==='질의자') {
          const named=Boolean(floor && matches && !hasOtherMember(cue,meeting,floor.name));
          result[id]={name:named?floor.name:'',role:named?'의원':'질의자',confidence:'low',
            method:named?'앞선 자기소개, 같은 이름의 명패 관측, 담당자에게 이어지는 질의 표현':'질문 종결 또는 담당자 호칭이 있는 질의 표현. 실명 미확인',
            evidence:named?[floor.id,id]:[id]};
        }
        lastQuestion={id,role:address,intro:false};
        continue;
      }
      if (!result[id] && previous && !interrupted && beforeLast && delta>=0 && delta<=policy.responseSeconds && RESPONSE.test(t) &&
          !t.includes('?') && (!beforeLast.intro || /(?:위원|의원)님/.test(t))) {
        result[id]={name:'',role:beforeLast.role||'답변자',confidence:'low',
          method:'직전 질의 또는 자기소개에 바로 이어진 응답 표현. 실명 미확인',evidence:[beforeLast.id,id]};
      }
    }
  }
  const acousticStops = /["“”‘’「」『』]|(?:라며|라고|다고)\s*(?:하셨|했|소개|말씀|전했|답했|말했|읽)|[?？.!。！]\s*(?:네|예|아니요|아닙니다)(?:[\s,.!？?]|$)|위원장님|잠깐만요|수고하셨습니다|답변해\s*주|질의해\s*주/;
  const acousticBadFlags = new Set(['uncertain','mixed','overlap','interrupted','audio_gap','invalid_time_value']);
  function acousticCue(cue, gaps,profile) {
    const duration=number(cue,'end')-number(cue,'start');
    return !uncertain(cue) && Array.isArray(cue.flags) && !cue.flags.some(f=>acousticBadFlags.has(f)) &&
      typeof cue.rawText==='string' && cue.rawText===cue.text && Number.isFinite(captureTime(cue.observedAt)) &&
      duration>=profile.minSeconds-0.001 && duration<=15.001 && !gapTouches(cue,cue,gaps) &&
      !acousticStops.test(textOf(cue)) && !QUOTED.test(textOf(cue)) && !TRANSFER.test(textOf(cue));
  }
  function introducedQuestions(meeting,ordered,result,gaps,visible) {
    const titles=new Set(['과장','국장','소장','팀장','실장','센터장','담당관','공보관','감사관','대표이사',
      ...(meeting.staffRoster || []).map(row=>clean(row.role).replace(/\s/g,''))]);
    const isQuestion=text=>EXPLICIT_QUESTION.test(text) || AUDIT_QUESTION.test(text) || /(?:십니까|신가요|맞으세요|계세요)[?？]$/.test(text);
    function address(cue) {
      const m=/^(?:(?:네|예)[,\s]+)?([A-Za-z가-힣]{1,16})님(?=[은는,.\s])/.exec(textOf(cue));
      return m && titles.has(m[1]) ? m[1] : '';
    }
    function eligible(cue,identity) {
      const prior=result[idOf(cue)],seen=visible.get(idOf(cue)),text=textOf(cue);
      return !uncertain(cue) && !(cue.flags || []).some(flag=>acousticBadFlags.has(flag)) &&
        !QUOTED.test(text) && !ANSWER_TO_OTHER.test(text) && !TRANSFER.test(text) &&
        !/의원님|위원님|대신|답변드리|잠깐만|그분이|라고\s*(?:묻|물|말)/.test(text) &&
        !hasOtherMember(cue,meeting,identity.name) && (!seen || seen===identity.name) &&
        (!prior || prior.name===identity.name || (!prior.name && prior.role==='질의자'));
    }
    for (let i=1;i<ordered.length;i++) {
      const intro=ordered[i-1].cue, first=ordered[i].cue, identity=result[idOf(intro)];
      if (!identity?.name || spokenMember(textOf(intro))!==identity.name || !uniqueMember(meeting,identity.name) ||
          (visible.has(idOf(intro)) && visible.get(idOf(intro))!==identity.name) ||
          (intro.flags || []).some(flag=>acousticBadFlags.has(flag)) ||
          !adjacent(intro,first,gaps,policy.continuationSeconds) || !eligible(first,identity)) continue;
      const title=address(first), text=textOf(first);
      if (!title || !/(?:저희가|저희는|저는|제가|여쭤|질의드|질문드)/.test(text) ||
          (text.match(/[가-힣]/g) || []).length<policy.introducedQuestionMinLetters) continue;
      const evidence=[idOf(intro),idOf(first)];
      let question=null;
      if (!isQuestion(text)) {
        question=ordered[i+1]?.cue;
        if (!question || !/(?:는데|인데|던데|거든요)[,.…\s]*$/.test(text) ||
            !adjacent(first,question,gaps,policy.continuationSeconds) || !eligible(question,identity) ||
            number(question,'end')-number(first,'start')>policy.introducedQuestionMaxSpanSeconds ||
            !new RegExp('^(?:지금\\s+)?(?:그\\s+)?'+escapeRegExp(title)+'님(?:은|는|이|께서는|[,.\\s])').test(textOf(question)) ||
            !isQuestion(textOf(question))) continue;
        evidence.push(idOf(question));
      }
      const method='실명 자기소개 직후 같은 직책을 부르며 이어진 질의 (원음 확인 필요)';
      for (const cue of question ? [first,question] : [first])
        if (!result[idOf(cue)]?.name) result[idOf(cue)]={name:identity.name,role:'의원',confidence:'low',method,evidence};
    }
  }
  function districtIntroPattern() {
    const {districts,dongs,numberedDongs,parties}=policy.districtIntro;
    const places=[...districts,...dongs].map(escapeRegExp);
    for (const [stem,digits] of Object.entries(numberedDongs)) {
      const number='['+digits+']';
      places.push(escapeRegExp(stem)+'\\s*'+number+'\\s*(?:동|지\\s*'+number+'\\s*등)');
    }
    const place='(?:'+places.join('|')+')';
    const separator='(?:\\s*[,·ㆍ]\\s*|(?:과|와)\\s*|\\s+및\\s+|\\s+)';
    const party=parties.map(label=>[...label].map(escapeRegExp).join('\\s*')).join('|');
    return new RegExp('^(?:(?:안녕하십니까|안녕하세요)[,.!?。！？\\s]+)?(?:저는\\s+)?(?:성남시\\s+)?'+
      place+'(?:'+separator+place+'){0,2}(?:을|를)\\s+지역구로\\s+(?:하는|둔)\\s+(?:(?:'+party+')\\s+)?'+
      '([가-힣]{2,4})\\s*(?:의원|위원)\\s*입니다[.!。！]?$');
  }
  const districtPattern=districtIntroPattern();
  function districtIntro(meeting,cue) {
    const text=textOf(cue);
    if (!text || text.length>110 || uncertain(cue) || (cue.flags || []).some(flag=>acousticBadFlags.has(flag)) ||
        (cue.rawText!=null && clean(cue.rawText)!==text) || QUOTED.test(text)) return null;
    const name=districtPattern.exec(text)?.[1];
    if (!name || !uniqueMember(meeting,name) || hasOtherMember(cue,meeting,name)) return null;
    return {name,role:'의원',confidence:'low',method:'지역구를 밝힌 자기소개와 회의 명부 실명 대조 (원음 확인 필요)',evidence:[idOf(cue)]};
  }
  const districtIntroShape=/지역구로.{0,45}(?:의원|위원)\s*입니다/;
  function acousticSeed(meeting,cue,mayUsePriorStaff=()=>true) {
    const district=districtIntro(meeting,cue);
    if (district) return {name:district.name,role:district.role};
    const text=textOf(cue);
    const match=/^(?:(?:안녕하십니까|안녕하세요|네|예)[,.!?。！？\s]+){0,2}(?:저는\s+)?([A-Za-z가-힣 ]{3,36})\s*입니다(?=$|[.!。！])/.exec(text);
    if (!match) return null;
    const spoken=match[1].replace(/\s/g,''), rest=text.slice(match[0].length);
    if (/(?:[가-힣]{2,4}\s*(?:의원|위원|과장|국장|주무관)|(?:의원|위원|과장|국장|주무관)\s+[가-힣]{2,4})\s*입니다/.test(rest)) return null;
    const names=[];
    for (const name of meeting.members || []) {
      if (uniqueMember(meeting,name) && [name+'의원',name+'위원','의원'+name,'위원'+name].includes(spoken))
        names.push({name,role:'의원'});
    }
    const staff=meeting.staffRoster || [];
    for (const row of staff) {
      const name=clean(row?.name), role=clean(row?.role), title=role.replace(/\s/g,'');
      if (!/^[가-힣]{2,4}$/.test(name) || !title || (meeting.members || []).includes(name) ||
          staff.filter(r=>clean(r?.name)===name).length!==1 ||
          !/^https:\/\/www\.sncouncil\.go\.kr\/record\/recordView\.do\?key=[a-f0-9]+$/.test(row.source || '')) continue;
      if (!mayUsePriorStaff(cue,name) || (row.candidateOnly && !historicalStaffIntro(meeting,row,cue))) continue;
      if ([title+name,name+title].includes(spoken)) names.push({name,role});
    }
    return names.length===1 ? names[0] : null;
  }
  function acousticProof(value,continuation) {
    const keys=continuation?['policy','sessionId','anchorId','previousId']:['policy','sessionId'];
    return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length &&
      keys.every(key=>Object.hasOwn(value,key)) && typeof value.sessionId==='string' && /^[a-f0-9]{32}$/.test(value.sessionId) &&
      typeof value.policy==='string' && Object.hasOwn(policy.acousticProfiles,value.policy) && (!continuation || [value.anchorId,value.previousId].every(id=>typeof id==='string' && safeId(id) && id.length<=100));
  }
  function acousticTurns(meeting,ordered,result,gaps,visible,mayUsePriorStaff) {
    let active=null;
    for (const {id,cue} of ordered) {
      const proof=cue.audioAnchor || cue.audioContinuation;
      if (!acousticProof(proof,!cue.audioAnchor) || (cue.audioAnchor && cue.audioContinuation)) { active=null; continue; }
      const profile=policy.acousticProfiles[proof.policy];
      if (!acousticCue(cue,gaps,profile)) { active=null; continue; }
      const existing=result[id], observedName=visible.get(id);
      if (cue.audioAnchor) {
        active=null;

        const identity=acousticSeed(meeting,cue,mayUsePriorStaff);
        if (!identity || (existing?.name && existing.name!==identity.name) || (observedName && observedName!==identity.name)) continue;
        if (!existing?.name) result[id]={...identity,confidence:'low',method:'자기소개와 회의 명부 대조 (원음 확인 필요)',evidence:[id]};
        active={...identity,policy:proof.policy,sessionId:proof.sessionId,anchorId:id,anchorStart:number(cue,'start'),previous:cue};
        continue;
      }
      const text=textOf(cue), words=text.split(/\s+/).length, letters=(text.match(/[가-힣]/g) || []).length;
      const short=number(cue,'end')-number(cue,'start')<profile.shortBelowSeconds;
      const substantive=short ? letters>=profile.shortMinLetters && words>=profile.shortMinWords &&
        !/^(?:네|예|아니요)[,.!?\s]+(?:잘\s*)?(?:맞습니다|알겠습니다|그렇습니다|감사합니다|동의합니다)/.test(text) :
        words>=2 && letters>=policy.acousticMinKoreanLetters;
      if (!active || proof.policy!==active.policy || proof.sessionId!==active.sessionId ||
          proof.anchorId!==active.anchorId || proof.previousId!==idOf(active.previous) ||
          (existing?.name && existing.name!==active.name) || (observedName && observedName!==active.name) ||
          (existing?.role && existing.role!==active.role && !(active.role==='의원' && existing.role==='질의자')) ||
          hasOtherMember(cue,meeting,active.name) || (meeting.staffRoster || []).some(r=>r.name && r.name!==active.name && text.includes(r.name)) ||
          !substantive || districtIntroShape.test(text) ||
          /(?:의원|위원)님/.test(text) || /^(?:(?:네|예|안녕하십니까|안녕하세요|저는)[,.!?\s]+){0,3}(?:[가-힣]{2,4}\s*(?:의원|위원|과장|국장)|(?:의원|위원|과장|국장)\s*[가-힣]{2,4})\s*입니다/.test(text)) {
        active=null; continue;
      }
      const before=active.previous, start=number(cue,'start'), delta=Math.round((start-number(before,'end'))*1000)/1000;
      const clockDelta=(captureTime(cue.observedAt)-captureTime(before.observedAt))/1000;
      if (delta < -policy.acousticMaxOverlapSeconds || delta > policy.acousticMaxGapSeconds ||
          Math.abs(clockDelta-(start-number(before,'start'))) > policy.acousticMaxClockDriftSeconds ||
          number(cue,'end')-active.anchorStart > policy.acousticMaxAgeSeconds || gapTouches(before,cue,gaps)) {
        active=null; continue;
      }
      if (!existing?.name) result[id]={name:active.name,role:active.role,confidence:'low',
        method:'같은 회의 기준 발언과 연속 음성 대조 (원음 확인 필요)',evidence:[...new Set([active.anchorId,proof.previousId,id])]};
      active.previous=cue;
    }
  }
  const podiumCall = /^(?:(?<outgoing>[가-힣]{2,4})\s*(?:의원|위원)님\s*수고하셨습니다[.!。]\s*)?(?:(?:다음은|그러면)\s+)?(?<next>[가-힣]{2,4})\s*(?:의원|위원)님\s*(?:나오셔서|나와서)\s*(?:[5오]분\s*(?:자유)?\s*)?발언(?:을)?\s*해\s*주시기\s*바랍니다[.!?\s]*$/;
  const podiumExit = /경청해\s*주셔서\s*감사|이상(?:으로)?\s*(?:[5오]분\s*)?(?:발언|보고|설명).*마치|(?:의원|위원)님\s*수고하셨습니다|(?:정회|산회|휴회)를?\s*선포|위원장님|의장님[,.! ]+잠깐|잠깐만요|답변\s*드리겠|질의(?:에|하신)|의원님께서|보충\s*(?:질의|설명)/;
  // A plenary greeting can address the chair by name before the member introduces themselves.
  // Both utterances must carry the original spoken name, with matching recording and wall clocks.
  // Validate the complete spoken place list against the city dictionary. A shared
  // stem may be omitted in “이매 1, 2동”. ASR can spell a Sino-Korean syllable as a digit.
  function spokenDistrictList(words) {
    const {dongs,numberedDongs}=policy.districtIntro;
    const parts=words.replace(/\s/g,'').split(/[,·ㆍ]/);
    if (!parts.length || parts.length>4) return false;
    let shared='';
    const seen=new Set();
    for (let i=0;i<parts.length;i++) {
      let place=parts[i];
      const short=/^([1-9])동$/.exec(place);
      if (short && shared) place=shared+place;
      else place=place.replace(/^([1-9])(?=[가-힣])/,(_,n)=>'일이삼사오육칠팔구'[Number(n)-1]);
      const numbered=/^([가-힣]+)([1-9])(동?)$/.exec(place);
      if (numbered) {
        const [,stem,n,suffix]=numbered;
        if (!Object.hasOwn(numberedDongs,stem) || !numberedDongs[stem].includes(n) ||
            (!suffix && !/^[1-9]동$/.test(parts[i+1] || ''))) return false;
        shared=stem;
        place=stem+n+'동';
      } else {
        if (!dongs.includes(place)) return false;
        shared='';
      }
      if (seen.has(place)) return false;
      seen.add(place);
    }
    return true;
  }
  function plenaryTopicReference(meeting, name, call, cue) {
    if (!Array.isArray(meeting.members) || meeting.members.length || !/본회의$/.test(clean(meeting.title))) return null;
    const kstDay = value => {
      const time = captureTime(value);
      return Number.isFinite(time) ? new Date(time+9*3600_000).toISOString().slice(0,10) : '';
    };
    const date = kstDay(meeting.scheduledAt);
    if (!date || (meeting.date != null && meeting.date!==date) ||
        kstDay(call.observedAt)!==date || kstDay(cue.observedAt)!==date) return null;
    const election = policy.chairElection;
    const terms = [meeting.term,meeting.councilTerm,meeting.memberRoster?.term].filter(value=>value!=null);
    if (!(election.registeredOn<date && date<=election.through) || terms.some(term=>Number(term)!==election.term) ||
        [...(meeting.staffRoster||[]), ...(meeting.registeredVodStaffRoster||[])].some(row=>clean(row?.name)===name)) return null;
    const activity = policy.plenaryTopicActivity;
    const age = row => (staffIsoDate(date)-staffIsoDate(row.publishedOn))/86400_000;
    const sources = activity.sources.filter(row=>row.name===name && row.term===election.term && age(row)>0 &&
      age(row)<=activity.maxDays && election.offices[row.office]?.name===name);
    if (!sources.length || new Set(sources.map(row=>row.office)).size!==1) return null;
    return {
      registeredVodReference:{vodId:election.vodId,sourceUrl:election.sourceUrl,registeredOn:election.registeredOn,
        position:election.offices[sources[0].office].position},
      officialActivityReferences:sources.map(row=>({sourceUrl:row.url,publishedOn:row.publishedOn})),
    };
  }
  function plenaryGreetingIntro(meeting, previous, cue, gaps, visibleName) {
    if (!previous || !/본회의/.test(clean(meeting.title)) ||
        !adjacent(previous, cue, gaps, policy.podium.callMaxSeconds)) return null;
    const call = textOf(previous), words = textOf(cue);
    if (previous.rawText !== call || cue.rawText !== words || words.length > 180 ||
        [previous, cue].some(row => !Array.isArray(row.flags) || row.flags.some(flag => acousticBadFlags.has(flag))) ||
        /["'“”‘’「」『』?？]/.test(words) || QUOTED.test(words)) return null;
    const callClock = captureTime(previous.observedAt), introClock = captureTime(cue.observedAt);
    const elapsed = (introClock - callClock) / 1000;
    if (!Number.isFinite(elapsed) || Math.abs(elapsed - (cue.start - previous.start)) > policy.acousticMaxClockDriftSeconds ||
        previous.end - previous.start < policy.podium.minCallSeconds ||
        cue.end - cue.start > policy.podium.maxCueSeconds || cue.end - cue.start < policy.podium.minSeedSeconds) return null;
    const invitation = call.replace(/발언하여\s*주시기/, '발언해 주시기').match(podiumCall)?.groups;
    if (!invitation || (visibleName && visibleName !== invitation.next) ||
        (invitation.outgoing && (!uniqueMember(meeting, invitation.outgoing) || invitation.outgoing === invitation.next))) return null;
    const topic=/^([가-힣\d\s,·ㆍ]{2,45})\s+([가-힣]{2,4})\s+의원입니다[.。]\s*(?:오늘\s+저는|저는\s+오늘)\s+([^.!?。！？]{6,65})[.。]?$/.exec(words);
    if (topic) {
      if (topic[2]!==invitation.next || !spokenDistrictList(topic[1]) || hasOtherMember(cue,meeting,invitation.next) ||
          (meeting.staffRoster||[]).some(row=>clean(row.name) && topic[3].includes(clean(row.name))) ||
          /(?:의원|위원|과장|국장|시장|의장|선생|대표)님|대독|대신|인용|전해\s*드|입니다|말씀하|답변해|주시기|질문해|라고\s*(?:했|말)/.test(topic[3])) return null;
      const hasMember=uniqueMember(meeting,invitation.next);
      const reference = hasMember || invitation.outgoing ? null : plenaryTopicReference(meeting,invitation.next,previous,cue);
      if (!hasMember && !reference) return null;
      return {name:invitation.next,role:'의원',confidence:'low',basis:'plenary-first-person-topic',...reference,
        method:reference ?
          '직전 호명·본인 실명을 사전 의정활동 공고와 같은 대수의 공식 당선 영상으로 대조 (원음 확인 필요)' :
          '직전 호명과 지역구 뒤의 본인 실명이 일치하고 같은 자막에서 첫 발언을 시작함 (원음 확인 필요)',
        evidence:[idOf(previous),idOf(cue)]};
    }
    const intro = /^존경하는\s+([^.!?。！？]{4,135}여러분)[,\s]+([가-힣 ·ㆍ,]{1,65}지역구(?:로\s*(?:하는|둔))?\s*(?:시\s*)?[의위]원)\s+([가-힣]{2,4})입니다[.!。！]?$/.exec(words);
    if (!intro || !uniqueMember(meeting,invitation.next) || intro[3] !== invitation.next || /(?:소개|대신|인용|말씀을?\s*전|발언을?\s*전|입니다)/.test(intro[1] + intro[2])) return null;
    // Another member may occur only as an explicitly addressed office in the greeting.
    for (const entry of meeting.members) {
      const person = clean(entry);
      if (!person || person === invitation.next) continue;
      if (intro[2].includes(person)) return null;
      for (const match of intro[1].matchAll(new RegExp(escapeRegExp(person), 'g'))) {
        if (!/^\s*(?:부?의장|위원장|의원|위원)님/.test(intro[1].slice(match.index + person.length))) return null;
      }
    }
    return {name:invitation.next, role:'의원', confidence:'low',basis:'plenary-called-introduction',
      method:'본회의 발언 요청과 지역구 자기소개에서 같은 실명을 확인 (원음 확인 필요)',
      evidence:[idOf(previous), idOf(cue)]};
  }
  const podiumRefs = Object.freeze({call:[],intro:['callId'],confirm:['callId','anchorId'],match:['callId','anchorId','confirmationId']});
  function podiumProof(value) {
    if (!value || typeof value!=='object' || Array.isArray(value) || value.policy!==policy.podium.profile ||
        typeof value.sessionId!=='string' || !/^[a-f0-9]{32}$/.test(value.sessionId) ||
        typeof value.stage!=='string' || !Object.hasOwn(podiumRefs,value.stage)) return false;
    const refs=podiumRefs[value.stage];
    return ['policy','sessionId','stage',...refs].every(key=>Object.hasOwn(value,key)) &&
      Object.keys(value).length===3+refs.length && refs.every(key=>typeof value[key]==='string' &&
      value[key].length<=100 && safeId(value[key])) && new Set(refs.map(key=>value[key])).size===refs.length;
  }
  function podiumTurns(meeting,ordered,result,gaps,visible) {
    const config=policy.podium;
    if (!clean(meeting.title).includes('본회의') || !ordered.some(({cue})=>cue.audioPodium)) return;
    let floor=null;
    for (const {cue,id} of ordered) {
      const text=textOf(cue), start=number(cue,'start'), end=number(cue,'end');
      const proof=cue.audioPodium, stage=proof?.stage, observed=captureTime(cue.observedAt);
      const cleanAudio=Array.isArray(cue.flags) && !uncertain(cue) && !cue.flags.some(flag=>acousticBadFlags.has(flag)) &&
        !QUOTED.test(text) && !/["“”‘’「」『』]/.test(text) && Number.isFinite(observed) &&
        Number.isFinite(start) && end>start && !gapTouches(cue,cue,gaps);
      if (!cleanAudio || (proof && (!podiumProof(proof) || cue.rawText!==cue.text || end-start>config.maxCueSeconds+.001))) {
        floor=null; continue;
      }
      const call=text.match(podiumCall)?.groups;
      if (call || stage==='call') {
        floor=null;
        if (call && stage==='call' && uniqueMember(meeting,call.next) &&
            (!call.outgoing || (call.outgoing!==call.next && uniqueMember(meeting,call.outgoing))) &&
            end-start>=config.minCallSeconds-.001)
          floor={name:call.next,sessionId:proof.sessionId,callId:id,callEnd:end,previous:cue};
        // The named person is the addressee. This evidence never labels the chair's cue.
        continue;
      }
      if (!floor) continue;
      const previous=floor.previous, prevStart=number(previous,'start');
      const sincePrevious=start-number(previous,'end'), elapsed=(observed-captureTime(previous.observedAt))/1000;
      if (sincePrevious < -config.maxOverlapSeconds-.001 ||
          Math.abs(elapsed-(start-prevStart))>policy.acousticMaxClockDriftSeconds ||
          gapTouches(previous,cue,gaps) || (proof && (proof.sessionId!==floor.sessionId || proof.callId!==floor.callId)) ||
          (floor.anchorId ? sincePrevious>config.maxCueGapSeconds+.001 || start-floor.supportedEnd>config.maxCueGapSeconds+.001 ||
            end-floor.anchorStart>config.maxFloorSeconds+.001 :
            start-floor.callEnd>config.callMaxSeconds+.001) ||
          podiumExit.test(text) || TRANSFER.test(text)) { floor=null; continue; }
      floor.previous=cue;
      const identity=acousticSeed(meeting,cue), existing=result[id], observedName=visible.get(id);
      if (identity || stage==='intro') {
        if (stage!=='intro' || floor.anchorId || identity?.name!==floor.name || identity.role!=='의원' ||
            end-start<config.minSeedSeconds-.001 || hasOtherMember(cue,meeting,floor.name) ||
            (existing?.name && existing.name!==floor.name) || (observedName && observedName!==floor.name)) { floor=null; continue; }
        floor.anchorId=id; floor.anchorStart=start; floor.supportedEnd=end;
        if (!existing?.name) result[id]={...identity,confidence:'low',method:'본회의 의장 호명과 발언자의 자기소개 대조 (원음 확인 필요)',evidence:[floor.callId,id]};
        continue;
      }
      if (districtIntroShape.test(text)) { floor=null; continue; }
      if (!floor.anchorId) {
        if (proof || !/^(?:네|예|감사합니다|안녕하십니까)[.!?\s]*$/.test(text)) floor=null;
        continue;
      }
      if ((observedName && observedName!==floor.name) || (existing?.name && existing.name!==floor.name) ||
          (existing?.role && existing.role!=='의원' && existing.role!=='질의자') || hasOtherMember(cue,meeting,floor.name) ||
          (meeting.staffRoster || []).some(row=>row.name && row.name!==floor.name && text.includes(row.name)) ||
          acousticStops.test(text) || ANSWER_TO_OTHER.test(text)) { floor=null; continue; }
      if (!proof) continue;
      const confirmation=stage==='confirm';
      const enoughText=(text.match(/[가-힣]/g) || []).length>=(confirmation?11:12) && text.split(/\s+/).length>=3;
      if (!enoughText || proof.anchorId!==floor.anchorId || end-start<(confirmation?config.minSeedSeconds:config.minMatchSeconds)-.001 ||
          (confirmation ? floor.confirmationId || start-floor.anchorStart>config.confirmationMaxSeconds+.001 :
            stage!=='match' || !floor.confirmationId || proof.confirmationId!==floor.confirmationId ||
            text===floor.confirmationText)) { floor=null; continue; }
      floor.supportedEnd=end;
      if (confirmation) { floor.confirmationId=id; floor.confirmationText=text; }
      if (!existing?.name) result[id]={name:floor.name,role:'의원',confidence:'low',
        method:'본회의 호명·자기소개와 같은 회의의 연설 음성 대조 (원음 확인 필요)',
        evidence:[...new Set([floor.callId,floor.anchorId,floor.confirmationId,id])]};
    }
  }
  function acknowledgedClosing(meeting,ordered,result,gaps,visible) {
    if (!clean(meeting.title).includes('본회의')) return;
    const handover=/^([가-힣]{2,4})(?:의원|위원)님수고(?:많이)?하셨습니다[.!。](?:다음은([가-힣]{2,4})(?:의원|위원)님(?:나오셔서|나와서)(?:발언해|발언하여|발견해)주시기바랍니다|이것으로[5오]분(?:자유)?발언이모두끝났습니다)[.!。]?$/;
    let floor;
    for (let i=0;i<ordered.length;i++) {
      const {id,cue}=ordered[i], known=result[id], text=textOf(cue);
      if (known?.basis==='plenary-called-introduction') {
        floor={cue,known,end:number(cue,'end'),priorUncontested:true};
        continue;
      }
      if (!floor) continue;
      const gapFromIntro=(captureTime(cue.observedAt)-captureTime(floor.cue.observedAt))/1000;
      const start=number(cue,'start'), end=number(cue,'end'), delta=start-floor.end;
      if (![gapFromIntro,start,end,delta].every(Number.isFinite) || end<=start || gapFromIntro<0 ||
          gapFromIntro>policy.completedSpeech.maxSeconds || delta>policy.completedSpeech.maxSilenceSeconds ||
          Math.abs(gapFromIntro-(start-number(floor.cue,'start')))>policy.acousticMaxClockDriftSeconds ||
          (cue.flags||[]).some(flag=>acousticBadFlags.has(flag))) { floor=null; continue; }
      const ack=handover.exec(text.replace(/\s/g,''));
      if (ack) {
        const prior=ordered[i-1], name=floor.known.name;
        const valid=row=>row?.rawText===textOf(row) && Array.isArray(row.flags) &&
          !row.flags.some(f=>acousticBadFlags.has(f)) && !uncertain(row);
        const closing=textOf(prior?.cue).replace(/\s/g,'');
        if (ack[1]===name && (!ack[2] || (ack[2]!==name && uniqueMember(meeting,ack[2]))) &&
            prior && floor.priorUncontested && delta>=0 && !result[prior.id] && valid(cue) && valid(prior.cue) &&
            /^(?:끝까지)?경청해주셔서감사합니다[.!。]?$/.test(closing) &&
            (!visible.has(prior.id) || visible.get(prior.id)===name) &&
            adjacent(prior.cue,cue,gaps,policy.completedSpeech.maxSilenceSeconds) && !gapTouches(floor.cue,cue,gaps)) {
          result[prior.id]={name,role:'의원',confidence:'low',basis:'plenary-acknowledged-close',
            method:'앞선 호명·본인 자기소개와 사회자의 후속 실명 인사가 일치해 마지막 인사말을 추정',
            evidence:[...new Set([...floor.known.evidence,prior.id,id])]};
        }
        floor=null;
      } else if ((known?.name && known.name!==floor.known.name) || known?.role==='의사진행자' ||
          /(?:의원|위원)님\s*(?:수고|나오셔서|나와서)|(?:정회|산회|휴회)를?\s*선포|(?:마이크|발언대).{0,12}(?:다시|켜\s*주)|잠깐만요/.test(text)) {
        floor=null;
      } else {
        floor.priorUncontested=delta>=0;
        floor.end=Math.max(floor.end,end);
      }
    }
  }
  function proceduralRole(meeting,cue,gaps) {
    const body=/(?:[가-힣]+위원회|본회의)/.exec(clean(meeting.title))?.[0];
    const words=textOf(cue);
    if (!body || !words || clean(cue.rawText)!==words || uncertain(cue) ||
        (cue.flags || []).some(flag=>acousticBadFlags.has(flag)) || gapTouches(cue,cue,gaps) ||
        /[?？“”‘’"'「」『』]|의사록|회의록|연습|예시|인용|낭독|집행부에서는|답변드리|과거에는|지난번에는/.test(words) ||
        QUOTED.test(words)) return;
    const text=words.replace(/\s/g,'').replace(/[.!。！]+$/u,'');
    const opening=/^(?:좌석|자석)을정돈해주시기바랍니다[.,]?성원이되었(?:으므로|음으로)제\d+회성남시의회/.test(text) &&
      (text.endsWith(body+'를개의하겠습니다') || text.endsWith(body+'를계획하겠습니다'));
    const agenda=/^(?:먼저|다음(?:은|으로)|그러면의사일정|의사일정제)/.test(text) &&
      /조례|청원|동의안|결의안|예산안|승인안/.test(text) && text.endsWith('상정합니다') && !/[.!。！]/.test(text);
    const decision=/^(?:(?:다른의견|이의)(?:이|가)?(?:없으시므로|없으므로|없으시면)|없으시면)/.test(text) &&
      /조례안|청원|동의안|결의안|예산안|승인안/.test(text) && /(?:되었|됐)음을선포합니다$/.test(text) && !/[.!。！]/.test(text);
    if (opening || agenda || decision) return {name:'',role:'의사진행자',confidence:'medium',
      method:'회의 개의·안건 상정·의결을 직접 알린 문장 (실명 미확인)',evidence:[idOf(cue)]};
  }
  function attribute(meeting,cues,observations=[],gaps=[]) {
    const result={};
    if (!meeting||!Array.isArray(cues)||!speakerReview?.guesses) return result;
    const ordered=orderedCues(cues),byId=new Map();
    for (const row of ordered) { if (byId.has(row.id)) return result; byId.set(row.id,row.cue); }
    const safeGaps=Array.isArray(gaps)?gaps:[],raw=speakerReview.guesses(meeting,cues);
    const visible=visibleNames(meeting,cues,observations,safeGaps),ocrConflicts=new Set();
    const mayUsePriorStaff=staffIntroductionGate(ordered,safeGaps);
    for (let ix=0;ix<ordered.length;ix++) {
      const {id,cue}=ordered[ix],candidate=raw[id],previous=ix?ordered[ix-1].cue:null;
      if (clean(meeting.title).includes('본회의') && podiumCall.test(textOf(cue)) && !uncertain(cue) &&
          !(cue.flags || []).some(flag=>acousticBadFlags.has(flag))) {
        result[id]={name:'',role:'의사진행자',confidence:'medium',method:'본회의에서 다음 발언자를 부르는 진행 문구 (실명 미확인)',evidence:[id]};
        continue;
      }
      const staff=staffIntro(cue);
      if (staff) {
        if (!uncertain(cue) && mayUsePriorStaff(cue)) result[id]=displayCandidate(cue,staff);
        continue;
      }
      const intro=memberIntro(cue,meeting,previous);
      if (intro) {
        if (uncertain(cue)) continue;
        if (intro.evidence.length>1) {
          if (!adjacent(previous,cue,safeGaps,policy.handoffSeconds)) {
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
      const isStaffRole = ROLE_SUFFIXES.some(role=>clean(candidate.role).endsWith(role));
      if (isStaffRole && !mayUsePriorStaff(cue,candidate.name)) continue;
      const target=validate(candidate,id,byId,previous,safeGaps,meeting);
      if (!target) continue;
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
      if (!base?.name || continued.has(prior.id) || ocrConflicts.has(prior.id) ||
          (result[next.id] && result[next.id].role !== '질의자')) continue;
      const text = textOf(next.cue), before = textOf(prior.cue);
      const joined = CONTINUATION.test(text) && !TERMINAL.test(before);
      const question = base.role === '의원' && spokenMember(before) === base.name &&
        /^(?:저는|저도|제가)\s/.test(text) && /(?:여쭤(?:보|봅)|질의(?:드리|하)|질문(?:드리|하))/.test(text);
      if ((!joined && !question) || /(?:위원|의원)님|답변|대신|위원장|잠깐/.test(text) ||
          !adjacent(prior.cue,next.cue,safeGaps,policy.continuationSeconds) || hasOtherMember(next.cue,meeting,base.name) ||
          ANSWER_TO_OTHER.test(text) || QUOTED.test(text) || (visible.has(next.id) && visible.get(next.id)!==base.name)) continue;
      const method = question ? '직전 실명 자기소개에 이어진 본인의 질의 표현 (원음 확인 필요)' : '앞 발언과 연속형 연결 표현이 있는 인접 발언 (수동 확인 필요)';
      result[next.id]={name:base.name,role:base.role,confidence:'low',method,evidence:[...new Set([...base.evidence,next.id])]};
      continued.add(next.id);
    }
    dialogueTurns(meeting,ordered,result,observations,safeGaps);
    for (let i=0;i<ordered.length;i++) {
      const {cue,id}=ordered[i], previous=i ? ordered[i-1].cue : null;
      const elected=electedChairIntro(meeting,cue,ordered,visible.get(id),safeGaps);
      const registered=!ocrConflicts.has(id) && registeredStaffIntro(meeting,cue,previous,ordered,safeGaps,visible.get(id),mayUsePriorStaff);
      const official = elected || rosterStaffIntro(meeting,cue,visible.get(id),mayUsePriorStaff) || registered ||
        splitStaffIntro(meeting,cue,previous,safeGaps,mayUsePriorStaff) ||
        rosterAppointmentAnswer(meeting,cue,previous,result[id],safeGaps) ||
        oathSignature(meeting,ordered,i,safeGaps,visible.get(id)) || petitionPresentation(meeting,ordered,i,safeGaps,visible) ||
        addressedMemberIntro(cue,meeting) ||
        calledMemberIntro(cue,previous,meeting,safeGaps) || openFloorIntroduction(meeting,previous,cue,safeGaps) ||
        plenaryGreetingIntro(meeting,previous,cue,safeGaps,visible.get(id));
      if (official) result[id]=official;
      else {
        const district=districtIntro(meeting,cue);
        if (district && !ocrConflicts.has(id) && (!visible.has(id) || visible.get(id)===district.name))
          result[id]=district;
        if (!result[id] && mayUsePriorStaff(cue)) {
          const office=calledOfficeOnly(meeting,previous,cue,ordered,safeGaps);
          if (office) result[id]=office;
        }
      }
    }
    introducedQuestions(meeting,ordered,result,safeGaps,visible);
    acousticTurns(meeting,ordered,result,safeGaps,visible,mayUsePriorStaff);
    podiumTurns(meeting,ordered,result,safeGaps,visible);
    acknowledgedClosing(meeting,ordered,result,safeGaps,visible);
    for (const {id,cue} of ordered) {
      if (result[id]) continue;
      const role=proceduralRole(meeting,cue,safeGaps);
      if (role) result[id]=role;
    }
    return result;
  }
  function registeredVodHref(reference) {
    const {vodId,sourceUrl,registeredOn,position}=reference || {};
    const page='https://cast.sncouncil.go.kr/vod/vod_view.jsp';
    const maxSeconds=86400;
    if (typeof vodId!=='string' || !/^[1-9]\d{0,7}$/.test(vodId) ||
        typeof sourceUrl!=='string' || !sourceUrl.startsWith(page+'?') || sourceUrl.length>200 ||
        typeof registeredOn!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(registeredOn) ||
        !Number.isFinite(position) || position<0 || position>maxSeconds) return '';
    const day=new Date(registeredOn+'T00:00:00Z');
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0,10)!==registeredOn) return '';
    const params=sourceUrl.slice(page.length+1).split('&');
    const idParam='pk_vod_no='+vodId;
    const sourcePosition=params.find(param=>param!==idParam);
    if (!params.includes(idParam) || params.length>2 ||
        (params.length===2 && (!/^position=\d{1,5}(?:\.\d+)?$/.test(sourcePosition) ||
          Number(sourcePosition.slice('position='.length))>maxSeconds))) return '';
    return page+'?pk_vod_no='+vodId+'&position='+Math.floor(position);
  }
  return Object.freeze({attribute,displayCandidate,acousticProof,podiumProof,registeredVodHref,policyVersion:policy.version});
});
