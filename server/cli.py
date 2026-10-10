import json
import os
import selectors
import shutil
import signal
import subprocess
import time

CLIS = ('codex', 'qoder', 'agy')


def command(cli, prompt, session=None):
    if cli == 'codex':
        flags = ['--json', '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=true']
        if session:
            return ['codex', 'exec', 'resume', *flags, session, '-'], prompt
        return ['codex', 'exec', '--sandbox', 'workspace-write', *flags, '-'], prompt
    if cli == 'qoder':
        return ['qoder', '-p', prompt, '--output-format', 'stream-json', '--permission-mode', 'auto',
                *(['--session-id', session] if session else [])], ''
    if cli == 'agy':
        return ['agy', '-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions',
                *(['--conversation', session] if session else [])], ''
    raise ValueError('不支持的 CLI')


def decode_event(cli, event):
    out = {}
    session = event.get('thread_id') or event.get('session_id') or event.get('conversation_id')
    if session:
        out['session'] = session
    if cli == 'codex':
        item = event.get('item', {})
        if event.get('type') == 'item.completed' and item.get('type') == 'agent_message':
            out['text'] = item.get('text', '')
        if event.get('type') in ('error', 'turn.failed'):
            out['error'] = event.get('message') or event.get('error', {}).get('message') or 'CLI 失败'
    elif cli == 'agy':
        if event.get('event') == 'step_update':
            step = event.get('step_update', {})
            if step.get('step_type') == 'agent_response' and step.get('text_delta'):
                out['text'] = step['text_delta']
        if event.get('event') == 'result':
            result = event.get('result', {})
            out.update(session=result.get('conversation_id'), text=result.get('response', ''))
            if result.get('status') != 'SUCCESS':
                out['error'] = result.get('error') or result.get('status') or 'CLI 失败'
    else:
        if event.get('type') == 'assistant':
            out['text'] = '\n'.join(p.get('text', '') for p in event.get('message', {}).get('content', []) if p.get('type') == 'text')
        if event.get('type') == 'result':
            out['text'] = event.get('result', '')
            if event.get('is_error'):
                out['error'] = event.get('result') or 'CLI 失败'
    return out


def status():
    result = []
    for cli in CLIS:
        binary = shutil.which(cli)
        item = {'id': cli, 'installed': bool(binary), 'auth': 'unverified', 'detail': '未安装' if not binary else '已安装，登录状态尚未验证'}
        if binary:
            try:
                p = subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=8)
                item['version'] = (p.stdout or p.stderr).strip()[:150]
                if cli == 'codex':
                    p = subprocess.run([binary, 'login', 'status'], capture_output=True, text=True, timeout=8)
                    item.update(auth='ready' if p.returncode == 0 else 'required', detail='已登录' if p.returncode == 0 else '需要登录')
            except (OSError, subprocess.TimeoutExpired) as error:
                item['detail'] = str(error)
        result.append(item)
    return result


def run_cli(cli, prompt, session, cwd, callback, cancelled, timeout=3600):
    argv, stdin = command(cli, prompt, session)
    process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    buffers = {}
    total = 0
    deadline = time.monotonic() + timeout
    error = None
    try:
        process.stdin.write(stdin.encode())
        process.stdin.close()
        for pipe, name in ((process.stdout, 'stdout'), (process.stderr, 'stderr')):
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, name)
            buffers[name] = b''
        while selector.get_map():
            if cancelled.is_set():
                raise InterruptedError('任务已取消，生成资料已保留')
            if time.monotonic() > deadline:
                raise TimeoutError('CLI 超时，资料与会话已保留')
            for key, _ in selector.select(.25):
                chunk = os.read(key.fileobj.fileno(), 65536)
                name = key.data
                total += len(chunk)
                if total > 4 * 1024 * 1024:
                    raise ValueError('CLI 输出超过 4 MiB，任务停止，已有资料保留')
                buffers[name] += chunk
                if not chunk:
                    selector.unregister(key.fileobj)
                    if buffers[name]:
                        buffers[name] += b'\n'
                while b'\n' in buffers[name]:
                    raw, buffers[name] = buffers[name].split(b'\n', 1)
                    line = raw.decode('utf-8', errors='replace')
                    if not line:
                        continue
                    if name == 'stderr':
                        callback({'diagnostic': line})
                        continue
                    try:
                        event = decode_event(cli, json.loads(line))
                    except (ValueError, TypeError, AttributeError):
                        event = {'diagnostic': line}
                    callback(event)
                    error = event.get('error') or error
        code = process.wait(timeout=5)
        if code != 0 or error:
            raise RuntimeError(error or f'{cli} 退出码 {code}；请查看运行错误')
    finally:
        selector.close()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        process.stdout.close()
        process.stderr.close()
        if not process.stdin.closed:
            process.stdin.close()
