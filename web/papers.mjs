import {mountPaperSheet} from '/paper-sheet.mjs';

const $ = id => document.getElementById(id);
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
let sheet;

function updateProgress() {
  $('progress').textContent = `已答 ${sheet.answeredCount()} / ${paper.numbers.length}`;
  $('submit').disabled = sheet.answeredCount() === 0;
}

async function submit() {
  const missing = paper.numbers.length - sheet.answeredCount();
  if (missing && !confirm(`还有 ${missing} 题未作答，仍然提交？未答题会留空。`)) return;
  $('submit').disabled = true;
  try {
    paper = await api(`/papers/${encodeURIComponent(slug)}/answers`, {answers: sheet.getAnswers()});
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
  sheet = mountPaperSheet({container: $('paper-text'), paper, initialAnswers: paper.answers, draftKey: 'papers:draft:' + slug,
    onChange() { updateProgress(); $('submitted').hidden = true; }});
  $('submit-bar').hidden = paper.numbers.length === 0;
  updateProgress();
  $('submit').addEventListener('click', submit);
  $('copy-prompt').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('grade-prompt').textContent); $('copy-prompt').textContent = '已复制'; } catch { notice(new Error('复制失败，请长按选择文字')); }
  });
}

(slug ? showPaper() : showList()).catch(notice);
