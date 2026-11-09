import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
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
