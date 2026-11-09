"""Writes the userscript loader for this site to a file, to be put into Userscripts' script folder once.

    python3 scripts/make_news_loader.py [--config /srv/jlpt/state/config.json] [--out build/jlpt-news.user.js]

Only `origin`, `news_sites` and `news_debug` are read from the config; nothing else is printed or written.
The file is the same text GET /api/news/loader.user.js serves, so after this first placement Userscripts
updates the loader itself ("check for updates") whenever the served @version is higher.
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # python -I leaves the repository out of sys.path

from server.news_sites import LOADER_VERSION, debug_enabled, loader_script, sites  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--config', default='/srv/jlpt/state/config.json')
    parser.add_argument('--out', default=str(ROOT / 'build' / 'jlpt-news.user.js'))
    args = parser.parse_args(argv)
    try:
        config = json.loads(Path(args.config).read_text(encoding='utf-8'))
        origin = config['origin']
        text = loader_script(origin, sites(config), debug=debug_enabled(config))
    except (OSError, ValueError, KeyError) as error:
        sys.exit(f'无法生成加载器：{type(error).__name__}: {error}')
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding='utf-8')
    print(f'已写入 {out}（加载器 v{LOADER_VERSION}，来源 {origin}）')


if __name__ == '__main__':
    main()
