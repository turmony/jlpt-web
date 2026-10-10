"""Prepare a persistent worktree and export pinned image blobs, without updates."""
import argparse
import json
import shutil
import subprocess
import tarfile
from pathlib import Path, PurePosixPath
from urllib.parse import unquote


def materialize_images(repo, catalog, output):
    revision = catalog['revision']
    if not isinstance(revision, str) or len(revision) != 40 or any(c not in '0123456789abcdef' for c in revision):
        raise ValueError('目录必须固定到完整 Git 提交')
    prefix = f'./images/{revision}/'
    mapping = {}
    for card in catalog['cards']:
        for url in card['images'].values():
            if url is None:
                continue
            if not url.startswith(prefix):
                raise ValueError('目录图片版本不一致')
            relative = PurePosixPath(unquote(url[len(prefix):]))
            if relative.is_absolute() or '..' in relative.parts or relative.parts[:2] != ('assets', 'grammar'):
                raise ValueError('目录图片路径无效')
            mapping['jlpt-notes/' + str(relative)] = Path(output) / 'grammar/images' / revision / str(relative)
    process = subprocess.Popen(['git', '-C', str(repo), 'archive', revision, '--', *sorted(mapping)], stdout=subprocess.PIPE)
    written = set()
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
            for member in archive:
                if member.isdir():
                    continue
                if member.name not in mapping or not member.isfile():
                    raise ValueError('Git 图片归档含非预期文件')
                destination = mapping[member.name]
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, destination.open('wb') as target:
                    shutil.copyfileobj(source, target)
                written.add(member.name)
        if process.wait() or written != set(mapping):
            raise ValueError('图片归档不完整')
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.terminate(); process.wait()
    return len(written)


def prepare(base, revision):
    repo = Path(base) / 'repos/jlpt-study'
    worktree = Path(base) / 'worktrees/study'
    repo.parent.mkdir(parents=True, exist_ok=True)
    worktree.parent.mkdir(parents=True, exist_ok=True)
    if not (repo / '.git').exists():
        subprocess.run(['git', 'clone', '--no-checkout', 'https://github.com/turmony/jlpt-study.git', str(repo)], check=True)
    subprocess.run(['git', '-C', str(repo), 'cat-file', '-e', revision + '^{commit}'], check=True)
    if not worktree.exists():
        subprocess.run(['git', '-C', str(repo), 'worktree', 'add', '-b', 'web-study', str(worktree), revision], check=True)
    branch = subprocess.check_output(['git', '-C', str(worktree), 'branch', '--show-current'], text=True).strip()
    if branch != 'web-study':
        raise ValueError('长期工作区不在 web-study 分支，拒绝改动')
    subprocess.run(['git', '-C', str(repo), 'remote', 'set-url', '--push', 'origin', str(Path(base) / 'push-disabled')], check=True)
    return repo, worktree


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default='/srv/jlpt')
    parser.add_argument('--catalog', default='data/catalog.json')
    args = parser.parse_args()
    catalog = json.loads(Path(args.catalog).read_text())
    repo, worktree = prepare(args.base, catalog['revision'])
    count = materialize_images(repo, catalog, Path(args.base) / 'static')
    print(f'Prepared persistent study worktree; exported {count} pinned images')
