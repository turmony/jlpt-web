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
from scripts.setup_study import study_paths


if __name__ == '__main__':
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--base', default='/srv/jlpt')
    parser.add_argument('--projects', default=str(Path.home() / 'projects'))
    parser.add_argument('--origin', required=True)
    parser.add_argument('--llm-base-url', help='qoder2api-hub 地址，例如 http://127.0.0.1:8790')
    parser.add_argument('--llm-api-key', help='模型网关 API Key；也可用环境变量 JLPT_LLM_API_KEY，避免进入 shell 历史')
    # parse_known_args + our own message: argparse would echo unknown arguments, which may be a mistyped key option.
    args, unknown = parser.parse_known_args()
    if unknown:
        names = sorted({item.split('=', 1)[0] for item in unknown if item.startswith('-')})
        parser.error('未知参数：' + ' '.join(names) if names else '多余的位置参数')
    # An empty key counts as not given: install.sh reruns this on every deploy, and an empty
    # JLPT_LLM_API_KEY or --llm-api-key must not wipe the key already stored.
    llm_key = args.llm_api_key or os.environ.get('JLPT_LLM_API_KEY') or None
    origin = urlsplit(args.origin)
    if origin.scheme != 'https' or not origin.netloc or origin.path not in ('', '/'):
        parser.error('origin 必须是 HTTPS 网站来源')
    llm_url = None
    if args.llm_base_url is not None:
        llm = urlsplit(args.llm_base_url)
        if llm.scheme not in ('http', 'https') or not llm.netloc or llm.username or llm.password or llm.query or llm.fragment:
            parser.error('llm-base-url 必须是 http(s) 地址，且不含账号、查询串或片段')
        llm_url = args.llm_base_url.rstrip('/')
    base = Path(args.base)
    state = base / 'state'
    config_path = state / 'config.json'
    existing = json.loads(config_path.read_text()) if config_path.exists() else None
    if llm_key is not None and llm_url is None and not ((existing or {}).get('llm') or {}).get('base_url'):
        parser.error('设置模型网关密钥时需要同时给出 --llm-base-url')
    os.umask(0o077)
    state.mkdir(parents=True, exist_ok=True); state.chmod(0o700)
    if existing is not None:
        config = existing
    else:
        password = secrets.token_urlsafe(24)
        (state / 'website-password').write_text(password + '\n')
        config = {'password_hash': Auth.hash_password(password)}
    _, study = study_paths(args.projects)
    config.update(state=str(state), study=str(study), static=str(base / 'static'),
                  origin=args.origin.rstrip('/'), secure_cookie=True)
    if llm_url is not None or llm_key is not None:
        llm_config = dict(config.get('llm') or {})
        if llm_url is not None:
            llm_config['base_url'] = llm_url
        if llm_key is not None:
            llm_config['api_key'] = llm_key
        config['llm'] = llm_config
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    config_path.chmod(0o600)
    print(f'Configuration saved to {config_path}; website password is in {state / "website-password"}')
