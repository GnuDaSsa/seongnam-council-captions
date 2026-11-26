const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
class Element {constructor(){this.children=[];this.handlers={};this.dataset={};this.readyState=1;}addEventListener(n,f){this.handlers[n]=f;}append(...v){this.children.push(...v);}replaceChildren(...v){this.children=v;}querySelector(){return this.child ||= new Element();}querySelectorAll(){return [];}removeAttribute(k){delete this[k];}setAttribute(k,v){this[k]=v;}pause(){}load(){}play(){return Promise.resolve();}canPlayType(){return '';}}
const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const old={id:'2853',title:'Economic',committee:'Economic',label:'old',scheduledAt:'2026-11-25T09:30:00+09:00',endsAt:'2026-11-25T23:59:00+09:00',officialPage:'https://cast.sncouncil.go.kr/live/flashPlayer.jsp?live_no=2853',agenda:[]};
const today={...old,id:'2857',label:'today',scheduledAt:day+'T09:30:00+09:00',endsAt:day+'T23:59:00+09:00'};
async function scenario(query, meetings, expected) {
 const els=new Map(),find=id=>{if(!els.has(id))els.set(id,new Element());return els.get(id);},loc={href:'https://example.test/'+query};
 const ctx={document:{getElementById:find,createElement:()=>new Element()},window:{CouncilLiveMinutes:{select(){}},addEventListener(){}},URL,Date,Intl,location:loc,history:{replaceState(_a,_b,url){loc.href=String(url);}},console,setTimeout(){return 1;},clearTimeout(){},fetch(url){if(url.startsWith('/api/live/schedule'))return Promise.resolve({ok:true,json:async()=>url.includes('meetingId=2853')?{date:'2026-11-25',meetings:[old]}:{date:day,meetings}});return new Promise(()=>{});}};
 vm.runInNewContext(fs.readFileSync('dist/live.js','utf8'),ctx);for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));
 assert.equal(find('live-meeting-select').value,expected);assert.equal(new URL(loc.href).searchParams.get('live'),expected || null);
}
(async()=>{await scenario('?live=2853',[today],'2857');await scenario('?live=2853&cue=old',[today],'2853');await scenario('?live=2853&speaker=recent',[today],'2853');await scenario('?live=2853',[],undefined);console.log('PASS: old bookmark selects today, record links retain old meeting, empty day clears');})().catch(e=>{console.error(e);process.exitCode=1;});
