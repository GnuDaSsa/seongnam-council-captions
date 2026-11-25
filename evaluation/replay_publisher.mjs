// Replay actual local producer payloads through the signed caption and minutes routes.
// Each recording has a fresh in-memory bucket and an ephemeral verification key.
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createSite} from '../worker/captions.mjs';
import speaker from '../dist/live-speaker.js';

function bucket() {
  const entries=new Map();
  return {
    async get(key){ return entries.get(key); },
    async put(key,body,options={}){
      const prior=entries.get(key);
      if ((options.onlyIf?.etagMatches && prior?.etag!==options.onlyIf.etagMatches) ||
          (prior && options.onlyIf?.get?.('if-none-match')==='*')) return null;
      const object={body,etag:String(Number(prior?.etag || 0)+1),customMetadata:options.customMetadata};
      entries.set(key,object);
      return object;
    }
  };
}

async function stream(dataset,mode) {
  const {meeting}=dataset, {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const env={BUCKET:bucket()}, causal=new Map();
  let clock, tail=[], lastClock=-Infinity;
  const worker=createSite({assets:{},meetings:[meeting],publicKey:publicKey.export({format:'jwk'}).x,
    attributeSpeakers:speaker.attribute,validateAcousticProof:speaker.acousticProof,validatePodiumProof:speaker.podiumProof},()=>clock);
  // The reserved host is only an input to the local Worker. No network fetch occurs.
  const base='https://replay.invalid/api/live/';
  const route=name=>base+name+'?meetingId='+encodeURIComponent(meeting.id);
  for(const batch of dataset.snapshots){
    clock=Date.parse(batch.clock);
    assert.ok(clock>lastClock,'producer clocks must strictly increase');
    lastClock=clock;
    const next=batch.newCues.map(cue=>{
      const {audioAnchor,audioContinuation,audioPodium,...text}=cue;
      if(mode==='text') return text;
      if(mode==='adjacent') return {...text,audioAnchor,audioContinuation};
      return cue;
    });
    tail=[...tail,...next].slice(-100);
    const body=JSON.stringify({meetingId:meeting.id,status:batch.status,updatedAt:batch.clock,cues:tail});
    const headers={'X-Council-Signature':sign(null,Buffer.from(body),privateKey).toString('base64url')};
    const saved=await worker.fetch(new Request(route('captions'),{method:'PUT',headers,body}),env);
    assert.equal(saved.status,204,await saved.text());
    const current=await worker.fetch(new Request(route('captions')),env);
    assert.equal(current.status,200);
    const {cues}=await current.json(), byId=new Map(cues.map(row=>[row.id,row]));
    for(const cue of next){
      const first=byId.get(cue.id);
      assert.ok(first,'every incoming cue must be visible in its originating batch');
      assert.equal(first.rawText,cue.rawText);
      causal.set(cue.id,first.speaker || null);
    }
  }
  const minutes=await worker.fetch(new Request(route('minutes')),env);
  assert.equal(minutes.status,200);
  const archive=(await minutes.json()).cues;
  assert.equal(archive.length,causal.size,'the meeting archive must contain every unique cue');
  return {causal,archive:new Map(archive.map(cue=>[cue.id,cue.speaker || null]))};
}

export async function evaluate(dataset) {
  const modes=['text','adjacent','all'], results={};
  for(const mode of modes) results[mode]=await stream(dataset,mode);
  const totals={}, differences=[], lateChanges=[];
  for(const m of modes) totals[m]={namedAtIngest:0,namedInMinutes:0};
  for(const cue of dataset.snapshots.flatMap(batch=>batch.newCues)){
    const names={}, archived={};
    for(const m of modes){
      names[m]=results[m].causal.get(cue.id)?.name || '';
      archived[m]=results[m].archive.get(cue.id)?.name || '';
      if(names[m]) totals[m].namedAtIngest++;
      if(archived[m]) totals[m].namedInMinutes++;
    }
    const evidence=results.all.causal.get(cue.id);
    if(new Set(Object.values(names)).size>1) differences.push({id:cue.id,start:cue.start,end:cue.end,text:cue.text,
      names,stage:cue.audioPodium?.stage || '',method:evidence?.method,evidence:evidence?.evidence});
    if(names.all!==archived.all) lateChanges.push({id:cue.id,start:cue.start,atIngest:names.all,inMinutes:archived.all});
  }
  return {sample:dataset.sample,split:dataset.split,policy:speaker.policyVersion,meetingId:dataset.meeting.id,
    cues:results.all.causal.size,totals,differences,lateChanges};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const [input,output]=process.argv.slice(2);
  if(!input || !output) throw Error('Usage: node evaluation/replay_publisher.mjs <publisher.json> <report.json>');
  const bytes=await readFile(input), dataset=JSON.parse(bytes);
  if(dataset.snapshots.some(batch=>batch.newCues.some(cue=>cue.audioPodium)) && !dataset.meeting.title)
    throw Error('Original meeting title is required to check plenary evidence');
  const report=await evaluate(dataset);
  report.inputSha256=createHash('sha256').update(bytes).digest('hex');
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({sample:report.sample,cues:report.cues,totals:report.totals,changed:report.differences.length}));
}
