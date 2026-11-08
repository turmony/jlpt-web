"""Live spot check of Yahoo! JAPAN News parsing (run by hand; touches the real site).

For every category RSS it opens the first N articles with the same code the server uses
(Yahoo.open + to_sentences) and prints one line per article:
  分类 / 页数 / 图片数 / 非雅虎图片 / 句数 / 结果
Failed lines carry the stage and reason. A topic that points outside Yahoo News (e.g. SNS posts
on search.yahoo.co.jp) cannot be opened by design: it is listed as 跳过 and not counted. The last
line is 「成功 x / 共 y」 (plus the skipped count); the exit code is 1 when anything failed. Images are only checked against the allowed hosts, never downloaded.
Pages within an article are spaced by Yahoo.open (about 0.5 s); articles are spaced the same.

  /srv/jlpt/venv/bin/python scripts/news_probe.py --per-feed 3
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.news_errors import STAGES, NewsError  # noqa: E402
from server.news_text import TokenizerUnavailable, to_sentences  # noqa: E402
from server.news_yahoo import FEEDS, PAGE_GAP, Yahoo, image_host_ok  # noqa: E402

HEADER = '分类\t页数\t图片数\t非雅虎图片\t句数\t结果'


def _fail(stage, reason, location=None):
    where = '（%s）' % location if location else ''
    return '失败 stage=%s（%s） reason=%s%s' % (stage, STAGES.get(stage, stage), reason, where)


def _texts(blocks):
    for block in blocks:
        if block.get('type') in ('heading', 'paragraph'):
            yield block.get('text') or ''
        elif block.get('type') == 'image':
            yield block.get('caption') or ''


def _off_news_topic(error):
    return error.stage == 'parse' and error.location == '话题页' and not error.retryable


def check_article(yahoo, url):
    """(pages, images, off_host_images, sentences, result, ok); ok is None when skipped."""
    pages, images, off_host, sentences = '-', 0, 0, 0
    try:
        art = yahoo.open(url, lambda stage, text: None)
        p = art['pages']
        pages = '%d/%d' % (p['fetched'], p['total'])
        srcs = [b.get('src') for b in art['blocks'] if b.get('type') == 'image']
        srcs += [b['cover'] for b in art['blocks'] if b.get('type') == 'video' and b.get('cover')]
        images = len(srcs)
        off_host = sum(1 for s in srcs if not image_host_ok(s))
        for text in _texts(art['blocks']):
            sentences += len(to_sentences(text, sentences))
        unknown = sum(1 for b in art['blocks'] if b.get('type') == 'unknown')
        if art.get('errors'):
            e = art['errors'][0]
            return pages, images, off_host, sentences, _fail(e['stage'], e['reason'], e.get('location')), False
        if not sentences:
            return pages, images, off_host, sentences, _fail('parse', '正文没有句子'), False
        note = '（含 %d 个未识别元素）' % unknown if unknown else ''
        return pages, images, off_host, sentences, '成功' + note, True
    except NewsError as e:
        if _off_news_topic(e):
            return pages, images, off_host, sentences, '跳过 %s' % e.reason, None
        return pages, images, off_host, sentences, _fail(e.stage, e.reason, e.location), False
    except TokenizerUnavailable:
        return pages, images, off_host, sentences, _fail('tokenize', '分词组件未安装（用新闻 venv 运行）'), False
    except Exception as e:  # anything else means the page shape surprised the parser
        return pages, images, off_host, sentences, _fail('parse', '正文结构无法识别：%s' % type(e).__name__), False


def run(yahoo, per_feed, out=print, sleep=time.sleep, feeds=None):
    """Probe each feed; returns (ok, total, skipped)."""
    ok = total = skipped = 0
    first = True
    out(HEADER)
    for slug in feeds or FEEDS:
        label = FEEDS[slug]
        try:
            items = yahoo.feed(slug)[:per_feed]
        except NewsError as e:
            total += per_feed
            out('%s\t-\t-\t-\t-\t%s（列表，计 %d 篇失败）' % (label, _fail(e.stage, e.reason, e.location), per_feed))
            continue
        for item in items:
            if not first:
                sleep(PAGE_GAP)
            first = False
            pages, images, off_host, sentences, result, good = check_article(yahoo, item['url'])
            if good is None:
                skipped += 1
            else:
                total += 1
                ok += good
            out('%s\t%s\t%d\t%d\t%d\t%s\t%s' % (label, pages, images, off_host, sentences, result, item['url']))
    out('成功 %d / 共 %d' % (ok, total) + ('（跳过 %d 篇：话题不指向雅虎新闻文章）' % skipped if skipped else ''))
    return ok, total, skipped


def main(argv=None):
    parser = argparse.ArgumentParser(description='抓取雅虎新闻各分类的前几篇并逐篇解析、分词。')
    parser.add_argument('--per-feed', type=int, default=3, help='每个分类抽查几篇（默认 3）')
    parser.add_argument('--feed', action='append', choices=list(FEEDS), help='只查指定分类，可重复')
    args = parser.parse_args(argv)
    if args.per_feed < 1:
        parser.error('--per-feed 至少为 1')
    ok, total, _skipped = run(Yahoo(), args.per_feed, out=lambda line: print(line, flush=True), feeds=args.feed)
    return 0 if ok == total else 1


if __name__ == '__main__':
    sys.exit(main())
