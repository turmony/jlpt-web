"""Starts this site over HTTPS (self-signed certificate) with the real tokenizer, for scripts/news_check.mjs.

    /srv/jlpt/venv/bin/python -I scripts/news_check_server.py <state dir> <port> <cert> <key>

No qoder2api-hub is configured and `news_sites` is left at its default, so only the userscript's
main script and /api/news/tokenize work. Prints one JSON line {"base": ..., "loader": ...} once the
server is listening, then serves until it is killed.
"""
import json
import secrets
import signal
import ssl
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # python -I leaves the repository out of sys.path

from server.app import Application, create_server  # noqa: E402
from server.auth import Auth  # noqa: E402
from server.news_sites import loader_script, sites  # noqa: E402


def main():
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    state, port, cert, key = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
    static = ROOT / 'server-public'
    if not (static / 'news-script' / 'client.js').is_file():
        sys.exit('server-public/news-script/client.js 不存在，请先运行 npm run build')
    base = f'https://127.0.0.1:{port}'
    config = {'state': state, 'static': str(static), 'origin': base, 'secure_cookie': True,
              'password_hash': Auth.hash_password(secrets.token_urlsafe(16))}
    app = Application(config)
    try:
        import fugashi  # noqa: F401
        fugashi.Tagger()
    except Exception as error:
        sys.exit(f'真实分词不可用（{type(error).__name__}）：请用 /srv/jlpt/venv/bin/python 运行')
    server = create_server(app, ('127.0.0.1', port))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    # Handshake in the request thread, not in accept(): a client that connects and stays silent must not block the server.
    server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    _, token = app.news.devices.install('抽查')
    print(json.dumps({'base': base, 'loader': loader_script(base, token, sites(config))}, ensure_ascii=False), flush=True)

    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
