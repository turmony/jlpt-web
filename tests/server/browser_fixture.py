import json
import sys
import threading
import time
from pathlib import Path
from server.app import Application, create_server
from server.auth import Auth
from server import cli, models

catalogs = {
    'codex': [{'id': 'codex-example', 'label': 'Codex Example', 'efforts': ['low', 'high']}],
    'agy': [{'id': 'gemini-example', 'label': 'Gemini Example', 'efforts': ['low', 'medium', 'high']}],
    'qoder': [{'id': 'auto', 'label': 'Auto', 'efforts': ['low', 'high']}],
}
models.catalog = lambda name: {'models': catalogs[name]}
cli.status = lambda: [{'id': name, 'installed': True, 'auth': 'ready', 'usable': True, 'checking': False, 'detail': '测试执行器已验证真实对话', 'models': items} for name, items in catalogs.items()]

base = Path(sys.argv[1])
app = Application({'state': str(base), 'study': str(base/'study'), 'static': str(Path('server-public').resolve()),
                   'origin': 'http://127.0.0.1', 'secure_cookie': False, 'password_hash': Auth.hash_password('browser-test-password')})
class FixtureHealth:
    def snapshot(self, **kwargs):
        return cli.status()
    def refresh(self):
        pass
app.health = FixtureHealth()
class StreamingWorker:
    def wake(self):
        for task in app.store.list('tasks'):
            if task.get('prompt') != 'SSE_TEST' or task['status'] != 'queued':
                continue
            def emit(task=task):
                started=time.time()
                app.store.change('tasks',task['id'],lambda t:t.update(status='running',started_at=started))
                data={'message_id':'stream-reply','generation':task['generation'],'delta':True}
                app.store.event(task['id'],'assistant','流式**回',data)
                time.sleep(2)
                app.store.event(task['id'],'assistant','复**完成',data)
                app.store.event(task['id'],'finish','',{'generation':task['generation'],'elapsed_seconds':2,'started_at':started,'finished_at':started+2})
                app.store.change('tasks',task['id'],lambda t:t.update(status='answered',finished_at=started+2))
            threading.Thread(target=emit,daemon=True).start()
app.worker=StreamingWorker()
app.store.put('tasks','task1',{'id':'task1','cli':'codex','status':'ready','generation':1,'session':'s1'})
app.store.event('task1', 'user', '请为我出一份练习', {'message_id': 'user1', 'generation': 1})
app.store.event('task1', 'assistant', '这是 **练习**。', {'message_id': 'reply1', 'generation': 1, 'delta': True})
app.store.event('task1', 'assistant', '\n<script>alert(1)</script>\n[危险链接](javascript:alert(1))', {'message_id': 'reply1', 'generation': 1, 'delta': True})
app.store.put('tasks','task2',{'id':'task2','cli':'agy','status':'waiting','generation':1,'session':'a1'})
app.store.event('task2', 'user', '请帮我解释语法用法。')
app.store.event('task2', 'assistant', '另一个会话的**答', {'message_id': 'reply2', 'generation': 1, 'delta': True})
app.store.event('task2', 'assistant', '案**', {'message_id': 'reply2', 'generation': 1, 'delta': True})
app.store.event('task2', 'message', '保留的相同片段')
app.store.event('task2', 'message', '保留的相同片段')
app.store.put('tasks','task3',{'id':'task3','cli':'qoder','status':'answered','generation':1,'session':'q1'})
app.store.event('task3', 'user', '介绍你自己', {'message_id': 'user3', 'generation': 1})
app.store.event('task3', 'message', '我是 Qoder，你的智能体助手。')
app.store.event('task3', 'message', '我是 Qoder，你的智能体助手。')
app.store.put('tasks','task4',{'id':'task4','cli':'qoder','status':'failed','generation':1,'session':'q2','error':'测试执行器异常'})
app.store.event('task4', 'user', '检查智能体运行错误')
app.store.event('task4', 'error', '测试执行器异常', {'generation': 1})
app.store.put('papers','paper1',{'id':'paper1','title':'测试试卷','task_id':'task1','questions':[
    {'number':1,'id':'N3-Q-0001','section':'form','prompt':'安全文本 <img src=x onerror=alert(1)>','options':{'1':'一','2':'二','3':'三','4':'四'}}], 'draft':{},'version':0})
app.store.put('tasks','task5',{'id':'task5','cli':'codex','status':'waiting','generation':1,'session':'s5'})
app.store.event('task5','user','请帮我复习 N3 助词。')
app.store.event('task5','assistant','一起复习助词。')
with app.store.connect() as db:
    db.execute('UPDATE events SET time=time-86400 WHERE task=?', ('task5',))
path = base/'study/jlpt-notes/quizzes/answers/paper1-answers.md'; path.parent.mkdir(parents=True)
path.write_text('答案与解析：第 1 题选 2。')
server = create_server(app, ('127.0.0.1',0))
app.config['origin'] = f'http://127.0.0.1:{server.server_port}'
print(app.config['origin'],flush=True)
server.serve_forever()
