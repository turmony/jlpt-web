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
    const loader=await install.text();
    await context.addInitScript(loader);
    const token=JSON.parse(loader.match(/^  const CONFIG = (.*);$/m)[1]).token;
    // The script name carries the loader version, as the same number in @version and the overlay.
    const version=loader.match(/^\/\/ @version +(\d+)$/m)[1];
    assert.equal(loader.match(/^\/\/ @name +(.*)$/m)[1],`JLPT 新闻查词 v${version}`);
    await run(page,{app,site,tmp,context,token,version});
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

// -- the on-screen debug overlay -------------------------------------------------------------------

const debugBox=page=>page.locator('jlpt-news-debug .d');
const debugLines=page=>page.locator('jlpt-news-debug .l > div').allInnerTexts();
// Index of the first overlay line matching rx (-1 when none), so the order can be checked.
const lineIndex=(lines,rx)=>lines.findIndex(line=>rx.test(line));

for(const device of ['iPhone 13','iPad Pro 11']) {
  test(`the debug overlay traces loading and stays out of the way on ${device}`,()=>withUserscript(device,async(page,{site,token,version})=>{
    await page.goto(`${site}/articles/${HEX}`);
    await marked(page);
    await page.locator('jlpt-news-debug .l > div',{hasText:/状态: 就绪/}).waitFor();
    await page.locator('jlpt-news-debug .l > div',{hasText:/已标出 \d+ 个词/}).waitFor();
    const lines=await debugLines(page);
    for(const line of lines) assert.match(line,/^\+\d+ms /);
    const order=[new RegExp(`加载器已运行 v${version} 页面 /articles/[0-9a-f]+ readyState=`),/匹配的网站: 样例新闻/,/正在取主脚本…/,/主脚本已取到: \d+ 字节/,
      /执行方式: new Function/,/主脚本已运行/,/站点已匹配: 样例新闻/,/主脚本已执行/,/状态: 就绪/];
    const at=order.map(rx=>lineIndex(lines,rx));
    assert.ok(at.every((n,k)=>n>=0&&(k===0||n>at[k-1])),JSON.stringify({at,lines}));
    assert.ok(lineIndex(lines,/页面 load 完成/)>0,JSON.stringify(lines));
    const words=Number(await page.locator('html').getAttribute('data-jlpt-words'));
    assert.ok(words>0);
    assert.match(lines.find(line=>/状态: 就绪/.test(line)),new RegExp(`词数 ${words} 重包 0`));
    assert.match(lines.find(line=>/已标出/.test(line)),new RegExp(`已标出 ${words} 个词`));
    const all=lines.join('\n');
    for(const secret of [token,'Bearer','Authorization']) assert.ok(!all.includes(secret),secret);
    assert.ok(lines.length<=40);
    // Small, dark, fixed at the top left, above everything; ok lines green.
    assert.equal(await page.evaluate(()=>document.querySelector('jlpt-news-debug').shadowRoot.mode),'open');
    const box=await debugBox(page).boundingBox();
    assert.ok(Math.abs(box.x-4)<=1&&Math.abs(box.y-4)<=1,JSON.stringify(box));
    assert.ok(box.width<=page.viewportSize().width*0.92+1,JSON.stringify(box));
    assert.deepEqual(await styleOf(debugBox(page),'position','zIndex','fontSize','pointerEvents'),['fixed','2147483647','11px','none']);
    assert.deepEqual(await styleOf(page.locator('jlpt-news-debug .l > div.ok').first(),'color'),['rgb(142, 234, 142)']);
    // The text lets taps through: a title word under it still opens the word card.
    await page.evaluate(()=>scrollTo(0,0));
    const under=page.locator('h1 .jlpt-word').first();
    const point=await under.evaluate(node=>{const r=node.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];});
    const list=await page.locator('jlpt-news-debug .l').boundingBox();
    assert.ok(point[0]>=list.x&&point[0]<=list.x+list.width&&point[1]>=list.y&&point[1]<=list.y+list.height,JSON.stringify({point,list}));
    assert.equal(await page.evaluate(([x,y])=>document.elementFromPoint(x,y).closest('.jlpt-word')?.textContent,point),await under.textContent());
    await tap(page,under);
    await card(page).waitFor();
    await page.keyboard.press('Escape');
    // Tapping the title collapses it to a small pill; again expands it; × hides it for this page.
    const toggle=page.locator('jlpt-news-debug .t');
    assert.equal(await toggle.innerText(),'JLPT 调试');
    await toggle.tap();
    await page.locator('jlpt-news-debug .l').waitFor({state:'hidden'});
    assert.equal(await page.locator('jlpt-news-debug .x').isVisible(),false);
    const pill=await debugBox(page).boundingBox();
    assert.ok(pill.width<100&&pill.height<40,JSON.stringify(pill));
    await toggle.tap();
    await page.locator('jlpt-news-debug .l').waitFor({state:'visible'});
    await page.locator('jlpt-news-debug .x').tap();
    await debugBox(page).waitFor({state:'hidden'});
    assert.equal(await page.locator('jlpt-news-debug').count(),1);
  }));
}

test('the debug overlay on a page outside the site table stops after the fetch',()=>withUserscript('iPhone 13',async(page,{site,token,version})=>{
  await page.goto(`${site}/articles/${HEX}/images/000`);
  await page.locator('jlpt-news-debug .l > div',{hasText:'主脚本已执行'}).waitFor();
  await page.waitForTimeout(300);
  const lines=await debugLines(page);
  const order=[new RegExp(`加载器已运行 v${version} 页面 /articles/[0-9a-f]+/images/000 `),/当前页面不在网站表内/,/主脚本已取到: \d+ 字节/,
    new RegExp(`当前页面路径不匹配 \\(/articles/${HEX}/images/000\\)`),/主脚本已执行/];
  const at=order.map(rx=>lineIndex(lines,rx));
  assert.ok(at.every((n,k)=>n>=0&&(k===0||n>at[k-1])),JSON.stringify({at,lines}));
  for(const rx of [/匹配的网站/,/站点已匹配/,/状态:/,/已标出/,/页面 load 完成/]) assert.equal(lineIndex(lines,rx),-1,String(rx));
  assert.deepEqual(await styleOf(page.locator('jlpt-news-debug .l > div',{hasText:'当前页面不在网站表内'}),'color'),['rgb(255, 213, 79)']);
  assert.ok(!lines.join('\n').includes(token));
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
// Computed style values of an element (inside the shadow root too).
const styleOf=(locator,...props)=>locator.evaluate((node,props)=>{const style=getComputedStyle(node);return props.map(prop=>style[prop]);},props);
const RED='rgb(179, 38, 30)'; // .news-error-line
// Touch input as iOS WebKit reports it: pointer events of pointerType 'touch', all sent to the element first
// touched (implicit capture), coordinates in the viewport. Playwright has no touch-drag API for WebKit.
// A touch on the script's own UI goes to the element inside its (test-opened) shadow root, as on a device.
async function pointer(page,type,[x,y]) {
  await page.evaluate(([type,x,y])=>{
    if(type==='pointerdown') {
      let el=document.elementFromPoint(x,y);
      while(el?.shadowRoot) {const inner=el.shadowRoot.elementFromPoint(x,y);if(!inner||inner===el) break;el=inner;}
      window.__touched=el;
    }
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
    assert.deepEqual(await styleOf(card(page).getByRole('button',{name:'朗读'}),'fontSize'),['18px']);
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
    assert.deepEqual(await styleOf(line,'color'),[RED]);
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

// -- analysis panel and follow-up questions ---------------------------------------------------------
// The FakeHub answers analyses with the spec §5 XML in pieces and questions with plain text; what it
// received is read back from news-hub-requests.json in the state dir.
// items: [form, level, brief, related=false, {connection, usage, confusable}]
function analysisChunks({selection,translation,items=[]}) {
  const out=['<analysis>'];
  if(selection) out.push(`<selection><reading>${selection[0]}</reading><role>${selection[1]}</role><meaning>${selection[2]}</meaning></selection>`);
  if(translation) out.push(`<translation>${translation}</translation>`);
  out.push('<grammar>');
  for(const [form,level,brief,related=false,more={}] of items) out.push(`<item related="${related}"><form>${form}</form><level>${level}</level><brief>${brief}</brief>`
    +`<connection>${more.connection??'接续说明'}</connection><usage>${more.usage??'用法说明'}</usage>${more.confusable?`<confusable>${more.confusable}</confusable>`:''}</item>`);
  out.push('</grammar></analysis>');
  return out;
}
const analyzeStep=(spec,delay=0)=>['chunks',analysisChunks(spec),delay];
const S1_TEXT='台風は強い勢力で島に接近するおそれがあります。';
const S2_TEXT='気象庁は早めの準備を呼びかけました。';
const P1=S1_TEXT+S2_TEXT; // both sentences are the first paragraph of the body
const S1_WORDS=['台風','は','強い','勢力','で','島','に','接近','する','おそれ','が','あり','ます','。'];
const S1_WHOLE={translation:'台风可能以强劲的势力接近岛屿。',items:[['〜は','N5','提示主题'],['〜で','N5','表示状态、方式'],
  ['〜おそれがある','N3','有…的可能（多指坏事）',false,{connection:'动词辞书形＋おそれがある',usage:'表示台风有接近岛屿的可能',confusable:'〜かもしれない 不限于坏事'}]]};
const S1_PART={selection:['つよいせいりょくで','修饰「接近する」，说明台风以什么状态接近。','以强劲的势力'],translation:'台风可能以强劲的势力接近岛屿。',
  items:[['〜は','N5','提示主题'],['〜で','N5','表示状态',true],['〜おそれがある','N3','有…的可能'],['い形容词＋名词','N5','形容词直接修饰名词',true]]};
const panel=page=>page.locator('jlpt-news .news-panel');
const analysisDone=page=>page.locator('jlpt-news .news-panel[data-analysis="done"]').waitFor();
const headings=page=>panel(page).locator('.news-panel-body > section:not([hidden]) > h3').allInnerTexts();
const forms=page=>panel(page).locator('.news-grammar-form').allInnerTexts();
const rounds=page=>panel(page).locator('.news-chat-round').evaluateAll(list=>list.map(round=>[round.querySelector('.news-chat-q').textContent,round.querySelector('.news-chat-a').textContent]));
// Waits until exactly n rounds are answered (not pending).
const answered=(page,n)=>page.waitForFunction(n=>document.querySelector('jlpt-news').shadowRoot.querySelectorAll('.news-panel .news-chat-round:not(.is-pending)').length===n,n);
async function hubRequests(tmp) {try {return JSON.parse(await readFile(join(tmp,'news-hub-requests.json'),'utf8'));} catch {return [];}}
async function hubDisconnects(tmp) {try {return Number(await readFile(join(tmp,'news-hub-disconnects'),'utf8'));} catch {return 0;}}
// Waits (up to 10 s) until the FakeHub has seen `count` requests dropped by the news server.
async function waitDisconnects(tmp,count) {
  for(const end=Date.now()+10000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,100))) if(await hubDisconnects(tmp)>=count) return true;
  return false;
}
// Bodies the page POSTs to /api/news/<name>, in order (the CORS preflights are left out).
function recordApi(page,name) {const bodies=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/news/'+name)) bodies.push(request.postDataJSON());});return bodies;}
// Long-press a sentence after scrolling it near the top (a bottom sheet may cover the lower half of the screen).
async function pressSentence(page,s,i=0) {
  const target=tok(page,s,i);
  await target.evaluate(node=>{node.scrollIntoView({block:'start'});window.scrollBy(0,-60);});
  await longPress(page,target);
  await panel(page).waitFor();
}
async function askQuestion(page,question) {
  await panel(page).locator('.news-ask-input').fill(question);
  await panel(page).locator('.news-ask-send').click();
}
async function askAndWait(page,question) {
  const done=await panel(page).locator('.news-chat-round:not(.is-pending)').count();
  await askQuestion(page,question);
  await answered(page,done+1);
}
const body=(tokens,start=null,end=null)=>({paragraph:P1,tokens,start,end});

for(const device of NEWS_DEVICES) {
  test(`sentence only shows 原文/译文/语法 without selection block on ${device}`,()=>withUserscript(device,async(page,{site,tmp})=>{
    await openArticle(page,site);
    const [A]=await ids(page,'台風は強い勢力で島に接近する');
    const analyses=recordApi(page,'analyze');
    assert.equal(await panel(page).isHidden(),true);
    await pressSentence(page,A);
    await analysisDone(page);
    assert.deepEqual(await headings(page),['原文','译文','语法']);
    assert.equal(await panel(page).locator('.news-panel-sentence').innerText(),S1_TEXT);
    assert.equal(await panel(page).locator('.news-panel-part').count(),0);
    assert.equal(await panel(page).locator('.news-panel-selection').count(),0);
    assert.equal(await panel(page).locator('.news-translation').innerText(),'台风可能以强劲的势力接近岛屿。');
    assert.deepEqual(await forms(page),['〜は','〜で','〜おそれがある']);
    assert.deepEqual(await panel(page).locator('.news-grammar-level').allInnerTexts(),['N5','N5','N3']);
    assert.deepEqual(await panel(page).locator('.news-grammar-brief').allInnerTexts(),['提示主题','表示状态、方式','有…的可能（多指坏事）']);
    assert.equal(await panel(page).locator('.news-grammar-detail:not([hidden])').count(),0);
    assert.equal(await panel(page).locator('.news-panel-status').innerText(),'');
    assert.equal(await panel(page).locator('.news-ask-input').getAttribute('placeholder'),'想问什么…');
    // The panel's controls keep their own styles: 16px input (iOS does not zoom on focus), white on blue send, a 24px ×.
    const [inputSize]=await styleOf(panel(page).locator('.news-ask-input'),'fontSize');
    assert.ok(parseFloat(inputSize)>=16,inputSize);
    assert.deepEqual(await styleOf(panel(page).locator('.news-ask-send'),'color','backgroundColor'),['rgb(255, 255, 255)','rgb(26, 115, 232)']);
    assert.deepEqual(await styleOf(panel(page).locator('.news-panel-close'),'fontSize','color'),['24px','rgb(102, 102, 102)']);
    const [rowSize,rowHeight]=await styleOf(panel(page).locator('.news-grammar-row').first(),'fontSize','lineHeight');
    assert.equal(parseFloat(rowHeight)/parseFloat(rowSize),1.5,`${rowHeight} / ${rowSize}`);
    // Nothing else to press: no read-aloud or quick-question buttons.
    assert.deepEqual(await panel(page).locator('button').evaluateAll(list=>list.map(b=>b.className.split(' ')[0])),
      ['news-panel-close','news-grammar-row','news-grammar-row','news-grammar-row','news-ask-send']);
    assert.doesNotMatch(await panel(page).innerText(),/🔊/);
    assert.deepEqual(analyses,[body(S1_WORDS)]);
    assert.match(JSON.stringify((await hubRequests(tmp))[0].messages),new RegExp(S1_TEXT));
    assert.deepEqual(await selectedIds(page),[A]);
    await panel(page).locator('.news-panel-close').click();
    assert.equal(await panel(page).isHidden(),true);
    assert.deepEqual(await selectedIds(page),[]);
  },{hub:[analyzeStep(S1_WHOLE)],select:'Auto'}));

  test(`part selection adds selection block and puts related grammar first on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site);
    const [A]=await ids(page,'台風は強い勢力で島に接近する');
    const analyses=recordApi(page,'analyze');
    await pressSentence(page,A);
    await analysisDone(page);
    await drag(page,await at(tok(page,A,2),0.3),await at(tok(page,A,4),0.5));
    assert.deepEqual(await partIndices(page),range(A,2,4));
    await panel(page).locator('.news-selection-reading').waitFor();
    await analysisDone(page);
    assert.deepEqual(await panel(page).locator('.news-panel-body > section:not([hidden])').evaluateAll(list=>list.map(s=>s.classList[1])),
      ['news-panel-original','news-panel-selection','news-panel-translation','news-panel-grammar']);
    assert.equal(await panel(page).locator('.news-panel-sentence').innerText(),S1_TEXT);
    assert.equal(await panel(page).locator('.news-panel-part').innerText(),'強い勢力で');
    // The part in the panel has the colour of the part on the page.
    const colors=await page.evaluate(()=>[getComputedStyle(document.querySelector('jlpt-news').shadowRoot.querySelector('.news-panel-part')).backgroundColor,getComputedStyle(document.querySelector('.jlpt-part')).backgroundColor]);
    assert.equal(colors[0],colors[1]);
    assert.equal(await panel(page).locator('.news-selection-text').innerText(),'強い勢力で');
    assert.equal(await panel(page).locator('.news-selection-reading').innerText(),'つよいせいりょくで');
    assert.equal(await panel(page).locator('.news-selection-role').innerText(),'修饰「接近する」，说明台风以什么状态接近。');
    assert.equal(await panel(page).locator('.news-selection-meaning').innerText(),'本句中：以强劲的势力');
    // Related items first, even when one arrives after unrelated ones.
    assert.deepEqual(await forms(page),['〜で','い形容词＋名词','〜は','〜おそれがある']);
    assert.deepEqual(analyses,[body(S1_WORDS),body(S1_WORDS,2,4)]);
  },{hub:[analyzeStep(S1_WHOLE),analyzeStep(S1_PART)],select:'Auto'}));

  test(`grammar row expands and links to grammar card on ${device}`,()=>withUserscript(device,async(page,{app,site,context})=>{
    await openArticle(page,site);
    const [A]=await ids(page,'台風は強い勢力で島に接近する');
    await pressSentence(page,A);
    await analysisDone(page);
    const items=panel(page).locator('.news-grammar-item');
    const row=items.nth(2).locator('.news-grammar-row');
    assert.equal(await row.getAttribute('aria-expanded'),'false');
    await row.click();
    assert.equal(await row.getAttribute('aria-expanded'),'true');
    assert.deepEqual(await items.nth(2).locator('.news-grammar-detail p').allInnerTexts(),
      ['接续：动词辞书形＋おそれがある','本句用法：表示台风有接近岛屿的可能','易混淆：〜かもしれない 不限于坏事']);
    await items.nth(0).locator('.news-grammar-row').click();
    assert.deepEqual(await items.nth(0).locator('.news-grammar-detail p').allInnerTexts(),['接续：接续说明','本句用法：用法说明']);
    await row.click();
    assert.equal(await items.nth(2).locator('.news-grammar-detail').isHidden(),true);
    assert.equal(await items.nth(0).locator('.news-grammar-card').count(),0);
    // The card is on this site, opened in a new tab; the news page stays.
    const link=items.nth(2).locator('.news-grammar-card');
    assert.equal(await link.innerText(),'语法卡');
    assert.equal(await link.getAttribute('href'),app+'/grammar/#N3/5-5');
    assert.equal(await link.getAttribute('target'),'_blank');
    assert.equal(await link.getAttribute('rel'),'noopener');
    const address=page.url();
    const opened=context.waitForEvent('page');
    await link.click();
    const tab=await opened;
    await tab.waitForURL(app+'/grammar/#N3/5-5');
    assert.equal(page.url(),address);
  },{hub:[analyzeStep(S1_WHOLE)],select:'Auto'}));

  test(`follow-up keeps context within sentence and sends history on ${device}`,()=>withUserscript(device,async(page,{site,tmp})=>{
    await openArticle(page,site);
    const [A]=await ids(page,'台風は強い勢力で島に接近する');
    const asks=recordApi(page,'ask');
    await pressSentence(page,A);
    await analysisDone(page);
    const q1='可以换成「強い勢力に」吗？',a1='不行。に 会变成「变成强劲势力」的意思。';
    await askQuestion(page,q1);
    const pending=panel(page).locator('.news-chat-round.is-pending');
    await pending.locator('.news-chat-a',{hasText:'不行。'}).waitFor();
    assert.equal(await pending.locator('.news-chat-q').innerText(),'我：'+q1);
    assert.equal(await panel(page).locator('.news-ask-send').isDisabled(),true);
    assert.equal(await panel(page).locator('.news-ask-input').inputValue(),'');
    await answered(page,1);
    assert.deepEqual(await rounds(page),[['我：'+q1,'答：'+a1]]);
    assert.deepEqual(await headings(page),['原文','译文','语法','追问']);
    assert.equal(await panel(page).locator('.news-ask-send').isDisabled(),false);
    const q2='那「で」呢？';
    await askAndWait(page,q2);
    assert.deepEqual(await rounds(page),[['我：'+q1,'答：'+a1],['我：'+q2,'答：で 表示状态。']]);
    const analysis=analysisChunks(S1_WHOLE).join('');
    assert.deepEqual(asks[0],{...body(S1_WORDS),analysis,history:[],question:q1});
    assert.deepEqual(asks[1],{...body(S1_WORDS),analysis,history:[{q:q1,a:a1}],question:q2});
    const third=(await hubRequests(tmp))[2].messages;
    assert.match(third[0].content,/已给出的分析/);
    assert.ok(third[0].content.includes(analysis));
    assert.deepEqual(third.slice(1),[{role:'user',content:q1},{role:'assistant',content:a1},{role:'user',content:q2}]);
    // A long conversation sends only the last 6 rounds.
    for(let n=3;n<=7;n++) await askAndWait(page,`问题${n}`);
    await askAndWait(page,'问题8');
    assert.equal((await rounds(page)).length,8);
    assert.deepEqual(asks[7].history.map(item=>item.q),[q2,'问题3','问题4','问题5','问题6','问题7']);
  },{hub:[analyzeStep(S1_WHOLE),['chunks',['不行。','に 会变成「变成强劲势力」的意思。'],1.0],['chunks',['で 表示状态。'],0],['chunks',['好的。'],0]],select:'Auto'}));

  test(`switching sentence while streaming discards the old stream on ${device}`,()=>withUserscript(device,async(page,{site,tmp})=>{
    await openArticle(page,site);
    const [A,B]=await ids(page,'台風は強い勢力で島に接近する','気象庁は');
    await pressSentence(page,A);
    await panel(page).locator('.news-translation',{hasText:'第一句的译文'}).waitFor();
    await pressSentence(page,B);
    await panel(page).locator('.news-translation',{hasText:'第二句的译文'}).waitFor();
    await analysisDone(page);
    assert.equal(await panel(page).locator('.news-panel-sentence').innerText(),S2_TEXT);
    // The server stops reading the abandoned analysis once it notices the page has gone; nothing of it is drawn.
    assert.ok(await waitDisconnects(tmp,1),'the server stops reading the abandoned analysis');
    await page.waitForTimeout(1000);
    assert.deepEqual(await forms(page),['〜を']);
    assert.doesNotMatch(await panel(page).innerText(),/第一句/);
    // An answer still streaming is dropped too, and the conversation starts over.
    await askQuestion(page,'这里的を是什么？');
    await panel(page).locator('.news-chat-a',{hasText:'旧回答一'}).waitFor();
    await pressSentence(page,A);
    await panel(page).locator('.news-translation',{hasText:'第一句又一次'}).waitFor();
    assert.equal(await panel(page).locator('.news-chat-round').count(),0);
    assert.deepEqual(await headings(page),['原文','译文']);
    assert.ok(await waitDisconnects(tmp,2),'the server stops reading the abandoned answer');
    await page.waitForTimeout(1000);
    assert.doesNotMatch(await panel(page).innerText(),/旧回答/);
    assert.equal(await panel(page).locator('.news-panel-sentence').innerText(),S1_TEXT);
    assert.deepEqual(await selectedIds(page),[A]);
  },{hub:[analyzeStep({translation:'第一句的译文',items:[['〜は','N5','第一句语法'],['〜で','N5','第一句语法'],['〜おそれがある','N3','第一句语法']]},0.8),
    analyzeStep({translation:'第二句的译文',items:[['〜を','N5','第二句语法']]}),
    ['chunks',['旧回答一','旧回答二','旧回答三','旧回答四','旧回答五'],1.0],analyzeStep({translation:'第一句又一次'})],select:'Auto'}));

  test(`changing part keeps follow-ups on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site);
    const [A,B]=await ids(page,'台風は強い勢力で島に接近する','気象庁は');
    const analyses=recordApi(page,'analyze'),asks=recordApi(page,'ask');
    await pressSentence(page,A);
    await analysisDone(page);
    await askAndWait(page,'问题一');
    await drag(page,await at(tok(page,A,2),0.3),await at(tok(page,A,4),0.5));
    await panel(page).locator('.news-selection-reading').waitFor();
    await analysisDone(page);
    assert.equal(await panel(page).locator('.news-panel-part').innerText(),'強い勢力で');
    assert.deepEqual(await rounds(page),[['我：问题一','答：答一']]);
    await askAndWait(page,'问题二');
    assert.deepEqual(await rounds(page),[['我：问题一','答：答一'],['我：问题二','答：答二']]);
    assert.deepEqual(asks[1],{...body(S1_WORDS,2,4),analysis:analysisChunks(S1_PART).join(''),history:[{q:'问题一',a:'答一'}],question:'问题二'});
    // The word card's 「在本句中的作用」 on another sentence: a new sentence (conversation cleared), analysed as a part directly.
    await tap(page,tok(page,B,4));
    await card(page).locator('.news-card-meaning',{hasText:'准备'}).waitFor();
    await card(page).locator('.news-card-role').click();
    await panel(page).locator('.news-panel-part',{hasText:'準備'}).waitFor();
    await analysisDone(page);
    assert.equal(await panel(page).locator('.news-panel-sentence').innerText(),S2_TEXT);
    assert.equal(await panel(page).locator('.news-chat-round').count(),0);
    assert.deepEqual(await partIndices(page),[`${B}:4`]);
    assert.deepEqual(analyses.map(item=>[item.tokens.join(''),item.start,item.end]),[[S1_TEXT,null,null],[S1_TEXT,2,4],[S2_TEXT,4,4]]);
  },{hub:[analyzeStep(S1_WHOLE),['chunks',['答一'],0],analyzeStep(S1_PART),['chunks',['答二'],0],
    ['chunks',['<gloss><meaning>准备</meaning></gloss>'],0],
    analyzeStep({selection:['じゅんび','作「を」的宾语','准备'],translation:'气象厅呼吁尽早做好准备。',items:[['〜を','N5','宾语',true]]})],select:'Auto'}));

  test(`model error shows stage line; format leftovers shown under 其他内容 on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site);
    const [A,B]=await ids(page,'台風は強い勢力で島に接近する','気象庁は');
    const asks=recordApi(page,'ask');
    const status=panel(page).locator('.news-panel-status');
    // No model chosen: one error line, nothing to retry, no automatic model switch.
    await pressSentence(page,A);
    await status.locator('.news-error-line').waitFor();
    assert.equal(await status.innerText(),'模型生成失败（句子分析）：请先点右下角按钮，在菜单里选择模型');
    assert.deepEqual(await styleOf(status.locator('.news-error-line'),'color'),[RED]);
    assert.deepEqual(await headings(page),['原文']);
    // The dock stays reachable while the panel is open.
    const menu=await openDock(page);
    await menu.locator('.news-model').click();
    await menu.locator('.news-model-list button',{hasText:'Auto'}).click();
    await menu.locator('.news-model',{hasText:'模型：Auto'}).waitFor();
    await dockButton(page).click();
    await dockMenu(page).waitFor({state:'hidden'});
    // Pressing the same sentence again analyses again; the model is reported unavailable.
    await pressSentence(page,A);
    await status.locator('.news-error-line',{hasText:'当前模型不可用'}).waitFor();
    assert.equal(await status.innerText(),'模型生成失败（句子分析）：当前模型不可用，请重新选择');
    await pressSentence(page,A);
    await status.locator('.news-error-line',{hasText:'模型排队中'}).waitFor();
    assert.equal(await status.innerText(),'模型生成失败（句子分析）：模型排队中，请稍后重试　重试');
    await status.locator('.news-error-retry').click();
    await analysisDone(page);
    assert.deepEqual(await headings(page),['原文','译文','其他内容']);
    assert.equal(await panel(page).locator('.news-translation').innerText(),'台风可能接近岛屿。');
    assert.match(await panel(page).locator('.news-extra-text').innerText(),/^说明：这句话是新闻。\n<item related="false"><form>〜は/);
    assert.equal(await status.innerText(),'');
    // Nothing matches the template: the raw reply under 其他内容, then the format error line.
    await pressSentence(page,B);
    await status.locator('.news-error-line').waitFor();
    assert.deepEqual(await headings(page),['原文','其他内容']);
    assert.equal(await panel(page).locator('.news-extra-text').innerText(),'完全不是模板的回答');
    assert.equal(await status.innerText(),'解析回复失败（句子分析）：回复不符合分析模板　重试');
    assert.deepEqual(await panel(page).locator('.news-panel-body > section:not([hidden]), .news-panel-body > .news-panel-status').evaluateAll(list=>list.map(n=>n.classList[n.classList.length-1])),
      ['news-panel-original','news-panel-extra','news-panel-status']);
    // A question that fails shows the line where the answer goes; 重试 sends the same question again.
    await askQuestion(page,'这句是什么意思？');
    const round=panel(page).locator('.news-chat-round');
    await round.locator('.news-error-line').waitFor();
    assert.equal(await round.locator('.news-error-line').innerText(),'模型生成失败（追问）：模型排队中，请稍后重试');
    assert.deepEqual(await styleOf(round.locator('.news-error-line'),'color'),[RED]);
    assert.equal(await round.locator('.news-chat-q').innerText(),'我：这句是什么意思？');
    await round.locator('.news-error-retry').click();
    await round.locator('.news-error-line',{hasText:'qoder2api-hub 中途断开'}).waitFor();
    assert.equal(await round.locator('.news-chat-a').innerText(),'答：答到一半');
    assert.equal(await round.locator('.news-error-line').innerText(),'推送到网页失败（追问）：qoder2api-hub 中途断开');
    await round.locator('.news-error-retry').click();
    await answered(page,1);
    assert.deepEqual(await rounds(page),[['我：这句是什么意思？','答：完整回答']]);
    assert.equal(await panel(page).locator('.news-chat .news-error').count(),0);
    assert.deepEqual(asks.map(item=>[item.question,item.history.length,item.tokens.join('')]),
      [['这句是什么意思？',0,S2_TEXT],['这句是什么意思？',0,S2_TEXT],['这句是什么意思？',0,S2_TEXT]]);
  },{hub:[['status',404,{error:{message:'model not found'}}],['status',429,'busy'],
    ['chunks',['<analysis><translation>台风可能接近岛屿。</translation>','说明：这句话是新闻。<item related="false"><form>〜は</form><level>N5</level><brief>提示主题</brief>'],0],
    ['chunks',['完全不是模板的回答'],0],['status',429,'busy'],['cut_after',['答到一半'],0],['chunks',['完整回答'],0]]}));

  test(`a question asked during the analysis waits and carries the final analysis on ${device}`,()=>withUserscript(device,async(page,{site,tmp})=>{
    await openArticle(page,site);
    const [A]=await ids(page,'台風は強い勢力で島に接近する');
    const asks=recordApi(page,'ask');
    const waiting=async question=>{
      await askQuestion(page,question);
      const round=panel(page).locator('.news-chat-round.is-pending');
      assert.equal(await round.locator('.news-chat-q').innerText(),'我：'+question);
      assert.equal(await round.locator('.news-progress').innerText(),'分析完成后发送…');
      assert.equal(await panel(page).locator('.news-ask-send').isDisabled(),true);
    };
    // First analysis of the sentence, still streaming.
    await pressSentence(page,A);
    await panel(page).locator('.news-translation').waitFor();
    assert.equal(await panel(page).getAttribute('data-analysis'),'running');
    await waiting('问题一');
    await page.waitForTimeout(500);
    assert.equal(asks.length,0,'nothing is sent before the analysis is done');
    await answered(page,1);
    assert.deepEqual(await rounds(page),[['我：问题一','答：答一']]);
    assert.equal(asks[0].analysis,analysisChunks(S1_WHOLE).join(''));
    assert.ok((await hubRequests(tmp))[1].messages[0].content.includes(analysisChunks(S1_WHOLE).join('')));
    // After a part change the conversation is kept and the question waits for the part's analysis.
    await drag(page,await at(tok(page,A,2),0.3),await at(tok(page,A,4),0.5));
    await panel(page).locator('.news-panel-part',{hasText:'強い勢力で'}).waitFor();
    assert.equal(await panel(page).getAttribute('data-analysis'),'running');
    await waiting('问题二');
    assert.equal(asks.length,1);
    await answered(page,2);
    assert.deepEqual(asks[1],{...body(S1_WORDS,2,4),analysis:analysisChunks(S1_PART).join(''),history:[{q:'问题一',a:'答一'}],question:'问题二'});
  },{hub:[analyzeStep(S1_WHOLE,0.5),['chunks',['答一'],0],analyzeStep(S1_PART,0.5),['chunks',['答二'],0]],select:'Auto'}));

  test(`closing the panel mid-analysis stops the stream and reopening starts empty on ${device}`,()=>withUserscript(device,async(page,{site,tmp})=>{
    await openArticle(page,site);
    const [A]=await ids(page,'台風は強い勢力で島に接近する');
    await pressSentence(page,A);
    await analysisDone(page);
    await askAndWait(page,'问题一');
    await drag(page,await at(tok(page,A,2),0.3),await at(tok(page,A,4),0.5));
    await panel(page).locator('.news-selection-reading').waitFor();
    assert.equal(await panel(page).getAttribute('data-analysis'),'running');
    await panel(page).locator('.news-panel-close').click();
    await panel(page).waitFor({state:'hidden'});
    assert.deepEqual(await selectedIds(page),[]);
    assert.deepEqual(await partIndices(page),[]);
    assert.ok(await waitDisconnects(tmp,1),'the server stops reading the closed analysis');
    await pressSentence(page,A);
    await analysisDone(page);
    assert.equal(await panel(page).locator('.news-panel-part').count(),0);
    assert.equal(await panel(page).locator('.news-chat-round').count(),0);
    assert.deepEqual(await headings(page),['原文','译文','语法']);
    assert.equal(await panel(page).locator('.news-ask-input').inputValue(),'');
  },{hub:[analyzeStep(S1_WHOLE),['chunks',['答一'],0],analyzeStep(S1_PART,0.8),analyzeStep(S1_WHOLE)],select:'Auto'}));
}

test('a long answer is cut to the server limit when it is sent back as history',()=>withUserscript('iPhone 13',async(page,{site})=>{
  await openArticle(page,site);
  const [A]=await ids(page,'台風は強い勢力で島に接近する');
  const asks=recordApi(page,'ask');
  await pressSentence(page,A);
  await analysisDone(page);
  await askAndWait(page,'问题一');
  assert.equal((await rounds(page))[0][1].length,'答：'.length+4500);
  await askAndWait(page,'问题二');
  assert.deepEqual(await rounds(page).then(list=>list[1]),['我：问题二','答：好的。']);
  assert.equal(asks[1].history[0].a,'あ'.repeat(4000));
  assert.equal(await panel(page).locator('.news-chat .news-error').count(),0);
},{hub:[analyzeStep(S1_WHOLE),['chunks',['あ'.repeat(4500)],0],['chunks',['好的。'],0]],select:'Auto'}));

for(const [device,mode] of [['iPad Pro 11 landscape','right'],['iPad Pro 11','sheet'],['iPhone 13','sheet']]) {
  test(`iPad landscape panel on right; iPhone bottom sheet on ${device}`,()=>withUserscript(device,async(page,{site})=>{
    await openArticle(page,site);
    const [A,B]=await ids(page,'台風は強い勢力で島に接近する','気象庁は');
    const viewport=page.viewportSize();
    await pressSentence(page,A);
    await analysisDone(page);
    const box=await panel(page).boundingBox();
    if(mode==='right') {
      assert.ok(Math.abs(box.width-viewport.width*0.35)<=2,`width ${box.width}`);
      assert.ok(Math.abs(box.x-viewport.width*0.65)<=2,`left edge ${box.x}`);
      assert.ok(Math.abs(box.x+box.width-viewport.width)<=1);
      assert.equal(box.y,0);
      assert.ok(Math.abs(box.height-viewport.height)<=1);
      assert.equal(await panel(page).locator('.news-panel-handle').isVisible(),false);
      // The dock moves left of the panel instead of covering its send button.
      const dock=await dockButton(page).boundingBox();
      assert.ok(dock.x+dock.width<=box.x,JSON.stringify([dock,box]));
      // An article word left of the panel can still be tapped, and the page still scrolls.
      await page.addStyleTag({content:'article{padding-bottom:3000px}'});
      const word=tok(page,A,3);
      const wordBox=await word.boundingBox();
      assert.ok(wordBox.x+wordBox.width<box.x,JSON.stringify([wordBox,box]));
      await tap(page,word);
      await card(page).locator('.news-card-meaning',{hasText:'势力'}).waitFor();
      assert.equal(await panel(page).isVisible(),true);
      const before=await page.evaluate(()=>scrollY);
      await page.evaluate(()=>window.scrollBy(0,400));
      assert.ok(await page.evaluate(()=>scrollY)>before);
      assert.equal((await panel(page).boundingBox()).y,0);
      await page.evaluate(()=>window.scrollTo(0,0));
      await pressSentence(page,B);
      await panel(page).locator('.news-panel-sentence',{hasText:S2_TEXT}).waitFor();
      assert.deepEqual(await selectedIds(page),[B]);
      return;
    }
    assert.equal(box.x,0);
    assert.ok(Math.abs(box.width-viewport.width)<=1);
    assert.ok(Math.abs(box.y+box.height-viewport.height)<=1,'docked to the bottom');
    assert.ok(box.height>viewport.height*0.4&&box.height<viewport.height*0.7,`height ${box.height}`);
    // The selected sentence stays above the sheet.
    const sentence=await page.locator(`.jlpt-t[data-s="${A}"]`).evaluateAll(spans=>{
      const rects=spans.flatMap(span=>[...span.getClientRects()]);
      return {top:Math.min(...rects.map(r=>r.top)),bottom:Math.max(...rects.map(r=>r.bottom))};
    });
    assert.ok(sentence.top>=0&&sentence.bottom<=box.y,JSON.stringify([sentence,box]));
    // The dock sits above the sheet, not on its send button.
    const dock=await dockButton(page).boundingBox();
    assert.ok(dock.y+dock.height<=box.y,JSON.stringify([dock,box]));
    // The page has room below its end: even the article's last sentence scrolls above the sheet.
    const [D]=await ids(page,'雨は');
    const last=await tok(page,D,0).evaluate(node=>{node.scrollIntoView({block:'start'});window.scrollBy(0,-60);return node.getBoundingClientRect().bottom;});
    assert.ok(last<=box.y,JSON.stringify([last,box]));
    const handle=panel(page).locator('.news-panel-handle');
    const grab=async()=>{const b=await handle.boundingBox();return [b.x+b.width*0.3,b.y+b.height/2];};
    const isFull=()=>panel(page).evaluate(node=>node.classList.contains('is-full'));
    // Drag up: full screen.
    let from=await grab();
    await drag(page,from,[from[0],20]);
    assert.equal(await isFull(),true);
    const full=await panel(page).boundingBox();
    assert.ok(full.y<=1&&Math.abs(full.height-viewport.height)<=1,`full ${JSON.stringify(full)}`);
    // Drag down a little: back to half height; a longer drag down closes it.
    from=await grab();
    await drag(page,from,[from[0],from[1]+200]);
    assert.equal(await isFull(),false);
    assert.ok(Math.abs((await panel(page).boundingBox()).height-box.height)<=2);
    from=await grab();
    await drag(page,from,[from[0],from[1]+160]);
    await panel(page).waitFor({state:'hidden'});
    assert.deepEqual(await selectedIds(page),[]);
    assert.equal(await page.locator('html[data-jlpt-panel]').count(),0);
    await pressSentence(page,A);
    await panel(page).locator('.news-panel-close').click();
    await panel(page).waitFor({state:'hidden'});
    assert.deepEqual(await selectedIds(page),[]);
  },{hub:mode==='right'?[analyzeStep(S1_WHOLE),GLOSS_HUB[0],analyzeStep({translation:'第二句的译文'})]:[analyzeStep(S1_WHOLE)],select:'Auto'}));
}

test('the analysis request carries the paragraph and the sentence words',()=>withUserscript('iPhone 13',async(page,{site,tmp})=>{
  await openArticle(page,site);
  const [B]=await ids(page,'気象庁は');
  const analyses=recordApi(page,'analyze');
  await pressSentence(page,B);
  await analysisDone(page);
  assert.deepEqual(analyses,[body(['気象庁','は','早め','の','準備','を','呼びかけ','まし','た','。'])]);
  // What the model is asked: the whole paragraph, then the sentence.
  const [request]=await hubRequests(tmp);
  const user=request.messages.find(message=>message.role==='user').content;
  assert.ok(user.includes(`所在段落：\n${P1}\n`),user);
  assert.ok(user.includes(`原句：\n${S2_TEXT}`),user);
},{hub:[analyzeStep({translation:'气象厅呼吁尽早做好准备。'})],select:'Auto'}));
