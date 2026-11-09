// Shared by the news userscript: JSON and Server-Sent-Events calls to the JLPT server (a different
// origin from the news page), plus the one-line error display.
// Every failure carries the same dict the server sends (stage, stage_label, location, reason,
// retryable, request_id, time); failures the script detects itself are stage 'client', 'stream',
// or one of the script stages 'loader', 'locate', 'mark'.

const config = {base: '', token: '', install: ''};

// Every later request goes to base + path with the device token.
export function configure({base, token, install}) {
  config.base = String(base || '').replace(/\/+$/, '');
  config.token = token || '';
  config.install = install || '';
}

// The full address of a page on the JLPT site, e.g. a grammar card link.
export function siteUrl(path) {
  return config.base + path;
}

function headers(extra) {
  return {...extra, Authorization: 'Bearer ' + config.token};
}

export class NewsFailure extends Error {
  constructor(info) {
    super(info.reason);
    this.info = info;
  }
}

const pad = n => String(n).padStart(2, '0');
function clock() {
  const now = new Date();
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// Errors the script makes up itself have no request id: the server never saw the request.
export function clientInfo(reason, location = '', retryable = true) {
  return {stage: 'client', stage_label: '脚本→服务器', location: location.split('?')[0], reason, retryable, request_id: '', time: clock()};
}

const SCRIPT_STAGES = {loader: '加载主脚本', locate: '找到正文', mark: '标出词'};

// A failure inside the script itself; stage is 'loader', 'locate' or 'mark'.
export function scriptInfo(stage, reason, location = '', retryable = true) {
  return {stage, stage_label: SCRIPT_STAGES[stage], location, reason, retryable, request_id: '', time: clock()};
}

function streamInfo() {
  return {stage: 'stream', stage_label: '推送到网页', location: '', reason: '回答中断', retryable: true, request_id: '', time: clock()};
}

function isInfo(value) {
  return value && typeof value === 'object' && typeof value.stage === 'string' && typeof value.reason === 'string';
}

// The failure for a non-2xx reply: the server's error dict when it has one, else a client error.
// A 401 means the device token was revoked; its failure always links to the reinstall page.
async function failureOf(response, path) {
  let body = null;
  try { body = await response.json(); } catch {}
  if (response.status === 401) {
    const info = body && isInfo(body.error) ? body.error : clientInfo('令牌已失效，请重新安装脚本', path, false);
    return {...info, install: info.install || config.install || config.base + '/news-script/'};
  }
  if (body && isInfo(body.error)) return body.error;
  const text = body && typeof body.error === 'string' ? `：${body.error}` : '';
  return clientInfo(`服务器返回 ${response.status}${text}`, path);
}

async function request(path, init) {
  let response;
  try {
    response = await fetch(config.base + path, init);
  } catch (error) {
    throw new NewsFailure(clientInfo('网络连接失败', path));
  }
  if (!response.ok) throw new NewsFailure(await failureOf(response, path));
  try {
    return await response.json();
  } catch {
    throw new NewsFailure(clientInfo('服务器回应格式不对', path));
  }
}

export function getJSON(path) {
  return request(path, {headers: headers()});
}

// `signal` (optional) aborts the request; the caller should then ignore the resulting failure.
export function postJSON(path, body, {signal} = {}) {
  return request(path, {method: 'POST', headers: headers({'Content-Type': 'application/json'}), body: JSON.stringify(body), signal});
}

// Incremental Server-Sent-Events parser: push(text) with decoded chunks of any size.
// Comment lines (": ping") and fields other than event/data are ignored. A frame whose data is
// not JSON is reported as an 'error' event.
export function sseParser(emit) {
  let buffer = '';
  const frame = text => {
    let name = 'message';
    const data = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    let value;
    try { value = JSON.parse(data.join('\n')); } catch {
      return emit('error', {...streamInfo(), reason: '服务器回应格式不对'});
    }
    emit(name, value);
  };
  return {
    push(text) {
      buffer += text.replace(/\r/g, '');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        frame(raw);
      }
    },
  };
}

const TERMINAL = new Set(['article', 'done', 'error']);

// POST `body` to an SSE endpoint. Resolves when the stream has ended. Exactly one of article, done
// or error is the last event; a stream that ends without one is reported as stage 'stream'.
// Aborting through `signal` ends quietly: no error event, and nothing is delivered after it.
// An exception thrown by `onEvent` is a script bug, not a stream failure: it rejects the returned
// promise (after the stream is cancelled) and is never turned into an error event.
export async function streamSSE(path, body, {signal, onEvent}) {
  let finished = false;
  const emit = (name, data) => {
    if (finished || signal?.aborted) return;
    if (TERMINAL.has(name)) finished = true;
    onEvent(name, data);
  };
  let response;
  try {
    response = await fetch(config.base + path, {method: 'POST', headers: headers({'Content-Type': 'application/json'}), body: JSON.stringify(body), signal});
  } catch {
    return emit('error', clientInfo('网络连接失败', path));
  }
  if (!response.ok) return emit('error', await failureOf(response, path));
  if (!(response.headers.get('content-type') || '').includes('text/event-stream') || !response.body) {
    return emit('error', clientInfo('服务器回应格式不对', path));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = sseParser(emit);
  // Cancelling resolves a pending read, so an abort ends the loop even between chunks.
  const stop = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', stop);
  try {
    while (!finished && !signal?.aborted) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        break; // dropped connection or abort: handled below
      }
      if (chunk.done) break;
      // Not wrapped: an exception thrown by the caller's onEvent rejects the returned promise.
      parser.push(decoder.decode(chunk.value, {stream: true}));
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    reader.cancel().catch(() => {});
  }
  if (!finished && !signal?.aborted) emit('error', streamInfo());
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// One line: "{环节}失败（{位置}）：{原因}　重试". Tapping the line shows all six fields; 重试 is a
// button only when the failure can be retried and the caller says what retrying does.
export function errorLine(info, onRetry) {
  const root = node('div', 'news-error');
  const where = info.location ? `（${info.location}）` : '';
  const line = node('button', 'news-error-line', `${info.stage_label}失败${where}：${info.reason}`);
  line.type = 'button';
  line.setAttribute('aria-expanded', 'false');
  const detail = node('dl', 'news-error-detail');
  detail.hidden = true;
  const fields = [['环节', info.stage_label], ['位置', info.location], ['原因', info.reason],
    ['能否重试', info.retryable ? '能' : '不能'], ['请求编号', info.request_id], ['时间', info.time]];
  for (const [term, value] of fields) detail.append(node('dt', '', term), node('dd', '', value || '无'));
  line.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
    line.setAttribute('aria-expanded', String(!detail.hidden));
  });
  root.append(line);
  if (info.install) {
    const link = node('a', 'news-error-install', '重新安装');
    link.href = info.install;
    link.target = '_blank';
    link.rel = 'noopener';
    root.append('　', link);
  }
  if (info.retryable && onRetry) {
    const retry = node('button', 'news-error-retry', '重试');
    retry.type = 'button';
    retry.addEventListener('click', onRetry);
    root.append('　', retry);
  }
  root.append(detail);
  return root;
}

// A waiting message such as 正在分析…; change its textContent as stages move on.
export function progressLine(text) {
  const line = node('p', 'news-progress', text);
  line.setAttribute('role', 'status');
  return line;
}
