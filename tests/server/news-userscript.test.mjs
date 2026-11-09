import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startFixture,hubScript,withSite} from './site-helper.mjs';
const require=createRequire(new URL('../../mobile/package.json',import.meta.url));
const {chromium,webkit,devices}=require('playwright');

test('the manage page prefills the device name from the user agent and links the install url',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url)=>{
  await page.goto(url+'/news-script/');
  const name=page.getByLabel('设备名称');
  assert.equal(await name.inputValue(),'iPhone');
  assert.equal(await name.getAttribute('maxlength'),'20');
  await name.fill('我的 iPad');
  const request=page.waitForRequest(request=>request.url().includes('/api/news/install/'));
  await page.getByRole('button',{name:'安装到这台设备'}).click();
  assert.equal((await request).url(),url+'/api/news/install/%E6%88%91%E7%9A%84%20iPad/jlpt-news.user.js');
}));

test('the download button saves jlpt-news.user.js with the token',()=>withSite(chromium,{locale:'zh-CN'},async(page,url)=>{
  await page.goto(url+'/news-script/');
  await page.getByLabel('设备名称').fill('书房');
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'下载脚本文件'}).click();
  const file=await download;
  assert.equal(file.suggestedFilename(),'jlpt-news.user.js');
  assert.match(await readFile(await file.path(),'utf8'),/@match/);
}));

test('the manage page lists devices and revokes one after confirming',()=>withSite(chromium,{locale:'zh-CN'},async(page,url)=>{
  for (const name of ['iPad','iPhone']) assert.equal((await page.request.get(`${url}/api/news/install/${name}/jlpt-news.user.js`)).status(),200);
  await page.goto(url+'/news-script/');
  const rows=page.locator('#device-list li');
  await rows.nth(1).waitFor();
  assert.equal(await rows.count(),2);
  assert.match(await rows.first().innerText(),/iPad.*安装 \d+\/\d+ \d\d:\d\d.*最近使用 未使用/s);
  const messages=[];
  page.on('dialog',dialog=>{messages.push(dialog.message());dialog.accept();});
  await rows.filter({hasText:'iPad'}).getByRole('button',{name:'作废'}).click();
  await page.locator('#device-list li').nth(1).waitFor({state:'detached'});
  assert.deepEqual(messages,['作废「iPad」后，这台设备上的脚本立即失效。']);
  assert.equal(await rows.count(),1);
  assert.match(await rows.first().innerText(),/iPhone/);
}));

const HEX='a1b2c3d4e5f60718';

// Opens the sample news site (another port, so a real cross-origin call) in a browser that has the
// installed userscript loader as an init script. run(page, {app, site, tmp, context}).
// hub: FakeHub script/spec, select: id of the stored model; name: the device name to install as.
async function withUserscript(device,run,{hub,select,name='iPad'}={}) {
  const hubFile=hub?await hubScript(hub):null;
  const fixture=await startFixture({...(hubFile?{NEWS_HUB_SCRIPT:hubFile.file}:{}),...(select?{NEWS_SELECTED_MODEL:select}:{})});
  const {url:app,site,tmp}=fixture;
  let browser;
  try {
    browser=await webkit.launch();
    const context=await browser.newContext({...devices[device],locale:'zh-CN'});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const login=await page.request.post(app+'/api/login',{data:{password:'browser-test-password'},headers:{Origin:app}});
    assert.equal(login.status(),200);
    const install=await page.request.get(`${app}/api/news/install/${encodeURIComponent(name)}/jlpt-news.user.js`);
    assert.equal(install.status(),200);
    // Test hook: shadow roots are created open so locators can look inside the loader's button.
    await context.addInitScript(()=>{const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(init){return attach.call(this,{...init,mode:'open'});};});
    await context.addInitScript(await install.text());
    await run(page,{app,site,tmp,context});
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();await fixture.stop();await hubFile?.remove();}
}

test('the loader runs the main script on an article page only',()=>withUserscript('iPad (gen 7)',async(page,{app,site})=>{
  await page.goto(`${site}/articles/${HEX}`);
  await page.locator('html[data-jlpt-news=ready]').waitFor({state:'attached'});
  assert.equal(await page.locator('jlpt-news').count(),1);
  // Not an article page: the script is fetched and run, but finds no site entry and does nothing.
  const fetched=page.waitForResponse(response=>response.url()===app+'/api/news/client.js');
  await page.goto(`${site}/articles/${HEX}/images/000`);
  assert.equal((await fetched).status(),200);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('html[data-jlpt-news]').count(),0);
  assert.equal(await page.locator('jlpt-news').count(),0);
  assert.equal(await page.locator('jlpt-news-loader').count(),0);
}));

test('a revoked token shows the loader button with the reinstall reason',()=>withUserscript('iPad (gen 7)',async(page,{app,site})=>{
  const {devices:list}=await (await page.request.get(app+'/api/news/devices')).json();
  const revoked=await page.request.post(app+'/api/news/devices/revoke',{data:{id:list[0].id},headers:{Origin:app}});
  assert.equal(revoked.status(),200);
  await page.goto(`${site}/articles/${HEX}`);
  await page.locator('jlpt-news-loader button').click();
  const panel=page.locator('jlpt-news-loader .p');
  await panel.waitFor({state:'visible'});
  assert.match(await panel.innerText(),/加载主脚本失败：令牌已失效，请重新安装脚本/);
  assert.equal(await panel.getByRole('link',{name:'重新安装'}).getAttribute('href'),app+'/news-script/');
  assert.equal(await page.locator('jlpt-news').count(),0);
}));

// -- marking words on the page --------------------------------------------------------------------

const dockButton=page=>page.locator('jlpt-news .news-dock-button');
const dockMenu=page=>page.locator('jlpt-news .news-dock-menu');
async function openDock(page){await dockButton(page).click();await dockMenu(page).waitFor({state:'visible'});return dockMenu(page);}
// Waits until the dock shows `label` (就绪 / 出错) after the first marking pass.
async function marked(page,label='就绪'){
  await page.locator('html[data-jlpt-words]').waitFor({state:'attached'});
  await page.locator('jlpt-news .news-dock-button',{hasText:label}).waitFor();
}
const tokenizeRequests=async tmp=>JSON.parse(await readFile(join(tmp,'news-tokenize-requests.json'),'utf8'));
// For every paragraph of the article: its text without whitespace, the same for its .jlpt-t pieces,
// and how many of them are tappable words.
const paragraphs=page=>page.evaluate(()=>[...document.querySelectorAll('h1, .article_body p, .article_body figcaption')].map(el=>({
  text:el.textContent.replace(/\s/g,''),
  marked:[...el.querySelectorAll('.jlpt-t')].map(s=>s.textContent).join('').replace(/\s/g,''),
  words:el.querySelectorAll('.jlpt-word').length,
})));

test('words are marked after load and every tappable character is covered',()=>withUserscript('iPad (gen 7)',async(page,{site,context})=>{
  // What the page looked like when its own DOMContentLoaded and load handlers ran.
  await context.addInitScript(()=>{
    const count=()=>document.querySelectorAll('.jlpt-t').length;
    document.addEventListener('DOMContentLoaded',()=>{window.__marksAtReady=count();});
    addEventListener('load',()=>{window.__marksAtLoad=count();});
  });
  await page.goto(`${site}/articles/${HEX}`);
  await marked(page);
  assert.deepEqual(await page.evaluate(()=>[window.__marksAtReady,window.__marksAtLoad]),[0,0]);
  const words=Number(await page.locator('html').getAttribute('data-jlpt-words'));
  assert.ok(words>0);
  assert.equal(words,await page.locator('.jlpt-word').count());
  assert.equal(await page.locator('html').getAttribute('data-jlpt-rewraps'),'0');
  const list=await paragraphs(page);
  assert.equal(list.length,7);
  for (const p of list) {assert.equal(p.marked,p.text);assert.ok(p.words>0,p.text);}
  // Only the title and the body are marked; punctuation and digits are pieces but not words.
  assert.equal(await page.locator('.jlpt-t').evaluateAll(spans=>spans.filter(s=>!s.closest('h1, .article_body')).length),0);
  assert.deepEqual(await page.locator('.jlpt-t',{hasText:/^。$/}).first().evaluate(s=>[s.classList.contains('jlpt-word'),s.dataset.s!==undefined,s.dataset.i!==undefined]),[false,true,true]);
  assert.equal(await page.locator('.jlpt-word',{hasText:/^10$/}).count(),0);
  // Sentence ids increase through the page.
  const ids=await page.locator('.jlpt-t').evaluateAll(spans=>spans.map(s=>Number(s.dataset.s)));
  assert.ok(ids.every((id,n)=>n===0||id>=ids[n-1]));
  assert.ok(new Set(ids).size>=8);
  // The system text-selection menu is off for the marked parts only.
  const select=await page.evaluate(()=>['h1','.article_body p','body'].map(s=>getComputedStyle(document.querySelector(s)).webkitUserSelect));
  assert.deepEqual(select.slice(0,2),['none','none']);
  assert.notEqual(select[2],'none');
  assert.equal(await dockButton(page).innerText(),'就绪');
}));

test('a word split by inline elements is one word in two pieces',()=>withUserscript('iPhone 13',async(page,{site})=>{
  await page.goto(`${site}/articles/${HEX}`);
  await marked(page);
  const paragraph=page.locator('.article_body p').nth(1);
  const bold=paragraph.locator('b .jlpt-word');
  assert.equal(await bold.count(),1);
  const [s,i]=await bold.evaluate(span=>[span.dataset.s,span.dataset.i]);
  const pieces=paragraph.locator(`.jlpt-t[data-s="${s}"][data-i="${i}"]`);
  assert.equal(await pieces.count(),2);
  assert.deepEqual(await pieces.allTextContents(),['気','象庁']);
  assert.deepEqual(await pieces.evaluateAll(spans=>spans.map(span=>[span.classList.contains('jlpt-word'),!!span.closest('b')])),[[true,true],[true,false]]);
  // A word inside a link stays one piece inside the link.
  const island=page.locator('.article_body p').first().locator('a .jlpt-word');
  assert.deepEqual(await island.allTextContents(),['島','気象庁']);
}));

test('paragraphs with spaces, nbsp, emoji and line breaks are fully marked',()=>withUserscript('iPad (gen 7)',async(page,{site})=>{
  await page.goto(`${site}/articles/${HEX}`);
  await marked(page);
  const list=await paragraphs(page);
  for (const start of ['一行目です。','全角']) {
    const p=list.find(p=>p.text.startsWith(start));
    assert.ok(p&&p.words>0,start);
    assert.equal(p.marked,p.text);
  }
  // Lines split by <br> are separate sentences; the <br> elements are still there.
  const lines=page.locator('.article_body p').nth(2);
  assert.equal(await lines.locator('br').count(),2);
  assert.equal(new Set(await lines.locator('.jlpt-t').evaluateAll(spans=>spans.map(s=>s.dataset.s))).size,3);
  assert.equal(await lines.innerText(),'一行目です。\n二行目です。\n三行目です。');
  // The emoji paragraph keeps its exact text, spaces included.
  assert.equal(await page.locator('.article_body p').nth(3).textContent(),'全角　空白と 不間断空白があります。😀 絵文字も含みます。');
  const menu=await openDock(page);
  assert.doesNotMatch(await menu.innerText(),/标出词/);
  assert.equal(await menu.locator('.news-error').count(),0);
}));

test('a re-render is re-marked from the cache without asking the server again',()=>withUserscript('iPad (gen 7)',async(page,{site,tmp})=>{
  await page.goto(`${site}/articles/${HEX}?rerender=1500`);
  await marked(page);
  const words=await page.locator('.jlpt-word').count();
  const ids=await page.locator('.jlpt-t').evaluateAll(spans=>spans.map(s=>s.dataset.s+'.'+s.dataset.i));
  await page.waitForFunction(()=>Number(document.documentElement.dataset.jlptRewraps)>=1,null,{timeout:5000});
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.jlpt-word').count(),words);
  assert.equal(await page.locator('html').getAttribute('data-jlpt-words'),String(words));
  // The same paragraphs keep the same sentence ids.
  assert.deepEqual(await page.locator('.jlpt-t').evaluateAll(spans=>spans.map(s=>s.dataset.s+'.'+s.dataset.i)),ids);
  for (const p of await paragraphs(page)) assert.equal(p.marked,p.text);
  // Re-marking does not feed itself: the count stays put.
  const rewraps=await page.locator('html').getAttribute('data-jlpt-rewraps');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('html').getAttribute('data-jlpt-rewraps'),rewraps);
  assert.equal((await tokenizeRequests(tmp)).length,1);
}));

test('a long article is tokenized in batches under the server limits',()=>withUserscript('iPad (gen 7)',async(page,{site,tmp})=>{
  await page.goto(`${site}/articles/${HEX}?long=1`);
  await marked(page);
  const requests=await tokenizeRequests(tmp);
  assert.ok(requests.length>=2,JSON.stringify(requests));
  for (const r of requests) {assert.ok(r.paragraphs<=200,JSON.stringify(r));assert.ok(r.chars<=20000,JSON.stringify(r));}
  const list=(await paragraphs(page)).filter(p=>p.text.startsWith('第'));
  assert.equal(list.length,250);
  for (const p of list) {assert.ok(p.words>0,p.text);assert.equal(p.marked,p.text);}
}));

test('a missing article body is reported as 找到正文 and cannot be retried',()=>withUserscript('iPad (gen 7)',async(page,{site})=>{
  await page.goto(`${site}/articles/${HEX}?missing=1`);
  await page.locator('jlpt-news .news-dock-button',{hasText:'出错'}).waitFor();
  const menu=await openDock(page);
  assert.match(await menu.innerText(),/找到正文失败：页面上找不到 \.article_body/);
  assert.equal(await menu.getByRole('button',{name:'重试'}).count(),0);
  assert.equal(await menu.getByRole('button',{name:'重新分词'}).count(),1);
  assert.equal(await page.locator('.jlpt-t').count(),0);
}));

test('a paragraph the tokens do not fit is skipped and named',()=>withUserscript('iPad (gen 7)',async(page,{site})=>{
  await page.goto(`${site}/articles/${HEX}?mismatch=1`);
  await marked(page,'出错');
  const menu=await openDock(page);
  assert.equal(await menu.locator('.news-error').count(),1);
  assert.match(await menu.innerText(),/标出词失败（第 3 段）：分词结果和原文对不上/);
  const misfit=page.locator('.article_body p',{hasText:'ズレ'});
  assert.equal(await misfit.locator('.jlpt-t').count(),0);
  assert.equal(await misfit.textContent(),'ここで分詞がズレます。');
  const list=(await paragraphs(page)).filter(p=>!p.text.includes('ズレ'));
  assert.equal(list.length,7);
  for (const p of list) {assert.ok(p.words>0,p.text);assert.equal(p.marked,p.text);}
}));

test('重新分词 asks the server again and marks every paragraph once',()=>withUserscript('iPad (gen 7)',async(page,{site,tmp})=>{
  await page.goto(`${site}/articles/${HEX}`);
  await marked(page);
  const words=await page.locator('.jlpt-word').count();
  const menu=await openDock(page);
  await menu.getByRole('button',{name:'重新分词'}).click();
  await page.locator('jlpt-news .news-dock-button',{hasText:'就绪'}).waitFor();
  await page.waitForFunction(n=>document.querySelectorAll('.jlpt-word').length===n,words);
  assert.equal((await tokenizeRequests(tmp)).length,2);
  assert.equal(await page.locator('.jlpt-t .jlpt-t').count(),0);
  for (const p of await paragraphs(page)) assert.equal(p.marked,p.text);
  assert.deepEqual(await page.locator('.article_body p').nth(1).locator('b .jlpt-t').allTextContents(),['気']);
}));

// "<data-s>.<data-i>" of every piece in the paragraphs with exactly `text`, one list per paragraph.
const piecesOf=(page,text)=>page.evaluate(text=>[...document.querySelectorAll('.article_body p')].filter(p=>p.textContent===text)
  .map(p=>[...p.querySelectorAll('.jlpt-t')].map(s=>s.dataset.s+'.'+s.dataset.i)),text);

test('identical paragraphs get their own sentence ids, kept across a re-render',()=>withUserscript('iPad (gen 7)',async(page,{site,tmp})=>{
  await page.goto(`${site}/articles/${HEX}?repeat=1`);
  await marked(page);
  let [first,second]=await piecesOf(page,'同じ文です。');
  assert.ok(first.length>0);
  assert.equal(second.length,first.length);
  const sentence=list=>new Set(list.map(piece=>piece.split('.')[0]));
  assert.equal([...sentence(first)].filter(id=>sentence(second).has(id)).length,0);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('html').getAttribute('data-jlpt-rewraps'),'0');
  // The same page re-rendered: each copy is marked again with its own ids from before.
  await page.goto(`${site}/articles/${HEX}?repeat=1&rerender=1500`);
  await marked(page);
  [first,second]=await piecesOf(page,'同じ文です。');
  assert.equal(await page.locator('html').getAttribute('data-jlpt-rewraps'),'0');
  const words=await page.locator('.jlpt-word').count();
  await page.waitForFunction(()=>Number(document.documentElement.dataset.jlptRewraps)>=1,null,{timeout:5000});
  await page.waitForTimeout(300);
  assert.equal(await page.locator('html').getAttribute('data-jlpt-rewraps'),'1');
  assert.deepEqual(await piecesOf(page,'同じ文です。'),[first,second]);
  assert.equal(await page.locator('.jlpt-word').count(),words);
  for (const p of await paragraphs(page)) assert.equal(p.marked,p.text);
  assert.equal((await tokenizeRequests(tmp)).length,2); // one per page load
}));

test('an article body that disappears and comes back is marked again',()=>withUserscript('iPad (gen 7)',async(page,{site,tmp})=>{
  await page.goto(`${site}/articles/${HEX}?vanish=1500`);
  await marked(page);
  const words=await page.locator('.jlpt-word').count();
  const ids=await page.locator('.article_body .jlpt-t').evaluateAll(spans=>spans.map(s=>s.dataset.s+'.'+s.dataset.i));
  await page.locator('.placeholder').waitFor({state:'attached'});
  await page.waitForFunction(n=>document.querySelector('.placeholder .article_body .jlpt-word')&&document.querySelectorAll('.jlpt-word').length===n,words,{timeout:5000});
  await page.waitForTimeout(300);
  assert.equal(await page.locator('html').getAttribute('data-jlpt-words'),String(words));
  assert.deepEqual(await page.locator('.article_body .jlpt-t').evaluateAll(spans=>spans.map(s=>s.dataset.s+'.'+s.dataset.i)),ids);
  for (const p of await paragraphs(page)) assert.equal(p.marked,p.text);
  // Vanishing after it was found is not a 找到正文 failure.
  assert.equal(await dockButton(page).innerText(),'就绪');
  assert.equal((await tokenizeRequests(tmp)).length,1);
}));

// -- tapping words, selecting sentences and parts ---------------------------------------------------
// The fixture tokenizer cuts the sample article into these sentences (word indices from 0):
//   台風は強い勢力で島に接近                    h1: 台風/は/強い/勢力/で/島/に/接近
//   台風は強い勢力で島に接近するおそれがあります。 台風/は/強い/勢力/で/島(link)/に/接近/する/おそれ/が/あり/ます/。
//   気象庁は早めの準備を呼びかけました。         気象庁(link)/は/早め/の/準備/を/呼びかけ/まし/た/。
//   港に並ぶ船は、気象庁の発表を受けて避難しました。 港/に/並ぶ/船/は/、/気象庁(気 in <b>)/…
//   港に並ぶ船（11月9日撮影）                    caption in a link: 港/に/並ぶ/船/（/11/月/9/日/撮影/）
//   雨は10日から降り、最後の段落です。           雨/は/10/日/から/降り/、/最後/の/段落/です/。
const NEWS_DEVICES=['iPad Pro 11','iPhone 13'];
const failure=(stage,stage_label,reason,extra={})=>({error:{stage,stage_label,location:null,reason,retryable:true,request_id:'n-20261108-a3f9',time:'15:42:07',...extra}});
const GLOSS_HUB=[['chunks',['<gloss><meaning>势力；力量，强度</meaning></gloss>'],0]];

// Opens the sample article, waits for the marks and records the selection events and speech.
async function openArticle(page,site,query='') {
  await page.goto(`${site}/articles/${HEX}${query}`);
  await marked(page);
  await page.evaluate(()=>{
    window.__events=[];
    for(const name of ['jlpt:select-sentence','jlpt:select-part']) document.addEventListener(name,event=>window.__events.push([name,event.detail]));
    window.__spoken=[];
    // On the prototype: WebKit may drop an expando on the speechSynthesis wrapper between calls.
    if(window.SpeechSynthesis) SpeechSynthesis.prototype.speak=utterance=>window.__spoken.push([utterance.text,utterance.lang]);
  });
}
// Sentence ids by the start of their text (first sentence on the page that starts so).
async function ids(page,...starts) {
  const texts=await page.evaluate(()=>{
    const out=new Map();
    for(const span of document.querySelectorAll('.jlpt-t')) out.set(span.dataset.s,(out.get(span.dataset.s)||'')+span.textContent);
    return [...out];
  });
  return starts.map(start=>{const found=texts.find(([,text])=>text.startsWith(start));assert.ok(found,start);return Number(found[0]);});
}
// The first piece of word i of sentence s.
const tok=(page,s,i)=>page.locator(`.jlpt-t[data-s="${s}"][data-i="${i}"]`).first();
const events=page=>page.evaluate(()=>window.__events);
const card=page=>page.locator('jlpt-news .news-card');
// Touch input as iOS WebKit reports it: pointer events of pointerType 'touch', all sent to the element first
// touched (implicit capture), coordinates in the viewport. Playwright has no touch-drag API for WebKit.
async function pointer(page,type,[x,y]) {
  await page.evaluate(([type,x,y])=>{
    if(type==='pointerdown') window.__touched=document.elementFromPoint(x,y);
    const up=type==='pointerup'||type==='pointercancel';
    (window.__touched||document.body).dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,composed:true,pointerId:7,pointerType:'touch',isPrimary:true,clientX:x,clientY:y,button:type==='pointermove'?-1:0,buttons:up?0:1,width:20,height:20,pressure:up?0:0.5}));
  },[type,x,y]);
}
// A point inside an element's first line box, in the page's client coordinates (whatever the page
// scale): fx/fy are fractions of it (0.5,0.5 is the centre). A target covered by the script's own
// UI (the word card, the dock) is scrolled up first.
async function at(locator,fx=0.5,fy=0.5) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate(node=>{
    const box=node.getClientRects()[0];
    if(!node.contains(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2))) {node.scrollIntoView({block:'start'});window.scrollBy(0,-80);}
  });
  return locator.evaluate((node,[fx,fy])=>{const box=node.getClientRects()[0];return [box.left+box.width*fx,box.top+box.height*fy];},[fx,fy]);
}
async function tap(page,locator) {const point=await at(locator);await pointer(page,'pointerdown',point);await page.waitForTimeout(40);await pointer(page,'pointerup',point);}
async function longPress(page,locator) {const point=await at(locator);await pointer(page,'pointerdown',point);await page.waitForTimeout(650);await pointer(page,'pointerup',point);}
async function drag(page,from,to,{end='pointerup'}={}) {
  await pointer(page,'pointerdown',from);
  for(let step=1;step<=6;step++) {await page.waitForTimeout(15);await pointer(page,'pointermove',[from[0]+(to[0]-from[0])*step/6,from[1]+(to[1]-from[1])*step/6]);}
  await pointer(page,end,to);
}
// "<sentence>:<word>" of the highlighted part, one entry per word (a word may have several pieces).
const partIndices=page=>page.locator('.jlpt-part').evaluateAll(nodes=>[...new Set(nodes.map(node=>`${node.dataset.s}:${node.dataset.i}`))]);
const selectedIds=page=>page.locator('.jlpt-sel').evaluateAll(nodes=>[...new Set(nodes.map(node=>Number(node.dataset.s)))]);
const range=(s,a,b)=>Array.from({length:b-a+1},(_,k)=>`${s}:${a+k}`);
// A cross-origin answer from page.route: the preflight is answered as well.
function answer(route,{status=200,json}={}) {
  const request=route.request();
  const headers={'Access-Control-Allow-Origin':request.headers().origin||'*','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, POST'};
  if(request.method()==='OPTIONS') return route.fulfill({status:204,headers});
  return route.fulfill({status,json,headers});
}

for(const device of NEWS_DEVICES) {
  test(`tap word shows reading and gloss; rapid taps keep only last on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site);
    const [A,C]=await ids(page,'台風は強い勢力で島に接近する','港に並ぶ船は');
    // Through the server and the fake model: reading, part of speech, meaning, speech.
    const word=tok(page,A,3);
    await tap(page,word);
    await card(page).waitFor();
    assert.equal(await card(page).locator('.news-card-word').innerText(),'勢力');
    assert.equal(await card(page).locator('.news-card-reading').innerText(),'せいりょく');
    assert.equal(await card(page).locator('.news-card-pos').innerText(),'名词');
    await card(page).locator('.news-card-meaning',{hasText:'势力；力量，强度'}).waitFor();
    // The card sits next to the word and inside the viewport.
    const box=await card(page).boundingBox();const wordBox=await word.boundingBox();const view=page.viewportSize();
    assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=view.width&&box.y+box.height<=view.height,JSON.stringify([box,view]));
    assert.ok(Math.min(Math.abs(box.y-(wordBox.y+wordBox.height)),Math.abs(box.y+box.height-wordBox.y))<=16,JSON.stringify([box,wordBox]));
    await card(page).getByRole('button',{name:'朗读'}).click();
    assert.deepEqual(await page.evaluate(()=>window.__spoken),[['勢力','ja-JP']]);
    // Tapping elsewhere closes the card.
    await tap(page,tok(page,A,13));
    assert.equal(await card(page).count(),0);
    // Rapid taps: a slow earlier answer never replaces the last word's, and a word tapped over at once is not asked for.
    const asked=[];
    await page.route('**/api/news/gloss',async route=>{
      if(route.request().method()!=='POST') return answer(route);
      const {lemma}=route.request().postDataJSON();asked.push(lemma);
      if(lemma==='台風') await new Promise(r=>setTimeout(r,700));
      try {await answer(route,{json:{meaning:lemma+'的释义'}});} catch {}
    });
    await tap(page,tok(page,A,0));
    await card(page).locator('.news-progress').waitFor();
    await page.waitForTimeout(350);
    const quick=[await at(tok(page,A,2)),await at(tok(page,A,5))];
    for(const point of quick) {await pointer(page,'pointerdown',point);await pointer(page,'pointerup',point);}
    await card(page).locator('.news-card-meaning',{hasText:'島的释义'}).waitFor();
    await page.waitForTimeout(900);
    assert.equal(await card(page).locator('.news-card-word').innerText(),'島');
    assert.equal(await card(page).locator('.news-card-meaning').innerText(),'島的释义');
    assert.equal(await card(page).count(),1);
    assert.deepEqual(asked,['台風','島']);
    // A failed lookup shows one error line with 重试 in the card.
    await page.unroute('**/api/news/gloss');
    let fail=true;
    await page.keyboard.press('Escape'); // the card may cover the next word
    assert.equal(await card(page).count(),0);
    await page.route('**/api/news/gloss',route=>answer(route,fail?{status:502,json:failure('model','模型生成','模型没有回应',{location:'查词：船'})}:{json:{meaning:'船只'}}));
    await tap(page,tok(page,C,3));
    const line=card(page).locator('.news-error-line');
    assert.equal(await line.innerText(),'模型生成失败（查词：船）：模型没有回应');
    fail=false;
    await card(page).getByRole('button',{name:'重试'}).click();
    await card(page).locator('.news-card-meaning',{hasText:'船只'}).waitFor();
    // 在本句中的作用 selects the sentence with this word as the selected part.
    await card(page).getByRole('button',{name:'在本句中的作用'}).click();
    assert.equal(await card(page).count(),0);
    assert.deepEqual(await events(page),[['jlpt:select-part',{sentenceId:C,start:3,end:3}]]);
    assert.deepEqual(await selectedIds(page),[C]);
    assert.deepEqual(await partIndices(page),[`${C}:3`]);
  },{hub:GLOSS_HUB,select:'Auto'}));

  test(`punctuation is not tappable on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site);
    const [A,F,D]=await ids(page,'台風は強い勢力で島に接近する','港に並ぶ船（','雨は');
    const asked=[];
    await page.route('**/api/news/gloss',route=>{if(route.request().method()==='POST') asked.push(route.request().postDataJSON().lemma);return answer(route,{json:{meaning:'x'}});});
    for(const [s,i] of [[A,13],[D,2],[F,4],[F,5],[D,6]]) await tap(page,tok(page,s,i)); // 。 10 （ 11 、
    await page.waitForTimeout(400);
    assert.equal(await card(page).count(),0);
    assert.deepEqual(asked,[]);
    // Particles are words like any other.
    await tap(page,tok(page,A,1));
    await card(page).locator('.news-card-meaning',{hasText:'x'}).waitFor();
    assert.equal(await card(page).locator('.news-card-pos').innerText(),'助词');
    assert.deepEqual(asked,['は']);
  }));

  test(`tapping a word inside a link looks it up and does not navigate on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site);
    const [A,B,F]=await ids(page,'台風は強い勢力で島に接近する','気象庁は','港に並ぶ船（');
    const address=page.url();
    // Real clicks (the browser's own pointer, mouse and click events): keyword links and the photo caption.
    for(const [s,i,text] of [[A,5,'島'],[B,0,'気象庁'],[F,0,'港'],[F,9,'撮影']]) {
      const word=tok(page,s,i);
      assert.equal(await word.evaluate(node=>!!node.closest('a[href]')),true,text);
      await word.click();
      await card(page).locator('.news-card-word',{hasText:text}).waitFor();
      await page.waitForTimeout(200);
      assert.equal(page.url(),address);
      await page.keyboard.press('Escape'); // the card may cover the next word
      assert.equal(await card(page).count(),0);
    }
    // Only clicks on the marked text are stopped: the link itself still follows its href.
    const stopped=await page.locator('.article_body a[href="/photo/1"]').evaluate(link=>{
      const seen=[];
      link.addEventListener('click',event=>{seen.push(event.defaultPrevented);event.preventDefault();});
      for(const target of [link,link.querySelector('.jlpt-word'),link.querySelector('.jlpt-t:not(.jlpt-word)')]) target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,composed:true}));
      return seen;
    });
    assert.deepEqual(stopped,[false,true,true]);
    assert.equal(page.url(),address);
  }));

  test(`long press selects whole sentence on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site);
    const [A,B,C,F,D]=await ids(page,'台風は強い勢力で島に接近する','気象庁は','港に並ぶ船は','港に並ぶ船（','雨は');
    // A press shorter than 500 ms is a tap, not a selection.
    const point=await at(tok(page,A,5));
    await pointer(page,'pointerdown',point);await page.waitForTimeout(250);await pointer(page,'pointerup',point);
    await card(page).waitFor();
    assert.equal(await page.locator('.jlpt-sel').count(),0);
    await longPress(page,tok(page,A,5));
    assert.equal(await card(page).count(),0);
    assert.deepEqual(await selectedIds(page),[A]);
    // Every piece of the sentence is highlighted, and nothing else.
    assert.equal(await page.locator('.jlpt-sel').count(),await page.locator(`.jlpt-t[data-s="${A}"]`).count());
    assert.deepEqual(await events(page),[['jlpt:select-sentence',{sentenceId:A}]]);
    assert.equal(await tok(page,A,5).evaluate(node=>getComputedStyle(node).touchAction),'none');
    assert.notEqual(await tok(page,A,5).evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)');
    // Anywhere in a sentence, punctuation included; another sentence replaces the selection.
    await longPress(page,tok(page,D,6));
    assert.deepEqual(await selectedIds(page),[D]);
    assert.notEqual(await tok(page,A,5).evaluate(node=>getComputedStyle(node).touchAction),'none');
    // A word in two pieces (気|象庁) is highlighted in both.
    await longPress(page,tok(page,C,0));
    assert.equal(await page.locator('.jlpt-sel').count(),await page.locator(`.jlpt-t[data-s="${C}"]`).count());
    assert.equal(await page.locator('.article_body b .jlpt-sel').count(),1);
    // Caption sentences too.
    await longPress(page,tok(page,F,0));
    assert.deepEqual(await events(page),[['jlpt:select-sentence',{sentenceId:A}],['jlpt:select-sentence',{sentenceId:D}],['jlpt:select-sentence',{sentenceId:C}],['jlpt:select-sentence',{sentenceId:F}]]);
    // Moving more than 10 px cancels the long press.
    const start=await at(tok(page,B,0));
    await pointer(page,'pointerdown',start);await page.waitForTimeout(100);
    await pointer(page,'pointermove',[start[0],start[1]+14]);await page.waitForTimeout(600);await pointer(page,'pointerup',[start[0],start[1]+14]);
    assert.equal((await events(page)).length,4);
    assert.equal(await card(page).count(),0);
    // The system menu and text selection stay off.
    for(const type of ['contextmenu','selectstart']) {
      assert.equal(await tok(page,A,5).evaluate((node,type)=>{const event=new Event(type,{bubbles:true,cancelable:true});node.dispatchEvent(event);return event.defaultPrevented;},type),true,type);
    }
  }));

  test(`drag inside selected sentence snaps to whole words on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site);
    const [A]=await ids(page,'台風は強い勢力で島に接近する');
    await longPress(page,tok(page,A,5));
    // From inside 強い to the first character of 島: both words whole.
    await drag(page,await at(tok(page,A,2),0.7),await at(tok(page,A,5),0.2));
    assert.deepEqual(await partIndices(page),range(A,2,5));
    assert.deepEqual((await events(page)).at(-1),['jlpt:select-part',{sentenceId:A,start:2,end:5}]);
    assert.deepEqual(await selectedIds(page),[A]);
    // Backwards works the same and replaces the part.
    await drag(page,await at(tok(page,A,11),0.6),await at(tok(page,A,3),0.4));
    assert.deepEqual(await partIndices(page),range(A,3,11));
    assert.deepEqual((await events(page)).at(-1),['jlpt:select-part',{sentenceId:A,start:3,end:11}]);
    assert.equal((await events(page)).length,3);
    // A tap on a word of the selected sentence still opens the word card and keeps the part.
    await tap(page,tok(page,A,7));
    await card(page).waitFor();
    assert.equal(await card(page).locator('.news-card-word').innerText(),'接近');
    assert.deepEqual(await partIndices(page),range(A,3,11));
    assert.equal((await events(page)).length,3);
    // Long press on the selected sentence goes back to the whole sentence.
    await longPress(page,tok(page,A,0));
    assert.deepEqual(await partIndices(page),[]);
    assert.deepEqual((await events(page)).at(-1),['jlpt:select-sentence',{sentenceId:A}]);
  }));

  test(`drag past sentence end clamps to sentence on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site);
    const [H,A,B]=await ids(page,'台風は強い勢力で島に接近','台風は強い勢力で島に接近する','気象庁は');
    await longPress(page,tok(page,A,5));
    // Past the end into the next sentence and further down the page: up to the last word, 。 left out.
    await drag(page,await at(tok(page,A,3)),await at(tok(page,B,2)));
    assert.deepEqual(await partIndices(page),range(A,3,12));
    assert.deepEqual((await events(page)).at(-1),['jlpt:select-part',{sentenceId:A,start:3,end:12}]);
    const view=page.viewportSize();
    const below=[view.width/2,view.height-4]; // further down the page, below sentence A
    await drag(page,await at(tok(page,A,6)),below);
    assert.deepEqual(await partIndices(page),range(A,6,12));
    // Back past the start, into the title and above it: from the first word.
    await drag(page,await at(tok(page,A,5)),await at(tok(page,H,1)));
    assert.deepEqual(await partIndices(page),range(A,0,5));
    const top=await at(page.locator('h1'),0.5,0);
    await drag(page,await at(tok(page,A,9)),[top[0],Math.max(1,top[1]-6)]);
    assert.deepEqual(await partIndices(page),range(A,0,9));
    assert.deepEqual((await events(page)).at(-1),['jlpt:select-part',{sentenceId:A,start:0,end:9}]);
    // Into the blank margin beside the paragraph: still inside the sentence.
    const [x,y]=await at(tok(page,A,4));
    await drag(page,[x,y],[2,y]);
    const parts=await partIndices(page);
    assert.ok(parts.length>0&&parts.every(part=>part.startsWith(`${A}:`)),JSON.stringify(parts));
    // Starting on the final 。 and going further: nothing but punctuation, so the selection is unchanged.
    const before=(await events(page)).length;const kept=await partIndices(page);
    await drag(page,await at(tok(page,A,13)),below);
    assert.equal((await events(page)).length,before);
    assert.deepEqual(await partIndices(page),kept);
    // From the trailing 。 back into the sentence: words up to the last one, 。 left out.
    await drag(page,await at(tok(page,A,13)),await at(tok(page,A,3)));
    assert.deepEqual(await partIndices(page),range(A,3,12));
    assert.deepEqual((await events(page)).at(-1),['jlpt:select-part',{sentenceId:A,start:3,end:12}]);
    // Only sentence A is ever highlighted.
    assert.deepEqual(await selectedIds(page),[A]);
  }));

  test(`drag keeps numbers with their counters and trims only punctuation on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site);
    // The caption: 港/に/並ぶ/船/（/11/月/9/日/撮影/）
    const [F]=await ids(page,'港に並ぶ船（');
    await longPress(page,tok(page,F,1));
    await drag(page,await at(tok(page,F,5),0.2),await at(tok(page,F,6),0.6));
    assert.deepEqual(await partIndices(page),range(F,5,6));
    assert.deepEqual((await events(page)).at(-1),['jlpt:select-part',{sentenceId:F,start:5,end:6}]);
    // Just a number is a selection too.
    await drag(page,await at(tok(page,F,5),0.05,0.1),await at(tok(page,F,5),0.95,0.9));
    assert.deepEqual((await events(page)).at(-1),['jlpt:select-part',{sentenceId:F,start:5,end:5}]);
    assert.deepEqual(await partIndices(page),range(F,5,5));
    // Brackets at the edges are dropped.
    await drag(page,await at(tok(page,F,4),0.5),await at(tok(page,F,10),0.5));
    assert.deepEqual((await events(page)).at(-1),['jlpt:select-part',{sentenceId:F,start:5,end:9}]);
    assert.deepEqual(await partIndices(page),range(F,5,9));
  }));

  test(`dragging outside selected sentence scrolls on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site);
    // The sample article is short: room below it so the page can scroll.
    await page.addStyleTag({content:'article{padding-bottom:3000px}'});
    const [A,D]=await ids(page,'台風は強い勢力で島に接近する','雨は');
    await longPress(page,tok(page,A,5));
    const selected=tok(page,A,3);const other=tok(page,D,0);
    assert.ok(await page.evaluate(()=>document.scrollingElement.scrollHeight>innerHeight+400));
    // Native panning stays on outside the selected sentence and is off on it.
    const touchMove=locator=>locator.evaluate(node=>{
      node.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,cancelable:true}));
      const move=new TouchEvent('touchmove',{bubbles:true,cancelable:true});node.dispatchEvent(move);
      node.dispatchEvent(new TouchEvent('touchend',{bubbles:true,cancelable:true}));
      return [move.defaultPrevented,getComputedStyle(node).touchAction];
    });
    const [blocked]=await touchMove(selected);
    assert.equal(blocked,true);
    await other.scrollIntoViewIfNeeded();
    const [otherBlocked,otherAction]=await touchMove(other);
    assert.equal(otherBlocked,false);
    assert.notEqual(otherAction,'none');
    // WebKit cancels the pointer once it starts panning: no selection, no card, no long press afterwards.
    const from=await at(other);
    await drag(page,from,[from[0],from[1]-80],{end:'pointercancel'});
    await page.waitForTimeout(650);
    // And a drag that ends normally outside the selected sentence selects nothing either.
    await drag(page,from,[from[0]+60,from[1]-60]);
    await page.waitForTimeout(100);
    assert.deepEqual(await events(page),[['jlpt:select-sentence',{sentenceId:A}]]);
    assert.deepEqual(await selectedIds(page),[A]);
    assert.deepEqual(await partIndices(page),[]);
    assert.equal(await card(page).count(),0);
    // The page itself really scrolls.
    const before=await page.evaluate(()=>scrollY);
    await page.evaluate(()=>window.scrollBy(0,300));
    assert.ok(await page.evaluate(()=>scrollY)>before);
  }));

  test(`a re-render keeps the selected sentence highlighted and words tappable on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site,'?rerender=3000');
    const [A,B]=await ids(page,'台風は強い勢力で島に接近する','気象庁は');
    assert.equal(await page.locator('html').getAttribute('data-jlpt-rewraps'),'0');
    await longPress(page,tok(page,A,5));
    await drag(page,await at(tok(page,A,2),0.5),await at(tok(page,A,5),0.5));
    assert.deepEqual(await partIndices(page),range(A,2,5));
    await tok(page,A,5).evaluate(node=>{window.__old=node;});
    await page.waitForFunction(()=>Number(document.documentElement.dataset.jlptRewraps)>=1,null,{timeout:8000});
    await page.waitForTimeout(300);
    // New spans, same sentence: still highlighted, every piece of it, part included.
    assert.equal(await page.evaluate(()=>window.__old.isConnected),false);
    assert.deepEqual(await selectedIds(page),[A]);
    assert.equal(await page.locator('.jlpt-sel').count(),await page.locator(`.jlpt-t[data-s="${A}"]`).count());
    assert.deepEqual(await partIndices(page),range(A,2,5));
    // Words are tappable on the new spans, and a drag on the selected sentence still works.
    await tap(page,tok(page,B,0));
    await card(page).locator('.news-card-word',{hasText:'気象庁'}).waitFor();
    await drag(page,await at(tok(page,A,7),0.5),await at(tok(page,A,9),0.5));
    assert.deepEqual(await partIndices(page),range(A,7,9));
    assert.deepEqual((await events(page)).at(-1),['jlpt:select-part',{sentenceId:A,start:7,end:9}]);
  }));

  test(`a re-render while the word card waits for its meaning keeps the card on the word on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    // The gloss answer is held back until the page has re-rendered the body.
    let release;const held=new Promise(resolve=>{release=resolve;});
    await page.route('**/api/news/gloss',async route=>{
      if(route.request().method()==='POST') await held;
      try {await answer(route,{json:{meaning:'势力的释义'}});} catch {}
    });
    await openArticle(page,site,'?rerender=2500');
    const [A]=await ids(page,'台風は強い勢力で島に接近する');
    await tap(page,tok(page,A,3));
    await card(page).locator('.news-progress').waitFor();
    await tok(page,A,3).evaluate(node=>{window.__old=node;});
    await page.waitForFunction(()=>Number(document.documentElement.dataset.jlptRewraps)>=1,null,{timeout:8000});
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(()=>window.__old.isConnected),false);
    release();
    // The answer arrives after the re-render: the card stays, shows it, and sits by the word's new piece.
    await card(page).locator('.news-card-meaning',{hasText:'势力的释义'}).waitFor();
    await page.waitForTimeout(200);
    assert.equal(await card(page).count(),1);
    assert.equal(await card(page).isVisible(),true);
    assert.equal(await card(page).locator('.news-card-word').innerText(),'勢力');
    const box=await card(page).boundingBox();const wordBox=await tok(page,A,3).boundingBox();
    assert.ok(Math.min(Math.abs(box.y-(wordBox.y+wordBox.height)),Math.abs(box.y+box.height-wordBox.y))<=16,JSON.stringify([box,wordBox]));
    // Tapping elsewhere still closes it.
    await tap(page,tok(page,A,13));
    assert.equal(await card(page).count(),0);
  }));

  test(`the dock switches model and persists on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site);
    let menu=await openDock(page);
    const label=menu.locator('.news-model');
    assert.equal(await menu.evaluate(node=>node.firstElementChild.className),'news-model-row');
    await label.getByText('模型：未选择').waitFor();
    await label.click();
    assert.deepEqual(await menu.locator('.news-model-list button').allInnerTexts(),['Auto','DeepSeek-V4-Flash','DeepSeek-V4-Pro']);
    await menu.locator('.news-model-list button',{hasText:'DeepSeek-V4-Flash'}).click();
    await label.getByText('模型：DeepSeek-V4-Flash').waitFor();
    assert.equal(await menu.locator('.news-model-list').isHidden(),true);
    await page.reload();
    await marked(page);
    menu=await openDock(page);
    await menu.locator('.news-model',{hasText:'模型：DeepSeek-V4-Flash'}).waitFor();
    await menu.locator('.news-model').click();
    assert.equal(await menu.locator('.news-model-list button[aria-current=true]').innerText(),'DeepSeek-V4-Flash');
  }));

  test(`the dock shows the error line when the chosen model is unavailable on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await page.route('**/api/news/settings',route=>answer(route,{status:502,json:failure('model','模型生成','当前模型不可用，请重新选择',{retryable:false,location:'保存模型'})}));
    await openArticle(page,site);
    const menu=await openDock(page);
    await menu.locator('.news-model',{hasText:'模型：未选择'}).click();
    await menu.locator('.news-model-list button',{hasText:'Auto'}).click();
    const line=menu.locator('.news-model-problem .news-error');
    assert.equal(await line.locator('.news-error-line').innerText(),'模型生成失败（保存模型）：当前模型不可用，请重新选择');
    assert.equal(await line.getByRole('button',{name:'重试'}).count(),0);
    assert.equal(await menu.locator('.news-model').innerText(),'模型：未选择');
    // No automatic switch: the picker is still open so another model can be chosen.
    assert.equal(await menu.locator('.news-model-list').isVisible(),true);
  }));
}

test('a device revoked while reading shows 令牌已失效 with 重新安装 in the word card',()=>withUserscript('iPhone 13',async(page,{app,site})=>{
  await openArticle(page,site);
  const [A]=await ids(page,'台風は強い勢力で島に接近する');
  const {devices:list}=await (await page.request.get(app+'/api/news/devices')).json();
  assert.equal((await page.request.post(app+'/api/news/devices/revoke',{data:{id:list[0].id},headers:{Origin:app}})).status(),200);
  await tap(page,tok(page,A,3));
  const problem=card(page).locator('.news-card-meaning .news-error');
  await problem.waitFor();
  assert.match(await problem.locator('.news-error-line').innerText(),/令牌已失效，请重新安装脚本/);
  assert.equal(await problem.getByRole('link',{name:'重新安装'}).getAttribute('href'),app+'/news-script/');
  assert.equal(await card(page).getByRole('button',{name:'重试'}).count(),0);
}));
