// Read the public schedule without executing page scripts or accepting user-supplied origins.
const ORIGIN='https://cast.sncouncil.go.kr';
const LIMIT=1024*1024;
const clean=s=>s.replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/gi,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/\r/g,'').split('\n').map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n');
function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid_date');
  const d=new Date(date+'T00:00:00Z');
  if (!Number.isFinite(d.valueOf()) || d.toISOString().slice(0,10)!==date) throw new Error('invalid_date');
}
function koreaDate(now) { return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(now); }
async function read(fetcher,url) {
  const ctrl=new AbortController(); let timer;
  try {
    return await Promise.race([(async()=>{
      const res=await fetcher(url,{redirect:'manual',signal:ctrl.signal});
      if (res.status===404 || res.status===410) throw new Error('official_source_missing');
      if (!res.ok || res.redirected || Number(res.headers.get('content-length'))>LIMIT) throw new Error('official_source_unavailable');
      const reader=res.body?.getReader(); if(!reader) throw new Error('official_source_unavailable');
      let size=0, chunks=[];
      try { for(;;) { const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>LIMIT) {await reader.cancel();throw new Error('official_source_unavailable');} chunks.push(value); } } finally {reader.releaseLock();}
      const bytes=new Uint8Array(size);let p=0;for(const chunk of chunks){bytes.set(chunk,p);p+=chunk.length;}return new TextDecoder().decode(bytes);
    })(),new Promise((_,reject)=>{timer=setTimeout(()=>{ctrl.abort();reject(new Error('official_source_timeout'));},8000);})]);
  } finally {clearTimeout(timer);}
}
function extract(html,cls) {return html.match(new RegExp(`<p\\b[^>]*class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/p\\s*>`,'i'))?.[1] ?? null;}
export function parseOfficialSchedule(html,date,roster=[]) {
  validateDate(date);
  const [year,month,day]=date.split('-');
  const schedule=`${ORIGIN}/schedule/live_schedule.jsp?sch_year=${year}&sch_month=${month}&sch_day=${day}`;
  if (!/class=["'][^"']*\blive_schedul\b/i.test(html) || !new RegExp(`${Number(year)}년\\s*${Number(month)}월`).test(html)) throw new Error('official_source_invalid');
  const blocks=[...html.matchAll(/<div\b[^>]*class=["'][^"']*\bschedul_infor\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/gi)];
  const hasDay=new RegExp(`current_yyyymmdd:\\s*['"]${year}${month}${day}['"]`).test(html);
  if (!blocks.length && hasDay) throw new Error('official_source_invalid');
  const records=Array.isArray(roster)?roster:(roster?.meetings||[]);
  const meetings=blocks.map((m,index)=>{
    const titleRaw=extract(m[1],'title'),timeRaw=extract(m[1],'time'),infoRaw=extract(m[1],'infor');
    if (titleRaw===null || timeRaw===null || infoRaw===null) throw new Error('official_source_invalid');
    const full=clean(titleRaw), time=clean(timeRaw), info=clean(infoRaw);
    if(!full.startsWith(date+' :')) throw new Error('official_source_invalid');
    const fullTitle=full.slice((date+' :').length).trim();
    const committee=fullTitle.match(/([^\s]*위원회|본회의)\s*$/)?.[1];
    const times=time.match(/(\d{2}:\d{2})\s*~\s*(\d{2}:\d{2})/);
    if(!committee||!times||times.slice(1).some(t=>Number(t.slice(0,2))>23||Number(t.slice(3))>59)) throw new Error('official_source_invalid');
    const lines=info.split('\n'); const label=(lines[0]||'').replace(/^□\s*/,'').replace(committee,'').trim();
    const agenda=[]; for(const line of lines.slice(1)) {
      for(const part of line.split(/(?=【)|(?=•)/)) {let x=part.replace(/^[•\s]+/,'').trim(); if(!x||/유튜브|youtube\.com/i.test(x)) continue; x=x.replace(/^【([^】]+)】\s*(?:\(외청\))?$/,'$1').trim(); if(x) agenda.push(x);}
    }
    const candidates=records.filter(x=>(x.committee||x.title)===committee && Array.isArray(x.members) && x.members.length &&  /^https:\/\/www\.sncouncil\.go\.kr\//.test(x.memberSource||'') && /^\d{4}-\d{2}-\d{2}T/.test(x.scheduledAt||'') && x.scheduledAt.slice(0,10)<=date);
    const matched=candidates.sort((a,b)=>(b.scheduledAt||'').localeCompare(a.scheduledAt||''))[0] || null;
    const player=m[1].match(/(?:flashPlayer\.jsp\?live_no=|live_no\s*[:=]\s*['"]?)(\d{1,10})/i);
    const officialPage=player?`${ORIGIN}/live/flashPlayer.jsp?live_no=${player[1]}`:schedule;
    return {id:player?player[1]:`schedule-${date}-${index+1}`,committee,title:committee,fullTitle,label,agenda,time,scheduledAt:`${date}T${times[1]}:00+09:00`,endsAt:`${date}T${times[2]}:00+09:00`,officialPage,provider:null,source:null,playlist:null,members:Array.isArray(matched?.members)?matched.members:[],staffRoster:[],...(matched?.memberSource?{memberSource:matched.memberSource}:{}),...( /youtube\.com\/@sncouncil/i.test(infoRaw)?{externalBroadcastPage:'https://www.youtube.com/@sncouncil',externalBroadcastUrl:'https://www.youtube.com/@sncouncil',allExternal:!/\u3010[^\u3011]+\u3011(?![ \t]*\(\uc678\uccad\))/.test(info)}:{})};
  });
  const sessionTitle=meetings[0]?.fullTitle.match(/\uc81c\s*\d+\ud68c\s*(?:\[?\uc815\ub840\ud68c\]?|\[?\uc784\uc2dc\ud68c\]?)/)?.[0] || null;
  return {date,schedule,sessionTitle,meetings};
}
export async function loadOfficialSchedule(date,fetcher=fetch,roster=[],now=new Date()) {
  validateDate(date);
  const [year,month,day]=date.split('-');
  const url=`${ORIGIN}/schedule/live_schedule.jsp?sch_year=${year}&sch_month=${month}&sch_day=${day}`;
  const result=parseOfficialSchedule(await read(fetcher,url),date,roster);
  // Calendar metadata remains useful even if individual metadata or players fail.
  if(date===koreaDate(now) && result.meetings.length) {
    const records=Array.isArray(roster)?roster:(roster?.meetings||[]);
    const ids=records.map(x=>String(x.id||'')).filter(x=>/^[1-9]\d{0,7}$/.test(x)).map(Number);
    const target=date.replaceAll('-','');
    const cache=new Map(); const transient=new Set(); let budget=39;
    async function candidate(id) {
      if(!Number.isSafeInteger(id)||id<1||id>99999999) return null;
      if(cache.has(id)) return cache.get(id);
      if(budget--<=0) return null;
      let item=null;
      try {
        const raw=await read(fetcher,`${ORIGIN}/schedule/get_schedule_info_json.jsp?live_no=${id}`);
        const parsed=JSON.parse(raw);
        if(parsed && Number(parsed.live_no)===id && /^\d{8}$/.test(String(parsed.live_day||''))) item=parsed;
      } catch (error) { if(error?.message!=='official_source_missing' && !(error instanceof SyntaxError)) transient.add(id); } // Individual failures do not erase the calendar.
      cache.set(id,item); return item;
    }
    function choices(meeting) {return [...cache.values()].filter(x=>x && x.live_day===target && x.sub_bunru_name===meeting.committee && x.start_time===meeting.scheduledAt.slice(11,16).replace(':','') && x.end_time===meeting.endsAt.slice(11,16).replace(':','') && (!meeting.label || String(x.contents||'').includes(meeting.label)));}
    // Revalidate IDs saved in the ledger, including IDs from the same date.
    await Promise.all([...new Set(ids)].slice(0,12).map(candidate));
    // A public list is useful when the official endpoint actually serves it.
    try {
      const live=await read(fetcher,`${ORIGIN}/live/live_list.jsp`);
      const listIds=[...new Set([...live.matchAll(/(?:flashPlayer\.jsp\?live_no=|live_view_subpage\.jsp\?live_no=|live_no\s*[:=]\s*['"]?)(\d{1,8})/gi)].map(m=>Number(m[1])))].slice(0,12);
      await Promise.all(listIds.map(candidate));
    } catch {}
    if(ids.length && result.meetings.some(m=>choices(m).length===0)) {
      const base=Math.max(...ids);
      // Probe the immediate region in small batches, then bracket a distant date
      // with exponential probes and narrow only when both dates are known.
      for(let start=1;start<=8 && budget>0;start+=4)
        await Promise.all(Array.from({length:4},(_,i)=>candidate(base+start+i)));
      let low=base+8, high=null;
      if(result.meetings.some(m=>choices(m).length===0)) {
        for(let step=16;step<=65536 && budget>5;step*=2) {
          const point=base+step, item=await candidate(point);
          if(!item) break;
          if(item.live_day>=target) {high=point;break;}
          low=point;
        }
        while(high!==null && high-low>8 && budget>8) {
          const mid=Math.floor((low+high)/2), item=await candidate(mid);
          if(!item) break;
          if(item.live_day>=target) high=mid; else low=mid;
        }
        if(high!==null && high-low<=8) {
          for(let start=Math.max(base+1,low-3);start<=high+4 && budget>0;start+=4)
            await Promise.all(Array.from({length:4},(_,i)=>candidate(start+i)));
        }
      }
    }
    function previous(meeting) {
      const rows=records.filter(x=>x.id && /^\d+$/.test(String(x.id)) && (x.committee||x.title)===meeting.committee && x.scheduledAt===meeting.scheduledAt && x.endsAt===meeting.endsAt && (x.label||'')===meeting.label && JSON.stringify(x.agenda||[])===JSON.stringify(meeting.agenda) && Boolean(x.allExternal)===Boolean(meeting.allExternal) && (x.externalBroadcastUrl||x.externalBroadcastPage||null)===(meeting.externalBroadcastUrl||null) && x.officialPage===`${ORIGIN}/live/flashPlayer.jsp?live_no=${x.id}` && /^https:\/\/cast\.sncouncil\.go\.kr:4443\/live\/[A-Za-z0-9_.-]+\/playlist\.m3u8$/.test(x.playlist||''));
      return rows.length===1?rows[0]:null;
    }
    for(const meeting of result.meetings) {
      const prior=previous(meeting);
      const matches=choices(meeting);
      if(matches.length!==1) {
        if(matches.length===0 && prior && transient.has(Number(prior.id))) Object.assign(meeting,{id:String(prior.id),officialPage:prior.officialPage,provider:'hls',source:prior.officialPage,playlist:prior.playlist});
        continue;
      }
      meeting.id=String(matches[0].live_no);
      meeting.officialPage=`${ORIGIN}/live/flashPlayer.jsp?live_no=${meeting.id}`;
      if(meeting.allExternal) continue;
      try {
        const html=await read(fetcher,meeting.officialPage);
        const h=clean(html.match(/<div\b[^>]*class=["'][^"']*\bconfer_view_right\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]||'');
        if(!h.includes(meeting.committee) || (meeting.label && !h.includes(meeting.label))) continue;
        const source=html.match(/^[ \t]*source\s*:\s*["'](https:\/\/cast\.sncouncil\.go\.kr:4443\/live\/[A-Za-z0-9_.-]+\/playlist\.m3u8)["']/m)?.[1];
        if(source) Object.assign(meeting,{provider:'hls',source:meeting.officialPage,playlist:source});
      } catch (error) {
        if(error?.message!=='official_source_missing' && prior && String(prior.id)===meeting.id) Object.assign(meeting,{provider:'hls',source:prior.officialPage,playlist:prior.playlist});
      }
    }
  }
  return result;
}
