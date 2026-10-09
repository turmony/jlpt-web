import json
import subprocess
from pathlib import Path

import pytest

from jlpt_notes.mobile_site import build_catalog, build_site


def write_note(root, number=31, *, example=True, connection='../../assets/grammar/n1/接续 图.png'):
    path = root / 'grammar/n1' / f'N1-G-{number:04d}.md'
    path.parent.mkdir(parents=True, exist_ok=True)
    metadata = {'id': path.stem, 'kind': 'grammar', 'level': 'N1', 'title': '<〜であれ> & 条件'}
    body = f'## 接续板书截图\n\n![接续](<{connection}>)\n'
    if example:
        body += '\n## 课程例句截图\n\n![例句](../../assets/grammar/n1/句子.png)\n'
    # No blank line after the delimiter is also valid in the reader.
    path.write_text('---\n' + json.dumps(metadata, ensure_ascii=False) + '\n---\n' + body)
    for name in ['接续 图.png', '句子.png']:
        image = root / 'assets/grammar/n1' / name
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(b'image fixture')
    return path


def test_catalog_resolves_body_links_and_encodes_urls(tmp_path):
    write_note(tmp_path)
    result = build_catalog(tmp_path, 'https://example.test/snapshot/jlpt-notes/')
    card = result['cards'][0]
    assert card['id'] == 'N1-G-0031'
    assert card['number'] == 31
    assert card['title'] == '<〜であれ> & 条件'
    assert card['images'] == {
        'connection': 'https://example.test/snapshot/jlpt-notes/assets/grammar/n1/%E6%8E%A5%E7%BB%AD%20%E5%9B%BE.png',
        'example': 'https://example.test/snapshot/jlpt-notes/assets/grammar/n1/%E5%8F%A5%E5%AD%90.png',
    }


def test_catalog_keeps_cards_without_two_images(tmp_path):
    write_note(tmp_path, example=False)
    assert build_catalog(tmp_path, 'https://example.test/')['cards'][0]['images']['example'] is None


def test_yaml_frontmatter_and_japanese_example_label(tmp_path):
    path = write_note(tmp_path)
    path.write_text('---\nid: N1-G-0031\nlevel: N1\ntitle: であれ\n---\n'
                    '## 接续\n![板书](../../assets/grammar/n1/接续%20图.png)\n'
                    '## 例文\n![例文](../../assets/grammar/n1/句子.png)\n')
    card = build_catalog(tmp_path, 'https://example.test/')['cards'][0]
    assert card['title'] == 'であれ'
    assert card['images']['example'].endswith('%E5%8F%A5%E5%AD%90.png')


def test_connection_caption_can_also_mention_examples(tmp_path):
    path = write_note(tmp_path)
    path.write_text(path.read_text().replace('![接续]', '![接续、意义及例句板书]'))
    card = build_catalog(tmp_path, 'https://example.test/')['cards'][0]
    assert card['images']['connection'].endswith('%E6%8E%A5%E7%BB%AD%20%E5%9B%BE.png')
    assert card['images']['example'].endswith('%E5%8F%A5%E5%AD%90.png')


def test_unlabelled_pair_matches_source_screenshot_exactly(tmp_path):
    path = write_note(tmp_path)
    text = path.read_text().replace('"kind": "grammar"', '"kind": "grammar", "source": {"screenshot": "assets/grammar/n1/接续 图.png"}')
    text = text.replace('## 接续板书截图', '## 视频学习资料整理').replace('## 课程例句截图', '').replace('![接续]', '![]').replace('![例句]', '![]')
    path.write_text(text)
    card = build_catalog(tmp_path, 'https://example.test/')['cards'][0]
    assert card['images']['connection'].endswith('%E6%8E%A5%E7%BB%AD%20%E5%9B%BE.png')
    assert card['images']['example'].endswith('%E5%8F%A5%E5%AD%90.png')


@pytest.mark.parametrize('link', ['../../assets/grammar/n1/missing.png', '../../../outside.png'])
def test_catalog_rejects_broken_or_outside_links(tmp_path, link):
    write_note(tmp_path, connection=link)
    with pytest.raises(ValueError, match='N1-G-0031'):
        build_catalog(tmp_path, 'https://example.test/')


def test_catalog_excludes_other_documents_and_sorts_by_number(tmp_path):
    write_note(tmp_path, 40)
    write_note(tmp_path, 31)
    (tmp_path / 'grammar/n1/README.md').write_text('# directory')
    assert [c['number'] for c in build_catalog(tmp_path, 'https://example.test/')['cards']] == [31, 40]


def test_build_uses_committed_snapshot_without_bundled_images(tmp_path):
    project = tmp_path / 'project'
    project.mkdir()
    note = write_note(project / 'jlpt-notes')
    (project / 'mobile').mkdir()
    (project / 'mobile/index.html').write_text('<html>test page</html>')
    (project / 'mobile/_headers').write_text('/assets/*\n  Cache-Control: no-store\n')
    (project / 'mobile/image-proxy.mjs').write_text(
        (Path(__file__).parents[1] / 'mobile/image-proxy.mjs').read_text())
    def git(*args):
        return subprocess.check_output(['git', '-C', str(project), *args], text=True).strip()
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture')
    commit = git('rev-parse', 'HEAD')
    note.write_text(note.read_text().replace('条件', '未提交内容'))
    (project / 'jlpt-notes/assets/grammar/n1/接续 图.png').write_bytes(b'uncommitted image')
    result = build_site(project, tmp_path / 'site')
    assert result['revision'] == commit
    assert result['cards'][0]['title'] == '<〜であれ> & 条件'
    assert result['cards'][0]['images']['connection'] == f'./images/{commit}/assets/grammar/n1/%E6%8E%A5%E7%BB%AD%20%E5%9B%BE.png'
    assert not (tmp_path / 'site/images').exists()
    assert not (tmp_path / 'site/grammar').exists()
    assert not (tmp_path / 'site/assets').exists()
    assert not (tmp_path / 'site/image-proxy.mjs').exists()
    worker = (tmp_path / 'site/_worker.js').read_text()
    assert f'/images/{commit}/assets/grammar/n1/接续 图.png' in worker
    assert f'https://raw.githubusercontent.com/turmony/jlpt-study/{commit}/jlpt-notes/assets/grammar/n1/%E6%8E%A5%E7%BB%AD%20%E5%9B%BE.png' in worker
    assert 'export default createImageProxy(imageManifest)' in worker
    assert json.loads((tmp_path / 'site/_routes.json').read_text()) == {
        'version': 1, 'include': ['/images/*'], 'exclude': [],
    }
    assert '未提交内容' in note.read_text()
    assert json.loads((tmp_path / 'site/catalog.json').read_text()) == result
    assert (tmp_path / 'site/_headers').read_text() == '/assets/*\n  Cache-Control: no-store\n'
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'updated image')
    updated = build_site(project, tmp_path / 'updated-site')
    assert updated['cards'][0]['images']['connection'] != result['cards'][0]['images']['connection']
    assert f'/images/{commit}/' not in (tmp_path / 'updated-site/_worker.js').read_text()


@pytest.mark.parametrize('directory', ['images', 'assets/grammar/n1'])
def test_build_rejects_legacy_bundled_output_without_deleting_it(tmp_path, directory):
    image = tmp_path / 'site' / directory / 'old.png'
    image.parent.mkdir(parents=True)
    image.write_bytes(b'preserve')
    with pytest.raises(ValueError, match='旧版图片包'):
        build_site(tmp_path / 'project', tmp_path / 'site')
    assert image.read_bytes() == b'preserve'


def test_output_inside_source_is_rejected(tmp_path):
    write_note(tmp_path / 'jlpt-notes')
    with pytest.raises(ValueError, match='输出目录'):
        build_site(tmp_path, tmp_path / 'jlpt-notes/site')
