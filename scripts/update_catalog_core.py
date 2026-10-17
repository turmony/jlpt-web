"""Copy complete core sections from the catalog's pinned, committed notes."""
import argparse
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path


def extract_core(body):
    headings = []
    offset = 0
    fence = None
    for line in body.splitlines(keepends=True):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        if marker:
            run = marker[1]
            if fence is None:
                fence = run
            elif run[0] == fence[0] and len(run) >= len(fence) and not line[marker.end():].strip():
                fence = None
        elif fence is None:
            heading = re.match(r'^(#{1,6})[ \t]+(.+?)[ \t]*\r?\n?$', line)
            if heading:
                title = re.sub(r'[ \t]+#+$', '', heading[2]).strip()
                headings.append((offset, offset + len(line), len(heading[1]), title))
        offset += len(line)

    exact = [heading for heading in headings if heading[3] == '核心']
    selected = exact or [heading for heading in headings if '核心' in heading[3]]
    sections = []
    previous_end = -1
    for start, content_start, depth, title in selected:
        if start < previous_end:
            continue
        # Two legacy cards use peer-level “功能” headings inside “核心”.
        end = next((other[0] for other in headings if other[0] > start and other[2] <= depth
                    and not (title == '核心' and other[2] == depth and other[3].startswith('功能'))), len(body))
        # A variant heading can carry meaning, e.g. “核心：附带状况”.
        sections.append(body[content_start if title == '核心' else start:end].strip())
        previous_end = end
    return '\n\n'.join(sections)


def update_catalog(repo, catalog_path):
    catalog_path = Path(catalog_path)
    catalog = json.loads(catalog_path.read_text())
    snapshot = subprocess.check_output(['git', '-C', str(repo), 'archive', catalog['revision'], 'jlpt-notes/grammar'])
    with tarfile.open(fileobj=io.BytesIO(snapshot)) as archive:
        for card in catalog['cards']:
            name = f"jlpt-notes/grammar/{card['level'].lower()}/{card['id']}.md"
            with archive.extractfile(name) as source:
                card['core'] = extract_core(source.read().decode('utf-8'))
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')) + '\n')
    return sum(bool(card['core']) for card in catalog['cards'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--study', required=True)
    parser.add_argument('--catalog', default=str(Path(__file__).resolve().parent.parent/'data/catalog.json'))
    args = parser.parse_args()
    print(f'Updated {update_catalog(args.study, args.catalog)} complete core sections')
