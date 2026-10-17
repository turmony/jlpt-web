import {renderCoreMarkdown} from '/grammar/core-markdown.mjs';
import {mountPaperSheet} from '/paper-sheet.mjs';

// Shows where the learner is in the grammar-network plan and runs one unit or review at a time.
// Grading and preparation happen elsewhere; this page only shows status text for them.
const $ = id => document.getElementById(id);
const STATUS = {learned: '已学', in_progress: '进行中', current: '当前', prepared: '已准备', unprepared: '未准备'};

async function api(path, data) {
  const response = await fetch('/api/review' + path, data === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
  if (response.status === 401) { location.replace('/login.html'); throw new Error('请重新登录'); }
  let value;
  try { value = await response.json(); } catch { throw new Error(`请求失败（${response.status}）`); }
  if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
  return value;
}

function notice(error) {
  $('notice').textContent = error ? error.message || String(error) : '';
  $('notice').hidden = !error;
  if (error) $('notice').scrollIntoView({behavior: 'smooth', block: 'center'});
}

function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

function markdown(source, props = {}) {
  const article = h('article', {className: 'markdown', ...props});
  renderCoreMarkdown(article, source);
  return article;
}

// Unsent text survives a reload in this browser only.
function drafted(textarea, key) {
  try { textarea.value = localStorage.getItem(key) || ''; } catch {}
  textarea.addEventListener('input', () => { try { localStorage.setItem(key, textarea.value); } catch {} });
  return textarea;
}

function dropDrafts(prefix) {
  try { for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key); } catch {}
}

// ---- Overview: progress, status and the whole directory ----
let today;

async function refresh() {
  today = await api('/today');
  renderProgress();
  renderStatus();
}

function canStartAhead() {
  const busy = today.directory.some(section => section.children.some(child => child.units.some(unit => unit.status === 'in_progress')));
  return !['review', 'review_not_ready'].includes(today.state) && !busy;
}

const STAGE = {pending: '待整理（不计入总数）', done: '已完成 ✓', current: '当前阶段', partial: '进行中', todo: '未开始', empty: '暂无单元'};

// Stages in learning order (基础体系表, then the top categories), with the unit the learner is on now:
// the unit in today's status, or else the first unit not yet learned.
function stages() {
  const list = today.directory.map(section => {
    const units = section.children.flatMap(child => child.units);
    return {section, units, learned: units.filter(unit => unit.status === 'learned').length};
  });
  const currentId = today.unit?.id ?? list.flatMap(stage => stage.units).find(unit => unit.status !== 'learned')?.id;
  for (const stage of list) {
    stage.currentIndex = stage.units.findIndex(unit => unit.id === currentId);
    stage.status = stage.section.pending ? 'pending' : !stage.units.length ? 'empty'
      : stage.learned === stage.units.length ? 'done' : stage.currentIndex >= 0 ? 'current' : stage.learned ? 'partial' : 'todo';
  }
  return {list, currentId};
}

function fill(share, className) {
  const bar = h('span', {className});
  bar.style.width = `${share * 100}%`;
  if (className === 'stage-mini-fill') {
    const track = h('span', {className: 'stage-mini'}, bar);
    track.setAttribute('aria-hidden', 'true');
    return track;
  }
  return bar;
}

function renderStageBar(list) {
  const progress = today.progress;
  const current = list.find(stage => stage.status === 'current');
  const bar = $('progress-bar');
  bar.setAttribute('aria-valuemax', String(progress.total));
  bar.setAttribute('aria-valuenow', String(progress.learned));
  bar.setAttribute('aria-valuetext', `已学 ${progress.learned} / ${progress.total}` + (current ? `，当前阶段：${current.section.title}` : ''));
  const counted = list.filter(stage => stage.units.length && !stage.section.pending);
  bar.replaceChildren(...counted.map(stage => {
    const segment = h('div', {className: 'stage-segment', title: `${stage.section.title} ${stage.learned}/${stage.units.length}`},
      fill(stage.learned / stage.units.length, 'stage-fill'));
    segment.style.flexGrow = String(stage.units.length);
    segment.dataset.status = stage.status;
    if (stage.currentIndex >= 0) {
      const marker = h('span', {className: 'stage-marker'});
      marker.style.left = `${(stage.currentIndex + 0.5) / stage.units.length * 100}%`;
      segment.append(marker);
    }
    return segment;
  }));
  // The legend names the segments in order, so the milestones are readable without opening the directory.
  $('stage-legend').replaceChildren(...counted.map(stage => {
    const item = h('span', {textContent: `${stage.status === 'done' ? '✓ ' : ''}${stage.section.title} ${stage.learned}/${stage.units.length}`});
    item.dataset.status = stage.status;
    return item;
  }));
  const next = list.find(stage => !stage.section.pending && stage.learned < stage.units.length);
  $('next-milestone').textContent = next ? `下一个节点：学完${next.section.title}（还差 ${next.units.length - next.learned} 个单元）`
    : progress.total ? '已提交的阶段已全部学完' : '';
}

function renderProgress() {
  const progress = today.progress;
  const {list, currentId} = stages();
  $('progress-summary').textContent = `第 ${today.round} 轮 · 已学 ${progress.learned} / ${progress.total}`;
  renderStageBar(list);
  $('progress-segments').textContent = `体系表单元 ${progress.system.learned}/${progress.system.total} · 功能小组 ${progress.group.learned}/${progress.group.total}`;
  const position = today.unit ? today.unit.position.join(' › ') : today.review ? `复习 ${today.review.id}` : '';
  $('progress-position').textContent = '当前位置：' + position;
  $('progress-position').hidden = !position;
  const cycle = progress.days_to_review > 0 ? `距下次复习还差 ${progress.days_to_review} 个学习日` : '复习已到期';
  $('progress-cycle').textContent = `${cycle} · 已完成复习 ${progress.reviews_done} 次`;

  const ahead = canStartAhead();
  $('directory-body').replaceChildren(...list.map(stage => {
    const {section} = stage;
    const counted = !section.pending && stage.units.length > 0;
    const details = h('details', {className: 'stage', open: stage.status === 'current'},
      h('summary', {},
        h('span', {className: 'stage-name', textContent: section.title}),
        counted ? h('span', {className: 'stage-count', textContent: `${stage.learned}/${stage.units.length}`}) : null,
        counted ? fill(stage.learned / stage.units.length, 'stage-mini-fill') : null,
        h('span', {className: 'stage-status', textContent: STAGE[stage.status]})),
      ...section.children.map(child => h('div', {className: 'directory-group'},
        h('h4', {}, child.mid ?? `${child.id} ${child.title}`),
        h('ul', {className: 'directory-list'}, ...child.units.map(unit => h('li', {className: unit.id === currentId ? 'is-current' : ''},
          h('span', {className: 'unit-name', textContent: `${unit.id} ${unit.title}`}),
          chip(unit.status),
          unit.status === 'prepared' && ahead ? h('button', {type: 'button', textContent: '提前学', onclick: () => openUnit(unit.id).catch(notice)}) : null))))));
    details.dataset.status = stage.status;
    return details;
  }));
}

function chip(status) {
  const node = h('span', {className: 'status-chip', textContent: STATUS[status] || status});
  node.dataset.status = status;
  return node;
}

function renderStatus() {
  const lines = [];
  let action = null;
  const {state, unit, review} = today;
  if (state === 'learn') {
    lines.push(`第 ${today.round} 轮 · 第 ${today.progress.study_day + 1} 个学习日 · ${unit.id} ${unit.title}`);
    action = [unit.resume ? '继续' : '开始', () => openUnit(unit.id)];
  } else if (state === 'not_prepared') {
    lines.push(`下一项（${unit.id} ${unit.title}）尚未准备`);
  } else if (state === 'review') {
    lines.push(`已累计 ${review.covers.length} 个学习日 → 复习（覆盖 ${review.covers.join('、')}）`);
    action = ['开始复习', () => openReview(review.id)];
  } else if (state === 'review_not_ready') {
    lines.push('复习已到期，复习卷尚未准备');
    if (review.ungraded.length) lines.push(`尚未判分：${review.ungraded.join('、')}`);
  } else if (state === 'round_complete') {
    lines.push(`第 ${today.round} 轮已全部完成`);
  } else if (state === 'awaiting_catalog') {
    lines.push(today.reason === 'empty' ? '分组总表尚未提交' : '已提交的单元已全部学完，下一批分组待整理');
  }
  if (today.pending_grading.length) lines.push(`已交卷，待判分：${today.pending_grading.map(item => item.id).join('、')}`);
  $('status').replaceChildren(...[
    h('h1', {className: 'status-title', textContent: '今日安排'}),
    ...lines.map((line, index) => h('p', {className: index ? 'status-note' : 'status-line', textContent: line})),
    action ? h('button', {className: 'primary', type: 'button', textContent: action[0], onclick: () => action[1]().catch(notice)}) : null,
  ].filter(Boolean));
}

function showOverview() {
  $('unit-view').hidden = true;
  $('review-view').hidden = true;
  $('status').hidden = false;
  scrollTo({top: 0});
}

function showFlow(id) {
  notice(null);
  $('status').hidden = true;
  $('unit-view').hidden = id !== 'unit-view';
  $('review-view').hidden = id !== 'review-view';
  scrollTo({top: 0});
}

function backButton() {
  return h('button', {type: 'button', className: 'back-link', textContent: '← 今日安排', onclick: showOverview});
}

function answeredLine(total) {
  const line = h('span', {className: 'muted'});
  line.setAttribute('role', 'status');
  const update = count => { line.textContent = `已答 ${count} / ${total}`; };
  update(0);
  return {line, update};
}

function confirmSubmit(missing) {
  return confirm((missing ? `还有 ${missing} 题未作答，未答题会留空。` : '') + '交卷后作答不能再修改，确定交卷？');
}

async function afterSubmit(state, prefix) {
  dropDrafts(prefix);
  today = state;
  renderProgress();
  renderStatus();
  showOverview();
}

// ---- A unit: recall → comparison page and member cores → 5 questions → sentence ----
async function openUnit(id) {
  const view = await api(`/units/${encodeURIComponent(id)}`);
  showFlow('unit-view');
  renderUnit(view);
}

function renderUnit(view) {
  const {unit, session} = view;
  const prefix = `review:${unit.id}:`;
  const root = $('unit-view');
  const scope = unit.position.slice(1).join(' › ');
  const recall = session.started
    ? [h('p', {className: 'locked-text', id: 'recall-text', textContent: view.recall}), h('p', {className: 'muted', textContent: `已锁定 · ${session.locked_at.slice(0, 16).replace('T', ' ')}`})]
    : [h('label', {htmlFor: 'recall', textContent: '凭记忆写出成员语法、意思与接续'}),
       drafted(h('textarea', {id: 'recall', rows: 6}), prefix + 'recall'),
       h('p', {className: 'muted', textContent: '锁定后不能修改，随后显示对比页与题目。'}),
       h('button', {className: 'primary', type: 'button', textContent: '锁定回忆', onclick: event => lockRecall(unit.id, event.currentTarget).catch(notice)})];
  root.replaceChildren(
    h('div', {className: 'paper-actions'}, backButton()),
    h('h1', {id: 'unit-title', className: 'paper-title', textContent: `${unit.id} ${unit.title}`}),
    h('p', {className: 'muted', textContent: unit.position.join(' › ')}),
    h('section', {className: 'step'}, h('h2', {textContent: '一、回忆'}), h('p', {textContent: `范围：${scope}`}), ...recall));
  if (!session.started) return;

  const page = markdown(view.page, {id: 'unit-page'});
  page.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#card-"]');
    const card = link && document.getElementById(link.getAttribute('href').slice(1));
    if (!card) return;
    event.preventDefault();
    card.open = true;
    card.scrollIntoView({behavior: 'smooth', block: 'start'});
  });
  const cards = view.cards.map(card => h('details', {className: 'member-card', id: `card-${card.id}`},
    h('summary', {textContent: `${card.id} ${card.title}`}), markdown(card.core || '（原卡没有核心一节）')));
  root.append(h('section', {className: 'step'}, h('h2', {textContent: '二、对比页'}), page,
    h('h3', {className: 'cards-title', textContent: '成员原卡核心'}), ...cards));

  if (session.submitted) {
    root.append(h('section', {className: 'step'}, h('h2', {textContent: '已交卷，待判分'}),
      h('p', {className: 'locked-text', textContent: view.sentence.text || ''}),
      view.note ? h('p', {className: 'locked-text', textContent: view.note}) : null));
    return;
  }

  const container = h('div', {id: 'unit-paper', className: 'markdown paper-markdown'});
  root.append(h('section', {className: 'step'}, h('h2', {textContent: `三、选择题（${view.paper.numbers.length} 题）`}), container));
  const counter = answeredLine(view.paper.numbers.length);
  const sheet = mountPaperSheet({container, paper: view.paper, initialAnswers: view.paper.answers, draftKey: prefix + 'paper', onChange: () => counter.update(sheet.answeredCount())});
  counter.update(sheet.answeredCount());

  const submit = h('button', {className: 'primary', type: 'button', textContent: '交卷'});
  root.append(h('section', {className: 'step'}, h('h2', {textContent: '四、造句'}),
    h('p', {className: 'sentence-prompt', textContent: view.sentence.prompt}),
    h('label', {htmlFor: 'sentence', textContent: '造句'}), drafted(h('textarea', {id: 'sentence', rows: 3}), prefix + 'sentence'),
    h('label', {htmlFor: 'note', textContent: '备注（可选）'}), drafted(h('textarea', {id: 'note', rows: 3, placeholder: '可写发现的对比页问题'}), prefix + 'note'),
    h('div', {className: 'flow-actions'}, counter.line, submit)));
  submit.addEventListener('click', async () => {
    if (!confirmSubmit(view.paper.numbers.length - sheet.answeredCount())) return;
    submit.disabled = true;
    try {
      const state = await api(`/units/${encodeURIComponent(unit.id)}/submit`, {answers: sheet.getAnswers(), sentence: $('sentence').value, note: $('note').value});
      await afterSubmit(state, prefix);
    } catch (error) {
      submit.disabled = false;
      notice(error);
    }
  });
}

async function lockRecall(id, button) {
  button.disabled = true;
  try {
    const view = await api(`/units/${encodeURIComponent(id)}/recall`, {text: $('recall').value});
    dropDrafts(`review:${id}:recall`);
    renderUnit(view);
  } catch (error) {
    button.disabled = false;
    throw error;
  }
  refresh().catch(notice);
}

// ---- A review: the 12-question paper ----
async function openReview(id) {
  const view = await api(`/reviews/${encodeURIComponent(id)}`);
  showFlow('review-view');
  const prefix = `review:${id}:`;
  const root = $('review-view');
  root.replaceChildren(
    h('div', {className: 'paper-actions'}, backButton()),
    h('h1', {id: 'review-title', className: 'paper-title', textContent: `复习 ${id}`}),
    h('p', {className: 'muted', textContent: `覆盖：${view.review.covers.join('、')}`}));
  if (view.session.submitted) {
    root.append(h('p', {className: 'status-line', textContent: '已交卷，待判分'}));
    return;
  }
  const container = h('div', {id: 'review-paper', className: 'markdown paper-markdown'});
  root.append(container);
  const counter = answeredLine(view.paper.numbers.length);
  const sheet = mountPaperSheet({container, paper: view.paper, initialAnswers: view.paper.answers, draftKey: prefix + 'paper', onChange: () => counter.update(sheet.answeredCount())});
  counter.update(sheet.answeredCount());
  const submit = h('button', {className: 'primary', type: 'button', textContent: '交卷'});
  root.append(h('div', {className: 'flow-actions'}, counter.line, submit));
  submit.addEventListener('click', async () => {
    if (!confirmSubmit(view.paper.numbers.length - sheet.answeredCount())) return;
    submit.disabled = true;
    try {
      await afterSubmit(await api(`/reviews/${encodeURIComponent(id)}/submit`, {answers: sheet.getAnswers()}), prefix);
    } catch (error) {
      submit.disabled = false;
      notice(error);
    }
  });
}

refresh().catch(notice);
