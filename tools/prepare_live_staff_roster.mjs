import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {withPriorLiveStaffRoster} from '../worker/vod.mjs';

const defaultRosters=new URL('../dist/data/vod-rosters.json',import.meta.url);
const defaultRegisteredStaff=new URL('../dist/data/registered-vod-staff.json',import.meta.url);
const usage=`Usage: node tools/prepare_live_staff_roster.mjs --manifest LIVE_MEETINGS_JSON --id ID --date YYYY-MM-DD --body COMMITTEE --output NEW_JSON
Optional: --rosters VOD_ROSTERS_JSON --registered-vod-staff REGISTERED_VOD_STAFF_JSON

Use the exact same-day official live manifest and committee name. The command writes
a separate new manifest for review and checks the source dates. Existing confirmed
staff entries take precedence. A prior candidate cannot establish current attendance.

After reviewing the prepared manifest, place that exact file at dist/data/live-meetings.json
for both the normal Worker build and tools/shared_stt.py. This command does not publish.`;

const {values}=parseArgs({options:{manifest:{type:'string'},id:{type:'string'},date:{type:'string'},
  body:{type:'string'},output:{type:'string'},rosters:{type:'string'},'registered-vod-staff':{type:'string'},help:{type:'boolean'}}});
if (values.help) {
  console.log(usage);
} else {
  const {manifest,id,date,body,output,rosters}=values;
  if (!manifest || !id || !date || !body || !output) throw Error(usage);
  const readJson=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
  const [source,snapshots,registeredStaff]=await Promise.all([readJson(manifest),readJson(rosters || defaultRosters),
    readJson(values['registered-vod-staff'] || defaultRegisteredStaff)]);
  if (source.date!==date || !Array.isArray(source.meetings)) throw Error('Manifest date and selected date must match');
  const eligible=source.meetings.filter(row=>String(row?.id)===id);
  if (eligible.length!==1) throw Error('Live ID is absent or ambiguous');
  const meeting=eligible[0];
  const next=withPriorLiveStaffRoster(meeting,snapshots,date,body,registeredStaff);
  const staff=next.staffRoster?.length ? next.staffRoster : next.registeredVodStaffRoster;
  if (next===meeting || !staff?.length) throw Error('No eligible prior staff candidates for this body, date and live source');
  const prepared={...source,meetings:source.meetings.map(row=>row===meeting ? next : row)};
  await writeFile(output,JSON.stringify(prepared,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({id,date,body,staffCandidates:staff.length,
    source:next.priorStaffRoster?.sourceUrl || next.registeredVodStaffRoster?.[0]?.sourceUrl,output}));
}
