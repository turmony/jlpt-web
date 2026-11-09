// Manual check against the REAL Yahoo News or Asahi Shimbun site (not part of any test run).
//   npm run build && node scripts/news_check.mjs [--site yahoo|asahi] [--per-feed N=2] [--feed slug]...
// Starts this site over HTTPS (self-signed certificate, real tokenizer, see news_check_server.py), takes
// topics from Yahoo's RSS, follows each topic to its first /articles/<hex> page, opens that page in
// Playwright WebKit (iPhone 15) with the installed userscript loader as an init script, waits for DOMContentLoaded and up to 20 s of `load`
// plus 10 s and prints one tab-separated row per article. Exit code 1 when an article failed or none was found.
// --site asahi takes articles from Asahi's headline RSS and opens each one twice: as an iPhone 15 (Asahi redirects
// it to /sp/articles/…) and as an iPad Pro 11 in landscape (desktop edition, /articles/…).
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(join(root,'mobile','package.json'));
const YAHOO_FEEDS=['top-picks','domestic','world','business','entertainment','sports','it','science'];
const ASAHI_FEEDS=['headlines'];
const PYTHON='/srv/jlpt/venv/bin/python';
// The default news_sites entries' `parts` (server/news_sites.py): what "found the article body" means.
const SITES={
  yahoo:{origin:'https://news.yahoo.co.jp',parts:['h1','.article_body'],feeds:YAHOO_FEEDS,devices:['iPhone 15']},
  asahi:{origin:'https://www.asahi.com',parts:['main#main h1','main#main div:has(> p):not(h1 ~ div *)'],feeds:ASAHI_FEEDS,devices:['iPhone 15','iPad Pro 11 landscape']},
};
const SETTLE=10000;                  // ms after `load` (or after LOAD_WAIT without it)
const MIN_BODY_CHARS=150;            // a body shorter than this is the wrong element (a date line is ~20 characters)
const LOAD_WAIT=20000;               // ms to wait for `load` after DOMContentLoaded
const TOPICS_TRIED=6;                // RSS items looked at per feed before giving up on finding N articles
const UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function usage(message){
  if(message) console.error(message);
  console.error('用法：node scripts/news_check.mjs [--site yahoo|asahi] [--per-feed N=2] [--feed slug]...\n'+
    Object.entries(SITES).map(([name,site])=>`${name} 的分类：${site.feeds.join(' ')}`).join('\n'));
  process.exit(2);
}
function parseArgs(argv){
  const options={site:'yahoo',perFeed:2,feeds:[]};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--per-feed'){
      const value=argv[++i];
      if(!/^[1-9][0-9]*$/.test(value??'')) usage('--per-feed 需要正整数');
      options.perFeed=Number(value);
    } else if(arg==='--site'){
      const name=argv[++i];
      if(!Object.hasOwn(SITES,name)) usage(`未知网站：${name}`);
      options.site=name;
    } else if(arg==='--feed'){
      options.feeds.push(argv[++i]);
    } else usage(`未知参数：${arg}`);
  }
  const known=SITES[options.site].feeds;
  for(const slug of options.feeds) if(!known.includes(slug)) usage(`${options.site} 没有分类：${slug}`);
  if(!options.feeds.length) options.feeds=known;
  return options;
}

async function get(url){
  const response=await fetch(url,{headers:{'User-Agent':UA,'Accept-Language':'ja,en;q=0.5'},signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error(`${url} 返回 ${response.status}`);
  return response.text();
}

// Up to `count` article URLs for one feed: RSS items are topics (or articles); a topic page links its article.
async function articlesOf(site,slug,count){
  if(site==='asahi') return asahiArticles(count);
  const xml=await get(`https://news.yahoo.co.jp/rss/topics/${slug}.xml`);
  const items=[...xml.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map(match=>match[1].trim());
  const found=[];
  for(const link of items.slice(0,TOPICS_TRIED)){
    if(found.length>=count) break;
    let article=link.match(/^https:\/\/news\.yahoo\.co\.jp\/articles\/[0-9a-f]+/)?.[0];
    if(!article&&/^https:\/\/news\.yahoo\.co\.jp\/pickup\/\d+/.test(link)){
      try{article=(await get(link)).match(/https:\/\/news\.yahoo\.co\.jp\/articles\/[0-9a-f]+/)?.[0];}catch{/* try the next topic */}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(article&&!found.includes(article)) found.push(article);
  }
  return found;
}

// Asahi's headline RSS links straight to articles (`?ref=rss` is dropped); the first item is the home page.
async function asahiArticles(count){
  const xml=await get('https://www.asahi.com/rss/asahi/newsheadlines.rdf');
  const found=[];
  for(const match of xml.matchAll(/<link>https?:\/\/www\.asahi\.com\/articles\/([A-Za-z0-9]+\.html)/g)){
    const url=`https://www.asahi.com/articles/${match[1]}`;
    if(!found.includes(url)) found.push(url);
    if(found.length>=count) break;
  }
  return found;
}

function freePort(){
  return new Promise((resolve,reject)=>{
    const probe=createServer();
    probe.once('error',reject);
    probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close(()=>resolve(port));});
  });
}

// Starts news_check_server.py; resolves {base, loader, stop}.
async function startServer(tmp){
  const execFileAsync=promisify(execFile);
  const cert=join(tmp,'cert.pem'),key=join(tmp,'key.pem');
  try{
    await execFileAsync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1']);
  }catch(error){throw new Error('生成自签证书失败（需要 openssl）：'+(error.stderr||error.message).toString().trim().split('\n').pop());}
  const port=await freePort();
  const child=spawn(PYTHON,['-I',join(root,'scripts','news_check_server.py'),join(tmp,'state'),String(port),cert,key],{stdio:['ignore','pipe','pipe']});
  const stop=()=>{if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL');};
  let stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  try{
    const line=await new Promise((resolve,reject)=>{
      let out='';
      const timer=setTimeout(()=>reject(new Error('服务 30 秒内没有启动')),30000);
      child.stdout.on('data',chunk=>{out+=chunk;const end=out.indexOf('\n');if(end>=0){clearTimeout(timer);resolve(out.slice(0,end));}});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error(`服务退出（${code}）：${stderr.trim()}`));});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    return {...JSON.parse(line),stop};
  }catch(error){stop();throw error;}
}

const oneLine=text=>String(text).replace(/\s+/g,' ').trim();
const clip=(text,n=160)=>text.length>n?text.slice(0,n)+'…':text;

async function check(browser,devices,loader,site,device,slug,url){
  const context=await browser.newContext({...devices[device],ignoreHTTPSErrors:true,locale:'ja-JP'});
  const row={slug:SITES[site].feeds.length>1?slug:device,url,body:'否',words:'-',rewraps:'-',status:'-',problems:[]};
  try{
    // Same test hook as the browser tests: the shadow roots are created open so the status can be read.
    await context.addInitScript(()=>{const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(init){return attach.call(this,{...init,mode:'open'});};});
    // Init scripts also run in the initial about:blank page and in every iframe (ads, widgets); a real userscript
    // has @match and @noframes, so only the top frame of a page of the site gets the loader.
    await context.addInitScript(`if(window===window.top&&location.origin===${JSON.stringify(SITES[site].origin)}){\n${loader}\n}`);
    const page=await context.newPage();
    let pageErrors=0,consoleErrors=0;
    const firstErrors=[];
    page.on('pageerror',error=>{pageErrors++;if(firstErrors.length<2) firstErrors.push('pageerror '+clip(oneLine(error.message),100));});
    page.on('console',message=>{if(message.type()==='error'){consoleErrors++;if(firstErrors.length<2) firstErrors.push('console '+clip(oneLine(message.text()),100));}});
    // Not `load`: a page with a tracker that hangs never reaches it (Asahi's desktop edition), and the script must
    // not depend on it. `load` is waited for a while longer, and a page that still has none is noted.
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    const loaded=await page.waitForLoadState('load',{timeout:LOAD_WAIT}).then(()=>true,()=>false);
    await page.waitForTimeout(SETTLE);
    const found=await page.evaluate(parts=>parts.every(selector=>document.querySelector(selector)),SITES[site].parts);
    // The edition the page really is (Asahi redirects an iPhone to /sp/): shown with the address.
    row.url=await page.evaluate(()=>location.origin+location.pathname);
    // The last part is the body: a page where the selector caught something else (a date line) is short.
    const chars=await page.evaluate(parts=>document.querySelector(parts.at(-1))?.textContent.trim().length??0,SITES[site].parts);
    row.body=found?`是（${chars} 字）`:'否';
    row.note=loaded?'':`（${LOAD_WAIT/1000} 秒内没有 load 事件）`;
    const html=await page.evaluate(()=>({...document.documentElement.dataset}));
    row.words=html.jlptWords??'-';
    row.rewraps=html.jlptRewraps??'-';
    const button=page.locator('jlpt-news .news-dock-button');
    row.status=await button.count()?oneLine(await button.first().textContent()):(await page.locator('jlpt-news-loader').count()?'加载器失败':'无状态');
    for(const text of await page.locator('jlpt-news .news-error-line').allTextContents()) row.problems.push(oneLine(text));
    for(const text of await page.locator('jlpt-news-loader .p').allTextContents()) row.problems.push(oneLine(text));
    if(pageErrors||consoleErrors) row.problems.push(`页面错误 ${pageErrors}、控制台错误 ${consoleErrors}`+(firstErrors.length?`（${firstErrors.join('；')}）`:''));
    // Counts as failed: no body, no marked words, no status, the dock reporting an error, or errors listed.
    row.failed=!found||chars<MIN_BODY_CHARS||!(Number(row.words)>0)||row.status!=='就绪'||row.problems.some(p=>!p.startsWith('页面错误'))
  }catch(error){
    row.problems.push('打开失败：'+clip(oneLine(error.message),160));
    row.failed=true;
  }finally{await context.close();}
  return row;
}

async function main(){
  const options=parseArgs(process.argv.slice(2));
  try{await access(join(root,'server-public','news-script','client.js'));}
  catch{console.error('server-public/news-script/client.js 不存在，请先运行 npm run build');process.exit(2);}
  try{await access(PYTHON);}
  catch{console.error(`找不到 ${PYTHON}（需要装有 fugashi 的新闻 venv）`);process.exit(2);}
  let webkit,devices;
  try{({webkit,devices}=require('playwright'));}
  catch{console.error('找不到 Playwright（应在 mobile/node_modules 里）：请先运行 npm ci --prefix mobile');process.exit(2);}
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-news-check-'));
  let server,browser,code=1;
  let cleaning; // one cleanup only, whether it comes from Ctrl-C/SIGTERM or from the end of the run
  const cleanup=()=>cleaning??=(async()=>{server?.stop();await browser?.close().catch(()=>{});await rm(tmp,{recursive:true,force:true});})();
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>cleanup().finally(()=>process.exit(130)));
  try{
    // The browser first: a missing WebKit binary is a setup problem (exit 2) found before the server is started.
    try{browser=await webkit.launch({handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false});} // our own handler cleans up
    catch(error){
      if(/Executable doesn't exist|playwright install/i.test(error.message)){
        throw Object.assign(new Error('Playwright 没有安装 WebKit 浏览器：请先运行 npm exec --prefix mobile -- playwright install webkit'),{setup:true});
      }
      throw error;
    }
    server=await startServer(tmp);
    console.log(['分类','地址','找到正文','词数','重包次数','状态','错误摘要'].join('\t'));
    let total=0,failed=0;
    for(const slug of options.feeds){
      let urls=[];
      try{urls=await articlesOf(options.site,slug,options.perFeed);}
      catch(error){console.log([slug,'-','否','-','-','-','取文章地址失败：'+clip(oneLine(error.message))].join('\t'));total++;failed++;continue;}
      if(!urls.length){console.log([slug,'-','否','-','-','-','没有取到文章地址'].join('\t'));total++;failed++;continue;}
      for(const url of urls) for(const device of SITES[options.site].devices){
        const row=await check(browser,devices,server.loader,options.site,device,slug,url);
        total++;if(row.failed) failed++;
        console.log([row.slug,row.url,row.body,row.words,row.rewraps,row.status,(row.problems.join(' | ')||'无')+(row.note||'')].join('\t'));
      }
    }
    console.log(`成功 ${total-failed} / 共 ${total}`);
    code=total>0&&failed===0?0:1;
  }catch(error){
    if(error.setup){console.error(error.message);code=2;}
    else console.error('抽查中止：'+error.message);
  }finally{await cleanup();}
  process.exit(code);
}
main();
