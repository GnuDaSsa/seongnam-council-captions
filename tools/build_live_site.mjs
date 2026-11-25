import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {join, relative, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
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
  const hash = createHash('sha256').update(Buffer.from(asset.body, 'base64')).digest('hex').slice(0,12);
  return `${attr}="./${path}?v=${hash}"`;
});
entry.body = Buffer.from(versionedHtml, 'utf8').toString('base64');
const catalog = JSON.parse(await readFile(join(dist, 'data/live-meetings.json'), 'utf8'));
const publicKey = (await readFile(join(root, 'worker/publisher.pub'), 'utf8')).trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(publicKey)) throw Error('Invalid Ed25519 public key');
const worker = await readFile(join(root, 'worker/captions.mjs'), 'utf8');
const vodResolver = await readFile(join(root,'worker/vod.mjs'),'utf8');
const vodIndex = JSON.parse(await readFile(join(dist,'data/vod-index.json'),'utf8')).meetings;
// The portable Sites artifact is a single Worker ES module. Register the same
// plain scripts the live player uses in a private namespace at build time.
const speakerSources = await Promise.all(['speaker-review.js','nameplate-review.js','live-speaker.js']
  .map(file => readFile(join(dist,file),'utf8')));
const speakerRegistry = 'const speakerModel = (() => { const window = {}, module = undefined;\n' +
  speakerSources.join('\n') + '\nreturn window.CouncilLiveSpeaker; })();\n';
const siteConfig = JSON.stringify({assets, meetings:catalog.meetings, publicKey});
await mkdir(join(dist, 'server'), {recursive:true});
await writeFile(join(dist, 'server/index.js'), worker + '\n' + vodResolver + '\n' + speakerRegistry +
  'const vodIndex = new Map('+JSON.stringify(vodIndex)+'.map(row => [row.id,row]));\n' +
  'export default createSite({...'+ siteConfig +', attributeSpeakers:speakerModel.attribute, resolveArchiveVideo:req => resolveVod(req,fetch,vodIndex)});\n');
console.log('Packaged', Object.keys(assets).length, 'assets and', catalog.meetings.length, 'meetings');
