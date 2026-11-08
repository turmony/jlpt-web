import {errorLine, getJSON, NewsFailure, progressLine} from '/news/api.mjs';
import {mountHeader} from '/news/header.mjs';

// The news list page: one category at a time, newest first as Yahoo orders them.
const FEEDS = [['top-picks', '主要'], ['domestic', '国内'], ['world', '国际'], ['business', '经济'],
  ['entertainment', '娱乐'], ['sports', '体育'], ['it', 'IT'], ['science', '科学']];
const KEY = 'news-category';

const $ = id => document.getElementById(id);
const readerUrl = url => `/news/read.html?url=${encodeURIComponent(url)}`;

function remembered() {
  try {
    const slug = localStorage.getItem(KEY);
    if (FEEDS.some(([value]) => value === slug)) return slug;
  } catch {}
  return FEEDS[0][0];
}

function hhmm(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let current = remembered();
let request = 0;

function renderTabs() {
  $('news-cats').replaceChildren(...FEEDS.map(([slug, label]) => {
    const tab = el('button', '', label);
    tab.type = 'button';
    tab.setAttribute('aria-pressed', String(slug === current));
    tab.addEventListener('click', () => {
      if (slug === current) return;
      current = slug;
      try { localStorage.setItem(KEY, slug); } catch {}
      renderTabs();
      load();
    });
    return tab;
  }));
}

function renderItems(items) {
  if (!items.length) return [el('p', 'muted', '这个分类暂时没有新闻。')];
  const list = el('ul', 'news-items');
  for (const item of items) {
    const row = el('li', 'news-item');
    const link = el('a', 'news-title', item.title);
    link.href = readerUrl(item.url);
    row.append(link, el('time', 'news-time', hhmm(item.time)));
    list.append(row);
  }
  return [list];
}

async function load() {
  const mine = ++request;
  const slug = current;
  $('news-list').replaceChildren(progressLine('正在读取新闻列表…'));
  try {
    const data = await getJSON(`/api/news/feeds?cat=${slug}`);
    if (mine !== request) return;
    const stale = data.stale_minutes === null || data.stale_minutes === undefined ? [] :
      [el('p', 'news-stale', `更新失败，显示的是 ${data.stale_minutes} 分钟前的列表`)];
    $('news-list').replaceChildren(...stale, ...renderItems(data.items || []));
  } catch (error) {
    if (mine !== request) return;
    const info = error instanceof NewsFailure ? error.info :
      {stage: 'client', stage_label: '网页→服务器', location: '', reason: '网页出错', retryable: true, request_id: '', time: ''};
    $('news-list').replaceChildren(errorLine(info, load));
  }
}

$('paste').addEventListener('submit', event => {
  event.preventDefault();
  const url = $('paste-url').value.trim();
  if (url) location.href = readerUrl(url);
});

mountHeader($('news-header'));
renderTabs();
load();
