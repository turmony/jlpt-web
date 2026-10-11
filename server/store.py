import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from .history import summarize_first_message


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
            columns = {row[1] for row in db.execute('PRAGMA table_info(events)')}
            if 'data' not in columns:
                db.execute('ALTER TABLE events ADD COLUMN data TEXT')

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

    def history_tasks(self):
        with self.connect() as db:
            originals = {}
            for raw in db.execute("SELECT data FROM records WHERE kind='previews' ORDER BY rowid"):
                preview = json.loads(raw[0])
                if not preview.get('used') or not preview.get('text'):
                    continue
                key = preview.get('task_id')
                generation = preview.get('generation', 0)
                if key not in originals or generation < originals[key][0]:
                    originals[key] = (generation, preview['text'])
            rows = db.execute('''
                SELECT records.data, first_user.text, first_user.data,
                       activity.first_time, activity.last_time
                FROM records
                LEFT JOIN (
                    SELECT task, MIN(time) AS first_time, MAX(time) AS last_time,
                           MIN(CASE WHEN type='user' THEN id END) AS first_user_id
                    FROM events GROUP BY task
                ) AS activity ON activity.task=records.id
                LEFT JOIN events AS first_user ON first_user.id=activity.first_user_id
                WHERE records.kind='tasks'
            ''')
            result = []
            for raw, first_text, first_data, first_time, last_time in rows:
                task = json.loads(raw)
                preview_generation, preview_text = originals.get(task['id'], (0, None))
                event_generation = json.loads(first_data or '{}').get('generation')
                # Preview generations precede their user event by one. Older
                # conversations may only start recording user events on a later turn.
                earlier_preview = preview_text and (
                    not first_text or
                    (isinstance(event_generation, (int, float)) and
                     preview_generation + 1 < event_generation) or
                    (event_generation is None and preview_generation == 0)
                )
                original_text = preview_text if earlier_preview else first_text
                task['title'] = task.get('title') or summarize_first_message(original_text)
                task['created_at'] = task.get('created_at') or first_time or task.get('updated') or 0
                task['last_activity'] = max(last_time or 0, task.get('updated') or 0, task['created_at'])
                result.append(task)
            return sorted(result, key=lambda task: task['last_activity'], reverse=True)

    def change(self, kind, key, fn):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            value = self._get(db, kind, key)
            fn(value)
            self._put(db, kind, key, value)
            return value

    def set_archived(self, task_id, archived):
        if not isinstance(archived, bool):
            raise ValueError('归档状态必须为布尔值')
        def update(task):
            if archived:
                if task.get('status') in ('queued', 'running', 'checking', 'committing'):
                    raise Conflict('对话正在处理中，请完成或停止后再归档')
                task.setdefault('archived_at', time.time())
            else:
                task.pop('archived_at', None)
        return self.change('tasks', task_id, update)

    def enqueue(self, preview_id):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            p = self._get(db, 'previews', preview_id)
            if p.get('used'):
                return self._get(db, 'tasks', p['task_id'])
            try:
                task = self._get(db, 'tasks', p['task_id'])
            except KeyError:
                task = {'id': p['task_id'], 'cli': p['cli'], 'generation': 0, 'session': None,
                        'title': summarize_first_message(p.get('text', p['prompt'])), 'created_at': time.time()}
            if task.get('archived_at'):
                raise Conflict('请先恢复已归档对话，再继续发送')
            if task['generation'] != p['generation'] or task.get('status') in ('queued', 'running', 'checking', 'committing', 'complete', 'commit_failed'):
                raise Conflict('任务已改变，请刷新对话后重试；已判卷任务仅可重试提交')
            if task['cli'] != p['cli']:
                raise Conflict('继续对话必须使用原 CLI')
            task.setdefault('transport', 'exec' if task.get('session') and task['cli'] == 'codex'
                            else 'acp' if task['cli'] == 'codex' else 'cli')
            task.update(status='queued', prompt=p['prompt'], operation=p.get('operation', 'auto'), preview_id=preview_id,
                        model=p.get('model', ''), effort=p.get('effort', ''),
                        generation=task['generation'] + 1, updated=time.time(), error=None, started_at=None, finished_at=None)
            p['used'] = True
            self._put(db, 'tasks', task['id'], task)
            self._put(db, 'previews', preview_id, p)
            self._event(db, task['id'], 'user', p.get('text', p['prompt']),
                        {'message_id': preview_id, 'generation': task['generation']})
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

    @staticmethod
    def _event(db, task, kind, text, data=None):
        db.execute('INSERT INTO events(task,type,text,time,data) VALUES (?,?,?,?,?)',
                   (task, kind, str(text)[:64000], time.time(),
                    json.dumps(data, ensure_ascii=False) if data is not None else None))

    def event(self, task, kind, text, data=None):
        with self.connect() as db:
            self._event(db, task, kind, text, data)

    def events(self, task, after=0):
        with self.connect() as db:
            result = []
            for row in db.execute('SELECT id,type,text,time,data FROM events WHERE task=? AND id>? ORDER BY id LIMIT 500', (task, after)):
                event = dict(zip(('id', 'type', 'text', 'time'), row[:4]))
                if row[4] is not None:
                    event['data'] = json.loads(row[4])
                result.append(event)
            return result

    def recover(self):
        for task in self.list('tasks'):
            if task.get('status') in ('queued', 'running', 'checking', 'committing'):
                task['status'] = 'commit_failed' if task.get('grade') else 'interrupted'
                task['error'] = '服务重启中断了任务，资料已保留，可继续提示或重试提交'
                self.put('tasks', task['id'], task)
