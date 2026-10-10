import {mkdir,copyFile,readdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const output=resolve(process.argv[2] || resolve(root,'server-public'));
await mkdir(resolve(output,'grammar'),{recursive:true});
for(const name of await readdir(resolve(root,'web'))) await copyFile(resolve(root,'web',name),resolve(output,name));
for(const name of await readdir(resolve(root,'mobile'))) {
  if(/\.(html|css|mjs|svg)$/.test(name) && name!=='image-proxy.mjs') await copyFile(resolve(root,'mobile',name),resolve(output,'grammar',name));
}
await copyFile(resolve(root,'data/catalog.json'),resolve(output,'grammar/catalog.json'));
const page=await readFile(resolve(output,'grammar/index.html'),'utf8');
await writeFile(resolve(output,'grammar/index.html'),page.replace('<main class="shell">','<main class="shell"><nav aria-label="学习导航"><a href="/">智能体练习</a></nav>'));
console.log(`Built server site → ${output}`);
