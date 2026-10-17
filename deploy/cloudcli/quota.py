"""Read-only Claude subscription quota (5-hour and weekly) for the CloudCLI page.

Serves GET /_quota on 127.0.0.1:3003; Caddy exposes it as /code/_quota behind the
site login. Uses the `claude /login` token without refreshing it: Claude Code owns
that file, and any Claude run refreshes an expired token.
"""
import json
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CREDENTIALS = Path.home() / '.claude' / '.credentials.json'
USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
CACHE_SECONDS = 60
_cache = {'at': 0.0, 'body': None}


def window(data):
    data = data or {}
    return {'percent': data.get('utilization'), 'resets_at': data.get('resets_at')}


def fetch_usage():
    oauth = json.loads(CREDENTIALS.read_text())['claudeAiOauth']
    if oauth.get('expiresAt', 0) / 1000 < time.time():
        return {'error': 'token_expired'}
    request = urllib.request.Request(USAGE_URL, headers={
        'Authorization': 'Bearer ' + oauth['accessToken'],
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'jlpt-cloudcli-quota',
    })
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            usage = json.load(response)
    except urllib.error.HTTPError as error:
        return {'error': f'http_{error.code}'}
    except (urllib.error.URLError, TimeoutError):
        return {'error': 'unreachable'}
    return {
        'plan': oauth.get('subscriptionType'),
        'five_hour': window(usage.get('five_hour')),
        'seven_day': window(usage.get('seven_day')),
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?')[0] != '/_quota':
            self.send_error(404)
            return
        now = time.time()
        if _cache['body'] is None or now - _cache['at'] > CACHE_SECONDS:
            body = fetch_usage()
            body['checked_at'] = int(now)
            _cache.update(at=now, body=body)
        payload = json.dumps(_cache['body']).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 3003), Handler).serve_forever()
