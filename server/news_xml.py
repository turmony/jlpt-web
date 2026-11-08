"""Incremental parser for the model's XML-ish replies (spec section 5).

Model output may contain unescaped '&' and '<' and may be wrapped in Markdown fences,
so this is a small tag scanner rather than xml.etree.
"""
import re

from server.news_errors import NewsError

_FENCE = re.compile(r'```[A-Za-z]*')
_WRAPPERS = re.compile(r'</?(?:analysis|grammar)\s*>')
_SECTIONS = [
    ('selection', re.compile(r'<selection\s*>(.*?)</selection\s*>', re.S)),
    ('translation', re.compile(r'<translation\s*>(.*?)</translation\s*>', re.S)),
    ('item', re.compile(r'<item(\s[^>]*)?>(.*?)</item\s*>', re.S)),
]
_OPENERS = re.compile(r'<(?:selection|translation|item)(?:\s[^>]*)?>')
_RELATED = re.compile(r'''\brelated\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))''', re.I)
_LEVELS = {'N1', 'N2', 'N3', 'N4', 'N5'}
_ENTITIES = (('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'), ('&apos;', "'"), ('&amp;', '&'))


def _unescape(s):
    for a, b in _ENTITIES:
        s = s.replace(a, b)
    return s


def _field(body, tag):
    m = re.search(r'<%s\s*>(.*?)</%s\s*>' % (tag, tag), body, re.S)
    return _unescape(m.group(1).strip()) if m else ''


def _strip_wrappers(text):
    return _WRAPPERS.sub('', _FENCE.sub('', text)).strip()


def _related(attrs):
    m = _RELATED.search(attrs or '')
    if not m:
        return False
    value = next(g for g in m.groups() if g is not None)
    return value.strip().lower() == 'true'


class AnalysisParser:
    def __init__(self):
        self._buf = ''
        self._extra = []

    def _scan(self):
        events = []
        while True:
            best = None
            for kind, rx in _SECTIONS:
                m = rx.search(self._buf)
                if m and (best is None or m.start() < best[1].start()):
                    best = (kind, m)
            if best is None:
                break
            kind, m = best
            self._note_extra(self._buf[:m.start()])
            self._buf = self._buf[m.end():]
            if kind == 'selection':
                body = m.group(1)
                events.append(('selection', {'reading': _field(body, 'reading'),
                                             'role': _field(body, 'role'),
                                             'meaning': _field(body, 'meaning')}))
            elif kind == 'translation':
                events.append(('translation', {'text': _unescape(m.group(1).strip())}))
            else:
                body = m.group(2)
                level = _field(body, 'level').upper()
                events.append(('grammar', {'form': _field(body, 'form'),
                                           'level': level if level in _LEVELS else '',
                                           'brief': _field(body, 'brief'),
                                           'connection': _field(body, 'connection'),
                                           'usage': _field(body, 'usage'),
                                           'confusable': _field(body, 'confusable'),
                                           'related': _related(m.group(1))}))
        return events

    def _note_extra(self, text):
        text = _strip_wrappers(text)
        if text:
            self._extra.append(text)

    def feed(self, chunk):
        self._buf += chunk
        return self._scan()

    def close(self):
        events = self._scan()
        rest, self._buf = self._buf, ''
        # An unterminated section keeps its raw text (opening tag included).
        m = _OPENERS.search(rest)
        if m:
            self._note_extra(rest[:m.start()])
            tail = _FENCE.sub('', rest[m.start():])
            tail = _WRAPPERS.sub('', tail).strip()
            if tail:
                self._extra.append(tail)
        else:
            self._note_extra(rest)
        if self._extra:
            events.append(('extra', {'text': '\n'.join(self._extra)}))
            self._extra = []
        return events


def parse_gloss(text):
    m = re.search(r'<meaning\s*>(.*?)</meaning\s*>', text or '', re.S)
    meaning = _unescape(m.group(1).strip()) if m else ''
    if not meaning:
        raise NewsError('format', '回复缺少释义')
    return meaning
