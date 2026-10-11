"""Read model metadata, without accessing CLI credentials."""
import json
import os
import re
import subprocess
import time
from functools import lru_cache
from pathlib import Path
from .executables import resolve_cli

EFFORTS = ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')


@lru_cache(maxsize=8)
def discover(cli, period, binary):
    try:
        args = ['models'] if cli == 'agy' else ['--list-models']
        result = subprocess.run([binary, *args], capture_output=True, text=True, timeout=12)
        if result.returncode:
            return {'models': [], 'error': '无法读取模型列表，请检查执行器登录状态'}
        efforts = ['low', 'medium', 'high'] if cli == 'qoder' else []
        models = []
        for line in result.stdout.splitlines():
            parts = re.split(r'\t+|\s{2,}', line.strip(), maxsplit=1)
            if parts[0] == 'MODEL' or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]*', parts[0]):
                continue
            pinned = parts[0].rsplit('-', 1)[-1]
            supported = [pinned] if cli == 'agy' and pinned in ('low', 'medium', 'high') else efforts
            models.append({'id': parts[0], 'label': parts[-1], 'efforts': supported})
        return {'models': models, **({} if models else {'error': '执行器未返回可识别的模型列表'})}
    except (OSError, subprocess.TimeoutExpired):
        return {'models': [], 'error': '模型列表读取失败或超时，仍可使用 CLI 默认配置'}


def catalog(cli):
    if cli not in ('codex', 'agy', 'qoder'):
        raise ValueError('不支持的 CLI')
    if cli != 'codex':
        binary = resolve_cli(cli)
        if not binary:
            return {'models': [], 'error': '执行器未安装'}
        return discover(cli, int(time.time() // 300), binary)
    try:
        home = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')
        data = json.loads((home / 'models_cache.json').read_text())
        models = []
        for item in data.get('models', []):
            if item.get('visibility') != 'list':
                continue
            efforts = [row['effort'] for row in item.get('supported_reasoning_levels', []) if row.get('effort') in EFFORTS]
            models.append({'id': item['slug'], 'label': item.get('display_name', item['slug']), 'efforts': efforts})
        return {'models': models, **({} if models else {'error': 'Codex 模型缓存为空，仍可使用 CLI 默认配置'})}
    except (OSError, ValueError, KeyError, TypeError):
        return {'models': [], 'error': '无法读取 Codex 模型缓存，仍可使用 CLI 默认配置'}


def validate_selection(options, model='', effort=''):
    if not isinstance(model, str) or not isinstance(effort, str):
        raise ValueError('模型和推理强度格式无效')
    if not model and not effort:
        return '', ''
    selected = next((item for item in options['models'] if item['id'] == model), None)
    if selected is None:
        raise ValueError('请选择执行器提供的模型')
    if effort and effort not in selected['efforts']:
        raise ValueError('所选模型不支持此推理强度')
    return model, effort
