import { readFile, writeFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCoreMarkdown } from './build-core.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'public');
const catalogText = await readFile(resolve(root, 'data/catalog.json'), 'utf8');
const catalog = JSON.parse(catalogText);
const manifest = {};
const prefix = `./images/${catalog.revision}/`;
for (const card of catalog.cards) {
  for (const url of Object.values(card.images)) {
    if (url === null) continue;
    if (!url.startsWith(prefix)) throw new Error(`Unexpected image path: ${url}`);
    manifest['/' + decodeURIComponent(url.slice(2))] =
      `https://raw.githubusercontent.com/${catalog.repository}/${catalog.revision}/jlpt-notes/` + url.slice(prefix.length);
  }
}
await mkdir(output, { recursive: true });
for (const name of await readdir(resolve(root, 'mobile'))) {
  if ((/\.(html|css|mjs|svg)$/.test(name) || name === '_headers') && name !== 'image-proxy.mjs') {
    await copyFile(resolve(root, 'mobile', name), resolve(output, name));
  }
}
const proxy = await readFile(resolve(root, 'mobile/image-proxy.mjs'), 'utf8');
await buildCoreMarkdown(output);
await writeFile(resolve(output, '_worker.js'), 'export const imageManifest = ' + JSON.stringify(manifest) + ';\n' + proxy + '\nexport default createImageProxy(imageManifest);\n');
await writeFile(resolve(output, '_routes.json'), JSON.stringify({ version: 1, include: ['/images/*'], exclude: [] }) + '\n');
await writeFile(resolve(output, 'catalog.json'), catalogText);
await writeFile(resolve(output, '.nojekyll'), '');
console.log(`Built ${catalog.cards.length} cards, ${Object.keys(manifest).length} on-demand image URLs → public/`);
