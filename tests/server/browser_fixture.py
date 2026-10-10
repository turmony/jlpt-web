import json
import sys
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
cli.status = lambda: [{'id': name, 'installed': True, 'detail': '测试执行器', 'models': items} for name, items in catalogs.items()]

base = Path(sys.argv[1])
app = Application({'state': str(base), 'study': str(base/'study'), 'static': str(Path('server-public').resolve()),
                   'origin': 'http://127.0.0.1', 'secure_cookie': False, 'password_hash': Auth.hash_password('browser-test-password')})
app.store.put('tasks','task1',{'id':'task1','cli':'codex','status':'ready','generation':1,'session':'s1'})
app.store.put('papers','paper1',{'id':'paper1','title':'测试试卷','task_id':'task1','questions':[
    {'number':1,'id':'N3-Q-0001','section':'form','prompt':'安全文本 <img src=x onerror=alert(1)>','options':{'1':'一','2':'二','3':'三','4':'四'}}], 'draft':{},'version':0})
path = base/'study/jlpt-notes/quizzes/answers/paper1-answers.md'; path.parent.mkdir(parents=True)
path.write_text('答案与解析：第 1 题选 2。')
server = create_server(app, ('127.0.0.1',0))
app.config['origin'] = f'http://127.0.0.1:{server.server_port}'
print(app.config['origin'],flush=True)
server.serve_forever()
