import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {join, relative, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {withPriorVodRoster} from '../worker/vod.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.png':'image/png'};
const assets = {};
async function collect(dir) {
  for (const entry of await readdir(dir, {withFileTypes:true})) {
    if (entry.name.startsWith('.') || (dir === dist && entry.name === 'server')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) {
      const key = '/' + relative(dist, path).replaceAll('\\', '/');
      assets[key] = {type:types[extname(path)] || 'application/octet-stream', body:(await readFile(path)).toString('base64')};
    }
  }
}
await collect(dist);
// Give browsers a new URL when a script or stylesheet changes between releases.
const entry = assets['/index.html'];
const html = Buffer.from(entry.body, 'base64').toString('utf8');
const versionedHtml = html.replace(/\b(src|href)="\.\/([^"?#]+\.(?:js|css))"/g, (match, attr, path) => {
  const asset = assets['/' + path];
  if (!asset) throw new Error('Missing page asset: ' + path);
  const digest = createHash('sha256').update(Buffer.from(asset.body, 'base64'));
  if (path === 'tab-captions.js') {
    for (const child of Object.keys(assets).filter(key=>key.startsWith('/asr/')).sort()) {
      digest.update(child);
      digest.update(Buffer.from(assets[child].body,'base64'));
    }
  }
  const hash = digest.digest('hex').slice(0,12);
  return `${attr}="./${path}?v=${hash}"`;
});
entry.body = Buffer.from(versionedHtml, 'utf8').toString('base64');
const catalog = JSON.parse(await readFile(join(dist, 'data/live-meetings.json'), 'utf8'));
const archiveCatalog = JSON.parse(await readFile(join(dist, 'data/archive-seed-meetings.json'), 'utf8'));
const publicKey = (await readFile(join(root, 'worker/publisher.pub'), 'utf8')).trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(publicKey)) throw Error('Invalid Ed25519 public key');
const worker = await readFile(join(root, 'worker/captions.mjs'), 'utf8');
const scheduleSource = await readFile(join(root,'worker/schedule.mjs'),'utf8');
const dailySource = await readFile(join(root,'worker/daily-catalog.mjs'),'utf8');
const datedSeeds = JSON.parse(await readFile(join(root,'worker/schedule-seeds.json'),'utf8'));
const vodResolver = await readFile(join(root,'worker/vod.mjs'),'utf8');
const vodRosters = JSON.parse(await readFile(join(dist,'data/vod-rosters.json'),'utf8'));
const registeredStaff = JSON.parse(await readFile(join(dist,'data/registered-vod-staff.json'),'utf8'));
const archiveIndex = JSON.parse(await readFile(join(dist,'data/vod-index.json'),'utf8'));
const vodIndex = archiveIndex.meetings.map(row=>withPriorVodRoster(row,vodRosters,registeredStaff));
assets['/data/vod-index.json'].body = Buffer.from(JSON.stringify({...archiveIndex,meetings:vodIndex}),'utf8').toString('base64');
// The portable Sites artifact is a single Worker ES module. Register the same
// plain scripts the live player uses in a private namespace at build time.
const speakerSources = await Promise.all(['speaker-policy.js','speaker-review.js','nameplate-review.js','live-speaker.js']
  .map(file => readFile(join(dist,file),'utf8')));
const speakerRegistry = 'const speakerModel = (() => { const window = {}, module = undefined;\n' +
  speakerSources.join('\n') + '\nreturn window.CouncilLiveSpeaker; })();\n';
const siteConfig = JSON.stringify({assets, meetings:catalog.meetings, archiveMeetings:archiveCatalog.meetings, publicKey});
await mkdir(join(dist, 'server'), {recursive:true});
await writeFile(join(dist, 'server/index.js'), worker + '\n' + vodResolver + '\n' + speakerRegistry +
  'const dailyCatalog=(()=>{\n' + scheduleSource.replace(/^export /gm,'') + '\n' + dailySource.replace(/^export /gm,'') +
  '\nreturn createDailyCatalog({load:(date,roster,now)=>loadOfficialSchedule(date,fetch,roster,now),mirror:readScheduleMirror,seed:' + JSON.stringify(catalog) + ',datedSeeds:' + JSON.stringify(datedSeeds) + '});})();\n' +
  'const vodIndex = new Map('+JSON.stringify(vodIndex)+'.map(row => [row.id,row]));\n' +
  'const vodRosters='+JSON.stringify(vodRosters)+';\n' +
  'const registeredVodStaff='+JSON.stringify(registeredStaff)+';\n' +
  'const siteConfig='+siteConfig+';\n' +
  'export default createSite({...siteConfig, dailyCatalog, attributeSpeakers:speakerModel.attribute, validateAcousticProof:speakerModel.acousticProof, validatePodiumProof:speakerModel.podiumProof, resolveArchiveVideo:req => resolveVod(req,fetch,vodIndex,siteConfig.meetings,vodRosters,registeredVodStaff), resolveArchiveTranscript:req => resolveVodTranscript(req,fetch)});\n');
console.log('Packaged', Object.keys(assets).length, 'assets and', catalog.meetings.length, 'meetings');
