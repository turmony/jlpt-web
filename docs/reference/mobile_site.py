"""Build the standalone image-card site without changing learning materials."""

import argparse
import json
import posixpath
import re
import shutil
import subprocess
import tarfile
from html.parser import HTMLParser
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import quote, unquote, urlsplit

import yaml
from markdown import Markdown

from .asset_links import MARKDOWN_EXTENSIONS, AssetIndex
from .reader.metadata import parse_markdown


class _Screenshots(HTMLParser):
    """Select screenshots from their heading/alt text, never from filenames."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.heading = ''
        self.heading_depth = 0
        self.images: dict[str, str] = {}
        self.all_images: list[str] = []

    def handle_starttag(self, tag, attrs):
        if re.fullmatch(r'h[1-6]', tag):
            self.heading = ''
            self.heading_depth = 1
        if tag == 'img':
            values = dict(attrs)
            label = self.heading + ' ' + values.get('alt', '')
            kind = 'connection' if '接续' in label else 'example' if re.search(r'例句|例文', label) else None
            if values.get('src'):
                self.all_images.append(values['src'])
            if kind and values.get('src'):
                self.images.setdefault(kind, values['src'])

    def handle_data(self, data):
        if self.heading_depth:
            self.heading += data

    def handle_endtag(self, tag):
        if re.fullmatch(r'h[1-6]', tag):
            self.heading_depth = 0


def build_catalog(root: Path, image_base: str) -> dict:
    """Resolve actual Markdown images relative to each card, read-only."""
    root = root.resolve(strict=True)
    index = AssetIndex(root)
    cards = []
    for path in sorted((root / 'grammar').glob('n*/*.md')):
        if not re.fullmatch(r'N[1-5]-G-\d{4}', path.stem):
            continue
        relative = path.relative_to(root)
        text = path.read_text(encoding='utf-8')
        frontmatter = re.match(r'\A---\r?\n(.*?)\r?\n---\r?\n', text, re.DOTALL)
        if not frontmatter:
            raise ValueError(f'{relative}: 缺少卡片元数据')
        try:
            raw = yaml.safe_load(frontmatter[1])
            if not isinstance(raw, dict) or raw.get('id') != path.stem or raw.get('level') != path.stem[:2]:
                raise ValueError('卡号与等级不匹配')
            normalized = '---\n' + json.dumps(raw, ensure_ascii=False, default=str) + '\n---\n' + text[frontmatter.end():]
        except (yaml.YAMLError, ValueError) as error:
            raise ValueError(f'{relative}: 元数据无法解析（{error}）') from error
        parsed = parse_markdown(relative, normalized)
        if parsed.warning:
            raise ValueError(f'{relative}: {parsed.warning}')
        metadata = parsed.metadata
        if metadata.source_id != path.stem or metadata.level != path.stem[:2]:
            raise ValueError(f'{relative}: 卡号与等级不匹配')
        issues = index.check(relative, parsed.body)
        if issues:
            raise ValueError('\n'.join(map(str, issues)))
        parser = _Screenshots()
        parser.feed(Markdown(extensions=MARKDOWN_EXTENSIONS).convert(parsed.body))
        screenshot = raw.get('source', {}).get('screenshot') if isinstance(raw.get('source'), dict) else None
        if screenshot and len(parser.all_images) == 2:
            for link in parser.all_images:
                target = posixpath.normpath(posixpath.join(relative.parent.as_posix(), unquote(urlsplit(link).path)))
                if target == screenshot:
                    parser.images['connection'] = link
                    parser.images['example'] = next(other for other in parser.all_images if other != link)
                    break
        images = {'connection': None, 'example': None}
        for kind, link in parser.images.items():
            split = urlsplit(link)
            if split.scheme or split.netloc:
                raise ValueError(f'{relative}: 课程截图必须引用资料库内的图片')
            target = posixpath.normpath(posixpath.join(relative.parent.as_posix(), unquote(split.path)))
            images[kind] = image_base.rstrip('/') + '/' + quote(target, safe='/')
        title = metadata.display_title.removeprefix(path.stem + '｜')
        cards.append({'id': path.stem, 'level': metadata.level,
                      'number': int(path.stem.rsplit('-', 1)[1]), 'title': title, 'images': images})
    return {'schema': 1, 'cards': sorted(cards, key=lambda c: (c['level'], c['number']))}


def _git_snapshot(project: Path, revision: str, destination: Path) -> str:
    commit = subprocess.check_output(
        ['git', '-C', str(project), 'rev-parse', '--verify', revision + '^{commit}'], text=True,
    ).strip()
    with subprocess.Popen(
        ['git', '-C', str(project), 'archive', commit, 'jlpt-notes/grammar', 'jlpt-notes/assets'],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ) as process:
        with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
            for member in archive:
                target = destination / member.name
                if not target.resolve().is_relative_to(destination.resolve()):
                    raise ValueError('Git 快照包含越界路径')
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as source, target.open('wb') as output:
                        shutil.copyfileobj(source, output)
                else:
                    raise ValueError(f'Git 快照包含不支持的链接文件: {member.name}')
        error = process.stderr.read().decode('utf-8', errors='replace')
        if process.wait():
            raise ValueError(f'无法读取 Git 快照: {error}')
    return commit


def build_site(project: Path, output: Path, *, revision: str = 'HEAD',
               repository: str = 'turmony/jlpt-study') -> dict:
    """Publish UI and an allowlisted Cloudflare proxy, without any image binaries."""
    project, output = project.resolve(), output.resolve()
    if output == project or output.is_relative_to(project / 'jlpt-notes') or output.is_relative_to(project / 'mobile'):
        raise ValueError('输出目录不能覆盖项目或源资料')
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', repository):
        raise ValueError('仓库名必须为 owner/repository')
    if any((output / name).exists() or (output / name).is_symlink() for name in ('images', 'assets')):
        raise ValueError('输出目录含旧版图片包，请选择新的输出目录')
    with TemporaryDirectory(prefix='jlpt-mobile-snapshot-') as temporary:
        snapshot = Path(temporary)
        commit = _git_snapshot(project, revision, snapshot)
        root = snapshot / 'jlpt-notes'
        image_prefix = Path('images') / commit
        image_base = f'./{image_prefix.as_posix()}/'
        catalog = build_catalog(root, image_base)
        manifest = {}
        for card in catalog['cards']:
            for url in card['images'].values():
                if url is None:
                    continue
                published = Path(unquote(urlsplit(url).path))
                relative = published.relative_to(image_prefix)
                manifest['/' + published.as_posix()] = (
                    f'https://raw.githubusercontent.com/{repository}/{commit}/jlpt-notes/'
                    + quote(relative.as_posix(), safe='/')
                )
    catalog.update({'repository': repository, 'revision': commit})
    output.mkdir(parents=True, exist_ok=True)
    for path in (project / 'mobile').iterdir():
        publishable = path.suffix in {'.html', '.css', '.mjs', '.svg'} or path.name == '_headers'
        if path.is_file() and not path.is_symlink() and publishable and path.name != 'image-proxy.mjs':
            shutil.copy2(path, output / path.name)
    proxy = (project / 'mobile/image-proxy.mjs').read_text(encoding='utf-8')
    (output / '_worker.js').write_text(
        'export const imageManifest = ' + json.dumps(manifest, ensure_ascii=False, separators=(',', ':'))
        + ';\n' + proxy + '\nexport default createImageProxy(imageManifest);\n', encoding='utf-8',
    )
    (output / '_routes.json').write_text(
        json.dumps({'version': 1, 'include': ['/images/*'], 'exclude': []}) + '\n', encoding='utf-8',
    )
    (output / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    (output / '.nojekyll').touch()
    return catalog


def main() -> None:
    parser = argparse.ArgumentParser(description='构建独立的 iPhone 双图语法卡页面')
    parser.add_argument('--project', type=Path, default=Path.cwd())
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--revision', default='HEAD')
    parser.add_argument('--repository', default='turmony/jlpt-study')
    args = parser.parse_args()
    catalog = build_site(args.project, args.output, revision=args.revision,
                         repository=args.repository)
    print(f"已构建 {len(catalog['cards'])} 张卡片目录 → {args.output}（{catalog['revision'][:7]}）")


if __name__ == '__main__':
    main()
