import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(new URL('../../mobile/package.json',import.meta.url));
const {chromium,devices}=require('playwright');

async function withSite(engine,options,run,env={}) {
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-site-'));
  const server=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{server.stdout.once('data',data=>resolve(data.toString().trim()));server.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await engine.launch();
    const page=await (await browser.newContext(options)).newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url+'/login.html');
    await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();
    await page.waitForURL(url+'/review/');
    await run(page,url,tmp);
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();server.kill();await rm(tmp,{recursive:true,force:true});}
}

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
