import os
import subprocess
import tempfile
from pathlib import Path


def commit_exercise(root, task_id, files):
    """Commit with a private index; preserve all existing staging and never push."""
    root = Path(root).resolve()
    env = os.environ.copy()
    def git(*args, input=None):
        p = subprocess.run(['git', '-C', str(root), *args], input=input, capture_output=True, env=env)
        if p.returncode:
            raise RuntimeError(p.stderr.decode(errors='replace').strip())
        return p.stdout.decode().strip()
    trailer = f'JLPT-Web-Task: {task_id}'
    for line in git('log', '--format=%H%x09%B%x00', '--all', '--fixed-strings', f'--grep={trailer}').split('\0'):
        if line.strip():
            sha, body = line.strip().split('\t', 1)
            if trailer in body.splitlines():
                git('reset', '--quiet', 'HEAD', '--', *sorted(set(files)))
                return sha
    from server.artifacts import safe_file
    files = sorted(set(files))
    if not files:
        raise ValueError('没有可提交的练习产物')
    for name in files:
        safe_file(root, name)
    parent = git('rev-parse', 'HEAD')
    branch = git('symbolic-ref', 'HEAD')
    with tempfile.TemporaryDirectory(prefix='jlpt-index-') as tmp:
        env['GIT_INDEX_FILE'] = str(Path(tmp) / 'index')
        git('read-tree', parent)
        git('add', '--', *files)
        tree = git('write-tree')
        if tree == git('rev-parse', f'{parent}^{{tree}}'):
            raise ValueError('相关产物未产生新内容；拒绝空提交')
        # commit-tree does not run repository hooks that could stage unrelated files or push.
        sha = git('commit-tree', tree, '-p', parent, input=f'feat: 记录网页练习作答成绩\n\n{trailer}\n'.encode())
        git('update-ref', branch, sha, parent)
    env.pop('GIT_INDEX_FILE', None)
    git('reset', '--quiet', 'HEAD', '--', *files)
    return sha
