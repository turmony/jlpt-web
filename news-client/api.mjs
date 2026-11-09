// Shared by the news userscript: JSON and Server-Sent-Events calls to the JLPT server (a different
// origin from the news page), plus the one-line error display.
// Every failure carries the same dict the server sends (stage, stage_label, location, reason,
// retryable, request_id, time); failures the script detects itself are stage 'client', 'stream',
// or one of the script stages 'loader', 'locate', 'mark'.

const config = {base: ''};

// Every later request goes to base + path.
export function configure({base}) {
  config.base = String(base || '').replace(/\/+$/, '');
}

// The full address of a page on the JLPT site, e.g. a grammar card link.
export function siteUrl(path) {
  return config.base + path;
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
async function failureOf(response, path) {
  let body = null;
  try { body = await response.json(); } catch {}
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
  return request(path);
}

// `signal` (optional) aborts the request; the caller should then ignore the resulting failure.
export function postJSON(path, body, {signal} = {}) {
  return request(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal});
}

// Incremental Server-Sent-Events parser: push(text) with decoded chunks of any size.
// emit(name, data, id): id is the frame's `id:` number, if it has one. Comment lines (": ping") and fields
// other than event/id/data are ignored. A frame whose data is
// not JSON is reported as an 'error' event.
export function sseParser(emit) {
  let buffer = '';
  const frame = text => {
    let name = 'message';
    let id;
    const data = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('id:')) id = Number.parseInt(line.slice(3), 10);
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    let value;
    try { value = JSON.parse(data.join('\n')); } catch {
      return emit('error', {...streamInfo(), reason: '服务器回应格式不对'});
    }
    emit(name, value, Number.isInteger(id) ? id : undefined);
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

// The public edge in front of the server cuts any single response at about 16 s, while a model answer can
// take longer. So the server runs an answer as a job and each connection follows it for ~12 s, then ends
// with a `resume` event; this file continues from the last event number with /api/news/resume. The job's
// name comes in the X-News-Job response header. Nothing of this reaches the caller of streamSSE.
const JOB_HEADER = 'X-News-Job';
const MAX_LOST = 3;          // connections lost in a row (not ended by `resume`) before giving up
const MAX_SEGMENTS = 60;     // connections for one answer
const RETRY_DELAY = 400;     // ms before reconnecting after a lost connection

// POST `body` to an SSE endpoint. Resolves when the stream has ended. Exactly one of article, done
// or error is the last event; a stream that ends without one is reported as stage 'stream'.
// Aborting through `signal` ends quietly: no error event, and nothing is delivered after it; a job the
// server already runs is told to stop.
// An exception thrown by `onEvent` is a script bug, not a stream failure: it rejects the returned
// promise (after the stream is cancelled) and is never turned into an error event.
export async function streamSSE(path, body, {signal, onEvent}) {
  let finished = false;
  let job = '';
  let seen = 0; // number of the last event delivered
  const emit = (name, data) => {
    if (finished || signal?.aborted) return;
    if (TERMINAL.has(name)) finished = true;
    onEvent(name, data);
  };
  const cancelJob = () => {
    if (!job || finished) return;
    fetch(config.base + '/api/news/cancel', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({job}), keepalive: true}).catch(() => {});
  };
  signal?.addEventListener('abort', cancelJob);

  // One connection. Resolves 'resume' (the server asked for a new one), 'lost' (it ended or broke without
  // a last event), or 'over' (finished, failed for good, or aborted).
  async function connection(url, payload) {
    let response;
    try {
      response = await fetch(config.base + url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload), signal});
    } catch {
      if (job && !signal?.aborted) return 'lost';
      emit('error', clientInfo('网络连接失败', url));
      return 'over';
    }
    if (!response.ok) {
      emit('error', await failureOf(response, url));
      return 'over';
    }
    if (!(response.headers.get('content-type') || '').includes('text/event-stream') || !response.body) {
      emit('error', clientInfo('服务器回应格式不对', url));
      return 'over';
    }
    job = response.headers.get(JOB_HEADER) || job;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let outcome = 'lost';
    const parser = sseParser((name, data, id) => {
      if (name === 'resume') { outcome = 'resume'; return; }
      if (id !== undefined) {
        if (id <= seen) return; // delivered already: a replay after reconnecting
        seen = id;
      }
      emit(name, data);
    });
    // Cancelling resolves a pending read, so an abort ends the loop even between chunks.
    const stop = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', stop);
    try {
      while (!finished && !signal?.aborted && outcome !== 'resume') {
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
    return finished || signal?.aborted ? 'over' : outcome;
  }

  try {
    let url = path;
    let payload = body;
    let lost = 0;
    for (let segments = 0; segments < MAX_SEGMENTS; segments++) {
      const outcome = await connection(url, payload);
      if (outcome === 'over') return;
      if (outcome === 'resume') {
        lost = 0;
      } else {
        if (!job || ++lost > MAX_LOST) break;
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        if (signal?.aborted) return;
      }
      url = '/api/news/resume';
      payload = {job, next: seen};
    }
    emit('error', streamInfo());
  } finally {
    signal?.removeEventListener('abort', cancelJob);
  }
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

// A waiting message such as 正在分析…; change its textContent as stages move on.
export function progressLine(text) {
  const line = node('p', 'news-progress', text);
  line.setAttribute('role', 'status');
  return line;
}
