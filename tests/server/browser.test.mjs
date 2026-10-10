import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(new URL('../../mobile/package.json',import.meta.url));
const {chromium,webkit}=require('playwright');

for(const [name,engine] of Object.entries({chromium,webkit})) {
  test(`${name}: login, preview invalidation, draft reload and one submission`,async()=>{
    const tmp=await mkdtemp(join(tmpdir(),'jlpt-browser-'));
    const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
    let browser;
    try {
      const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.once('exit',code=>reject(new Error('fixture exit '+code)));process.stderr.on('data',data=>reject(new Error(data.toString())));});
      browser=await engine.launch();
      const page=await browser.newPage({viewport:{width:390,height:844}});
      await page.goto(url+'/login.html');
      await page.locator('#password').fill('wrong'); await page.locator('button[type=submit]').click();
      await page.waitForSelector('#error:not([hidden])');
      await page.locator('#password').fill('browser-test-password'); await page.locator('button[type=submit]').click();
      await page.waitForURL(url+'/');
      await page.locator('#model').selectOption('codex-example');
      await page.locator('#effort').selectOption('high');
      await page.locator('#prompt').fill('N3 出两道题'); await page.locator('#preview-button').click();
      await page.waitForSelector('#execute:not([disabled])');
      assert.equal(await page.locator('#preview').textContent(),'请使用出卷 skill：.claude/skills/quiz-generate/SKILL.md\n\nN3 出两道题');
      assert.match(await page.locator('#preview-settings').textContent(),/codex-example.*high/);
      await page.locator('#effort').selectOption('low');
      assert.equal(await page.locator('#execute').isDisabled(),true);
      await page.locator('#cli').selectOption('agy');
      assert.equal(await page.locator('#model option[value="codex-example"]').count(),0);
      await page.locator('#model').selectOption('gemini-example');
      await page.locator('#effort').selectOption('medium');
      await page.locator('#cli').selectOption('codex');
      assert.equal(await page.locator('#model').inputValue(),'');
      assert.equal(await page.locator('#effort').inputValue(),'');
      await page.locator('#operation').selectOption('grade');
      assert.equal(await page.locator('#execute').isDisabled(),true);
      await page.locator('#preview-button').click();
      await page.waitForSelector('#execute:not([disabled])');
      assert.equal(await page.locator('#preview').textContent(),'请使用判卷 skill：.claude/skills/quiz-grade/SKILL.md\n\nN3 出两道题');
      await page.locator('#operation').selectOption('generate');
      await page.locator('#prompt').fill('改成一题'); assert.equal(await page.locator('#execute').isDisabled(),true);
      await page.locator('#papers button').click(); await page.waitForSelector('#questions input[type=radio]');
      assert.equal(await page.locator('#questions img').count(),0);
      await page.locator('#view-answers').click(); await page.waitForSelector('#answer-details:not([hidden])');
      assert.match(await page.locator('#answer-text').textContent(),/第 1 题选 2/);
      await page.locator('input[name=q1][value="2"]').check();
      await page.waitForFunction(()=>document.getElementById('save-state').textContent==='草稿已保存');
      await page.reload(); await page.locator('#papers button').click();
      assert.equal(await page.locator('input[name=q1][value="2"]').isChecked(),true);
      await page.locator('#submit-paper').click();
      await page.waitForFunction(()=>document.getElementById('save-state').textContent.includes('答案已锁定'));
      await page.waitForFunction(()=>document.querySelector('input[name=q1][value="2"]').disabled || document.querySelector('input[name=q1][value="2"]').closest('fieldset').disabled);
      assert.equal(await page.locator('input[name=q1][value="2"]').isDisabled(),true);
      assert.equal(await page.locator('#operation').inputValue(),'grade');
      await page.locator('#preview-button').click();
      await page.waitForSelector('#execute:not([disabled])');
      assert.match(await page.locator('#preview').textContent(),/^请使用判卷 skill：/);
      await page.locator('#model').selectOption('codex-example');
      await page.locator('#effort').selectOption('high');
      await page.locator('#preview-button').click();
      await page.waitForSelector('#execute:not([disabled])');
      await page.locator('#execute').click();
      await page.waitForFunction(()=>document.getElementById('task-state').textContent.includes('排队中'));
      assert.equal(await page.locator('#model').inputValue(),'codex-example');
      assert.equal(await page.locator('#effort').inputValue(),'high');
      const tasks=await page.evaluate(async()=>await (await fetch('/api/tasks')).json());
      const grading=tasks.find(task=>task.id==='task1');
      assert.equal(grading.model,'codex-example');assert.equal(grading.effort,'high');assert.equal(grading.operation,'grade');
      const submission=await page.evaluate(async()=>await (await fetch('/api/papers/paper1')).json());
      await page.reload(); await page.locator('#papers button').click();
      await page.waitForFunction(()=>document.getElementById('paper-section').hidden===false && document.getElementById('submit-paper').disabled);
      assert.equal(await page.locator('#submit-paper').isDisabled(),true);
      const after=await page.evaluate(async()=>await (await fetch('/api/papers/paper1')).json());
      assert.equal(after.submission.id,submission.submission.id);
    } finally {await browser?.close(); process.kill(); await rm(tmp,{recursive:true,force:true});}
  });
}

test('late previews are discarded and multi-tab conflicts preserve local choices',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-browser-'));
  const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await chromium.launch(); const context=await browser.newContext(); const page=await context.newPage();
    await page.goto(url+'/login.html');await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();await page.waitForURL(url+'/');
    let release;await page.route('**/api/previews',async route=>{const response=await route.fetch();await new Promise(resolve=>release=resolve);await route.fulfill({response});});
    await page.locator('#prompt').fill('old');await page.locator('#preview-button').click();
    for(let n=0;n<100&&!release;n++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(release);await page.locator('#prompt').fill('new');release();
    await page.waitForTimeout(200);assert.equal(await page.locator('#execute').isDisabled(),true);
    await page.locator('#papers button').click();
    const tab=await page.context().newPage();await tab.goto(url+'/');await tab.locator('#papers button').click();
    await page.locator('input[name=q1][value="1"]').check();await page.waitForFunction(()=>document.getElementById('save-state').textContent==='草稿已保存');
    await tab.locator('input[name=q1][value="2"]').check();await tab.waitForSelector('#draft-conflict:not([hidden])');
    assert.equal(await tab.locator('input[name=q1][value="2"]').isChecked(),true);
    await tab.locator('#keep-local-draft').click();await tab.waitForFunction(()=>document.getElementById('save-state').textContent==='草稿已保存');
    const stored=await tab.evaluate(async()=>await (await fetch('/api/papers/paper1')).json());assert.equal(stored.draft['1'].answer,'2');
  } finally{await browser?.close();process.kill();await rm(tmp,{recursive:true,force:true});}
});
