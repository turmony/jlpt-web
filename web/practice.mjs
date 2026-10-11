import '/chat.mjs';
import {groupHistory} from './history.mjs';
const $ = id => document.getElementById(id);
let currentTask = null, currentPaper = null, cursor = 0, busy = false;
let stream = null, selectionRevision = 0, composeRevision = 0, sending = false, pendingSnapshot = null, activeSend = null;
let checkingClis = false, cliPoll = null, cliStates = [];
let showArchived = false, historyTasks = [], lastArchived = null, historyRevision = 0;
let historyPapers = [], openHistoryMenu = null;
const archivingTasks = new Set();
const processingStates = ['queued','running','checking','committing'];
const chat = window.jlptChat;
let draftTimer, saveChain = Promise.resolve(), draftRevision = 0, draftDirty = false, draftConflict = false;
const stateNames = { answered:'回复完成，可继续对话',queued:'排队中',running:'智能体处理中',checking:'正在检查实际产物',waiting:'等待补充提示词',ready:'试卷已准备，可作答',failed:'处理失败，可继续提示',cancelled:'已取消，资料保留',interrupted:'重启中断，可继续提示',committing:'正在提交本地学习历史',commit_failed:'判卷通过，本地提交失败',complete:'判卷与本地提交完成' };

async function api(path, data) {
  const response = await fetch('/api' + path, data === undefined ? {} : { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data) });
  if (response.status === 401) { location.replace('/login.html'); throw new Error('请重新登录'); }
  const value = await response.json();
  if (!response.ok) { const error = new Error(value.error || '请求失败'); error.status = response.status; throw error; }
  return value;
}
function notice(error) { $('notice').textContent = error.message || String(error); $('notice').hidden = false; }
function wrap(fn) { return async event => { try { $('notice').hidden = true; await fn(event); } catch(error) { notice(error); } }; }
function draftChanged() { composeRevision++; pendingSnapshot = null; }
function showCliStates(states) {
  cliStates=states;chat.setClis(states);
  if (!currentTask && !states.some(item=>item.id===chat.getSettings().cli && item.usable && item.auth==='ready')) {
    const fallback=states.find(item=>item.usable && item.auth==='ready');
    if (fallback) {selectionRevision++;chat.setSettings({cli:fallback.id,model:'',effort:''});draftChanged();}
  }
  checkingClis=states.some(item=>item.checking);
  $('refresh-diagnostics').disabled=checkingClis;
  $('diagnostic-state').textContent=checkingClis ? '正在验证登录和真实对话…' : '验证完成';
  $('cli-status').textContent=states.map(item=>`${item.id}：${item.detail}${item.checked_at ? '（'+new Date(item.checked_at*1000).toLocaleTimeString()+'）' : ''}${item.models_error ? '；模型列表：'+item.models_error : ''}`).join('\n');
  clearTimeout(cliPoll);
  if (checkingClis) cliPoll=setTimeout(()=>loadCliStates().catch(error=>{checkingClis=false;$('refresh-diagnostics').disabled=false;notice(error);}),1500);
  renderHistory();
}
async function loadCliStates() {showCliStates(await api('/clis'));}
function selectTask(task) {
  closeHistoryMenus();
  selectionRevision++;
  stream?.close();
  currentTask = task; cursor = 0; $('events').textContent = '';
  chat.setConversation(task);
  chat.setSettings({cli:task.cli,operation:'auto',model:task.model || '',effort:task.effort || ''});
  draftChanged(); updateTask(task);
  watchTask(task.id);
  document.getElementById('chat-shell').classList.remove('sidebar-open','artifacts-open');
  $('toggle-artifacts').setAttribute('aria-expanded','false');
  $('toggle-conversations').setAttribute('aria-expanded','false');
  renderHistory();
}
function receiveEvents(id, events) {
  if (currentTask?.id !== id) return;
  chat.addEvents(events);
  renderTaskState();
  for (const event of events) {
    if (event.id <= cursor) continue;
    cursor = event.id;
    if (['diagnostic','error'].includes(event.type)) $('events').textContent += event.text + '\n';
  }
  if ($('events').textContent.length > 200000) $('events').textContent = $('events').textContent.slice(-200000);
}
function watchTask(id) {
  stream?.close();
  const source = new EventSource(`/api/tasks/${id}/stream?after=${cursor}`); stream = source;
  source.onmessage = event => {if(stream===source)receiveEvents(id,[JSON.parse(event.data)]);};
  source.addEventListener('task',event=>{
    if (stream!==source || currentTask?.id !== id) return;
    const task = JSON.parse(event.data); updateTask(task);
    if (!['queued','running','checking','committing'].includes(task.status)) {source.close();refresh().catch(notice);}
  });
  source.addEventListener('auth',()=>{source.close();location.replace('/login.html');});
}
function updateTask(task) {
  task = {...historyTasks.find(item => item.id === task.id), ...task, archived_at:task.archived_at};
  currentTask = task;
  chat.updateTask(task);
  $('conversation').textContent = (task.archived_at ? '已归档 · ' : '') + taskTitle(task);
  $('restore-current').hidden = !task.archived_at;
  renderTaskState();
  $('cancel').disabled = !['queued','running','checking'].includes(task.status) || !!task.grade;
  $('commit-retry').hidden = task.status !== 'commit_failed' || !!task.archived_at;
}
function renderTaskState() {
  if (!currentTask) return;
  const task = currentTask;
  const errorInChat = chat.getMessages().some(message => message.type === 'tips' && message.content.type === 'error' && message.content.content === task.error);
  $('task-state').textContent = (task.archived_at ? '已归档，恢复后可继续对话。\n' : '') + (stateNames[task.status] || task.status) + (task.error && !errorInChat ? '\n' + task.error : '') + (task.commit ? '\n本地提交 ' + task.commit.slice(0,10) : '');
}
function button(text, action, className) {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.className = className || '';
  node.addEventListener('click', wrap(action)); return node;
}
function taskTitle(task) {return task.title || historyTasks.find(item => item.id === task.id)?.title || '未命名对话';}
function closeHistoryMenus(restoreFocus = false) {
  const row = openHistoryMenu && [...$('tasks').querySelectorAll('.task-row')].find(row => row.dataset.taskId === openHistoryMenu);
  openHistoryMenu = null;
  for (const menu of $('tasks').querySelectorAll('.task-menu')) menu.hidden = true;
  for (const trigger of $('tasks').querySelectorAll('.task-more')) trigger.setAttribute('aria-expanded', 'false');
  for (const item of $('tasks').querySelectorAll('.menu-open')) item.classList.remove('menu-open');
  if (restoreFocus) row?.querySelector('.task-more').focus();
}
function openTaskMenu(row, focus = true) {
  closeHistoryMenus();
  const menu = row.querySelector('.task-menu'), trigger = row.querySelector('.task-more');
  openHistoryMenu = row.dataset.taskId;
  menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); row.classList.add('menu-open');
  const rect = trigger.getBoundingClientRect();
  menu.style.left = Math.max(12, Math.min(rect.right-menu.offsetWidth, innerWidth-menu.offsetWidth-12))+'px';
  menu.style.top = Math.max(12, Math.min(rect.bottom+6, innerHeight-menu.offsetHeight-12))+'px';
  if (focus) menu.querySelector('button').focus();
}
function paperIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-label','有试卷'); svg.setAttribute('role','img');
  svg.classList.add('task-paper-icon');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d','M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6');
  svg.append(path); return svg;
}
function renderHistory() {
  const menuId = openHistoryMenu;
  const menuFocused = !!document.activeElement?.closest('.task-menu');
  openHistoryMenu = null;
  $('restore-current').disabled = archivingTasks.has(currentTask?.id);
  $('show-active').setAttribute('aria-pressed', String(!showArchived));
  $('show-archived').setAttribute('aria-pressed', String(showArchived));
  const cli = chat.getSettings().cli;
  const archivedCount = historyTasks.filter(task => task.cli === cli && task.archived_at).length;
  $('show-archived').textContent = '已归档' + (archivedCount ? ` (${archivedCount})` : '');
  const paperTasks = new Set(historyPapers.map(paper => paper.task_id));
  const paperIds = new Set(historyPapers.map(paper => paper.id));
  const groups = groupHistory(historyTasks, cli, showArchived);
  const sections = groups.map(group => {
    const section = document.createElement('section'); section.className = 'history-group';
    const heading = document.createElement('h3'); heading.className = 'history-date'; heading.textContent = group.label;
    heading.id = 'history-date-'+group.key; section.setAttribute('aria-labelledby', heading.id); section.append(heading);
    for (const task of group.tasks) {
    const row = document.createElement('div'); row.className = 'task-row'; row.dataset.taskId = task.id;
    const title = taskTitle(task);
    const node = button('', () => selectTask(task), 'task'); node.title = title+' · '+(stateNames[task.status] || task.status);
    const label = document.createElement('span'); label.className = 'task-title'; label.textContent = title; node.append(label);
    if (paperTasks.has(task.id) || paperIds.has(task.paper_id)) node.append(paperIcon());
    node.setAttribute('aria-current', String(task.id === currentTask?.id));
    const archived = !!task.archived_at;
    const more = button('⋮', () => {
      if (openHistoryMenu === task.id) closeHistoryMenus(); else openTaskMenu(row);
    }, 'task-more');
    more.setAttribute('aria-label', '对话操作：'+title); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded','false');
    const menu = document.createElement('div'); menu.className = 'task-menu'; menu.setAttribute('role','menu'); menu.setAttribute('aria-label', title+'的操作'); menu.hidden = true;
    const action = button(archived ? '恢复' : '归档', () => {closeHistoryMenus(); return setTaskArchived(task.id, !archived);}, 'task-archive');
    action.setAttribute('role','menuitem');
    action.disabled = archivingTasks.has(task.id) || (!archived && (processingStates.includes(task.status) || (sending && currentTask?.id === task.id)));
    action.title = !archived && action.disabled ? '对话正在处理中，完成或停止后可归档' : archived ? '恢复到对话列表' : '归档后保留消息、CLI 会话和学习记录';
    menu.append(action); row.append(node, more, menu); section.append(row);
    }
    return section;
  });
  if (!sections.length) {const empty = document.createElement('p'); empty.className = 'muted history-empty'; empty.textContent = showArchived ? '暂无已归档对话' : '暂无对话'; sections.push(empty);}
  $('tasks').replaceChildren(...sections);
  if (menuId) {
    const row = [...$('tasks').querySelectorAll('.task-row')].find(row => row.dataset.taskId === menuId);
    if (row) openTaskMenu(row, menuFocused);
  }
}
async function setTaskArchived(id, archived) {
  if (archivingTasks.has(id)) return;
  archivingTasks.add(id); renderHistory();
  try {
    const task = await api(`/tasks/${id}/archive`, {archived});
    historyRevision++;
    historyTasks = historyTasks.map(item => item.id === id ? {...item, ...task, archived_at:task.archived_at} : item);
    if (currentTask?.id === id) {updateTask(task); draftChanged(); watchTask(id);}
    if (archived) {
      lastArchived = id; $('archive-message').textContent = '对话已归档';
      $('archive-feedback').hidden = false;
    } else if (lastArchived === id) {lastArchived = null; $('archive-feedback').hidden = true;}
  } finally {archivingTasks.delete(id); renderHistory();}
}
async function refresh() {
  if (busy) return; busy = true;
  const revision = historyRevision;
  try {
    const [tasks,papers] = await Promise.all([api('/tasks'),api('/papers')]);
    const freshHistory = revision === historyRevision && !archivingTasks.size;
    if (freshHistory) {historyTasks = tasks; historyPapers = papers; renderHistory();}
    $('papers').replaceChildren(...papers.map(paper => {const node=button(`${paper.title} · ${paper.submission ? (paper.score === undefined ? '已交卷' : '成绩 '+paper.score+'/'+paper.questions.length) : '作答中'}`, () => togglePaper(paper.id), 'paper-link');node.setAttribute('aria-expanded',String(currentPaper?.id===paper.id&&!$('paper-section').hidden));return node;}));
    if (currentTask) {
      const task = tasks.find(item => item.id === currentTask.id);
      if (freshHistory && task && !sending && task.generation >= currentTask.generation) {
        const resumeStream = task.generation > currentTask.generation ||
          (['queued','running','checking','committing'].includes(task.status) && (!stream || stream.readyState===EventSource.CLOSED));
        updateTask(task);
        if (resumeStream) watchTask(task.id);
      }
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
  $('paper-section').hidden = false; $('artifact-empty').hidden=true;
  if(innerWidth<=1100) { $('chat-shell').classList.add('artifacts-open');$('chat-shell').classList.remove('sidebar-open');$('toggle-artifacts').setAttribute('aria-expanded','true');$('toggle-conversations').setAttribute('aria-expanded','false'); } $('paper-title').textContent = paper.title;
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
async function togglePaper(id) {
  if(currentPaper?.id===id && !$('paper-section').hidden) {
    clearTimeout(draftTimer);await saveDraft();
    $('paper-section').hidden=true;$('artifact-empty').hidden=false;
    await refresh();
  } else {await openPaper(id);await refresh();}
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
    chat.setSettings({operation:'grade'});
    chat.setInput('请按项目流程判卷已交卷试卷 '+paper.id+'，给出完整成绩报告。');
    draftChanged();
    $('conversation').textContent += task.archived_at ? ' · 已交卷，恢复对话后可发送判卷请求' : ' · 已交卷，可直接发送判卷请求';
    await refresh();
  } finally { $('submit-paper').disabled = !!currentPaper.submission || draftConflict; }
}));
chat.onSend = async () => {
  const text=chat.getInput();
  if (sending || currentTask?.archived_at || archivingTasks.has(currentTask?.id) || !text.trim() || ['queued','running','checking','committing','complete','commit_failed'].includes(currentTask?.status)) return;
  if (!cliStates.some(item=>item.id===chat.getSettings().cli && item.usable && item.auth==='ready')) {
    const error=new Error('请先刷新运行诊断，验证智能体可以真实对话');notice(error);throw error;
  }
  const settings={...chat.getSettings()}, revision=selectionRevision, sentRevision=composeRevision;
  const payload={...settings,text,...(currentTask ? {task_id:currentTask.id} : {})};
  const key=JSON.stringify(payload);
  const turn={revision,cancelled:false,accepted:false};activeSend=turn;
  sending=true; $('notice').hidden=true; renderHistory();
  chat.beginSend(text);
  try {
    // Keep the existing immutable, idempotent transaction; there is one Send action in the UI.
    const saved=pendingSnapshot?.key===key ? pendingSnapshot.saved : await api('/previews',payload);
    if (revision===selectionRevision && sentRevision===composeRevision) pendingSnapshot={key,saved};
    if (turn.cancelled) return;
    if(revision===selectionRevision) chat.bindSend(saved.id,saved.generation+1);
    let task=await api('/tasks',{preview_id:saved.id});
    if (turn.cancelled) {
      try {task=await api(`/tasks/${task.id}/cancel`,{});}
      catch(error) {
        if (revision===selectionRevision) {
          const nextSettings={...chat.getSettings()};selectTask(task);chat.setSettings(nextSettings);
        }
        throw error;
      }
    }
    if (revision===selectionRevision) {
      const unchanged=!turn.cancelled && sentRevision===composeRevision, nextSettings={...chat.getSettings()};
      updateTask(task);
      watchTask(task.id);
      turn.accepted=true;
      if (unchanged) chat.setInput('');
      else chat.setSettings(nextSettings);
    }
    await refresh();
  } catch(error) {
    if (error.status && error.status<500) pendingSnapshot=null;
    notice(error);throw error;
  }
  finally {sending=false;activeSend=null;chat.endSend(!turn.accepted);renderHistory();}
};
chat.onInput = draftChanged;
chat.onSetting = (key,value) => {
  if (!['cli','model','effort','operation'].includes(key)) return;
  if (key==='cli') {
    if (currentTask) return;
    if (!cliStates.some(item=>item.id===value && item.usable && item.auth==='ready')) return;
    selectionRevision++;
    chat.setSettings({cli:value,model:'',effort:''});
    closeHistoryMenus(); renderHistory();
  } else chat.setSettings({[key]:value,...(key==='model' ? {effort:''} : {})});
  draftChanged();
};
async function taskAction(action) {
  const id=currentTask?.id, revision=selectionRevision;
  if (!id) return;
  const task=await api(`/tasks/${id}/${action}`,{});
  if (revision===selectionRevision && currentTask?.id===id) updateTask(task);
  await refresh();
}
chat.onStop = async () => {
  if (activeSend?.revision===selectionRevision) {activeSend.cancelled=true;return;}
  try {await taskAction('cancel');}catch(error){notice(error);throw error;}
};
$('new-task').addEventListener('click', () => {
  closeHistoryMenus();
  selectionRevision++; stream?.close(); currentTask = null;
  chat.setConversation(null);chat.setInput('');chat.setSettings({model:'',effort:'',operation:'auto'});
  cursor=0; $('events').textContent=''; $('conversation').textContent='新对话'; $('task-state').textContent='新对话';
  $('restore-current').hidden=true;
  showArchived=false;renderHistory();
  $('cancel').disabled=true; $('commit-retry').hidden=true;
  $('chat-shell').classList.remove('sidebar-open','artifacts-open');
  $('toggle-conversations').setAttribute('aria-expanded','false');$('toggle-artifacts').setAttribute('aria-expanded','false');
  draftChanged();
});
$('show-active').addEventListener('click', () => {closeHistoryMenus();showArchived=false; renderHistory();});
$('show-archived').addEventListener('click', () => {closeHistoryMenus();showArchived=true; renderHistory();});
$('tasks').addEventListener('keydown', event => {
  if (event.key === 'Escape') {event.preventDefault();closeHistoryMenus(true);}
  if ((event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('task-more') && !openHistoryMenu) {
    event.preventDefault();openTaskMenu(event.target.closest('.task-row'));
  }
});
document.addEventListener('pointerdown', event => {if (!event.target.closest('.task-menu, .task-more')) closeHistoryMenus();});
window.addEventListener('resize', () => closeHistoryMenus());
document.addEventListener('scroll', () => {if (openHistoryMenu) closeHistoryMenus();}, true);
$('undo-archive').addEventListener('click', wrap(async () => {if (lastArchived) await setTaskArchived(lastArchived, false);}));
$('restore-current').addEventListener('click', wrap(async () => {if (currentTask) await setTaskArchived(currentTask.id, false);}));
$('toggle-conversations').addEventListener('click',()=>{$('chat-shell').classList.remove('artifacts-open');$('toggle-artifacts').setAttribute('aria-expanded','false');const open=$('chat-shell').classList.toggle('sidebar-open');$('toggle-conversations').setAttribute('aria-expanded',String(open));});
$('toggle-artifacts').addEventListener('click',()=>{ $('chat-shell').classList.remove('sidebar-open');$('toggle-conversations').setAttribute('aria-expanded','false');const open=$('chat-shell').classList.toggle('artifacts-open');$('toggle-artifacts').setAttribute('aria-expanded',String(open)); });
$('close-artifacts').addEventListener('click',()=>{ $('chat-shell').classList.remove('artifacts-open');$('toggle-artifacts').setAttribute('aria-expanded','false'); });
window.addEventListener('jlpt:notice',event=>notice(event.detail));
$('cancel').addEventListener('click', wrap(() => taskAction('cancel')));
$('commit-retry').addEventListener('click', wrap(() => taskAction('commit')));
$('refresh').addEventListener('click', wrap(refresh));
$('refresh-diagnostics').addEventListener('click', wrap(async () => {
  showCliStates(cliStates.map(item=>({...item,usable:false,auth:'checking',checking:true,detail:'正在验证真实对话…'})));
  clearTimeout(cliPoll);
  try {showCliStates(await api('/clis/refresh',{}));await refresh();}
  catch(error) {
    try {await loadCliStates();}
    catch {checkingClis=false;$('refresh-diagnostics').disabled=false;$('diagnostic-state').textContent='读取验证状态失败，请重试';}
    throw error;
  }
}));
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
  await loadCliStates();
  await refresh();
} catch(error) { notice(error); }
setInterval(() => refresh().catch(notice), 10000);
