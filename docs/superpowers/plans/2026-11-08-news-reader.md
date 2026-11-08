# 新闻阅读（雅虎新闻、查词、句子分析与连续追问）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 JLPT 网站增加 `/news/`：读雅虎新闻，点词查读音与释义，长按选句看译文、选中部分作用与 N5–N1 语法，并可连续追问。

**Architecture:** Python 标准库后端新增 `server/news_*.py` 若干模块：抓取与整理（雅虎）、切句分词（fugashi）、存储与清理、qoder2api-hub 流式客户端、提示词与增量 XML 解析，由 `server/news.py` 挂到现有 `app.py` 路由。前端是 `web/news/` 下的原生 JS 模块，通过 `fetch` 读取 Server-Sent Events。每个错误都带「环节」，前后端统一显示。

**Tech Stack:** Python 3.12 标准库 + fugashi（独立 venv）；原生 ES modules；Caddy；Playwright WebKit；本机 qoder2api-hub（OpenAI Chat Completions 兼容，`127.0.0.1:8790`）。

**Spec:** `docs/superpowers/specs/2026-11-08-news-reader-design.md`

## Global Constraints

- 仅接受 `https://news.yahoo.co.jp/pickup/<数字>` 与 `https://news.yahoo.co.jp/articles/<hex>`；不跟随跳转到其他主机。
- RSS 分类与 slug：主要 `top-picks`、国内 `domestic`、国际 `world`、经济 `business`、娱乐 `entertainment`、体育 `sports`、IT `it`、科学 `science`；RSS 缓存 10 分钟。
- 抓取：单次请求超时 10 秒；多页间隔约 0.5 秒；同一篇文章并发打开只抓一次。
- 存储：文章与图片 7 天；释义缓存 30 天；图片单张上限 5 MB；新闻目录总上限 300 MB（超出先删最早的文章）；启动时及每小时清理。
- 查词与分析记录不保存；追问对话由页面每次随请求发送，服务器不留存。
- 模型：查词、分析、追问共用页头选定的模型（`state/news/settings.json`），`reasoning_effort` 为 `low`；模型不可用时不自动换模型。
- 超时：模型 30 秒内无任何输出或总时长超过 2 分钟按超时处理；模型请求同时最多 3 个。
- 追问只发送最近 6 轮问答。
- 提示词只放带说明的模板，不放具体例句；模板文字照抄 spec 第 5 节。
- 错误环节（`stage` → 中文）：`client` 网页→服务器、`yahoo` 抓取雅虎、`parse` 解析正文、`tokenize` 切句分词、`image` 下载图片、`gateway` 服务器→qoder2api-hub、`model` 模型生成、`format` 解析回复、`stream` 推送到网页。
- 请求编号格式 `n-YYYYMMDD-xxxx`（4 位十六进制）；日志不记录密码、Cookie、API Key。
- 页面简洁：分析面板不放朗读按钮、快捷追问按钮或装饰性分隔符；查词卡保留朗读（`speechSynthesis`，`ja-JP`）。
- 自动测试不访问真实雅虎；除「真实模型测试」一组外不调用真实模型。仓库中不放新闻原文，样例正文自写。

## Review Focus

- 拖选时手指越过句子边界或从句尾往回拖：选区应夹在当前句内并对齐整词，不应选中别句或空选。→ Task 9 测试 `drag past sentence end clamps to sentence`。
- 正在生成时连续长按两句：第一句的回答不应出现在第二句的面板里。→ Task 10 测试 `switching sentence while streaming discards the old stream`。
- 模型把 XML 标签写在 Markdown 代码块里（```xml … ```）或在标签内用了 `&`、`<`：应仍能解析出各段。→ Task 5 测试 `fenced_and_unescaped_xml_still_parses`。
- 文章已在服务器过期删除后，页面仍开着并发起句子分析：应返回明确错误（环节「解析正文」，原因「文章缓存已过期，请重新打开」），而不是 500。→ Task 6 测试 `analyze_after_article_expired_reports_reopen`。
- 文章段落里出现引号嵌套与句末无句号（如「…と述べた」后直接换行、标题无句号）：切句不能丢字，所有 token 拼接后应等于原文。→ Task 1 测试 `tokens_reassemble_original_text`。

---

### Task 1: 分词环境与切句分词

**Files:**
- Create: `requirements-news.txt`、`server/news_text.py`
- Test: `tests/server/test_news_text.py`

**Interfaces:**
- Produces:
  - `split_sentences(text: str) -> list[str]`：按「。！？」与换行切，「」『』内不切；去掉纯空白句；拼接后（忽略空白）等于原文。
  - `tokenize(sentence: str) -> list[dict]`：每项 `{"s": 原文, "r": 平假名读音或 "", "l": 词典形, "p": 词性大类(日文，如 "名詞"), "t": 是否可点}`；标点（`補助記号`/`記号`/空白）与数字 `t=False`。
  - `to_sentences(text: str, start_id: int) -> list[dict]`：`[{"id": int, "tokens": [...]}]`，id 从 `start_id` 递增。
  - `class TokenizerUnavailable(Exception)`：fugashi 或词典缺失时由 `tokenize` 抛出。

- [ ] **Step 1: 测量词典占用并选定**

在 scratch venv 中分别装 `fugashi unidic-lite` 与 `fugashi ipadic`，各自加载并分词 1000 句，记录 `du -sh` 与进程 RSS 增量。RSS 增量 ≤ 150 MB 选 unidic-lite，否则选 ipadic。把选择和数字写入 `requirements-news.txt` 顶部注释，钉死版本（如 `fugashi==1.4.0`、`unidic-lite==1.0.8`）。
Expected: 记录两组数字，`requirements-news.txt` 只含选中的一组。

- [ ] **Step 2: 写失败测试**

```python
class NewsTextTests(unittest.TestCase):
    def test_split_keeps_quotes_whole(self):
        self.assertEqual(split_sentences('彼は「明日行く。必ず。」と言った。次だ'),
                         ['彼は「明日行く。必ず。」と言った。', '次だ'])
    def test_tokens_carry_reading_lemma_and_tappable(self):
        toks = tokenize('台風は強い勢力で接近し、10日に到着。')
        by = {t['s']: t for t in toks}
        self.assertEqual(by['勢力']['r'], 'せいりょく'); self.assertTrue(by['勢力']['t'])
        self.assertEqual(by['接近']['l'], '接近')
        self.assertFalse(by['、']['t']); self.assertFalse(by['10']['t'])
        self.assertTrue(by['は']['t'])            # 助词可点
    def test_tokens_reassemble_original_text(self):
        text = '首相は「検討する」と述べた\n見出しに句点なし'
        joined = ''.join(t['s'] for s in to_sentences(text, 0) for t in s['tokens'])
        self.assertEqual(joined.replace('\n', ''), text.replace('\n', ''))
    def test_sentence_ids_continue_from_start(self):
        self.assertEqual([s['id'] for s in to_sentences('一。二。', 5)], [5, 6])
```

（`接近し` 的词典形取决于词典：unidic 把 `接近し` 切成 `接近`+`し`，ipadic 同样；断言按 Step 1 选定的词典核对一次。）

- [ ] **Step 3: 运行确认失败** — Run: `/srv/jlpt/venv/bin/python -m unittest tests.server.test_news_text -v` Expected: ImportError。
- [ ] **Step 4: 实现 `server/news_text.py`** — fugashi `Tagger` 延迟到首次 `tokenize` 创建并复用（加锁）；读音取 `kana`（unidic）或 `reading`（ipadic）字段，片假名转平假名；数字判定用 `str.isdigit()` 或词性 `数詞`。
- [ ] **Step 5: 运行确认通过**，同时 `python3 -m unittest discover -s tests/server -q` 仍全部通过（系统 python 无 fugashi 时，本测试文件用 `skipUnless(importlib.util.find_spec('fugashi'))` 跳过并打印原因）。
- [ ] **Step 6: Commit** — `git commit -m "feat(news): 切句与分词（fugashi）"`

---

### Task 2: 错误结构与雅虎抓取整理

**Files:**
- Create: `server/news_errors.py`、`server/news_yahoo.py`、`tests/server/news_fixtures/`（`pickup.json`、`single.json`、`multi_p1.json`、`multi_p2.json`、`multi_p3.json`、`video.json`、`broken.html`、`rss.xml`）、`tests/server/news_fixture.py`
- Test: `tests/server/test_news_yahoo.py`

**Interfaces:**
- Produces（`news_errors.py`）：
  - `STAGES: dict[str, str]`（Global Constraints 中的 9 个环节）。
  - `new_request_id(now=None) -> str`
  - `class NewsError(Exception)`：`__init__(stage, reason, location=None, retryable=True, request_id=None)`；`to_dict() -> {"stage","stage_label","location","reason","retryable","request_id","time"}`，`time` 为 `HH:MM:SS`。
- Produces（`news_yahoo.py`）：
  - `FEEDS: dict[str, str]`：slug → 中文名，顺序同 Global Constraints。
  - `validate_url(url: str) -> str`：返回规范化 URL；不合规抛 `ValueError('只支持雅虎新闻的链接')`。
  - `class Yahoo`：`__init__(self, fetch=http_fetch, sleep=time.sleep)`；`fetch(url) -> bytes`，HTTP 非 200 抛 `NewsError('yahoo', f'雅虎返回 {status}', location)`。
    - `feed(slug) -> list[{"title","url","time"}]`（`time` 为 ISO 字符串）。
    - `open(url, progress) -> dict`：`progress(stage, text)` 回调；返回原始文章 `{"id","url","title","media","published","author","pages":{"total","fetched","missing":[int]},"blocks":[...],"errors":[NewsError.to_dict()]}`；`blocks` 项：`{"type":"heading","text"}`、`{"type":"paragraph","text"}`、`{"type":"image","src","caption","credit"}`、`{"type":"video","url"}`、`{"type":"unknown","url"}`。
  - `http_fetch(url) -> tuple[int, bytes]`：`urllib` 10 秒超时，`redirect` 处理器拒绝非 `news.yahoo.co.jp` 主机。
- 测试辅助 `tests/server/news_fixture.py`：`fake_fetch(mapping: dict[str, tuple[int, bytes] | Exception])`，以及 `load(name) -> bytes`（把 JSON 样例包进 `<script>window.__PRELOADED_STATE__ = …</script>` 页面）。

样例：照 spec 第 2 节的真实结构（`articleDetail.paragraphs[].head/textDetails/objectItems`、`richBody`、`currentPage/maxPage`、`topicsDetail.article.url`），正文为自写日语。`video.json` 的 `richBody` 含 `yjrf-yvp`；再加一个未知元素 `yjrf-table`。

- [ ] **Step 1: 写失败测试**

```python
def test_pickup_resolves_and_multi_page_merges_in_order(self):
    y = Yahoo(fetch=fake_fetch({P: load('pickup'), A: load('multi_p1'), A+'?page=2': load('multi_p2'), A+'?page=3': load('multi_p3')}), sleep=lambda s: None)
    art = y.open(P, progress=lambda *a: None)
    texts = [b['text'] for b in art['blocks'] if b['type'] == 'paragraph']
    self.assertEqual(texts, ['一頁目の本文。', '二頁目の本文。', '三頁目の本文。'])
    self.assertEqual(art['pages'], {'total': 3, 'fetched': 3, 'missing': []})
def test_missing_page_keeps_rest_and_records_error(self):  # page 3 → 503
    ...; self.assertEqual(art['pages']['missing'], [3])
    self.assertEqual(art['errors'][0]['stage'], 'yahoo'); self.assertEqual(art['errors'][0]['location'], '第 3 页 / 共 3 页')
def test_image_caption_heading_video_and_unknown_blocks(self):
    types = [b['type'] for b in art['blocks']]
    self.assertIn('video', types); self.assertIn('unknown', types)
    img = next(b for b in art['blocks'] if b['type'] == 'image'); self.assertEqual(img['caption'], '画像：テスト')
def test_broken_page_raises_parse_stage(self):
    with self.assertRaises(NewsError) as cm: y.open(A, progress=...)
    self.assertEqual(cm.exception.stage, 'parse')
def test_validate_url_rejects_lookalikes(self):
    for bad in ('https://news.yahoo.co.jp.evil.com/articles/ab', 'http://127.0.0.1/articles/ab',
                'https://news.yahoo.co.jp/articles/ab/comments', 'https://example.com/pickup/1'):
        with self.assertRaises(ValueError): validate_url(bad)
def test_feed_parses_rss(self):
    self.assertEqual(y.feed('domestic')[0], {'title': '見出し一', 'url': 'https://news.yahoo.co.jp/pickup/1', 'time': '2026-11-08T06:51:34+00:00'})
def test_progress_reports_each_page(self):
    calls = []; y.open(P, progress=lambda s, t: calls.append(t))
    self.assertIn('正在抓取雅虎（第 2 / 3 页）…', calls)
def test_request_id_format(self):
    self.assertRegex(new_request_id(), r'^n-\d{8}-[0-9a-f]{4}$')
```

- [ ] **Step 2: 运行确认失败** — `python3 -m unittest tests.server.test_news_yahoo -v` → ImportError。
- [ ] **Step 3: 实现两个模块** — `__PRELOADED_STATE__` 用正则取出后 `json.loads`；正文以 `paragraphs` 为准，`head` → heading，`objectItems` → image（取 `resizedViewUrl.jpeg` 或 `view.uri`），`textDetails[].text` → paragraph；遍历 `richBody`，`yjrf-yvp` → video，除 `yjrf-article/yjrf-paragraph/figure/figcaption/yjrf-img/p/h2/a/br/strong/em/span` 外的元素 → unknown。RSS 用 `xml.etree`。
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: Commit** — `feat(news): 错误环节结构与雅虎抓取整理`

---

### Task 3: 存储、图片与清理

**Files:**
- Create: `server/news_store.py`
- Test: `tests/server/test_news_store.py`

**Interfaces:**
- Consumes: `NewsError`（Task 2）。
- Produces: `class NewsStore(root: Path, now=time.time)`：
  - `save_article(article: dict)`、`load_article(article_id) -> dict`（不存在抛 `KeyError`）。
  - `save_image(article_id, index, data: bytes)`（超过 5 MB 抛 `NewsError('image', '图片超过 5 MB', f'第 {index+1} 张')`）、`image_path(article_id, index) -> Path`。
  - `single_flight(key) -> contextmanager`：同 key 并发时后来者等待前者完成。
  - `glossary_get(model, lemma, pos) -> str | None`、`glossary_put(model, lemma, pos, meaning)`（sqlite `glossary.sqlite`）。
  - `settings() -> dict`、`save_settings(dict)`（`settings.json`，默认 `{"model": None}`）。
  - `cleanup()`：删 7 天前的文章目录（按 `article.json` 修改时间）、30 天前的释义；总大小超 300 MB 时按修改时间从旧到新删文章直到 ≤ 300 MB。
- 常量：`ARTICLE_TTL = 7*86400`、`GLOSS_TTL = 30*86400`、`IMAGE_MAX = 5*1024*1024`、`TOTAL_MAX = 300*1024*1024`。

- [ ] **Step 1: 写失败测试** — `test_articles_expire_after_7_days`（`now` 前进 7 天+1 秒后 `load_article` 抛 KeyError）、`test_glossary_expires_after_30_days_and_is_keyed_by_model`（同词不同模型各自独立）、`test_total_size_cap_deletes_oldest_first`（把 `TOTAL_MAX` 用 `mock.patch` 改小为 3000，写三篇各 1500 字节，保留最新一篇）、`test_oversized_image_rejected_with_image_stage`、`test_single_flight_runs_once`（两个线程同 key，计数器为 1）、`test_settings_default_and_roundtrip`。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现** — 目录 `root/news/<id>/article.json`、`root/news/<id>/images/<index>`；文章 id 仅允许 `[0-9a-f]{8,64}`，否则 `ValueError`（防路径穿越）。
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: Commit** — `feat(news): 文章、图片、释义缓存与过期清理`

---

### Task 4: qoder2api-hub 流式客户端

**Files:**
- Create: `server/llm.py`、`tests/server/fake_hub.py`
- Test: `tests/server/test_llm.py`

**Interfaces:**
- Consumes: `NewsError`。
- Produces:
  - `class Hub(base_url: str, api_key: str, first_timeout=30, total_timeout=120)`。
  - `Hub.models() -> list[{"id": str, "name": str}]`：`GET /v1/models`，过滤 `enabled is False`；`name` 取 `name_local` 或 `id`。
  - `Hub.stream(model: str, messages: list[dict]) -> Iterator[str]`：`POST /v1/chat/completions`，`{"model", "messages", "stream": true, "reasoning_effort": "low"}`，逐个产出 `choices[0].delta.content` 文本；生成器被 `close()` 时关闭上游连接。
  - `Hub.complete(model, messages) -> str`：拼接 `stream` 结果（查词用）。
  - 错误映射：连接失败、401 → `gateway`（原因分别为「qoder2api-hub 未运行或无法连接」「API Key 无效」）；429、正文含 `10605` → `model`「模型排队中，请稍后重试」；400/404 且正文提到模型 → `model`「当前模型不可用，请重新选择」（`retryable=False`）；其他 HTTP 错误 → `model`「模型返回 {status}：{前 200 字}」；首个文本 30 秒未到或总计超 120 秒 → `model`「模型 30 秒内没有输出」/「回答超过 2 分钟」；已开始输出后连接断开 → `stream`「回答中断」。
- `tests/server/fake_hub.py`：`FakeHub(script)` 起在随机端口的 HTTP 服务，`script` 为按请求顺序的行为列表：`('chunks', ['<a>', 'b</a>'], delay)`、`('status', 429, body)`、`('silent', seconds)`、`('cut_after', ['部分'])`；记录收到的请求体到 `requests`。

- [ ] **Step 1: 写失败测试** — 每种映射一个测试，断言 `stage` 与 `reason`；`test_stream_yields_chunks_in_order`；`test_request_body_has_low_reasoning_and_stream`（检查 `FakeHub.requests[0]`）；`test_closing_generator_closes_upstream`（关闭后 FakeHub 记录到连接断开）。超时测试用 `first_timeout=0.3`。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现** — `http.client`；读 SSE 行 `data: {...}`、`data: [DONE]`；socket 超时设为剩余时间。
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: Commit** — `feat(news): qoder2api-hub 流式客户端与错误环节映射`

---

### Task 5: 提示词与增量 XML 解析

**Files:**
- Create: `server/news_prompts.py`、`server/news_xml.py`
- Test: `tests/server/test_news_xml.py`

**Interfaces:**
- Produces（`news_prompts.py`）：
  - `GLOSS_TEMPLATE`、`ANALYSIS_TEMPLATE`：照抄 spec 第 5 节两个模板及其规则段。
  - `gloss_messages(lemma, reading, pos) -> list[dict]`
  - `analysis_messages(paragraph: str, sentence: str, selection: str | None) -> list[dict]`
  - `ask_messages(sentence, selection, analysis_text: str, history: list[{"q","a"}], question) -> list[dict]`：只取 `history[-6:]`；要求「用中文、简短、能举例时给一个对比例句」，不套模板。
- Produces（`news_xml.py`）：
  - `parse_gloss(text: str) -> str`：返回 `<meaning>` 内容；缺失抛 `NewsError('format', '回复缺少释义')`。
  - `class AnalysisParser`：`feed(chunk: str) -> list[tuple[str, dict]]`、`close() -> list[tuple[str, dict]]`；事件：`("selection", {"reading","role","meaning"})`、`("translation", {"text"})`、`("grammar", {"form","level","brief","connection","usage","confusable","related": bool})`、`("extra", {"text"})`（close 时把未能解析的剩余文字放这里）。
- 解析方法：自写的按标签扫描器，不用 `xml.etree`（模型输出可能含未转义的 `&`、`<`）：在缓冲区中查找完整的 `<selection>…</selection>`、`<translation>…</translation>`、`<item …>…</item>`，取出后从缓冲区移除，子标签用非贪婪正则提取；去掉 ```` ```xml ```` 围栏；`level` 不在 N1–N5 时置为空串。

- [ ] **Step 1: 写失败测试**

```python
def test_events_emit_as_soon_as_each_section_closes(self):
    p = AnalysisParser(); ev = []
    for ch in split_every(SAMPLE_WITH_SELECTION, 7): ev += p.feed(ch)
    ev += p.close()
    self.assertEqual([e[0] for e in ev], ['selection', 'translation', 'grammar', 'grammar'])
    self.assertTrue(ev[2][1]['related'])
def test_missing_selection_and_confusable_are_fine(self): ...
def test_text_outside_tags_goes_to_extra(self): ...  # 'extra' 事件含多余文字
def test_fenced_and_unescaped_xml_still_parses(self):
    text = '```xml\n<analysis><translation>A & B <注></translation></analysis>\n```'
    self.assertEqual(parse_all(text)[0], ('translation', {'text': 'A & B <注>'}))
def test_bad_level_blanked(self): ...
def test_ask_messages_keep_last_six_rounds(self):
    msgs = ask_messages('文', None, '分析', [{'q': str(i), 'a': str(i)} for i in range(9)], '新')
    self.assertNotIn('2', [m['content'] for m in msgs if m['role'] == 'user'][:-1])
def test_templates_contain_no_sample_sentence(self):
    self.assertNotIn('台風', ANALYSIS_TEMPLATE); self.assertIn('<selection>', ANALYSIS_TEMPLATE)
```

（`SAMPLE_WITH_SELECTION` 用自写句子；`split_every` 把字符串按 n 字切片。）

- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现两个模块。**
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: Commit** — `feat(news): 提示词模板与增量 XML 解析`

---

### Task 6: 新闻接口与路由接入

**Files:**
- Create: `server/news.py`
- Modify: `server/app.py`（`Application.__init__` 创建 `self.news`；`route()` 在 `/api/review/` 分支前加 `/api/news/` 分支；新增流式响应方法）、`server/__main__.py`（启动每小时清理线程）
- Test: `tests/server/test_news_http.py`

**Interfaces:**
- Consumes: Tasks 1–5 全部接口。
- Produces: `class NewsService(config: dict, state: Path, yahoo=None, hub=None)`：
  - `config['llm'] = {"base_url": "http://127.0.0.1:8790", "api_key": "..."}`；缺失时模型类接口报 `gateway`「未配置 qoder2api-hub」。
  - 构造时调用一次 `NewsStore.cleanup()`；`server/__main__.py` 另起守护线程每 3600 秒调用一次。
  - `feeds(slug) -> {"items": [...], "stale_minutes": int | None}`：抓取失败但有缓存时返回缓存并给出分钟数；无缓存时抛 `NewsError('yahoo', …)`。
  - `open(url, emit)`：`emit(event, data)`；事件 `progress {"stage","text"}` → `article {完整文章}`；流程：`validate_url` → `single_flight` → `Yahoo.open` → 对每个 text 块调 `to_sentences`（heading/paragraph/image caption 都切句，句 id 全文递增；image 块改为 `{"type":"image","index","caption_sentences","credit","ok"}`）→ 下载图片（失败记入 `errors`，`ok=False`）→ `save_article`。分词失败抛 `NewsError('tokenize', …)`。
  - `gloss(lemma, reading, pos) -> {"meaning"}`：先查缓存。
  - `analyze(article_id, sentence_id, start, end, emit)`：事件 `progress`、`selection`、`translation`、`grammar`（附 `card`: `"/grammar/#N2/12-12"` 或 `null`）、`extra`、`done {"analysis_text"}`。
  - `ask(article_id, sentence_id, start, end, analysis_text, history, question, emit)`：事件 `progress`、`delta {"text"}`、`done`。
  - `match_card(form, cards) -> str | None`：取卡片 `title` 在第一个「：」「（」「(」之前的部分，按「／」「・」「/」拆开，两边去掉「～」「〜」与空白后完全相等即命中，返回 `/grammar/#{level}/{number}-{number}`；目录读 `config['static']/grammar/catalog.json`，缺失时一律 `None`。
  - 并发：`threading.BoundedSemaphore(3)`；等待时 `emit('progress', {'stage':'model','text':'排队中…'})`。
  - 模型未选择：`NewsError('model', '请先在页头选择模型', retryable=False)`。
  - 文章不存在：`NewsError('parse', '文章缓存已过期，请重新打开', retryable=False)`。
- 路由（`app.py`，均在登录检查之后；POST 已由现有代码做同源检查）：

| 方法 路径 | 处理 |
|---|---|
| `GET /api/news/feeds?cat=` | JSON |
| `POST /api/news/open` `{url}` | SSE |
| `GET /api/news/image/<id>/<n>` | 图片，`Cache-Control: private, max-age=604800` |
| `GET /api/news/models` | JSON `{"models":[...],"selected":str|None}` |
| `POST /api/news/settings` `{model}` | JSON |
| `POST /api/news/gloss` `{lemma,reading,pos}` | JSON |
| `POST /api/news/analyze` `{article,sentence,start,end}` | SSE |
| `POST /api/news/ask` `{article,sentence,start,end,analysis,history,question}` | SSE |

- JSON 出错：HTTP 4xx/5xx，正文 `{"error": NewsError.to_dict()}`。SSE：`Content-Type: text/event-stream`、`Cache-Control: no-store`、`X-Accel-Buffering: no`，无 `Content-Length`、`Connection: close`；每事件 `event: <name>\ndata: <json>\n\n` 后 `flush()`；错误以 `event: error` 发送后结束；写入时 `BrokenPipeError/ConnectionResetError` → 关闭上游生成器并结束（即取消）。
- 日志：`NewsError` 以 `request_id stage reason location url` 一行写 stderr。

- [ ] **Step 1: 写失败测试**（沿用 `test_http.py` 的 setUp 写法；`NewsService` 注入 `Yahoo(fetch=fake_fetch(...))` 与指向 `FakeHub` 的 `Hub`）

```python
def test_news_endpoints_need_login_and_same_origin(self): ...  # 401；POST 异源 403
def test_open_streams_progress_then_article_with_tokens(self):
    events = self.sse('/api/news/open', {'url': P})
    self.assertEqual(events[-1][0], 'article'); self.assertIn('progress', [e for e, _ in events])
    tok = events[-1][1]['blocks'][0]['sentences'][0]['tokens'][0]; self.assertIn('r', tok)
def test_analyze_streams_sections_and_links_card(self):
    # catalog 中有 title '～おそれがある（…）' level N2 number 7
    ev = dict(...); self.assertEqual(grammar_event['card'], '/grammar/#N2/7-7')
def test_analyze_after_article_expired_reports_reopen(self):
    err = self.sse('/api/news/analyze', {...'article': 'ab12cd34'...})[-1]
    self.assertEqual(err, ('error', ANY_WITH(stage='parse', reason='文章缓存已过期，请重新打开')))
def test_no_model_selected_reports_model_stage(self): ...
def test_gloss_cached_second_call_hits_no_hub(self): ...  # FakeHub.requests 长度保持 1
def test_feeds_fall_back_to_stale_cache(self): ...  # 第二次 RSS 503 → stale_minutes 为整数
def test_at_most_three_model_requests_at_once(self): ...  # FakeHub 记录最大并发 == 3（发 5 个）
def test_client_disconnect_cancels_upstream(self): ...  # 读到第一个事件后关闭连接，FakeHub 观察到断开
def test_every_stage_error_has_request_id_and_location(self):
    # 逐个注入：雅虎 503（第 3 页）、分词不可用（patch tokenize 抛 TokenizerUnavailable）、hub 停止、429、模型 404、cut_after、silent
    for case, stage in CASES: self.assertEqual(err['stage'], stage); self.assertRegex(err['request_id'], r'^n-')
```

- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现 `server/news.py` 与 `app.py` 接入**（`app.py` 中仅加路由分支与 `sse(self, run)` 辅助方法；业务逻辑都在 `news.py`）。
- [ ] **Step 4: 运行** `python3 -m unittest discover -s tests/server -q`（在 venv 中运行以覆盖分词路径）。Expected: 全部通过。
- [ ] **Step 5: Commit** — `feat(news): 新闻接口、流式响应与分环节报错`

---

### Task 7: 部署：venv、Caddy 流式与配置

**Files:**
- Modify: `deploy/jlpt.service`（`ExecStart=/srv/jlpt/venv/bin/python -m server --config /srv/jlpt/state/config.json`）、`deploy/Caddyfile`（`@api` 的 `reverse_proxy` 加 `flush_interval -1`）、`scripts/configure_server.py`（新增 `--llm-base-url`、`--llm-api-key`，写入 `config['llm']`，不打印密钥）、`docs/server-deployment.md`（venv 创建：`python3 -m venv /srv/jlpt/venv && /srv/jlpt/venv/bin/pip install -r requirements-news.txt`；配置 llm；回滚说明）
- Test: `tests/server/test_caddy.py`（新增流式用例）、`tests/server/test_setup.py`（llm 配置用例）

**Interfaces:**
- Consumes: Task 6 的 SSE 路由。

- [ ] **Step 1: 写失败测试** — `test_sse_passes_through_caddy_incrementally`：用测试内的最小 `http.server` 后端代替 8765 端口（对 `/api/news/analyze` 先发一个事件、0.5 秒后再发第二个），经 Caddy 读取，断言第一个事件在 0.4 秒内到达（证明未缓冲）；`test_configure_server_writes_llm_without_echoing_key`。
- [ ] **Step 2: 运行确认失败**（`CADDY_BINARY=/usr/bin/caddy python3 -m unittest tests.server.test_caddy -v`）。
- [ ] **Step 3: 修改上述文件。**
- [ ] **Step 4: 运行确认通过；`caddy validate --config deploy/Caddyfile` 通过。**
- [ ] **Step 5: Commit** — `feat(news): 部署 venv、Caddy 流式不缓冲与模型网关配置`

---

### Task 8: 列表页、页头模型选择与公共前端

**Files:**
- Create: `web/news/index.html`、`web/news/news.css`、`web/news/api.mjs`、`web/news/list.mjs`、`web/news/header.mjs`
- Modify: `web/review/index.html`、`web/papers.html` 的 `<nav>` 加 `<a href="/news/">新闻</a>`；`scripts/build-server.mjs` 中语法页注入的导航加同一链接
- Modify: `tests/server/browser_fixture.py`（为 `app.news` 注入假雅虎与 FakeHub，FakeHub 脚本从环境变量 `NEWS_HUB_SCRIPT` 指定的 JSON 读取）
- Test: `tests/server/browser.test.mjs`（新增用例）

**Interfaces:**
- Produces（`api.mjs`）：
  - `getJSON(path) -> Promise<object>`、`postJSON(path, body) -> Promise<object>`：失败时抛 `NewsFailure`，其 `.info` 为错误对象；无响应或非约定格式时由前端生成 `stage:'client'`（`stage_label:'网页→服务器'`，`reason` 如「网络连接失败」「登录已过期」——401 时跳转 `/login.html`）。
  - `streamSSE(path, body, {signal, onEvent}) -> Promise<void>`：`fetch` + `ReadableStream` 解析事件；中途断开且未收到 `done`/`error` 时以 `stage:'stream'`、`reason:'回答中断'` 调 `onEvent('error', …)`。
  - `errorLine(info, onRetry) -> HTMLElement`：一行「{stage_label}失败（{location}）：{reason}　重试」，点开显示 spec 第 6 节的六项；`retryable` 为 false 时不显示「重试」。
  - `progressLine(text) -> HTMLElement`。
- Produces（`header.mjs`）：`mountHeader(el)`：页头标题「新闻」+ 右侧「模型：××」，点开列出 `/api/news/models`，选择后 `POST /api/news/settings`；未选择时显示「模型：未选择」。
- 列表页：分类按 `FEEDS` 顺序；条目显示标题与 `HH:MM`；点标题跳 `/news/read.html?url=<encodeURIComponent(url)>`；底部输入框粘贴链接后同样跳转；`stale_minutes` 不为空时顶部显示「更新失败，显示的是 X 分钟前的列表」。

- [ ] **Step 1: 写失败测试**（WebKit，`devices['iPad Pro 11']` 与 `devices['iPhone 13']`）— `news list shows feeds and opens an article`、`header switches model and persists`、`stale feed shows notice`、`nav links to news from review page`。
- [ ] **Step 2: 运行确认失败**（`npm run build && npm run test:browser`）。
- [ ] **Step 3: 实现页面与模块**，样式沿用 `site.css` 的变量，不加装饰符号。
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: Commit** — `feat(news): 新闻列表页与页头模型选择`

---

### Task 9: 阅读页、查词卡、长按选句与拖选

**Files:**
- Create: `web/news/read.html`、`web/news/reader.mjs`、`web/news/wordcard.mjs`
- Test: `tests/server/browser.test.mjs`

**Interfaces:**
- Consumes: `streamSSE`、`errorLine`、`progressLine`、`postJSON`（Task 8）；文章结构（Task 6）。
- Produces（`reader.mjs`）：
  - 渲染：每个 token 一个 `<span data-s="{句id}" data-i="{词序号}">`；`t=false` 的不响应点击；正文容器 `-webkit-user-select:none; -webkit-touch-callout:none`。
  - 事件（`CustomEvent` 派发在 `document`）：`news:select-sentence {sentenceId}`、`news:select-part {sentenceId, start, end}`。供 Task 10 的面板监听。
  - 交互常量：长按 500 ms，移动超过 10 px 取消长按；已选句设 `touch-action:none`，在其上拖动为选择，拖出句子边界时夹到句首/句尾 token；查词请求以最后一次点击为准（`AbortController`）。
- Produces（`wordcard.mjs`）：`showWordCard(tokenEl, token, sentenceId, index)`：显示「原文　读音　🔊」「词性」「释义（加载中显示进度）」「在本句中的作用」；🔊 调 `speechSynthesis.speak(new SpeechSynthesisUtterance(token.s))`，`lang='ja-JP'`；「在本句中的作用」派发 `news:select-part {sentenceId, start:index, end:index}`。

- [ ] **Step 1: 写失败测试** — `open shows progress then title, media, images and video placeholder`、`tap word shows reading and gloss; rapid taps keep only last`、`punctuation is not tappable`、`long press selects whole sentence`、`drag inside selected sentence snaps to whole words`、`drag past sentence end clamps to sentence`、`dragging outside selected sentence scrolls`、`partial article shows page-missing error line with retry`。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: Commit** — `feat(news): 阅读页、查词卡、长按选句与拖选`

---

### Task 10: 分析面板与连续追问

**Files:**
- Create: `web/news/panel.mjs`
- Modify: `web/news/read.html`（面板容器）、`web/news/news.css`
- Test: `tests/server/browser.test.mjs`

**Interfaces:**
- Consumes: `news:select-sentence`、`news:select-part`（Task 9）；`streamSSE`、`errorLine`、`progressLine`（Task 8）；分析事件（Task 6）。
- Produces: 面板依次显示「原文」（选中部分底色高亮）、选中部分块（读音 / 作用 / 「本句中：」意思，仅 B 情况）、「译文」、「语法」（每条一行：形式、等级、brief；点开显示接续、本句用法、易混淆，有 `card` 时加语法卡链接）、「追问」（「我：」「答：」）、输入框「想问什么…」。
  - 状态：`{sentenceId, start, end, analysisText, history: [{q, a}]}`；换句清空 `history`；同句改选部分保留 `history`；关闭面板清空全部。
  - 每次新分析前 `abort()` 上一个流；渲染前核对事件所属的 `sentenceId` 与当前一致。
  - 布局：`@media (min-width: 900px) and (orientation: landscape)` 时固定在右侧 40% 宽；否则为底部抽屉，可上拉到全屏、下拉关闭。

- [ ] **Step 1: 写失败测试** — `sentence only shows 原文/译文/语法 without selection block`、`part selection adds selection block and puts related grammar first`、`grammar row expands and links to grammar card`、`follow-up keeps context within sentence and sends history`（检查 FakeHub 第二次请求包含第一轮问答）、`switching sentence while streaming discards the old stream`、`changing part keeps follow-ups`、`iPad landscape panel on right; iPhone bottom sheet`、`model error shows stage line; format leftovers shown under 其他内容`。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 运行确认通过。**
- [ ] **Step 5: Commit** — `feat(news): 分析面板与连续追问`

---

### Task 11: 真实模型测试与真实抽查脚本

**Files:**
- Create: `tests/llm/__init__.py`、`tests/llm/test_real_model.py`、`scripts/news_probe.py`
- Modify: `package.json`（`"test:llm": "python3 -m unittest discover -s tests/llm -v"`）、`docs/server-deployment.md`（何时运行这两项）

**Interfaces:**
- Consumes: `Hub`、`news_prompts`、`news_xml`（Tasks 4–5）；`Yahoo`、`to_sentences`（Tasks 1–2）。
- 真实模型测试读取环境变量 `JLPT_LLM_BASE_URL`、`JLPT_LLM_API_KEY`、`JLPT_LLM_MODEL`，缺失时整组 `skip` 并说明原因。

- [ ] **Step 1: 写真实模型测试**（句子全部自写）— `test_gloss_meaning_present_and_short`（每个义项 ≤ 15 字，最多两个，助词「で」也有释义）、`test_analysis_without_selection_has_no_selection_tag`、`test_analysis_with_selection_has_selection_and_related_first`、`test_levels_within_n5_n1_and_required_tags_present`、`test_sections_arrive_incrementally`（第一个事件早于最后一个事件至少 0.3 秒）、`test_follow_up_uses_previous_round`（第二问「那换成に呢」的回答提到「に」）。
- [ ] **Step 2: 运行** — `JLPT_LLM_API_KEY=… JLPT_LLM_MODEL=… /srv/jlpt/venv/bin/python -m unittest discover -s tests/llm -v`。Expected: 全部通过；若格式类失败，调整 `news_prompts.py` 的规则措辞后重跑，并在 Task 5 测试中补对应回归用例。
- [ ] **Step 3: 写 `scripts/news_probe.py`** — `--per-feed 3`；对每个分类取前 N 条，`Yahoo.open` + `to_sentences`，输出每篇「分类 / 页数 / 图片数 / 结果」，失败行带 `stage` 与 `reason`；末行汇总「成功 x / 共 y」。退出码：有失败为 1。
- [ ] **Step 4: 运行** — `/srv/jlpt/venv/bin/python scripts/news_probe.py --per-feed 3`。Expected: 末行「成功 24 / 共 24」或列出失败及环节。
- [ ] **Step 5: Commit** — `test(news): 真实模型测试与真实抽查脚本`

---

### Task 12: 上线

**Files:**
- Modify: `docs/server-deployment.md`（本次发布记录：发布目录、venv、回滚路径）

- [ ] **Step 1:** `python3 -m venv /srv/jlpt/venv && /srv/jlpt/venv/bin/pip install -r requirements-news.txt`，记录 `du -sh /srv/jlpt/venv`。
- [ ] **Step 2:** `python3 scripts/configure_server.py … --llm-base-url http://127.0.0.1:8790 --llm-api-key <qoder2api-hub 中为本站新建的 Key>`。
- [ ] **Step 3:** `python3 scripts/prepare_release.py --name <UTC时间>-news`，`node scripts/build-server.mjs <新版本>/static`，切换 `/srv/jlpt/app` 与 `/srv/jlpt/static`，安装新的 `jlpt.service` 与 Caddyfile，`caddy validate` 后 `systemctl daemon-reload && systemctl restart jlpt.service && systemctl reload caddy`。
- [ ] **Step 4:** 验证：`/news/` 未登录 303 到登录页；登录后 `python3 scripts/news_probe.py --per-feed 1` 通过；`systemctl show jlpt.service -p MemoryCurrent` 记录内存；`/review/`、`/grammar/`、`/papers.html`、`/code/` 仍正常。
- [ ] **Step 5:** 请用户在 iPad 与 iPhone 上实际操作长按、拖选与面板，记录结果到 `docs/server-deployment.md`。
- [ ] **Step 6: Commit** — `docs: 记录新闻阅读发布与回滚路径`
