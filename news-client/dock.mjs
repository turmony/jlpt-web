// The small round button at the bottom right: shows how marking the page is going and opens a
// menu with the model every news request uses (「模型：××」, a list of the models qoder2api-hub
// offers; choosing one is saved on the server), the error lines and 重新分词. Lives in the
// <jlpt-news> shadow root's layer.
import {clientInfo, errorLine, getJSON, NewsFailure, postJSON} from './api.mjs';

const LABELS = {tokenizing: '分词中…', ready: '就绪', error: '出错'};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const failure = (error, path) => error instanceof NewsFailure ? error.info : clientInfo(`脚本出错：${error?.message || error}`, path);

// The 「模型：××」 row: the label is a button that opens the model list. load() asks the server again.
function modelRow() {
  const row = node('div', 'news-model-row');
  const button = node('button', 'news-model', '模型：未选择');
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  const panel = node('div', 'news-model-panel');
  panel.hidden = true;
  const list = node('ul', 'news-model-list');
  const problem = node('div', 'news-model-problem');
  panel.append(list, problem);
  row.append(button, panel);

  let models = [];
  let selected = null;

  const showLabel = () => {
    const found = models.find(model => model.id === selected);
    button.textContent = !selected ? '模型：未选择' : found ? `模型：${found.name || found.id}` : `模型：${selected}（不可用）`;
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

  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }

  async function pick(id) {
    problem.replaceChildren();
    try {
      const result = await postJSON('/api/news/settings', {model: id});
      selected = result.selected;
      showLabel();
      renderList();
      setOpen(false);
    } catch (error) {
      problem.replaceChildren(errorLine(failure(error, '/api/news/settings'), () => pick(id)));
    }
  }

  // One request at a time: opening the menu and then the list right away asks once.
  let loading = null;
  function load() {
    if (loading) return loading;
    problem.replaceChildren();
    loading = getJSON('/api/news/models').then(data => {
      models = data.models || [];
      selected = data.selected || null;
      showLabel();
      renderList();
    }, error => {
      problem.replaceChildren(errorLine(failure(error, '/api/news/models'), load));
    }).finally(() => { loading = null; });
    return loading;
  }

  button.addEventListener('click', () => {
    const open = panel.hidden;
    setOpen(open);
    if (open) load();
  });
  return {row, load, close: () => setOpen(false)};
}

// -> {setStatus({state, errors})}
export function mountDock(layer, {onRetokenize}) {
  const dock = node('div', 'news-dock');
  const menu = node('div', 'news-dock-menu');
  menu.hidden = true;
  const model = modelRow();
  const errors = node('div', 'news-dock-errors');
  const retokenize = node('button', 'news-dock-action', '重新分词');
  retokenize.type = 'button';
  retokenize.addEventListener('click', () => onRetokenize());
  menu.append(model.row, errors, retokenize);
  const button = node('button', 'news-dock-button');
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
    if (menu.hidden) model.close();
    else model.load();
  });
  dock.append(menu, button);
  layer.append(dock);

  return {
    setStatus({state, errors: list}) {
      button.textContent = LABELS[state] || state;
      button.dataset.state = state;
      errors.replaceChildren(...list.map(info => errorLine(info, onRetokenize)));
    },
  };
}
