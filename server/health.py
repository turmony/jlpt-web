"""Verify CLI usability through the same transport used by real conversations."""
import copy
import secrets
import tempfile
import threading
import time

from . import cli, models


class CliHealth:
    def __init__(self, timeout=45):
        self.timeout = timeout
        self.lock = threading.Lock()
        self.cancelled = threading.Event()
        self.thread = None
        self.started = False
        self.closed = False
        self.states = [{'id': name, 'installed': None, 'auth': 'unverified',
                        'usable': False, 'checking': False, 'models': [],
                        'detail': '尚未验证真实对话'} for name in cli.CLIS]

    def snapshot(self, start=False):
        if start and not self.started:
            self.refresh(initial=True)
        with self.lock:
            return copy.deepcopy(self.states)

    def refresh(self, initial=False):
        with self.lock:
            if self.closed or (initial and self.started) or (self.thread and self.thread.is_alive()):
                return
            self.started = True
            self.cancelled.clear()
            for item in self.states:
                item.update(usable=False, checking=True, auth='checking', detail='正在验证真实对话…')
            models.discover.cache_clear()
            self.thread = threading.Thread(target=self.check, daemon=True, name='cli-health')
            self.thread.start()

    def publish(self, item):
        with self.lock:
            self.states = [copy.deepcopy(item) if row['id'] == item['id'] else row for row in self.states]

    def check(self):
        try:
            metadata = cli.status()
            for original in metadata:
                item = copy.deepcopy(original)
                item.update(usable=False, checking=bool(item['installed']),
                            auth='checking' if item['installed'] else 'missing',
                            detail='正在验证真实对话…' if item['installed'] else '未安装')
                self.publish(item)
            for original in metadata:
                if self.cancelled.is_set():
                    return
                if not original['installed']:
                    continue
                item = copy.deepcopy(original)
                item.update(usable=False, checking=False, auth='failed', checked_at=time.time())
                challenge = 'JLPT_CONNECTION_' + secrets.token_hex(8)
                prompt = f'仅回复以下文字：{challenge}。不要调用工具、读取或写入文件、运行命令。'
                replies = []
                def receive(event):
                    if event.get('type') in (None, 'assistant', 'message') and event.get('text'):
                        replies.append(event['text'])
                try:
                    with tempfile.TemporaryDirectory(prefix='jlpt-cli-check-') as workspace:
                        cli.run_cli(item['id'], prompt, None, workspace, receive, self.cancelled,
                                    timeout=self.timeout, persist_session=False)
                    if challenge not in ''.join(replies):
                        raise RuntimeError('未收到真实对话的验证回复')
                    item.update(usable=True, auth='ready', detail='已验证登录并成功完成真实对话')
                except Exception as error:
                    item['detail'] = '未通过对话验证：' + str(error)[:350]
                item['checked_at'] = time.time()
                self.publish(item)
        except Exception as error:
            with self.lock:
                for item in self.states:
                    item.update(usable=False, checking=False, auth='failed',
                                detail='验证失败：' + str(error)[:350])

    def close(self):
        with self.lock:
            self.closed = True
            self.cancelled.set()
            thread = self.thread
        if thread:
            thread.join(timeout=8)
