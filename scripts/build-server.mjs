import {mkdir,copyFile,cp,readdir,readFile,writeFile,chmod} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {buildCoreMarkdown} from './build-core.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const output=resolve(process.argv[2] || resolve(root,'server-public'));
await mkdir(resolve(output,'grammar'),{recursive:true});
// Server-only pages, including the /review/ folder.
await cp(resolve(root,'web'),output,{recursive:true});
for(const name of await readdir(resolve(root,'mobile'))) {
  if(/\.(html|css|mjs|svg)$/.test(name) && name!=='image-proxy.mjs') await copyFile(resolve(root,'mobile',name),resolve(output,'grammar',name));
}
await copyFile(resolve(root,'data/catalog.json'),resolve(output,'grammar/catalog.json'));
await buildCoreMarkdown(resolve(output,'grammar'));
const page=await readFile(resolve(output,'grammar/index.html'),'utf8');
// Three links no longer fit beside the brand and the reader header on phones, so there they take their own row.
const navStyle='<style>.shell:has(> nav) .reader-header{padding-right:236px}@media(max-width:503px){.shell>nav{position:static;justify-content:flex-end;flex-wrap:wrap;margin-bottom:8px}.shell:has(> nav) .reader-header{padding-right:0}}</style>';
await writeFile(resolve(output,'grammar/index.html'),page.replace('</head>',navStyle+'<script src="/launch-home.js"></script></head>').replace('<main class="shell">','<main class="shell"><nav aria-label="学习导航"><a href="/review/">今日安排</a><a href="/papers.html">做题</a><a href="/code/">云开发</a></nav>'));
// Caddy runs as its own user. Deployment may inherit a restrictive umask;
// generated static files need the same read access as the existing web assets.
async function staticPermissions(directory) {
  await chmod(directory,0o755);
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=resolve(directory,entry.name);
    if(entry.isDirectory()) await staticPermissions(path);
    else if(entry.isFile()) await chmod(path,0o644);
  }
}
await staticPermissions(output);
console.log(`Built server site → ${output}`);
