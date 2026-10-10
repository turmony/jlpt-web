import argparse
import fcntl
import json
import signal
from pathlib import Path
from .app import Application, create_server
from .worker import Worker


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    app = Application(config)
    lock = open(Path(config['state']) / 'worker.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    app.store.recover()
    app.worker = Worker(app.store, config['study'])
    app.worker.start()
    server = create_server(app, (args.host, args.port))
    def stop(*_):
        app.worker.close()
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.worker.close()
        server.server_close()
        lock.close()


if __name__ == '__main__':
    main()
