// Read-only playback preview for the working source. All optional audio models run inside Chrome.
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,realpath,stat,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {resolveVod,resolveVodTranscript,withPriorVodRoster} from '../worker/vod.mjs';
import {createSite} from '../worker/captions.mjs';
import speaker from '../dist/live-speaker.js';

const {values}=parseArgs({options:{port:{type:'string',default:'4186'},captures:{type:'string'},
  'asr-runtime':{type:'string'},'asr-model':{type:'string'},'installation-id':{type:'boolean'},help:{type:'boolean'}}});
if(values.help){
  console.log('node tools/serve_local.mjs [--port 4186] [--captures <minutes directory>] [--asr-runtime <WASM directory> --asr-model <ONNX directory>]');
  process.exit(0);
}
const root=fileURLToPath(new URL('../dist/',import.meta.url));
const installationPath=await realpath(root);
const installationId=createHash('sha256').update(process.platform==='win32'?installationPath.toLowerCase():installationPath).digest('hex');
if(values['installation-id']){
  console.log(installationId);
  process.exit(0);
}
const readJson=async file=>JSON.parse(await readFile(file,'utf8'));
const rosters=await readJson(path.join(root,'data','vod-rosters.json'));
const registeredStaff=await readJson(path.join(root,'data','registered-vod-staff.json'));
const indexData=await readJson(path.join(root,'data','vod-index.json'));
indexData.meetings=indexData.meetings.map(row=>withPriorVodRoster(row,rosters,registeredStaff));
const vodIndex=new Map(indexData.meetings.map(row=>[String(row.id),row]));
const archiveMeetings=(await readJson(path.join(root,'data','archive-seed-meetings.json'))).meetings;
const liveManifestPath=path.join(root,'data','live-meetings.json');
const port=Number(values.port);
if(!Number.isInteger(port)||port<1024||port>65535) throw Error('Choose a port from 1024 to 65535');
const host='127.0.0.1',origin='http://'+host+':'+port;
const roots={dist:await realpath(root)};
for(const key of ['captures','asr-model','asr-runtime']) if(values[key]) roots[key]=await realpath(values[key]);
const modelFiles={
  'encoder.onnx':['asr-model','encoder-epoch-99-avg-1.int8.onnx'],
  'decoder.onnx':['asr-model','decoder-epoch-99-avg-1.onnx'],
  'joiner.onnx':['asr-model','joiner-epoch-99-avg-1.int8.onnx'],
  'tokens.txt':['asr-model','tokens.txt'],
  'sherpa-onnx-wasm-web.js':['asr-runtime','sherpa-onnx-wasm-web.js'],
  'sherpa-onnx-asr.js':['asr-runtime','sherpa-onnx-asr.js'],
  'sherpa-onnx-wasm-web.wasm':['asr-runtime','sherpa-onnx-wasm-web.wasm']
};
const verifiedHashes={
  'sherpa-onnx-wasm-web.js':'28f909145d93018c90c181035a008880ceaa94a72b66603dc7bb7c619714c23c',
  'sherpa-onnx-asr.js':'d51ae8e8b756ee5e53423ffada0c9702973f154f561aca7984fe0b12f4060178',
  'sherpa-onnx-wasm-web.wasm':'e0d84744c39a28121f7738a161a21612788f4e8f07879a7224e74919e9831573',
  'encoder.onnx':'8b196d723421a0513c98ec25da2c43420c029e817f5e4a90b29ff80291c0af2b',
  'decoder.onnx':'b486221625f4680659c21eaf0505c50e64a897583af4f9ca6f87dea762a33885',
  'joiner.onnx':'eb654db1ea2cc9d63474855f65958b6059084692a9f2eb4f3812aceb1e416a20',
  'tokens.txt':'016bdf0965029263b7ad01b742366ee542ef0bef38261510e8176ff6f2e9e668'
};
if(Boolean(roots['asr-runtime'])!==Boolean(roots['asr-model'])) throw Error('Give both local WASM and model directories');
if(roots['asr-runtime']){
  for(const [key,[kind,file]] of Object.entries(modelFiles)){
    const digest=createHash('sha256');
    for await(const bytes of createReadStream(path.join(roots[kind],file))) digest.update(bytes);
    if(digest.digest('hex')!==verifiedHashes[key]) throw Error('Unexpected local ASR version: '+file);
  }
}
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png',
  '.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.wasm':'application/wasm','.onnx':'application/octet-stream'};
const baseHeaders={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
function send(res,code,message){
  res.writeHead(code,{...baseHeaders,'Content-Type':'text/plain; charset=utf-8'});
  res.end(message);
}
async function fileUnder(dir,relative){
  if(!dir) return null;
  const file=await realpath(path.resolve(dir,relative));
  const diff=path.relative(dir,file);
  if(!diff || diff.startsWith('..'+path.sep) || diff==='..' || path.isAbsolute(diff)) return null;
  return file;
}
async function serveFile(req,res,dir,name){
  const file=await fileUnder(dir,name);
  if(!file) return send(res,404,'File unavailable');
  const info=await stat(file);
  if(!info.isFile()) return send(res,404,'File unavailable');
  res.writeHead(200,{...baseHeaders,'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':info.size});
  if(req.method==='HEAD') return res.end();
  createReadStream(file).on('error',()=>res.destroy()).pipe(res);
}
async function forward(req,res,upstream){
  res.writeHead(upstream.status,{...Object.fromEntries(upstream.headers),...baseHeaders});
  res.end(req.method==='HEAD'?undefined:Buffer.from(await upstream.arrayBuffer()));
}
const liveDay=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'});
function validateLiveManifest(manifest) {
  const date=manifest?.date;
  const dateTime=value=>typeof value==='string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? Date.parse(value) : NaN;
  function secureUrl(value) {
    if (typeof value!=='string') throw Error('Missing live source URL');
    const url=new URL(value);
    if (url.protocol!=='https:' || url.username || url.password || url.hash) throw Error('Invalid live source URL');
    return url;
  }
  if (typeof date!=='string' || !/^\d{4}-\d\d-\d\d$/.test(date) ||
      !Array.isArray(manifest.meetings) || !manifest.meetings.length) throw Error('Incomplete live manifest');
  const ids=new Set();
  for (const row of manifest.meetings) {
    const {id,title,scheduledAt,endsAt}=row||{};
    const start=dateTime(scheduledAt),end=dateTime(endsAt);
    if (typeof id!=='string' || !/^[1-9]\d{0,7}$/.test(id) || ids.has(id) || typeof title!=='string' || !title.trim() ||
        !Number.isFinite(start) || !Number.isFinite(end) || !(end>start) || liveDay.format(start)!==date ||
        (row.agenda!=null && !Array.isArray(row.agenda)) ||
        (row.members!=null && !Array.isArray(row.members)) ||
        (row.staffRoster!=null && !Array.isArray(row.staffRoster))) throw Error('Invalid live meeting');
    const official=secureUrl(row.officialPage), source=secureUrl(row.source);
    if (official.origin!=='https://cast.sncouncil.go.kr' || official.pathname!=='/live/flashPlayer.jsp' ||
        official.searchParams.getAll('live_no').join(',')!==id) throw Error('Invalid official live page');
    if (row.provider==='youtube') {
      if (!/^[\w-]{11}$/.test(row.youtubeId || '') || source.origin!=='https://www.youtube.com' ||
          source.pathname!=='/watch' || source.searchParams.getAll('v').join(',')!==row.youtubeId) throw Error('Invalid YouTube meeting');
    } else {
      const playlist=secureUrl(row.playlist);
      if ((row.provider!=null && row.provider!=='hls') || source.href!==official.href ||
          playlist.origin!=='https://cast.sncouncil.go.kr:4443' || playlist.search ||
          !/^\/live\/ch\d+\.sdp\/playlist\.m3u8$/.test(playlist.pathname)) throw Error('Invalid HLS meeting');
    }
    ids.add(id);
  }
  if (manifest.defaultMeetingId!=null && !ids.has(String(manifest.defaultMeetingId))) throw Error('Unknown default live meeting');
}

let liveCatalog, readingCatalog;
const rememberedMeetings=new Map();
function playbackSite(meetings) {
  return createSite({assets:{},meetings,archiveMeetings:[...archiveMeetings,...rememberedMeetings.values()],publicKey:'',
    attributeSpeakers:speaker.attribute,validateAcousticProof:speaker.acousticProof,validatePodiumProof:speaker.podiumProof});
}

// Retain recently displayed days for record links and their local captures across midnight.
const displayedDays=new Map();
async function previewSchedule(local,id) {
  const today=liveDay.format(Date.now());
  if (id) {
    for (const {catalog} of displayedDays.values()) {
      if (catalog.date<today && catalog.meetings.some(row=>row.id===id)) return catalog;
    }
    const saved=rememberedMeetings.get(id);
    if (saved) {
      const date=liveDay.format(Date.parse(saved.scheduledAt));
      if (date<today) {
        if (local.manifest.date===date && local.manifest.meetings.some(row=>row.id===id)) return local.manifest;
        return {date,meetings:[...rememberedMeetings.values()].filter(row=>liveDay.format(Date.parse(row.scheduledAt))===date)};
      }
    }
  }
  // A playback-only session can open its existing captures without consulting the official schedule.
  local.daily ??= Promise.all([import('../worker/schedule.mjs'),import('../worker/daily-catalog.mjs'),
    readJson(new URL('../worker/schedule-seeds.json',import.meta.url))]).then(([official,cache,datedSeeds])=>
    cache.createDailyCatalog({load:(date,roster,now)=>official.loadOfficialSchedule(date,fetch,roster,now),
      mirror:cache.readScheduleMirror,seed:local.manifest,datedSeeds}));
  const daily=await local.daily;
  try { return await (id ? daily.forId(undefined,id) : daily.today()); }
  catch (error) {
    const last=displayedDays.get(today)?.catalog;
    if (last && (!id || last.meetings.some(row=>row.id===id))) return {...last,cached:true};
    throw error;
  }
}
async function refreshLiveCatalog() {
  const raw=await readFile(liveManifestPath,'utf8');
  if (liveCatalog?.raw===raw) return liveCatalog;
  const manifest=JSON.parse(raw.replace(/^\uFEFF/,''));
  validateLiveManifest(manifest);
  for(const row of manifest.meetings) rememberedMeetings.set(row.id,row);
  const history=[...rememberedMeetings.values()].sort((a,b)=>Date.parse(b.scheduledAt)-Date.parse(a.scheduledAt));
  for(const old of history.slice(256)) rememberedMeetings.delete(old.id);
  return liveCatalog={raw,manifest,site:playbackSite(manifest.meetings)};
}
function currentLiveCatalog() {
  readingCatalog ??= refreshLiveCatalog().catch(error=>{
    if (liveCatalog) return liveCatalog;
    throw error;
  }).finally(()=>{readingCatalog=null;});
  return readingCatalog;
}
await currentLiveCatalog();

function captureBucket() {
  const files = new Map();
  return {
    async list({cursor}) {
      const names = roots.captures ? (await readdir(roots.captures)).filter(n=>/^[1-9]\d{0,7}\.json$/.test(n)).sort() : [];
      const offset = Number(cursor || 0), slice = names.slice(offset, offset+1000), next = offset+slice.length;
      return {objects:slice.map(n=>({key:'council-captions/'+n})), truncated:next<names.length, cursor:String(next)};
    },
    async get(key) {
      const match = /^council-(captions|nameplates)\/([1-9]\d{0,7})\.json$/.exec(key);
      if (!match || !roots.captures) return null;
      const id = match[2];
      if (!files.has(id)) {
        try {
          const file = await fileUnder(roots.captures, id+'.json');
          files.set(id, file ? await readJson(file) : null);
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
          files.set(id, null);
        }
      }
      const capture = files.get(id);
      const body = match[1] === 'captions' ? capture?.minutes : capture?.plates;
      return body?.meetingId === id ? {body:JSON.stringify(body)} : null;
    },
  };
}
const server=http.createServer(async(req,res)=>{
  try{
    if(![host+':'+port,'localhost:'+port].includes(req.headers.host)) return send(res,400,'Invalid local host');
    if(!['GET','HEAD'].includes(req.method)) return send(res,405,'This preview is read-only');
    const url=new URL(req.url,origin);
    if(url.origin!==origin) return send(res,400,'Invalid local URL');
    const route=url.pathname;
    if ((route==='/' || route==='/index.html') && roots['asr-model'] && !url.searchParams.has('asr')) {
      url.searchParams.set('asr','hybrid');
      res.writeHead(307,{...baseHeaders,Location:url.pathname+url.search});
      return res.end();
    }
    if(route==='/api/local-preview/status'){
      const allowed=['null','http://127.0.0.1:48193','http://localhost:48193'];
      const statusHeaders={'Vary':'Origin'};
      if(allowed.includes(req.headers.origin)) statusHeaders['Access-Control-Allow-Origin']=req.headers.origin;
      return forward(req,res,Response.json({app:'seongnam-council-caption-preview',
        hybridAssets:Boolean(roots['asr-runtime'] && roots['asr-model'])},{headers:statusHeaders}));
    }
    if(route==='/api/local-preview') return forward(req,res,Response.json({app:'seongnam-council-caption-preview',
      installationId,localCaptures:Boolean(roots.captures),hybridAssets:Boolean(roots['asr-runtime'] && roots['asr-model'])}));
    if(route==='/data/vod-index.json') return await forward(req,res,Response.json(indexData));
    if(route==='/data/live-meetings.json') return await forward(req,res,Response.json((await currentLiveCatalog()).manifest));
    if(route==='/api/live/schedule') {
      const ids=url.searchParams.getAll('meetingId');
      if ([...url.searchParams.keys()].some(k=>k!=='meetingId') || ids.length>1 || (ids.length && !/^[1-9]\d{0,7}$/.test(ids[0])))
        return send(res,400,'Invalid meeting');
      const local=await currentLiveCatalog();
      let catalog;
      try { catalog=await previewSchedule(local,ids[0]); }
      catch { return send(res,503,'Official schedule unavailable'); }
      if (!catalog) return send(res,404,'Unknown meeting');
      if (displayedDays.get(catalog.date)?.catalog!==catalog) {
        displayedDays.delete(catalog.date);
        displayedDays.set(catalog.date,{catalog,site:playbackSite(catalog.meetings)});
        if (displayedDays.size>14) displayedDays.delete(displayedDays.keys().next().value);
      }
      return forward(req,res,Response.json(catalog));
    }
    if(route==='/api/vod/resolve') {
      const {manifest}=await currentLiveCatalog();
      return await forward(req,res,await resolveVod(new Request(url),fetch,vodIndex,manifest.meetings,rosters,registeredStaff));
    }
    if(route==='/api/vod/transcript') return forward(req,res,await resolveVodTranscript(new Request(url),fetch));
    const liveRoute = ['/api/live/minutes','/api/live/nameplates','/api/live/captions'].includes(route);
    if (liveRoute || route.startsWith('/api/archive/')) {
      if (liveRoute) {
        const ids = url.searchParams.getAll('meetingId');
        if (ids.length !== 1 || !/^\d{1,8}$/.test(ids[0]) || [...url.searchParams.keys()].some(k=>k!=='meetingId'))
          return send(res,400,'Invalid meeting');
      }
      const local=await currentLiveCatalog();
      const id=url.searchParams.get('meetingId');
      const displayed=liveRoute && [...displayedDays.values()].find(({catalog})=>catalog.meetings.some(row=>row.id===id));
      const site=displayed?.site || local.site;
      return forward(req,res,await site.fetch(new Request(url,{method:req.method}),{BUCKET:captureBucket()}));
    }
    if(route.startsWith('/asr-local/')){
      const key=route.slice('/asr-local/'.length);
      if(!Object.hasOwn(modelFiles,key)) return send(res,404,'Model asset unavailable');
      const [kind,name]=modelFiles[key];
      return await serveFile(req,res,roots[kind],name);
    }
    const name=route==='/'?'index.html':decodeURIComponent(route.slice(1));
    if(!name.split('/').every(chunk=>/^[a-zA-Z\d_-][a-zA-Z\d_.-]*$/.test(chunk)) || name.startsWith('server/') ||
        !Object.hasOwn(types,path.extname(name))) return send(res,404,'File unavailable');
    return await serveFile(req,res,roots.dist,name);
  } catch(error){
    if(res.headersSent) return res.destroy();
    if(error?.code==='ENOENT' || error?.code==='ENOTDIR') return send(res,404,'File unavailable');
    return send(res,500,'Unable to open the requested preview resource');
  }
});
server.listen(port,host,()=>console.log('성남시의회 자막 미리보기  '+origin+'/'));

