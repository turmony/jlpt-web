const $ = id => document.getElementById(id);
let currentTask = null, currentPaper = null, preview = null, cursor = 0, busy = false;
let cliStates = [];
const effortNames = {none:'无',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'极高'};
let draftTimer, saveChain = Promise.resolve(), draftRevision = 0, draftDirty = false, draftConflict = false, previewRevision = 0;
const stateNames = { queued:'排队中',running:'智能体处理中',checking:'正在检查实际产物',waiting:'等待补充提示词',ready:'试卷已准备，可作答',failed:'处理失败，可继续提示',cancelled:'已取消，资料保留',interrupted:'重启中断，可继续提示',committing:'正在提交本地学习历史',commit_failed:'判卷通过，本地提交失败',complete:'判卷与本地提交完成' };

async function api(path, data) {
  const response = await fetch('/api' + path, data === undefined ? {} : { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data) });
  if (response.status === 401) { location.replace('/login.html'); throw new Error('请重新登录'); }
  const value = await response.json();
  if (!response.ok) { const error = new Error(value.error || '请求失败'); error.status = response.status; throw error; }
  return value;
}
function notice(error) { $('notice').textContent = error.message || String(error); $('notice').hidden = false; }
function wrap(fn) { return async event => { try { $('notice').hidden = true; await fn(event); } catch(error) { notice(error); } }; }
function invalidate() { previewRevision++; preview = null; $('execute').disabled = true; $('preview').textContent = ''; $('preview-settings').textContent = ''; }
function renderEfforts(value = '') {
  const state = cliStates.find(item => item.id === $('cli').value);
  const selected = state?.models?.find(item => item.id === $('model').value);
  $('model-status').textContent = state?.models_error || '';
  $('effort').replaceChildren(new Option('沿用 CLI／会话配置', ''), ...(selected?.efforts || []).map(effort => new Option(`${effortNames[effort] || effort} · ${effort}`, effort)));
  if (value && ![...$('effort').options].some(option => option.value === value)) $('effort').add(new Option('已保存 · '+value, value));
  $('effort').value = value; $('effort').disabled = !selected?.efforts?.length && !value;
  if (selected && !selected.efforts?.length && !$('model-status').textContent) $('model-status').textContent = '该模型未提供可选推理强度，沿用执行器配置。';
}
function renderModels(model = '', effort = '') {
  const state = cliStates.find(item => item.id === $('cli').value);
  $('model').replaceChildren(new Option('沿用 CLI／会话配置', ''), ...(state?.models || []).map(item => new Option(item.label, item.id)));
  if (model && ![...$('model').options].some(option => option.value === model)) $('model').add(new Option('已保存 · '+model, model));
  $('model').value = model; $('model-status').textContent = state?.models_error || '';
  renderEfforts(effort);
}
function selectTask(task) {
  currentTask = task; cursor = 0; $('events').textContent = '';
  $('cli').value = task.cli; $('cli').disabled = true;
  $('operation').value = task.operation || 'generate';
  renderModels(task.model || '', task.effort || '');
  $('conversation').textContent = '继续对话 · ' + task.id.slice(0,8);
  invalidate(); updateTask(task);
}
function updateTask(task) {
  currentTask = task;
  $('task-state').textContent = (stateNames[task.status] || task.status) + (task.error ? '\n' + task.error : '') + (task.commit ? '\n本地提交 ' + task.commit.slice(0,10) : '');
  $('cancel').disabled = !['queued','running','checking'].includes(task.status) || !!task.grade;
  $('commit-retry').hidden = task.status !== 'commit_failed';
  $('execute').disabled = !preview || ['queued','running','checking','committing','complete','commit_failed'].includes(task.status);
}
function button(text, action, className) {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.className = className || '';
  node.addEventListener('click', wrap(action)); return node;
}
async function refresh() {
  if (busy) return; busy = true;
  try {
    const [tasks,papers] = await Promise.all([api('/tasks'),api('/papers')]);
    $('tasks').replaceChildren(...tasks.map(task => button(`${task.id.slice(0,8)} · ${task.cli} · ${stateNames[task.status] || task.status}`, () => selectTask(task), 'task')));
    $('papers').replaceChildren(...papers.map(paper => button(`${paper.title} · ${paper.submission ? (paper.score === undefined ? '已交卷' : '成绩 '+paper.score+'/'+paper.questions.length) : '作答中'}`, () => openPaper(paper.id), 'paper-link')));
    if (currentTask) {
      const task = tasks.find(item => item.id === currentTask.id);
      if (task) updateTask(task);
      const events = await api(`/tasks/${currentTask.id}/events?after=${cursor}`);
      for (const event of events) { cursor = event.id; $('events').textContent += event.text + '\n'; }
      if ($('events').textContent.length > 200000) $('events').textContent = $('events').textContent.slice(-200000);
    }
    if (currentPaper) {
      const paper = papers.find(item => item.id === currentPaper.id);
      $('view-report').hidden = !paper?.report;
    }
  } finally { busy = false; }
}
function readAnswers() {
  const result = {};
  for (const question of currentPaper.questions) {
    const field = $('questions').querySelector(`[data-number="${question.number}"]`);
    const answer = question.section === 'order' ? field.querySelector('.order-answer').value.trim() : field.querySelector('input[type=radio]:checked')?.value || '';
    result[String(question.number)] = {answer,uncertain:field.querySelector('.uncertain input').checked};
  }
  return result;
}
async function saveDraft() {
  if (!currentPaper || currentPaper.submission || !draftDirty || draftConflict) return;
  const paper = currentPaper, answers = readAnswers(), revision = draftRevision;
  saveChain = saveChain.catch(() => {}).then(async () => {
    if (currentPaper !== paper || paper.submission) return;
    let saved;
    try { saved = await api(`/papers/${paper.id}/draft`, {answers,version:paper.version}); }
    catch(error) {
      if (error.status === 409) { draftConflict = true; $('draft-conflict').hidden = false; $('submit-paper').disabled = true; }
      throw error;
    }
    paper.version = saved.version; paper.draft = saved.draft;
    $('save-state').textContent = revision === draftRevision ? '草稿已保存' : '正在保存最新作答…';
    if (revision === draftRevision) { draftDirty = false; sessionStorage.removeItem('jlpt-draft:'+paper.id); }
  });
  return saveChain;
}
async function openPaper(id, discardLocal = false) {
  clearTimeout(draftTimer);
  if (currentPaper && !currentPaper.submission && !draftConflict && !discardLocal) await saveDraft();
  if (discardLocal) sessionStorage.removeItem('jlpt-draft:'+id);
  const paper = await api('/papers/' + id); currentPaper = paper;
  draftDirty = false; draftConflict = false;
  if (paper.submission) sessionStorage.removeItem('jlpt-draft:'+id);
  const local = JSON.parse(sessionStorage.getItem('jlpt-draft:'+id) || 'null');
  if (local && !paper.submission) {
    paper.draft = local.answers; draftDirty = true; draftConflict = local.version !== paper.version;
    if (!draftConflict) draftTimer = setTimeout(() => saveDraft().catch(notice), 500);
  }
  $('draft-conflict').hidden = !draftConflict;
  $('paper-section').hidden = false; $('paper-title').textContent = paper.title;
  $('save-state').textContent = paper.submission ? '已正式交卷，答案已锁定' : '草稿自动保存；可随时查看答案';
  $('view-report').hidden = !paper.report;
  $('answer-details').hidden = true; $('report-details').hidden = true;
  $('submit-paper').disabled = !!paper.submission || draftConflict;
  $('questions').replaceChildren();
  for (const q of paper.questions) {
    const field = document.createElement('fieldset'); field.className = 'question'; field.dataset.number = q.number; field.disabled = !!paper.submission;
    const legend = document.createElement('legend'); legend.textContent = `${q.number}. ${q.paper_prompt || q.prompt}`; field.append(legend);
    for (const [value,text] of Object.entries(q.options)) {
      const label = document.createElement('label'); label.className = 'option';
      if (q.section !== 'order') { const input = document.createElement('input'); input.type = 'radio'; input.name = 'q'+q.number; input.value = value; input.checked = paper.draft[String(q.number)]?.answer === value; label.append(input); }
      const span = document.createElement('span'); span.textContent = value + '. ' + text; label.append(span); field.append(label);
    }
    if (q.section === 'order') { const input = document.createElement('input'); input.className = 'order-answer'; input.inputMode = 'numeric'; input.placeholder = '完整语序，例如 2314'; input.setAttribute('aria-label', '第'+q.number+'题完整语序'); input.value = paper.draft[String(q.number)]?.answer || ''; field.append(input); }
    const uncertain = document.createElement('label'); uncertain.className = 'uncertain option';
    const check = document.createElement('input'); check.type='checkbox'; check.checked=paper.draft[String(q.number)]?.uncertain || false;
    uncertain.append(check,document.createTextNode('这题不确定')); field.append(uncertain); $('questions').append(field);
  }
}
$('answer-form').addEventListener('input', () => {
  draftRevision++; draftDirty = true; $('save-state').textContent = '正在保存…'; clearTimeout(draftTimer);
  sessionStorage.setItem('jlpt-draft:'+currentPaper.id,JSON.stringify({answers:readAnswers(),version:currentPaper.version}));
  draftTimer = setTimeout(() => saveDraft().catch(notice), 500);
});
$('answer-form').addEventListener('submit', wrap(async event => {
  event.preventDefault(); clearTimeout(draftTimer); $('submit-paper').disabled = true;
  try {
    if (draftConflict) throw new Error('请先选择草稿版本');
    await saveDraft(); const paper = await api(`/papers/${currentPaper.id}/submit`, {version:currentPaper.version});
    currentPaper = paper; await openPaper(paper.id);
    const task = await api('/tasks/'+paper.task_id); selectTask(task);
    $('operation').value = 'grade';
    $('prompt').value = '请按项目流程判卷已交卷试卷 '+paper.id+'，给出完整成绩报告。';
    $('conversation').textContent += ' · 已交卷，请预览判卷提示词后执行';
    await refresh();
  } finally { $('submit-paper').disabled = !!currentPaper.submission || draftConflict; }
}));
$('preview-button').addEventListener('click', wrap(async () => {
  invalidate(); const revision = previewRevision;
  const result = await api('/previews',{cli:$('cli').value,model:$('model').value,effort:$('effort').value,operation:$('operation').value,text:$('prompt').value,...(currentTask ? {task_id:currentTask.id} : {})});
  if (revision !== previewRevision) return;
  preview = result;
  $('preview-settings').textContent = `智能体：${preview.cli} · 模型：${preview.model || '沿用 CLI／会话配置'} · 推理强度：${preview.effort || '沿用 CLI／会话配置'}`;
  $('preview').textContent = preview.prompt; $('preview-details').open = true; $('execute').disabled = false;
}));
$('execute').addEventListener('click', wrap(async () => {
  if (!preview) return; const id = preview.id; $('execute').disabled = true;
  const task = await api('/tasks',{preview_id:id}); selectTask(task); await refresh();
}));
$('prompt').addEventListener('input', invalidate); $('cli').addEventListener('change', () => { renderModels(); invalidate(); });
$('model').addEventListener('change', () => { renderEfforts(); invalidate(); });
$('effort').addEventListener('change', invalidate);
$('operation').addEventListener('change', invalidate);
$('new-task').addEventListener('click', () => { currentTask = null; cursor=0; $('events').textContent=''; $('cli').disabled=false; $('operation').value='generate'; renderModels(); $('conversation').textContent='新对话'; $('task-state').textContent='新对话'; $('cancel').disabled=true; $('commit-retry').hidden=true; invalidate(); });
$('cancel').addEventListener('click', wrap(async () => { updateTask(await api(`/tasks/${currentTask.id}/cancel`,{})); }));
$('commit-retry').addEventListener('click', wrap(async () => { updateTask(await api(`/tasks/${currentTask.id}/commit`,{})); }));
$('refresh').addEventListener('click', wrap(refresh));
$('view-answers').addEventListener('click', wrap(async () => { $('answer-text').textContent=(await api(`/papers/${currentPaper.id}/answers`)).text; $('answer-details').hidden=false; $('answer-details').open=true; }));
$('view-report').addEventListener('click', wrap(async () => { $('report-text').textContent=(await api(`/papers/${currentPaper.id}/report`)).text; $('report-details').hidden=false; $('report-details').open=true; }));
$('logout').addEventListener('click', wrap(async () => { clearTimeout(draftTimer); await saveDraft(); await api('/logout',{}); location.replace('/login.html'); }));
$('load-server-draft').addEventListener('click', wrap(async () => { await openPaper(currentPaper.id, true); }));
$('keep-local-draft').addEventListener('click', wrap(async () => {
  const latest = await api('/papers/'+currentPaper.id);
  if (latest.submission) { await openPaper(latest.id, true); throw new Error('另一标签页已正式交卷，答案已锁定'); }
  currentPaper.version = latest.version; draftConflict = false; draftDirty = true;
  await saveDraft(); $('draft-conflict').hidden = true; $('submit-paper').disabled = false;
}));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { clearTimeout(draftTimer); saveDraft().catch(notice); } });
try {
  await api('/session');
  const states = await api('/clis');
  cliStates = states; renderModels();
  $('cli-status').textContent = states.map(s => `${s.id}：${s.detail}`).join(' · ');
  for (const option of $('cli').options) option.disabled = !states.find(s=>s.id===option.value)?.installed;
  await refresh();
} catch(error) { notice(error); }
setInterval(() => refresh().catch(notice), 2500);
