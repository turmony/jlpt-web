import {mkdir,copyFile,readdir,readFile,writeFile,cp,chmod,rm,link,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const output=resolve(process.argv[2] || resolve(root,'server-public'));
await mkdir(resolve(output,'grammar'),{recursive:true});
const includeChat=source=>!source.endsWith('uno-config.mjs') && !source.endsWith('.map');
// Local previews read the existing build. Published releases keep independent
// copies so a later frontend build cannot change the live site or rollback.
async function shareChat(source,target) {
  await mkdir(target,{recursive:true});
  for(const entry of await readdir(source,{withFileTypes:true})) {
    const from=resolve(source,entry.name),to=resolve(target,entry.name);
    if(!includeChat(from)) continue;
    if(entry.isDirectory()) await shareChat(from,to);
    else {
      await rm(to,{force:true});
      await link(from,to);
    }
  }
}
if(output===resolve(root,'server-public')) {
  if((await lstat(output)).isSymbolicLink()) throw new Error('Local server-public must be a real directory');
  await shareChat(resolve(root,'chat/dist'),output);
} else await cp(resolve(root,'chat/dist'),output,{recursive:true,filter:includeChat});
await mkdir(resolve(output,'licenses'),{recursive:true});
await copyFile(resolve(root,'vendor/aionui/LICENSE'),resolve(output,'licenses/AionUi.txt'));
await copyFile(resolve(root,'vendor/aionui/README.md'),resolve(output,'licenses/AionUi-source.md'));
for(const name of await readdir(resolve(root,'web'))) await copyFile(resolve(root,'web',name),resolve(output,name));
for(const name of await readdir(resolve(root,'mobile'))) {
  if(/\.(html|css|mjs|svg)$/.test(name) && name!=='image-proxy.mjs') await copyFile(resolve(root,'mobile',name),resolve(output,'grammar',name));
}
await copyFile(resolve(root,'data/catalog.json'),resolve(output,'grammar/catalog.json'));
const page=await readFile(resolve(output,'grammar/index.html'),'utf8');
await writeFile(resolve(output,'grammar/index.html'),page.replace('<main class="shell">','<main class="shell"><nav aria-label="学习导航"><a href="/">智能体练习</a></nav>'));
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
