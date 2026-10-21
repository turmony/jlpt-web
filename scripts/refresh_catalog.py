"""Rebuild the catalog's cards (titles, images, complete cores) from one pinned study commit."""
import argparse
import json
import re
import subprocess
from pathlib import Path

try:
    from scripts.update_catalog_core import extract_core
except ModuleNotFoundError:  # run as a plain script
    from update_catalog_core import extract_core


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True)


def refresh(repo, revision, catalog):
    revision = git(repo, 'rev-parse', '--verify', revision + '^{commit}').strip()
    cards = []
    for name in sorted(git(repo, 'ls-tree', '-r', '--name-only', revision, 'jlpt-notes/grammar').split()):
        if not name.endswith('.md'):
            continue
        card_id = name.rsplit('/', 1)[1][:-3]
        body = git(repo, 'show', f'{revision}:{name}')
        front = re.match(r'---\n(.*?)\n---\n', body, re.S)
        title = json.loads(front[1])['title']
        level = card_id[:2]
        images = {kind: f'./images/{revision}/assets/grammar/{level.lower()}/{card_id}-{kind}.png'
                  for kind in ('connection', 'example')}
        # A card without both screenshots would make its whole range unreadable.
        for url in images.values():
            git(repo, 'cat-file', '-e', f'{revision}:jlpt-notes/{url.split("/", 3)[3]}')
        cards.append({'id': card_id, 'level': level, 'number': int(card_id[-4:]),
                      'title': title, 'images': images, 'core': extract_core(body)})
    return {**catalog, 'revision': revision, 'cards': cards}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--study', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--catalog', default=str(Path(__file__).resolve().parent.parent/'data/catalog.json'))
    args = parser.parse_args()
    path = Path(args.catalog)
    catalog = refresh(args.study, args.revision, json.loads(path.read_text()))
    path.write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f"Catalog now has {len(catalog['cards'])} cards at {catalog['revision']}")
