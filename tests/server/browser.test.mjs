import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(new URL('../../mobile/package.json',import.meta.url));
const {chromium,webkit}=require('playwright');
async function fillPrompt(page,text) {
  // Upstream SendBox accepts mobile focus only after a user tap.
  await page.locator('#prompt').click();
  await page.locator('#prompt').fill(text);
}
async function chooseSetting(page,id,label) {
  await page.locator(`#${id} button`).click();
  await page.getByRole('menuitem').filter({hasText:label}).click();
}
async function chooseCli(page,value) {
  await page.locator('#cli').click();
  await page.getByRole('option',{name:{codex:'Codex',agy:'Antigravity',qoder:'Qoder'}[value],exact:true}).click();
}
async function selectHistoryTask(page,id,cli) {
  if (cli && (await settings(page)).cli !== cli) {
    if (!(await page.locator('#new-task').isVisible())) await page.locator('#toggle-conversations').click();
    await page.locator('#new-task').click();await chooseCli(page,cli);
  }
  if (!(await page.locator('#tasks').isVisible())) await page.locator('#toggle-conversations').click();
  await page.locator(`#tasks [data-task-id="${id}"] .task`).click();
}
async function historyAction(page,id,restore=false) {
  const row=page.locator(`#tasks [data-task-id="${id}"]`);
  await row.hover();await row.locator('.task-more').click();
  await row.getByRole('menuitem',{name:restore?'恢复':'归档',exact:true}).click();
}
async function openPaperPanel(page) {
  await page.locator('#papers button').waitFor({state:'attached'});
  if(!(await page.locator('#papers button').isVisible())) await page.locator('#toggle-artifacts').click();
  await page.locator('#papers button').click();
}
const settings=page=>page.evaluate(()=>window.jlptChat.getSettings());

test('history calendar dates use local midnight, year labels and activity order',async()=>{
  const {groupHistory}=await import('../../web/history.mjs');
  const now=new Date(2026,0,1,0,5);
  const seconds=date=>date.getTime()/1000;
  const tasks=[
    {id:'yesterday',cli:'codex',last_activity:seconds(new Date(2025,11,31,23,59))},
    {id:'today',cli:'codex',last_activity:seconds(new Date(2026,0,1,0,1))},
    {id:'old',cli:'codex',last_activity:seconds(new Date(2024,11,31,12))},
    {id:'other',cli:'qoder',last_activity:seconds(now)},
    {id:'archived',cli:'codex',archived_at:1,last_activity:seconds(now)},
    {id:'undated',cli:'codex'}
  ];
  const groups=groupHistory(tasks,'codex',false,now);
  assert.deepEqual(groups.map(group=>group.label),['今天','昨天','2024年12月31日','更早']);
  assert.deepEqual(groups.flatMap(group=>group.tasks.map(task=>task.id)),['today','yesterday','old','undated']);
  assert.deepEqual(groupHistory(tasks,'codex',true,now).flatMap(group=>group.tasks.map(task=>task.id)),['archived']);
});

test('history follows the selected agent with date groups, first-message titles and paper-only file icons',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-history-style-'));
  const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:900}});
    await page.goto(url+'/login.html');await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();await page.waitForURL(url+'/');
    await page.locator('#tasks [data-task-id="task1"]').waitFor();
    assert.deepEqual(await page.locator('#tasks .history-date').allTextContents(),['今天','昨天']);
    assert.deepEqual(await page.locator('#tasks .task-row').evaluateAll(rows=>rows.map(row=>row.dataset.taskId)),['task1','task5']);
    assert.equal(await page.locator('#tasks [data-task-id="task1"] .task-title').textContent(),'出一份练习');
    assert.equal(await page.locator('#tasks [data-task-id="task1"] .task-paper-icon').count(),1);
    assert.equal(await page.locator('#tasks [data-task-id="task5"] .task-paper-icon').count(),0);
    const row=page.locator('#tasks [data-task-id="task1"]');
    assert.equal(await row.locator('.task-more').evaluate(el=>getComputedStyle(el).opacity),'0');
    await row.hover();assert.equal(await row.locator('.task-more').evaluate(el=>getComputedStyle(el).opacity),'1');
    await row.locator('.task-more').click();assert.equal(await row.getByRole('menuitem',{name:'归档',exact:true}).isVisible(),true);
    await page.keyboard.press('Escape');assert.equal(await page.locator('.task-menu:not([hidden])').count(),0);
    await chooseCli(page,'qoder');
    assert.deepEqual(await page.locator('#tasks .task-row').evaluateAll(rows=>rows.map(row=>row.dataset.taskId).sort()),['task3','task4']);
    assert.equal(await page.locator('#tasks .task-paper-icon').count(),0);
    await chooseCli(page,'codex');await row.hover();await row.locator('.task-more').click();
    await row.getByRole('menuitem',{name:'归档',exact:true}).click();await row.waitFor({state:'detached'});
    await chooseCli(page,'qoder');await page.locator('#show-archived').click();assert.equal(await page.locator('#tasks .task-row').count(),0);
    await chooseCli(page,'codex');await row.waitFor();
    assert.equal(await row.locator('.task-title').textContent(),'出一份练习');
    // Finish the agent popup's exit animation before changing its viewport.
    await page.locator('.arco-select-popup').waitFor({state:'hidden'});
    await page.setViewportSize({width:390,height:844});await page.locator('#toggle-conversations').click();
    assert.equal(await row.locator('.task-more').isVisible(),true);
    await row.locator('.task-more').click();await row.getByRole('menuitem',{name:'恢复',exact:true}).click();await row.waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  } finally {await browser?.close();process.kill();await rm(tmp,{recursive:true,force:true});}
});

test('a delayed history refresh cannot undo archive and queued conversations cannot be archived',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-archive-race-'));
  const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await chromium.launch();const page=await browser.newPage();
    await page.goto(url+'/login.html');await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();await page.waitForURL(url+'/');
    await selectHistoryTask(page,'task1','codex');
    let release,received;const pending=new Promise(resolve=>received=resolve);
    await page.route('**/api/tasks',async route=>{
      const response=await route.fetch();received();await new Promise(resolve=>release=resolve);await route.fulfill({response});
    });
    await page.locator('#refresh').click();await pending;
    await historyAction(page,'task1');
    await page.locator('#tasks [data-task-id="task1"]').waitFor({state:'detached'});
    const oldResponse=page.waitForResponse(response=>response.url()===url+'/api/tasks');release();await oldResponse;
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#tasks [data-task-id="task1"]').count(),0);
    assert.equal(await page.locator('#restore-current').isVisible(),true);
    await page.unroute('**/api/tasks');
    const task=await page.evaluate(async()=>{
      const preview=await (await fetch('/api/previews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cli:'codex',text:'等待执行'})})).json();
      return (await fetch('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({preview_id:preview.id})})).json();
    });
    await page.locator('#refresh').click();
    const busyRow=page.locator(`#tasks [data-task-id="${task.id}"]`);await busyRow.locator('.task-more').click();
    const archive=busyRow.getByRole('menuitem',{name:'归档',exact:true});await archive.waitFor();
    assert.equal(await archive.isDisabled(),true);
    const status=await page.evaluate(async id=>(await fetch(`/api/tasks/${id}/archive`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({archived:true})})).status,task.id);
    assert.equal(status,409);
  } finally {await browser?.close();process.kill();await rm(tmp,{recursive:true,force:true});}
});

for(const [name,engine] of Object.entries({chromium,webkit})) {
  test(`${name}: archive persists across devices, undo and restore preserve messages, papers and drafts`,async()=>{
    const tmp=await mkdtemp(join(tmpdir(),'jlpt-archive-'));
    const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
    let browser;
    try {
      const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.stderr.once('data',data=>reject(new Error(data.toString())));});
      browser=await engine.launch();const page=await browser.newPage({viewport:{width:390,height:844}});
      const login=async page=>{await page.goto(url+'/login.html');await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();await page.waitForURL(url+'/');};
      const row=page=>page.locator('#tasks [data-task-id="task1"]');
      await login(page);await page.locator('#toggle-conversations').click();
      await selectHistoryTask(page,'task1','codex');
      await page.locator('[data-message-position="right"]').waitFor();
      await fillPrompt(page,'保留我的输入草稿');
      await page.locator('#toggle-conversations').click();
      await historyAction(page,'task1');
      await row(page).waitFor({state:'detached'});
      assert.match(await page.locator('#archive-feedback').textContent(),/已归档/);
      assert.equal(await page.locator('#prompt').inputValue(),'保留我的输入草稿');
      assert.equal(await page.locator('#execute').isDisabled(),true);
      assert.match(await page.locator('[data-message-position="right"]').textContent(),/请为我出一份练习/);
      assert.equal(await page.locator('#papers .paper-link').count(),1);
      await page.locator('#undo-archive').click();await row(page).waitFor();
      assert.equal(await page.locator('#execute').isDisabled(),false);
      await historyAction(page,'task1');
      await row(page).waitFor({state:'detached'});
      const other=await browser.newPage({viewport:{width:1440,height:900}});await login(other);
      assert.equal(await row(other).count(),0);
      await other.locator('#show-archived').click();await row(other).waitFor();
      await row(other).locator('.task').click();
      await other.locator('[data-message-position="right"]').waitFor();
      assert.match(await other.locator('[data-message-position="right"]').textContent(),/请为我出一份练习/);
      assert.equal(await other.locator('#restore-current').isVisible(),true);
      await historyAction(other,'task1',true);
      await row(other).waitFor({state:'detached'});
      await other.locator('#show-active').click();await row(other).waitFor();
      const task=await other.evaluate(async()=>{const response=await fetch('/api/tasks/task1');return response.json();});
      assert.equal(task.session,'s1');assert.equal(task.archived_at,undefined);
      await page.locator('#refresh').click();await row(page).waitFor();
      assert.equal(await page.locator('#prompt').inputValue(),'保留我的输入草稿');
      await page.reload();await page.locator('#toggle-conversations').click();await row(page).waitFor();
      await page.route('**/api/tasks/task1/archive',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'测试归档失败'})}));
      await historyAction(page,'task1');
      await page.locator('#notice:not([hidden])').waitFor();assert.equal(await row(page).count(),1);
      await page.unroute('**/api/tasks/task1/archive');
      await historyAction(page,'task1');await row(page).waitFor({state:'detached'});
      await page.locator('#show-archived').click();await row(page).waitFor();
      await historyAction(page,'task1',true);await row(page).waitFor({state:'detached'});
      await page.locator('#show-active').click();await row(page).waitFor();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    } finally {await browser?.close();process.kill();await rm(tmp,{recursive:true,force:true});}
  });
}

for(const [name,engine] of Object.entries({chromium,webkit})) {
  test(`${name}: input-box settings, exact direct send, IME, draft reload and one submission`,async()=>{
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
      await page.locator('#toggle-conversations').click();
      await selectHistoryTask(page,'task1','codex');
      await page.waitForSelector('[data-message-position="right"]');
      assert.match(await page.locator('[data-message-position="right"]').textContent(),/请为我出一份练习/);
      assert.equal(await page.locator('#chat-messages strong').filter({hasText:'练习'}).count(),1);
      assert.equal(await page.locator('#chat-messages script').count(),0);
      assert.equal(await page.locator('#chat-messages a[href^="javascript:"]').count(),0);
      await page.locator('#toggle-conversations').click();
      await selectHistoryTask(page,'task2','agy');
      await page.locator('#chat-messages .markdown-shadow-body').filter({hasText:'另一个会话的答案'}).waitFor();
      assert.equal(await page.locator('#chat-messages strong').filter({hasText:'答案'}).count(),1);
      assert.equal(await page.locator('#chat-messages .markdown-shadow-body').filter({hasText:'保留的相同片段'}).count(),2);
      assert.ok(!(await page.locator('#chat-messages').textContent()).includes('请为我出一份练习'));
      await page.locator('#toggle-conversations').click();
      await page.locator('#new-task').click();
      assert.equal(await page.locator('#toggle-conversations').getAttribute('aria-expanded'),'false');
      await chooseCli(page,'codex');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      assert.equal(await page.locator('.sendbox-panel #model-selector').count(),1);
      assert.equal(await page.locator('.sendbox-panel #effort-selector').count(),1);
      assert.equal(await page.locator('#preview-button, #preview-details').count(),0);
      await chooseSetting(page,'model-selector','Codex Example');
      await chooseSetting(page,'effort-selector','高');
      await fillPrompt(page,'N3 出两道题');
      await page.waitForSelector('#execute:not([disabled])');
      assert.deepEqual(await settings(page),{cli:'codex',model:'codex-example',effort:'high',operation:'auto'});
      let composedSend=false;
      const composingRequest=request=>{if(request.url().endsWith('/api/tasks') && request.method()==='POST') composedSend=true;};
      page.on('request',composingRequest);
      await page.locator('#prompt').dispatchEvent('compositionstart');
      await page.locator('#prompt').dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,keyCode:229});
      await page.locator('#prompt').dispatchEvent('compositionend');
      await page.waitForTimeout(80);page.off('request',composingRequest);
      assert.equal(composedSend,false,'IME confirmation must not send the input');
      await chooseSetting(page,'effort-selector','低');
      assert.equal(await page.locator('#execute').isDisabled(),false);
      await chooseCli(page,'agy');
      assert.equal((await settings(page)).model,'');
      await chooseSetting(page,'model-selector','Gemini Example');
      await chooseSetting(page,'effort-selector','中');
      await chooseCli(page,'codex');
      assert.equal((await settings(page)).model,'');
      assert.equal((await settings(page)).effort,'');
      assert.equal(await page.locator('#operation').count(),0);
      await fillPrompt(page,'改成一题'); assert.equal(await page.locator('#execute').isDisabled(),false);
      await openPaperPanel(page); await page.waitForSelector('#questions input[type=radio]');
      assert.equal(await page.locator('#questions img').count(),0);
      await page.locator('#view-answers').click(); await page.waitForSelector('#answer-details:not([hidden])');
      assert.match(await page.locator('#answer-text').textContent(),/第 1 题选 2/);
      await page.locator('input[name=q1][value="2"]').check();
      await page.waitForFunction(()=>document.getElementById('save-state').textContent==='草稿已保存');
      await page.reload(); await openPaperPanel(page);
      assert.equal(await page.locator('input[name=q1][value="2"]').isChecked(),true);
      await page.locator('#submit-paper').click();
      await page.waitForFunction(()=>document.getElementById('save-state').textContent.includes('答案已锁定'));
      await page.waitForFunction(()=>document.querySelector('input[name=q1][value="2"]').disabled || document.querySelector('input[name=q1][value="2"]').closest('fieldset').disabled);
      assert.equal(await page.locator('input[name=q1][value="2"]').isDisabled(),true);
      assert.equal((await settings(page)).operation,'grade');
      await page.waitForSelector('#execute:not([disabled])');
      await chooseSetting(page,'model-selector','Codex Example');
      await chooseSetting(page,'effort-selector','高');
      const raw='  /copy 请判卷\n严格按我的要求  ';
      await fillPrompt(page,raw);
      await page.locator('#execute').click();
      await page.waitForFunction(()=>document.getElementById('task-state').textContent.includes('排队中'));
      assert.equal((await settings(page)).model,'codex-example');
      assert.equal((await settings(page)).effort,'high');
      const tasks=await page.evaluate(async()=>await (await fetch('/api/tasks')).json());
      const grading=tasks.find(task=>task.id==='task1');
      assert.equal(grading.model,'codex-example');assert.equal(grading.effort,'high');assert.equal(grading.operation,'grade');
      assert.equal(grading.prompt,raw);
      const history=await page.evaluate(async()=>await (await fetch('/api/tasks/task1/events')).json());
      assert.equal(history.filter(event=>event.type==='user').at(-1).text,raw);
      const submission=await page.evaluate(async()=>await (await fetch('/api/papers/paper1')).json());
      await page.reload(); await openPaperPanel(page);
      await page.waitForFunction(()=>document.getElementById('paper-section').hidden===false && document.getElementById('submit-paper').disabled);
      assert.equal(await page.locator('#submit-paper').isDisabled(),true);
      const after=await page.evaluate(async()=>await (await fetch('/api/papers/paper1')).json());
      assert.equal(after.submission.id,submission.submission.id);
    } finally {await browser?.close(); process.kill(); await rm(tmp,{recursive:true,force:true});}
  });
}

test('sending locks raw input and settings while newer drafts and multi-tab choices survive',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-browser-'));
  const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await chromium.launch(); const context=await browser.newContext(); const page=await context.newPage();
    await page.goto(url+'/login.html');await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();await page.waitForURL(url+'/');
    let release, notify;const prepared=new Promise(resolve=>notify=resolve);
    await page.route('**/api/previews',async route=>{const response=await route.fetch();notify();await new Promise(resolve=>release=resolve);await route.fulfill({response});});
    await chooseSetting(page,'model-selector','Codex Example');
    await chooseSetting(page,'effort-selector','低');
    await fillPrompt(page,'old');await page.locator('#execute').click();await prepared;
    assert.equal(await page.locator('[data-message-position="right"]').filter({hasText:'old'}).count(),1,'sent prompt must appear while preparation response is still pending');
    await fillPrompt(page,'new');await chooseSetting(page,'effort-selector','高');release();
    await page.waitForFunction(()=>document.getElementById('task-state').textContent.includes('排队中'));
    assert.equal(await page.locator('#prompt').inputValue(),'new');
    assert.equal((await settings(page)).effort,'high');
    const sent=await page.evaluate(async()=>await (await fetch('/api/tasks')).json());
    const queued=sent.find(task=>task.status==='queued');
    assert.equal(queued.prompt,'old');assert.equal(queued.effort,'low');
    await page.waitForFunction(()=>window.jlptChat.getMessages().filter(message=>message.position==='right'&&message.content.content==='old').length===1);
    await openPaperPanel(page);
    const tab=await page.context().newPage();await tab.goto(url+'/');await openPaperPanel(tab);
    await page.locator('input[name=q1][value="1"]').check();await page.waitForFunction(()=>document.getElementById('save-state').textContent==='草稿已保存');
    await tab.locator('input[name=q1][value="2"]').check();await tab.waitForSelector('#draft-conflict:not([hidden])');
    assert.equal(await tab.locator('input[name=q1][value="2"]').isChecked(),true);
    await tab.locator('#keep-local-draft').click();await tab.waitForFunction(()=>document.getElementById('save-state').textContent==='草稿已保存');
    const stored=await tab.evaluate(async()=>await (await fetch('/api/papers/paper1')).json());assert.equal(stored.draft['1'].answer,'2');
  } finally{await browser?.close();process.kill();await rm(tmp,{recursive:true,force:true});}
});

test('stream replay is deduplicated and delayed actions preserve the selected conversation and new input',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-chat-races-'));
  const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await chromium.launch();const page=await browser.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/tasks/task1/stream?after=*',route=>{
      const chunks=[{id:99,type:'user',text:'请为我出一份练习',time:1,data:{message_id:'user',generation:1}},{id:100,type:'assistant',text:'**流',time:1,data:{message_id:'stream',generation:1,delta:true}},{id:101,type:'assistant',text:'式**',time:1,data:{message_id:'stream',generation:1,delta:true}}];
      const body=[...chunks,chunks[0]].map(event=>`id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`).join('')+'event: task\ndata: '+JSON.stringify({id:'task1',cli:'codex',status:'ready',generation:1,session:'s1'})+'\n\n';
      return route.fulfill({contentType:'text/event-stream',body});
    });
    await page.goto(url+'/login.html');await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();await page.waitForURL(url+'/');
    await selectHistoryTask(page,'task1','codex');
    await page.locator('#chat-messages strong').filter({hasText:'流式'}).waitFor();
    assert.equal(await page.locator('#chat-messages strong').filter({hasText:'流式'}).count(),1);
    await fillPrompt(page,'请解释');
    await page.locator('[data-testid="message-text-content"]').filter({hasText:'请为我出一份练习'}).scrollIntoViewIfNeeded();
    // Upstream clears the quote control 100 ms after scrolling; select once scrolling settles.
    await page.waitForTimeout(150);
    await page.locator('[data-testid="message-text-content"]').filter({hasText:'请为我出一份练习'}).evaluate(element=>{
      const range=document.createRange();range.selectNodeContents(element);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    });
    await page.getByText('引用',{exact:true}).click();
    assert.equal(await page.locator('#prompt').inputValue(),'> 请为我出一份练习\n\n请解释');
    let releaseCancel, notifyCancel;
    const cancelling=new Promise(resolve=>notifyCancel=resolve);
    await page.route('**/api/tasks/task1/cancel',async route=>{
      notifyCancel();await new Promise(resolve=>releaseCancel=resolve);
      await route.fulfill({contentType:'application/json',body:JSON.stringify({id:'task1',cli:'codex',status:'cancelled'})});
    });
    const stopped=page.evaluate(()=>window.jlptChat.onStop());await cancelling;
    await selectHistoryTask(page,'task2','agy');
    releaseCancel();await stopped;
    let previewTask;
    page.on('request',request=>{if(request.url().endsWith('/api/previews')) previewTask=request.postDataJSON().task_id;});
    let releaseSend, notifySend;const sending=new Promise(resolve=>notifySend=resolve);
    await page.route('**/api/tasks',async route=>{
      if(route.request().method()!=='POST') return route.continue();
      const response=await route.fetch();notifySend();await new Promise(resolve=>releaseSend=resolve);await route.fulfill({response});
    });
    await fillPrompt(page,'给第二个会话的问题');await page.locator('#execute').click();await sending;
    assert.equal(previewTask,'task2');
    await fillPrompt(page,'发送期间写下的下一条提示词');releaseSend();
    await page.waitForFunction(()=>document.getElementById('task-state').textContent.includes('排队中'));
    assert.equal(await page.locator('#prompt').inputValue(),'发送期间写下的下一条提示词');
    assert.match(await page.locator('#conversation').textContent(),/语法用法解释/);
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();process.kill();await rm(tmp,{recursive:true,force:true});}
});

test('lost enqueue response retains raw input and retries the same turn once',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-chat-retry-'));
  const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await chromium.launch();const page=await browser.newPage();
    await page.goto(url+'/login.html');await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();await page.waitForURL(url+'/');
    const ids=[];
    await page.route('**/api/tasks',async route=>{
      if(route.request().method()!=='POST') return route.continue();
      ids.push(route.request().postDataJSON().preview_id);
      const response=await route.fetch();
      if(ids.length===1) return route.abort('failed');
      await route.fulfill({response});
    });
    const raw='/export 原样发送\n  保留末尾空格  ';
    await fillPrompt(page,raw);await page.locator('#execute').click();
    await page.locator('#notice:not([hidden])').waitFor();
    assert.equal(await page.locator('#prompt').inputValue(),raw);
    await page.locator('#execute').click();
    await page.waitForFunction(()=>document.getElementById('task-state').textContent.includes('排队中'));
    assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
    const tasks=await page.evaluate(async()=>await (await fetch('/api/tasks')).json());
    const sent=tasks.filter(task=>task.status==='queued');assert.equal(sent.length,1);
    assert.equal(sent[0].generation,1);assert.equal(sent[0].prompt,raw);
    const events=await page.evaluate(async id=>await (await fetch(`/api/tasks/${id}/events`)).json(),sent[0].id);
    assert.equal(events.filter(event=>event.type==='user').length,1);
  } finally {await browser?.close();process.kill();await rm(tmp,{recursive:true,force:true});}
});

test('stop during preparation prevents enqueue, and stop during enqueue cancels the returned task',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-chat-stop-'));
  const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await chromium.launch();const page=await browser.newPage();
    await page.goto(url+'/login.html');await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();await page.waitForURL(url+'/');
    let releasePrepare, notifyPrepare;const prepared=new Promise(resolve=>notifyPrepare=resolve);
    await page.route('**/api/previews',async route=>{
      const response=await route.fetch();notifyPrepare();await new Promise(resolve=>releasePrepare=resolve);await route.fulfill({response});
    });
    let enqueued=0;page.on('request',request=>{if(request.url().endsWith('/api/tasks') && request.method()==='POST') enqueued++;});
    await fillPrompt(page,'停止这一次发送');
    const preparing=page.evaluate(()=>window.jlptChat.onSend());await prepared;
    await page.evaluate(()=>window.jlptChat.onStop());releasePrepare();await preparing;
    assert.equal(enqueued,0);assert.equal(await page.locator('#prompt').inputValue(),'停止这一次发送');
    await page.unroute('**/api/previews');
    let releaseSend, notifySend;const sent=new Promise(resolve=>notifySend=resolve);
    await page.route('**/api/tasks',async route=>{
      if(route.request().method()!=='POST') return route.continue();
      const response=await route.fetch();notifySend();await new Promise(resolve=>releaseSend=resolve);await route.fulfill({response});
    });
    let cancelled;
    await page.route('**/api/tasks/*/cancel',async route=>{
      cancelled=route.request().url().split('/').at(-2);
      await route.fulfill({contentType:'application/json',body:JSON.stringify({id:cancelled,cli:'codex',status:'cancelled',generation:1})});
    });
    const sending=page.evaluate(()=>window.jlptChat.onSend());await sent;
    await page.evaluate(()=>window.jlptChat.onStop());releaseSend();await sending;
    assert.ok(cancelled);assert.equal(enqueued,1);
    assert.equal(await page.locator('#prompt').inputValue(),'停止这一次发送');
  } finally {await browser?.close();process.kill();await rm(tmp,{recursive:true,force:true});}
});

test('agent menu is dark and verified-only; diagnostic refresh updates it and focus hides input decoration',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-chat-health-'));
  const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await chromium.launch();const page=await browser.newPage();
    const states=[{id:'codex',installed:true,auth:'ready',usable:true,checking:false,detail:'已验证真实对话',models:[]},
      {id:'qoder',installed:true,auth:'unverified',usable:false,checking:false,detail:'未验证',models:[]},
      {id:'agy',installed:true,auth:'failed',usable:false,checking:false,detail:'地域限制',models:[]}];
    let checked=false, requests=0;
    await page.route('**/api/clis',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(states)}));
    await page.route('**/api/clis/refresh',async route=>{
      requests++;checked=true;
      states[0]={...states[0],auth:'failed',usable:false,detail:'登录失效'};
      states[1]={...states[1],auth:'ready',usable:true,detail:'已验证真实对话'};
      await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify(states)});
    });
    await page.goto(url+'/login.html');await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();await page.waitForURL(url+'/');
    await page.waitForFunction(()=>document.getElementById('cli-status').textContent.includes('已验证真实对话'));
    assert.equal(await page.locator('#operation').count(),0);
    await page.locator('#cli').click();
    assert.deepEqual(await page.getByRole('option').allTextContents(),['Codex']);
    const popup=await page.locator('.chat-agent-options').evaluate(element=>getComputedStyle(element).backgroundColor);
    assert.equal(popup,'rgb(38, 38, 36)');
    await page.getByRole('option',{name:'Codex',exact:true}).click();
    await page.locator('#prompt').click();
    const input=await page.locator('#prompt').evaluate(element=>({
      outline:getComputedStyle(element).outlineStyle,
      border:getComputedStyle(element).borderBottomWidth,
      placeholder:getComputedStyle(element,'::placeholder').color
    }));
    assert.equal(input.outline,'none');assert.equal(input.border,'0px');
    assert.equal(input.placeholder,'rgba(0, 0, 0, 0)');
    await page.locator('#diagnostics summary').click();
    await page.locator('#refresh-diagnostics').click();
    await page.waitForFunction(()=>window.jlptChat.getSettings().cli==='qoder');
    assert.equal(checked,true);assert.equal(requests,1);
    assert.match(await page.locator('#cli-status').textContent(),/登录失效/);
    await page.locator('#cli').click();
    assert.deepEqual(await page.getByRole('option').allTextContents(),['Qoder']);
  } finally {await browser?.close();process.kill();await rm(tmp,{recursive:true,force:true});}
});


test('lost diagnostic refresh response revokes old choices and recovers without losing input',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-health-retry-'));
  const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await chromium.launch();const page=await browser.newPage();
    let states=[{id:'codex',installed:true,auth:'ready',usable:true,checking:false,detail:'已验证真实对话',models:[]}];
    await page.route('**/api/clis',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(states)}));
    let releaseResponse, accepted;
    const received=new Promise(resolve=>accepted=resolve);
    await page.route('**/api/clis/refresh',async route=>{
      states=[{...states[0],auth:'failed',usable:false,detail:'登录失效'}];
      accepted();await new Promise(resolve=>releaseResponse=resolve);await route.abort('failed');
    });
    await page.goto(url+'/login.html');await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();await page.waitForURL(url+'/');
    await page.waitForFunction(()=>document.getElementById('cli-status').textContent.includes('已验证真实对话'));
    const raw='保留尚未发送的草稿';await fillPrompt(page,raw);
    assert.equal(await page.locator('#execute').isDisabled(),false);
    await page.locator('#diagnostics summary').click();await page.locator('#refresh-diagnostics').click();await received;
    assert.equal(await page.locator('#execute').isDisabled(),true);
    assert.equal(await page.locator('#cli .arco-select').getAttribute('aria-disabled'),'true');
    assert.equal(await page.locator('#prompt').inputValue(),raw);
    releaseResponse();
    await page.waitForFunction(()=>document.getElementById('cli-status').textContent.includes('登录失效'));
    assert.equal(await page.locator('#execute').isDisabled(),true);
    assert.equal(await page.locator('#prompt').inputValue(),raw);
    assert.equal(await page.locator('#refresh-diagnostics').isDisabled(),false);
  } finally {await browser?.close();process.kill();await rm(tmp,{recursive:true,force:true});}
});

test('full-height three-column chat shows one legacy reply and opens papers only in the right pane',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-layout-'));
  const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1920,height:1080}});
    await page.goto(url+'/login.html');await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();await page.waitForURL(url+'/');
    await selectHistoryTask(page,'task3','qoder');
    await page.locator('#chat-messages .markdown-shadow-body').filter({hasText:'我是 Qoder'}).waitFor();
    assert.equal(await page.locator('#chat-messages .markdown-shadow-body').filter({hasText:'我是 Qoder'}).count(),1);
    await selectHistoryTask(page,'task4','qoder');
    await page.locator('#chat-messages').getByText('测试执行器异常',{exact:true}).waitFor();
    assert.ok(!(await page.locator('#task-state').textContent()).includes('测试执行器异常'),'error detail should appear only in its chat message');
    await selectHistoryTask(page,'task3','qoder');
    await page.locator('#chat-messages .markdown-shadow-body').filter({hasText:'我是 Qoder'}).waitFor();
    const bounds=await page.evaluate(()=>{
      const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,width:r.width,height:r.height,bottom:r.bottom};};
      return {input:rect('chat-input'),history:rect('chat-messages'),chat:document.querySelector('.chat-surface').getBoundingClientRect().toJSON(),artifacts:rect('artifacts-panel'),width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollHeight};
    });
    assert.ok(bounds.input.bottom>=bounds.height-40);
    assert.ok(bounds.history.height>bounds.height*.55);
    assert.ok(bounds.artifacts.x>=bounds.chat.right-1);
    assert.ok(bounds.artifacts.width>=320);
    assert.ok(bounds.scroll<=bounds.height+1);
    await openPaperPanel(page);await page.locator('#paper-section').waitFor({state:'visible'});
    assert.equal(await page.locator('#artifacts-panel #questions').count(),1);
    await page.locator('input[name=q1][value="2"]').check();
    await page.locator('#papers button').click();
    await page.locator('#paper-section').waitFor({state:'hidden'});
    assert.equal(await page.locator('#paper-section').isVisible(),false);
    await page.locator('#papers button').click();
    await page.locator('#paper-section').waitFor({state:'visible'});
    assert.equal(await page.locator('input[name=q1][value="2"]').isChecked(),true);
    assert.equal(await page.locator('#chat-input').isVisible(),true);
    const after=await page.locator('#chat-input').boundingBox();assert.ok(Math.abs(after.y+after.height-bounds.input.bottom)<2);
    await page.setViewportSize({width:390,height:844});
    await page.locator('#toggle-artifacts').click();
    assert.equal(await page.locator('#artifacts-panel').isVisible(),true);
    assert.equal(await page.locator('#chat-input').isVisible(),false);
    await page.locator('#close-artifacts').click();
    assert.equal(await page.locator('#chat-input').isVisible(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  } finally {await browser?.close();process.kill();await rm(tmp,{recursive:true,force:true});}
});

test('SSE displays partial replies and preserves completed work time after reload without event polling',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-sse-time-'));
  const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:900}});
    let polled=0;page.on('request',request=>{if(/\/events\?/.test(request.url()))polled++;});
    await page.goto(url+'/login.html');await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();await page.waitForURL(url+'/');
    await fillPrompt(page,'SSE_TEST');await page.locator('#execute').click();
    await page.locator('#chat-messages .markdown-shadow-body').filter({hasText:'流式'}).waitFor();
    assert.ok(!(await page.locator('#chat-messages').textContent()).includes('回复完成'));
    await page.locator('.chat-work-time').filter({hasText:/工作中 \d+ 秒/}).waitFor();
    await page.locator('#chat-messages strong').filter({hasText:'回复'}).waitFor();
    await page.locator('#chat-messages .chat-work-time').filter({hasText:'工作时间 2 秒'}).waitFor();
    const id=await page.evaluate(()=>window.jlptChat.getMessages()[0].conversation_id);
    await page.reload();await selectHistoryTask(page,id,'codex');
    await page.locator('#chat-messages .chat-work-time').filter({hasText:'工作时间 2 秒'}).waitFor();
    assert.equal(polled,0);
  } finally {await browser?.close();process.kill();await rm(tmp,{recursive:true,force:true});}
});

test('refresh recovers a completed continuation over SSE when the enqueue response was lost',async()=>{
  const tmp=await mkdtemp(join(tmpdir(),'jlpt-sse-recovery-'));
  const process=spawn('python3',['-m','tests.server.browser_fixture',tmp],{stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{process.stdout.once('data',data=>resolve(data.toString().trim()));process.stderr.once('data',data=>reject(new Error(data.toString())));});
    browser=await chromium.launch();const page=await browser.newPage();
    let polled=0;page.on('request',request=>{if(/\/events\?/.test(request.url()))polled++;});
    await page.goto(url+'/login.html');await page.locator('#password').fill('browser-test-password');await page.locator('button[type=submit]').click();await page.waitForURL(url+'/');
    await selectHistoryTask(page,'task1','codex');
    await page.locator('#chat-messages strong').filter({hasText:'练习'}).waitFor();
    await page.waitForFunction(()=>document.getElementById('task-state').textContent.includes('试卷已准备'));
    await page.route('**/api/tasks',async route=>{
      if(route.request().method()!=='POST') return route.continue();
      await route.fetch();await route.abort('failed');
    });
    await fillPrompt(page,'SSE_TEST');await page.locator('#execute').click();
    await page.locator('#notice:not([hidden])').waitFor();
    await page.waitForFunction(async()=> (await (await fetch('/api/tasks/task1')).json()).status==='answered');
    await page.locator('#refresh').click();
    await page.locator('#chat-messages strong').filter({hasText:'回复'}).waitFor({timeout:3000});
    await page.locator('#chat-messages .chat-work-time').filter({hasText:'工作时间 2 秒'}).waitFor();
    assert.equal(await page.locator('[data-message-position="right"]').filter({hasText:'SSE_TEST'}).count(),1);
    assert.equal(polled,0);
  } finally {await browser?.close();process.kill();await rm(tmp,{recursive:true,force:true});}
});
