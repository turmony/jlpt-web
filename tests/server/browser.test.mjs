import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(new URL('../../mobile/package.json',import.meta.url));
const {chromium,webkit,devices}=require('playwright');

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

test('home and login open the review plan; grammar page links back',()=>withSite(chromium,{},async(page,url)=>{
  await page.goto(url+'/');await page.waitForURL(url+'/review/');
  await page.goto(url+'/login.html');await page.waitForURL(url+'/review/');
  await page.goto(url+'/grammar/');
  await page.locator('#start-reading:not([disabled])').waitFor();
  assert.equal(await page.getByRole('link',{name:'今日安排'}).getAttribute('href'),'/review/');
  assert.equal(await page.getByRole('link',{name:'做题'}).getAttribute('href'),'/papers.html');
  assert.equal(await page.getByRole('link',{name:'云开发'}).getAttribute('href'),'/code/');
  assert.equal((await page.goto(url+'/practice.html')).status(),404);
}));

for(const device of ['iPhone SE','iPhone 13','Desktop Chrome']) {
  test(`grammar page navigation leaves the header readable on ${device}`,()=>withSite(chromium,{...devices[device],locale:'zh-CN'},async(page,url)=>{
    const covers=selector=>page.evaluate(selector=>{
      const nav=document.querySelector('.shell > nav').getBoundingClientRect();
      return [...document.querySelectorAll(selector)].some(node=>{const box=node.getBoundingClientRect();return box.width>0&&nav.left<box.right&&box.left<nav.right&&nav.top<box.bottom&&box.top<nav.bottom;});
    },selector);
    await page.goto(url+'/grammar/');await page.locator('#start-reading:not([disabled])').waitFor();
    assert.equal(await covers('.brand span, .brand svg'),false);
    await page.locator('#start-reading').click();await page.locator('#change-range').waitFor();
    assert.equal(await covers('#change-range, #range-label'),false);
  }));
}

test('a home-screen launch at grammar memory opens the review plan first',()=>withSite(webkit,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url)=>{
  const context=page.context();
  const tab=await context.newPage();
  await tab.goto(url+'/grammar/');await tab.locator('#start-reading:not([disabled])').waitFor();
  assert.equal(tab.url(),url+'/grammar/');
  await tab.close();
  await context.addInitScript(()=>Object.defineProperty(Navigator.prototype,'standalone',{configurable:true,get:()=>true}));
  const app=await context.newPage();
  await app.goto(url+'/grammar/');await app.waitForURL(url+'/review/');
  await app.getByRole('navigation',{name:'学习导航'}).getByRole('link',{name:'语法记忆'}).click();
  await app.waitForURL(url+'/grammar/');await app.locator('#start-reading:not([disabled])').waitFor();
  assert.equal(app.url(),url+'/grammar/');
}));

test('today\'s spaced review groups due units by learning date and records the ticked ones',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const beijing=offset=>new Date(Date.now()+8*3600e3+offset*864e5).toISOString().slice(0,10);
  const plan=join(tmp,'study/jlpt-notes/groups/spaced-reviews.json');
  await writeFile(plan,JSON.stringify({schema_version:1,anchors:{'G-001':beijing(0),'G-002':beijing(0),'G-003':beijing(-2)},done:[]}));
  const folder=join(tmp,'study/jlpt-notes/groups/submissions/r1');
  await mkdir(folder,{recursive:true});
  for (const [unit,offset] of [['G-001',-1],['G-002',-1],['G-003',-3]]) await writeFile(join(folder,`${unit}.json`),JSON.stringify({unit_id:unit,submitted_at:`${beijing(offset)}T20:00:00+08:00`}));
  await page.reload();
  const block=page.locator('#spaced-review');
  await block.getByText('有 3 个单元待复习').waitFor();
  const groups=block.locator('.spaced-group');
  assert.equal(await groups.count(),2);
  assert.match(await groups.nth(0).innerText(),/第 1 天复习[\s\S]*逾期 2 天[\s\S]*G-003/);
  assert.doesNotMatch(await groups.nth(1).innerText(),/逾期/);
  assert.equal(await page.locator('#spaced-submit').isDisabled(),true);
  await groups.nth(1).getByRole('button',{name:'G-001'}).click();
  assert.equal(await groups.nth(1).getByRole('button',{name:'G-001'}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#spaced-count').innerText(),'已选 1 / 3');
  await groups.nth(0).getByRole('button',{name:'全选本组'}).click();
  assert.equal(await page.locator('#spaced-count').innerText(),'已选 2 / 3');
  await groups.nth(0).getByRole('button',{name:'取消本组'}).click();
  await groups.nth(0).getByRole('button',{name:'全选本组'}).click();
  await page.locator('#spaced-submit').click();
  await block.getByText('有 1 个单元待复习').waitFor();
  assert.equal(await page.locator('#spaced-done').innerText(),'今日已复习：G-001、G-003');
  assert.equal(await block.locator('.spaced-unit').count(),1);
  const stored=JSON.parse(await readFile(plan,'utf8'));
  assert.deepEqual(stored.done.map(item=>[item.unit,item.step,item.date]),[['G-001',1,beijing(0)],['G-003',1,beijing(0)]]);
  await page.reload();
  await block.getByText('有 1 个单元待复习').waitFor();
  assert.equal(await block.locator('.spaced-unit[aria-pressed=true]').count(),0);
}));

test('today\'s new units follow daily_new and what was actually submitted',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const notes=join(tmp,'study/jlpt-notes/groups');
  assert.equal(await page.locator('#daily-new').isHidden(),true);
  await mkdir(notes,{recursive:true});
  await writeFile(join(notes,'plan.json'),JSON.stringify({schema_version:1,round:1,review_cycle:'off',daily_new:2}));
  await page.reload();
  const block=page.locator('#daily-new');
  await block.getByText('每天 2 个 · 今天已交卷 0 个，还差 2 个').waitFor();
  const rows=block.locator('li');
  assert.equal(await rows.count(),2);
  assert.match(await rows.nth(0).innerText(),/B-01-1[\s\S]*待学[\s\S]*开始/);
  assert.match(await rows.nth(1).innerText(),/B-01-2[\s\S]*尚未准备/);
  assert.equal(await rows.nth(1).getByRole('button').count(),0);
  await mkdir(join(notes,'submissions/r1'),{recursive:true});
  await writeFile(join(notes,'submissions/r1/B-01-1.json'),JSON.stringify({schema_version:1,unit_id:'B-01-1',round:1,paper:'2026-10-17-b-01-1',note:'',submitted_at:new Date().toISOString()}));
  await page.reload();
  await block.getByText('今天已交卷 1 个，还差 1 个').waitFor();
  assert.match(await rows.nth(0).innerText(),/B-01-1[\s\S]*今天已完成 ✓/);
}));

test('the cycle line follows the plan: shown while the 7-day review is on, hidden once it is retired',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  await page.locator('#progress-cycle',{hasText:'距下次复习还差 7 个学习日'}).waitFor();
  const plan=join(tmp,'study/jlpt-notes/groups/plan.json');
  await mkdir(join(tmp,'study/jlpt-notes/groups'),{recursive:true});
  await writeFile(plan,JSON.stringify({schema_version:1,round:1,review_cycle:'off'}));
  await page.reload();
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  assert.equal(await page.locator('#progress-cycle').isHidden(),true);
  assert.equal(await page.locator('#status').innerText().then(text=>text.includes('复习已到期')),false);
}));

test('stage progress shows the current stage, the next milestone and the plan directory',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const finish=async(unit,minute)=>{
    const folder=join(tmp,'study/jlpt-notes/groups/submissions/r1');
    await mkdir(folder,{recursive:true});
    await writeFile(join(folder,`${unit}.json`),JSON.stringify({schema_version:1,unit_id:unit,round:1,paper:`2026-10-17-${unit.toLowerCase()}`,
      sentence:{card:'N5-G-0013',text:'文。'},note:'',submitted_at:`2026-10-17T20:${minute}:00+08:00`}));
  };
  const stage=title=>page.locator('.stage',{has:page.locator('summary',{hasText:title})});
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  assert.equal(await page.locator('#progress-bar .stage-segment').count(),1);
  assert.equal(await page.locator('#progress-bar .stage-segment .stage-marker').count(),1);
  assert.equal(await page.locator('#next-milestone').innerText(),'下一个节点：学完基础体系表（还差 2 个单元）');
  assert.equal(await page.locator('#stage-legend').innerText(),'基础体系表 0/2');
  assert.equal(await page.locator('#stage-legend [data-status=current]').count(),1);
  await page.locator('#directory > summary').click();
  assert.equal(await stage('基础体系表').evaluate(details=>details.open),true);
  assert.match(await stage('基础体系表').locator('summary').innerText(),/基础体系表[\s\S]*0\/2[\s\S]*当前阶段/);
  assert.equal(await stage('ものごとの様子').evaluate(details=>details.open),false);
  assert.match(await stage('ものごとの様子').locator('summary').innerText(),/待整理（不计入总数）/);
  assert.match(await page.locator('.directory-list li.is-current').innerText(),/B-01-1/);

  await finish('B-01-1','10');await page.reload();
  await page.locator('#progress-summary',{hasText:'已学 1 / 2'}).waitFor();
  assert.equal(await page.locator('#progress-bar .stage-fill').evaluate(fill=>fill.style.width),'50%');
  assert.equal(await page.locator('#next-milestone').innerText(),'下一个节点：学完基础体系表（还差 1 个单元）');
  assert.match(await page.locator('.directory-list li.is-current').textContent(),/B-01-2/);
  // A learned unit opens in place of the overview (not below the open directory) and the back button restores it.
  await page.locator('#directory > summary').click();
  await page.locator('.directory-list li',{hasText:'B-01-1'}).getByRole('button',{name:'查看'}).click();
  await page.locator('#unit-title',{hasText:'B-01-1'}).waitFor();
  assert.equal(await page.locator('#plan-progress').isHidden(),true);
  assert.equal(await page.locator('#unit-view h2',{hasText:'已交卷'}).count(),1);
  assert.equal(await page.locator('#unit-view h2',{hasText:'试题回顾'}).count(),1);
  assert.equal(await page.locator('#unit-view .review-tag.correct').count(),5);
  assert.equal(await page.locator('#unit-view .review-verdict',{hasText:'未作答'}).count(),5);
  await page.locator('#unit-view .review-explain > summary').first().click();
  assert.match(await page.locator('#unit-view .review-explain').first().innerText(),/解析1/);
  await page.getByRole('button',{name:'← 今日安排'}).click();
  assert.equal(await page.locator('#plan-progress').isVisible(),true);

  await finish('B-01-2','20');await page.reload();
  await page.locator('#progress-summary',{hasText:'已学 2 / 2'}).waitFor();
  assert.equal(await page.locator('#progress-bar .stage-marker').count(),0);
  assert.equal(await page.locator('#next-milestone').innerText(),'已提交的阶段已全部学完');
  assert.equal(await page.locator('#stage-legend').innerText(),'✓ 基础体系表 2/2');
  await page.locator('#directory > summary').click();
  assert.match(await stage('基础体系表').locator('summary').innerText(),/2\/2[\s\S]*已完成/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}));

test('the directory shows finished, due and next reviews next to the unit that closes the cycle',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url)=>{
  // The fixture plan has two units, so the review nodes are injected into the plan response.
  const reviews={'B-01-1':{id:'review-01',status:'done'},'B-01-2':{id:'review-02',status:'next',remaining:3}};
  await page.route('**/api/review/today',async route=>{
    const response=await route.fetch();const body=await response.json();
    for(const section of body.directory)for(const child of section.children)for(const unit of child.units)if(reviews[unit.id])unit.review=reviews[unit.id];
    await route.fulfill({response,json:body});
  });
  await page.reload();
  await page.locator('#directory > summary').click();
  const nodes=page.locator('.directory-list li.review-node');
  assert.equal(await nodes.count(),2);
  assert.match(await nodes.nth(0).innerText(),/复习 review-01[\s\S]*已完成/);
  assert.match(await nodes.nth(1).innerText(),/下次复习 review-02[\s\S]*还差 3 个学习日/);
  assert.match(await page.locator('.directory-list li').nth(1).innerText(),/review-01/);
  assert.equal(await nodes.nth(0).getByRole('button',{name:'查看'}).count(),1);
  assert.equal(await nodes.nth(1).getByRole('button',{name:'查看'}).count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}));

test('damaged study data shows the server error instead of a blank page',()=>withSite(chromium,{},async(page,url,tmp)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  const folder=join(tmp,'study/jlpt-notes/groups/submissions/r1');
  await mkdir(folder,{recursive:true});await writeFile(join(folder,'B-01-1.json'),'{');
  await page.reload();
  await page.locator('#notice',{hasText:'groups/submissions/r1/B-01-1.json'}).waitFor();
}));

test('the usage overview shows each usage straight away and records nothing about it',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#recall-list').waitFor();
  assert.deepEqual(await page.locator('#recall-list .recall-text').allInnerTexts(),['时间点','动作的方向']);
  assert.equal(await page.locator('#unit-view .step h2').first().innerText(),'一、用法总览');
  assert.doesNotMatch(await page.locator('#unit-view').innerText(),/没想到|点击显示|回忆/);
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page').waitFor();
  const sub=JSON.parse(await readFile(join(tmp,'study/jlpt-notes/groups/submissions/r1/B-01-1.json'),'utf8'));
  assert.equal('recall' in sub,false);
  assert.equal(await page.locator('#recall-list .recall-mask').count(),2);
  assert.doesNotMatch(await page.locator('#unit-view').innerText(),/已锁定/);
}));

test('usages show on the first look, start as bars once the unit is entered, and slide per form or all at once',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#recall-list').waitFor();
  const all=page.locator('.recall-bar .recall-switch');
  const forms=page.locator('#recall-list .recall-switch');
  // First look: everything shown, every switch is on.
  assert.deepEqual(await page.locator('#recall-list .recall-text').allInnerTexts(),['时间点','动作的方向']);
  assert.deepEqual(await forms.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-checked'))),['true','true']);
  assert.equal(await all.getAttribute('aria-checked'),'true');
  assert.equal(await all.getAttribute('role'),'switch');
  // One form off: that form turns into bars, the other stays, "all" sits in the middle.
  await forms.first().click();
  assert.equal(await forms.first().getAttribute('aria-checked'),'false');
  assert.equal(await page.locator('#recall-list .recall-group').first().locator('.recall-text').count(),0);
  assert.equal(await page.locator('#recall-list .recall-group').first().locator('.recall-mask').count(),1);
  assert.deepEqual(await page.locator('#recall-list .recall-text').allInnerTexts(),['动作的方向']);
  assert.equal(await all.getAttribute('aria-checked'),'mixed');
  // "All" with something hidden shows everything; with everything shown hides everything.
  await all.click();
  assert.equal(await page.locator('#recall-list .recall-text').count(),2);
  assert.equal(await all.getAttribute('aria-checked'),'true');
  await all.click();
  assert.equal(await page.locator('#recall-list .recall-text').count(),0);
  assert.equal(await page.locator('#recall-list .recall-mask').count(),2);
  assert.equal(await all.getAttribute('aria-checked'),'false');
  await all.click();
  // Entered: the usages start as bars; the form names stay and no usage text is in the page.
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page').waitFor();
  assert.equal(await page.locator('#recall-list .recall-text').count(),0);
  assert.equal(await page.locator('#recall-list').innerText().then(text=>/时间点|动作的方向/.test(text)),false);
  assert.deepEqual(await page.locator('#recall-list .recall-form').allInnerTexts(),['に','へ']);
  assert.equal(await page.locator('#recall-list .recall-mask').count(),2);
  assert.equal(await all.getAttribute('aria-checked'),'false');
  assert.doesNotMatch(await page.locator('#unit-view').innerText(),/用法已隐藏/);
  // Clicking the bars reveals that form; its switch follows.
  await page.locator('#recall-list .recall-group').nth(1).locator('.recall-rows').click();
  assert.deepEqual(await page.locator('#recall-list .recall-text').allInnerTexts(),['动作的方向']);
  assert.equal(await forms.nth(1).getAttribute('aria-checked'),'true');
  assert.equal(await all.getAttribute('aria-checked'),'mixed');
  // Hiding again leaves a bar and no text.
  await forms.nth(1).click();
  assert.equal(await page.locator('#recall-list .recall-text').count(),0);
  assert.equal(await page.locator('#compare').isVisible(),true);
  const box=await forms.first().boundingBox();
  assert.ok(box.height>=44);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}));

test('each form of an entered unit has a wordless can\'t-recall sticker that counts every tap, can take the last taps back and keeps the count',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const log=async()=>{try{return JSON.parse(await readFile(join(tmp,'study/jlpt-notes/groups/forgets.json'),'utf8')).events;}catch{return [];}};
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#recall-list').waitFor();
  // First look: nothing learned yet, so nothing to forget.
  assert.equal(await page.locator('#recall-list .forget').count(),0);
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page').waitFor();
  const group=page.locator('#recall-list .recall-group');
  const forget=page.locator('#recall-list .forget');
  const count=index=>group.nth(index).locator('.forget-count').innerText();
  assert.equal(await forget.count(),2);
  assert.deepEqual(await forget.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label'))),['に 想不起来，已记 0 次','へ 想不起来，已记 0 次']);
  // No words on the sticker, only a face; zero is shown too.
  assert.doesNotMatch(await page.locator('#recall-list').innerText(),/忘/);
  assert.deepEqual([await count(0),await count(1)],['0','0']);
  const face=await forget.first().locator('.forget-face').innerText();
  await forget.first().click();
  assert.notEqual(await forget.first().locator('.forget-face').innerText(),face);
  await forget.first().click();
  await forget.first().click();
  assert.equal(await count(0),'3');
  // Each tap throws out a sticker with the count it reached.
  assert.equal(await page.locator('#recall-list .forget-burst > *').last().innerText(),'3');
  const undo=group.first().getByRole('button',{name:'撤销'});
  await undo.waitFor();
  for (let wait=0;(await log()).length<3&&wait<50;wait++) await page.waitForTimeout(100);
  assert.deepEqual((await log()).map(event=>[event.unit,event.form,event.cards]),Array(3).fill(['B-01-1','に',['N5-G-0013']]));
  await undo.click();
  assert.equal(await count(0),'2');
  for (let wait=0;(await log()).length>2&&wait<50;wait++) await page.waitForTimeout(100);
  assert.equal((await log()).length,2);
  assert.equal(await forget.first().getAttribute('aria-label'),'に 想不起来，已记 2 次');
  // The undo goes away by itself; the count is kept by the server.
  await undo.waitFor({state:'hidden',timeout:8000});
  assert.equal(await count(1),'0');
  const box=await forget.first().boundingBox();
  assert.ok(box.height>=44&&box.width>=44);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.reload();
  await page.locator('#status').getByRole('button',{name:'继续'}).click();
  await page.locator('#unit-page').waitFor();
  assert.equal(await page.locator('#recall-list .recall-group').first().locator('.forget-count').innerText(),'2');
}));

test('the comparison stacks by item on a phone, switches to per-form cards and has no sideways scroll',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#compare').waitFor();
  assert.equal(await page.locator('.compare-title').innerText(),'对比表');
  assert.match(await page.locator('#compare').innerText(),/情境：约定见面/);
  assert.deepEqual(await page.locator('.compare-by-item .compare-block h4').allInnerTexts(),['接续','一句话记忆','核心含义','语气与感情色彩','代表例句']);
  assert.equal(await page.locator('.compare-by-item .compare-block').first().locator('.compare-line').count(),2);
  assert.equal(await page.locator('.compare-by-item .compare-ja strong').first().innerText(),'に');
  assert.equal(await page.locator('.compare-by-form').isVisible(),false);
  assert.equal(await page.locator('.compare-table').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.getByRole('button',{name:'按语法看'}).click();
  assert.equal(await page.locator('.compare-by-item').isVisible(),false);
  assert.equal(await page.locator('.compare-by-form .compare-block').count(),2);
  assert.equal(await page.getByRole('button',{name:'按语法看'}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
}));

test('the comparison is a real table on a wide screen',()=>withSite(chromium,{viewport:{width:1100,height:800},locale:'zh-CN'},async(page)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#compare').waitFor();
  assert.equal(await page.locator('.compare-table').isVisible(),true);
  assert.equal(await page.locator('.compare-by-item').isVisible(),false);
  assert.equal(await page.locator('.compare-mode').first().isVisible(),false);
  assert.deepEqual(await page.locator('.compare-table thead th').allInnerTexts(),['项目','に','へ']);
  assert.equal(await page.locator('.compare-table tbody tr').count(),5);
}));

for(const [name,engine] of Object.entries({chromium,webkit})) {
  test(`${name}: a unit is learned end to end on a phone`,()=>withSite(engine,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
    await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
    await page.locator('#status').getByRole('button',{name:'开始'}).click();
    await page.locator('#recall-list').waitFor();
    assert.equal(await page.locator('#recall-list .recall-row').count(),2);
    assert.equal(await page.locator('#unit-page').count(),0);
    assert.deepEqual(await page.locator('#recall-list .recall-text').allInnerTexts(),['时间点','动作的方向']);
    assert.deepEqual(await page.locator('#recall-list .recall-form').allInnerTexts(),['に','へ']);
    assert.equal(await page.locator('#recall-list .recall-group').nth(1).locator('.recall-row').count(),1);
    await page.getByRole('button',{name:'进入对比页'}).click();
    await page.locator('#unit-page img').first().waitFor();
    assert.equal(await page.locator('#unit-page img').first().evaluate(image=>image.complete&&image.naturalWidth>0),true);
    assert.equal(await page.locator('.cards-title').count(),0);
    assert.equal(await page.locator('#unit-page details.member-card').count(),2);
    assert.equal(await page.locator('#card-N5-G-0013').evaluate(details=>!details.open
      && details.previousElementSibling.querySelector('img')?.alt==='时点に接续图'
      && details.nextElementSibling.classList.contains('compare-meaning')
      && details.nextElementSibling.nextElementSibling.tagName==='H3'),true);
    assert.match(await page.locator('#card-N5-G-0013 + .compare-meaning').innerText(),/核心含义[\s\S]*に[\s\S]*时间点/);
    await page.locator('#card-N5-G-0013 summary').click();
    await page.locator('#card-N5-G-0013',{hasText:'时间词＋に，表示动作发生的时间点。'}).waitFor();
    await page.locator('#unit-page a[href="#card-N5-G-0032"]').click();
    assert.deepEqual(await page.locator('#card-N5-G-0032 h2').allInnerTexts(),['功能一 1/2：对象','功能二 2/2：到达点']);
    assert.equal(await page.locator('#card-N5-G-0032').evaluate(details=>details.open),true);
    await page.locator('.option-list').first().locator('.option-block').nth(1).click();
    await page.locator('#sentence').fill('三時に会いましょう。');
    page.on('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'交卷'}).click();
    await page.locator('#status',{hasText:'已交卷，待判分'}).waitFor();
    assert.equal(await page.locator('#status').innerText(),'今日安排\n\n下一项（B-01-2 で・を）尚未准备\n\n已交卷，待判分：B-01-1');
    await page.locator('#progress-summary',{hasText:'已学 1 / 2'}).waitFor();
    const sub=JSON.parse(await readFile(join(tmp,'study/jlpt-notes/groups/submissions/r1/B-01-1.json'),'utf8'));
    assert.equal('recall' in sub,false);
    assert.equal(sub.sentence.text,'三時に会いましょう。');
    const paper=await readFile(join(tmp,'study/jlpt-notes/quizzes/papers/2026-10-17-b-01-1.md'),'utf8');
    assert.match(paper,/```text\n1-2, 2-__, 3-__, 4-__, 5-__\n```/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }));
}

test('a unit without a sentence prompt ends with a note box only and submits without a sentence',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
  const file=join(tmp,'study/jlpt-notes/groups/units/B-01-1.json');
  const material=JSON.parse(await readFile(file,'utf8'));delete material.sentence;
  await writeFile(file,JSON.stringify(material));
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.getByRole('button',{name:'进入对比页'}).click();
  await page.locator('#unit-page').waitFor();
  await page.locator('.option-list').first().locator('.option-block').nth(1).click();
  assert.equal(await page.locator('#sentence').count(),0);
  assert.equal(await page.locator('.sentence-prompt').count(),0);
  await page.getByRole('heading',{name:'四、备注'}).waitFor();
  await page.locator('#note').fill('对比页少了例句');
  page.on('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'交卷'}).click();
  await page.locator('#status',{hasText:'已交卷，待判分'}).waitFor();
  const sub=JSON.parse(await readFile(join(tmp,'study/jlpt-notes/groups/submissions/r1/B-01-1.json'),'utf8'));
  assert.equal('sentence' in sub,false);
  assert.equal(sub.note,'对比页少了例句');
}));

for(const [name,engine] of Object.entries({chromium,webkit})) {
  test(`${name}: a paper is answered by tapping option blocks and written to its answer area`,()=>withSite(engine,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url,tmp)=>{
    page.on('dialog',dialog=>dialog.accept());
    await page.getByRole('navigation',{name:'学习导航'}).getByRole('link',{name:'做题'}).click();
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

test('opening the directory scrolls the current unit into view',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.evaluate(()=>{const filler=document.createElement('div');filler.style.height='3000px';document.querySelector('#directory').before(filler);});
  await page.locator('#directory > summary').click();
  await page.waitForFunction(()=>{const box=document.querySelector('#directory-body li.is-current')?.getBoundingClientRect();return box&&box.top>=0&&box.bottom<=innerHeight;});
}));

test('units and reviews get previous/next buttons at the top and bottom, only toward steps that are ready',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page)=>{
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#recall-list').waitFor();
  // B-01-2 is not prepared in the fixture: no next button, and nothing before the first unit.
  assert.equal(await page.locator('#unit-view .pager').count(),2);
  assert.equal(await page.locator('#unit-view .pager-link').count(),0);
  await page.getByRole('button',{name:'← 今日安排'}).click();
  await page.route('**/api/review/today',async route=>{
    const response=await route.fetch();const body=await response.json();
    const units=body.directory.flatMap(section=>section.children.flatMap(child=>child.units));
    units[1].status='prepared';units[0].review={id:'review-01',status:'done'};
    await route.fulfill({response,json:body});
  });
  await page.reload();
  await page.locator('#progress-summary',{hasText:'已学 0 / 2'}).waitFor();
  await page.locator('#status').getByRole('button',{name:'开始'}).click();
  await page.locator('#unit-view .pager').first().waitFor();
  assert.deepEqual(await page.locator('#unit-view .pager-next').allInnerTexts(),['下一页 复习 review-01 →','下一页 复习 review-01 →']);
}));

test('the last unit of a category can page forward to the next category\'s first unit when it is the one to learn now',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page)=>{
  await page.route('**/api/review/today',async route=>{
    const response=await route.fetch();const body=await response.json();
    const [first,second]=body.directory.flatMap(section=>section.children.flatMap(child=>child.units));
    // Category A ends with a learned unit; category B starts with the unit to learn now.
    first.status='learned';second.status='current';
    const [section]=body.directory;
    const next={...section,title:'次の類',pending:false,children:[{...section.children[0],id:'C-2',title:'次',units:[second]}]};
    section.children[0].units=[first];
    body.directory.splice(1,0,next);
    body.state='learn';body.unit={...body.unit,id:second.id,title:second.title};
    await route.fulfill({response,json:body});
  });
  await page.reload();
  await page.locator('#directory > summary').click();
  await page.locator('.stage').evaluateAll(stages=>stages.forEach(stage=>{stage.open=true;}));
  await page.locator('.directory-list li',{hasText:'B-01-1'}).getByRole('button',{name:'查看'}).click();
  await page.locator('#unit-title',{hasText:'B-01-1'}).waitFor();
  assert.deepEqual(await page.locator('#unit-view .pager-next').allInnerTexts(),['下一页 B-01-2 →','下一页 B-01-2 →']);
  await page.getByRole('button',{name:'← 今日安排'}).first().click();
  await page.locator('.stage').evaluateAll(stages=>stages.forEach(stage=>{stage.open=true;}));
  assert.equal(await page.locator('.directory-list li',{hasText:'B-01-2'}).getByRole('button').count(),1);
}));

// ---- News reader (WebKit, iPad and iPhone). The fixture serves fake Yahoo pages and a FakeHub; see browser_fixture.py. ----
// hub: a FakeHub script (list) or {script,models}; select: model id stored as the header selection.
async function withNews(device,run,{hub,select}={}) {
  const scratch=await mkdtemp(join(tmpdir(),'jlpt-news-hub-'));
  const env={};
  if(hub) {env.NEWS_HUB_SCRIPT=join(scratch,'hub.json');await writeFile(env.NEWS_HUB_SCRIPT,JSON.stringify(hub));}
  if(select) env.NEWS_SELECTED_MODEL=select;
  try {await withSite(webkit,{...devices[device],locale:'zh-CN',timezoneId:'Asia/Tokyo'},run,env);}
  finally {await rm(scratch,{recursive:true,force:true});}
}
const NEWS_DEVICES=['iPad Pro 11','iPhone 13'];
const failure=(stage,stage_label,reason,extra={})=>({error:{stage,stage_label,location:null,reason,retryable:true,request_id:'n-20261108-a3f9',time:'15:42:07',...extra}});

for(const device of NEWS_DEVICES) {
  test(`news list shows feeds and opens an article on ${device}`,()=>withNews(device,async(page,url)=>{
    await page.goto(url+'/news/');
    const items=page.locator('.news-item');
    await items.first().waitFor();
    assert.deepEqual(await page.locator('.news-cats button').allInnerTexts(),['主要','国内','国际','经济','娱乐','体育','IT','科学']);
    assert.equal(await page.getByRole('button',{name:'主要'}).getAttribute('aria-pressed'),'true');
    assert.deepEqual(await page.locator('.news-title').allInnerTexts(),['top-picksの見出し一','top-picksの見出し二']);
    assert.deepEqual(await page.locator('.news-time').allInnerTexts(),['15:51','15:40']);
    await page.getByRole('button',{name:'国际'}).click();
    await page.locator('.news-title',{hasText:'worldの見出し一'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'国际'}).getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('.news-title',{hasText:'top-picks'}).count(),0);
    await page.route('**/news/read.html**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>stub</title>'}));
    await page.locator('.news-title',{hasText:'worldの見出し二'}).click();
    await page.waitForURL(url+'/news/read.html?url='+encodeURIComponent('https://news.yahoo.co.jp/pickup/2'));
  }));

  test(`news list pasted link opens the reader on ${device}`,()=>withNews(device,async(page,url)=>{
    await page.goto(url+'/news/');
    await page.locator('.news-item').first().waitFor();
    await page.route('**/news/read.html**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>stub</title>'}));
    const link='https://news.yahoo.co.jp/articles/0123456789abcdef?x=1&y=2';
    await page.getByLabel('粘贴雅虎新闻链接').fill('  '+link+'  ');
    await page.getByRole('button',{name:'打开'}).click();
    await page.waitForURL(url+'/news/read.html?url='+encodeURIComponent(link));
  }));

  test(`header switches model and persists on ${device}`,()=>withNews(device,async(page,url)=>{
    await page.goto(url+'/news/');
    const label=page.locator('.news-model');
    await label.getByText('模型：未选择').waitFor();
    await label.click();
    assert.deepEqual(await page.locator('.news-model-list button').allInnerTexts(),['Auto','DeepSeek-V4-Flash','DeepSeek-V4-Pro']);
    await page.locator('.news-model-list button',{hasText:'DeepSeek-V4-Flash'}).click();
    await label.getByText('模型：DeepSeek-V4-Flash').waitFor();
    assert.equal(await page.locator('.news-model-list').isHidden(),true);
    await page.reload();
    await page.locator('.news-model',{hasText:'模型：DeepSeek-V4-Flash'}).waitFor();
    await page.locator('.news-model').click();
    assert.equal(await page.locator('.news-model-list button[aria-current=true]').innerText(),'DeepSeek-V4-Flash');
  }));

  test(`header shows the error line when the chosen model is unavailable on ${device}`,()=>withNews(device,async(page,url)=>{
    await page.route('**/api/news/settings',route=>route.fulfill({status:502,json:failure('model','模型生成','当前模型不可用，请重新选择',{retryable:false,location:'保存模型'})}));
    await page.goto(url+'/news/');
    await page.locator('.news-model',{hasText:'模型：未选择'}).click();
    await page.locator('.news-model-list button',{hasText:'Auto'}).click();
    const line=page.locator('.news-header .news-error');
    assert.equal(await line.locator('.news-error-line').innerText(),'模型生成失败（保存模型）：当前模型不可用，请重新选择');
    assert.equal(await line.getByRole('button',{name:'重试'}).count(),0);
    assert.equal(await page.locator('.news-model').innerText(),'模型：未选择');
    // No automatic switch: the picker is still open so another model can be chosen.
    assert.equal(await page.locator('.news-model-list').isVisible(),true);
  }));

  test(`stale feed shows notice on ${device}`,()=>withNews(device,async(page,url,tmp)=>{
    await page.goto(url+'/news/');
    await page.locator('.news-item').first().waitFor();
    assert.equal(await page.locator('.news-stale').count(),0);
    // The cached list is 12.5 minutes old and Yahoo is down: the old list comes back with a notice.
    await writeFile(join(tmp,'news-rss-fail'),'');await writeFile(join(tmp,'news-clock-offset'),'750');
    await page.reload();
    await page.locator('.news-item').first().waitFor();
    assert.equal(await page.locator('.news-stale').innerText(),'更新失败，显示的是 12 分钟前的列表');
    assert.deepEqual(await page.locator('.news-title').allInnerTexts(),['top-picksの見出し一','top-picksの見出し二']);
  }));

  test(`feed failure shows one error line that opens its details and retries on ${device}`,()=>withNews(device,async(page,url,tmp)=>{
    await writeFile(join(tmp,'news-rss-fail'),'');
    await page.goto(url+'/news/');
    const line=page.locator('.news-error-line');
    await line.waitFor();
    assert.match(await line.innerText(),/^抓取雅虎失败（新闻列表）：连接雅虎失败：simulated RSS outage$/);
    assert.equal(await page.locator('.news-error').innerText(),await line.innerText()+'　重试');
    assert.equal(await page.locator('.news-error-detail').isHidden(),true);
    await line.click();
    const terms=await page.locator('.news-error-detail dt').allInnerTexts();
    assert.deepEqual(terms,['环节','位置','原因','能否重试','请求编号','时间']);
    const values=await page.locator('.news-error-detail dd').allInnerTexts();
    assert.deepEqual(values.slice(0,4),['抓取雅虎','新闻列表','连接雅虎失败：simulated RSS outage','能']);
    assert.match(values[4],/^n-\d{8}-[0-9a-f]{4}$/);
    assert.match(values[5],/^\d\d:\d\d:\d\d$/);
    await line.click();
    assert.equal(await page.locator('.news-error-detail').isHidden(),true);
    await rm(join(tmp,'news-rss-fail'));
    await page.getByRole('button',{name:'重试'}).click();
    await page.locator('.news-title',{hasText:'top-picksの見出し一'}).waitFor();
    assert.equal(await page.locator('.news-error').count(),0);
  }));
}

test('an unreachable server is reported as a web-to-server error',()=>withNews('iPhone 13',async(page,url)=>{
  await page.route('**/api/news/feeds**',route=>route.abort());
  await page.goto(url+'/news/');
  const line=page.locator('.news-error-line');
  assert.equal(await line.innerText(),'网页→服务器失败（/api/news/feeds）：网络连接失败');
  await line.click();
  assert.equal((await page.locator('.news-error-detail dd').allInnerTexts())[3],'能');
}));

test('a reply that is not the agreed format is reported as a web-to-server error',()=>withNews('iPhone 13',async(page,url)=>{
  await page.route('**/api/news/feeds**',route=>route.fulfill({status:200,contentType:'text/html',body:'<html>proxy</html>'}));
  await page.goto(url+'/news/');
  assert.equal(await page.locator('.news-error-line').innerText(),'网页→服务器失败（/api/news/feeds）：服务器回应格式不对');
}));

test('a 401 from the news api returns to the login page',()=>withNews('iPhone 13',async(page,url)=>{
  await page.route('**/api/news/feeds**',route=>route.fulfill({status:401,json:{error:'请先登录'}}));
  await page.goto(url+'/news/');
  await page.waitForURL(url+'/login.html');
}));

test('nav links to news from the review, papers and grammar pages',()=>withSite(chromium,{...devices['iPhone 13'],locale:'zh-CN'},async(page,url)=>{
  assert.equal(await page.getByRole('navigation',{name:'学习导航'}).getByRole('link',{name:'新闻'}).getAttribute('href'),'/news/');
  await page.goto(url+'/papers.html');
  assert.equal(await page.getByRole('navigation',{name:'学习导航'}).getByRole('link',{name:'新闻'}).getAttribute('href'),'/news/');
  await page.goto(url+'/grammar/');await page.locator('#start-reading:not([disabled])').waitFor();
  assert.equal(await page.getByRole('navigation',{name:'学习导航'}).getByRole('link',{name:'新闻'}).getAttribute('href'),'/news/');
  await page.getByRole('navigation',{name:'学习导航'}).getByRole('link',{name:'新闻'}).click();
  await page.waitForURL(url+'/news/');
  assert.equal(await page.locator('.news-header h1').innerText(),'新闻');
}));

test('the news api module parses chunked event streams and reports interrupted ones',()=>withNews('iPhone 13',async(page,url)=>{
  await page.goto(url+'/news/');
  await page.locator('.news-item').first().waitFor();
  const sse=events=>({status:200,headers:{'content-type':'text/event-stream'},body:events});
  const run=(body,abortAfter)=>page.evaluate(async([path,abortAfter])=>{
    const {streamSSE}=await import('/news/api.mjs');
    const seen=[];const controller=new AbortController();
    if(abortAfter===0) controller.abort();
    await streamSSE(path,{url:'x'},{signal:controller.signal,onEvent:(name,data)=>{seen.push([name,data]);if(abortAfter===seen.length) controller.abort();}});
    return seen;
  },[body,abortAfter]);
  // Comments (: ping) are ignored and multi-byte text survives (one-chunk body; real chunking is tested below).
  await page.route('**/api/news/open',route=>route.fulfill(sse(': ping\n\nevent: progress\ndata: {"stage":"yahoo","text":"正在抓取雅虎…"}\n\n: ping\n\nevent: article\ndata: {"id":"a1","title":"題"}\n\n')));
  assert.deepEqual(await run('/api/news/open'),[['progress',{stage:'yahoo',text:'正在抓取雅虎…'}],['article',{id:'a1',title:'題'}]]);
  // No terminal event: the stream is reported as interrupted (retryable).
  await page.unroute('**/api/news/open');
  await page.route('**/api/news/open',route=>route.fulfill(sse('event: progress\ndata: {"stage":"yahoo","text":"a"}\n\n')));
  const cut=await run('/api/news/open');
  assert.equal(cut.length,2);
  assert.equal(cut[1][0],'error');
  assert.deepEqual({...cut[1][1],time:'-'},{stage:'stream',stage_label:'推送到网页',location:'',reason:'回答中断',retryable:true,request_id:'',time:'-'});
  // An error event is the terminal event and carries the server's dict untouched.
  const dict=failure('model','模型生成','排队中，请稍后重试').error;
  await page.unroute('**/api/news/open');
  await page.route('**/api/news/open',route=>route.fulfill(sse('event: error\ndata: '+JSON.stringify(dict)+'\n\n')));
  assert.deepEqual(await run('/api/news/open'),[['error',dict]]);
  // A 400 JSON reply before streaming becomes the same error event.
  const bad=failure('client','网页→服务器','链接不是雅虎新闻',{retryable:false}).error;
  await page.unroute('**/api/news/open');
  await page.route('**/api/news/open',route=>route.fulfill({status:400,json:{error:bad}}));
  assert.deepEqual(await run('/api/news/open'),[['error',bad]]);
  // Aborting produces no error event, and events after the abort are dropped.
  await page.unroute('**/api/news/open');
  await page.route('**/api/news/open',route=>route.fulfill(sse('event: progress\ndata: {"text":"1"}\n\nevent: progress\ndata: {"text":"2"}\n\n')));
  assert.deepEqual(await run('/api/news/open',1),[['progress',{text:'1'}]]);
  assert.deepEqual(await run('/api/news/open',0),[]);
  // Chunk boundaries may fall anywhere, even inside a multi-byte character or a line ending.
  const split=await page.evaluate(async()=>{
    const {sseParser}=await import('/news/api.mjs');
    const seen=[];const parser=sseParser((name,data)=>seen.push([name,data]));
    const bytes=new TextEncoder().encode('event: delta\r\ndata: {"text":"日本語"}\r\n\r\nevent: done\ndata: {}\n\n');
    const decoder=new TextDecoder();
    for(let i=0;i<bytes.length;i+=3) parser.push(decoder.decode(bytes.slice(i,i+3),{stream:true}));
    return seen;
  });
  assert.deepEqual(split,[['delta',{text:'日本語'}],['done',{}]]);
}));

// These drive streamSSE's own read loop: window.fetch is replaced by one answering with a ReadableStream
// that enqueues controlled Uint8Array pieces with delays, as the browser does for a live response.
const STREAM_HELPERS=`
  window.__fakeStream=(pieces,{honourAbort=true,hang=false}={})=>{
    window.fetch=(path,init)=>{
      let cancelled=false;
      const stream=new ReadableStream({
        async start(controller){
          init.signal?.addEventListener('abort',()=>{if(honourAbort) controller.error(new DOMException('aborted','AbortError'));});
          for(const piece of pieces){
            if(typeof piece==='number') await new Promise(r=>setTimeout(r,piece)); else if(!cancelled) controller.enqueue(piece);
          }
          if(!hang&&!cancelled) controller.close();
        },
        cancel(){cancelled=true;},
      });
      return Promise.resolve(new Response(stream,{status:200,headers:{'content-type':'text/event-stream'}}));
    };
  };`;
const inPage=(page,fn,arg)=>page.evaluate(`(async()=>{${STREAM_HELPERS}
  const {streamSSE}=await import('/news/api.mjs');
  const settle=(promise,ms=2000)=>Promise.race([promise.then(()=>'settled',error=>'rejected: '+error.message),new Promise(r=>setTimeout(()=>r('hung'),ms))]);
  return (${fn.toString()})(${JSON.stringify(arg??null)});})()`);

test('streamSSE reassembles frames from byte pieces split inside multibyte characters and CRLF',()=>withNews('iPhone 13',async(page,url)=>{
  await page.goto(url+'/news/');
  const seen=await inPage(page,async()=>{
    const bytes=new TextEncoder().encode(': ping\r\n\r\nevent: delta\r\ndata: {"text":"日本語"}\r\n\r\n: ping\r\n\r\nevent: delta\r\ndata: {"text":"ニュース"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n');
    const pieces=[];
    for(let i=0;i<bytes.length;i++){pieces.push(bytes.slice(i,i+1));if(i%7===0) pieces.push(1);}
    window.__fakeStream(pieces);
    const seen=[];
    await streamSSE('/api/news/ask',{},{onEvent:(name,data)=>seen.push([name,data])});
    return seen;
  });
  assert.deepEqual(seen,[['delta',{text:'日本語'}],['delta',{text:'ニュース'}],['done',{}]]);
}));

test('streamSSE ends quietly when aborted while a read is pending',()=>withNews('iPhone 13',async(page,url)=>{
  await page.goto(url+'/news/');
  for(const honourAbort of [true,false]) {
    const result=await inPage(page,async honourAbort=>{
      const first=new TextEncoder().encode('event: progress\ndata: {"text":"1"}\n\n');
      window.__fakeStream([first],{honourAbort,hang:true}); // then the read waits forever
      const seen=[];const controller=new AbortController();
      const done=streamSSE('/api/news/open',{},{signal:controller.signal,onEvent:(name,data)=>{seen.push([name,data]);setTimeout(()=>controller.abort(),30);}});
      return {outcome:await settle(done),seen};
    },honourAbort);
    assert.deepEqual(result,{outcome:'settled',seen:[['progress',{text:'1'}]]},`honourAbort=${honourAbort}`);
  }
}));

test('streamSSE rejects when the page handler throws and does not report an interrupted stream',()=>withNews('iPhone 13',async(page,url)=>{
  await page.goto(url+'/news/');
  const result=await inPage(page,async()=>{
    const enc=text=>new TextEncoder().encode(text);
    const out={};
    for(const [label,body] of [['non-terminal','event: progress\ndata: {"text":"1"}\n\nevent: progress\ndata: {"text":"2"}\n\nevent: done\ndata: {}\n\n'],['terminal','event: done\ndata: {}\n\n']]){
      window.__fakeStream([enc(body)]);
      const seen=[];
      const outcome=await settle(streamSSE('/api/news/open',{},{onEvent:name=>{seen.push(name);throw new Error('handler bug');}}));
      out[label]={outcome,seen};
    }
    return out;
  });
  assert.deepEqual(result,{'non-terminal':{outcome:'rejected: handler bug',seen:['progress']},terminal:{outcome:'rejected: handler bug',seen:['done']}});
}));

// ---- Reader page. READER_URL is the fixture's three-page article (browser_fixture.py READER_PAGES); the fixture
// tokenizer cuts sentence 1 into 台風/は/強い/勢力/で/島/に/接近/する/おそれ/が/あり/ます/。 (indices 0..13). ----
const READER_ID='b2c3d4e5f6a7081929304a5b6c7d8e9f00112233';
const READER_URL='https://news.yahoo.co.jp/articles/'+READER_ID;
const readerPage=url=>url+'/news/read.html?url='+encodeURIComponent(READER_URL);
async function openReader(page,url) {
  await page.goto(readerPage(url));
  await page.locator('.news-article-title').waitFor();
  await page.evaluate(()=>{
    window.__events=[];
    for(const name of ['news:select-sentence','news:select-part']) document.addEventListener(name,event=>window.__events.push([name,event.detail]));
    window.__spoken=[];
    // On the prototype: WebKit may drop an expando on the speechSynthesis wrapper between calls.
    if(window.SpeechSynthesis) SpeechSynthesis.prototype.speak=utterance=>window.__spoken.push([utterance.text,utterance.lang]);
  });
}
const tok=(page,s,i)=>page.locator(`.news-token[data-s="${s}"][data-i="${i}"]`);
const events=page=>page.evaluate(()=>window.__events);
const card=page=>page.locator('.news-card');
// Touch input as iOS WebKit reports it: pointer events of pointerType 'touch', all sent to the element first
// touched (implicit capture), coordinates in the viewport. Playwright has no touch-drag API for WebKit.
async function pointer(page,type,[x,y]) {
  await page.evaluate(([type,x,y])=>{
    if(type==='pointerdown') window.__touched=document.elementFromPoint(x,y);
    const up=type==='pointerup'||type==='pointercancel';
    (window.__touched||document.body).dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,composed:true,pointerId:7,pointerType:'touch',isPrimary:true,clientX:x,clientY:y,button:type==='pointermove'?-1:0,buttons:up?0:1,width:20,height:20,pressure:up?0:0.5}));
  },[type,x,y]);
}
// A point inside an element's first line box: fx/fy are fractions of it (0.5,0.5 is the centre).
async function at(locator,fx=0.5,fy=0.5) {
  await locator.scrollIntoViewIfNeeded();
  // On a phone the analysis sheet covers the lower part of the screen: a covered target is scrolled up above it.
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
const partIndices=page=>page.locator('.news-token.is-part').evaluateAll(nodes=>nodes.map(node=>`${node.dataset.s}:${node.dataset.i}`));
const range=(s,a,b)=>Array.from({length:b-a+1},(_,k)=>`${s}:${a+k}`);
const GLOSS_HUB=[['chunks',['<gloss><meaning>势力；力量，强度</meaning></gloss>'],0]];

for(const device of NEWS_DEVICES) {
  test(`open shows progress then title, media, images and video placeholder on ${device}`,()=>withNews(device,async(page,url,tmp)=>{
    await writeFile(join(tmp,'news-hold-page2'),'');
    await page.goto(readerPage(url));
    await page.locator('.news-progress',{hasText:'正在抓取雅虎（第 2 / 3 页）…'}).waitFor();
    assert.equal(await page.locator('.news-article-title').count(),0);
    await rm(join(tmp,'news-hold-page2'));
    const title=page.locator('.news-article-title');
    await title.waitFor();
    assert.equal(await title.innerText(),'台風が島に接近');
    assert.equal(await page.title(),'台風が島に接近 · 新闻 · JLPT 学习册');
    assert.equal(await page.locator('.news-progress').count(),0);
    assert.equal(await page.locator('.news-meta .news-media').innerText(),'テスト通信');
    assert.equal(await page.locator('.news-meta time').innerText(),'2026年11月8日 15:30');
    const original=page.locator('.news-meta a',{hasText:'原文'});
    assert.equal(await original.getAttribute('href'),READER_URL);
    assert.equal(await original.getAttribute('target'),'_blank');
    assert.match(await original.getAttribute('rel'),/noopener/);
    assert.equal(await page.locator('.news-body h3').first().innerText(),'台風の接近');
    assert.equal(await page.locator('.news-body .news-para').first().innerText(),'台風は強い勢力で島に接近するおそれがあります。気象庁は早めの準備を呼びかけました。');
    // Every token is its own span, numbered per sentence; ids run through captions too.
    assert.deepEqual(await page.locator('.news-sentence[data-sid="1"] .news-token').allInnerTexts(),['台風','は','強い','勢力','で','島','に','接近','する','おそれ','が','あり','ます','。']);
    const photo=page.locator('.news-figure img');
    assert.equal(await photo.getAttribute('src'),`/api/news/image/${READER_ID}/0`);
    await page.waitForFunction(()=>document.querySelector('.news-figure img').naturalWidth>0);
    assert.equal(await page.locator('.news-figure figcaption .news-sentence').innerText(),'港に並ぶ船。');
    assert.equal(await page.locator('.news-figure figcaption .news-sentence').getAttribute('data-sid'),'3');
    assert.equal(await page.locator('.news-figure .news-credit').innerText(),'テスト提供');
    const videos=page.locator('.news-video');
    assert.equal(await videos.count(),2);
    assert.equal(await videos.nth(0).locator('img').getAttribute('src'),`/api/news/image/${READER_ID}/1`);
    await page.waitForFunction(()=>document.querySelector('.news-video img').naturalWidth>0);
    assert.equal(await videos.nth(0).locator('.news-video-placeholder').count(),0);
    assert.equal(await videos.nth(1).locator('img').count(),0);
    assert.equal(await videos.nth(1).locator('.news-video-placeholder').count(),1);
    for(const [n,href] of [[0,'https://news.yahoo.co.jp/video/reader/1'],[1,'https://news.yahoo.co.jp/video/reader/2']]) {
      const watch=videos.nth(n).getByRole('link',{name:'在雅虎观看'});
      assert.equal(await watch.getAttribute('href'),href);
      assert.equal(await watch.getAttribute('target'),'_blank');
      assert.match(await watch.getAttribute('rel'),/noopener/);
    }
    const unknown=page.locator('.news-unknown');
    assert.match(await unknown.innerText(),/^这里有原文内容没能显示/);
    assert.equal(await unknown.locator('a').getAttribute('href'),READER_URL);
    // Pages 2 and 3 follow page 1 as one article.
    assert.equal(await page.locator('.news-body .news-para').last().innerText(),'最後の段落の文です。');
    assert.equal(await page.locator('.news-error').count(),0);
    // The system press-and-hold selection and callout are off on the text. Desktop WebKit does not compute
    // -webkit-touch-callout (iOS only), so that one is checked in the stylesheet the page loads.
    assert.equal(await page.locator('.news-body').evaluate(node=>getComputedStyle(node).webkitUserSelect),'none');
    const css=await page.evaluate(()=>fetch('/news/news.css').then(response=>response.text()));
    assert.match(css,/\.news-body\{[^}]*-webkit-touch-callout:none/);
  }));

  test(`tap word shows reading and gloss; rapid taps keep only last on ${device}`,()=>withNews(device,async(page,url)=>{
    await openReader(page,url);
    // Through the server and the fake model: reading, part of speech, meaning, speech.
    const word=tok(page,1,3);
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
    await tap(page,page.locator('.news-article-title'));
    assert.equal(await card(page).count(),0);
    // Rapid taps: a slow earlier answer never replaces the last word's, and a word tapped over at once is not asked for.
    const asked=[];
    await page.route('**/api/news/gloss',async route=>{
      const {lemma}=route.request().postDataJSON();asked.push(lemma);
      if(lemma==='台風') await new Promise(r=>setTimeout(r,700));
      try {await route.fulfill({json:{meaning:lemma+'的释义'}});} catch {}
    });
    await tap(page,tok(page,1,0));
    await card(page).locator('.news-progress').waitFor();
    await page.waitForTimeout(350);
    const quick=[await at(tok(page,1,2)),await at(tok(page,1,5))];
    for(const point of quick) {await pointer(page,'pointerdown',point);await pointer(page,'pointerup',point);}
    await card(page).locator('.news-card-meaning',{hasText:'島的释义'}).waitFor();
    await page.waitForTimeout(900);
    assert.equal(await card(page).locator('.news-card-word').innerText(),'島');
    assert.equal(await card(page).locator('.news-card-meaning').innerText(),'島的释义');
    assert.equal(await page.locator('.news-card').count(),1);
    assert.deepEqual(asked,['台風','島']);
    // A failed lookup shows one error line with 重试 in the card.
    await page.unroute('**/api/news/gloss');
    let fail=true;
    await page.route('**/api/news/gloss',route=>fail?route.fulfill({status:502,json:failure('model','模型生成','模型没有回应',{location:'查词：船'})}):route.fulfill({json:{meaning:'船只'}}));
    await tap(page,tok(page,3,3));
    const line=card(page).locator('.news-error-line');
    assert.equal(await line.innerText(),'模型生成失败（查词：船）：模型没有回应');
    fail=false;
    await card(page).getByRole('button',{name:'重试'}).click();
    await card(page).locator('.news-card-meaning',{hasText:'船只'}).waitFor();
    // 在本句中的作用 selects the sentence with this word as the selected part.
    await card(page).getByRole('button',{name:'在本句中的作用'}).click();
    assert.equal(await card(page).count(),0);
    assert.deepEqual(await events(page),[['news:select-part',{sentenceId:3,start:3,end:3}]]);
    assert.equal(await page.locator('.news-sentence.is-selected').getAttribute('data-sid'),'3');
    assert.deepEqual(await partIndices(page),['3:3']);
  },{hub:GLOSS_HUB,select:'Auto'}));

  test(`punctuation is not tappable on ${device}`,()=>withNews(device,async(page,url)=>{
    await openReader(page,url);
    const asked=[];
    await page.route('**/api/news/gloss',route=>{asked.push(route.request().postDataJSON().lemma);route.fulfill({json:{meaning:'x'}});});
    for(const [s,i] of [[1,13],[4,0],[4,2],[4,6]]) await tap(page,tok(page,s,i)); // 。 10 ( 11
    await page.waitForTimeout(400);
    assert.equal(await card(page).count(),0);
    assert.deepEqual(asked,[]);
    // Particles are words like any other.
    await tap(page,tok(page,1,1));
    await card(page).locator('.news-card-meaning',{hasText:'x'}).waitFor();
    assert.equal(await card(page).locator('.news-card-pos').innerText(),'助词');
    assert.deepEqual(asked,['は']);
  }));

  test(`long press selects whole sentence on ${device}`,()=>withNews(device,async(page,url)=>{
    await openReader(page,url);
    // A press shorter than 500 ms is a tap, not a selection.
    const point=await at(tok(page,1,5));
    await pointer(page,'pointerdown',point);await page.waitForTimeout(250);await pointer(page,'pointerup',point);
    await card(page).waitFor();
    assert.equal(await page.locator('.news-sentence.is-selected').count(),0);
    await longPress(page,tok(page,1,5));
    assert.equal(await card(page).count(),0);
    assert.deepEqual(await page.locator('.news-sentence.is-selected').evaluateAll(nodes=>nodes.map(node=>node.dataset.sid)),['1']);
    assert.deepEqual(await events(page),[['news:select-sentence',{sentenceId:1}]]);
    assert.equal(await page.locator('.news-sentence[data-sid="1"]').evaluate(node=>getComputedStyle(node).touchAction),'none');
    // Anywhere in a sentence, punctuation included; another sentence replaces the selection.
    await longPress(page,tok(page,4,2));
    assert.deepEqual(await page.locator('.news-sentence.is-selected').evaluateAll(nodes=>nodes.map(node=>node.dataset.sid)),['4']);
    assert.notEqual(await page.locator('.news-sentence[data-sid="1"]').evaluate(node=>getComputedStyle(node).touchAction),'none');
    // Caption sentences too.
    await longPress(page,tok(page,3,0));
    assert.deepEqual(await events(page),[['news:select-sentence',{sentenceId:1}],['news:select-sentence',{sentenceId:4}],['news:select-sentence',{sentenceId:3}]]);
    // Moving more than 10 px cancels the long press.
    const start=await at(tok(page,2,0));
    await pointer(page,'pointerdown',start);await page.waitForTimeout(100);
    await pointer(page,'pointermove',[start[0],start[1]+14]);await page.waitForTimeout(600);await pointer(page,'pointerup',[start[0],start[1]+14]);
    assert.equal((await events(page)).length,3);
    assert.equal(await card(page).count(),0);
    // The system menu stays closed.
    assert.equal(await tok(page,1,5).evaluate(node=>{const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});node.dispatchEvent(event);return event.defaultPrevented;}),true);
  }));

  test(`drag inside selected sentence snaps to whole words on ${device}`,()=>withNews(device,async(page,url)=>{
    await openReader(page,url);
    await longPress(page,tok(page,1,5));
    // From inside 強い to the first character of 島: both words whole.
    await drag(page,await at(tok(page,1,2),0.7),await at(tok(page,1,5),0.2));
    assert.deepEqual(await partIndices(page),range(1,2,5));
    assert.deepEqual((await events(page)).at(-1),['news:select-part',{sentenceId:1,start:2,end:5}]);
    assert.equal(await page.locator('.news-sentence.is-selected').getAttribute('data-sid'),'1');
    // Backwards works the same and replaces the part.
    await drag(page,await at(tok(page,1,11),0.6),await at(tok(page,1,3),0.4));
    assert.deepEqual(await partIndices(page),range(1,3,11));
    assert.deepEqual((await events(page)).at(-1),['news:select-part',{sentenceId:1,start:3,end:11}]);
    assert.equal((await events(page)).length,3);
    // A tap on a word of the selected sentence still opens the word card and keeps the part.
    await tap(page,tok(page,1,7));
    await card(page).waitFor();
    assert.equal(await card(page).locator('.news-card-word').innerText(),'接近');
    assert.deepEqual(await partIndices(page),range(1,3,11));
    assert.equal((await events(page)).length,3);
    // Long press on the selected sentence goes back to the whole sentence.
    await longPress(page,tok(page,1,0));
    assert.deepEqual(await partIndices(page),[]);
    assert.deepEqual((await events(page)).at(-1),['news:select-sentence',{sentenceId:1}]);
  }));

  test(`drag past sentence end clamps to sentence on ${device}`,()=>withNews(device,async(page,url)=>{
    await openReader(page,url);
    await longPress(page,tok(page,1,5));
    // Past the end into the next sentence and further down the page: up to the last word, 。 left out.
    await drag(page,await at(tok(page,1,3)),await at(tok(page,2,2)));
    assert.deepEqual(await partIndices(page),range(1,3,12));
    assert.deepEqual((await events(page)).at(-1),['news:select-part',{sentenceId:1,start:3,end:12}]);
    const view=page.viewportSize();
    const below=[view.width/2,view.height-4]; // further down the page, below sentence 1
    await drag(page,await at(tok(page,1,6)),below);
    assert.deepEqual(await partIndices(page),range(1,6,12));
    // Back past the start, into the heading and up to the title: from the first word.
    await drag(page,await at(tok(page,1,5)),await at(tok(page,0,1)));
    assert.deepEqual(await partIndices(page),range(1,0,5));
    const title=await at(page.locator('.news-article-title'),0.9,0.5);
    await drag(page,await at(tok(page,1,9)),title);
    assert.deepEqual(await partIndices(page),range(1,0,9));
    assert.deepEqual((await events(page)).at(-1),['news:select-part',{sentenceId:1,start:0,end:9}]);
    // Into the blank margin beside the paragraph: still inside the sentence.
    const [x,y]=await at(tok(page,1,4));
    await drag(page,[x,y],[2,y]);
    const parts=await partIndices(page);
    assert.ok(parts.length>0&&parts.every(part=>part.startsWith('1:')),JSON.stringify(parts));
    // Starting on the final 。 and going further: nothing but punctuation, so the selection is unchanged.
    const before=(await events(page)).length;const kept=await partIndices(page);
    await drag(page,await at(tok(page,1,13)),below);
    assert.equal((await events(page)).length,before);
    assert.deepEqual(await partIndices(page),kept);
    // From the trailing 。 back into the sentence: words up to the last one, 。 left out.
    await drag(page,await at(tok(page,1,13)),await at(tok(page,1,3)));
    assert.deepEqual(await partIndices(page),range(1,3,12));
    assert.deepEqual((await events(page)).at(-1),['news:select-part',{sentenceId:1,start:3,end:12}]);
    // Only sentence 1 is ever highlighted.
    assert.deepEqual(await page.locator('.news-sentence.is-selected').evaluateAll(nodes=>nodes.map(node=>node.dataset.sid)),['1']);
  }));

  test(`drag keeps numbers with their counters and trims only punctuation on ${device}`,()=>withNews(device,async(page,url)=>{
    await openReader(page,url);
    // Sentence 4: 10/日/(/火/)/から/11/日/(/水/)/にかけて/雨/が/降り/ます/。
    await longPress(page,tok(page,4,1));
    await drag(page,await at(tok(page,4,0),0.2),await at(tok(page,4,1),0.6));
    assert.deepEqual(await partIndices(page),range(4,0,1));
    assert.deepEqual((await events(page)).at(-1),['news:select-part',{sentenceId:4,start:0,end:1}]);
    // Just a number is a selection too.
    await drag(page,await at(tok(page,4,6),0.05,0.1),await at(tok(page,4,6),0.95,0.9));
    assert.deepEqual((await events(page)).at(-1),['news:select-part',{sentenceId:4,start:6,end:6}]);
    assert.deepEqual(await partIndices(page),range(4,6,6));
    // Brackets at the edges are dropped.
    await drag(page,await at(tok(page,4,2),0.5),await at(tok(page,4,4),0.5));
    assert.deepEqual((await events(page)).at(-1),['news:select-part',{sentenceId:4,start:3,end:3}]);
    assert.deepEqual(await partIndices(page),range(4,3,3));
  }));

  test(`dragging outside selected sentence scrolls on ${device}`,()=>withNews(device,async(page,url)=>{
    await openReader(page,url);
    await longPress(page,tok(page,1,5));
    const selected=tok(page,1,3);const other=tok(page,6,0);
    // The page is long enough to scroll.
    assert.ok(await page.evaluate(()=>document.scrollingElement.scrollHeight>innerHeight+400));
    // Native panning stays on outside the selected sentence and is off on it.
    const touchMove=locator=>locator.evaluate(node=>{
      node.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,cancelable:true}));
      const move=new TouchEvent('touchmove',{bubbles:true,cancelable:true});node.dispatchEvent(move);
      node.dispatchEvent(new TouchEvent('touchend',{bubbles:true,cancelable:true}));
      return [move.defaultPrevented,getComputedStyle(node.closest('.news-sentence')).touchAction];
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
    assert.deepEqual(await events(page),[['news:select-sentence',{sentenceId:1}]]);
    assert.deepEqual(await page.locator('.news-sentence.is-selected').evaluateAll(nodes=>nodes.map(node=>node.dataset.sid)),['1']);
    assert.deepEqual(await partIndices(page),[]);
    assert.equal(await card(page).count(),0);
    // The page itself really scrolls.
    const before=await page.evaluate(()=>scrollY);
    await page.evaluate(()=>window.scrollBy(0,300));
    assert.ok(await page.evaluate(()=>scrollY)>before);
  }));

  test(`partial article shows page-missing error line with retry on ${device}`,()=>withNews(device,async(page,url,tmp)=>{
    await writeFile(join(tmp,'news-page3-fail'),'');
    await page.goto(readerPage(url));
    await page.locator('.news-article-title').waitFor();
    const line=page.locator('.news-body .news-error-line');
    assert.equal(await line.innerText(),'抓取雅虎失败（第 3 页 / 共 3 页）：雅虎返回 503');
    assert.equal(await page.locator('.news-body .news-para').last().innerText(),'30番目の段落です。町の人々は静かに過ごしています。');
    // The line sits at the end of what was fetched.
    assert.equal(await page.locator('.news-body').evaluate(body=>body.lastElementChild.classList.contains('news-error')),true);
    assert.equal(await page.getByText('最後の段落の文です。').count(),0);
    await rm(join(tmp,'news-page3-fail'));
    // Straight away: the server does not reuse a partial article, so 重试 really fetches page 3 again.
    await page.locator('.news-body').getByRole('button',{name:'重试'}).click();
    await page.getByText('最後の段落の文です。').waitFor();
    assert.equal(await page.locator('.news-error').count(),0);
    assert.equal(await page.locator('.news-article-title').count(),1);
  }));
}

test('article errors show where they belong: failed images in place, missing pages at the end',()=>withNews('iPhone 13',async(page,url)=>{
  const err=(stage,stage_label,location,reason)=>({stage,stage_label,location,reason,retryable:true,request_id:'n-20261108-0001',time:'15:42:07'});
  const sentence=(id,text)=>({id,tokens:[{s:text,r:'',l:text,p:'名詞',t:true},{s:'。',r:'',l:'。',p:'補助記号',t:false}]});
  const article={id:READER_ID,url:READER_URL,title:'題',media:'媒体',published:'2026-11-08T15:30:00+09:00',author:'',
    pages:{total:2,fetched:1,missing:[2]},
    blocks:[{type:'paragraph',sentences:[sentence(0,'一')]},{type:'image',index:0,caption_sentences:[sentence(1,'写真')],credit:'',ok:false},
      {type:'paragraph',sentences:[sentence(2,'二')]},{type:'video',url:'https://news.yahoo.co.jp/video/x',cover:null},
      {type:'image',index:2,caption_sentences:[],credit:'',ok:true},{type:'paragraph',sentences:[sentence(3,'三')]},{type:'mystery',url:READER_URL}],
    errors:[err('yahoo','抓取雅虎','第 2 页 / 共 2 页','雅虎返回 503'),err('image','下载图片','第 1 张','图片返回 404'),err('image','下载图片','第 2 张','图片超过 5 MB')]};
  await page.route('**/api/news/open',route=>route.fulfill({status:200,headers:{'content-type':'text/event-stream'},body:'event: article\ndata: '+JSON.stringify(article)+'\n\n'}));
  await page.route('**/api/news/image/**',route=>route.fulfill({status:404,body:''}));
  await page.goto(readerPage(url));
  await page.locator('.news-article-title').waitFor();
  const order=await page.locator('.news-body').evaluate(body=>[...body.children].map(node=>node.matches('.news-error')?'error:'+node.querySelector('.news-error-line').textContent:node.className.split(' ')[0]));
  assert.deepEqual(order,['news-para','news-figure','news-para','news-video','news-figure','news-para','news-unknown','error:抓取雅虎失败（第 2 页 / 共 2 页）：雅虎返回 503']);
  assert.equal(await page.locator('.news-figure').first().locator('.news-error-line').innerText(),'下载图片失败（第 1 张）：图片返回 404');
  assert.equal(await page.locator('.news-figure').first().locator('img').count(),0);
  assert.equal(await page.locator('.news-video .news-error-line').innerText(),'下载图片失败（第 2 张）：图片超过 5 MB');
  assert.match(await page.locator('.news-unknown').innerText(),/^这里有原文内容没能显示/);
}));

test('links taken from the article only go to Yahoo News over https',()=>withNews('iPhone 13',async(page,url)=>{
  const article={id:READER_ID,url:READER_URL,title:'題',media:'媒体',published:'2026-11-08T15:30:00+09:00',author:'',
    pages:{total:1,fetched:1,missing:[]},errors:[],
    blocks:[{type:'video',url:'javascript:alert(1)',cover:null},{type:'video',url:'http://news.yahoo.co.jp/video/plain',cover:null},
      {type:'video',url:'https://news.yahoo.co.jp.evil.com/video',cover:null},{type:'video',url:'https://news.yahoo.co.jp/video/ok',cover:null},
      {type:'video',url:'https://s.yimg.yahoo.co.jp/v',cover:null},{type:'mystery',url:'data:text/html,x'}]};
  await page.route('**/api/news/open',route=>route.fulfill({status:200,headers:{'content-type':'text/event-stream'},body:'event: article\ndata: '+JSON.stringify(article)+'\n\n'}));
  await page.goto(readerPage(url));
  await page.locator('.news-article-title').waitFor();
  const hrefs=await page.locator('.news-video a, .news-unknown a').evaluateAll(links=>links.map(link=>link.getAttribute('href')));
  assert.deepEqual(hrefs,[READER_URL,READER_URL,READER_URL,'https://news.yahoo.co.jp/video/ok','https://s.yimg.yahoo.co.jp/v',READER_URL]);
}));

test('a reader link that is not a Yahoo article shows the server\'s error line',()=>withNews('iPhone 13',async(page,url)=>{
  await page.goto(url+'/news/read.html?url='+encodeURIComponent('https://example.com/x'));
  const line=page.locator('.news-error-line');
  await line.waitFor();
  assert.match(await line.innerText(),/^网页→服务器失败/);
  await page.goto(url+'/news/read.html');
  assert.equal(await page.locator('.news-error-line').innerText(),'网页→服务器失败：缺少文章链接');
}));

// ---- Analysis panel and follow-up questions. The FakeHub answers analyses with the spec §5 XML in pieces and
// questions with plain text; what it received is read back from news-hub-requests.json in the state dir. ----
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
const S1_WHOLE={translation:'台风可能以强劲的势力接近岛屿。',items:[['〜は','N5','提示主题'],['〜で','N5','表示状态、方式'],
  ['〜おそれがある','N3','有…的可能（多指坏事）',false,{connection:'动词辞书形＋おそれがある',usage:'表示台风有接近岛屿的可能',confusable:'〜かもしれない 不限于坏事'}]]};
const S1_PART={selection:['つよいせいりょくで','修饰「接近する」，说明台风以什么状态接近。','以强劲的势力'],translation:'台风可能以强劲的势力接近岛屿。',
  items:[['〜は','N5','提示主题'],['〜で','N5','表示状态',true],['〜おそれがある','N3','有…的可能'],['い形容词＋名词','N5','形容词直接修饰名词',true]]};
const panel=page=>page.locator('#news-panel');
const analysisDone=page=>page.locator('#news-panel[data-analysis="done"]').waitFor();
const headings=page=>panel(page).locator('.news-panel-body > section:not([hidden]) > h3').allInnerTexts();
const forms=page=>panel(page).locator('.news-grammar-form').allInnerTexts();
const rounds=page=>panel(page).locator('.news-chat-round').evaluateAll(list=>list.map(round=>[round.querySelector('.news-chat-q').textContent,round.querySelector('.news-chat-a').textContent]));
async function hubRequests(tmp) {try {return JSON.parse(await readFile(join(tmp,'news-hub-requests.json'),'utf8'));} catch {return [];}}
async function hubDisconnects(tmp) {try {return Number(await readFile(join(tmp,'news-hub-disconnects'),'utf8'));} catch {return 0;}}
// Waits (up to 10 s) until the FakeHub has seen `count` requests dropped by the news server.
async function waitDisconnects(tmp,count) {
  for(const end=Date.now()+10000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,100))) if(await hubDisconnects(tmp)>=count) return true;
  return false;
}
// Bodies the page POSTs to /api/news/<name>, in order.
function recordApi(page,name) {const bodies=[];page.on('request',request=>{if(request.url().endsWith('/api/news/'+name)) bodies.push(request.postDataJSON());});return bodies;}
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
  await page.waitForFunction(n=>document.querySelectorAll('#news-panel .news-chat-round:not(.is-pending)').length===n,done+1);
}

for(const device of NEWS_DEVICES) {
  test(`sentence only shows 原文/译文/语法 without selection block on ${device}`,()=>withNews(device,async(page,url,tmp)=>{
    await openReader(page,url);
    const analyses=recordApi(page,'analyze');
    assert.equal(await panel(page).isHidden(),true);
    await pressSentence(page,1);
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
    // Nothing else to press: no read-aloud or quick-question buttons.
    assert.deepEqual(await panel(page).locator('button').evaluateAll(list=>list.map(b=>b.className.split(' ')[0])),
      ['news-panel-close','news-grammar-row','news-grammar-row','news-grammar-row','news-ask-send']);
    assert.doesNotMatch(await panel(page).innerText(),/🔊/);
    assert.deepEqual(analyses,[{article:READER_ID,sentence:1,start:null,end:null}]);
    assert.match(JSON.stringify((await hubRequests(tmp))[0].messages),new RegExp(S1_TEXT));
    assert.equal(await page.locator('.news-sentence.is-selected').getAttribute('data-sid'),'1');
    await panel(page).locator('.news-panel-close').click();
    assert.equal(await panel(page).isHidden(),true);
    assert.equal(await page.locator('.news-sentence.is-selected').count(),0);
  },{hub:[analyzeStep(S1_WHOLE)],select:'Auto'}));

  test(`part selection adds selection block and puts related grammar first on ${device}`,()=>withNews(device,async(page,url)=>{
    await openReader(page,url);
    const analyses=recordApi(page,'analyze');
    await pressSentence(page,1);
    await analysisDone(page);
    await drag(page,await at(tok(page,1,2),0.3),await at(tok(page,1,4),0.5));
    assert.deepEqual(await partIndices(page),range(1,2,4));
    await panel(page).locator('.news-selection-reading').waitFor();
    await analysisDone(page);
    assert.deepEqual(await panel(page).locator('.news-panel-body > section:not([hidden])').evaluateAll(list=>list.map(s=>s.classList[1])),
      ['news-panel-original','news-panel-selection','news-panel-translation','news-panel-grammar']);
    assert.equal(await panel(page).locator('.news-panel-sentence').innerText(),S1_TEXT);
    assert.equal(await panel(page).locator('.news-panel-part').innerText(),'強い勢力で');
    const colors=await page.evaluate(()=>[getComputedStyle(document.querySelector('.news-panel-part')).backgroundColor,getComputedStyle(document.querySelector('.news-token.is-part')).backgroundColor]);
    assert.equal(colors[0],colors[1]);
    assert.equal(await panel(page).locator('.news-selection-text').innerText(),'強い勢力で');
    assert.equal(await panel(page).locator('.news-selection-reading').innerText(),'つよいせいりょくで');
    assert.equal(await panel(page).locator('.news-selection-role').innerText(),'修饰「接近する」，说明台风以什么状态接近。');
    assert.equal(await panel(page).locator('.news-selection-meaning').innerText(),'本句中：以强劲的势力');
    // Related items first, even when one arrives after unrelated ones.
    assert.deepEqual(await forms(page),['〜で','い形容词＋名词','〜は','〜おそれがある']);
    assert.deepEqual(analyses,[{article:READER_ID,sentence:1,start:null,end:null},{article:READER_ID,sentence:1,start:2,end:4}]);
  },{hub:[analyzeStep(S1_WHOLE),analyzeStep(S1_PART)],select:'Auto'}));

  test(`grammar row expands and links to grammar card on ${device}`,()=>withNews(device,async(page,url)=>{
    await openReader(page,url);
    await pressSentence(page,1);
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
    const link=items.nth(2).locator('.news-grammar-card');
    assert.equal(await link.innerText(),'语法卡');
    assert.equal(await link.getAttribute('href'),'/grammar/#N3/5-5');
    await link.click();
    await page.waitForURL(url+'/grammar/#N3/5-5');
  },{hub:[analyzeStep(S1_WHOLE)],select:'Auto'}));

  test(`follow-up keeps context within sentence and sends history on ${device}`,()=>withNews(device,async(page,url,tmp)=>{
    await openReader(page,url);
    const asks=recordApi(page,'ask');
    await pressSentence(page,1);
    await analysisDone(page);
    const q1='可以换成「強い勢力に」吗？',a1='不行。に 会变成「变成强劲势力」的意思。';
    await askQuestion(page,q1);
    const pending=panel(page).locator('.news-chat-round.is-pending');
    await pending.locator('.news-chat-a',{hasText:'不行。'}).waitFor();
    assert.equal(await pending.locator('.news-chat-q').innerText(),'我：'+q1);
    assert.equal(await panel(page).locator('.news-ask-send').isDisabled(),true);
    assert.equal(await panel(page).locator('.news-ask-input').inputValue(),'');
    await page.waitForFunction(()=>document.querySelectorAll('#news-panel .news-chat-round:not(.is-pending)').length===1);
    assert.deepEqual(await rounds(page),[['我：'+q1,'答：'+a1]]);
    assert.deepEqual(await headings(page),['原文','译文','语法','追问']);
    assert.equal(await panel(page).locator('.news-ask-send').isDisabled(),false);
    const q2='那「で」呢？';
    await askAndWait(page,q2);
    assert.deepEqual(await rounds(page),[['我：'+q1,'答：'+a1],['我：'+q2,'答：で 表示状态。']]);
    const analysis=analysisChunks(S1_WHOLE).join('');
    assert.deepEqual(asks[0],{article:READER_ID,sentence:1,start:null,end:null,analysis,history:[],question:q1});
    assert.deepEqual(asks[1],{article:READER_ID,sentence:1,start:null,end:null,analysis,history:[{q:q1,a:a1}],question:q2});
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

  test(`switching sentence while streaming discards the old stream on ${device}`,()=>withNews(device,async(page,url,tmp)=>{
    await openReader(page,url);
    await pressSentence(page,1);
    await panel(page).locator('.news-translation',{hasText:'第一句的译文'}).waitFor();
    await pressSentence(page,2);
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
    await pressSentence(page,1);
    await panel(page).locator('.news-translation',{hasText:'第一句又一次'}).waitFor();
    assert.equal(await panel(page).locator('.news-chat-round').count(),0);
    assert.deepEqual(await headings(page),['原文','译文']);
    assert.ok(await waitDisconnects(tmp,2),'the server stops reading the abandoned answer');
    await page.waitForTimeout(1000);
    assert.doesNotMatch(await panel(page).innerText(),/旧回答/);
    assert.equal(await panel(page).locator('.news-panel-sentence').innerText(),S1_TEXT);
  },{hub:[analyzeStep({translation:'第一句的译文',items:[['〜は','N5','第一句语法'],['〜で','N5','第一句语法'],['〜おそれがある','N3','第一句语法']]},0.8),
    analyzeStep({translation:'第二句的译文',items:[['〜を','N5','第二句语法']]}),
    ['chunks',['旧回答一','旧回答二','旧回答三','旧回答四','旧回答五'],1.0],analyzeStep({translation:'第一句又一次'})],select:'Auto'}));

  test(`changing part keeps follow-ups on ${device}`,()=>withNews(device,async(page,url)=>{
    await openReader(page,url);
    const analyses=recordApi(page,'analyze'),asks=recordApi(page,'ask');
    await pressSentence(page,1);
    await analysisDone(page);
    await askAndWait(page,'问题一');
    await drag(page,await at(tok(page,1,2),0.3),await at(tok(page,1,4),0.5));
    await panel(page).locator('.news-selection-reading').waitFor();
    await analysisDone(page);
    assert.equal(await panel(page).locator('.news-panel-part').innerText(),'強い勢力で');
    assert.deepEqual(await rounds(page),[['我：问题一','答：答一']]);
    await askAndWait(page,'问题二');
    assert.deepEqual(await rounds(page),[['我：问题一','答：答一'],['我：问题二','答：答二']]);
    assert.deepEqual(asks[1],{article:READER_ID,sentence:1,start:2,end:4,analysis:analysisChunks(S1_PART).join(''),history:[{q:'问题一',a:'答一'}],question:'问题二'});
    // The word card's 「在本句中的作用」 on another sentence: a new sentence (conversation cleared), analysed as a part directly.
    await tap(page,tok(page,2,4));
    await card(page).locator('.news-card-meaning',{hasText:'准备'}).waitFor();
    await card(page).locator('.news-card-role').click();
    await panel(page).locator('.news-panel-part',{hasText:'準備'}).waitFor();
    await analysisDone(page);
    assert.equal(await panel(page).locator('.news-panel-sentence').innerText(),S2_TEXT);
    assert.equal(await panel(page).locator('.news-chat-round').count(),0);
    assert.deepEqual(await partIndices(page),['2:4']);
    assert.deepEqual(analyses.map(body=>[body.sentence,body.start,body.end]),[[1,null,null],[1,2,4],[2,4,4]]);
  },{hub:[analyzeStep(S1_WHOLE),['chunks',['答一'],0],analyzeStep(S1_PART),['chunks',['答二'],0],
    ['chunks',['<gloss><meaning>准备</meaning></gloss>'],0],
    analyzeStep({selection:['じゅんび','作「を」的宾语','准备'],translation:'气象厅呼吁尽早做好准备。',items:[['〜を','N5','宾语',true]]})],select:'Auto'}));

  test(`model error shows stage line; format leftovers shown under 其他内容 on ${device}`,()=>withNews(device,async(page,url)=>{
    await openReader(page,url);
    const asks=recordApi(page,'ask');
    const status=panel(page).locator('.news-panel-status');
    // No model chosen: one error line, nothing to retry, no automatic model switch.
    await pressSentence(page,1);
    await status.locator('.news-error-line').waitFor();
    assert.equal(await status.innerText(),'模型生成失败（句子分析（第 2 句））：请先在页头选择模型');
    assert.deepEqual(await headings(page),['原文']);
    await page.locator('.news-model').click();
    await page.locator('.news-model-list button',{hasText:'Auto'}).click();
    await page.locator('.news-model',{hasText:'模型：Auto'}).waitFor();
    // Pressing the same sentence again analyses again; the model is reported unavailable.
    await pressSentence(page,1);
    await status.locator('.news-error-line',{hasText:'当前模型不可用'}).waitFor();
    assert.equal(await status.innerText(),'模型生成失败（句子分析（第 2 句））：当前模型不可用，请重新选择');
    await pressSentence(page,1);
    await status.locator('.news-error-line',{hasText:'模型排队中'}).waitFor();
    assert.equal(await status.innerText(),'模型生成失败（句子分析（第 2 句））：模型排队中，请稍后重试　重试');
    await status.locator('.news-error-retry').click();
    await analysisDone(page);
    assert.deepEqual(await headings(page),['原文','译文','其他内容']);
    assert.equal(await panel(page).locator('.news-translation').innerText(),'台风可能接近岛屿。');
    assert.match(await panel(page).locator('.news-extra-text').innerText(),/^说明：这句话是新闻。\n<item related="false"><form>〜は/);
    assert.equal(await status.innerText(),'');
    // Nothing matches the template: the raw reply under 其他内容, then the format error line.
    await pressSentence(page,2);
    await status.locator('.news-error-line').waitFor();
    assert.deepEqual(await headings(page),['原文','其他内容']);
    assert.equal(await panel(page).locator('.news-extra-text').innerText(),'完全不是模板的回答');
    assert.equal(await status.innerText(),'解析回复失败（句子分析（第 3 句））：回复不符合分析模板　重试');
    assert.deepEqual(await panel(page).locator('.news-panel-body > section:not([hidden]), .news-panel-body > .news-panel-status').evaluateAll(list=>list.map(n=>n.classList[n.classList.length-1])),
      ['news-panel-original','news-panel-extra','news-panel-status']);
    // A question that fails shows the line where the answer goes; 重试 sends the same question again.
    await askQuestion(page,'这句是什么意思？');
    const round=panel(page).locator('.news-chat-round');
    await round.locator('.news-error-line').waitFor();
    assert.equal(await round.locator('.news-error-line').innerText(),'模型生成失败（追问（第 3 句））：模型排队中，请稍后重试');
    assert.equal(await round.locator('.news-chat-q').innerText(),'我：这句是什么意思？');
    await round.locator('.news-error-retry').click();
    await round.locator('.news-error-line',{hasText:'回答中断'}).waitFor();
    assert.equal(await round.locator('.news-chat-a').innerText(),'答：答到一半');
    assert.equal(await round.locator('.news-error-line').innerText(),'推送到网页失败（追问（第 3 句））：回答中断');
    await round.locator('.news-error-retry').click();
    await page.waitForFunction(()=>document.querySelectorAll('#news-panel .news-chat-round:not(.is-pending)').length===1);
    assert.deepEqual(await rounds(page),[['我：这句是什么意思？','答：完整回答']]);
    assert.equal(await panel(page).locator('.news-chat .news-error').count(),0);
    assert.deepEqual(asks.map(body=>[body.question,body.history.length]),[['这句是什么意思？',0],['这句是什么意思？',0],['这句是什么意思？',0]]);
  },{hub:[['status',404,{error:{message:'model not found'}}],['status',429,'busy'],
    ['chunks',['<analysis><translation>台风可能接近岛屿。</translation>','说明：这句话是新闻。<item related="false"><form>〜は</form><level>N5</level><brief>提示主题</brief>'],0],
    ['chunks',['完全不是模板的回答'],0],['status',429,'busy'],['cut_after',['答到一半'],0],['chunks',['完整回答'],0]]}));
}

for(const device of NEWS_DEVICES) {
  test(`a question asked during the analysis waits and carries the final analysis on ${device}`,()=>withNews(device,async(page,url,tmp)=>{
    await openReader(page,url);
    const asks=recordApi(page,'ask');
    const waiting=async question=>{
      await askQuestion(page,question);
      const round=panel(page).locator('.news-chat-round.is-pending');
      assert.equal(await round.locator('.news-chat-q').innerText(),'我：'+question);
      assert.equal(await round.locator('.news-progress').innerText(),'分析完成后发送…');
      assert.equal(await panel(page).locator('.news-ask-send').isDisabled(),true);
    };
    // First analysis of the sentence, still streaming.
    await pressSentence(page,1);
    await panel(page).locator('.news-translation').waitFor();
    assert.equal(await page.locator('#news-panel').getAttribute('data-analysis'),'running');
    await waiting('问题一');
    await page.waitForTimeout(500);
    assert.equal(asks.length,0,'nothing is sent before the analysis is done');
    await page.waitForFunction(()=>document.querySelectorAll('#news-panel .news-chat-round:not(.is-pending)').length===1);
    assert.deepEqual(await rounds(page),[['我：问题一','答：答一']]);
    assert.equal(asks[0].analysis,analysisChunks(S1_WHOLE).join(''));
    assert.ok((await hubRequests(tmp))[1].messages[0].content.includes(analysisChunks(S1_WHOLE).join('')));
    // After a part change the conversation is kept and the question waits for the part's analysis.
    await drag(page,await at(tok(page,1,2),0.3),await at(tok(page,1,4),0.5));
    await panel(page).locator('.news-panel-part',{hasText:'強い勢力で'}).waitFor();
    assert.equal(await page.locator('#news-panel').getAttribute('data-analysis'),'running');
    await waiting('问题二');
    assert.equal(asks.length,1);
    await page.waitForFunction(()=>document.querySelectorAll('#news-panel .news-chat-round:not(.is-pending)').length===2);
    assert.deepEqual(asks[1],{article:READER_ID,sentence:1,start:2,end:4,analysis:analysisChunks(S1_PART).join(''),history:[{q:'问题一',a:'答一'}],question:'问题二'});
  },{hub:[analyzeStep(S1_WHOLE,0.5),['chunks',['答一'],0],analyzeStep(S1_PART,0.5),['chunks',['答二'],0]],select:'Auto'}));

  test(`closing the panel mid-analysis stops the stream and reopening starts empty on ${device}`,()=>withNews(device,async(page,url,tmp)=>{
    await openReader(page,url);
    await pressSentence(page,1);
    await analysisDone(page);
    await askAndWait(page,'问题一');
    await drag(page,await at(tok(page,1,2),0.3),await at(tok(page,1,4),0.5));
    await panel(page).locator('.news-selection-reading').waitFor();
    assert.equal(await page.locator('#news-panel').getAttribute('data-analysis'),'running');
    await panel(page).locator('.news-panel-close').click();
    await panel(page).waitFor({state:'hidden'});
    assert.equal(await page.locator('.news-sentence.is-selected').count(),0);
    assert.ok(await waitDisconnects(tmp,1),'the server stops reading the closed analysis');
    await pressSentence(page,1);
    await analysisDone(page);
    assert.equal(await panel(page).locator('.news-panel-part').count(),0);
    assert.equal(await panel(page).locator('.news-chat-round').count(),0);
    assert.deepEqual(await headings(page),['原文','译文','语法']);
    assert.equal(await panel(page).locator('.news-ask-input').inputValue(),'');
  },{hub:[analyzeStep(S1_WHOLE),['chunks',['答一'],0],analyzeStep(S1_PART,0.8),analyzeStep(S1_WHOLE)],select:'Auto'}));
}

test('a long answer is cut to the server limit when it is sent back as history',()=>withNews('iPhone 13',async(page,url)=>{
  await openReader(page,url);
  const asks=recordApi(page,'ask');
  await pressSentence(page,1);
  await analysisDone(page);
  await askAndWait(page,'问题一');
  assert.equal((await rounds(page))[0][1].length,'答：'.length+4500);
  await askAndWait(page,'问题二');
  assert.deepEqual(await rounds(page).then(list=>list[1]),['我：问题二','答：好的。']);
  assert.equal(asks[1].history[0].a,'あ'.repeat(4000));
  assert.equal(await panel(page).locator('.news-chat .news-error').count(),0);
},{hub:[analyzeStep(S1_WHOLE),['chunks',['あ'.repeat(4500)],0],['chunks',['好的。'],0]],select:'Auto'}));

for(const [device,mode] of [['iPad Pro 11 landscape','right'],['iPad Pro 11','sheet'],['iPhone 13','sheet']]) {
  test(`iPad landscape panel on right; iPhone bottom sheet on ${device}`,()=>withNews(device,async(page,url)=>{
    await openReader(page,url);
    const viewport=page.viewportSize();
    await pressSentence(page,1);
    await analysisDone(page);
    const box=await panel(page).boundingBox();
    if(mode==='right') {
      assert.ok(Math.abs(box.width-viewport.width*0.4)<=2,`width ${box.width}`);
      assert.ok(Math.abs(box.x+box.width-viewport.width)<=1);
      assert.equal(box.y,0);
      assert.ok(Math.abs(box.height-viewport.height)<=1);
      assert.equal(await panel(page).locator('.news-panel-handle').isVisible(),false);
      const body=await page.locator('.news-body').boundingBox();
      assert.ok(body.x+body.width<=box.x+1,'the article stays to the left of the panel');
      // The article can still be scrolled and tapped.
      await tap(page,tok(page,1,3));
      await card(page).locator('.news-card-meaning',{hasText:'势力'}).waitFor();
      const before=await page.evaluate(()=>scrollY);
      await page.evaluate(()=>window.scrollBy(0,400));
      assert.ok(await page.evaluate(()=>scrollY)>before);
      assert.equal((await panel(page).boundingBox()).y,0);
      await pressSentence(page,2);
      await panel(page).locator('.news-panel-sentence',{hasText:S2_TEXT}).waitFor();
      return;
    }
    assert.equal(box.x,0);
    assert.ok(Math.abs(box.width-viewport.width)<=1);
    assert.ok(Math.abs(box.y+box.height-viewport.height)<=1,'docked to the bottom');
    assert.ok(box.height>viewport.height*0.4&&box.height<viewport.height*0.7,`height ${box.height}`);
    const sentence=await page.locator('.news-sentence[data-sid="1"]').boundingBox();
    assert.ok(sentence.y>=0&&sentence.y+sentence.height<=box.y,'the selected sentence stays above the sheet');
    const handle=panel(page).locator('.news-panel-handle');
    const grab=async()=>{const b=await handle.boundingBox();return [b.x+b.width*0.3,b.y+b.height/2];};
    // Drag up: full screen.
    let from=await grab();
    await drag(page,from,[from[0],20]);
    await page.waitForFunction(()=>document.querySelector('#news-panel').classList.contains('is-full'));
    const full=await panel(page).boundingBox();
    assert.ok(full.y<=1&&Math.abs(full.height-viewport.height)<=1,`full ${JSON.stringify(full)}`);
    // Drag down a little: back to half height; a longer drag down closes it.
    from=await grab();
    await drag(page,from,[from[0],from[1]+200]);
    await page.waitForFunction(()=>!document.querySelector('#news-panel').classList.contains('is-full'));
    assert.ok(Math.abs((await panel(page).boundingBox()).height-box.height)<=2);
    from=await grab();
    await drag(page,from,[from[0],from[1]+160]);
    await panel(page).waitFor({state:'hidden'});
    assert.equal(await page.locator('.news-sentence.is-selected').count(),0);
    await pressSentence(page,1);
    await panel(page).locator('.news-panel-close').click();
    await panel(page).waitFor({state:'hidden'});
    assert.equal(await page.locator('.news-sentence.is-selected').count(),0);
  },{hub:mode==='right'?[analyzeStep(S1_WHOLE),GLOSS_HUB[0],analyzeStep({translation:'第二句的译文'})]:[analyzeStep(S1_WHOLE)],select:'Auto'}));
}
