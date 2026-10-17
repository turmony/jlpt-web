import {renderCoreMarkdown} from '/grammar/core-markdown.mjs';

const $ = id => document.getElementById(id);
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
const slug = new URLSearchParams(location.search).get('p');

async function api(path, data) {
  const response = await fetch('/api/quiz' + path, data === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
  if (response.status === 401) { location.replace('/login.html'); throw new Error('请重新登录'); }
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '请求失败');
  return value;
}

function notice(error) {
  $('notice').textContent = error ? error.message || String(error) : '';
  $('notice').hidden = !error;
}

// ---- List: the 20 most recent papers ----
async function showList() {
  const papers = await api('/papers');
  $('paper-list').replaceChildren(...papers.map(paper => {
    const link = document.createElement('a');
    link.href = '/papers.html?p=' + encodeURIComponent(paper.slug);
    const name = document.createElement('span');
    name.className = 'paper-name';
    const title = document.createElement('strong');
    title.textContent = paper.title;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${paper.date || paper.slug} · ${paper.questions} 题`;
    name.append(title, meta);
    link.append(name);
    if (paper.answered > 0) {
      const chip = document.createElement('span');
      chip.className = 'status-chip';
      chip.textContent = '已提交';
      link.append(chip);
    }
    const item = document.createElement('li');
    item.append(link);
    return item;
  }));
  $('list-empty').hidden = papers.length > 0;
}

// ---- Paper ----
let paper;
let answers = {};
const questions = new Map();
const draftKey = () => 'papers:draft:' + slug;

function saveDraft() {
  try { localStorage.setItem(draftKey(), JSON.stringify(answers)); } catch {}
}

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch { return null; }
}

const answeredCount = () => paper.numbers.filter(number => answers[number]?.answer).length;

function updateProgress() {
  $('progress').textContent = `已答 ${answeredCount()} / ${paper.numbers.length}`;
  $('submit').disabled = answeredCount() === 0;
}

function setAnswer(number, change) {
  answers[number] = {answer: '', uncertain: false, ...answers[number], ...change};
  saveDraft();
  questions.get(number)?.refresh();
  updateProgress();
  $('submitted').hidden = true;
}

// A question's prompt and options run from its heading to the next heading.
function questionNodes(heading) {
  const nodes = [];
  for (let node = heading.nextElementSibling; node && !/^H[1-6]$/.test(node.tagName); node = node.nextElementSibling) nodes.push(node);
  return nodes;
}

function pressable(node, label, onPress) {
  node.setAttribute('role', 'button');
  node.setAttribute('tabindex', '0');
  node.setAttribute('aria-label', label);
  node.addEventListener('click', onPress);
  node.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPress(); }
  });
}

function buildQuestion(number, heading) {
  const nodes = questionNodes(heading);
  const list = [...nodes].reverse().find(node => node.tagName === 'OL');
  if (!list) return null;
  const ordering = [heading, ...nodes].some(node => node.textContent.includes('★'));
  const start = Number(list.getAttribute('start') || 1);
  list.classList.add('option-list');
  const options = [...list.children].map((item, index) => {
    const value = String(start + index);
    item.classList.add('option-block');
    item.dataset.value = value;
    const badge = document.createElement('span');
    badge.className = 'order-badge';
    badge.setAttribute('aria-hidden', 'true');
    if (ordering) item.append(badge);
    pressable(item, `第 ${number} 题选项 ${value}`, () => {
      const current = answers[number]?.answer || '';
      if (!ordering) return setAnswer(number, {answer: current === value ? '' : value});
      // Ordering: tap pieces in sentence order; tapping a placed piece removes it.
      setAnswer(number, {answer: current.includes(value) ? current.replace(value, '') : current + value});
    });
    return {item, value, badge};
  });

  heading.classList.add('question-heading');
  const uncertain = document.createElement('button');
  uncertain.type = 'button';
  uncertain.className = 'uncertain-switch';
  uncertain.textContent = '不确定';
  uncertain.addEventListener('click', () => setAnswer(number, {uncertain: !answers[number]?.uncertain}));
  heading.append(uncertain);

  let sequence;
  if (ordering) {
    sequence = document.createElement('p');
    sequence.className = 'order-line';
    list.after(sequence);
  }

  return {refresh() {
    const answer = answers[number]?.answer || '';
    for (const {item, value, badge} of options) {
      const position = ordering ? answer.indexOf(value) : answer === value ? 0 : -1;
      item.setAttribute('aria-pressed', String(position >= 0));
      badge.textContent = position >= 0 ? CIRCLED[position] || String(position + 1) : '';
    }
    if (sequence) sequence.textContent = answer ? '语序：' + answer.split('').join(' → ') : '按句子顺序依次点选';
    uncertain.setAttribute('aria-pressed', String(Boolean(answers[number]?.uncertain)));
  }};
}

async function submit() {
  const missing = paper.numbers.length - answeredCount();
  if (missing && !confirm(`还有 ${missing} 题未作答，仍然提交？未答题会留空。`)) return;
  $('submit').disabled = true;
  try {
    // An uncertain mark only means something on an answered question.
    const sheet = Object.fromEntries(Object.entries(answers).map(([number, item]) => [number, {answer: item.answer || '', uncertain: Boolean(item.answer && item.uncertain)}]));
    paper = await api(`/papers/${encodeURIComponent(slug)}/answers`, {answers: sheet});
    notice(null);
    $('grade-prompt').textContent = `用 quiz-grade 判卷：jlpt-notes/quizzes/papers/${slug}.md（答案已写在答案填写区）`;
    $('copy-prompt').textContent = '复制';
    $('submitted').hidden = false;
    $('submitted').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (error) {
    notice(error);
    $('notice').scrollIntoView({behavior: 'smooth', block: 'center'});
  } finally {
    updateProgress();
  }
}

async function showPaper() {
  $('list-view').hidden = true;
  $('paper-view').hidden = false;
  paper = await api('/papers/' + encodeURIComponent(slug));
  document.title = paper.title;
  $('paper-title').textContent = paper.title;
  renderCoreMarkdown($('paper-text'), paper.text.split(/\n## 答案填写区/)[0]);
  answers = loadDraft() || Object.fromEntries(Object.entries(paper.answers).filter(([, item]) => item.answer));
  const numbers = new Set(paper.numbers.map(String));
  for (const heading of $('paper-text').querySelectorAll('h3, h4')) {
    const number = heading.textContent.match(/^\s*(\d+)\./)?.[1];
    if (!number || !numbers.has(number) || questions.has(number)) continue;
    const question = buildQuestion(number, heading);
    if (question) questions.set(number, question);
  }
  for (const question of questions.values()) question.refresh();
  $('submit-bar').hidden = paper.numbers.length === 0;
  updateProgress();
  $('submit').addEventListener('click', submit);
  $('copy-prompt').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('grade-prompt').textContent); $('copy-prompt').textContent = '已复制'; } catch { notice(new Error('复制失败，请长按选择文字')); }
  });
}

(slug ? showPaper() : showList()).catch(notice);
