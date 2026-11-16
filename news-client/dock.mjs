// The small round button at the bottom right: shows how marking the page is going and opens a
// menu with the model every news request uses (「模型：××」, a list of the models qoder2api-hub
// offers; choosing one is saved on the server), the 外观 switch (follow the page / light / dark,
// theme.mjs), the error lines and 重新分词. Lives in the
// <jlpt-news> shadow root's layer.
import {clientInfo, errorLine, getJSON, NewsFailure, postJSON} from './api.mjs';
import {getThemeMode, onThemeMode, setThemeMode} from './theme.mjs';

const LABELS = {tokenizing: '分词中…', ready: '就绪', error: '出错'};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const failure = (error, path) => error instanceof NewsFailure ? error.info : clientInfo(`脚本出错：${error?.message || error}`, path);

const DEFAULT_PROVIDERS = [
  {id: 'codebuddy', label: 'CodeBuddy'},
  {id: 'qoder', label: 'Qoder'},
];

const EFFORT_LABELS = {
  off: '关闭',
  on: '开启',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};

// The 「CodeBuddy / Qoder」 + 「模型：××」 + 「思考强度/模式」 section at the top of the dock menu.
function modelRow() {
  const row = node('div', 'news-model-row');
  const providerGroup = node('div', 'news-provider');
  providerGroup.setAttribute('role', 'group');
  providerGroup.setAttribute('aria-label', '模型来源');
  const button = node('button', 'news-model', '模型：未选择');
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  const panel = node('div', 'news-model-panel');
  panel.hidden = true;
  const list = node('ul', 'news-model-list');
  panel.append(list);
  const problem = node('div', 'news-model-problem');
  const thinkingBox = node('div', 'news-thinking-box');
  thinkingBox.hidden = true;
  const thinkingLabel = node('div', 'news-thinking-label', '思考强度');
  const thinkingGroup = node('div', 'news-thinking');
  thinkingGroup.setAttribute('role', 'group');
  thinkingBox.append(thinkingLabel, thinkingGroup);
  row.append(providerGroup, button, panel, problem, thinkingBox);

  let provider = 'codebuddy';
  let providers = DEFAULT_PROVIDERS;
  let models = [];
  let selected = null;
  let effort = null;
  let effortsMap = {};
  let loadSeq = 0;

  const showProvider = () => {
    for (const option of providerGroup.children) {
      option.setAttribute('aria-pressed', String(option.dataset.provider === provider));
    }
  };

  function renderProviders(nextProviders) {
    providers = nextProviders;
    providerGroup.replaceChildren(...providers.map(item => {
      const option = node('button', 'news-provider-option', item.label || item.id);
      option.type = 'button';
      option.dataset.provider = item.id;
      option.addEventListener('click', () => pickProvider(item.id));
      return option;
    }));
    showProvider();
  }

  const showLabel = () => {
    const found = models.find(model => model.id === selected);
    button.textContent = !selected ? '模型：未选择' : found ? `模型：${found.name || found.id}` : `模型：${selected}（不可用）`;
  };

  function renderThinking() {
    const found = models.find(model => model.id === selected);
    const thinking = found?.thinking;
    if (!thinking || thinking.mode === 'none') {
      thinkingBox.hidden = true;
      thinkingGroup.replaceChildren();
      return;
    }
    const title = thinking.mode === 'levels' ? '思考强度' : '思考模式';
    thinkingBox.hidden = false;
    thinkingLabel.textContent = title;
    thinkingGroup.setAttribute('aria-label', title);
    const options = Array.isArray(thinking.options) ? thinking.options : [];
    if (thinking.mode === 'fixed') {
      const level = options[0] || thinking.default || 'high';
      const fixed = node('div', 'news-thinking-fixed', `固定开启（${level}，不支持关闭）`);
      fixed.setAttribute('aria-disabled', 'true');
      thinkingGroup.className = 'news-thinking-static';
      thinkingGroup.replaceChildren(fixed);
      return;
    }
    thinkingGroup.className = 'news-thinking';
    const current = (effort && options.includes(effort))
      ? effort
      : (effortsMap[selected] && options.includes(effortsMap[selected]))
        ? effortsMap[selected]
        : thinking.default;
    thinkingGroup.replaceChildren(...options.map(opt => {
      const option = node('button', 'news-thinking-option', EFFORT_LABELS[opt] || opt);
      option.type = 'button';
      option.dataset.effort = opt;
      option.setAttribute('aria-pressed', String(opt === current));
      option.addEventListener('click', () => pickEffort(opt));
      return option;
    }));
  }

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
      effort = result.effort ?? null;
      showLabel();
      renderList();
      renderThinking();
      setOpen(false);
    } catch (error) {
      problem.replaceChildren(errorLine(failure(error, '/api/news/settings'), () => pick(id)));
    }
  }

  async function pickEffort(nextEffort) {
    if (nextEffort === effort && !problem.childElementCount) return;
    const prev = effort;
    const seq = ++loadSeq;
    effort = nextEffort;
    renderThinking();
    problem.replaceChildren();
    try {
      const result = await postJSON('/api/news/settings', {effort: nextEffort});
      if (seq !== loadSeq) return;
      effort = result.effort ?? nextEffort;
      if (selected) effortsMap[selected] = effort;
      renderThinking();
    } catch (error) {
      if (seq !== loadSeq) return;
      effort = prev;
      renderThinking();
      problem.replaceChildren(errorLine(failure(error, '/api/news/settings'), () => pickEffort(nextEffort)));
    }
  }

  async function pickProvider(nextId) {
    if (nextId === provider && !problem.childElementCount) return;
    const prev = provider;
    const seq = ++loadSeq;
    loading = null;
    provider = nextId;
    showProvider();
    problem.replaceChildren();
    try {
      const result = await postJSON('/api/news/settings', {provider: nextId});
      if (seq !== loadSeq) return;
      provider = result.provider || nextId;
      models = [];
      selected = result.selected ?? null;
      effort = result.effort ?? null;
      effortsMap = {};
      showProvider();
      showLabel();
      renderList();
      renderThinking();
      await load(true);
    } catch (error) {
      if (seq !== loadSeq) return;
      provider = prev;
      showProvider();
      setOpen(true);
      problem.replaceChildren(errorLine(failure(error, '/api/news/settings'), () => pickProvider(nextId)));
    }
  }

  // One request at a time: opening the menu and then the list right away asks once.
  let loading = null;
  function load(force = false) {
    if (loading && !force) return loading;
    const seq = ++loadSeq;
    problem.replaceChildren();
    const current = getJSON('/api/news/models').then(data => {
      if (seq !== loadSeq) return;
      if (Array.isArray(data.providers) && data.providers.length) renderProviders(data.providers);
      if (typeof data.provider === 'string' && data.provider) provider = data.provider;
      showProvider();
      models = data.models || [];
      selected = data.selected || null;
      effort = data.effort ?? null;
      effortsMap = (data.efforts && typeof data.efforts === 'object') ? {...data.efforts} : {};
      showLabel();
      renderList();
      renderThinking();
    }, error => {
      if (seq !== loadSeq) return;
      models = [];
      effort = null;
      renderList();
      renderThinking();
      showLabel();
      setOpen(true);
      problem.replaceChildren(errorLine(failure(error, '/api/news/models'), () => load(true)));
    }).finally(() => {
      if (loading === current) loading = null;
    });
    loading = current;
    return current;
  }

  renderProviders(providers);

  button.addEventListener('click', () => {
    const open = panel.hidden;
    setOpen(open);
    if (open) load();
  });
  return {row, load, close: () => setOpen(false)};
}

const THEMES = [['auto', '跟随页面'], ['light', '浅色'], ['dark', '深色']];

// The 「外观」 row: three buttons in a segmented control; the pressed one is the current mode.
function themeRow() {
  const row = node('div', 'news-theme');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', '外观');
  const buttons = THEMES.map(([mode, label]) => {
    const button = node('button', 'news-theme-option', label);
    button.type = 'button';
    button.dataset.mode = mode;
    button.addEventListener('click', () => setThemeMode(mode));
    return button;
  });
  const show = mode => { for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.mode === mode)); };
  onThemeMode(show);
  show(getThemeMode());
  row.append(...buttons);
  return row;
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
  menu.append(model.row, themeRow(), errors, retokenize);
  const button = node('button', 'news-dock-button');
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');

  function setMenuOpen(open) {
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) model.load();
    else model.close();
  }

  button.addEventListener('click', () => setMenuOpen(menu.hidden));
  // Tapping outside the dock (e.g. a word on the page to look it up) or pressing Escape closes the menu.
  document.addEventListener('pointerdown', event => {
    if (!menu.hidden && !event.composedPath().includes(dock)) setMenuOpen(false);
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) setMenuOpen(false);
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
