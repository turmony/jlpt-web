import {errorLine, getJSON, postJSON, NewsFailure} from '/news/api.mjs';

// Page header shared by the list and reader pages: the title on the left, and on the right the
// model every news request uses. Tapping it lists the models qoder2api-hub offers; choosing one
// is saved on the server. Listens: nothing. Fires 'news-model' on `el` with {detail: {model}}.
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function mountHeader(el, {title = '新闻'} = {}) {
  el.classList.add('news-header');
  const heading = node('h1', '', title);
  const button = node('button', 'news-model', '模型：未选择');
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  const panel = node('div', 'news-model-panel');
  panel.hidden = true;
  const list = node('ul', 'news-model-list');
  const problem = node('div', 'news-model-problem');
  panel.append(list, problem);
  el.replaceChildren(heading, button, panel);

  let models = [];
  let selected = null;

  const showLabel = () => {
    const found = models.find(model => model.id === selected);
    button.textContent = !selected ? '模型：未选择' : found ? `模型：${found.name || found.id}` : `模型：${selected}（不可用）`;
  };
  const showError = (info, retry) => problem.replaceChildren(errorLine(info, retry));
  const failure = error => error instanceof NewsFailure ? error.info : {
    stage: 'client', stage_label: '网页→服务器', location: '', reason: '网页出错', retryable: true, request_id: '', time: '',
  };

  function renderList() {
    list.replaceChildren(...models.map(model => {
      const item = node('li');
      const choose = node('button', '', model.name || model.id);
      choose.type = 'button';
      if (model.id === selected) choose.setAttribute('aria-current', 'true');
      choose.addEventListener('click', () => pick(model.id));
      item.append(choose);
      return item;
    }));
  }

  async function pick(id) {
    problem.replaceChildren();
    try {
      const result = await postJSON('/api/news/settings', {model: id});
      selected = result.selected;
      showLabel();
      renderList();
      setOpen(false);
      el.dispatchEvent(new CustomEvent('news-model', {detail: {model: selected}}));
    } catch (error) {
      showError(failure(error), () => pick(id));
    }
  }

  async function load() {
    problem.replaceChildren();
    try {
      const data = await getJSON('/api/news/models');
      models = data.models || [];
      selected = data.selected || null;
      showLabel();
      renderList();
    } catch (error) {
      showError(failure(error), load);
    }
  }

  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }

  button.addEventListener('click', () => {
    const open = panel.hidden;
    setOpen(open);
    if (open) load();
  });
  document.addEventListener('click', event => { if (!panel.hidden && !event.composedPath().includes(el)) setOpen(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { setOpen(false); button.focus(); } });
  load();
  return {get model() { return selected; }};
}
