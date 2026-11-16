"""News reader service: word glosses, tokenizing, sentence analysis and follow-up questions.
HTTP wiring lives in app.py; everything here is plain Python driven by `emit(event, data)`
callbacks so the streaming endpoints can be tested without a browser.

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
from .news_jobs import ClientGone, JobBoard
from .news_prompts import MAX_HISTORY_ROUNDS, analysis_messages, ask_messages, gloss_messages
from .news_store import DEFAULT_PROVIDER, NewsStore
from .news_text import TokenizerUnavailable, to_sentences
from .news_xml import AnalysisParser, parse_gloss

MODEL_SLOTS = 3
CLEANUP_INTERVAL = 3600
PING_GAP = 0.5
MAX_QUESTION = 500
MAX_HISTORY_TEXT = 4000
MAX_ANALYSIS = 20000
MAX_PARAGRAPHS = 200        # per tokenize request
MAX_CHARS = 20000           # in all paragraphs of one tokenize request
MAX_PARAGRAPH = 4000        # a paragraph sent with an analysis or follow-up
MAX_TOKENS = 400            # words in that sentence
MAX_TOKEN = 100             # characters in one word

R_NO_MODEL = '请先点右下角按钮，在菜单里选择模型'
R_NO_HUB = '未配置 CodeBuddy 网关'

PROVIDERS = (
    ('codebuddy', 'CodeBuddy', 'CodeBuddy 网关'),
    ('qoder', 'Qoder', 'qoder2api-hub'),
)
_PROVIDER_BY_ID = {pid: (label, gw) for pid, label, gw in PROVIDERS}
DEFAULT_MODELS = {'codebuddy': 'global:hy4flash-free'}

_CARD_CUT = re.compile('[：（(]')
_CARD_SPLIT = re.compile('[／・/]')
_CARD_TRIM = ' \t\r\n　〜～'
_LEVEL = re.compile(r'N[1-5]')


def client_error(reason):
    return NewsError('client', reason, retryable=False)


def http_status(error):
    return 400 if error.stage == 'client' else 502


def sse_frame(event, data=None, event_id=None):
    """One Server-Sent Events frame; event None is a comment line used to notice a closed client.
    event_id numbers the frame within its job so a resumed stream can continue after it."""
    if event is None:
        return b': ping\n\n'
    head = '' if event_id is None else 'id: %d\n' % event_id
    return ('%sevent: %s\ndata: %s\n\n' % (head, event, json.dumps(data, ensure_ascii=False))).encode('utf-8')


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


def _provider_entry(cfg):
    return isinstance(cfg, dict) and isinstance(cfg.get('base_url'), str) and cfg.get('base_url').strip()


class NewsService:
    def __init__(self, config, state, hub=None):
        self.config = config
        self.store = NewsStore(state)
        self.store.cleanup()
        self._single_hub = hub is not None
        self._hubs = {}
        if hub is not None:
            self._hubs[DEFAULT_PROVIDER] = hub
        else:
            raw_providers = dict(config.get('llm_providers') or {}) if isinstance(config.get('llm_providers'), dict) else {}
            candidates = {
                'codebuddy': raw_providers.get('codebuddy') or config.get('codebuddy'),
                'qoder': raw_providers.get('qoder') or config.get('llm'),
            }
            for pid, _label, gw_name in PROVIDERS:
                entry = candidates.get(pid)
                if _provider_entry(entry):
                    self._hubs[pid] = Hub(entry['base_url'], entry.get('api_key') or '', label=gw_name)
        self.hub = self._hubs.get(DEFAULT_PROVIDER) or self._hubs.get('qoder')
        self.slots = threading.BoundedSemaphore(MODEL_SLOTS)
        self.jobs = JobBoard()
        self._lock = threading.Lock()
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

    # -- models ----------------------------------------------------------------
    @staticmethod
    def _validate_provider(provider):
        if not isinstance(provider, str) or provider not in _PROVIDER_BY_ID:
            raise client_error('模型来源无效')
        return provider

    def _active_provider(self, settings=None):
        pid = (settings if settings is not None else self.store.settings()).get('provider')
        return pid if pid in _PROVIDER_BY_ID else DEFAULT_PROVIDER

    def _merged_models(self, settings):
        models_map = dict(settings.get('models') or {})
        if not models_map and settings.get('model'):
            legacy_pid = DEFAULT_PROVIDER if self._single_hub else 'qoder'
            models_map[legacy_pid] = settings['model']
        return models_map

    @staticmethod
    def _merged_efforts(settings):
        raw = settings.get('efforts') or {}
        return {pid: dict(inner) for pid, inner in raw.items() if isinstance(pid, str) and isinstance(inner, dict)}

    @staticmethod
    def _find_model(items, model_id):
        for m in items:
            if m['id'] == model_id:
                return m
        return None

    def _effective_effort(self, pid, model_id, settings, items):
        if not model_id:
            return None
        item = self._find_model(items, model_id)
        if not item:
            return None
        thinking = item.get('thinking') or {}
        options = thinking.get('options') or []
        saved = self._merged_efforts(settings).get(pid, {}).get(model_id)
        if thinking.get('mode') != 'fixed' and saved in options:
            return saved
        return thinking.get('default') if thinking else item.get('effort')

    def _saved_model(self, settings, pid):
        return self._merged_models(settings).get(pid)

    def _effective_selected(self, pid, settings, items):
        chosen = self._saved_model(settings, pid)
        if chosen:
            return chosen
        default_id = DEFAULT_MODELS.get(pid)
        if default_id and any(m['id'] == default_id for m in items):
            return default_id
        return None

    def _hub(self, provider=None):
        pid = provider or self._active_provider()
        hub = self._hubs.get(pid)
        if hub is None:
            gw_name = _PROVIDER_BY_ID[pid][1]
            raise NewsError('gateway', '未配置 %s' % gw_name, retryable=False)
        return hub

    def _providers_info(self):
        return [
            {'id': pid, 'label': label, 'configured': pid in self._hubs}
            for pid, label, _gw in PROVIDERS
        ]

    def models(self, provider=None):
        with _located('模型列表'):
            settings = self.store.settings()
            pid = self._validate_provider(provider) if provider is not None else self._active_provider(settings)
            items = self._hub(pid).models()
            selected = self._effective_selected(pid, settings, items)
            return {
                'provider': pid,
                'providers': self._providers_info(),
                'models': items,
                'selected': selected,
                'effort': self._effective_effort(pid, selected, settings, items),
                'efforts': self._merged_efforts(settings).get(pid, {}),
            }

    def save_settings(self, provider=None, model=None, effort=None):
        if provider is None and model is None and effort is None:
            raise client_error('设置参数无效')
        settings = self.store.settings()
        pid = self._validate_provider(provider) if provider is not None else self._active_provider(settings)
        models_map = self._merged_models(settings)
        efforts_map = self._merged_efforts(settings)
        items = None
        if model is not None:
            if not isinstance(model, str) or not model.strip() or len(model) > 200:
                raise client_error('模型名无效')
            with _located('保存模型'):
                items = self._hub(pid).models()
                if not self._find_model(items, model):
                    raise NewsError('model', R_UNAVAILABLE, retryable=False)
            models_map[pid] = model
        if effort is not None:
            if not isinstance(effort, str) or not effort.strip() or len(effort) > 40:
                raise client_error('思考强度无效')
            with _located('保存思考强度'):
                if items is None:
                    items = self._hub(pid).models()
                target_model = model if model is not None else self._effective_selected(pid, {'models': models_map}, items)
                if not target_model:
                    raise NewsError('model', R_NO_MODEL, retryable=False)
                item = self._find_model(items, target_model)
                if not item:
                    raise NewsError('model', R_UNAVAILABLE, retryable=False)
                thinking = item.get('thinking') or {}
                mode = thinking.get('mode')
                options = thinking.get('options') or []
                if mode in ('fixed', 'none'):
                    if mode == 'none' or effort != thinking.get('default'):
                        raise client_error('当前模型不支持调节思考强度')
                elif effort not in options:
                    raise client_error('思考强度无效')
                efforts_map.setdefault(pid, {})[target_model] = effort
        new_settings = {'provider': pid, 'models': models_map, 'efforts': efforts_map}
        self.store.save_settings(new_settings)
        selected = models_map.get(pid)
        if items is not None:
            eff_model = selected or self._effective_selected(pid, new_settings, items)
            res = {'selected': eff_model, 'effort': self._effective_effort(pid, eff_model, new_settings, items)}
            if provider is not None:
                res['provider'] = pid
            return res
        return {'provider': pid, 'selected': selected}

    def save_model(self, model):
        return self.save_settings(model=model)

    def _model(self):
        """(provider, hub, model id, effort) of the active selection, which must still be offered."""
        settings = self.store.settings()
        pid = self._active_provider(settings)
        hub = self._hub(pid)
        items = hub.models()
        model = self._effective_selected(pid, settings, items)
        if not model:
            raise NewsError('model', R_NO_MODEL, retryable=False)
        if not self._find_model(items, model):
            raise NewsError('model', R_UNAVAILABLE, retryable=False)
        return pid, hub, model, self._effective_effort(pid, model, settings, items)

    @staticmethod
    def _glossary_key(provider, model):
        return model if provider == 'qoder' else f'{provider}:{model}'

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

    def _stream(self, hub, model, messages, effort, on_text, emit=None):
        """Feed model text to on_text(chunk) -> bool (whether it emitted). Pings a quiet stream so
        a closed client is noticed, including while the model only thinks (the hub's '' heartbeats,
        which never reach on_text); closing the generator drops the upstream request."""
        gen = hub.stream(model, messages, effort)
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
            provider, hub, model, effort = self._model()
            cache_key = self._glossary_key(provider, model)
            cached = self.store.glossary_get(cache_key, lemma, pos)
            if cached is not None:
                return {'meaning': cached}
            parts = []

            def on_text(chunk):
                parts.append(chunk)
                return False
            with self._slot():
                self._stream(hub, model, gloss_messages(lemma, reading, pos), effort, on_text)
            meaning = parse_gloss(''.join(parts))
            self.store.glossary_put(cache_key, lemma, pos, meaning)
            return {'meaning': meaning}

    # -- tokenizing ----------------------------------------------------------------
    def tokenize(self, data):
        """Sentences (token lists, no ids) for each paragraph the userscript found on a page."""
        paragraphs = data.get('paragraphs')
        if not isinstance(paragraphs, list) or not all(isinstance(p, str) for p in paragraphs):
            raise client_error('分词请求格式不对')
        if len(paragraphs) > MAX_PARAGRAPHS or sum(len(p) for p in paragraphs) > MAX_CHARS:
            raise client_error('分词请求超过 %d 段或 2 万字' % MAX_PARAGRAPHS)
        result = []
        for n, text in enumerate(paragraphs, 1):
            location = '第 %d 段' % n
            try:
                sentences = to_sentences(text, 0)
            except TokenizerUnavailable:
                raise NewsError('tokenize', '分词组件未安装', location, retryable=False)
            except NewsError:
                raise
            except Exception as error:
                raise NewsError('tokenize', '分词失败：%s' % type(error).__name__, location)
            result.append([{'tokens': s['tokens']} for s in sentences])
        return {'paragraphs': result}

    # -- sentence arguments --------------------------------------------------------
    def _selection_args(self, data):
        """(paragraph, tokens, start, end) from a body the userscript built."""
        paragraph, tokens = data.get('paragraph'), data.get('tokens')
        start, end = data.get('start'), data.get('end')
        if not isinstance(paragraph, str) or not 1 <= len(paragraph) <= MAX_PARAGRAPH:
            raise client_error('段落无效')
        if not isinstance(tokens, list) or not 1 <= len(tokens) <= MAX_TOKENS \
                or not all(isinstance(t, str) and 1 <= len(t) <= MAX_TOKEN for t in tokens):
            raise client_error('句子无效')
        if ''.join(tokens) not in paragraph:
            raise client_error('句子不在段落中')
        if (start is None) != (end is None):
            raise client_error('选中范围无效')
        if start is not None:
            if type(start) is not int or type(end) is not int or not 0 <= start <= end:
                raise client_error('选中范围无效')
            if end >= len(tokens):
                raise client_error('选中范围超出句子')
        return paragraph, tokens, start, end

    def analyze_args(self, data):
        """Validate an analyze body before any stream starts (NewsError('client') -> HTTP 400)."""
        return self._selection_args(data)

    def ask_args(self, data):
        paragraph, tokens, start, end = self._selection_args(data)
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
        return paragraph, tokens, start, end, analysis, history, question.strip()

    @staticmethod
    def job_name(data):
        job = data.get('job')
        if not isinstance(job, str) or not 1 <= len(job) <= 100:
            raise client_error('任务编号无效')
        return job

    def resume_args(self, data):
        """(job, number of events already received) of a /resume body; raises NewsError when the job is gone."""
        job, seen = self.job_name(data), data.get('next')
        if type(seen) is not int or seen < 0:
            raise client_error('续传位置无效')
        return self.jobs.get(job), seen

    @staticmethod
    def _sentence_texts(tokens, start, end):
        return ''.join(tokens), '' if start is None else ''.join(tokens[start:end + 1])

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

    def analyze(self, paragraph, tokens, start, end, emit):
        with _located('句子分析'):
            sentence, selection = self._sentence_texts(tokens, start, end)
            _provider, hub, model, effort = self._model()
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
                self._stream(hub, model, analysis_messages(paragraph, sentence, selection), effort, on_text, emit)
            send(parser.close())
            if not sections[0]:
                raise NewsError('format', '回复不符合分析模板')
            emit('done', {'analysis_text': ''.join(parts)})

    def ask(self, paragraph, tokens, start, end, analysis_text, history, question, emit):
        with _located('追问'):
            sentence, selection = self._sentence_texts(tokens, start, end)
            _provider, hub, model, effort = self._model()

            def on_text(chunk):
                emit('delta', {'text': chunk})
                return True

            messages = ask_messages(sentence, selection, analysis_text, history[-MAX_HISTORY_ROUNDS:], question)
            with self._slot(emit):
                self._progress(emit, 'model', '等待模型回应…')
                self._stream(hub, model, messages, effort, on_text, emit)
            emit('done', {})
