import http.client
import http.server
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


@unittest.skipUnless(os.environ.get('CADDY_BINARY'), 'Set CADDY_BINARY to exercise the real deployment proxy')
class CaddyStreamingTests(unittest.TestCase):
    def test_sse_passes_through_caddy_incrementally(self):
        class Backend(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length') or 0))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Accel-Buffering', 'no')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.close_connection = True
                self.wfile.write(b'event: first\ndata: {"n": 1}\n\n'); self.wfile.flush()
                time.sleep(.5)
                self.wfile.write(b'event: second\ndata: {"n": 2}\n\n'); self.wfile.flush()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); static=root/'static'; static.mkdir()
            with socket.socket() as s:
                s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
            backend=http.server.ThreadingHTTPServer(('127.0.0.1',0),Backend)
            threading.Thread(target=backend.serve_forever,daemon=True).start()
            config=Path('deploy/Caddyfile').read_text().replace('admin 127.0.0.1:2019','admin off').replace(':8080 {',f'http://127.0.0.1:{port} {{').replace('/srv/jlpt/static',str(static)).replace('127.0.0.1:8765',f'127.0.0.1:{backend.server_port}')
            config_path=root/'Caddyfile';config_path.write_text(config)
            process=subprocess.Popen([os.environ['CADDY_BINARY'],'run','--config',str(config_path)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    try:
                        conn=http.client.HTTPConnection('127.0.0.1',port,timeout=2);conn.request('GET','/login.html');conn.getresponse().read();conn.close();break
                    except OSError:time.sleep(.03)
                for path in ('/api/news/analyze','/api/news/ask'):
                    # A browser always offers compression; the stream must still arrive event by event.
                    conn=http.client.HTTPConnection('127.0.0.1',port,timeout=5)
                    started=time.monotonic()
                    conn.request('POST',path,body='{}',headers={'Content-Type':'application/json','Accept-Encoding':'gzip, deflate, br, zstd'})
                    response=conn.getresponse()
                    self.assertEqual(response.status,200,path)
                    self.assertEqual(response.getheader('Content-Type'),'text/event-stream',path)
                    self.assertIsNone(response.getheader('Content-Encoding'),path)
                    first=response.readline()
                    elapsed=time.monotonic()-started
                    self.assertEqual(first,b'event: first\n',path)
                    self.assertLess(elapsed,.4,f'{path}: first event arrived after {elapsed:.2f}s, the proxy buffered the stream')
                    rest=response.read()
                    self.assertIn(b'event: second',rest,path)
                    self.assertGreaterEqual(time.monotonic()-started,.45,path)
                    conn.close()
            finally:
                process.terminate();process.wait(timeout=5)
                backend.shutdown();backend.server_close()

    def test_preflight_passes_through_caddy_unchanged(self):
        class Backend(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_OPTIONS(self):
                self.send_response(204)
                self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin', ''))
                self.send_header('Vary', 'Origin')
                self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST')
                self.send_header('Access-Control-Max-Age', '600')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.close_connection = True
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); static=root/'static'; static.mkdir()
            with socket.socket() as s:
                s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
            backend=http.server.ThreadingHTTPServer(('127.0.0.1',0),Backend)
            threading.Thread(target=backend.serve_forever,daemon=True).start()
            config=Path('deploy/Caddyfile').read_text().replace('admin 127.0.0.1:2019','admin off').replace(':8080 {',f'http://127.0.0.1:{port} {{').replace('/srv/jlpt/static',str(static)).replace('127.0.0.1:8765',f'127.0.0.1:{backend.server_port}')
            config_path=root/'Caddyfile';config_path.write_text(config)
            process=subprocess.Popen([os.environ['CADDY_BINARY'],'run','--config',str(config_path)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    try:
                        conn=http.client.HTTPConnection('127.0.0.1',port,timeout=2);conn.request('GET','/login.html');conn.getresponse().read();conn.close();break
                    except OSError:time.sleep(.03)
                conn=http.client.HTTPConnection('127.0.0.1',port,timeout=5)
                conn.request('OPTIONS','/api/news/analyze',headers={'Origin':'https://news.example','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization','Accept-Encoding':'gzip, deflate, br, zstd'})
                response=conn.getresponse();body=response.read()
                self.assertEqual(response.status,204)
                self.assertEqual(body,b'')
                self.assertEqual(response.getheader('Access-Control-Allow-Origin'),'https://news.example')
                self.assertEqual(response.getheader('Access-Control-Allow-Headers'),'Authorization, Content-Type')
                self.assertEqual(response.getheader('Access-Control-Allow-Methods'),'GET, POST')
                self.assertEqual(response.getheader('Access-Control-Max-Age'),'600')
                conn.close()
            finally:
                process.terminate();process.wait(timeout=5)
                backend.shutdown();backend.server_close()

    def test_deployed_caddyfile_disables_response_buffering_for_api(self):
        config=Path('deploy/Caddyfile').read_text()
        api=config[config.index('handle @api'):config.index('handle {', config.index('handle @api'))]
        self.assertRegex(api, r'flush_interval\s+-1')
