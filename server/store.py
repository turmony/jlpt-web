import json
import sqlite3
import time
import uuid
from contextlib import contextmanager


class Conflict(ValueError):
    pass


class Store:
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, data TEXT, PRIMARY KEY(kind,id));
                CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, task TEXT, type TEXT, text TEXT, time REAL);
                CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires REAL);
            ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _get(db, kind, key):
        row = db.execute('SELECT data FROM records WHERE kind=? AND id=?', (kind, key)).fetchone()
        if row is None:
            raise KeyError(key)
        return json.loads(row[0])

    @staticmethod
    def _put(db, kind, key, data):
        db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?)', (kind, key, json.dumps(data, ensure_ascii=False)))

    def get(self, kind, key):
        with self.connect() as db:
            return self._get(db, kind, key)

    def put(self, kind, key, data):
        with self.connect() as db:
            self._put(db, kind, key, data)
        return data

    def list(self, kind):
        with self.connect() as db:
            return [json.loads(r[0]) for r in db.execute('SELECT data FROM records WHERE kind=? ORDER BY rowid DESC', (kind,))]

    def change(self, kind, key, fn):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            value = self._get(db, kind, key)
            fn(value)
            self._put(db, kind, key, value)
            return value

    def enqueue(self, preview_id):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            p = self._get(db, 'previews', preview_id)
            if p.get('used'):
                return self._get(db, 'tasks', p['task_id'])
            try:
                task = self._get(db, 'tasks', p['task_id'])
            except KeyError:
                task = {'id': p['task_id'], 'cli': p['cli'], 'generation': 0, 'session': None}
            if task['generation'] != p['generation'] or task.get('status') in ('queued', 'running', 'checking', 'committing', 'complete', 'commit_failed'):
                raise Conflict('任务已改变，请重新预览；已判卷任务仅可重试提交')
            if task['cli'] != p['cli']:
                raise Conflict('继续对话必须使用原 CLI')
            task.update(status='queued', prompt=p['prompt'], preview_id=preview_id,
                        generation=task['generation'] + 1, updated=time.time(), error=None)
            p['used'] = True
            self._put(db, 'tasks', task['id'], task)
            self._put(db, 'previews', preview_id, p)
            return task

    def save_draft(self, paper_id, answers, version):
        def update(p):
            if p.get('submission') or p['version'] != version:
                raise Conflict('作答已交卷或已被其他标签页修改，请重新读取')
            known = {str(q['number']) for q in p['questions']}
            if not isinstance(answers, dict) or not set(answers) <= known:
                raise ValueError('作答题号无效')
            for answer in answers.values():
                if not isinstance(answer, dict) or not isinstance(answer.get('answer'), str) or len(answer['answer']) > 200:
                    raise ValueError('作答格式无效')
                if not isinstance(answer.get('uncertain', False), bool):
                    raise ValueError('不确定标记无效')
            p.update(draft=answers, version=version + 1)
        return self.change('papers', paper_id, update)

    def submit(self, paper_id, version):
        def update(p):
            if p.get('submission'):
                return
            if version != p['version']:
                raise Conflict('草稿版本已改变，请重新读取')
            if any(not p['draft'].get(str(q['number']), {}).get('answer', '').strip() for q in p['questions']):
                raise ValueError('请填写全部题目；有疑问可标记不确定')
            p['submission'] = {'id': str(uuid.uuid4()), 'answers': p['draft'], 'time': time.time()}
        return self.change('papers', paper_id, update)

    def claim_next(self):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            for key, raw in db.execute("SELECT id,data FROM records WHERE kind='tasks' ORDER BY rowid"):
                task = json.loads(raw)
                if task['status'] == 'queued':
                    task.update(status='committing' if task.get('commit_only') else 'running', cancellation_requested=False)
                    self._put(db, 'tasks', key, task)
                    return task
        return None

    def publish_paper(self, paper):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            task = self._get(db, 'tasks', paper['task_id'])
            if task.get('cancellation_requested') or task.get('status') != 'checking':
                raise Conflict('任务已取消或状态改变，不交付新试卷')
            try:
                existing = self._get(db, 'papers', paper['id'])
            except KeyError:
                self._put(db, 'papers', paper['id'], paper)
                existing = paper
            if existing['task_id'] != paper['task_id'] or existing['hashes'] != paper['hashes']:
                raise Conflict('不能替换已经展示的试卷，请使用新试卷名称')
            task.update(status='ready', paper_id=paper['id'])
            self._put(db, 'tasks', task['id'], task)
            return existing

    def accept_grade(self, task_id, paper_id, grade):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            task = self._get(db, 'tasks', task_id)
            paper = self._get(db, 'papers', paper_id)
            if task.get('cancellation_requested') or task['status'] != 'checking':
                raise Conflict('任务已取消或状态已改变，不推进判卷')
            if paper.get('grade_task') not in (None, task_id) or paper.get('commit'):
                raise Conflict('该正式交卷已有判卷成果，请重试原任务的本地提交')
            if paper['submission']['id'] != grade['submission_id']:
                raise Conflict('正式交卷记录发生变化')
            task.update(grade=grade, paper_id=paper_id)
            paper.update(grade_task=task_id, report=grade['report'], score=grade['score'])
            self._put(db, 'tasks', task_id, task)
            self._put(db, 'papers', paper_id, paper)

    def event(self, task, kind, text):
        with self.connect() as db:
            db.execute('INSERT INTO events(task,type,text,time) VALUES (?,?,?,?)', (task, kind, str(text)[:64000], time.time()))

    def events(self, task, after=0):
        with self.connect() as db:
            return [dict(zip(('id', 'type', 'text', 'time'), r)) for r in db.execute(
                'SELECT id,type,text,time FROM events WHERE task=? AND id>? ORDER BY id LIMIT 500', (task, after))]

    def recover(self):
        for task in self.list('tasks'):
            if task.get('status') in ('queued', 'running', 'checking', 'committing'):
                task['status'] = 'commit_failed' if task.get('grade') else 'interrupted'
                task['error'] = '服务重启中断了任务，资料已保留，可继续提示或重试提交'
                self.put('tasks', task['id'], task)
