import http.client
import os
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from server.app import Application, create_server
from server.auth import Auth


@unittest.skipUnless(os.environ.get('CADDY_BINARY'), 'Set CADDY_BINARY to exercise the real deployment proxy')
class CaddyTests(unittest.TestCase):
    def test_deployment_proxy_blocks_static_content_and_shares_api_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); static=root/'static'; static.mkdir()
            (static/'index.html').write_text('private home')
            (static/'login.html').write_text('public login')
            (static/'catalog.json').write_text('private catalog')
            with socket.socket() as s:
                s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
            origin=f'http://127.0.0.1:{port}'
            app=Application({'state':str(root),'study':str(root/'study'),'static':str(static),
                             'origin':origin,'secure_cookie':False,'password_hash':Auth.hash_password('test-password')})
            backend=create_server(app,('127.0.0.1',0))
            threading.Thread(target=backend.serve_forever,daemon=True).start()
            config=Path('deploy/Caddyfile').read_text().replace('admin 127.0.0.1:2019','admin off').replace(':8080 {',f'http://127.0.0.1:{port} {{').replace('/srv/jlpt/static',str(static)).replace('127.0.0.1:8765',f'127.0.0.1:{backend.server_port}')
            config_path=root/'Caddyfile';config_path.write_text(config)
            process=subprocess.Popen([os.environ['CADDY_BINARY'],'run','--config',str(config_path)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    try:
                        conn=http.client.HTTPConnection('127.0.0.1',port,timeout=2);conn.request('GET','/login.html');response=conn.getresponse();response.read();conn.close();break
                    except OSError:time.sleep(.03)
                def request(path,data=None,cookie=''):
                    conn=http.client.HTTPConnection('127.0.0.1',port,timeout=2)
                    headers={'Cookie':cookie,'Origin':origin,'Content-Type':'application/json'}
                    conn.request('GET' if data is None else 'POST',path,body=data,headers=headers)
                    response=conn.getresponse();result=(response.status,dict(response.getheaders()),response.read());conn.close();return result
                for path in ('/','/catalog.json','/grammar/images/test.png'):
                    status,headers,body=request(path)
                    self.assertEqual(status,303,(path,headers,body))
                    self.assertEqual(headers['Location'],'/login.html')
                    self.assertNotIn(b'private',body)
                self.assertEqual(request('/api/tasks')[0],401)
                status,headers,_=request('/api/login','{"password":"test-password"}')
                self.assertEqual(status,200)
                cookie=headers['Set-Cookie'].split(';')[0]
                self.assertEqual(request('/',cookie=cookie)[2],b'private home')
                self.assertEqual(request('/catalog.json',cookie=cookie)[2],b'private catalog')
            finally:
                process.terminate();process.wait(timeout=5)
                backend.shutdown();backend.server_close()
