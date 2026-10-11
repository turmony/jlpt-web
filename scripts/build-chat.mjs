import {build} from 'esbuild';
import {resolve,dirname,extname,relative} from 'node:path';
import {existsSync,readFileSync,mkdirSync,copyFileSync,writeFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {applyBridgePolicy} from '../agent/bridge-policy.mjs';
const root=resolve(import.meta.dirname,'..'), vendor=resolve(root,'vendor/aionui');
const source=process.env.JLPT_AIONUI_SOURCE;
const debugBuild=process.env.JLPT_DEBUG_BUILD==='1';
if(!debugBuild) {
  const {readdirSync,unlinkSync}=await import('node:fs');
  for(const directory of ['chat/dist','agent/dist']) {
    const path=resolve(root,directory);
    if(existsSync(path)) for(const name of readdirSync(path)) if(name.endsWith('.map')) unlinkSync(resolve(path,name));
  }
}
const manifestPath=resolve(vendor,'manifest.json');
const previous=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,'utf8')).files:[];
const adaptations={
  'src/renderer/pages/conversation/Messages/components/MessageText.tsx':'Optional application workTime metadata is shown in the assistant footer; user and assistant message timestamps remain visible without hover.',
  'src/renderer/components/chat/sendbox.tsx':'Optional DOM ids, sendDisabled, clearOnSend, enableBuiltinCommands and inlineReplyQuote props preserve exact JLPT input and direct sending; accessible send label.',
  'src/process/agent/acp/AcpConnection.ts':'Use ACP selected/reject-option and cancelled outcomes; rejected is invalid in the maintained bridge SDK.',
};
function ensure(file) {
  if(!existsSync(file) && source && file.startsWith(vendor+'/')) {
    const upstream=resolve(source,relative(vendor,file));
    if(existsSync(upstream) && statSync(upstream).isFile()) {mkdirSync(dirname(file),{recursive:true});copyFileSync(upstream,file);}
  }
  return existsSync(file) && statSync(file).isFile();
}
function resolveSource(base) {
  for(const file of [base,...['.ts','.tsx','.mjs','.js','.css','.json','.svg'].map(ext=>base+ext),...['index.ts','index.tsx'].map(name=>resolve(base,name))]) if(ensure(file)) return file;
  throw new Error('Missing vendored module '+relative(root,base));
}
const backendBindings = new Set(['@/common','@/common/platform','@process/utils/shellEnv','@process/services/ccSwitchModelSource','@process/utils/mainLogger']);
const frontendBindings = new Map([
  ['@/common','chat/bridge.ts'],['@office-ai/platform','chat/bridge.ts'],['@/common/config/storage','chat/bridge.ts'],
  ['@/common/adapter/ipcBridge','chat/bridge.ts'],
  ['@/renderer/pages/conversation/Preview','chat/preview.tsx'],['@/renderer/hooks/file/usePreviewLauncher','chat/preview.tsx'],
  ['@/renderer/pages/conversation/Messages/hooks','chat/controller.ts'],
  ...['useConversationExport','useDragUpload','usePasteService','useAutoPreviewOfficeFiles','useUploadState'].map(name=>['@/renderer/hooks/file/'+name,'chat/features.tsx']),
  ['@/renderer/services/FileService','chat/features.tsx'],
  ['@/renderer/components/chat/SpeechInputButton','chat/features.tsx'],['@/renderer/components/media/UploadProgressBar','chat/features.tsx'],
]);
function upstreamPlugin(platform) {
  return {name:'aionui-source',setup(build) {
    build.onResolve({filter:/.*/},args=>{
      if(platform==='node' && backendBindings.has(args.path)) return {path:resolve(root,'agent/platform.ts')};
      const normalized=args.path.startsWith('@renderer/')?'@/renderer/'+args.path.slice(10):args.path;
      if(platform==='browser' && frontendBindings.has(normalized)) return {path:resolve(root,frontendBindings.get(normalized))};
      if(platform==='browser' && args.path.startsWith('.')) {
        const absolute=resolve(args.resolveDir,args.path).replace(/\.(tsx?|mjs|js)$/, '');
        for(const [key,binding] of frontendBindings) {
          if(key.startsWith('@/') && absolute===resolve(vendor,'src',key.slice(2))) return {path:resolve(root,binding)};
        }
      }
      if(platform==='browser' && args.path.startsWith('.') && resolve(args.resolveDir,args.path)===resolve(vendor,'src/common/adapter/ipcBridge')) return {path:resolve(root,'chat/bridge.ts')};
      if(args.path.startsWith('@/') || args.path.startsWith('@renderer/') || args.path.startsWith('@process/')) {
        const suffix=args.path.startsWith('@/')?args.path.slice(2):args.path.slice(1);
        return {path:resolveSource(resolve(vendor,'src',suffix))};
      }
      if(args.path.startsWith('.') && (args.importer.startsWith(vendor) || resolve(args.resolveDir,args.path).startsWith(vendor))) return {path:resolveSource(resolve(args.resolveDir,args.path))};
    });
  }};
}
mkdirSync(vendor,{recursive:true});
for(const name of ['LICENSE','uno.config.ts']) ensure(resolve(vendor,name));
await build({entryPoints:[resolve(root,'agent/runner.ts')],outfile:resolve(root,'agent/dist/runner.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',plugins:[upstreamPlugin('node')],sourcemap:debugBuild});
const bridgeEntry=createRequire(import.meta.url).resolve('@agentclientprotocol/codex-acp');
writeFileSync(resolve(root,'agent/dist/codex-acp.mjs'),applyBridgePolicy(readFileSync(bridgeEntry,'utf8')));
copyFileSync(resolve(dirname(bridgeEntry),'../LICENSE'),resolve(root,'agent/dist/codex-acp-LICENSE.txt'));
if(existsSync(resolve(root,'chat/main.tsx'))) {
  await build({entryPoints:[resolve(root,'chat/main.tsx')],outfile:resolve(root,'chat/dist/chat.mjs'),bundle:true,platform:'browser',format:'esm',target:'es2022',plugins:[upstreamPlugin('browser')],loader:{'.svg':'file','.png':'file','.jpg':'file','.woff':'file','.woff2':'file','.ttf':'file'},assetNames:'assets/[name]-[hash]',minify:true,sourcemap:debugBuild});
  await build({entryPoints:[resolve(vendor,'uno.config.ts')],outfile:resolve(root,'chat/dist/uno-config.mjs'),bundle:true,platform:'node',format:'esm',packages:'external'});
  const {createGenerator}=await import('unocss');
  const config=(await import('../chat/dist/uno-config.mjs')).default;
  const generator=await createGenerator(config);
  const {readdirSync}=await import('node:fs');
  const walk=dir=>readdirSync(dir).flatMap(name=>{const file=resolve(dir,name);return statSync(file).isDirectory()?walk(file):[file];});
  const sources=walk(resolve(vendor,'src/renderer')).filter(file=>/\.(tsx?|css)$/.test(file)).map(file=>readFileSync(file,'utf8')).join('\n');
  const generated=await generator.generate(sources);
  const css=resolve(root,'chat/dist/chat.css');
  writeFileSync(css,generated.css+'\n'+readFileSync(css,'utf8'));
}
const {readdirSync}=await import('node:fs');
const walk=dir=>readdirSync(dir).flatMap(name=>{const file=resolve(dir,name);return statSync(file).isDirectory()?walk(file):[file];});
const files=walk(vendor).filter(file=>!file.endsWith('manifest.json')).map(file=>{
  const path=relative(vendor,file),sha256=createHash('sha256').update(readFileSync(file)).digest('hex');
  const original=source && resolve(source,path);
  const upstream_sha256=original && existsSync(original)?createHash('sha256').update(readFileSync(original)).digest('hex'):previous.find(item=>item.path===path)?.upstream_sha256;
  if(upstream_sha256 && sha256!==upstream_sha256 && !adaptations[path]) throw new Error('Unexpected change to upstream source: '+path);
  return {path,sha256,...(upstream_sha256?{upstream_sha256}:{}),...(adaptations[path]?{adaptation:adaptations[path]}:{})};
});
writeFileSync(resolve(vendor,'manifest.json'),JSON.stringify({repository:'https://github.com/iOfficeAI/AionUi',version:'v1.9.25',commit:'bbada2a9268060d2b41ddf1d885a9b27ecd2103d',files},null,2)+'\n');
console.log('Built upstream Codex ACP runner');
