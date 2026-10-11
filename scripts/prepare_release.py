"""Prepare a release without duplicating installed packages or course images."""
import argparse
import hashlib
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path


def copy_static(source, target):
    path = Path(source)
    if 'images' in path.parts and path.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.gif'):
        os.link(source, target)
        return target
    return shutil.copy2(source, target)


def prepare(source, base, name):
    source, base = Path(source).resolve(), Path(base).resolve()
    current_app, current_static = (base/'app').resolve(), (base/'static').resolve()
    lock = (source/'package-lock.json').read_bytes()
    key = hashlib.sha256(lock).hexdigest()[:16]
    modules = base/'shared'/'node_modules'/key
    if not modules.exists():
        modules.parent.mkdir(parents=True, exist_ok=True)
        if (current_app/'package-lock.json').read_bytes() == lock and not (current_app/'node_modules').is_symlink():
            (current_app/'node_modules').rename(modules)
            (current_app/'node_modules').symlink_to(modules, target_is_directory=True)
        else:
            shutil.copytree(source/'node_modules', modules, symlinks=True)
    release = base/'releases'/name
    ignore = shutil.ignore_patterns('node_modules', '.git', '.env*', '.dev.vars*', '__pycache__', '*.pyc',
                                    'server-public', 'public', '.wrangler', '.superpowers', '.agents', '.codex', '.aws', '*.log')
    shutil.copytree(source, release/'app', symlinks=True, ignore=ignore)
    (release/'app'/'node_modules').symlink_to(modules, target_is_directory=True)
    shutil.copytree(current_static, release/'static', copy_function=copy_static)
    (release/'previous-release.txt').write_text(f'app={current_app}\nstatic={current_static}\n')
    return release


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument('--base', default='/srv/jlpt')
    parser.add_argument('--name', default=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-chat-stream')
    args = parser.parse_args()
    print(prepare(args.source, args.base, args.name))
