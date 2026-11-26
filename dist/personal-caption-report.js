(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports=factory();
  else root.CouncilPersonalCaptionReport=factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const origin='http://127.0.0.1:48193';
  const prefix='#personal-report=';
  const sharedPrefix='#shared-report=';
  const localPlayback=new Set(['http://127.0.0.1:4186','http://localhost:4186']);
  const issuesUrl='https://github.com/GnuDaSsa/seongnam-council-captions/issues';
  const limits=Object.freeze({meetingTitle:240,speaker:120,quote:1600,rawQuote:1600});
  const contextKeys=['meetingId','cueId',...Object.keys(limits)];
  const idPattern=/^[1-9][0-9]{0,11}$/;
  const cuePattern=/^[A-Za-z0-9_.:-]{1,150}$/;
  const requestPattern=/^[A-Za-z0-9_-]{16,100}$/;
  const maxHash=35000;
  function shape(value,keys) {
    return value && typeof value==='object' && !Array.isArray(value) &&
      Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
  }
  function plain(value,limit,required) {
    if (typeof value!=='string' || value.length>limit || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) return null;
    const text=value.trim();
    return required && !text ? null : text;
  }
  function contextOf(value, maxDuration=30) {
    const shared=value && Object.hasOwn(value,'observedAt');
    const times=shared ? ['observedAt'] : ['start','end'];
    if (!shape(value,[...contextKeys,...times]) || typeof value.meetingId!=='string'||!idPattern.test(value.meetingId) ||
        typeof value.cueId!=='string'||!cuePattern.test(value.cueId))
      return null;
    const {meetingId,cueId,start,end,observedAt}=value;
    if (shared ? !koreanWallTime(observedAt) : !Number.isFinite(start) || !Number.isFinite(end) ||
        !(0<=start && start<end && end<=604800 && end-start<=maxDuration)) return null;
    const context={meetingId,cueId,...(shared ? {observedAt} : {start,end})};
    for (const [key,limit] of Object.entries(limits)) {
      const text=plain(value[key],limit,key!=='speaker');
      if (text===null) return null;
      context[key]=text;
    }
    return context;
  }
  function koreanWallTime(value) {
    if (typeof value!=='string' || !/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return '';
    const observed=new Date(value);
    if (!Number.isFinite(observed.getTime()) || observed.toISOString().slice(0,19)!==value.slice(0,19)) return '';
    return new Date(observed.getTime()+9*3600000).toISOString().slice(0,19).replace('T',' ')+' (한국시간)';
  }
  function isReportHash(hash) {
    return typeof hash==='string' && (hash.startsWith(prefix) || hash.startsWith(sharedPrefix));
  }
  function draftOf(draft) {
    if (!shape(draft,['kind','note','id']) || typeof draft.id!=='string' || !requestPattern.test(draft.id)) return null;
    const kind=plain(draft.kind,80,true), note=plain(draft.note,1200,false);
    return kind!==null && note!==null ? {kind,note,id:draft.id} : null;
  }
  function reportUrl(input,draft) {
    const context=contextOf(input);
    if (!context) return '';
    const cleanDraft=draft===undefined ? undefined : draftOf(draft);
    if (draft!==undefined && !cleanDraft) return '';
    try {
      const hash=(context.observedAt ? sharedPrefix : prefix)+encodeURIComponent(JSON.stringify({context,...(cleanDraft && {draft:cleanDraft})}));
      return hash.length<=maxHash ? origin+'/'+hash : '';
    } catch (_) { return ''; }
  }
  function fromHash(hash) {
    if (!isReportHash(hash) || hash.length>maxHash) return null;
    try {
      const shared=hash.startsWith(sharedPrefix);
      const data=JSON.parse(decodeURIComponent(hash.slice((shared ? sharedPrefix : prefix).length)));
      const includesDraft=Object.hasOwn(data,'draft');
      if (!shape(data,includesDraft ? ['context','draft'] : ['context'])) return null;
      const context=contextOf(data.context), draft=includesDraft ? draftOf(data.draft) : null;
      return context && shared===Boolean(context.observedAt) && (!includesDraft || draft) ? {context,draft} : null;
    } catch (_) { return null; }
  }
  function officialUrl(input) {
    const context=contextOf(input);
    if (!context) return '';
    if (context.observedAt) return officialLiveUrl(context.meetingId);
    return 'https://cast.sncouncil.go.kr/vod/vod_view.jsp?pk_vod_no='+context.meetingId+'&position='+Math.floor(context.start);
  }
  function officialLiveUrl(id) {
    return typeof id==='string' && idPattern.test(id) ? 'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no='+id : '';
  }
  function modeFor(originValue) {
    if (localPlayback.has(originValue)) return 'local';
    try {
      const page=new URL(originValue);
      return page.protocol==='https:' && page.origin===originValue ? 'hosted' : '';
    } catch (_) { return ''; }
  }
  function mediaStamp(seconds) {
    const n=Math.floor(seconds);
    return [Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(value=>String(value).padStart(2,'0')).join(':');
  }
  function literal(text, limit) {
    const points=Array.from(text);
    const excerpt=points.length>limit ? points.slice(0,limit).join('')+'…' : text;
    return excerpt.split('\n').map(line=>'    '+line).join('\n');
  }
  function issueUrl(input) {
    const context=contextOf(input);
    if (!context) return '';
    const time=context.observedAt ? koreanWallTime(context.observedAt) : `${mediaStamp(context.start)}–${mediaStamp(context.end)}`;
    const title=`[자막 오류] ${context.meetingTitle.replace(/\s+/g,' ').replace(/@/g,'＠')} · ${time}`;
    const issue=new URL(issuesUrl+'/new');
    issue.searchParams.set('title',title);
    for (const limit of [1600,600,200]) {
      const lines=['### 자막 정보','',
        `[공식 ${context.observedAt?'생중계':'영상'} 보기](${officialUrl(context)})`,
        '',`시각 · ${time}`,`자막 ID · ${context.cueId}`,''];
      if (context.speaker) lines.push('화면의 발언자 표기','',literal(context.speaker,120),'');
      lines.push('표시된 자막','',literal(context.quote,limit),'');
      if (context.rawQuote!==context.quote) lines.push('음성 인식 원문','',literal(context.rawQuote,limit),'');
      lines.push('### 어떤 부분이 잘못됐나요?','','');
      issue.searchParams.set('body',lines.join('\n'));
      if (issue.href.length<=7500) return issue.href;
    }
    return '';
  }
  const kinds = ['자막 내용 오류','발언자 오류','시각 오류','기타'];
  function hostedDraft(value,source) {
    const context = contextOf(value,604800);
    if (!context || !(context.observedAt ? ['live-shared','live-personal'] : ['vod-existing','vod-personal']).includes(source)) return null;
    context.source=source;
    return {context,id:crypto.randomUUID(),kind:kinds[0],note:'',submitted:null,
      sending:false,deliveryDay:'',message:''};
  }
  async function submit(draft, fetcher=fetch) {
    if (!draft || draft.sending || draft.deliveryDay) return;
    const note=draft.note.trim(), kind=draft.kind;
    if (!kinds.includes(kind) || !note || !plain(note,1200,true)) {
      draft.message='의견을 1~1,200자로 입력해 주세요.';
      return;
    }
    if (draft.submitted && (draft.submitted.note!==note || draft.submitted.kind!==kind)) draft.id=crypto.randomUUID();
    draft.submitted={kind,note};
    draft.sending=true;
    draft.message='제보를 저장하고 있습니다.';
    try {
      const response=await fetcher('/api/reports',{method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({id:draft.id,kind,note,context:draft.context})});
      if (!response.ok) {
        if (response.status===429) throw Error('접수가 몰려 잠시 후 다시 제출해 주세요.');
        throw Error('저장을 확인하지 못했습니다. 다시 제출해 주세요.');
      }
      const data=await response.json();
      if (data.receipt!==true || data.id!==draft.id || !/^\d{4}-\d\d-\d\d$/.test(data.deliveryDay)) {
        throw Error('저장을 확인하지 못했습니다. 다시 제출해 주세요.');
      }
      draft.deliveryDay=data.deliveryDay;
      draft.message='접수했습니다. '+data.deliveryDay+' 오후 9시 취합분에 포함됩니다.';
    } catch (error) {
      draft.message=error.message==='접수가 몰려 잠시 후 다시 제출해 주세요.' ? error.message :
        '저장을 확인하지 못했습니다. 다시 제출해 주세요.';
    } finally {
      draft.sending=false;
    }
  }
  function bindForm(panel,template) {
    const form=template.content.firstElementChild.cloneNode(true);
    panel.append(form);
    const kind=form.elements.namedItem('kind'),note=form.elements.namedItem('note');
    const button=form.querySelector('[type=submit]'),status=form.querySelector('[role=status]');
    const excerpt=form.querySelector('blockquote');
    let active=null;
    function draw(draft) {
      active=draft;
      form.hidden=!draft;
      if (!draft) return;
      if (kind.value!==draft.kind) kind.value=draft.kind;
      if (note.value!==draft.note) note.value=draft.note;
      if (excerpt.textContent!==draft.context.quote) excerpt.textContent=draft.context.quote;
      const locked=draft.sending || !!draft.deliveryDay;
      kind.disabled=note.disabled=locked;
      button.disabled=locked || !draft.note.trim();
      if (status.textContent!==draft.message) status.textContent=draft.message;
    }
    function edit() {
      if (!active || active.sending || active.deliveryDay) return;
      active.kind=kind.value; active.note=note.value; active.message='';
      draw(active);
    }
    kind.addEventListener('change',edit); note.addEventListener('input',edit);
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      const draft=active;
      if (!draft) return;
      const pending=submit(draft);
      draw(draft);
      await pending;
      if (active===draft) draw(draft);
    });
    draw(null);
    return draw;
  }
  function bridgeReady() {
    return new Promise(resolve=>{
      const image=new Image();
      const done=available=>{clearTimeout(timer);image.onload=image.onerror=null;resolve(available);};
      const timer=setTimeout(()=>done(false),2200);
      image.onload=()=>done(true);
      image.onerror=()=>done(false);
      image.src=origin+'/ready.png';
    });
  }
  return Object.freeze({origin,prefix,reportUrl,fromHash,isReportHash,officialUrl,officialLiveUrl,koreanWallTime,modeFor,issueUrl,issuesUrl,
    hostedDraft,submit,bindForm,bridgeReady,localPlayback:value=>localPlayback.has(value)});
});
