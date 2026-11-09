// The small round button at the bottom right: shows how marking the page is going and opens a
// menu with the error lines and 重新分词. Lives in the <jlpt-news> shadow root's layer.
import {errorLine} from './api.mjs';

const LABELS = {tokenizing: '分词中…', ready: '就绪', error: '出错'};

// -> {setStatus({state, errors})}
export function mountDock(layer, {onRetokenize}) {
  const dock = document.createElement('div');
  dock.className = 'news-dock';
  const menu = document.createElement('div');
  menu.className = 'news-dock-menu';
  menu.hidden = true;
  const errors = document.createElement('div');
  errors.className = 'news-dock-errors';
  const retokenize = document.createElement('button');
  retokenize.type = 'button';
  retokenize.className = 'news-dock-action';
  retokenize.textContent = '重新分词';
  retokenize.addEventListener('click', () => onRetokenize());
  menu.append(errors, retokenize);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'news-dock-button';
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
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
