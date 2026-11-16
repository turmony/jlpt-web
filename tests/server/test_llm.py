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
        self.assertErr(ctx, 'stream', 'qoder2api-hub 中途断开')

    def test_cut_before_any_text_is_model_error(self):
        fake, hub = self.hub([('cut_after', [])])
        self.assertErr(self.run_stream(hub), 'model', '模型没有返回内容')


class SlowLineAndInBandErrorTests(HubTestCase):
    def run_stream(self, hub):
        got = []
        with self.assertRaises(NewsError) as ctx:
            for piece in hub.stream('m', MSG, None):
                got.append(piece)
        return ctx, got

    def test_trickle_without_newline_hits_first_timeout(self):
        import time
        fake, hub = self.hub([('trickle', 0.05, 5, [])], first_timeout=0.3, total_timeout=10)
        t = time.monotonic()
        ctx, got = self.run_stream(hub)
        self.assertLess(time.monotonic() - t, 1.5)
        self.assertErr(ctx, 'model', '模型 0.3 秒内没有输出')

    def test_trickle_without_newline_hits_total_timeout(self):
        import time
        fake, hub = self.hub([('trickle', 0.05, 5, ['a'])], first_timeout=1, total_timeout=0.5)
        t = time.monotonic()
        ctx, got = self.run_stream(hub)
        self.assertLess(time.monotonic() - t, 1.5)
        self.assertEqual(got, ['a'])
        self.assertErr(ctx, 'model', '回答超过 0.5 秒')

    def test_in_band_10605_is_queueing(self):
        fake, hub = self.hub([('sse', ['data: {"error":{"message":"busy","code":10605}}\n\n'])])
        ctx, got = self.run_stream(hub)
        self.assertErr(ctx, 'model', '模型排队中，请稍后重试')

    def test_hub_queue_notice_is_queueing_without_waiting(self):
        # qoder2api-hub's visible queue mode: an empty chunk carrying `qoder_queue`, then pings
        notice = {'object': 'chat.completion.chunk', 'model': 'm',
                  'choices': [{'index': 0, 'delta': {'content': ''}, 'finish_reason': None}],
                  'qoder_queue': {'queued': True, 'waited_seconds': 0, 'message': '上游模型排队中'}}
        fake, hub = self.hub([('sse', [': ping\n\n', 'data: %s\n\n' % json.dumps(notice)])])
        ctx, got = self.run_stream(hub)
        self.assertErr(ctx, 'model', '模型排队中，请稍后重试')
        self.assertEqual(got, [])

    def test_in_band_error_mentioning_model_is_unavailable(self):
        fake, hub = self.hub([('sse', ['data: {"error":{"message":"unknown model m"}}\n\n'])])
        ctx, got = self.run_stream(hub)
        self.assertErr(ctx, 'model', '当前模型不可用，请重新选择', retryable=False)

    def test_in_band_other_error_is_surfaced(self):
        fake, hub = self.hub([('sse', ['data: {"error":{"message":"boom ' + KEY + '"}}\n\n'])])
        ctx, got = self.run_stream(hub)
        self.assertErr(ctx, 'model', '模型返回错误：boom ***')

    def test_non_sse_json_error_body_is_mapped(self):
        fake, hub = self.hub([('status', 200, {'error': {'message': 'quota', 'code': 10605}})])
        ctx, got = self.run_stream(hub)
        self.assertErr(ctx, 'model', '模型排队中，请稍后重试')

    def test_non_sse_json_error_body_other_message(self):
        fake, hub = self.hub([('status', 200, {'error': {'message': 'weird failure'}})])
        ctx, got = self.run_stream(hub)
        self.assertErr(ctx, 'model', '模型返回错误：weird failure')

    def test_non_sse_plain_body_is_surfaced(self):
        fake, hub = self.hub([('status', 200, 'maintenance')])
        ctx, got = self.run_stream(hub)
        self.assertErr(ctx, 'model', '模型返回 200：maintenance')


class ReasoningTests(HubTestCase):
    """Thinking deltas are output for the 30-second deadline (spec section 6) but never text."""

    def test_reasoning_longer_than_first_timeout_then_content_succeeds(self):
        fake, hub = self.hub([('reasoning', 0.8, ['答', '案'])], first_timeout=0.3, total_timeout=5)
        got = list(hub.stream('m', MSG, None))
        self.assertEqual([g for g in got if g], ['答', '案'])
        self.assertIn('', got)  # heartbeats while thinking
        self.assertNotIn('思考', ''.join(got))

    def test_reasoning_field_name_variant_counts_too(self):
        fake, hub = self.hub([('reasoning', 0.8, ['ok'], 'reasoning')], first_timeout=0.3, total_timeout=5)
        self.assertEqual(hub.complete('m', MSG, None), 'ok')

    def test_complete_ignores_heartbeats(self):
        fake, hub = self.hub([('reasoning', 0.3, ['日本', '語'])], first_timeout=1, total_timeout=5)
        self.assertEqual(hub.complete('m', MSG, None), '日本語')

    def test_reasoning_only_beyond_total_timeout_fails_with_total_reason(self):
        import time
        fake, hub = self.hub([('reasoning', 5, ['late'])], first_timeout=0.3, total_timeout=1)
        t = time.monotonic()
        with self.assertRaises(NewsError) as ctx:
            list(hub.stream('m', MSG, None))
        self.assertLess(time.monotonic() - t, 2)
        self.assertErr(ctx, 'model', '回答超过 1 秒')

    def test_reasoning_then_done_without_text_is_no_output(self):
        fake, hub = self.hub([('reasoning', 0.2, [])], first_timeout=1, total_timeout=5)
        with self.assertRaises(NewsError) as ctx:
            list(hub.stream('m', MSG, None))
        self.assertErr(ctx, 'model', '模型没有返回内容')

    def test_hub_pings_alone_still_hit_first_timeout(self):
        import time
        fake, hub = self.hub([('pings', 5)], first_timeout=0.3, total_timeout=10)
        t = time.monotonic()
        with self.assertRaises(NewsError) as ctx:
            list(hub.stream('m', MSG, None))
        self.assertLess(time.monotonic() - t, 1.5)
        self.assertErr(ctx, 'model', '模型 0.3 秒内没有输出')

    def test_hub_ping_comments_are_not_reported_as_a_stray_body(self):
        fake, hub = self.hub([('sse', [': ping\n\n', 'data: [DONE]\n\n'])])
        with self.assertRaises(NewsError) as ctx:
            list(hub.stream('m', MSG, None))
        self.assertErr(ctx, 'model', '模型没有返回内容')


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
            {'id': 'Auto', 'name': 'Auto', 'effort': None,
             'thinking': {'mode': 'none', 'options': [], 'default': None}},
            {'id': 'DeepSeek-Flash', 'name': 'DeepSeek-V4-Flash', 'effort': 'low',
             'thinking': {'mode': 'levels', 'options': ['low', 'high', 'max'], 'default': 'low'}},
            {'id': 'DeepSeek-V4-Pro', 'name': 'DeepSeek-V4-Pro', 'effort': 'high',
             'thinking': {'mode': 'levels', 'options': ['high', 'max'], 'default': 'high'}},
            {'id': 'Odd', 'name': 'Odd', 'effort': 'medium',
             'thinking': {'mode': 'levels', 'options': ['medium', 'xhigh'], 'default': 'medium'}},
            {'id': 'Weird', 'name': 'Weird', 'effort': None,
             'thinking': {'mode': 'none', 'options': [], 'default': None}},
            {'id': 'Empty', 'name': 'Empty', 'effort': None,
             'thinking': {'mode': 'none', 'options': [], 'default': None}},
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

    def test_codebuddy_models_shape_credits_and_supported_efforts(self):
        models = [
            {'id': 'global:default-model', 'name': 'Auto', 'credits': 'x0.15'},
            {'id': 'global:hy4flash', 'name': 'Hy4 flash', 'credits': 'x0.03',
             'reasoning_supported_efforts': ['high']},
            {'id': 'global:hy4flash-free', 'name': 'Hy4 flash', 'credits': 'x0.00',
             'reasoning_supported_efforts': ['high']},
            {'id': 'global:glm-5.3-flash', 'name': 'GLM-5.3-Flash', 'credits': 'x0.08',
             'supported_reasoning_levels': [{'effort': 'max'}, {'effort': 'low'}, {'effort': 'high'}]},
            {'id': 'global:max-model', 'name': 'Max', 'credits': 'x1.33 credits',
             'reasoning_supported_efforts': ['high']},
            {'id': 'global:kimi-k3', 'name': 'Kimi-K3', 'credits': 'x1.62',
             'reasoning_supported_efforts': ['medium']},
            {'id': 'dup-a', 'name': 'SameName'},
            {'id': 'dup-b', 'name': 'SameName'},
        ]
        _fake, hub = self.hub([], models)
        self.assertEqual(hub.models(), [
            {'id': 'global:default-model', 'name': 'Auto（x0.15）', 'effort': 'off',
             'thinking': {'mode': 'toggle', 'options': ['off', 'on'], 'default': 'off'}},
            {'id': 'global:hy4flash', 'name': 'Hy4 flash（x0.03）', 'effort': 'off',
             'thinking': {'mode': 'toggle', 'options': ['off', 'on'], 'default': 'off'}},
            {'id': 'global:hy4flash-free', 'name': 'Hy4 flash（免费）', 'effort': 'off',
             'thinking': {'mode': 'toggle', 'options': ['off', 'on'], 'default': 'off'}},
            {'id': 'global:glm-5.3-flash', 'name': 'GLM-5.3-Flash（x0.08）', 'effort': 'low',
             'thinking': {'mode': 'levels', 'options': ['low', 'high', 'max'], 'default': 'low'}},
            {'id': 'global:max-model', 'name': 'Max（x1.33）', 'effort': 'high',
             'thinking': {'mode': 'fixed', 'options': ['high'], 'default': 'high'}},
            {'id': 'global:kimi-k3', 'name': 'Kimi-K3（x1.62）', 'effort': 'medium',
             'thinking': {'mode': 'fixed', 'options': ['medium'], 'default': 'medium'}},
            {'id': 'dup-a', 'name': 'SameName（dup-a）', 'effort': None,
             'thinking': {'mode': 'none', 'options': [], 'default': None}},
            {'id': 'dup-b', 'name': 'SameName（dup-b）', 'effort': None,
             'thinking': {'mode': 'none', 'options': [], 'default': None}},
        ])

    def test_toggle_off_and_on_map_to_upstream_reasoning_effort(self):
        models = [
            {'id': 'global:hy4flash-free', 'name': 'Hy4 flash', 'credits': 'x0.00',
             'reasoning_supported_efforts': ['high']},
            {'id': 'global:default-model', 'name': 'Auto', 'credits': 'x0.15'},
            {'id': 'QSingle', 'reasoning_efforts': ['medium'], 'reasoning_can_disable': True},
        ]
        fake, hub = self.hub([('chunks', ['ok'], 0)] * 6, models)
        specs = {m['id']: m['thinking'] for m in hub.models()}
        self.assertEqual(specs['QSingle'], {'mode': 'toggle', 'options': ['off', 'on'], 'default': 'off'})
        list(hub.stream('global:hy4flash-free', MSG, 'off'))
        list(hub.stream('global:hy4flash-free', MSG, 'on'))
        list(hub.stream('global:default-model', MSG, 'off'))
        list(hub.stream('global:default-model', MSG, 'on'))
        list(hub.stream('QSingle', MSG, 'off'))
        list(hub.stream('QSingle', MSG, 'on'))
        self.assertEqual(fake.requests[0]['reasoning_effort'], 'none')
        self.assertEqual(fake.requests[1]['reasoning_effort'], 'high')
        self.assertNotIn('reasoning_effort', fake.requests[2])
        self.assertEqual(fake.requests[3]['reasoning_effort'], 'high')
        self.assertNotIn('reasoning_effort', fake.requests[4])
        self.assertEqual(fake.requests[5]['reasoning_effort'], 'medium')

    def test_custom_gateway_label_in_errors(self):
        fake = FakeHub([])
        url = fake.base_url
        fake.close()
        with self.assertRaises(NewsError) as ctx:
            Hub(url, KEY, label='CodeBuddy 网关').models()
        self.assertErr(ctx, 'gateway', 'CodeBuddy 网关 未运行或无法连接')
        fake2, hub2 = self.hub([('cut_after', ['部分'])])
        hub2 = Hub(fake2.base_url, KEY, label='CodeBuddy 网关')
        with self.assertRaises(NewsError) as ctx2:
            list(hub2.stream('m', MSG, None))
        self.assertErr(ctx2, 'stream', 'CodeBuddy 网关 中途断开')

    def test_filters_non_chat_media_and_internal_models(self):
        models = [
            {'id': 'global:default-model', 'name': 'Auto', 'credits': 'x0.15'},
            {'id': 'global:hy-image-3.5', 'name': 'HY-Image-3.5', 'tags': ['text-to-image', 'image-to-image']},
            {'id': 'global:kling-video-v3', 'name': 'Kling-Video-V3', 'tags': ['text-to-video', 'image-to-video']},
            {'id': 'nes-embed', 'name': 'Embed'},
        ]
        _fake, hub = self.hub([], models)
        self.assertEqual([m['id'] for m in hub.models()], ['global:default-model'])

    def test_11158_tier_blocked_is_non_retryable_model_error(self):
        msg = '{"error":{"code":"no_healthy_account","message":"{\\"code\\":11158,\\"msg\\":\\"model [gpt-6-luna] is not allowed for user type [personal_free_user]\\"}"}}'
        _fake, hub = self.hub([('status', 503, msg)])
        with self.assertRaises(NewsError) as ctx:
            list(hub.stream('global:gpt-6-luna', MSG, None))
        self.assertErr(ctx, 'model', '当前账号类型暂不支持该模型，请换选其他模型', retryable=False)

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
