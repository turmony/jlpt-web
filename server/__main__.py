import argparse
import json
import signal
from pathlib import Path
from .app import Application, create_server
from .news import start_cleanup


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    app = Application(config)
    start_cleanup(app.news)  # hourly expiry of glosses
    server = create_server(app, (args.host, args.port))

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
