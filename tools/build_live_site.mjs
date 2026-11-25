import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {join, relative, extname} from 'node:path';
import {fileURLToPath} from 'node:url';

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
const catalog = JSON.parse(await readFile(join(dist, 'data/live-meetings.json'), 'utf8'));
const publicKey = (await readFile(join(root, 'worker/publisher.pub'), 'utf8')).trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(publicKey)) throw Error('Invalid Ed25519 public key');
const worker = await readFile(join(root, 'worker/captions.mjs'), 'utf8');
await mkdir(join(dist, 'server'), {recursive:true});
await writeFile(join(dist, 'server/index.js'), worker + '\nexport default createSite(' + JSON.stringify({assets, meetings:catalog.meetings, publicKey}) + ');\n');
console.log('Packaged', Object.keys(assets).length, 'assets and', catalog.meetings.length, 'meetings');
