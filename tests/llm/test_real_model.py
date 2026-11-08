"""Real-model tests: call the selected model through the local qoder2api-hub.

This group spends quota and is run on its own (npm run test:llm) after changing prompts
and before going live. It needs three environment variables and skips entirely without them:

  JLPT_LLM_BASE_URL  e.g. http://127.0.0.1:8790
  JLPT_LLM_API_KEY   a qoder2api-hub API key (never printed by these tests)
  JLPT_LLM_MODEL     a model id offered by the hub, e.g. DeepSeek-Flash

The thinking effort is the model's lowest one, taken from Hub.models() like the server does.
All sentences are self-written. To keep the number of calls small, the two sentence analyses
(with and without a selection) are made once per run and shared by the analysis tests.
"""
import os
import re
import time
import unittest

from server.llm import Hub
from server.news_prompts import analysis_messages, ask_messages, gloss_messages
from server.news_xml import AnalysisParser, parse_gloss

ENV = ('JLPT_LLM_BASE_URL', 'JLPT_LLM_API_KEY', 'JLPT_LLM_MODEL')
MISSING = [name for name in ENV if not os.environ.get(name)]
SKIP_REASON = ('真实模型测试需要环境变量 %s（会消耗额度，单独运行：npm run test:llm）'
               % '、'.join(MISSING))

# Self-written sentences (not news text).
SENTENCE_RAIN = '昨日から降り続いていた雨は、夕方になってようやく止んだ。'
SENTENCE_PARK = '駅前の広場で、子どもたちが楽しそうに遊んでいる。'
PARAGRAPH = SENTENCE_RAIN + SENTENCE_PARK
SELECTION = '遊んでいる'

LEVELS = {'N1', 'N2', 'N3', 'N4', 'N5'}
REQUIRED_ITEM_FIELDS = ('form', 'level', 'brief', 'connection', 'usage')


def _senses(meaning):
    return [s.strip() for s in re.split(r'[；;]', meaning) if s.strip()]


@unittest.skipIf(MISSING, SKIP_REASON)
class RealModelTests(unittest.TestCase):
    _analyses = {}

    @classmethod
    def setUpClass(cls):
        cls.model = os.environ['JLPT_LLM_MODEL']
        cls.hub = Hub(os.environ['JLPT_LLM_BASE_URL'], os.environ['JLPT_LLM_API_KEY'],
                      first_timeout=30, total_timeout=120)
        offered = {m['id']: m for m in cls.hub.models()}
        if cls.model not in offered:
            raise AssertionError('qoder2api-hub 没有提供模型 %s（可选：%s）'
                                 % (cls.model, '、'.join(sorted(offered))))
        cls.effort = offered[cls.model]['effort']

    # -- helpers -------------------------------------------------------------
    def complete(self, messages):
        return self.hub.complete(self.model, messages, self.effort)

    @classmethod
    def analysis(cls, selection):
        """Stream one analysis; events carry the monotonic time they were parsed out."""
        sentence = SENTENCE_PARK if selection else SENTENCE_RAIN
        if selection not in cls._analyses:
            parser = AnalysisParser()
            events, parts = [], []
            started = time.monotonic()
            for chunk in cls.hub.stream(cls.model, analysis_messages(PARAGRAPH, sentence, selection),
                                        cls.effort):
                parts.append(chunk)
                now = time.monotonic()
                events += [(now, name, data) for name, data in parser.feed(chunk)]
            now = time.monotonic()
            events += [(now, name, data) for name, data in parser.close()]
            cls._analyses[selection] = {'events': events, 'text': ''.join(parts),
                                        'started': started, 'ended': now}
        return cls._analyses[selection]

    def names(self, result):
        return [name for _t, name, _d in result['events']]

    def items(self, result):
        return [data for _t, name, data in result['events'] if name == 'grammar']

    def assertParsedCleanly(self, result):
        extra = [data['text'] for _t, name, data in result['events'] if name == 'extra']
        self.assertEqual(extra, [], '标签之外有多余内容，原始回复：\n%s' % result['text'])
        self.assertEqual(self.names(result).count('translation'), 1, result['text'])
        self.assertTrue(self.items(result), '没有语法条目：\n%s' % result['text'])

    # -- gloss ---------------------------------------------------------------
    def test_gloss_meaning_present_and_short(self):
        for lemma, reading, pos in (('学校', 'がっこう', '名詞'), ('で', 'で', '助詞'),
                                    ('調べる', 'しらべる', '動詞')):
            with self.subTest(lemma=lemma):
                raw = self.complete(gloss_messages(lemma, reading, pos))
                meaning = parse_gloss(raw)
                senses = _senses(meaning)
                self.assertTrue(senses, raw)
                self.assertLessEqual(len(senses), 2, '义项超过两个：%s' % meaning)
                for sense in senses:
                    self.assertLessEqual(len(sense), 15, '义项超过 15 字：%s' % sense)

    # -- analysis ------------------------------------------------------------
    def test_analysis_without_selection_has_no_selection_tag(self):
        result = self.analysis(None)
        self.assertNotIn('selection', self.names(result), result['text'])
        self.assertNotIn('<selection', result['text'])
        self.assertParsedCleanly(result)

    def test_analysis_with_selection_has_selection_and_related_first(self):
        result = self.analysis(SELECTION)
        self.assertParsedCleanly(result)
        selections = [data for _t, name, data in result['events'] if name == 'selection']
        self.assertEqual(len(selections), 1, result['text'])
        for field in ('reading', 'role', 'meaning'):
            self.assertTrue(selections[0][field], '<selection> 缺少 <%s>：\n%s' % (field, result['text']))
        related = [item['related'] for item in self.items(result)]
        self.assertTrue(related[0], '第一条语法不是 related="true"：\n%s' % result['text'])
        first_false = related.index(False) if False in related else len(related)
        self.assertNotIn(True, related[first_false:], '相关语法没有全部排在最前：\n%s' % result['text'])

    def test_levels_within_n5_n1_and_required_tags_present(self):
        for selection in (None, SELECTION):
            result = self.analysis(selection)
            with self.subTest(selection=selection):
                self.assertParsedCleanly(result)
                raw_levels = re.findall(r'<level\s*>(.*?)</level\s*>', result['text'], re.S)
                self.assertTrue(raw_levels, result['text'])
                for level in raw_levels:
                    self.assertIn(level.strip().upper(), LEVELS, '等级不在 N5–N1：%r' % level)
                for item in self.items(result):
                    for field in REQUIRED_ITEM_FIELDS:
                        self.assertTrue(item[field], '语法条目缺少 <%s>：%r' % (field, item))
                translation = [d for _t, n, d in result['events'] if n == 'translation']
                self.assertTrue(translation and translation[0]['text'], result['text'])

    def test_sections_arrive_incrementally(self):
        result = self.analysis(None)
        times = [t for t, name, _d in result['events'] if name != 'extra']
        self.assertGreaterEqual(len(times), 2, result['text'])
        spread = times[-1] - times[0]
        self.assertGreaterEqual(spread, 0.3, '各段几乎同时到达（相差 %.3f 秒）' % spread)

    # -- follow-up -----------------------------------------------------------
    def test_follow_up_uses_previous_round(self):
        analysis_text = self.analysis(SELECTION)['text']
        q1 = '句中「広場で」的「で」是什么作用？'
        a1 = self.complete(ask_messages(SENTENCE_PARK, SELECTION, analysis_text, [], q1))
        self.assertTrue(a1.strip())
        q2 = '那换成に呢'
        a2 = self.complete(ask_messages(SENTENCE_PARK, SELECTION, analysis_text,
                                        [{'q': q1, 'a': a1}], q2))
        self.assertIn('に', a2, '第二轮回答没有提到「に」：\n%s' % a2)


if __name__ == '__main__':
    unittest.main()
