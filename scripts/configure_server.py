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


def _validate_url(parser, raw, flag):
    if raw is None:
        return None
    parts = urlsplit(raw)
    if parts.scheme not in ('http', 'https') or not parts.netloc or parts.username or parts.password or parts.query or parts.fragment:
        parser.error(f'{flag} 必须是 http(s) 地址，且不含账号、查询串或片段')
    return raw.rstrip('/')


def _apply_gateway(parser, existing, config, section, url, key, env_var, label):
    # An empty key counts as not given: install.sh reruns this on every deploy, and an empty
    # env var or --*-api-key must not wipe the key already stored.
    resolved_key = key or os.environ.get(env_var) or None
    if resolved_key is not None and url is None and not ((existing or {}).get(section) or {}).get('base_url'):
        parser.error(f'设置{label}密钥时需要同时给出 {label} 地址')
    if url is not None or resolved_key is not None:
        section_cfg = dict(config.get(section) or {})
        if url is not None:
            section_cfg['base_url'] = url
        if resolved_key is not None:
            section_cfg['api_key'] = resolved_key
        config[section] = section_cfg


if __name__ == '__main__':
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--base', default='/srv/jlpt')
    parser.add_argument('--projects', default=str(Path.home() / 'projects'))
    parser.add_argument('--origin', required=True)
    parser.add_argument('--llm-base-url', help='qoder2api-hub 地址，例如 http://127.0.0.1:8790')
    parser.add_argument('--llm-api-key', help='qoder2api-hub API Key；也可用环境变量 JLPT_LLM_API_KEY，避免进入 shell 历史')
    parser.add_argument('--codebuddy-base-url', help='CodeBuddy（workbuddy-manager）网关地址，例如 http://127.0.0.1:7864')
    parser.add_argument('--codebuddy-api-key', help='CodeBuddy 网关 API Key；也可用环境变量 JLPT_CODEBUDDY_API_KEY')
    # parse_known_args + our own message: argparse would echo unknown arguments, which may be a mistyped key option.
    args, unknown = parser.parse_known_args()
    if unknown:
        names = sorted({item.split('=', 1)[0] for item in unknown if item.startswith('-')})
        parser.error('未知参数：' + ' '.join(names) if names else '多余的位置参数')
    origin = urlsplit(args.origin)
    if origin.scheme != 'https' or not origin.netloc or origin.path not in ('', '/'):
        parser.error('origin 必须是 HTTPS 网站来源')
    llm_url = _validate_url(parser, args.llm_base_url, 'llm-base-url')
    codebuddy_url = _validate_url(parser, args.codebuddy_base_url, 'codebuddy-base-url')
    base = Path(args.base)
    state = base / 'state'
    config_path = state / 'config.json'
    existing = json.loads(config_path.read_text()) if config_path.exists() else None
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
    _apply_gateway(parser, existing, config, 'llm', llm_url, args.llm_api_key, 'JLPT_LLM_API_KEY', '模型网关')
    _apply_gateway(parser, existing, config, 'codebuddy', codebuddy_url, args.codebuddy_api_key, 'JLPT_CODEBUDDY_API_KEY', 'CodeBuddy 网关')
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    config_path.chmod(0o600)
    print(f'Configuration saved to {config_path}; website password is in {state / "website-password"}')
