import {readFile, mkdir, open, unlink} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadOfficialSchedule} from '../worker/schedule.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function parseArgs(args) {
  const options={};
  for (let i=0;i<args.length;i++) {
    if (!['--if','--output'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw Error('Usage: node tools/refresh_schedule.mjs --output NEW_FILE [--if EXISTING]');
    options[args[i].slice(2)]=args[++i];
  }
  if (!options.output) throw Error('Missing --output');
  return options;
}
async function jsonFile(path,optional=false) {
  try { return JSON.parse(await readFile(path,'utf8')); }
  catch(e) { if (optional && e.code==='ENOENT') return null; throw e; }
}
export async function refresh(options,{fetcher=fetch, now=new Date()}={}) {
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const manifest=await jsonFile(resolve(root,'dist/data/live-meetings.json'));
  const seeds=await jsonFile(resolve(root,'worker/schedule-seeds.json'));
  const prior=options.if ? await jsonFile(resolve(options.if),true) : null;
  const candidates=[...(prior?.meetings || []), ...(Array.isArray(seeds)?seeds.flatMap(s=>s.meetings||[]):[]), ...(manifest.meetings||[])];
  const roster = [...new Map(candidates.map(row => [JSON.stringify(row), row])).values()];
  const catalog=await loadOfficialSchedule(date,fetcher,roster,now);
  if (catalog?.date!==date || !Array.isArray(catalog.meetings) || typeof catalog.schedule!=='string' || !Object.hasOwn(catalog,'sessionTitle')) throw Error('Invalid official schedule');
  const body = JSON.stringify(catalog, null, 2) + '\n';
  const output = resolve(options.output);
  await mkdir(dirname(output), {recursive:true});
  const handle = await open(output, 'wx');
  try {
    try {
      await handle.writeFile(body, 'utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Exclusive creation succeeded, so an existing destination never reaches cleanup.
    await unlink(output);
    throw error;
  }
  return catalog;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { const result=await refresh(parseArgs(process.argv.slice(2))); console.log(`Saved ${result.date} schedule (${result.meetings.length} meetings)`); }
  catch(e) { console.error('Schedule refresh failed:',e.message); process.exitCode=1; }
}
