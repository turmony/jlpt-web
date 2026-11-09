# 新闻阅读改为用户脚本 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉本站的雅虎抓取与 `/news/` 阅读页，改由 Safari 扩展 Userscripts 在雅虎原页面上运行本站脚本，提供查词、长按选句、分析面板、连续追问、模型选择和分环节报错；令牌按设备发放、可单独作废。

**Architecture:** 服务器新增设备令牌（`news_devices.py`）、网站表与加载器生成（`news_sites.py`），`app.py` 增加 Bearer 验证与 CORS；分析与追问改为由脚本直接发送段落与句子。前端源码放在新目录 `news-client/`，用 esbuild 打包为一个 IIFE（`server-public/news-script/client.js`），由加载器带令牌取回运行；查词卡、面板、右下角按钮渲染在 Shadow DOM 中。另有一个很小的管理页 `web/news-script/`。

**Tech Stack:** Python 3.12 标准库 + fugashi；原生 ES modules + esbuild 0.25.11（已在 devDependencies）；Playwright WebKit；Node 22 `node:test`。

**Spec:** `docs/superpowers/specs/2026-11-09-news-userscript-design.md`（查词、分析、追问、提示词等未变部分见 `docs/superpowers/specs/2026-11-08-news-reader-design.md`）

**旧代码：** Task 6 删除 `web/news/` 与旧的新闻浏览器测试后，Task 7、9、10 改写它们时从 `main` 分支取原文件，例如 `git show main:web/news/panel.mjs`、`git show main:tests/server/browser.test.mjs`。

## Global Constraints

- 网站表只在服务器配置 `news_sites` 中保存一份；缺省值：`{"name": "雅虎新闻", "origin": "https://news.yahoo.co.jp", "match": "https://news.yahoo.co.jp/articles/*", "path": "^/articles/[0-9a-f]+$", "parts": ["h1", ".article_body"]}`。加载器 `@match`、主脚本识别网站、CORS 允许列表都由它生成。
- 令牌：每台设备一个；`state/news/devices.json` 只存设备编号、名称、令牌的 SHA-256、安装时间、最近使用时间；设备最多 10 台；名称 1–20 字（去掉首尾空白后），不能含 `/` 和控制字符；同名重装替换旧令牌；最近使用时间最多每 10 分钟写一次。
- 新闻接口接受登录 Cookie 或 `Authorization: Bearer <令牌>`；安装、设备列表、作废只接受 Cookie。
- CORS 只对网站表中的 `origin` 开放：`Access-Control-Allow-Origin` 写具体来源、`Vary: Origin`、`Access-Control-Allow-Headers: Authorization, Content-Type`、`Access-Control-Allow-Methods: GET, POST`、`Access-Control-Max-Age: 600`；不发 `Allow-Credentials`。
- POST 同源规则：来源等于 `config['origin']`，或「带有效令牌且来源在网站表中、路径在 `/api/news/` 下」，否则 403。
- 分词接口一次最多 200 段、共 2 万字；分析/追问的段落最多 4000 字，句子最多 400 个词、每词最多 100 字。
- 错误环节（`stage` → 中文）：服务器端 `client` 脚本→服务器、`tokenize` 切句分词、`gateway` 服务器→qoder2api-hub、`model` 模型生成、`format` 解析回复、`stream` 推送到网页；脚本自己生成的 `loader` 加载主脚本、`locate` 找到正文、`mark` 标出词。401 的原因固定为「令牌已失效，请重新安装脚本」，不能重试，附管理页地址。
- 包词在 `load` 事件之后进行；词标记被页面清掉时按缓存自动重包（2026-11-09 实测：提前包词会引发 React #418/#423 并被整块重渲染清掉）。
- 沿用：30 秒无输出或总时长 2 分钟超时；模型请求最多同时 3 个；追问只发最近 6 轮；请求编号 `n-YYYYMMDD-xxxx`；日志不记录令牌、Cookie、API Key；查词与分析记录、追问对话不保存。
- 只有网站表 `parts` 内的文字可点；只对这些元素设 `-webkit-user-select: none; -webkit-touch-callout: none`；在链接里点词查词、不跳转。
- iPad 横屏（`(min-width: 900px) and (orientation: landscape)`）面板浮在右侧约 35% 宽；其余从底部弹出。
- 自动测试不访问真实雅虎、不调用真实模型；样例正文自写。

## Review Focus

- 一个词被链接或 `<b>` 从中间切开：两段都属于同一个词（同一 `data-s`/`data-i`），点任一段弹出同一张查词卡，高亮时两段都亮。→ Task 8 测试 `a word split by inline elements is one word in two pieces`。
- 面板开着时雅虎重新渲染正文：重包后选中句的高亮恢复，面板内容不变，点词照常。→ Task 9 测试 `a re-render keeps the selected sentence highlighted and words tappable`。
- 段落含全角空格、`&nbsp;`、emoji、`<br>` 换行：每个可点的字都被标出，没有段落被报「标出词」失败。→ Task 8 测试 `paragraphs with spaces, nbsp, emoji and line breaks are fully marked`。
- 很长的文章（超过 200 段或 2 万字）：分几次请求分词，都不超过服务器上限，全部段落被标出。→ Task 8 测试 `a long article is tokenized in batches under the server limits`。
- 设备名称含 `/`（含编码成 `%2F`）、全是空格、超过 20 字、含日文或 emoji：前三种被拒，后两种可以安装。→ Task 3 测试 `test_install_name_rules`。

---

### Task 1: 设备令牌存储

**Files:**
- Create: `server/news_devices.py`
- Test: `tests/server/test_news_devices.py`

**Interfaces:**
- Produces: `class DeviceStore(path: Path, now=time.time)`；`MAX_DEVICES = 10`、`NAME_MAX = 20`、`TOUCH_INTERVAL = 600`；
  - `install(name: str) -> tuple[dict, str]`：返回（设备信息, 明文令牌）；名称无效抛 `ValueError('设备名称为 1–20 字，不能含 /')`；已满抛 `ValueError('设备已满 10 台，请先作废不用的设备')`；同名（去空白后相等）替换旧记录。
  - `check(token: str) -> str | None`：有效时返回设备编号，并按 `TOUCH_INTERVAL` 更新最近使用时间。
  - `list() -> list[dict]`：`{id, name, installed, last_used}`（时间为 Unix 秒），按安装时间排序，不含散列值。
  - `revoke(device_id: str) -> None`：不存在抛 `KeyError`。
- 令牌：`secrets.token_urlsafe(32)`；设备编号：`secrets.token_hex(8)`；比较用 `hmac.compare_digest`；写文件用临时文件 + `os.replace`；一把 `threading.Lock`。

- [ ] **Step 1: 写失败测试**（`unittest`，临时目录，注入可调的 `now`）

```python
def test_install_returns_token_and_stores_only_its_hash(self):
    device, token = self.store.install('iPad')
    self.assertEqual(self.store.check(token), device['id'])
    raw = (self.dir / 'devices.json').read_text()
    self.assertNotIn(token, raw)
    self.assertIn(hashlib.sha256(token.encode()).hexdigest(), raw)
def test_two_devices_work_and_revoking_one_keeps_the_other(self): ...  # iPad、iPhone 都有效；revoke(iPad) 后只有 iPhone 有效
def test_same_name_reinstall_replaces_only_that_device(self): ...      # 第二次 install('iPad')：旧 iPad 令牌 None，iPhone 仍有效，list() 共 2 台
def test_eleventh_device_is_refused(self): ...                        # 10 台后 install('第11台') 抛 ValueError，消息含「设备已满 10 台」
def test_name_rules(self): ...                                         # ''、'   '、'a/b'、'x'*21、'a\nb' 抛 ValueError；' 我的iPad ' 存为 '我的iPad'；'📱' 可以
def test_last_used_is_written_at_most_every_ten_minutes(self): ...     # now=1000 install；now=1100 check → last_used 仍为 None；now=1700 check → 1700；文件 mtime 只在第二次变
def test_unknown_or_malformed_token_is_none(self): ...                 # ''、'x'、None 都返回 None
def test_list_has_no_secrets(self): ...                                # list() 每项键集合恰为 {'id','name','installed','last_used'}
```

- [ ] **Step 2: 运行确认失败** — `python3 -m unittest tests.server.test_news_devices -v`，预期 `ModuleNotFoundError: server.news_devices`。
- [ ] **Step 3: 实现 `server/news_devices.py`**（按上面接口）。
- [ ] **Step 4: 运行确认通过** — 同上命令，全部 PASS。
- [ ] **Step 5: 提交** — `git add server/news_devices.py tests/server/test_news_devices.py && git commit -m "feat(news): 按设备发放与作废令牌"`

---

### Task 2: 网站表与加载器生成

**Files:**
- Create: `server/news_sites.py`
- Test: `tests/server/test_news_sites.py`

**Interfaces:**
- Produces:
  - `DEFAULT_SITES`（Global Constraints 中的缺省项）。
  - `sites(config: dict) -> list[dict]`：`config.get('news_sites')` 或缺省；每项必须有 `name/origin/match/path/parts`，`origin` 为 `http(s)://主机[:端口]`，`path` 能编译为正则，`parts` 为非空字符串列表，否则抛 `ValueError`。
  - `allowed_origins(config) -> set[str]`。
  - `loader_script(base: str, token: str, site_list: list[dict]) -> str`：返回 `.user.js` 文本。

加载器的元数据块与行为（这是用户会看到的文字，照写）：

```
// ==UserScript==
// @name         JLPT 新闻查词
// @namespace    <base>
// @version      1
// @description  在新闻页面上查词、分析句子（令牌只属于这台设备）
// @match        <每个网站一行 match>
// @run-at       document-start
// @inject-into  content
// @noframes
// ==/UserScript==
```

正文是一个立即执行函数，常量 `CONFIG = {base, token, sites, install: base + '/news-script/'}`（用 `json.dumps` 写入，`</` 转义为 `<\/`）：
1. `fetch(base + '/api/news/client.js', {headers: {Authorization: 'Bearer ' + token}, cache: 'no-store'})` 取主脚本文本。
2. 先 `new Function('JLPT_NEWS', code)(CONFIG)`；若抛 `EvalError`（扩展环境禁止 eval），改为向页面插入 `<script>`，内容 `(function(JLPT_NEWS){<code>\n})(<CONFIG JSON>)`，执行后立即移除该元素。
3. 取不到（网络错误、非 2xx）时，在 `document.documentElement` 上挂一个 `<jlpt-news-loader>`（Shadow DOM），右下角显示红色圆按钮「!」，点开显示「加载主脚本失败：<原因>」；401 时原因为「令牌已失效，请重新安装脚本」并附 `CONFIG.install` 链接；其他状态为「服务器返回 <状态码>」；网络错误为「网络连接失败」。

- [ ] **Step 1: 写失败测试**

```python
def test_default_sites_and_allowed_origins(self):
    self.assertEqual(allowed_origins({}), {'https://news.yahoo.co.jp'})
def test_config_sites_override_and_bad_entries_are_refused(self): ...  # 缺 parts、origin 带路径、path 不是正则 → ValueError
def test_default_path_rejects_image_and_comment_pages(self):
    rx = re.compile(DEFAULT_SITES[0]['path'])
    self.assertTrue(rx.search('/articles/bd93f19234247d18f21aadb475e5de44c0e759b3'))
    self.assertFalse(rx.search('/articles/bd93f19234247d18f21aadb475e5de44c0e759b3/images/000'))
    self.assertFalse(rx.search('/articles/bd93f19234247d18f21aadb475e5de44c0e759b3/comments'))
def test_loader_has_metadata_matches_and_config(self): ...  # 含 '// @match        https://news.yahoo.co.jp/articles/*'、'@inject-into  content'、令牌、'/api/news/client.js'
def test_loader_escapes_script_end(self): ...               # 名称为 '</script>' 的网站：输出不含 '</script>'
def test_loader_is_valid_javascript(self): ...              # 写入临时文件，`node --check` 退出码 0
```

- [ ] **Step 2: 运行确认失败** — `python3 -m unittest tests.server.test_news_sites -v`。
- [ ] **Step 3: 实现 `server/news_sites.py`**。
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: 提交** — `feat(news): 网站表与加载器生成`

---

### Task 3: 令牌验证、跨域与设备接口接入 app.py

**Files:**
- Modify: `server/app.py`（`Application.__init__`、`route`、`reply`、`sse`、新增 `do_OPTIONS`、`news_route`）
- Modify: `server/news.py`（`NewsService.__init__` 增加 `self.devices = DeviceStore(state / 'news' / 'devices.json')`）
- Modify: `tests/server/test_caddy.py`（经 Caddy 的预检请求）
- Test: `tests/server/test_news_access.py`

**Interfaces:**
- Consumes: Task 1 `DeviceStore`，Task 2 `sites`、`allowed_origins`、`loader_script`。
- Produces（HTTP）：
  - `OPTIONS /api/news/*`：来源在允许列表中 → 204 + CORS 头；否则 403。
  - `GET /api/news/install/<设备名称>/jlpt-news.user.js`（只接受 Cookie）→ 200，`Content-Type: text/javascript; charset=utf-8`，正文为 `loader_script(config['origin'], token, sites(config))`；带查询参数 `download=1` 时另加 `Content-Disposition: attachment; filename="jlpt-news.user.js"`；名称无效或已满 → 400 `{'error': <消息>}`。
  - `GET /api/news/devices`（只接受 Cookie）→ `{'devices': [...]}`。
  - `POST /api/news/devices/revoke {id}`（只接受 Cookie，须同源）→ `{'ok': True}`；不存在 → 404。
  - `GET /api/news/client.js`（令牌或 Cookie）→ 读取 `Path(config['static'])/'news-script'/'client.js'`，`text/javascript; charset=utf-8`；文件不存在 → 503 `{'error': '主脚本未构建'}`。
  - 其余 `/api/news/*` 接受令牌或 Cookie。来源在允许列表中的请求，`reply()` 与 `sse()` 都带 CORS 头（错误回复也带，脚本才能读到错误内容）。
  - 无效令牌 → 401 `{'error': NewsError('client', '令牌已失效，请重新安装脚本', retryable=False).to_dict()}`，并加 `'install': config['origin'] + '/news-script/'`。
  - 带令牌访问安装、设备列表、作废 → 403 `{'error': '令牌不能管理设备'}`。
- 解析令牌：`Authorization` 头以 `Bearer ` 开头时取其后部分；带了 `Authorization` 头就只按令牌验证，不再看 Cookie。

- [ ] **Step 1: 写失败测试**（沿用 `test_news_http.py` 的服务器启动方式；`config['news_sites']` 设为一个测试来源 `https://news.example`）

```python
def test_preflight_allows_only_listed_origins(self): ...         # OPTIONS 来自 https://news.example → 204 且四个 CORS 头值如 Global Constraints；来自 https://evil.example → 403、无 CORS 头
def test_token_post_from_listed_origin_is_allowed(self): ...      # 带令牌、Origin https://news.example 的 POST /api/news/settings → 200 且带 Access-Control-Allow-Origin
def test_cookie_only_post_from_listed_origin_is_refused(self): ...# 只有 Cookie、Origin https://news.example → 403
def test_token_post_from_unlisted_origin_is_refused(self): ...    # 带令牌、Origin https://evil.example → 403
def test_bad_token_is_401_with_install_link_and_cors(self): ...   # error.stage=='client'、reason=='令牌已失效，请重新安装脚本'、retryable False、install 以 '/news-script/' 结尾；有 CORS 头
def test_token_cannot_manage_devices(self): ...                   # 带令牌 GET install/devices、POST revoke → 403
def test_install_needs_login_and_returns_loader(self): ...        # 未登录 401；登录后 200、Content-Type text/javascript、正文含 '@match' 和一个能通过 /api/news/models 验证的令牌
def test_install_download_is_an_attachment(self): ...            # ?download=1 → Content-Disposition 为 attachment; filename="jlpt-news.user.js"；不带时无此头；两种都按同名替换令牌
def test_install_name_rules(self): ...                            # 'a%2Fb'、'%20%20'、21 个字 → 400；'%E6%97%A5%E6%9C%AC'（日本）、'%F0%9F%93%B1'（📱）→ 200
def test_devices_list_and_revoke(self): ...                       # 装 iPad、iPhone；列表 2 台、无令牌字段；revoke iPad 后它的令牌 401、iPhone 仍 200；revoke 不存在的编号 404；revoke 非同源 403
def test_client_js_needs_auth_and_reports_unbuilt(self): ...      # 无凭据 401；带令牌而文件不存在 503；写入文件后 200 且内容一致
def test_logs_never_contain_the_token(self): ...                  # 用无效令牌和有效令牌各请求一次，stderr 中不含令牌文本
```

`test_caddy.py`：在现有流式检查旁加一项——经 Caddy 发 `OPTIONS /api/news/analyze`（Origin 为测试来源），后端假服务回 204 时 Caddy 原样转发（状态 204、`Access-Control-Allow-Origin` 头保留）。

- [ ] **Step 2: 运行确认失败** — `python3 -m unittest tests.server.test_news_access -v`。
- [ ] **Step 3: 实现**（按上面接口修改 `app.py`、`news.py`）。
- [ ] **Step 4: 运行确认通过** — `python3 -m unittest tests.server.test_news_access tests.server.test_news_http tests.server.test_http -v`，以及 `CADDY_BINARY=$(which caddy) python3 -m unittest tests.server.test_caddy -v`。
- [ ] **Step 5: 提交** — `feat(news): 令牌验证、跨域与设备接口`

---

### Task 4: 分词接口；分析与追问改由脚本发送句子

**Files:**
- Modify: `server/news.py`（新增 `tokenize`；改 `analyze_args`、`ask_args`、`analyze`、`ask`；删除 `_locate`、`_selection_args` 中按文章编号查找的部分）
- Modify: `server/app.py`（`news_route` 增加 `/tokenize`）
- Modify: `tests/server/test_news_http.py`（`AnalyzeTests`、`AskTests`、`ReasoningHTTPTests`、`StageErrorTests` 的请求体改为新格式）

**Interfaces:**
- Produces:
  - `POST /api/news/tokenize {paragraphs: [str]}` → `{'paragraphs': [[{'tokens': [{s, r, l, p, t}]}…]…]}`（每段一个句子列表，不带句子编号）。常量 `MAX_PARAGRAPHS = 200`、`MAX_CHARS = 20000`；超出 → 400 `client_error('分词请求超过 200 段或 2 万字')`；某段不是字符串 → 400 `'分词请求格式不对'`。分词组件缺失 → `NewsError('tokenize', '分词组件未安装', '第 N 段', retryable=False)`（N 从 1 起）。
  - `analyze_args(data) -> (paragraph, tokens, start, end)`；`ask_args(data) -> (paragraph, tokens, start, end, analysis, history, question)`。常量 `MAX_PARAGRAPH = 4000`、`MAX_TOKENS = 400`、`MAX_TOKEN = 100`。规则：`paragraph` 为 1–4000 字字符串；`tokens` 为 1–400 个字符串、每个不超过 100 字；`''.join(tokens)` 必须是 `paragraph` 的子串，否则 400 `'句子不在段落中'`；`start/end` 规则不变，`end >= len(tokens)` → `'选中范围超出句子'`。
  - `analyze(paragraph, tokens, start, end, emit)`、`ask(paragraph, tokens, start, end, analysis_text, history, question, emit)`；出错位置分别为「句子分析」「追问」。
- 提示词（`news_prompts.py`）不变；`tests/llm/test_real_model.py` 直接调用提示词函数，不需改动。

- [ ] **Step 1: 写失败测试**（加到 `test_news_http.py` 的新类 `TokenizeTests`，并改写现有分析/追问用例的请求体）

```python
def test_tokenize_returns_sentences_per_paragraph(self): ...      # ['今日は晴れ。明日は雨。', '「はい。」と言った。'] → 第 1 段 2 句、第 2 段 1 句；拼回各句等于原句
def test_tokenize_limits(self): ...                               # 201 段 → 400；两段共 20001 字 → 400；[1] → 400 '分词请求格式不对'
def test_tokenize_unavailable_names_the_paragraph(self): ...      # to_sentences 抛 TokenizerUnavailable → error.stage 'tokenize'、location '第 1 段'、retryable False
def test_analyze_takes_sentence_from_body(self): ...              # {'paragraph': P, 'tokens': [...], 'start': 1, 'end': 2} → FakeHub 收到的消息含 P 与选中文字
def test_bad_sentence_bodies_are_400(self): ...                   # tokens 拼不出 paragraph 的子串；401 个词；段落 4001 字；end 越界 → 均 400
```

- [ ] **Step 2: 运行确认失败** — `python3 -m unittest tests.server.test_news_http -v`。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行确认通过**（同上命令）。
- [ ] **Step 5: 提交** — `feat(news): 分词接口；分析与追问由脚本发送句子`

---

### Task 5: 新闻脚本管理页与导航

**Files:**
- Create: `web/news-script/index.html`、`web/news-script/manage.mjs`
- Modify: `scripts/build-server.mjs:18`、`web/papers.html:5`、`web/review/index.html:5`（导航 `<a href="/news/">新闻</a>` → `<a href="/news-script/">新闻脚本</a>`）
- Modify: `tests/server/test_storage.py:84`（断言改为新链接）
- Modify: `tests/server/browser.test.mjs`（`nav links to news …` 一项改为检查「新闻脚本」指向 `/news-script/`）
- Test: `tests/server/news-userscript.test.mjs`（新建；本任务只放管理页两项）

**Interfaces:**
- Consumes: Task 3 的安装、设备列表、作废接口。
- 页面（使用 `/site.css`，与 `papers.html` 相同的顶栏）：标题「新闻脚本」；输入框「设备名称」（`maxlength=20`，按 `navigator.userAgent` 预填：含 `iPad` 或（`Macintosh` 且 `navigator.maxTouchPoints > 1`）→「iPad」，含 `iPhone` →「iPhone」，否则空）；按钮「安装到这台设备」把页面跳到 `/api/news/install/<encodeURIComponent(名称)>/jlpt-news.user.js`；按钮「下载脚本文件」跳到同一地址加 `?download=1`，下面一句小字「下载后存入 Userscripts 的脚本文件夹，也可以使用」；说明一句「需要先在 App Store 安装 Userscripts，并在 Safari 中启用它。」；设备列表每行「名称　安装 11/9 10:12　最近使用 11/9 10:30（未使用过时写「未使用」）　作废」，作废前 `confirm('作废「名称」后，这台设备上的脚本立即失效。')`，作废后刷新列表；接口失败时在列表上方显示一行错误文字。

- [ ] **Step 1: 写失败测试**（`news-userscript.test.mjs`：复制 `browser.test.mjs` 的 `withSite` 登录方式，Chromium 即可）

```js
test('the manage page prefills the device name from the user agent and links the install url', ...)
  // iPhone 13 设备：输入框值 'iPhone'；填 '我的 iPad' 后点「安装到这台设备」，页面请求的地址为 /api/news/install/%E6%88%91%E7%9A%84%20iPad/jlpt-news.user.js
test('the download button saves jlpt-news.user.js with the token', ...)
  // 点「下载脚本文件」触发下载（page.waitForEvent('download')），suggestedFilename() 为 'jlpt-news.user.js'，内容含 '@match'
test('the manage page lists devices and revokes one after confirming', ...)
  // 先用 page.request 装 iPad、iPhone；列表 2 行；对话框确认后剩 1 行「iPhone」
```

- [ ] **Step 2: 运行确认失败** — `npm run build && node --test tests/server/news-userscript.test.mjs`。
- [ ] **Step 3: 实现页面与导航修改。**
- [ ] **Step 4: 运行确认通过** — 同上；再跑 `python3 -m unittest tests.server.test_storage -v`。
- [ ] **Step 5: 提交** — `feat(news): 新闻脚本管理页，导航改为新闻脚本`

---

### Task 6: 删除雅虎抓取、文章存储与旧阅读页

**Files:**
- Delete: `server/news_yahoo.py`、`scripts/news_probe.py`、`tests/server/test_news_yahoo.py`、`tests/server/test_news_probe.py`、`tests/server/news_fixture.py`、`tests/server/news_fixtures/`、`web/news/`
- Modify: `server/news.py`（删除 `feeds`、`open`、`check_url`、`_stored_partial`、`_build`、`_sentences`、`_blocks`、`_download`、`image`、`_source_ok`、`sniff_image`、`FEED_TTL`、`REUSE_SECONDS`、`KEY_SHOWN`、`R_EXPIRED` 及相关导入；`NewsService(config, state, hub=None)` 不再接受 `yahoo`）
- Modify: `server/news_store.py`（删除文章、图片、`single_flight`、`image_key`、`ARTICLE_TTL`、`IMAGE_MAX`、`TOTAL_MAX`、`KEY_RE`；`cleanup()` 改为：删除 `news/` 下名称匹配 `ID_RE` 的旧文章目录，再清理过期释义）
- Modify: `server/news_errors.py`（`STAGES` 只留 `client: '脚本→服务器'`、`tokenize`、`gateway`、`model`、`format`、`stream`）
- Modify: `server/app.py`（删除 `/feeds`、`/open`、`/image/…` 路由）、`server/__main__.py:17` 注释改为「hourly expiry of glosses」
- Modify: `tests/server/test_news_http.py`（删除 `OpenTests`、`RealTokenTests`、`FeedTests` 和 `StageErrorTests` 中 yahoo/parse/image 部分、`UnitTests` 中只测已删函数的项）、`tests/server/test_news_store.py`（删除文章、图片、并发相关测试）、`tests/server/test_caddy.py:90`（流式路径改为 `('/api/news/analyze', '/api/news/ask')`）
- Modify: `tests/server/browser.test.mjs`（删除「News reader」整段：`withNews` 起至文件末尾的新闻测试；保留其他页面测试）、`tests/server/browser_fixture.py`（`news_wiring` 去掉 Yahoo，只保留 FakeHub、`fixture_sentences`、选定模型；删除 `READER_*`、`IMAGE_HOST`、`_reader_page`、`_png`）

**Interfaces:**
- Produces: `NewsService(config, state, hub=None)`；`NewsStore(root, now)` 只有释义、设置与 `cleanup()`。

- [ ] **Step 1: 写失败测试**（`test_news_store.py`）

```python
def test_cleanup_removes_legacy_article_dirs_and_keeps_settings(self):
    legacy = self.dir / 'b2c3d4e5f6a70819' / 'images'; legacy.mkdir(parents=True)
    self.store.save_settings({'model': 'M'})
    self.store.cleanup()
    self.assertFalse(legacy.parent.exists())
    self.assertEqual(self.store.settings()['model'], 'M')
    self.assertTrue((self.dir / 'glossary.sqlite').exists())
def test_removed_routes_are_404(self): ...   # 放在 test_news_http：/api/news/feeds?cat=domestic、POST /api/news/open、/api/news/image/abcdef12/0 → 404
```

- [ ] **Step 2: 运行确认失败** — `python3 -m unittest tests.server.test_news_store tests.server.test_news_http -v`。
- [ ] **Step 3: 删除与修改**（按 Files 列表）。确认 `git grep -n "news_yahoo\|news_probe\|/news/read\|web/news/"` 在 `server/ scripts/ tests/ web/` 下无结果。
- [ ] **Step 4: 运行全部后端与浏览器测试** — `npm run test:server` 全部通过；`npm run build && npm run test:browser` 全部通过。
- [ ] **Step 5: 提交** — `refactor(news): 删除雅虎抓取、文章存储与旧阅读页`

---

### Task 7: 主脚本骨架：请求模块、打包、加载与测试环境

**Files:**
- Create: `news-client/api.mjs`（由 `git show main:web/news/api.mjs` 改写）、`news-client/ui.mjs`、`news-client/ui.css`、`news-client/main.mjs`
- Create: `scripts/build-news-client.mjs`；Modify: `scripts/build-server.mjs`（调用它输出 `news-script/client.js`）
- Create: `tests/server/news_site/article.html`（仿雅虎结构的自写样例页）
- Modify: `tests/server/browser_fixture.py`（另起一个本机端口提供样例页；配置 `news_sites`；输出改为一行「`<本站地址> <样例站地址>`」）、`tests/server/browser.test.mjs`（`withSite` 只取输出的第一段作为地址）
- Test: `tests/news-client/api.test.mjs`（Node 直接运行）、`tests/server/news-userscript.test.mjs`
- Modify: `package.json`（`test:browser` 同时运行 `tests/server/news-userscript.test.mjs`；新增 `"test:client": "node --test tests/news-client/"`）

**Interfaces:**
- Produces（`news-client/api.mjs`，在原 `web/news/api.mjs` 的导出上改动）：
  - `configure({base, token, install})`：之后所有请求的地址为 `base + path`，并带 `Authorization: Bearer <token>`。
  - `getJSON`、`postJSON`、`streamSSE`、`sseParser`、`NewsFailure`、`errorLine`、`progressLine` 签名不变。
  - `clientInfo(reason, location = '', retryable = true)` 改为导出，`stage_label` 为「脚本→服务器」。
  - `scriptInfo(stage, reason, location = '', retryable = true)`：脚本自己生成的错误，`stage` 为 `'loader' | 'locate' | 'mark'`，`stage_label` 依次为「加载主脚本」「找到正文」「标出词」。
  - 401：不再跳转登录页；返回服务器给的错误信息（含 `install`）；服务器没给时用 `clientInfo('令牌已失效，请重新安装脚本', path, false)` 加 `install`。`errorLine(info)` 在 `info.install` 存在时，在原因后显示链接「重新安装」（新标签页打开）。
- Produces（`news-client/ui.mjs`）：`mountUi() -> {host: HTMLElement, root: ShadowRoot, layer: HTMLElement}`：在 `document.documentElement` 上挂 `<jlpt-news>`（`all: initial`），`attachShadow({mode: 'open'})`，注入 `ui.css`（以文本导入）；`injectPageStyle(cssText)`：向 `document.head` 加一个 `<style data-jlpt-news>`。
- Produces（`news-client/main.mjs`，打包入口）：读取自由变量 `JLPT_NEWS`；`site = JLPT_NEWS.sites.find(s => s.origin === location.origin && new RegExp(s.path).test(location.pathname))`，找不到就什么也不做；找到则 `configure(...)`、`mountUi()`，并设 `document.documentElement.dataset.jlptNews = 'ready'`（后续任务在此继续接线）。
- Produces（`scripts/build-news-client.mjs`）：`export async function buildNewsClient(outfile)`：`esbuild.build({entryPoints: ['news-client/main.mjs'], bundle: true, format: 'iife', target: ['safari15'], loader: {'.css': 'text'}, outfile})`。
- 样例页 `article.html`：`<h1>`；`<div class="article_body">` 内含：带关键词链接 `<a>` 的段落；用 `<b>` 从词中间切开一个词的段落；带 `<br>` 的段落；含全角空格、`&nbsp;`、emoji 的段落；`<figure>` 中 `<a>` 包着的 `<figcaption>`；以及一段数字与量词「10日」。查询参数控制：`?rerender=<毫秒>` 到时用同一段 HTML 整块替换 `.article_body` 的内容；`?missing=1` 在 `DOMContentLoaded` 时删除 `.article_body`；`?long=1` 由页面脚本生成 250 段、共约 2.5 万字。
- 测试辅助（`news-userscript.test.mjs`）：`withUserscript(device, run, {hub, select, name = 'iPad'})`：启动 fixture，用 `page.request` 登录本站并取 `/api/news/install/<name>/jlpt-news.user.js` 的文本，`context.addInitScript(loaderText)`，`run(page, {app, site, tmp})`；页面在样例站上，本站是另一个端口，是真实的跨域。

- [ ] **Step 1: 写失败测试**

```js
// tests/news-client/api.test.mjs（Node；用 globalThis.fetch 的替身）
test('requests go to base with the bearer token')                 // configure({base:'https://a', token:'T'}) 后 getJSON('/api/news/models') 调用 'https://a/api/news/models'，headers.Authorization === 'Bearer T'
test('a 401 becomes the reinstall failure with the install link') // reason '令牌已失效，请重新安装脚本'、retryable false、install 'https://a/news-script/'
// main 上 tests/server/browser.test.mjs 中 4 项 SSE 测试（分块帧、多字节字符与 CRLF 拆分、读取中止、处理函数抛错）改写到这里，在 Node 中运行
```

```js
// tests/server/news-userscript.test.mjs
test('the loader runs the main script on an article page only')   // /articles/<hex> 上 html[data-jlpt-news=ready] 且有 jlpt-news 元素；/articles/<hex>/images/000 上都没有
test('a revoked token shows the loader button with the reinstall reason') // 作废设备后打开文章：jlpt-news-loader 出现，点开含「加载主脚本失败：令牌已失效，请重新安装脚本」与「重新安装」链接
```

- [ ] **Step 2: 运行确认失败** — `npm run test:client`；`npm run build && node --test tests/server/news-userscript.test.mjs`。
- [ ] **Step 3: 实现**（按上面接口）。
- [ ] **Step 4: 运行确认通过**（同上命令，以及 `npm run test:browser` 确认 `withSite` 修改未破坏其他测试）。
- [ ] **Step 5: 提交** — `feat(news): 主脚本骨架、打包与加载`

---

### Task 8: 标出词（找正文、分词、包词、重包）与右下角状态

**Files:**
- Create: `news-client/marks.mjs`、`news-client/dock.mjs`
- Modify: `news-client/main.mjs`、`news-client/ui.css`
- Test: `tests/server/news-userscript.test.mjs`

**Interfaces:**
- Produces（`marks.mjs`）：
  - `findParts(site) -> {roots: Element[], missing: string[]}`。
  - `blocksOf(root) -> Array<{text: string, nodes: Text[]}>`：文字节点按最近的块级祖先（`P H1–H6 LI FIGCAPTION BLOCKQUOTE DIV SECTION TD DT DD`）分组；同组两个文字节点之间隔着 `<br>` 时，用 `'\n'` 连接；跳过 `script style noscript button textarea` 内、已在 `.jlpt-t` 内的文字，以及只有空白的组。
  - `wrapBlock(block, sentences) -> boolean`：`sentences` 为 `[{id, tokens}]`。从左到右用 `indexOf` 在 `block.text` 中定位每个词（从上一个词的末尾开始找）；任何一个词找不到就不改动 DOM，返回 `false`。每个词生成 `<span class="jlpt-t" data-s="<id>" data-i="<序号>">`，可点的词再加 `jlpt-word`；一个词跨多个文字节点时分成几段，每段同样的 `data-s`/`data-i`。
  - `class Marker`：`constructor(site, {onStatus})`；`start()`；`retokenize()`；`sentence(id) -> {id, paragraph, tokens, spans: HTMLElement[][]} | undefined`；`onRewrap(callback)`。
    - `start()`：找不到正文时 `onStatus({state: 'error', errors: [scriptInfo('locate', '页面上找不到 <选择器>', '', false)]})`。否则立即读取各段文字并请求分词（每批最多 200 段、2 万字，超出就分批），等 `load` 事件后再用 `requestAnimationFrame` 包词。
    - 句子编号在整页内递增；缓存 `Map<段落文字, [{id, tokens}]>`，同一段文字重包时沿用原编号。
    - 用 `MutationObserver` 监听 `document.documentElement`，一帧内合并处理：找出不在 `.jlpt-t` 内的段落，有缓存的直接重包；没缓存的新段落补发分词后再包。
    - `document.documentElement.dataset.jlptWords` 为当前 `.jlpt-word` 数，`dataset.jlptRewraps` 为重包次数（测试与抽查脚本读取）。
    - 某段包词失败：记 `scriptInfo('mark', '分词结果和原文对不上', '第 N 段')`，其余段落照常。
    - 状态：`{state: 'tokenizing' | 'ready' | 'error', errors: [info]}`。
- Produces（`dock.mjs`）：`mountDock(layer, {onRetokenize}) -> {setStatus(status)}`：右下角圆按钮（文字「分词中…」「就绪」「出错」），点开是菜单：错误行（`errorLine`）列表、「重新分词」按钮。Task 9 在菜单顶部加模型选择。
- 页面样式（`injectPageStyle`）：`<parts> { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none }`。

- [ ] **Step 1: 写失败测试**

```js
test('words are marked after load and every tappable character is covered')          // data-jlpt-words > 0；每个 .jlpt-t 的文字拼起来等于对应段落去掉空白后的文字
test('a word split by inline elements is one word in two pieces')                    // <b> 切开的词：两段 span 同 data-s/data-i
test('paragraphs with spaces, nbsp, emoji and line breaks are fully marked')         // 菜单中没有「标出词」错误；这几段都有 .jlpt-word
test('a re-render is re-marked from the cache without asking the server again')      // ?rerender=1500：之后 data-jlpt-rewraps ≥ 1，.jlpt-word 数不变，服务器 /tokenize 只收到 1 次请求（从 fixture 状态目录的请求记录读取）
test('a long article is tokenized in batches under the server limits')               // ?long=1：/tokenize 请求 ≥ 2 次，每次 ≤ 200 段且 ≤ 20000 字；250 段都被标出
test('a missing article body is reported as 找到正文 and cannot be retried')         // ?missing=1：按钮显示「出错」，菜单中有「找到正文失败：页面上找不到 .article_body」，无「重试」
test('a paragraph the tokens do not fit is skipped and named')                      // fixture 对含「ズレ」的段落返回多一个字的词：菜单中有「标出词失败（第 N 段）」，其他段落照常可点
```

为最后一项，`browser_fixture.py` 的 `fixture_sentences` 在段落含「ズレ」时把第一个词改为原文没有的文字；分词请求记录写到状态目录 `news-tokenize-requests.json`（每次请求的段数与总字数）。

- [ ] **Step 2: 运行确认失败。** `npm run build && node --test tests/server/news-userscript.test.mjs`
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: 提交** — `feat(news): 在原页面上标出词并在重渲染后重包`

---

### Task 9: 点词、长按选句、拖选与模型选择

**Files:**
- Create: `news-client/reader.mjs`（由旧 `web/news/reader.mjs` 的「Selection state」与「Gestures」部分改写）、`news-client/wordcard.mjs`（由旧 `web/news/wordcard.mjs` 改写）
- Modify: `news-client/dock.mjs`（加入旧 `web/news/header.mjs` 的模型选择）、`news-client/main.mjs`、`news-client/ui.css`
- Test: `tests/server/news-userscript.test.mjs`

**Interfaces:**
- Consumes: Task 8 `Marker.sentence(id)`、`onRewrap`；`.jlpt-t[data-s][data-i]`、`.jlpt-word`。
- Produces（`reader.mjs`）：`mountReader(marker, roots)`；在 `document` 上派发 `jlpt:select-sentence {sentenceId}`、`jlpt:select-part {sentenceId, start, end}`，监听这两个事件更新选区；导出 `currentSelection()`、`clearSelection()`。常量沿用 `LONG_PRESS_MS = 500`、`MOVE_TOLERANCE_PX = 10`。
  - 和旧阅读页的差别：一个词可能有多段 span，所以高亮给该词的所有段加类名——选中句加 `jlpt-sel`，选中部分加 `jlpt-part`；`indexAt` 按词的所有段的矩形判断；每次 `marker.onRewrap` 后重新上色。
  - 手势只在 `roots` 内开始。`roots` 上捕获阶段的 `click`：目标在 `.jlpt-t` 内时 `preventDefault()`，在链接里点词不会跳转。`contextmenu`、`selectstart` 照旧阻止。
- Produces（`wordcard.mjs`）：`showWordCard(tokenEl, token, sentenceId, index)`、`closeWordCard()`、`LOOKUP_DELAY = 150`。卡片放在 Shadow DOM 的 `layer` 中，`position: fixed`，按词的视口坐标定位（不再加 `scrollX/Y`），页面滚动时关闭。
- Dock 菜单顶部是「模型：××」，点开为模型列表（`/api/news/models`、`/api/news/settings`），行为与文字同旧页头：「模型：未选择」「模型：<名称>（不可用）」。
- 页面样式加上：`.jlpt-sel { background: <淡黄> }`、`.jlpt-part { background: <较深的黄> }`。

- [ ] **Step 1: 写失败测试**（把旧 `browser.test.mjs` 中的 `pointer`、`at`、`tap`、`longPress`、`drag` 辅助函数复制过来，选择器改为 `.jlpt-t`；设备 `['iPad Pro 11', 'iPhone 13']`）

```js
test(`tap word shows reading and gloss; rapid taps keep only last on ${device}`)        // 同旧测试；卡片在 jlpt-news 的 Shadow DOM 中（Playwright 选择器可穿透）
test(`punctuation is not tappable on ${device}`)
test(`tapping a word inside a link looks it up and does not navigate on ${device}`)    // 关键词链接与图片说明：page.url() 不变，卡片出现
test(`long press selects whole sentence on ${device}`)                                 // 该句所有 span 都有 jlpt-sel
test(`drag inside selected sentence snaps to whole words on ${device}`)
test(`drag past sentence end clamps to sentence on ${device}`)
test(`drag keeps numbers with their counters and trims only punctuation on ${device}`)
test(`dragging outside selected sentence scrolls on ${device}`)
test(`a re-render keeps the selected sentence highlighted and words tappable on ${device}`) // ?rerender=3000：先长按选句，等重包后 jlpt-sel 仍在同一句，点词仍弹卡
test(`the dock switches model and persists on ${device}`)                              // 同旧「header switches model」
test(`the dock shows the error line when the chosen model is unavailable on ${device}`)
test('a device revoked while reading shows 令牌已失效 with 重新安装 in the word card') // 作废后点词：卡片中错误行含「令牌已失效，请重新安装脚本」与「重新安装」链接，无「重试」
```

- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: 提交** — `feat(news): 原页面上点词、长按选句、拖选与模型选择`

---

### Task 10: 分析面板与连续追问

**Files:**
- Create: `news-client/panel.mjs`（由旧 `web/news/panel.mjs` 改写）
- Modify: `news-client/main.mjs`、`news-client/ui.css`（面板样式取自旧 `web/news/news.css`）
- Test: `tests/server/news-userscript.test.mjs`

**Interfaces:**
- Consumes: Task 9 的事件与 `clearSelection()`；Task 8 `Marker.sentence(id)`；Task 4 的请求体。
- Produces: `mountPanel(layer, marker)`；行为与旧面板相同（状态 `{sentenceId, start, end, analysisText, analysis, history}`，不再有 `articleId`）。差别：
  - 分析请求体为 `{paragraph: s.paragraph, tokens: s.tokens.map(t => t.s), start, end}`；追问在此基础上加 `analysis`、`history`、`question`。
  - 语法卡链接为 `JLPT_NEWS.base + card`，`target="_blank"`、`rel="noopener"`。
  - 面板在 Shadow DOM 中；宽屏判断沿用 `(min-width: 900px) and (orientation: landscape)`，宽屏时宽度为 `35vw`。

- [ ] **Step 1: 写失败测试**（逐项改写旧 `browser.test.mjs` 中的面板测试，只改选择器与入口）

```js
test(`sentence only shows 原文/译文/语法 without selection block on ${device}`)
test(`part selection adds selection block and puts related grammar first on ${device}`)
test(`grammar row expands and links to grammar card on ${device}`)                     // 链接 href 以本站地址开头、target _blank
test(`follow-up keeps context within sentence and sends history on ${device}`)
test(`switching sentence while streaming discards the old stream on ${device}`)
test(`changing part keeps follow-ups on ${device}`)
test(`model error shows stage line; format leftovers shown under 其他内容 on ${device}`)
test(`a question asked during the analysis waits and carries the final analysis on ${device}`)
test(`closing the panel mid-analysis stops the stream and reopening starts empty on ${device}`)
test('a long answer is cut to the server limit when it is sent back as history')
test(`iPad landscape panel on right; iPhone bottom sheet on ${device}`)                // iPad 横屏：面板左边缘约在视口 65% 处，文章仍可点词
test('the analysis request carries the paragraph and the sentence words')              // 从 fixture 记录的 FakeHub 请求中，用户消息含该段落与句子
```

- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行确认通过** — `npm run build && npm run test:browser && npm run test:client && npm run test:server`。
- [ ] **Step 5: 提交** — `feat(news): 原页面上的分析面板与连续追问`

---

### Task 11: 真实雅虎抽查脚本与部署文档

**Files:**
- Create: `scripts/news_check.mjs`、`scripts/news_check_server.py`
- Modify: `docs/server-deployment.md`（新闻一节：删除抽查脚本 `news_probe.py`、文章与图片缓存的说明；新增安装步骤、`news_sites` 配置、抽查脚本、上线前人工检查）

**Interfaces:**
- `scripts/news_check_server.py <state目录> <端口> <证书> <私钥>`：用真实分词启动本站服务（HTTPS，自签证书，不配置 qoder2api-hub），`news_sites` 用缺省值；启动后用 `DeviceStore.install('抽查')` 生成令牌，向标准输出打印一行 JSON `{"base": ..., "loader": <loader_script 文本>}`。
- `scripts/news_check.mjs [--per-feed N=2] [--feed slug]…`：生成临时自签证书（`openssl`）；启动上面的服务（`/srv/jlpt/venv/bin/python -I`）；从雅虎 RSS（分类 `top-picks domestic world business entertainment sports it science`）取话题页，再取话题页中的第一个 `/articles/<hex>` 地址；用 Playwright WebKit（`iPhone 15`，`ignoreHTTPSErrors: true`）`addInitScript(loader)` 打开每篇文章，等 `load` 后 10 秒。每篇输出一行：分类、地址、找到正文（是/否）、词数（`data-jlpt-words`）、重包次数（`data-jlpt-rewraps`）、右下角状态与错误摘要。有文章失败或一篇都没取到时，退出码为 1。
- 需要事先 `npm run build`（`server-public/news-script/client.js`）。

- [ ] **Step 1: 在服务器上运行** — `npm run build && node scripts/news_check.mjs --per-feed 1`。预期：8 行，每行「找到正文：是」、词数 > 0、无错误；退出码 0。
- [ ] **Step 2: 更新 `docs/server-deployment.md`**，写清：
  - 安装：
    1. 在 App Store 安装 Userscripts；
    2. 在 Safari 设置里启用扩展，并允许它在 `news.yahoo.co.jp` 上运行；
    3. 登录本站，打开「新闻脚本」，点「安装到这台设备」，在扩展弹窗中点安装；
    4. 安装提示不出现时，改点「下载脚本文件」，把文件存进 Userscripts 的脚本文件夹。
  - 配置 `news_sites` 的格式（缺省值见 Global Constraints）；加网站后各设备重装一次加载器。
  - 抽查命令与输出说明。
  - 上线前人工检查：在 iPad 与 iPhone 上点词、长按、拖选、面板、追问各试一次；打开一篇多页文章，翻到第 2 页后确认词仍被标出。
  - 旧文章与图片目录由服务启动时的清理自动删除。
- [ ] **Step 3: 提交** — `git add scripts/news_check.mjs scripts/news_check_server.py docs/server-deployment.md && git commit -m "feat(news): 真实雅虎抽查脚本与部署说明"`
