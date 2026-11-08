"""Staged error structure shared by the news reader (spec section 6)."""
import secrets
from datetime import datetime

STAGES = {
    'client': '网页→服务器',
    'yahoo': '抓取雅虎',
    'parse': '解析正文',
    'tokenize': '切句分词',
    'image': '下载图片',
    'gateway': '服务器→qoder2api-hub',
    'model': '模型生成',
    'format': '解析回复',
    'stream': '推送到网页',
}


def new_request_id(now=None):
    now = now or datetime.now()
    return 'n-%s-%s' % (now.strftime('%Y%m%d'), secrets.token_hex(2))


class NewsError(Exception):
    def __init__(self, stage, reason, location=None, retryable=True, request_id=None):
        if stage not in STAGES:
            raise ValueError('unknown stage: %s' % stage)
        super().__init__(reason)
        now = datetime.now()
        self.stage = stage
        self.reason = reason
        self.location = location
        self.retryable = retryable
        self.request_id = request_id or new_request_id(now)
        self.time = now.strftime('%H:%M:%S')

    def to_dict(self):
        return {'stage': self.stage, 'stage_label': STAGES[self.stage], 'location': self.location,
                'reason': self.reason, 'retryable': self.retryable,
                'request_id': self.request_id, 'time': self.time}
