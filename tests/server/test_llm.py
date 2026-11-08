import json
import threading
import unittest

from server.llm import Hub
from server.news_errors import NewsError
from tests.server.fake_hub import FakeHub

MSG = [{'role': 'user', 'content': 'hi'}]
KEY = 'sk-secret-key-123'


class HubTestCase(unittest.TestCase):
    def hub(self, script, models=None, **kw):
        fake = FakeHub(script, models)
        self.addCleanup(fake.close)
        return fake, Hub(fake.base_url, KEY, **kw)

    def assertErr(self, ctx, stage, reason, retryable=True):
        e = ctx.exception
        self.assertEqual((e.stage, e.reason), (stage, reason))
        self.assertEqual(e.retryable, retryable)
        self.assertNotIn(KEY, repr(e.to_dict()))


class StreamTests(HubTestCase):
    def test_stream_yields_chunks_in_order(self):
        fake, hub = self.hub([('chunks', ['<a>', 'b', '</a>'], 0)])
        self.assertEqual(list(hub.stream('m', MSG, None)), ['<a>', 'b', '</a>'])

    def test_list_script_items_work_like_tuples(self):
        fake, hub = self.hub([['chunks', ['x', 'y'], 0]])
        self.assertEqual(hub.complete('m', MSG, None), 'xy')

    def test_complete_joins_chunks(self):
        fake, hub = self.hub([('chunks', ['日本', '語'], 0)])
        self.assertEqual(hub.complete('m', MSG, None), '日本語')

    def test_request_body_and_auth_header(self):
        fake, hub = self.hub([('chunks', ['x'], 0)])
        list(hub.stream('Auto', MSG, None))
        self.assertEqual(fake.requests[0], {'model': 'Auto', 'messages': MSG, 'stream': True})
        self.assertEqual(fake.request_headers[0]['Authorization'], 'Bearer ' + KEY)

    def test_request_body_uses_lowest_supported_effort(self):
        fake, hub = self.hub([('chunks', ['x'], 0)] * 2)
        models = {m['id']: m['effort'] for m in hub.models()}
        self.assertEqual(models['DeepSeek-V4-Pro'], 'high')
        list(hub.stream('DeepSeek-V4-Pro', MSG, models['DeepSeek-V4-Pro']))
        list(hub.stream('Auto', MSG, models['Auto']))
        self.assertEqual(fake.requests[0]['reasoning_effort'], 'high')
        self.assertNotIn('reasoning_effort', fake.requests[1])

    def test_closing_generator_closes_upstream(self):
        fake, hub = self.hub([('chunks', ['a', 'b', 'c'], 0.3)])
        gen = hub.stream('m', MSG, None)
        self.assertEqual(next(gen), 'a')
        gen.close()
        self.assertTrue(fake.wait_disconnect(timeout=2))
        self.assertEqual(fake.disconnects, 1)

    def test_empty_answer_is_a_model_error(self):
        fake, hub = self.hub([('chunks', [], 0)])
        with self.assertRaises(NewsError) as ctx:
            list(hub.stream('m', MSG, None))
        self.assertErr(ctx, 'model', '模型没有返回内容')


class ErrorMappingTests(HubTestCase):
    def run_stream(self, hub):
        with self.assertRaises(NewsError) as ctx:
            list(hub.stream('m', MSG, None))
        return ctx

    def test_connection_refused_is_gateway(self):
        fake = FakeHub([])
        url = fake.base_url
        fake.close()
        ctx = self.run_stream(Hub(url, KEY))
        self.assertErr(ctx, 'gateway', 'qoder2api-hub 未运行或无法连接')

    def test_401_is_gateway_bad_key(self):
        fake, hub = self.hub([('status', 401, 'nope')])
        self.assertErr(self.run_stream(hub), 'gateway', 'API Key 无效')

    def test_429_is_queueing(self):
        fake, hub = self.hub([('status', 429, 'slow down')])
        self.assertErr(self.run_stream(hub), 'model', '模型排队中，请稍后重试')

    def test_10605_in_body_is_queueing(self):
        fake, hub = self.hub([('status', 403, '{"error":{"code":10605}}')])
        self.assertErr(self.run_stream(hub), 'model', '模型排队中，请稍后重试')

    def test_400_mentioning_model_is_unavailable_not_retryable(self):
        fake, hub = self.hub([('status', 400, {'error': {'message': 'model not found: m'}})])
        self.assertErr(self.run_stream(hub), 'model', '当前模型不可用，请重新选择', retryable=False)

    def test_404_mentioning_model_is_unavailable(self):
        fake, hub = self.hub([('status', 404, 'The model `m` does not exist')])
        self.assertErr(self.run_stream(hub), 'model', '当前模型不可用，请重新选择', retryable=False)

    def test_400_without_model_is_generic(self):
        fake, hub = self.hub([('status', 400, 'bad json')])
        self.assertErr(self.run_stream(hub), 'model', '模型返回 400：bad json')

    def test_other_http_error_truncates_body_to_200_chars(self):
        fake, hub = self.hub([('status', 500, 'x' * 500)])
        self.assertErr(self.run_stream(hub), 'model', '模型返回 500：' + 'x' * 200)

    def test_api_key_never_leaks_from_error_body(self):
        fake, hub = self.hub([('status', 500, 'bad key ' + KEY)])
        ctx = self.run_stream(hub)
        self.assertNotIn(KEY, ctx.exception.reason)
        self.assertNotIn(KEY, repr(ctx.exception.to_dict()))

    def test_silent_hub_hits_first_timeout(self):
        fake, hub = self.hub([('silent', 3)], first_timeout=0.3)
        import time
        t = time.monotonic()
        ctx = self.run_stream(hub)
        self.assertLess(time.monotonic() - t, 1.5)
        self.assertErr(ctx, 'model', '模型 0.3 秒内没有输出')

    def test_default_timeout_texts(self):
        h = Hub('http://127.0.0.1:1', KEY)
        self.assertEqual(h._first_msg(), '模型 30 秒内没有输出')
        self.assertEqual(h._total_msg(), '回答超过 2 分钟')

    def test_headers_but_no_text_hits_first_timeout(self):
        fake, hub = self.hub([('chunks', ['late'], 2)], first_timeout=0.3)
        self.assertErr(self.run_stream(hub), 'model', '模型 0.3 秒内没有输出')

    def test_total_timeout_after_text_started(self):
        fake, hub = self.hub([('chunks', ['a'] * 20, 0.15)], first_timeout=1, total_timeout=0.5)
        got = []
        with self.assertRaises(NewsError) as ctx:
            for piece in hub.stream('m', MSG, None):
                got.append(piece)
        self.assertTrue(got)
        self.assertErr(ctx, 'model', '回答超过 0.5 秒')

    def test_cut_after_text_is_stream_interrupted(self):
        fake, hub = self.hub([('cut_after', ['部分'])])
        got = []
        with self.assertRaises(NewsError) as ctx:
            for piece in hub.stream('m', MSG, None):
                got.append(piece)
        self.assertEqual(got, ['部分'])
        self.assertErr(ctx, 'stream', '回答中断')

    def test_cut_before_any_text_is_model_error(self):
        fake, hub = self.hub([('cut_after', [])])
        self.assertErr(self.run_stream(hub), 'model', '模型没有返回内容')


class ModelsTests(HubTestCase):
    MODELS = [
        {'id': 'Auto', 'enabled': True},
        {'id': 'DeepSeek-Flash', 'name_local': 'DeepSeek-V4-Flash', 'enabled': True,
         'reasoning_efforts': ['max', 'low', 'high']},
        {'id': 'DeepSeek-V4-Pro', 'reasoning_efforts': ['high', 'max']},
        {'id': 'Off', 'enabled': False},
        {'id': 'Odd', 'reasoning_efforts': ['xhigh', 'medium']},
        {'id': 'Weird', 'reasoning_efforts': ['turbo']},
        {'id': 'Empty', 'reasoning_efforts': []},
    ]

    def test_models_names_efforts_and_filtering(self):
        fake, hub = self.hub([], self.MODELS)
        self.assertEqual(hub.models(), [
            {'id': 'Auto', 'name': 'Auto', 'effort': None},
            {'id': 'DeepSeek-Flash', 'name': 'DeepSeek-V4-Flash', 'effort': 'low'},
            {'id': 'DeepSeek-V4-Pro', 'name': 'DeepSeek-V4-Pro', 'effort': 'high'},
            {'id': 'Odd', 'name': 'Odd', 'effort': 'medium'},
            {'id': 'Weird', 'name': 'Weird', 'effort': None},
            {'id': 'Empty', 'name': 'Empty', 'effort': None},
        ])

    def test_models_cached_for_five_minutes(self):
        now = [1000.0]
        fake, hub = self.hub([], self.MODELS)
        hub = Hub(fake.base_url, KEY, clock=lambda: now[0])
        first = hub.models()
        fake.models = [{'id': 'New'}]
        now[0] += 299
        self.assertEqual(hub.models(), first)
        now[0] += 2
        self.assertEqual([m['id'] for m in hub.models()], ['New'])

    def test_models_401_is_gateway(self):
        fake = FakeHub([])
        self.addCleanup(fake.close)
        fake._server.RequestHandlerClass.do_GET = lambda h: h._send_json(401, {'error': 'x'})
        with self.assertRaises(NewsError) as ctx:
            Hub(fake.base_url, KEY).models()
        self.assertErr(ctx, 'gateway', 'API Key 无效')

    def test_models_connection_failure_is_gateway(self):
        fake = FakeHub([])
        url = fake.base_url
        fake.close()
        with self.assertRaises(NewsError) as ctx:
            Hub(url, KEY).models()
        self.assertErr(ctx, 'gateway', 'qoder2api-hub 未运行或无法连接')


class FakeHubTests(unittest.TestCase):
    def test_records_max_concurrent_requests(self):
        with FakeHub([('chunks', ['a', 'b'], 0.2)]) as fake:
            hub = Hub(fake.base_url, KEY)
            threads = [threading.Thread(target=lambda: list(hub.stream('m', MSG, None))) for _ in range(3)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(5)
            self.assertEqual(fake.max_concurrent, 3)
            self.assertEqual(fake.disconnects, 0)

    def test_script_runs_in_request_order_and_last_item_repeats(self):
        with FakeHub([('status', 429, ''), ('chunks', ['ok'], 0)]) as fake:
            hub = Hub(fake.base_url, KEY)
            with self.assertRaises(NewsError):
                hub.complete('m', MSG, None)
            self.assertEqual(hub.complete('m', MSG, None), 'ok')
            self.assertEqual(hub.complete('m', MSG, None), 'ok')


if __name__ == '__main__':
    unittest.main()
