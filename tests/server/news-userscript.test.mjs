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
