"""Sentence splitting and morphological tokenizing for the news reader.

Text is cut into sentences first, then each sentence into tokens with fugashi
(unidic-lite). Tokens always reassemble to the sentence they came from:
whitespace the tagger drops is emitted back as untappable tokens.
"""
import threading

TERMINATORS = '。！？'
OPEN_QUOTES = '「『'
CLOSE_QUOTES = '」』'
# Parts of speech (UniDic pos1) that are never worth a dictionary lookup.
UNTAPPABLE_POS = {'補助記号', '記号', '空白'}

_tagger = None
_lock = threading.Lock()


class TokenizerUnavailable(Exception):
    """fugashi or its dictionary is not installed."""


def split_sentences(text):
    """Split on 。！？ and newlines; 「」『』 keep their content in one sentence.

    Runs of terminators stay with their sentence. A newline always ends a
    sentence (and resets quote depth, so an unclosed quote cannot swallow the
    rest of the article). Blank sentences are dropped.
    """
    sentences = []
    buf = []
    depth = 0

    def flush():
        sentence = ''.join(buf).strip()
        buf.clear()
        if sentence:
            sentences.append(sentence)

    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch in '\r\n':
            flush()
            depth = 0
        elif ch in OPEN_QUOTES:
            depth += 1
            buf.append(ch)
        elif ch in CLOSE_QUOTES:
            depth = max(0, depth - 1)
            buf.append(ch)
        elif ch in TERMINATORS:
            buf.append(ch)
            if depth == 0:
                while i + 1 < n and text[i + 1] in TERMINATORS:
                    i += 1
                    buf.append(text[i])
                flush()
        else:
            buf.append(ch)
        i += 1
    flush()
    return sentences


def _get_tagger():
    global _tagger
    if _tagger is not None:
        return _tagger
    with _lock:
        if _tagger is None:
            try:
                import fugashi
                _tagger = fugashi.Tagger()
            except Exception as error:  # ImportError, or RuntimeError for a missing dictionary
                raise TokenizerUnavailable(f'{type(error).__name__}: {error}') from error
    return _tagger


def _hiragana(kana):
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in kana)


def _field(feature, name):
    value = getattr(feature, name, None)
    return '' if value in (None, '*') else value


def _lemma(feature, surface):
    lemma = _field(feature, 'lemma')
    if not lemma:
        return surface
    # UniDic appends a gloss after a hyphen ("テン-ten"); keep the head only.
    head = lemma.split('-', 1)[0]
    return head or lemma


def _accent(feature):
    """UniDic aType: the pitch-accent number(s) of the dictionary form, e.g. '3' or '2,0' ('' when unknown).
    For an inflected word it is the accent of the lemma, not of the surface form."""
    numbers = [n.strip() for n in _field(feature, 'aType').split(',')]
    return ','.join(numbers) if numbers and all(n.isdigit() for n in numbers) else ''


def _tappable(surface, pos1, pos2):
    if pos1 in UNTAPPABLE_POS or pos2 == '数詞':
        return False
    if surface.isspace() or surface.isdigit():
        return False
    return any(c.isalnum() for c in surface)


def tokenize(sentence):
    """Return [{'s','r','l','p','t'}]: surface, hiragana reading, lemma, pos1, tappable. A token whose
    pitch accent is known also has 'a' (the number as text, '2,0' when the dictionary gives two)."""
    tagger = _get_tagger()
    with _lock:  # a MeCab tagger is not documented as thread-safe
        words = [(w.surface, w.feature) for w in tagger(sentence)]
    tokens = []
    pos = 0

    def gap(end):
        nonlocal pos
        if end > pos:
            tokens.append({'s': sentence[pos:end], 'r': '', 'l': '', 'p': '空白', 't': False})
            pos = end

    for surface, feature in words:
        start = sentence.find(surface, pos)
        if start < 0:  # should not happen; stay lossless regardless
            start = pos
        gap(start)
        pos = start + len(surface)
        pos1, pos2 = _field(feature, 'pos1'), _field(feature, 'pos2')
        token = {
            's': surface,
            'r': _hiragana(_field(feature, 'kana')),
            'l': _lemma(feature, surface),
            'p': pos1,
            't': _tappable(surface, pos1, pos2),
        }
        accent = _accent(feature)
        if accent:
            token['a'] = accent
        tokens.append(token)
    gap(len(sentence))
    return tokens


def to_sentences(text, start_id):
    """Split text and tokenize each sentence: [{'id': start_id + i, 'tokens': [...]}]."""
    return [{'id': start_id + i, 'tokens': tokenize(s)} for i, s in enumerate(split_sentences(text))]
