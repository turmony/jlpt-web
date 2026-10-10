import hashlib
import json
import subprocess
import threading
import time
from pathlib import Path

from .artifacts import (QUIZZES, safe_file, atomic_write, validate_paper,
                        validate_grade, run_validators, append_attempts)
from .cli import run_cli
from .git import commit_exercise
from .store import Conflict


class Worker:
    def __init__(self, store, study):
        self.store = store
        self.study = Path(study).resolve()
        self.signal = threading.Event()
        self.stop = threading.Event()
        self.cancelled = threading.Event()
        self.active = None
        self.thread = None
        self.mutex = threading.Lock()

    def start(self):
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.thread.start()

    def wake(self):
        self.signal.set()

    def close(self):
        self.stop.set()
        self.cancelled.set()
        self.signal.set()
        if self.thread:
            self.thread.join(timeout=8)

    def loop(self):
        while not self.stop.is_set():
            if not self.run_once():
                self.signal.wait(1)
                self.signal.clear()

    def set_task(self, task_id, **fields):
        return self.store.change('tasks', task_id, lambda task: task.update(fields, updated=time.time()))

    def cancel(self, task_id):
        def update(task):
            if task.get('grade') or task['status'] in ('complete', 'committing'):
                raise Conflict('判卷成果已通过检查，请查看成绩或重试提交')
            if task['status'] in ('running', 'checking'):
                task['cancellation_requested'] = True
            else:
                task['status'] = 'cancelled'
        task = self.store.change('tasks', task_id, update)
        if task.get('cancellation_requested') and task_id == self.active:
            self.cancelled.set()
        return task

    def retry_commit(self, task_id):
        def retry(task):
            if task.get('status') != 'commit_failed' or not task.get('grade'):
                raise Conflict('此任务没有待重试的本地提交')
            task.update(status='queued', commit_only=True, error=None)
        task = self.store.change('tasks', task_id, retry)
        self.wake()
        return task

    def check_cancelled(self):
        if self.cancelled.is_set() or (self.active and self.store.get('tasks', self.active).get('cancellation_requested')):
            raise InterruptedError('任务已取消，资料和会话已保留')

    def destination(self, name):
        path = self.study / name
        cursor = self.study
        for part in Path(name).parts:
            cursor /= part
            if cursor.is_symlink():
                raise ValueError('写入路径含符号链接')
        return path

    def export_submissions(self):
        for paper in self.store.list('papers'):
            submission = paper.get('submission')
            if not submission:
                continue
            base = f"{QUIZZES}/web/submissions/{submission['id']}"
            body = {'paper_id': paper['id'], **submission}
            text = '\n'.join(('*' if a.get('uncertain') else '') + n + '-' + a['answer']
                             for n, a in sorted(submission['answers'].items(), key=lambda item: int(item[0]))) + '\n'
            for suffix, data in (('.json', (json.dumps(body, ensure_ascii=False, indent=2) + '\n').encode()), ('.txt', text.encode())):
                path = self.destination(base + suffix)
                if path.exists():
                    if path.read_bytes() != data:
                        raise ValueError('正式交卷文件被修改，拒绝继续')
                else:
                    atomic_write(path, data)

    def run_once(self):
        if not self.mutex.acquire(blocking=False):
            return False
        try:
            task = self.store.claim_next()
            if not task:
                return False
            self.active = task['id']
            self.cancelled.clear()
            try:
                if task.get('commit_only'):
                    self.commit(task)
                    return True
                self.check_cancelled()
                self.export_submissions()
                attempts_path = self.destination(f'{QUIZZES}/attempts.jsonl')
                attempts_before = attempts_path.read_bytes() if attempts_path.exists() else b''
                head = self.git_head()
                def event(data):
                    if data.get('session'):
                        self.set_task(task['id'], session=data['session'])
                    for key in ('text', 'diagnostic', 'error'):
                        if data.get(key):
                            self.store.event(task['id'], 'message' if key == 'text' else key, data[key])
                run_cli(task['cli'], task['prompt'], task.get('session'), self.study, event, self.cancelled)
                self.check_cancelled()
                if self.git_head() != head:
                    raise ValueError('CLI 修改了 Git 历史；网页流程禁止模型提前提交')
                if (attempts_path.read_bytes() if attempts_path.exists() else b'') != attempts_before:
                    raise ValueError('CLI 修改了历史作答；请恢复后继续，后台才可追加')
                self.set_task(task['id'], status='checking')
                self.process_handoff(task)
            except Exception as error:
                state = 'cancelled' if isinstance(error, InterruptedError) else 'failed'
                current = self.store.get('tasks', task['id'])
                if current.get('cancellation_requested'):
                    state = 'cancelled'
                if current.get('grade'):
                    state = 'commit_failed'
                self.set_task(task['id'], status=state, error=str(error), commit_only=False)
                self.store.event(task['id'], 'error', str(error))
            finally:
                self.active = None
            return True
        finally:
            self.mutex.release()

    def git_head(self):
        if not (self.study / '.git').exists():
            return None
        return subprocess.check_output(['git', '-C', str(self.study), 'rev-parse', 'HEAD'], text=True).strip()

    def process_handoff(self, task):
        name = f"{QUIZZES}/web/{task['id']}/turn-{task['generation']}.json"
        handoff = json.loads(safe_file(self.study, name).read_text())
        if handoff.get('task_id') != task['id'] or handoff.get('turn') != task['generation']:
            raise ValueError('交接文件不属于当前任务轮次')
        if handoff.get('message'):
            self.store.event(task['id'], 'message', handoff['message'])
        if handoff.get('operation') == 'clarify':
            self.set_task(task['id'], status='waiting')
            return
        if handoff.get('operation') == 'generate':
            paper = validate_paper(self.study, handoff['slug'], handoff.get('requirements'))
            checks = run_validators(self.study, paper)
            self.check_cancelled()
            paper['hashes'] = {f: hashlib.sha256(safe_file(self.study, f).read_bytes()).hexdigest() for f in paper['files']}
            paper.update(task_id=task['id'], checks=checks)
            self.store.publish_paper(paper)
        elif handoff.get('operation') == 'grade':
            paper = self.store.get('papers', handoff['slug'])
            if paper.get('commit') or paper.get('grade_task') not in (None, task['id']):
                raise Conflict('该试卷已经完成判卷与提交')
            for filename, digest in paper['hashes'].items():
                if hashlib.sha256(safe_file(self.study, filename).read_bytes()).hexdigest() != digest:
                    raise ValueError('已展示的试卷或答案发生变化，拒绝判卷')
            report_name = f"{QUIZZES}/results/{paper['id']}-result.md"
            if handoff.get('report') != report_name:
                raise ValueError('成绩报告路径不对应目标试卷')
            report = safe_file(self.study, report_name).read_text()
            rows = validate_grade(paper, handoff, report)
            checks = run_validators(self.study, paper)
            self.check_cancelled()
            submission_id = paper['submission']['id']
            files = sorted(set(paper['files'] + [report_name, f'{QUIZZES}/attempts.jsonl',
                f'{QUIZZES}/web/submissions/{submission_id}.json', f'{QUIZZES}/web/submissions/{submission_id}.txt', name]))
            # Receipt is persisted before append/commit, so process death can retry without another CLI turn.
            grade = {'paper_id': paper['id'], 'report': report_name, 'score': handoff['score'], 'rows': rows, 'submission_id': submission_id,
                     'files': files, 'checks': checks,
                     'hashes': {f: hashlib.sha256(safe_file(self.study, f).read_bytes()).hexdigest()
                                for f in files if f != f'{QUIZZES}/attempts.jsonl'}}
            self.store.accept_grade(task['id'], paper['id'], grade)
            self.commit(self.store.get('tasks', task['id']))
        else:
            raise ValueError('交接文件操作无效；需要 generate、grade 或 clarify')

    def commit(self, task):
        grade = task['grade']
        self.set_task(task['id'], status='committing')
        for filename, digest in grade['hashes'].items():
            if hashlib.sha256(safe_file(self.study, filename).read_bytes()).hexdigest() != digest:
                raise ValueError('已验证产物被修改，拒绝提交；无需重新交卷')
        path = self.destination(f'{QUIZZES}/attempts.jsonl')
        # Refuse unrelated uncommitted history edits; allow only our exact idempotent append.
        previous = subprocess.check_output(['git', '-C', str(self.study), 'show', f'HEAD:{QUIZZES}/attempts.jsonl'])
        current = path.read_bytes() if path.exists() else b''
        suffix = current[len(previous):] if current.startswith(previous) else None
        if suffix is None or any(json.loads(line).get('web_submission_id') != grade['submission_id'] for line in suffix.splitlines() if line.strip()):
            raise ValueError('作答历史含无关未提交修改，拒绝将其一并提交')
        append_attempts(path, grade['submission_id'], grade['rows'])
        sha = commit_exercise(self.study, grade['submission_id'], grade['files'])
        self.store.change('papers', grade['paper_id'], lambda p: p.update(commit=sha, report=grade['report'], score=grade['score']))
        self.set_task(task['id'], status='complete', commit=sha, commit_only=False, error=None)
