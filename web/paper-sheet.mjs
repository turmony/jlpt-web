import {renderCoreMarkdown} from '/grammar/core-markdown.mjs';

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

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

// Renders a paper and turns each numbered question into tappable option blocks with an “不确定” switch.
// Answers are kept as a local draft until the page submits `getAnswers()`.
export function mountPaperSheet({container, paper, initialAnswers = {}, draftKey, onChange = () => {}}) {
  const questions = new Map();

  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(draftKey) || 'null'); } catch { return null; }
  }

  function saveDraft() {
    try { localStorage.setItem(draftKey, JSON.stringify(answers)); } catch {}
  }

  let answers = loadDraft() || Object.fromEntries(Object.entries(initialAnswers).filter(([, item]) => item.answer));

  const answeredCount = () => paper.numbers.filter(number => answers[number]?.answer).length;

  function setAnswer(number, change) {
    answers[number] = {answer: '', uncertain: false, ...answers[number], ...change};
    saveDraft();
    questions.get(number)?.refresh();
    onChange();
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

  renderCoreMarkdown(container, paper.text.split(/\n## 答案填写区/)[0]);
  const numbers = new Set(paper.numbers.map(String));
  for (const heading of container.querySelectorAll('h3, h4')) {
    const number = heading.textContent.match(/^\s*(\d+)\./)?.[1];
    if (!number || !numbers.has(number) || questions.has(number)) continue;
    const question = buildQuestion(number, heading);
    if (question) questions.set(number, question);
  }
  for (const question of questions.values()) question.refresh();

  return {
    // An uncertain mark only means something on an answered question.
    getAnswers: () => Object.fromEntries(Object.entries(answers).map(([number, item]) => [number, {answer: item.answer || '', uncertain: Boolean(item.answer && item.uncertain)}])),
    answeredCount,
  };
}

// Read-only look back at a submitted paper: the correct option, the learner's choice and the explanation.
// `key` lists {number, correct, correct_text, explanation} from the answer file; `paper.answers` holds the learner's choices.
export function mountPaperReview({container, paper, key}) {
  const keys = new Map(key.map(item => [String(item.number), item]));
  const numbers = new Set(paper.numbers.map(String));
  renderCoreMarkdown(container, paper.text.split(/\n## 答案填写区/)[0]);
  for (const heading of container.querySelectorAll('h3, h4')) {
    const number = heading.textContent.match(/^\s*(\d+)\./)?.[1];
    if (!number || !numbers.has(number)) continue;
    const nodes = questionNodes(heading);
    const list = [...nodes].reverse().find(node => node.tagName === 'OL');
    if (!list) continue;
    const info = keys.get(number);
    const mine = paper.answers[number]?.answer || '';
    const uncertain = Boolean(mine && paper.answers[number]?.uncertain);
    const ordering = [heading, ...nodes].some(node => node.textContent.includes('★'));
    const start = Number(list.getAttribute('start') || 1);
    list.classList.add('option-list', 'review-options');
    const tag = (item, text, kind) => {
      const badge = document.createElement('span');
      badge.className = `review-tag ${kind}`;
      badge.textContent = text;
      item.append(badge);
    };
    [...list.children].forEach((item, index) => {
      const value = String(start + index);
      item.classList.add('option-block');
      item.dataset.value = value;
      if (ordering) return;
      if (info?.correct === value) { item.classList.add('is-correct'); tag(item, '正确答案', 'correct'); }
      if (mine === value) { item.classList.add('is-mine'); tag(item, '我的选择', 'mine'); }
    });

    const verdict = document.createElement('span');
    verdict.className = 'review-verdict';
    if (!mine) { verdict.textContent = '未作答'; verdict.dataset.result = 'blank'; }
    else if (!ordering && info?.correct) {
      const right = mine === info.correct;
      verdict.textContent = right ? '答对' : '答错';
      verdict.dataset.result = right ? 'right' : 'wrong';
    }
    if (uncertain) verdict.textContent = [verdict.textContent, '不确定'].filter(Boolean).join(' · ');
    if (verdict.textContent) heading.append(verdict);
    heading.classList.add('question-heading');

    let last = list;
    if (ordering) {
      const line = document.createElement('p');
      line.className = 'order-line';
      line.textContent = `我的语序：${mine ? mine.split('').join(' → ') : '未作答'}` + (info?.correct ? `　★处正确项：${info.correct}（${info.correct_text}）` : '');
      list.after(line);
      last = line;
    }
    if (info?.explanation) {
      const details = document.createElement('details');
      details.className = 'review-explain';
      const summary = document.createElement('summary');
      summary.textContent = '解析';
      const body = document.createElement('div');
      renderCoreMarkdown(body, info.explanation);
      details.append(summary, body);
      last.after(details);
    }
  }
}
