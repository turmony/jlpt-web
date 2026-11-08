// Shared by the news pages: JSON and Server-Sent-Events calls, plus the one-line error display.
// Every failure carries the same dict the server sends (stage, stage_label, location, reason,
// retryable, request_id, time); failures the page detects itself are stage 'client' or 'stream'.

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

// Errors the browser makes up itself have no request id: the server never saw the request.
function clientInfo(reason, path = '', retryable = true) {
  return {stage: 'client', stage_label: '网页→服务器', location: path.split('?')[0], reason, retryable, request_id: '', time: clock()};
}

function streamInfo() {
  return {stage: 'stream', stage_label: '推送到网页', location: '', reason: '回答中断', retryable: true, request_id: '', time: clock()};
}

function isInfo(value) {
  return value && typeof value === 'object' && typeof value.stage === 'string' && typeof value.reason === 'string';
}

function loginExpired(path) {
  location.href = '/login.html';
  return clientInfo('登录已过期', path, false);
}

// The failure for a non-2xx reply: the server's error dict when it has one, else a client error.
async function failureOf(response, path) {
  if (response.status === 401) return loginExpired(path);
  let body = null;
  try { body = await response.json(); } catch {}
  if (body && isInfo(body.error)) return body.error;
  const text = body && typeof body.error === 'string' ? `：${body.error}` : '';
  return clientInfo(`服务器返回 ${response.status}${text}`, path);
}

async function request(path, init) {
  let response;
  try {
    response = await fetch(path, init);
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
  return request(path, {});
}

export function postJSON(path, body) {
  return request(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
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
export async function streamSSE(path, body, {signal, onEvent}) {
  let finished = false;
  const emit = (name, data) => {
    if (finished || signal?.aborted) return;
    if (TERMINAL.has(name)) finished = true;
    onEvent(name, data);
  };
  let response;
  try {
    response = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal});
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
  try {
    while (!finished && !signal?.aborted) {
      const {done, value} = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, {stream: true}));
    }
  } catch {
    // Dropped connection or abort; handled below.
  }
  try { await reader.cancel(); } catch {}
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
  if (info.retryable && onRetry) {
    const retry = node('button', 'news-error-retry', '重试');
    retry.type = 'button';
    retry.addEventListener('click', onRetry);
    root.append('　', retry);
  }
  root.append(detail);
  return root;
}

// A waiting message such as 正在抓取雅虎（第 2 / 3 页）…; change its textContent as stages move on.
export function progressLine(text) {
  const line = node('p', 'news-progress', text);
  line.setAttribute('role', 'status');
  return line;
}
