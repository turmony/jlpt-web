"""Create local configuration; never emit the generated website password."""
import argparse
import json
import os
import secrets
import sys
from pathlib import Path
from urllib.parse import urlsplit
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.auth import Auth


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default='/srv/jlpt')
    parser.add_argument('--origin', required=True)
    args = parser.parse_args()
    origin = urlsplit(args.origin)
    if origin.scheme != 'https' or not origin.netloc or origin.path not in ('', '/'):
        parser.error('origin 必须是 HTTPS 网站来源')
    os.umask(0o077)
    base = Path(args.base)
    state = base / 'state'; state.mkdir(parents=True, exist_ok=True); state.chmod(0o700)
    config_path = state / 'config.json'
    if config_path.exists():
        config = json.loads(config_path.read_text())
    else:
        password = secrets.token_urlsafe(24)
        (state / 'website-password').write_text(password + '\n')
        config = {'password_hash': Auth.hash_password(password)}
    config.update(state=str(state), study=str(base / 'worktrees/study'), static=str(base / 'static'),
                  origin=args.origin.rstrip('/'), secure_cookie=True)
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    config_path.chmod(0o600)
    print(f'Configuration saved to {config_path}; website password is in {state / "website-password"}')
