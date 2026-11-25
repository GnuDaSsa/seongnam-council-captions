import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
const root = process.cwd();
const dist = join(root, 'dist');
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.ico':'image/x-icon', '.wasm':'application/wasm', '.vtt':'text/vtt; charset=utf-8' };
const assets = {};
async function collect(dir) {
  for (const entry of await readdir(dir, {withFileTypes:true})) {
    if (entry.name.startsWith('.') || (dir === dist && entry.name === 'server')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) {
      const key = '/' + relative(dist, path).replaceAll('\\', '/');
      assets[key] = {type:types[extname(path).toLowerCase()] || 'application/octet-stream', body:(await readFile(path)).toString('base64')};
    }
  }
}
await collect(dist);
const hash = (await readFile(join(root, '.openai', 'live-write.sha256'), 'utf8')).trim();
if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid live write hash');
const template = await readFile(join(root, 'worker', 'live.mjs'), 'utf8');
const bundle = template.replace('__LIVE_WRITE_HASH__', JSON.stringify(hash)).replace('__STATIC_ASSETS__', JSON.stringify(assets));
await mkdir(join(dist, 'server'), {recursive:true});
await writeFile(join(dist, 'server', 'index.js'), bundle);
console.log(`Bundled ${Object.keys(assets).length} static files and live worker`);
