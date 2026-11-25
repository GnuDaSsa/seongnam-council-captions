// Add official VODs whose date, committee, sitting and entire agenda identify one captured live meeting.
import {readFile,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {resolveVod} from '../worker/vod.mjs';

const {values,positionals}=parseArgs({allowPositionals:true,options:{
  manifest:{type:'string',default:'dist/data/live-meetings.json'},
  index:{type:'string',default:'dist/data/vod-index.json'},
  'saved-pages':{type:'string'}
}});
if (!positionals.length || !positionals.every(id=>/^[1-9]\d{0,7}$/.test(id))) {
  throw Error('Usage: node tools/link_live_vod.mjs [--saved-pages official-page-directory] VOD_ID ...');
}
const {meetings}=JSON.parse(await readFile(values.manifest,'utf8'));
const catalog=JSON.parse(await readFile(values.index,'utf8'));
const revised=new Map(catalog.meetings.map(row=>[row.id,row]));
for (const id of new Set(positionals)) {
  let reader=fetch;
  if (values['saved-pages']) {
    const html=await readFile(resolve(values['saved-pages'],'audit-vod-'+id+'.html'),'utf8');
    const ids=[...html.matchAll(/vod_view_simple_subpage\.jsp\?pk_vod_no=(\d+)/g)].map(match=>match[1]);
    if (!ids.includes(id) || ids.some(other=>other!==id)) throw Error('VOD ID mismatch in saved official page: '+id);
    reader=async()=>new Response(html);
  }
  const response=await resolveVod(new Request('https://localhost/api/vod/resolve?id='+id),reader,undefined,meetings);
  const {cues,...row}=await response.json();
  if (!response.ok || !row.liveMeetingId) throw Error('No unique live counterpart for VOD '+id);
  revised.set(id,{...revised.get(id),...row});
  console.log(id,row.liveMeetingId,row.title,row.members.length,row.staffRoster.length);
}
catalog.meetings=[...revised.values()].sort((a,b)=>Number(b.id)-Number(a.id));
const destination=resolve(values.index), temporary=destination+'.'+process.pid+'.tmp';
await writeFile(temporary,JSON.stringify(catalog,null,2)+'\n');
await rename(temporary,destination);
