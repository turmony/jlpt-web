"""Launch the Node adapter which reuses AionUi's ACP connection implementation."""
import json
import shutil
from pathlib import Path


def command(prompt, session, cwd, model='', effort='', timeout=3600):
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Codex ACP 需要 Node.js 22，请安装后重新执行')
    runner = Path(__file__).resolve().parent.parent / 'agent/dist/runner.mjs'
    if not runner.is_file():
        raise RuntimeError('Codex ACP 尚未构建，请执行 npm ci && npm run build')
    return [node, str(runner)], json.dumps({'prompt': prompt, 'session': session,
        'cwd': str(Path(cwd).resolve()), 'model': model, 'effort': effort,
        'timeout': timeout}, ensure_ascii=False) + '\n'
