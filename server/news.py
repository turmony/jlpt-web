"""News reader service: feeds, opening articles, word glosses, sentence analysis and follow-up
questions. HTTP wiring lives in app.py; everything here is plain Python driven by `emit(event,
data)` callbacks so the streaming endpoints can be tested without a browser.

Every failure is a NewsError naming the stage that failed (spec section 6). Errors raised inside a
stream become an `error` event; each one is logged to stderr as
`request_id stage reason location url` (never passwords, cookies or API keys).
"""
import contextlib
import json
import re
import sys
import threading
import time
from pathlib import Path

from .llm import Hub, R_UNAVAILABLE
from .news_errors import NewsError
from .news_prompts import MAX_HISTORY_ROUNDS, analysis_messages, ask_messages, gloss_messages
from .news_store import ARTICLE_TTL, ID_RE, KEY_RE, NewsStore, image_key
from .news_text import TokenizerUnavailable, to_sentences
from .news_xml import AnalysisParser, parse_gloss
from .news_yahoo import FEEDS, HOST, Yahoo, article_id_of, validate_url

FEED_TTL = 600
REUSE_SECONDS = 60          # a second open of the same URL right after the first reuses a complete result
MODEL_SLOTS = 3
CLEANUP_INTERVAL = 3600
PING_GAP = 0.5
MAX_QUESTION = 500
MAX_HISTORY_TEXT = 4000
MAX_ANALYSIS = 20000
KEY_SHOWN = 16              # hex digits of an image's file key given to the page (cache-busting only)

R_EXPIRED = '文章缓存已过期，请重新打开'
R_NO_MODEL = '请先在页头选择模型'
R_NO_HUB = '未配置 qoder2api-hub'

_CARD_CUT = re.compile('[：（(]')
_CARD_SPLIT = re.compile('[／・/]')
_CARD_TRIM = ' \t\r\n　〜～'
_LEVEL = re.compile(r'N[1-5]')


def _source_ok(source, article_id):
    """Whether a stored `cache.source` has the shape Yahoo.open(known=...) expects."""
    if not isinstance(source, dict) or source.get('id') != article_id:
        return False
    if not all(isinstance(source.get(key), str) for key in ('url', 'title', 'media', 'published', 'author')):
        return False
    try:
        if article_id_of(validate_url(source['url'])) != article_id:
            return False
    except ValueError:
        return False
    pages, page_blocks = source.get('pages'), source.get('page_blocks')
    if not isinstance(pages, dict) or type(pages.get('total')) is not int or not isinstance(page_blocks, list):
        return False
    numbers = []
    for item in page_blocks:
        if not (isinstance(item, list) and len(item) == 2 and type(item[0]) is int and isinstance(item[1], list)
                and all(isinstance(block, dict) for block in item[1])):
            return False
        numbers.append(item[0])
    return 1 in numbers


class ClientGone(BaseException):
    """The browser closed the stream. A BaseException so generic handlers never swallow it."""


def client_error(reason):
    return NewsError('client', reason, retryable=False)


def http_status(error):
    return 400 if error.stage == 'client' else 502


def sse_frame(event, data=None):
    """One Server-Sent Events frame; event None is a comment line used to notice a closed client."""
    if event is None:
        return b': ping\n\n'
    return ('event: %s\ndata: %s\n\n' % (event, json.dumps(data, ensure_ascii=False))).encode('utf-8')


def sniff_image(data):
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp'
    if data[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif'
    return None


def _norm_form(text):
    return text.strip(_CARD_TRIM) if isinstance(text, str) else ''


def match_card(form, cards):
    """Grammar card link for a model's <form>, or None. Card titles are cut at the first
    「：」「（」「(」 and split on 「／」「・」「/」; both sides drop 〜/～ and whitespace at the ends;
    only exact equality counts."""
    target = _norm_form(form)
    if not target or not cards:
        return None
    for card in cards:
        if not isinstance(card, dict):
            continue
        title, level, number = card.get('title'), card.get('level'), card.get('number')
        if not isinstance(title, str) or not isinstance(level, str) or not _LEVEL.fullmatch(level) \
                or type(number) is not int:
            continue
        head = _CARD_CUT.split(title, 1)[0]
        if any(_norm_form(part) == target for part in _CARD_SPLIT.split(head)):
            return '/grammar/#%s/%d-%d' % (level, number, number)
    return None


def _text(sentences):
    return ''.join(t['s'] for s in sentences for t in s['tokens'])


@contextlib.contextmanager
def _located(label):
    """Give NewsErrors raised inside a location when they have none."""
    try:
        yield
    except NewsError as error:
        if not error.location:
            error.location = label
        raise


def start_cleanup(service, interval=CLEANUP_INTERVAL, stop=None):
    """Daemon thread calling service.store.cleanup() every `interval` seconds."""
    stop = stop or threading.Event()

    def loop():
        while not stop.wait(interval):
            try:
                service.store.cleanup()
            except Exception as error:
                sys.stderr.write('news cleanup failed: %s: %s\n' % (type(error).__name__, error))
                sys.stderr.flush()
    thread = threading.Thread(target=loop, name='news-cleanup', daemon=True)
    thread.start()
    return thread


class NewsService:
    def __init__(self, config, state, yahoo=None, hub=None):
        self.config = config
        self.store = NewsStore(state)
        self.store.cleanup()
        self.yahoo = yahoo or Yahoo()
        llm = config.get('llm') or {}
        if hub is None and llm.get('base_url'):
            hub = Hub(llm['base_url'], llm.get('api_key') or '')
        self.hub = hub
        self.slots = threading.BoundedSemaphore(MODEL_SLOTS)
        self.clock = time.time
        self._lock = threading.Lock()
        self._feeds = {}       # slug -> (fetched_at, items)
        self._recent = {}      # canonical url -> (opened_at, article)
        self._resolved = {}    # topic (pickup) url -> (opened_at, article id): finds the stored copy
        self._catalog = None

    # -- logging & streaming -------------------------------------------------
    def log_error(self, error, url=None):
        info = error.to_dict() if isinstance(error, NewsError) else error
        fields = [info.get('request_id'), info.get('stage'), info.get('reason'), info.get('location'), url]
        line = ' '.join(str(f or '-').replace('\n', ' ') for f in fields)
        sys.stderr.write(line + '\n')
        sys.stderr.flush()

    def guard(self, run, emit, url=None):
        """Run a streaming handler. A NewsError, or any unexpected failure, ends the stream with
        an `error` event; a closed client just stops (the handler already closed upstream)."""
        try:
            run(emit)
            return
        except ClientGone:
            return
        except NewsError as error:
            err = error
        except Exception as error:
            err = NewsError('stream', '服务器内部错误：%s' % type(error).__name__)
        self.log_error(err, url)
        try:
            emit('error', err.to_dict())
        except ClientGone:
            pass

    @staticmethod
    def _progress(emit, stage, text):
        emit('progress', {'stage': stage, 'text': text})

    # -- feeds ---------------------------------------------------------------
    def feeds(self, slug):
        if not isinstance(slug, str) or slug not in FEEDS:
            raise client_error('未知分类')
        now = self.clock()
        with self._lock:
            cached = self._feeds.get(slug)
        if cached and now - cached[0] < FEED_TTL:
            return {'items': cached[1], 'stale_minutes': None}
        try:
            items = self.yahoo.feed(slug)
        except NewsError as error:
            if not cached:
                raise  # logged once by the route that reports it
            self.log_error(error, 'https://%s/rss/topics/%s.xml' % (HOST, slug))
            return {'items': cached[1], 'stale_minutes': int(max(0, now - cached[0]) // 60)}
        with self._lock:
            self._feeds[slug] = (now, items)
        return {'items': items, 'stale_minutes': None}

    # -- opening articles ----------------------------------------------------
    @staticmethod
    def check_url(url):
        try:
            return validate_url(url)
        except ValueError as error:
            raise client_error(str(error))

    def open(self, url, emit):
        url = self.check_url(url)
        with self.store.single_flight(url):
            now = self.clock()
            with self._lock:
                self._recent = {k: v for k, v in self._recent.items() if now - v[0] < REUSE_SECONDS}
                self._resolved = {k: v for k, v in self._resolved.items() if now - v[0] < ARTICLE_TTL}
                hit = self._recent.get(url)
                article_id = article_id_of(url) or self._resolved.get(url, (None, None))[1]
            if hit:
                article = hit[1]
            else:
                # A stored partial copy (missing pages) is refilled: only its missing pages are fetched.
                article = self._build(url, emit, self._stored_partial(article_id))
                with self._lock:
                    if article_id_of(url) is None:
                        self._resolved[url] = (self.clock(), article['id'])
                    # A partial article (missing page, failed image) is not reused: 重试 must fetch again.
                    if not article.get('errors') and not article['pages'].get('missing'):
                        self._recent[url] = (self.clock(), article)
        emit('article', article)

    def _stored_partial(self, article_id):
        """The saved copy of an article that still misses pages and can be refilled, or None."""
        if not article_id:
            return None
        try:
            saved = self.store.load_article(article_id)
        except (KeyError, ValueError):
            return None
        cache = saved.get('cache')
        source = cache.get('source') if isinstance(cache, dict) else None
        pages = saved.get('pages')
        images = cache.get('images') if isinstance(cache, dict) else None
        if not (isinstance(pages, dict) and pages.get('missing') and _source_ok(source, article_id)
                and isinstance(images, list)
                and all(key is None or (isinstance(key, str) and KEY_RE.fullmatch(key)) for key in images)):
            return None
        return saved

    def _build(self, url, emit, previous=None):
        """Fetch (or, with `previous`, refill) an article, tokenize it, download its images and
        save it. A refill keeps the stored pages and the images already downloaded for them;
        sentence ids and image indices are assigned afresh over the whole article."""
        step = 'yahoo'
        try:
            reuse = set()
            if previous:
                cache = previous['cache']
                reuse = {key for key in cache['images'] if isinstance(key, str)
                         and self.store.image_path(previous['id'], key).is_file()}

            def progress(stage, text):
                self._progress(emit, stage, text)
            try:
                if previous:
                    raw = self.yahoo.open(url, progress, known=previous['cache']['source'])
                else:
                    raw = self.yahoo.open(url, progress)
            except NewsError:
                raise
            except (AttributeError, TypeError, ValueError, KeyError, IndexError) as error:
                raise NewsError('parse', '正文结构无法识别（雅虎可能改版）：%s' % type(error).__name__, '文章页')
            errors = list(raw.get('errors') or [])
            for info in errors:
                self.log_error(info, url)

            step = 'tokenize'
            self._progress(emit, 'tokenize', '正在分词…')
            blocks, images = self._blocks(raw['blocks'])

            step = 'image'
            keys = [None] * len(images)
            for index, (src, done, failed) in enumerate(images):
                key = image_key(src) if isinstance(src, str) else None
                if key in reuse:
                    keys[index] = key
                    done(key)
                    continue
                self._progress(emit, 'image', '正在下载图片（第 %d / %d 张）…' % (index + 1, len(images)))
                try:
                    keys[index] = self._download(raw['id'], index, src)
                    done(keys[index])
                except NewsError as error:
                    failed()
                    self.log_error(error, url)
                    errors.append(error.to_dict())

            step = 'parse'
            article = {key: raw[key] for key in ('id', 'url', 'title', 'media', 'published', 'author', 'pages')}
            article.update(blocks=blocks, errors=errors)
            source = None
            if 'page_blocks' in raw:
                source = {key: raw[key] for key in ('id', 'url', 'title', 'media', 'published', 'author',
                                                    'pages', 'page_blocks')}
            # `cache` stays on the server: which file holds image n, and the pages as fetched.
            self.store.save_article(dict(article, cache={'images': keys, 'source': source}))
            self.store.prune_images(raw['id'], {key for key in keys if key})
            return article
        except NewsError:
            raise
        except Exception as error:
            raise NewsError(step, '服务器内部错误：%s' % type(error).__name__, '打开文章')

    def _sentences(self, text, start_id, n):
        location = '正文第 %d 块' % n
        try:
            return to_sentences(text or '', start_id)
        except TokenizerUnavailable:
            raise NewsError('tokenize', '分词组件未安装', location, retryable=False)
        except NewsError:
            raise
        except Exception as error:
            raise NewsError('tokenize', '分词失败：%s' % type(error).__name__, location)

    def _blocks(self, raw_blocks):
        """Tokenized blocks (sentence ids run through the whole article) and the images to fetch,
        [(src, on_success(file key), on_failure)] in local image index order. Article images and
        video posters share one index space: image blocks carry `index`/`ok`, a video's `cover` is
        its poster's index (null when there is none or it failed). `key` / `cover_key` name the
        image's content (a prefix of its file key, null when it failed): the page puts it in the
        image URL, because an index can point at another image after a refill."""
        blocks, images, next_id = [], [], 0
        for n, raw in enumerate(raw_blocks, 1):
            kind = raw.get('type')
            if kind in ('heading', 'paragraph'):
                sentences = self._sentences(raw.get('text'), next_id, n)
                blocks.append({'type': kind, 'sentences': sentences})
            elif kind == 'image':
                sentences = self._sentences(raw.get('caption'), next_id, n)
                block = {'type': 'image', 'index': len(images), 'caption_sentences': sentences,
                         'credit': raw.get('credit') or '', 'ok': False, 'key': None}
                images.append((raw.get('src'), lambda key, b=block: b.update(ok=True, key=key[:KEY_SHOWN]),
                               lambda: None))
                blocks.append(block)
            elif kind == 'video':
                sentences = []
                block = {'type': 'video', 'url': raw.get('url') or '', 'cover': None, 'cover_key': None}
                if raw.get('cover'):
                    block['cover'] = len(images)
                    images.append((raw['cover'], lambda key, b=block: b.update(cover_key=key[:KEY_SHOWN]),
                                   lambda b=block: b.update(cover=None)))
                blocks.append(block)
            else:
                sentences = []
                blocks.append(dict(raw))
            next_id += len(sentences)
        return blocks, images

    def _download(self, article_id, index, src):
        """Download and save image `index`; returns its file key."""
        location = '第 %d 张' % (index + 1)
        data = self.yahoo.image(src, location)
        if not sniff_image(data):
            raise NewsError('image', '下载的内容不是图片', location, retryable=False)
        key = image_key(src)
        self.store.save_image(article_id, key, data, location)
        return key

    def image(self, article_id, index):
        """(bytes, mime) of a saved image of a live article; KeyError otherwise."""
        try:
            article = self.store.load_article(article_id)
            self.store.image_path(article_id, index)  # validates the index
        except ValueError:
            raise KeyError(article_id)
        if not any((b.get('type') == 'image' and b.get('index') == index and b.get('ok'))
                   or (b.get('type') == 'video' and b.get('cover') == index)
                   for b in article.get('blocks', [])):
            raise KeyError(index)
        cache = article.get('cache')
        if isinstance(cache, dict):
            keys = cache.get('images')
            name = keys[index] if isinstance(keys, list) and index < len(keys) else None
            if not isinstance(name, str):
                raise KeyError(index)
        else:
            name = index  # saved before images were keyed by source
        try:
            path = self.store.image_path(article_id, name)
        except ValueError:
            raise KeyError(index)
        try:
            data = path.read_bytes()
        except OSError:
            raise KeyError(index)
        mime = sniff_image(data)
        if not mime:
            raise KeyError(index)
        return data, mime

    # -- models ----------------------------------------------------------------
    def _hub(self):
        if self.hub is None:
            raise NewsError('gateway', R_NO_HUB, retryable=False)
        return self.hub

    def models(self):
        with _located('模型列表'):
            return {'models': self._hub().models(), 'selected': self.store.settings().get('model')}

    def save_model(self, model):
        if not isinstance(model, str) or not model.strip() or len(model) > 200:
            raise client_error('模型名无效')
        with _located('保存模型'):
            if not any(m['id'] == model for m in self._hub().models()):
                raise NewsError('model', R_UNAVAILABLE, retryable=False)
        settings = self.store.settings()
        settings['model'] = model
        self.store.save_settings(settings)
        return {'selected': model}

    def _model(self):
        """(model id, effort) of the selected model, which must still be offered by the hub."""
        hub = self._hub()
        model = self.store.settings().get('model')
        if not model:
            raise NewsError('model', R_NO_MODEL, retryable=False)
        for m in hub.models():
            if m['id'] == model:
                return model, m.get('effort')
        raise NewsError('model', R_UNAVAILABLE, retryable=False)

    @contextlib.contextmanager
    def _slot(self, emit=None):
        """At most MODEL_SLOTS model requests at once; queued streams are told so and pinged."""
        if not self.slots.acquire(blocking=False):
            if emit:
                self._progress(emit, 'model', '排队中…')
            while not self.slots.acquire(timeout=1):
                if emit:
                    emit(None)
        try:
            yield
        finally:
            self.slots.release()

    def _stream(self, model, messages, effort, on_text, emit=None):
        """Feed model text to on_text(chunk) -> bool (whether it emitted). Pings a quiet stream so
        a closed client is noticed, including while the model only thinks (the hub's '' heartbeats,
        which never reach on_text); closing the generator drops the upstream request."""
        gen = self.hub.stream(model, messages, effort)
        last = time.monotonic()
        try:
            for chunk in gen:
                now = time.monotonic()
                if chunk and on_text(chunk):
                    last = now
                elif emit and now - last >= PING_GAP:
                    emit(None)
                    last = now
        finally:
            gen.close()

    # -- gloss -----------------------------------------------------------------
    def gloss(self, lemma, reading, pos):
        for value, limit in ((lemma, 50), (reading, 100), (pos, 50)):
            if not isinstance(value, str) or len(value) > limit:
                raise client_error('查词参数无效')
        if not lemma.strip():
            raise client_error('查词参数无效')
        with _located('查词：%s' % lemma):
            model, effort = self._model()
            cached = self.store.glossary_get(model, lemma, pos)
            if cached is not None:
                return {'meaning': cached}
            parts = []

            def on_text(chunk):
                parts.append(chunk)
                return False
            with self._slot():
                self._stream(model, gloss_messages(lemma, reading, pos), effort, on_text)
            meaning = parse_gloss(''.join(parts))
            self.store.glossary_put(model, lemma, pos, meaning)
            return {'meaning': meaning}

    # -- sentence lookup ---------------------------------------------------------
    def _locate(self, article_id, sentence_id, start, end):
        """(paragraph text, sentence text, selection text) from the stored article."""
        try:
            article = self.store.load_article(article_id)
        except (KeyError, ValueError):
            raise NewsError('parse', R_EXPIRED, retryable=False)
        for block in article.get('blocks', []):
            sentences = block.get('sentences') or block.get('caption_sentences') or []
            for sentence in sentences:
                if sentence.get('id') != sentence_id:
                    continue
                tokens = sentence['tokens']
                if start is not None and end >= len(tokens):
                    raise client_error('选中范围超出句子')
                selection = '' if start is None else ''.join(t['s'] for t in tokens[start:end + 1])
                return _text(sentences), ''.join(t['s'] for t in tokens), selection
        raise client_error('句子不存在')

    def _selection_args(self, data):
        article, sentence = data.get('article'), data.get('sentence')
        start, end = data.get('start'), data.get('end')
        if not isinstance(article, str) or not ID_RE.fullmatch(article):
            raise client_error('文章编号无效')
        if type(sentence) is not int or sentence < 0:
            raise client_error('句子编号无效')
        if (start is None) != (end is None):
            raise client_error('选中范围无效')
        if start is not None and (type(start) is not int or type(end) is not int or not 0 <= start <= end):
            raise client_error('选中范围无效')
        try:
            self._locate(article, sentence, start, end)
        except NewsError as error:
            if error.stage == 'client':
                raise
            # An expired article is reported inside the stream, where the page shows it.
        return article, sentence, start, end

    def analyze_args(self, data):
        """Validate an analyze body before any stream starts (NewsError('client') -> HTTP 400)."""
        return self._selection_args(data)

    def ask_args(self, data):
        article, sentence, start, end = self._selection_args(data)
        analysis = data.get('analysis') or ''
        if not isinstance(analysis, str) or len(analysis) > MAX_ANALYSIS:
            raise client_error('分析内容无效')
        history = data.get('history') or []
        if not isinstance(history, list):
            raise client_error('追问记录无效')
        for item in history:
            if not isinstance(item, dict) or not all(
                    isinstance(item.get(k), str) and len(item[k]) <= MAX_HISTORY_TEXT for k in ('q', 'a')):
                raise client_error('追问记录无效')
        question = data.get('question')
        if not isinstance(question, str) or not question.strip() or len(question) > MAX_QUESTION:
            raise client_error('问题为空或超过 %d 字' % MAX_QUESTION)
        history = [{'q': h['q'], 'a': h['a']} for h in history[-MAX_HISTORY_ROUNDS:]]
        return article, sentence, start, end, analysis, history, question.strip()

    # -- analysis ----------------------------------------------------------------
    def card_for(self, form):
        with self._lock:
            if self._catalog is None:
                self._catalog = self._load_catalog()
            cards = self._catalog
        return match_card(form, cards)

    def _load_catalog(self):
        static = self.config.get('static')
        if not static:
            return []
        try:
            data = json.loads((Path(static) / 'grammar' / 'catalog.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return []
        cards = data.get('cards') if isinstance(data, dict) else None
        return cards if isinstance(cards, list) else []

    def analyze(self, article_id, sentence_id, start, end, emit):
        with _located('句子分析（第 %d 句）' % (sentence_id + 1)):
            paragraph, sentence, selection = self._locate(article_id, sentence_id, start, end)
            model, effort = self._model()
            parser = AnalysisParser()
            parts = []
            sections = [0]

            def send(events):
                for name, data in events:
                    if name == 'grammar':
                        data = dict(data, card=self.card_for(data.get('form')))
                    if name != 'extra':
                        sections[0] += 1
                    emit(name, data)
                return bool(events)

            def on_text(chunk):
                parts.append(chunk)
                return send(parser.feed(chunk))

            with self._slot(emit):
                self._progress(emit, 'model', '等待模型回应…')
                self._stream(model, analysis_messages(paragraph, sentence, selection), effort, on_text, emit)
            send(parser.close())
            if not sections[0]:
                raise NewsError('format', '回复不符合分析模板')
            emit('done', {'analysis_text': ''.join(parts)})

    def ask(self, article_id, sentence_id, start, end, analysis_text, history, question, emit):
        with _located('追问（第 %d 句）' % (sentence_id + 1)):
            _paragraph, sentence, selection = self._locate(article_id, sentence_id, start, end)
            model, effort = self._model()

            def on_text(chunk):
                emit('delta', {'text': chunk})
                return True

            messages = ask_messages(sentence, selection, analysis_text, history[-MAX_HISTORY_ROUNDS:], question)
            with self._slot(emit):
                self._progress(emit, 'model', '等待模型回应…')
                self._stream(model, messages, effort, on_text, emit)
            emit('done', {})
