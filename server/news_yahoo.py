"""Fetch and normalize Yahoo! JAPAN News (RSS, topic pages, multi-page articles)."""
import email.utils
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import timezone

from .news_errors import NewsError
from .news_store import IMAGE_MAX

HOST = 'news.yahoo.co.jp'
TIMEOUT = 10
PAGE_GAP = 0.5
MAX_PAGES = 6              # pages shown; the rest are one error line (2026-11-08, user-approved)
PAGE_RETRY_DELAY = 1.5     # a failed page is tried once more after this pause
OPEN_BUDGET = 30           # seconds one article open may spend fetching pages
USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

FEEDS = {
    'top-picks': '主要', 'domestic': '国内', 'world': '国际', 'business': '经济',
    'entertainment': '娱乐', 'sports': '体育', 'it': 'IT', 'science': '科学',
}

_PATH_OK = re.compile(r'/(?:pickup/\d+|articles/[0-9a-f]{8,64})')
_ARTICLE_PATH = re.compile(r'/articles/([0-9a-f]{8,64})')
_KNOWN_TAGS = {'yjrf-article', 'yjrf-paragraph', 'figure', 'figcaption', 'yjrf-img',
               'p', 'h2', 'a', 'br', 'strong', 'em', 'span'}
_NO_RETRY = {403, 404, 410}
_PAGE_GONE = {404, 410}      # this page only; any other failure means Yahoo as a whole is in trouble
_REDIRECTS = {301, 302, 303, 307, 308}
MAX_REDIRECTS = 5


def validate_url(url):
    """Return the canonical pickup/article URL, or raise ValueError."""
    bad = ValueError('只支持雅虎新闻的链接')
    if not isinstance(url, str):
        raise bad
    try:
        u = urllib.parse.urlsplit(url.strip())
        port = u.port
    except ValueError:
        raise bad
    if (u.scheme != 'https' or u.hostname != HOST or port is not None or u.username or u.password
            or u.netloc != HOST or not _PATH_OK.fullmatch(u.path)):
        raise bad
    return 'https://%s%s' % (HOST, u.path)


def article_id_of(url):
    """The id of a canonical article URL; None for a topic (pickup) URL."""
    m = _ARTICLE_PATH.fullmatch(urllib.parse.urlsplit(url).path)
    return m.group(1) if m else None


class _SameHostRedirect(urllib.request.HTTPRedirectHandler):
    """Follow redirects only to https://news.yahoo.co.jp."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urllib.parse.urlsplit(newurl)
        if u.scheme != 'https' or u.netloc != HOST:
            raise urllib.error.URLError('拒绝跳转到其他地址')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def http_fetch(url):
    """GET url -> (status, body). Redirects off news.yahoo.co.jp raise URLError."""
    opener = urllib.request.build_opener(_SameHostRedirect())
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept-Language': 'ja,en;q=0.5'})
    try:
        with opener.open(req, timeout=TIMEOUT) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, b''


def image_host_ok(url):
    """https on news.yahoo.co.jp or *.yimg.jp, with no port or credentials."""
    try:
        u = urllib.parse.urlsplit(url) if isinstance(url, str) else None
        port = u.port if u else None
    except ValueError:
        return False
    if not u or u.scheme != 'https' or port is not None or u.username or u.password:
        return False
    host = u.hostname or ''
    return u.netloc == host and (host == HOST or host.endswith('.yimg.jp'))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Hand 3xx answers back to Yahoo.image, which checks each hop itself."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def open_image(url):
    """GET url without following redirects -> a response (HTTPError for non-2xx), unread."""
    opener = urllib.request.build_opener(_NoRedirect())
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Referer': 'https://%s/' % HOST})
    try:
        return opener.open(req, timeout=TIMEOUT)
    except urllib.error.HTTPError as e:
        return e


def extract_state(html, location=None):
    """window.__PRELOADED_STATE__ as a dict, or NewsError('parse')."""
    text = html.decode('utf-8', 'replace') if isinstance(html, bytes) else html
    m = re.search(r'__PRELOADED_STATE__\s*=\s*', text)
    if not m:
        raise NewsError('parse', '页面里找不到正文数据（雅虎可能改版）', location)
    try:
        state, _ = json.JSONDecoder().raw_decode(text, m.end())
    except ValueError:
        raise NewsError('parse', '正文数据无法解析（雅虎可能改版）', location)
    if not isinstance(state, dict):
        raise NewsError('parse', '正文数据格式不对（雅虎可能改版）', location)
    return state


def _image_src(item):
    resized = item.get('resizedViewUrl')
    if isinstance(resized, dict) and resized.get('jpeg'):
        return resized['jpeg']
    view = item.get('view')
    if isinstance(view, dict) and view.get('uri'):
        return view['uri']
    return None


def _paragraph_blocks(paragraphs):
    """One list of blocks per paragraph, in order."""
    out = []
    for p in paragraphs:
        blocks = []
        if not isinstance(p, dict):
            out.append(blocks)
            continue
        head = (p.get('head') or '').strip()
        if head:
            blocks.append({'type': 'heading', 'text': head})
        for t in p.get('textDetails') or []:
            text = (t.get('text') if isinstance(t, dict) else '') or ''
            if text.strip():
                blocks.append({'type': 'paragraph', 'text': text.strip()})
        for item in p.get('objectItems') or []:
            src = _image_src(item) if isinstance(item, dict) else None
            if src:
                blocks.append({'type': 'image', 'src': src, 'caption': item.get('caption') or '',
                               'credit': item.get('credit') or ''})
        out.append(blocks)
    return out


def _rich_extras(rich, page_url):
    """Video / unknown blocks from richBody, keyed by the number of paragraphs
    already opened (so they can be placed after that paragraph)."""
    extras = {}
    seen = [0]

    def add(block):
        extras.setdefault(seen[0], []).append(block)

    def walk(node):
        if isinstance(node, list):
            for n in node:
                walk(n)
            return
        if not isinstance(node, dict) or node.get('type') == 'text':
            return
        tag = node.get('tagName') or node.get('tag') or ''
        attrs = node.get('attributes') or {}
        if tag == 'yjrf-yvp':
            block = {'type': 'video', 'url': attrs.get('src') or attrs.get('url') or ''}
            if attrs.get('poster'):
                block['cover'] = attrs['poster']
            add(block)
            return
        if tag not in _KNOWN_TAGS:
            add({'type': 'unknown', 'url': page_url})
            return
        if tag == 'yjrf-paragraph':
            seen[0] += 1
        walk(node.get('children'))

    walk(rich)
    return extras


def parse_page(state, page_url, location=None):
    detail = state.get('articleDetail') if isinstance(state, dict) else None
    if not isinstance(detail, dict) or not isinstance(detail.get('paragraphs'), list):
        raise NewsError('parse', '页面里找不到正文（雅虎可能改版）', location)
    groups = _paragraph_blocks(detail['paragraphs'])
    extras = _rich_extras(detail.get('richBody'), page_url)
    blocks = list(extras.pop(0, []))
    for i, g in enumerate(groups, 1):
        blocks.extend(g)
        blocks.extend(extras.pop(i, []))
    for k in sorted(extras):  # richBody had more paragraphs than the structured data
        blocks.extend(extras[k])
    media = detail.get('media')
    author = detail.get('author')
    if isinstance(author, dict):
        author = author.get('name')
    return {
        'title': detail.get('headline') or '',
        'media': (media.get('mediaName') if isinstance(media, dict) else media) or '',
        'published': detail.get('createDateTime') or '',
        'author': author or '',
        'current': detail.get('currentPage') or 1,
        'max': detail.get('maxPage') or 1,
        'blocks': blocks,
    }


class OffNewsTopic(NewsError):
    """A topic whose article link leaves Yahoo News (e.g. SNS posts on search.yahoo.co.jp).
    Expected, final, and not a sign that the page changed; the probe skips these by type."""
    def __init__(self, host):
        super().__init__('parse', '这条话题指向雅虎新闻以外的页面（%s），阅读器只能打开雅虎新闻文章'
                         % (host or '未知地址'), '话题页', retryable=False)


def _pages_text(pages):
    """'3', '3–6' or '3、5–6' for a sorted list of page numbers (runs joined by an en dash)."""
    runs = []
    for n in pages:
        if runs and n == runs[-1][1] + 1:
            runs[-1][1] = n
        else:
            runs.append([n, n])
    return '、'.join('%d' % a if a == b else '%d–%d' % (a, b) for a, b in runs)


def _page_location(pages, total):
    return '第 %s 页 / 共 %d 页' % (_pages_text(pages), total)


class _PageFailed(Exception):
    """A page that could not be fetched or read; `site_wide` failures stop the page loop."""
    def __init__(self, error, site_wide):
        super().__init__(error.reason)
        self.error = error
        self.site_wide = site_wide


class Yahoo:
    def __init__(self, fetch=http_fetch, sleep=time.sleep, open_image=open_image,
                 clock=time.monotonic, budget=OPEN_BUDGET):
        self._fetch = fetch
        self._sleep = sleep
        self._open_image = open_image
        self._clock = clock
        self._budget = budget

    def image(self, url, location):
        """Bytes of an article image. Only https news.yahoo.co.jp / *.yimg.jp, redirects only
        within those hosts, at most IMAGE_MAX bytes read. Failures are NewsError('image')."""
        for _hop in range(MAX_REDIRECTS + 1):
            if not image_host_ok(url):
                raise NewsError('image', '图片地址不是雅虎的', location, retryable=False)
            try:
                resp = self._open_image(url)
            except Exception as e:
                raise NewsError('image', '下载图片失败：%s' % (e or type(e).__name__), location)
            try:
                status = getattr(resp, 'status', None) or getattr(resp, 'code', None)
                if status in _REDIRECTS:
                    target = resp.headers.get('Location') if resp.headers else None
                    if not target:
                        raise NewsError('image', '图片跳转缺少地址', location)
                    url = urllib.parse.urljoin(url, target)
                    continue
                if status != 200:
                    raise NewsError('image', '图片返回 %s' % status, location, retryable=status not in _NO_RETRY)
                try:
                    data = resp.read(IMAGE_MAX + 1)
                except Exception as e:
                    raise NewsError('image', '下载图片失败：%s' % (e or type(e).__name__), location)
                if len(data) > IMAGE_MAX:
                    raise NewsError('image', '图片超过 5 MB', location, retryable=False)
                return data
            finally:
                close = getattr(resp, 'close', None)
                if close:
                    close()
        raise NewsError('image', '图片跳转次数过多', location)

    def fetch(self, url, location=None):
        try:
            status, body = self._fetch(url)
        except NewsError:
            raise
        except Exception as e:
            raise NewsError('yahoo', '连接雅虎失败：%s' % (e or type(e).__name__), location)
        if status != 200:
            error = NewsError('yahoo', '雅虎返回 %s' % status, location, retryable=status not in _NO_RETRY)
            error.status = status
            raise error
        return body

    def feed(self, slug):
        if slug not in FEEDS:
            raise ValueError('未知分类')
        body = self.fetch('https://%s/rss/topics/%s.xml' % (HOST, slug), '新闻列表')
        if b'<!DOCTYPE' in body or b'<!ENTITY' in body:
            raise NewsError('parse', '列表格式不对', '新闻列表')
        try:
            root = ET.fromstring(body)
        except ET.ParseError:
            raise NewsError('parse', '列表无法解析', '新闻列表')
        items = []
        for it in root.iter('item'):
            title = (it.findtext('title') or '').strip()
            link = (it.findtext('link') or '').strip()
            if not title or not link:
                continue
            when = ''
            raw = (it.findtext('pubDate') or '').strip()
            if raw:
                try:
                    when = email.utils.parsedate_to_datetime(raw).astimezone(timezone.utc).isoformat()
                except (TypeError, ValueError):
                    when = ''
            items.append({'title': title, 'url': link, 'time': when})
        return items

    def _resolve_pickup(self, url, progress):
        progress('yahoo', '正在抓取雅虎…')
        state = extract_state(self.fetch(url, '话题页'), '话题页')
        try:
            article = state['topicsDetail']['article']['url']
        except (KeyError, TypeError):
            raise NewsError('parse', '话题页里找不到文章链接（雅虎可能改版）', '话题页')
        try:
            return validate_url(article)
        except ValueError:
            # Real topics sometimes point elsewhere (e.g. SNS posts on search.yahoo.co.jp).
            # Not a page change and retrying will not help.
            try:
                host = urllib.parse.urlsplit(article).hostname if isinstance(article, str) else None
            except ValueError:
                host = None
            raise OffNewsTopic(host)

    def _page(self, url, n, total):
        """Page n parsed, or _PageFailed. 404/410 and pages without article data are this
        page's own problem; timeouts, connection errors, 403, 429 and 5xx are site-wide."""
        loc = _page_location([n], total)
        try:
            body = self.fetch('%s?page=%d' % (url, n), loc)
        except NewsError as error:
            raise _PageFailed(error, getattr(error, 'status', None) not in _PAGE_GONE)
        try:
            return parse_page(extract_state(body, loc), url, loc)
        except NewsError as error:
            raise _PageFailed(error, False)
        except (AttributeError, TypeError, ValueError, KeyError, IndexError) as error:
            raise _PageFailed(NewsError('parse', '正文结构无法识别（雅虎可能改版）：%s' % type(error).__name__, loc),
                              False)

    def _first_page(self, url):
        loc = '第 1 页'
        for attempt in (1, 2):
            try:
                return parse_page(extract_state(self.fetch(url, loc), loc), url, loc)
            except NewsError:
                if attempt == 2:
                    raise
            self._sleep(PAGE_RETRY_DELAY)

    def open(self, url, progress, known=None):
        """The article as {id, url, title, media, published, author, pages:{total, fetched,
        missing}, blocks, errors, page_blocks}. Pages 1..MAX_PAGES are fetched in order, spaced by
        PAGE_GAP; a failed page is tried once more after PAGE_RETRY_DELAY. A site-wide failure,
        a page whose number is wrong, or running past the time budget stops the loop; the pages
        left are `missing` and get one error. Pages past MAX_PAGES are one error, never listed.

        `known` is an earlier result of this method for the same article: its pages are kept
        and only the pages it misses are fetched (no topic page, no page 1)."""
        began = self._clock()
        if known:
            pages = {int(n): list(blocks) for n, blocks in known['page_blocks']}
            if 1 not in pages:
                raise NewsError('parse', '缓存里没有第 1 页', '第 1 页')
            meta = {key: known[key] for key in ('id', 'url', 'title', 'media', 'published', 'author')}
            total = max(1, int(known['pages']['total']))
        else:
            url = validate_url(url)
            if '/pickup/' in url:
                url = self._resolve_pickup(url, progress)
            article_id = _ARTICLE_PATH.fullmatch(urllib.parse.urlsplit(url).path).group(1)
            progress('yahoo', '正在抓取雅虎…')
            first = self._first_page(url)
            total = max(1, int(first['max']))
            pages = {1: list(first['blocks'])}
            meta = {'id': article_id, 'url': url, 'title': first['title'], 'media': first['media'],
                    'published': first['published'], 'author': first['author']}
        url = meta['url']
        shown = min(total, MAX_PAGES)
        pages = {n: blocks for n, blocks in pages.items() if 1 <= n <= shown}
        todo = [n for n in range(2, shown + 1) if n not in pages]
        errors = []

        def rest_from(n):
            return _page_location(todo[todo.index(n):], total)

        for n in todo:
            progress('yahoo', '正在抓取雅虎（第 %d / %d 页）…' % (n, total))
            self._sleep(PAGE_GAP)
            page, failure, late = None, None, False
            for attempt in (1, 2):
                if attempt == 2:
                    self._sleep(PAGE_RETRY_DELAY)
                if self._clock() - began > self._budget:
                    late = True
                    break
                try:
                    page = self._page(url, n, total)
                    break
                except _PageFailed as failed:
                    failure = failed
            if late:
                errors.append(NewsError('yahoo', '抓取超过 %g 秒，已停止' % self._budget, rest_from(n)).to_dict())
                break
            if page is None:
                if failure.site_wide:
                    # Yahoo as a whole is unwell (403/429 included): worth trying again later.
                    failure.error.location = rest_from(n)
                    failure.error.retryable = True
                    errors.append(failure.error.to_dict())
                    break
                errors.append(failure.error.to_dict())
                continue
            if _page_number(page['current']) != n:
                # Yahoo ignored ?page= (or served another page): what follows cannot be trusted.
                errors.append(NewsError('parse', '第 %d 页内容与页码不符，已停止抓取后续页' % n,
                                        _page_location([n], total), retryable=False).to_dict())
                break
            pages[n] = list(page['blocks'])

        if total > MAX_PAGES:
            errors.append(NewsError(
                'yahoo', '这篇文章共 %d 页，只显示前 %d 页，其余请看原文' % (total, MAX_PAGES),
                '第 %s 页 / 共 %d 页' % (MAX_PAGES + 1 if total == MAX_PAGES + 1 else '%d–%d' % (MAX_PAGES + 1, total),
                                     total), retryable=False).to_dict())
        order = sorted(pages)
        art = dict(meta)
        art.update(pages={'total': total, 'fetched': len(order),
                          'missing': [n for n in range(1, shown + 1) if n not in pages]},
                   blocks=[b for n in order for b in pages[n]], errors=errors,
                   page_blocks=[[n, pages[n]] for n in order])
        return art


def _page_number(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
