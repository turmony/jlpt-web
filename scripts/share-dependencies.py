"""Share identical dependency files without letting npm remove deployed packages.

Preview by default. Each directory keeps its own entries; only regular files
are hardlinked. Reinstall with npm ci before changing shared files in place.
"""
import argparse
import hashlib
import os
import stat
import tempfile
from pathlib import Path


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').digest()


def share(source, deployed, apply=False):
    source, deployed = Path(source).resolve(), Path(deployed).resolve()
    if (source / 'package-lock.json').read_bytes() != (deployed / 'package-lock.json').read_bytes():
        raise ValueError('Dependency lockfiles differ; install matching versions first')
    local = source / 'node_modules'
    remote = (deployed / 'node_modules').resolve()
    if local.is_symlink() or not local.is_dir() or not remote.is_dir():
        raise ValueError('Source node_modules must be a real installed directory')
    if local.stat().st_dev != remote.stat().st_dev:
        raise ValueError('Hardlink sharing requires the same filesystem')
    candidates = []
    # Validate the complete source tree before changing any file. A matching
    # lockfile alone does not prove the installed packages are identical.
    for directory, directories, files in os.walk(local):
        for name in directories + files:
            path = Path(directory) / name
            other = remote / path.relative_to(local)
            if path.is_symlink():
                if not other.is_symlink() or os.readlink(path) != os.readlink(other):
                    raise ValueError(f'Dependency symlink differs: {path.relative_to(local)}')
            elif path.is_dir():
                if other.is_symlink() or not other.is_dir():
                    raise ValueError(f'Dependency directory differs: {path.relative_to(local)}')
            elif path.is_file():
                if other.is_symlink() or not other.is_file():
                    raise ValueError(f'Dependency file is missing: {path.relative_to(local)}')
                before, target = path.stat(), other.stat()
                if (before.st_size != target.st_size or
                        stat.S_IMODE(before.st_mode) != stat.S_IMODE(target.st_mode) or
                        digest(path) != digest(other)):
                    raise ValueError(f'Dependency file differs: {path.relative_to(local)}')
                if (before.st_dev, before.st_ino) != (target.st_dev, target.st_ino):
                    candidates.append((path, other))
            else:
                raise ValueError(f'Unsupported dependency entry: {path.relative_to(local)}')
    if apply:
        for path, other in candidates:
            descriptor, temporary = tempfile.mkstemp(prefix='.jlpt-link-', dir=path.parent)
            os.close(descriptor)
            temporary = Path(temporary)
            try:
                temporary.unlink()
                os.link(other, temporary)
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
    return len(candidates)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument('--deployed', default='/srv/jlpt/app')
    parser.add_argument('--apply', action='store_true', help='Apply sharing after full validation')
    args = parser.parse_args()
    count = share(args.source, args.deployed, args.apply)
    print(f'{"Shared" if args.apply else "Would share"} {count} identical dependency files')
