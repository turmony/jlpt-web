import {renderCoreMarkdown} from '/grammar/core-markdown.mjs';
import {labelCoreFunctions} from '/grammar/core-content.mjs';
import {mountPaperReview, mountPaperSheet} from '/paper-sheet.mjs';

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

// The change itself was recorded; only the review records could not be rebuilt.
function recordsNotice(result) {
  if (result?.records_error) notice(`已记录，但复习记录生成失败：${result.records_error}`);
}

function notice(error) {
  $('notice').textContent = error ? error.message || String(error) : '';
  $('notice').hidden = !error;
  if (error) $('notice').scrollIntoView({behavior: 'smooth', block: 'center'});
}

function h(tag, props = {}, ...children) {
  const {dataset, ...rest} = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
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
  refreshSpaced();
  today = await api('/today');
  renderDaily();
  renderProgress();
  renderStatus();
}

// ---- Review: due units are preselected; extra units come in as ranges; one submit ----
let spaced = null;
const picked = new Set();
// Each range is {from, to}: unit ids chosen in its two selects.
let ranges = [];

async function refreshSpaced() {
  try {
    spaced = await api('/spaced');
  } catch (error) {
    spaced = null;
    $('spaced-summary').textContent = `复习清单读取失败：${error.message || error}`;
    $('spaced-due').replaceChildren();
    $('spaced-extra').hidden = true;
    $('spaced-bar').hidden = true;
    return;
  }
  picked.clear();
  for (const entry of spaced.due) picked.add(entry.unit);
  ranges = [];
  renderSpaced();
}

const unitLabel = id => spaced.titles[id] ? `${id} ${spaced.titles[id]}` : id;

// Selected due units plus every unit from each range's two ends (any order) and between them in `eligible`.
function chosenUnits() {
  const chosen = new Set(picked);
  for (const range of ranges) {
    const ends = [spaced.eligible.indexOf(range.from), spaced.eligible.indexOf(range.to)].sort((a, b) => a - b);
    if (ends[0] < 0) continue;
    for (const id of spaced.eligible.slice(ends[0], ends[1] + 1)) chosen.add(id);
  }
  return [...chosen];
}

function updateSpacedCount() {
  const total = chosenUnits().length;
  $('spaced-count').textContent = `本次共 ${total} 个单元`;
  $('spaced-submit').disabled = !total;
}

function rangeRow(range) {
  const select = (className, key) => {
    const node = h('select', {className}, ...spaced.eligible.map(id => h('option', {value: id, textContent: unitLabel(id), selected: id === range[key]})));
    node.setAttribute('aria-label', key === 'from' ? '从' : '到');
    node.addEventListener('change', () => { range[key] = node.value; updateSpacedCount(); });
    return node;
  };
  const remove = h('button', {type: 'button', className: 'range-remove', textContent: '删除', onclick: () => {
    ranges = ranges.filter(item => item !== range);
    renderSpaced();
  }});
  return h('div', {className: 'spaced-range'}, select('range-from', 'from'), '到', select('range-to', 'to'), remove);
}

function renderSpaced() {
  const {due, done_today: done, eligible} = spaced;
  $('spaced-summary').textContent = due.length ? `今天到期 ${due.length} 个单元：点掉没复习的，再确认提交`
    : done.length ? '今日到期的已复习完' : '今天没有到期的复习';
  $('spaced-due').replaceChildren(...due.map(entry => {
    const title = spaced.titles[entry.unit];
    const late = entry.overdue ? `逾期 ${entry.overdue} 天 · ` : '';
    const button = h('button', {type: 'button', className: 'spaced-unit', onclick: () => {
      picked.has(entry.unit) ? picked.delete(entry.unit) : picked.add(entry.unit);
      button.setAttribute('aria-pressed', String(picked.has(entry.unit)));
      updateSpacedCount();
    }}, entry.unit, h('small', {textContent: title || entry.unit}), h('span', {className: 'spaced-forms', textContent: late + entry.forms.join('、')}));
    button.setAttribute('aria-pressed', String(picked.has(entry.unit)));
    return button;
  }));
  $('spaced-extra').hidden = !eligible.length;
  $('spaced-ranges').replaceChildren(...ranges.map(rangeRow));
  $('spaced-bar').hidden = !due.length && !eligible.length;
  updateSpacedCount();
  $('spaced-done').textContent = `今日已复习：${done.join('、')}`;
  $('spaced-done').hidden = !done.length;
}

$('spaced-add-range').addEventListener('click', () => {
  if (!spaced?.eligible.length) return;
  const last = spaced.eligible.at(-1);
  ranges.push({from: last, to: last});
  renderSpaced();
});

$('spaced-submit').addEventListener('click', async () => {
  const button = $('spaced-submit');
  button.disabled = true;
  notice(null);
  try {
    const result = await api('/spaced/submit', {units: chosenUnits()});
    spaced = result;
    picked.clear();
    for (const entry of spaced.due) picked.add(entry.unit);
    ranges = [];
    renderSpaced();
    recordsNotice(result);
  } catch (error) {
    notice(error);
    await refreshSpaced();
  }
});

function canStartAhead() {
  const busy = today.directory.some(section => section.children.some(child => child.units.some(unit => unit.status === 'in_progress')));
  return !['review', 'review_not_ready'].includes(today.state) && !busy;
}

// What the learner can do with a unit from the directory or the pager; null when it cannot be opened yet.
// The unit to learn now is `current` (never `prepared`), and it opens only while today's status offers it.
function unitAction(unit, ahead = canStartAhead()) {
  if (unit.status === 'learned') return '查看';
  if (unit.status === 'in_progress') return '继续';
  if (unit.status === 'current') return today.state === 'learn' && today.unit?.id === unit.id ? '开始' : null;
  return unit.status === 'prepared' && ahead ? '提前学' : null;
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

// Opening the directory brings the learner's current unit (else the current stage) into view.
function locateCurrent() {
  const target = document.querySelector('#directory-body li.is-current') || document.querySelector('#directory-body .stage[data-status="current"] summary');
  if (target) target.scrollIntoView({block: 'center'});
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
  // The 7-study-day review cycle is retired when `days_to_review` is null (plan.json `review_cycle: "off"`).
  const cycle = progress.days_to_review > 0 ? `距下次复习还差 ${progress.days_to_review} 个学习日` : '复习已到期';
  $('progress-cycle').textContent = `${cycle} · 已完成复习 ${progress.reviews_done} 次`;
  $('progress-cycle').hidden = progress.days_to_review === null;

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
        h('ul', {className: 'directory-list'}, ...child.units.flatMap(unit => [h('li', {className: unit.id === currentId ? 'is-current' : ''},
          h('span', {className: 'unit-name', textContent: `${unit.id} ${unit.title}`}),
          chip(unit.status),
          unitAction(unit, ahead) ? h('button', {type: 'button', textContent: unitAction(unit, ahead), onclick: () => openUnit(unit.id).catch(notice)}) : null),
          unit.review ? reviewNode(unit.review) : null].filter(Boolean))))));
    details.dataset.status = stage.status;
    return details;
  }));
}

// A review closes each 7-study-day cycle: finished and due ones sit where they happened, and only the next one is projected.
function reviewNode(review) {
  const label = review.status === 'next' ? `下次复习 ${review.id}` : `复习 ${review.id}`;
  const text = {done: '已完成 ✓', due: '已到期，待做', next: `还差 ${review.remaining} 个学习日`}[review.status];
  const node = h('li', {className: 'review-node'},
    h('span', {className: 'unit-name', textContent: label}),
    h('span', {className: 'status-chip', textContent: text}),
    review.status === 'done' ? h('button', {type: 'button', textContent: '查看', onclick: () => openReview(review.id).catch(notice)}) : null);
  node.dataset.status = review.status;
  return node;
}

// ---- Today's new units: this many a day (plan.json `daily_new`), counted from what was actually submitted ----
const DAILY_LABEL = {learned: '今天已完成 ✓', in_progress: '进行中', current: '待学', prepared: '待学', unprepared: '尚未准备'};

function renderDaily() {
  const daily = today.daily;
  $('daily-new').hidden = !daily;
  if (!daily) return;
  const waiting = ['review', 'review_not_ready'].includes(today.state);
  $('daily-summary').textContent = waiting ? '复习已到期：先完成复习，再学新单元'
    : daily.full ? `今天的 ${daily.limit} 个单元已学完`
    : `每天 ${daily.limit} 个 · 今天已交卷 ${daily.done_today} 个，还差 ${daily.limit - daily.done_today} 个`;
  const ahead = canStartAhead();
  $('daily-list').replaceChildren(...daily.slots.map(slot => {
    const action = unitAction(slot, ahead);
    const label = h('span', {className: 'status-chip', textContent: DAILY_LABEL[slot.status] || slot.status});
    label.dataset.status = slot.status;
    return h('li', {},
      h('span', {className: 'unit-name', textContent: `${slot.id} ${slot.title}`}),
      label,
      action ? h('button', {type: 'button', textContent: action === '提前学' ? '开始' : action, onclick: () => openUnit(slot.id).catch(notice)}) : null);
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
  $('spaced-review').hidden = false;
  $('daily-new').hidden = !today?.daily;
  $('unit-view').hidden = true;
  $('review-view').hidden = true;
  $('plan-progress').hidden = false;
  $('status').hidden = false;
  scrollTo({top: 0});
}

function showFlow(id) {
  notice(null);
  $('spaced-review').hidden = true;
  $('daily-new').hidden = true;
  $('plan-progress').hidden = true;
  $('status').hidden = true;
  $('unit-view').hidden = id !== 'unit-view';
  $('review-view').hidden = id !== 'review-view';
  scrollTo({top: 0});
}

// The learning path in directory order: each unit, then the review that closes its cycle.
// Only steps that are ready to open are offered.
function pathSteps() {
  const steps = [];
  const ahead = canStartAhead();
  for (const section of today.directory) for (const child of section.children) for (const unit of child.units) {
    steps.push({kind: 'unit', id: unit.id, label: unit.id, ready: unitAction(unit, ahead) !== null});
    const review = unit.review;
    if (review) steps.push({kind: 'review', id: review.id, label: `复习 ${review.id}`,
      ready: review.status === 'done' || (review.status === 'due' && today.state === 'review' && today.review?.id === review.id)});
  }
  return steps;
}

function openStep(step) {
  return (step.kind === 'unit' ? openUnit : openReview)(step.id).catch(notice);
}

function pager(kind, id) {
  const steps = pathSteps();
  const index = steps.findIndex(step => step.kind === kind && step.id === id);
  const link = (step, text, className) => step && step.ready
    ? h('button', {type: 'button', className: `pager-link ${className}`, textContent: text, onclick: () => openStep(step)})
    : h('span');
  return h('div', {className: 'pager'}, link(steps[index - 1], `← 上一页 ${steps[index - 1]?.label ?? ''}`, 'pager-prev'),
    link(steps[index + 1], `下一页 ${steps[index + 1]?.label ?? ''} →`, 'pager-next'));
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

// ---- A unit: recall → comparison page and member cores → 5 questions → (sentence) → note ----
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
  const compare = compareView(view.compare);
  // Once the comparison page is there, a form jumps to the connection image of its first card on that page.
  // It wears the tint of its comparison row, the same as the core meaning under that image.
  const members = new Set(session.started ? view.cards.map(card => card.id) : []);
  const jump = form => {
    const card = view.recall.items.find(item => item.form === form && members.has(item.card))?.card;
    if (!card) return null;
    return {tint: compareTint(view.compare, form),
      go: () => jumpTo(document.getElementById(`connection-${card}`) || document.getElementById(`card-${card}`))};
  };
  const usages = recallList(view.recall.items, session.started, session.started ? {unit: unit.id, counts: view.forgets || {}} : null, jump);
  const recall = session.started
    ? [usages, compare]
    : [h('p', {className: 'muted', textContent: '先看一遍各语法形式与用法，再进入对比页。'}),
       usages, compare,
       h('div', {className: 'flow-actions'}, h('span'),
         h('button', {className: 'primary', type: 'button', textContent: '进入对比页', onclick: event => startUnit(unit.id, event.currentTarget).catch(notice)}))];
  root.replaceChildren(
    h('div', {className: 'paper-actions'}, backButton()),
    pager('unit', unit.id),
    h('h1', {id: 'unit-title', className: 'paper-title', textContent: `${unit.id} ${unit.title}`}),
    h('p', {className: 'muted', textContent: unit.position.join(' › ')}),
    h('section', {className: 'step'}, h('h2', {textContent: '一、用法总览'}),
      view.overview_note ? h('p', {className: 'overview-note', textContent: view.overview_note}) : null,
      h('p', {textContent: `范围：${scope}（共 ${view.recall.items.length} 项）`}), ...recall));
  if (!session.started) { root.append(pager('unit', unit.id)); return; }

  const page = markdown(view.page, {id: 'unit-page'});
  page.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#card-"]');
    const card = link && document.getElementById(link.getAttribute('href').slice(1));
    if (!card) return;
    event.preventDefault();
    card.open = true;
    card.scrollIntoView({behavior: 'smooth', block: 'start'});
  });
  // Each member's core goes, folded, right under its own connection image (the end of its ### section).
  for (const card of view.cards) {
    const details = h('details', {className: 'member-card', id: `card-${card.id}`},
      h('summary', {textContent: `原卡核心 · ${card.id} ${card.title}`}), markdown(labelCoreFunctions(card.core || '（原卡没有核心一节）')));
    const heading = [...page.querySelectorAll('h3')].find(node => node.querySelector(`a[href="#card-${card.id}"]`));
    if (heading) heading.id = `connection-${card.id}`;
    let next = heading && heading.nextElementSibling;
    while (next && !/^H[1-3]$/.test(next.tagName)) next = next.nextElementSibling;
    // Every member shows its core meaning here: its comparison row when it has one, else the 功能 headings of its core.
    // It jumps back to the card's (first) form in the overview.
    const row = compareRows(view.compare).find(form => form.card === card.id);
    const forms = row ? [row.form] : [...new Set(view.recall.items.filter(item => item.card === card.id).map(item => item.form))];
    const group = [...root.querySelectorAll('.recall-group')].find(group => group.dataset.form === forms[0]);
    const meaning = coreMeaning(forms, row ? [row.meaning] : cardMeanings(card), form => compareTint(view.compare, form),
      group && (() => jumpTo(group)));
    if (heading) heading.parentNode.insertBefore(details, next); else page.append(details);
    details.after(meaning);
  }
  root.append(h('section', {className: 'step'}, h('h2', {textContent: '二、对比页'}), page));

  if (session.submitted) {
    root.append(h('section', {className: 'step'}, h('h2', {textContent: '三、试题回顾'}), paperReview(view)));
    const ungraded = today.pending_grading.some(item => item.id === unit.id);
    root.append(h('section', {className: 'step'}, h('h2', {textContent: ungraded ? '已交卷，待判分' : '已交卷'}),
      view.sentence ? h('p', {className: 'locked-text', textContent: view.sentence.text || ''}) : null,
      view.note ? h('p', {className: 'locked-text', textContent: view.note}) : null),
      pager('unit', unit.id));
    return;
  }

  const container = h('div', {id: 'unit-paper', className: 'markdown paper-markdown'});
  root.append(h('section', {className: 'step'}, h('h2', {textContent: `三、选择题（${view.paper.numbers.length} 题）`}), container));
  const counter = answeredLine(view.paper.numbers.length);
  const sheet = mountPaperSheet({container, paper: view.paper, initialAnswers: view.paper.answers, draftKey: prefix + 'paper', onChange: () => counter.update(sheet.answeredCount())});
  counter.update(sheet.answeredCount());

  const submit = h('button', {className: 'primary', type: 'button', textContent: '交卷'});
  // Units prepared from 2026-10-21 on carry no sentence prompt: their last step is just the note.
  const sentence = view.sentence ? [
    h('p', {className: 'sentence-prompt', textContent: view.sentence.prompt}),
    h('label', {htmlFor: 'sentence', textContent: '造句'}), drafted(h('textarea', {id: 'sentence', rows: 3}), prefix + 'sentence')] : [];
  root.append(h('section', {className: 'step'}, h('h2', {textContent: view.sentence ? '四、造句' : '四、备注'}), ...sentence,
    h('label', {htmlFor: 'note', textContent: '备注（可选）'}), drafted(h('textarea', {id: 'note', rows: 3, placeholder: '可写发现的对比页问题'}), prefix + 'note'),
    h('div', {className: 'flow-actions'}, counter.line, submit)), pager('unit', unit.id));
  submit.addEventListener('click', async () => {
    if (!confirmSubmit(view.paper.numbers.length - sheet.answeredCount())) return;
    submit.disabled = true;
    try {
      const state = await api(`/units/${encodeURIComponent(unit.id)}/submit`, {answers: sheet.getAnswers(), ...(view.sentence ? {sentence: $('sentence').value} : {}), note: $('note').value});
      await afterSubmit(state, prefix);
    } catch (error) {
      submit.disabled = false;
      notice(error);
    }
  });
}

// A submitted paper with the correct options, the learner's choices and the explanations.
function paperReview(view) {
  const container = h('div', {className: 'markdown paper-markdown'});
  mountPaperReview({container, paper: view.paper, key: view.key || []});
  return container;
}

// A sliding switch: thumb right = shown, left = hidden, centred = mixed (only the "all" switch).
function usageSwitch(label, onToggle) {
  const state = value => { button.setAttribute('aria-checked', value); };
  const button = h('button', {type: 'button', className: 'recall-switch', onclick: onToggle},
    h('span', {className: 'recall-switch-label', textContent: label}),
    h('span', {className: 'recall-switch-track'}, h('span', {className: 'recall-switch-thumb'})));
  button.setAttribute('role', 'switch');
  return {button, state};
}

// The small label of a jump with its arrow. The word is drawn by CSS, so a form's heading text stays the form alone.
function jumpBadge(label, direction) {
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrow.setAttribute('viewBox', '0 0 16 16');
  arrow.innerHTML = direction === 'up' ? '<path d="M8 12.5v-9M4 7.5l4-4 4 4"/>' : '<path d="M8 3.5v9M4 8.5l4 4 4-4"/>';
  const badge = h('span', {className: 'jump-badge', dataset: {label}}, arrow);
  badge.setAttribute('aria-hidden', 'true');
  return badge;
}

// Scrolls a jump target to the top and flashes it, so the eye finds it after the move.
function jumpTo(target) {
  if (!target) return;
  target.scrollIntoView({behavior: calm.matches ? 'auto' : 'smooth', block: 'start'});
  target.classList.remove('is-jumped');
  void target.offsetWidth;
  target.classList.add('is-jumped');
  target.addEventListener('animationend', () => target.classList.remove('is-jumped'), {once: true});
}

// Usage rows, grouped under their grammar form. A unit not yet started shows them (first look); once it has been
// entered they start hidden, as bars with no text in the page, so the learner recalls each usage before checking.
// Nothing is stored about the switches. `jump(form)` gives the form's jump to its connection image ({go, tint}), if any.
const MASK_WIDTHS = ['86%', '58%', '72%'];
function recallList(items, hidden, forgets, jump) {
  const list = h('div', {id: 'recall-list', className: 'recall-list'});
  const groups = [];
  const all = usageSwitch('全部', () => {
    const hideAll = groups.every(group => !group.hidden);
    groups.forEach(group => group.set(hideAll, true));
    sync();
  });
  const sync = () => {
    const shown = groups.filter(group => !group.hidden).length;
    all.state(shown === groups.length ? 'true' : shown === 0 ? 'false' : 'mixed');
  };
  items.forEach((item, index) => {
    if (index > 0 && items[index - 1].form === item.form) return;
    const usages = [];
    for (let next = index; next < items.length && items[next].form === item.form; next++) usages.push(items[next].usage);
    const rows = h('ol', {className: 'recall-rows', start: index + 1});
    const group = {hidden: false, set: null};
    const toggle = usageSwitch('用法', () => { group.set(!group.hidden, true); sync(); });
    // Hidden rows carry no usage text, only a bar of a fixed width that says nothing about the real length.
    group.set = (value, animate) => {
      group.hidden = value;
      rows.classList.toggle('is-hidden', value);
      rows.replaceChildren(...usages.map((usage, row) => {
        if (value) {
          const mask = h('span', {className: 'recall-mask'});
          mask.style.setProperty('--mask-width', MASK_WIDTHS[row % MASK_WIDTHS.length]);
          mask.setAttribute('role', 'img');
          mask.setAttribute('aria-label', '用法已隐藏');
          return h('li', {className: 'recall-row'}, mask);
        }
        return h('li', {className: 'recall-row'}, h('span', {className: animate ? 'recall-text is-revealed' : 'recall-text', textContent: usage}));
      }));
      toggle.state(String(!value));
    };
    rows.addEventListener('click', () => { if (group.hidden) { group.set(false, true); sync(); } });
    groups.push(group);
    group.set(hidden, false);
    const forget = forgets && forgetButton(forgets.unit, item.form, forgets.counts[item.form] || 0);
    const link = jump(item.form);
    const form = link ? h('button', {type: 'button', className: 'recall-jump', title: '看接续图', onclick: link.go,
      dataset: link.tint === null ? {} : {tint: link.tint}}, item.form, jumpBadge('接续图', 'down')) : item.form;
    if (link) form.setAttribute('aria-label', `${item.form}：看接续图`);
    list.append(h('section', {className: 'recall-group', dataset: {form: item.form}},
      h('div', {className: 'recall-head'}, h('h3', {className: 'recall-form'}, form),
        h('div', {className: 'recall-tools'}, ...(forget || []), toggle.button)), rows));
  });
  sync();
  return h('div', {className: 'recall'}, h('div', {className: 'recall-bar'}, all.button), list);
}

// A "can't recall" sticker per form of an entered unit: every tap is one timed record on the server, for statistics later.
// No words on it, just a face picked at random; the count sits beside it and each tap throws out a sticker with the new
// count. The tap counts at once (rolled back if the server refuses); the last taps can be taken back while ↩ shows.
const FORGET_FACES = ['💭', '🤯', '🫠', '😵‍💫'];
const FORGET_UNDO_MS = 5000;
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const random = (low, high) => Math.round(low + Math.random() * (high - low));

function forgetButton(unitId, form, initial) {
  const path = `/units/${encodeURIComponent(unitId)}/forget`;
  const count = h('span', {className: 'forget-count'});
  const face = h('span', {className: 'forget-face', textContent: FORGET_FACES[random(0, FORGET_FACES.length - 1)]});
  const burst = h('span', {className: 'forget-burst'});
  for (const part of [count, face, burst]) part.setAttribute('aria-hidden', 'true');
  const button = h('button', {type: 'button', className: 'forget'}, face, burst);
  const undo = h('button', {type: 'button', className: 'forget-undo', textContent: '↩', hidden: true});
  undo.setAttribute('aria-label', '撤销');
  let total = initial, open = 0, timer, pressed;
  const events = [];
  // Requests go one after another, so an undo always takes back the newest record.
  let queue = Promise.resolve();
  const show = animate => {
    const before = count.textContent, after = String(total);
    // Only the digits that changed roll in.
    count.replaceChildren(...[...after].map((digit, at) =>
      h('span', {className: animate && !calm.matches && (before.length !== after.length || before[at] !== digit) ? 'forget-digit is-changing' : 'forget-digit', textContent: digit})));
    count.classList.toggle('is-counted', total > 0);
    button.setAttribute('aria-label', `${form} 想不起来，已记 ${total} 次`);
  };
  const offerUndo = () => {
    clearTimeout(timer);
    undo.hidden = !open;
    if (open) timer = setTimeout(() => { open = 0; undo.hidden = true; }, FORGET_UNDO_MS);
  };
  // The button sinks into its shadow and shows another face; a sticker with the new count flies off.
  const press = () => {
    face.textContent = FORGET_FACES.filter(next => next !== face.textContent)[random(0, FORGET_FACES.length - 2)];
    clearTimeout(pressed);
    button.classList.remove('is-pressed');
    void button.offsetWidth;
    button.classList.add('is-pressed');
    pressed = setTimeout(() => button.classList.remove('is-pressed'), 280);
    if (calm.matches) return;
    const sticker = h('span', {textContent: String(total)});
    sticker.style.setProperty('--burst-x', `${random(-44, 20)}px`);
    sticker.style.setProperty('--burst-y', `${random(-100, -58)}px`);
    sticker.style.setProperty('--burst-rotate', `${random(-14, 14)}deg`);
    sticker.style.setProperty('--burst-size', `${random(14, 18)}px`);
    sticker.addEventListener('animationend', () => sticker.remove(), {once: true});
    burst.append(sticker);
    while (burst.childElementCount > 12) burst.firstElementChild.remove();
  };
  button.addEventListener('click', () => {
    total += 1;
    open += 1;
    show(true);
    press();
    offerUndo();
    queue = queue.then(() => api(path, {form})).then(made => { events.push(made.event); recordsNotice(made); }, error => {
      total -= 1;
      open = Math.max(0, open - 1);
      show(true);
      offerUndo();
      notice(error);
    });
  });
  undo.addEventListener('click', () => {
    if (!open) return;
    total -= 1;
    open -= 1;
    show(true);
    offerUndo();
    queue = queue.then(() => {
      const event = events.pop();
      if (!event) throw new Error('这一次还没记上，无法撤销');
      return api(path + '/undo', {event}).then(recordsNotice, error => { events.push(event); throw error; });
    }).catch(error => {
      total += 1;
      show(true);
      notice(error);
    });
  });
  show(false);
  return [undo, count, button];
}

// The optional comparison of look-alike forms: stacked by item or by form on a phone, a real table when wide.
const COMPARE_ITEMS = [['connection', '接续'], ['meaning', '核心含义'], ['tone', '语气与感情色彩']];

const compareCell = (row, key) => document.createTextNode(row[key]);

const compareChip = (row, index) => h('span', {className: 'compare-chip', textContent: row.form, dataset: {tint: index % 6}});

// `compare` is one table, or a list of titled tables; tints run on across the tables, so no two rows share one early.
const compareTables = compare => !compare ? [] : Array.isArray(compare) ? compare : [compare];
const compareRows = compare => compareTables(compare).flatMap(table => table.forms);

// The tint of a form's comparison row, or null when the form is not in the comparison (it then shows in gold).
function compareTint(compare, form) {
  const index = compareRows(compare).findIndex(row => row.form === form);
  return index >= 0 ? index % 6 : null;
}

// What a card means, from its 功能 headings (“## 功能一：对象”); a card without them falls back to its title's meaning.
const FUNCTION_MEANING = /^ {0,3}#{1,6}[ \t]+功能\s*[一二三四五六七八九十百零〇两\d]*\s*[：:]\s*(.+?)\s*$/gm;
function cardMeanings(card) {
  const meanings = [...(card.core || '').matchAll(FUNCTION_MEANING)].map(match => match[1]);
  return meanings.length ? meanings : [card.title.replace(/^[^：]*：/, '')];
}

// A 核心含义 card under a connection image (the by-item layout of the comparison): the card's forms and what it means,
// one line per function. A click anywhere on it calls `onJump`; without one it is plain text.
function coreMeaning(forms, meanings, tintOf, onJump) {
  const tint = tintOf(forms[0]);
  const chips = forms.map(form => {
    const chipTint = tintOf(form);
    return h('span', {className: 'compare-chip', textContent: form, dataset: chipTint === null ? {} : {tint: chipTint}});
  });
  const value = meanings.length === 1 ? meanings[0] : h('ol', {className: 'meaning-list'}, ...meanings.map(text => h('li', {textContent: text})));
  let back = null;
  if (onJump) {
    back = h('button', {type: 'button', className: 'meaning-jump', title: '回到用法总览'}, jumpBadge('用法总览', 'up'));
    back.setAttribute('aria-label', `核心含义：回到用法总览的 ${forms[0]}`);
  }
  return h('div', {className: `compare-by-item compare-meaning${onJump ? ' is-linked' : ''}`, dataset: tint === null ? {} : {tint}, onclick: onJump},
    h('section', {className: 'compare-block'}, h('h4', {}, h('span', {textContent: '核心含义'}), back),
      h('ul', {}, h('li', {className: chips.length > 1 ? 'compare-line is-stacked' : 'compare-line'}, chips.length ? h('span', {className: 'meaning-forms'}, ...chips) : null,
        h('span', {className: 'compare-value'}, value)))));
}

function compareView(compare) {
  const tables = compareTables(compare);
  if (!tables.length) return null;
  let offset = 0;
  const parts = tables.flatMap(table => {
    const part = compareTable(table, offset);
    offset += table.forms.length;
    return table.title ? [h('h4', {className: 'compare-subtitle', textContent: table.title}), ...part] : part;
  });
  return h('section', {id: 'compare', className: 'compare'}, h('h3', {className: 'compare-title', textContent: '对比表'}), ...parts);
}

// One table: the two phone layouts with their switch, and the wide table. `offset` starts its tints.
function compareTable(compare, offset) {
  const {forms} = compare;
  const chip = (row, index) => compareChip(row, offset + index);
  const byItem = h('div', {className: 'compare-stack compare-by-item'}, ...COMPARE_ITEMS.map(([key, label]) =>
    h('section', {className: 'compare-block'}, h('h4', {textContent: label}),
      h('ul', {}, ...forms.map((row, index) => h('li', {className: 'compare-line'}, chip(row, index), h('span', {className: 'compare-value'}, compareCell(row, key))))))));
  const byForm = h('div', {className: 'compare-stack compare-by-form', hidden: true}, ...forms.map((row, index) =>
    h('section', {className: 'compare-block', dataset: {tint: (offset + index) % 6}}, h('h4', {}, chip(row, index)),
      h('dl', {}, ...COMPARE_ITEMS.flatMap(([key, label]) => [h('dt', {textContent: label}), h('dd', {}, compareCell(row, key))])))));
  const table = h('table', {className: 'compare-table'},
    h('thead', {}, h('tr', {}, h('th', {scope: 'col', textContent: '项目'}), ...forms.map((row, index) => h('th', {scope: 'col'}, chip(row, index))))),
    h('tbody', {}, ...COMPARE_ITEMS.map(([key, label]) =>
      h('tr', {}, h('th', {scope: 'row', textContent: label}), ...forms.map(row => h('td', {}, compareCell(row, key)))))));
  const modes = [['item', '按项目比', byItem], ['form', '按语法看', byForm]];
  const buttons = modes.map(([mode, label]) => h('button', {type: 'button', className: 'compare-mode', textContent: label, dataset: {mode}}));
  const choose = mode => modes.forEach(([name, , view], index) => {
    view.hidden = name !== mode;
    buttons[index].setAttribute('aria-pressed', String(name === mode));
  });
  buttons.forEach((button, index) => button.addEventListener('click', () => choose(modes[index][0])));
  choose('item');
  return [h('div', {className: 'compare-modes'}, ...buttons), byItem, byForm, h('div', {className: 'compare-wide'}, table)];
}

async function startUnit(id, button) {
  button.disabled = true;
  try {
    const view = await api(`/units/${encodeURIComponent(id)}/recall`, {});
    dropDrafts(`review:${id}:recall`); // drafts from the retired 没想到 marks
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
    pager('review', id),
    h('h1', {id: 'review-title', className: 'paper-title', textContent: `复习 ${id}`}),
    h('p', {className: 'muted', textContent: `覆盖：${view.review.covers.join('、')}`}));
  if (view.session.submitted) {
    const ungraded = today.pending_grading.some(item => item.id === id);
    root.append(h('p', {className: 'status-line', textContent: ungraded ? '已交卷，待判分' : '已交卷'}), h('section', {className: 'step'}, h('h2', {textContent: '试题回顾'}), paperReview(view)), pager('review', id));
    return;
  }
  const container = h('div', {id: 'review-paper', className: 'markdown paper-markdown'});
  root.append(container);
  const counter = answeredLine(view.paper.numbers.length);
  const sheet = mountPaperSheet({container, paper: view.paper, initialAnswers: view.paper.answers, draftKey: prefix + 'paper', onChange: () => counter.update(sheet.answeredCount())});
  counter.update(sheet.answeredCount());
  const submit = h('button', {className: 'primary', type: 'button', textContent: '交卷'});
  root.append(h('div', {className: 'flow-actions'}, counter.line, submit), pager('review', id));
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

$('directory').addEventListener('toggle', event => {
  if (event.target.open) requestAnimationFrame(locateCurrent);
});
