import json
import os
import selectors
import signal
import subprocess
import time
from .models import catalog
from .executables import resolve_cli

CLIS = ('codex', 'qoder', 'agy')


def command(cli, prompt, session=None, model='', effort='', persist_session=True):
    model_flags = ['--model', model] if model else []
    if cli == 'codex':
        flags = ['--json', '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=true',
                 *model_flags, *(['-c', 'model_reasoning_effort=' + json.dumps(effort)] if effort else [])]
        if session:
            return ['codex', 'exec', 'resume', *flags, session, '-'], prompt
        return ['codex', 'exec', '--sandbox', 'workspace-write', *flags, '-'], prompt
    if cli == 'qoder':
        return [resolve_cli(cli) or 'qoder', '-p', prompt, '--output-format', 'stream-json', '--include-partial-messages', '--permission-mode', 'auto',
                *model_flags, *(['--reasoning-effort', effort] if effort else []),
                *([] if persist_session else ['--no-session-persistence']),
                *(['--resume', session] if session else [])], ''
    if cli == 'agy':
        return ['agy', '-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions',
                *model_flags, *(['--effort', effort] if effort else []),
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
        if event.get('type') == 'stream_event':
            block = event.get('event', {})
            delta = block.get('delta', {})
            if block.get('type') == 'content_block_delta' and delta.get('type') == 'text_delta':
                out.update(type='assistant', text=delta.get('text', ''), delta=True)
        if event.get('type') == 'assistant':
            out['text'] = '\n'.join(p.get('text', '') for p in event.get('message', {}).get('content', []) if p.get('type') == 'text')
            if event.get('message', {}).get('id') and out['text']:
                out.update(type='assistant', message_id='qoder-'+event['message']['id'])
        if event.get('type') == 'result':
            out['text'] = event.get('result', '')
            if event.get('is_error'):
                out['error'] = event.get('result') or 'CLI 失败'
    return out


def status():
    result = []
    for cli in CLIS:
        binary = resolve_cli(cli)
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
        options = catalog(cli)
        item['models'] = options['models']
        if options.get('error'):
            item['models_error'] = options['error']
        result.append(item)
    return result


def run_cli(cli, prompt, session, cwd, callback, cancelled, timeout=3600, model='', effort='', transport=None, persist_session=True):
    use_acp = cli == 'codex' and transport != 'exec'
    if use_acp:
        from .acp import command as acp_command
        argv, stdin = acp_command(prompt, session, cwd, model, effort, timeout)
    else:
        argv, stdin = command(cli, prompt, session, model, effort, persist_session)
    process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    buffers = {}
    total = 0
    deadline = time.monotonic() + timeout
    error = None
    assistant_texts = []
    qoder_message_id = 'qoder-response'
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
                        parsed = json.loads(line)
                        event = parsed if use_acp else decode_event(cli, parsed)
                        if cli == 'qoder' and not use_acp:
                            partial=parsed.get('event', {})
                            if partial.get('type') == 'message_start':
                                qoder_message_id = 'qoder-'+partial.get('message', {}).get('id', 'response')
                            if event.get('delta'):
                                event['message_id'] = qoder_message_id
                        if not use_acp and cli in ('qoder', 'agy'):
                            terminal = parsed.get('type') == 'result' if cli == 'qoder' else parsed.get('event') == 'result'
                            duplicate = event.get('text', '').strip() in [text.strip() for text in (*assistant_texts, ''.join(assistant_texts))]
                            if terminal and assistant_texts and duplicate:
                                # Result repeats the completed assistant response; retain its session/error.
                                event.pop('text', None)
                            elif not terminal and event.get('text'):
                                assistant_texts.append(event['text'])
                                if cli == 'agy':
                                    event.update(type='assistant', message_id='agy-response', delta=True)
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
            # Let the ACP parent send session/cancel and clean up descendants.
            # Sending SIGTERM to the whole group first would prevent delivery.
            if use_acp:
                process.send_signal(signal.SIGTERM)
            else:
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
