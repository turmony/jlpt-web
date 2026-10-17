import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(new URL('../../mobile/package.json',import.meta.url));
const {chromium,webkit,devices}=require('playwright');

async function withSite(engine,options,run) {
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-site-'));
  const server=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{server.stdout.once('data',data=>resolve(data.toString().trim()));server.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await engine.launch();
    const page=await (await browser.newContext(options)).newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url+'/login.html');
    await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();
    await page.waitForURL(url+'/grammar/');
    await run(page,url,tmp);
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();server.kill();await rm(tmp,{recursive:true,force:true});}
}

test('home and login open grammar memory with links to papers and cloud development',()=>withSite(chromium,{},async(page,url)=>{
  await page.locator('#start-reading:not([disabled])').waitFor();
  await page.goto(url+'/');await page.waitForURL(url+'/grammar/');
  await page.goto(url+'/login.html');await page.waitForURL(url+'/grammar/');
  assert.equal(await page.getByRole('link',{name:'做题'}).getAttribute('href'),'/papers.html');
  assert.equal(await page.getByRole('link',{name:'云开发'}).getAttribute('href'),'/code/');
  assert.equal((await page.goto(url+'/practice.html')).status(),404);
}));

for(const [name,engine] of Object.entries({chromium,webkit})) {
  test(`${name}: a paper is answered by tapping option blocks and written to its answer area`,()=>withSite(engine,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
    page.on('dialog',dialog=>dialog.accept());
    await page.getByRole('link',{name:'做题'}).click();
    await page.getByRole('link',{name:/测试试卷/}).click();
    const lists=page.locator('.option-list');
    await lists.nth(0).locator('.option-block').nth(0).click();
    assert.equal(await lists.nth(0).locator('[aria-pressed=true]').count(),1);
    for(const index of [1,3,0,2]) await lists.nth(1).locator('.option-block').nth(index).click();
    assert.equal(await page.locator('.order-line').innerText(),'语序：2 → 4 → 1 → 3');
    assert.equal(await lists.nth(1).locator('.order-badge').nth(1).innerText(),'①');
    await page.locator('.uncertain-switch').nth(1).click();
    await page.locator('#progress',{hasText:'已答 2 / 2'}).waitFor();
    await page.locator('#submit').click();
    await page.locator('#submitted').waitFor();
    assert.match(await page.locator('#grade-prompt').innerText(),/papers\/2026-10-14-test\.md/);
    const text=await readFile(join(tmp,'study/jlpt-notes/quizzes/papers/2026-10-14-test.md'),'utf8');
    assert.match(text,/```text\n1-1, \*2-2413\n```/);
    await page.goto(url+'/papers.html');
    assert.equal(await page.locator('.status-chip').innerText(),'已提交');
  }));
}
