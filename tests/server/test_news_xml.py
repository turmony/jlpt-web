import unittest

from server.news_errors import NewsError
from server.news_prompts import (ANALYSIS_TEMPLATE, GLOSS_TEMPLATE, analysis_messages,
                                 ask_messages, gloss_messages)
from server.news_xml import AnalysisParser, parse_gloss

SAMPLE_WITH_SELECTION = '''<analysis>
  <selection>
    <reading>ひろがる</reading>
    <role>修饰后面的名词</role>
    <meaning>扩散</meaning>
  </selection>
  <translation>天空一下子晴了起来。</translation>
  <grammar>
    <item related="true">
      <form>〜ている</form>
      <level>N4</level>
      <brief>表示状态持续</brief>
      <connection>动词て形+いる</connection>
      <usage>表示晴朗的状态持续着</usage>
      <confusable>〜てある：强调有意为之的结果</confusable>
    </item>
    <item related="false">
      <form>〜ば</form>
      <level>N3</level>
      <brief>假定条件</brief>
      <connection>动词假定形</connection>
      <usage>表示条件</usage>
    </item>
  </grammar>
</analysis>'''


def split_every(s, n):
    return [s[i:i + n] for i in range(0, len(s), n)]


def parse_all(text, step=None):
    p = AnalysisParser()
    ev = []
    for ch in (split_every(text, step) if step else [text]):
        ev += p.feed(ch)
    ev += p.close()
    return ev


class AnalysisParserTests(unittest.TestCase):
    def test_events_emit_as_soon_as_each_section_closes(self):
        p = AnalysisParser()
        ev = []
        for ch in split_every(SAMPLE_WITH_SELECTION, 7):
            ev += p.feed(ch)
        ev += p.close()
        self.assertEqual([e[0] for e in ev], ['selection', 'translation', 'grammar', 'grammar'])
        self.assertTrue(ev[2][1]['related'])
        self.assertFalse(ev[3][1]['related'])
        self.assertEqual(ev[0][1], {'reading': 'ひろがる', 'role': '修饰后面的名词', 'meaning': '扩散'})
        self.assertEqual(ev[2][1]['form'], '〜ている')
        self.assertEqual(ev[2][1]['level'], 'N4')
        self.assertEqual(ev[2][1]['confusable'], '〜てある：强调有意为之的结果')

    def test_event_is_emitted_before_stream_ends(self):
        p = AnalysisParser()
        self.assertEqual(p.feed('<analysis><translation>你好'), [])
        self.assertEqual(p.feed('</translation><gram'), [('translation', {'text': '你好'})])

    def test_missing_selection_and_confusable_are_fine(self):
        text = ('<analysis><translation>译文</translation><grammar><item><form>〜た</form>'
                '<level>N5</level><brief>过去</brief><connection>c</connection><usage>u</usage>'
                '</item></grammar></analysis>')
        ev = parse_all(text, 5)
        self.assertEqual([e[0] for e in ev], ['translation', 'grammar'])
        self.assertEqual(ev[1][1]['confusable'], '')
        self.assertFalse(ev[1][1]['related'])

    def test_text_outside_tags_goes_to_extra(self):
        text = '好的，如下：\n<analysis><translation>译文</translation>多余的话\n</analysis>\n以上。'
        ev = parse_all(text, 4)
        self.assertEqual(ev[0], ('translation', {'text': '译文'}))
        extras = [e for e in ev if e[0] == 'extra']
        self.assertEqual(len(extras), 1)
        self.assertIn('好的，如下：', extras[0][1]['text'])
        self.assertIn('多余的话', extras[0][1]['text'])
        self.assertIn('以上。', extras[0][1]['text'])
        self.assertEqual(ev[-1], extras[0])

    def test_no_extra_when_only_wrappers_and_whitespace(self):
        ev = parse_all('```xml\n' + SAMPLE_WITH_SELECTION + '\n```\n', 9)
        self.assertEqual([e[0] for e in ev], ['selection', 'translation', 'grammar', 'grammar'])

    def test_fenced_and_unescaped_xml_still_parses(self):
        text = '```xml\n<analysis><translation>A & B <注></translation></analysis>\n```'
        self.assertEqual(parse_all(text)[0], ('translation', {'text': 'A & B <注>'}))
        self.assertEqual(parse_all(text, 3)[0], ('translation', {'text': 'A & B <注>'}))

    def test_standard_entities_are_unescaped(self):
        ev = parse_all('<translation>a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &amp;lt;</translation>')
        self.assertEqual(ev[0][1]['text'], 'a & b <c> "d" \'e\' &lt;')

    def test_bad_level_blanked(self):
        for lvl, want in (('N6', ''), ('n3', 'N3'), ('中级', ''), (' N1 ', 'N1'), ('N5、N4', '')):
            text = '<item><form>f</form><level>%s</level><brief>b</brief></item>' % lvl
            ev = parse_all(text)
            self.assertEqual(ev[0][1]['level'], want, lvl)

    def test_related_attribute_variants(self):
        def rel(attrs):
            return parse_all('<item%s><form>f</form></item>' % attrs)[0][1]['related']
        self.assertTrue(rel(' related="true"'))
        self.assertTrue(rel(' related="TRUE"'))
        self.assertTrue(rel(" related='true'"))
        self.assertTrue(rel(' related=true'))
        self.assertFalse(rel(' related="false"'))
        self.assertFalse(rel(''))
        self.assertFalse(rel(' related="true 或 false"'))
        self.assertFalse(rel(' related="yes"'))

    def test_values_are_stripped(self):
        ev = parse_all('<selection><reading>\n  ひ \n</reading><role> r </role></selection>')
        self.assertEqual(ev[0][1], {'reading': 'ひ', 'role': 'r', 'meaning': ''})

    def test_unterminated_section_at_close_goes_to_extra(self):
        ev = parse_all('<analysis><translation>译文</translation><grammar><item><form>〜た</form><lev', 6)
        self.assertEqual(ev[0], ('translation', {'text': '译文'}))
        self.assertEqual(ev[-1][0], 'extra')
        self.assertIn('<form>〜た</form>', ev[-1][1]['text'])
        self.assertNotIn('<grammar>', ev[-1][1]['text'])

    def test_unterminated_item_does_not_swallow_next_items(self):
        text = ('<analysis><grammar><item related="true"><form>A</form><level>N5</level>'
                '<item><form>B</form></item><item><form>C</form></item></grammar></analysis>')
        for step in (None, 1, 3, 7):
            ev = parse_all(text, step)
            self.assertEqual([e[0] for e in ev], ['grammar', 'grammar', 'extra'], step)
            self.assertEqual([e[1]['form'] for e in ev[:2]], ['B', 'C'], step)
            self.assertIn('<form>A</form>', ev[2][1]['text'])
            self.assertIn('<level>N5</level>', ev[2][1]['text'])
            self.assertNotIn('<form>B</form>', ev[2][1]['text'])

    def test_unterminated_selection_and_translation_do_not_swallow_next(self):
        text = ('<selection><reading>r</reading><translation>T1</translation>'
                '<selection><reading>s</reading></selection>')
        for step in (None, 2):
            ev = parse_all(text, step)
            self.assertEqual([e[0] for e in ev], ['translation', 'selection', 'extra'], step)
            self.assertEqual(ev[1][1]['reading'], 's')
            self.assertIn('<reading>r</reading>', ev[2][1]['text'])
        ev = parse_all('<translation>half<item><form>B</form></item>', 4)
        self.assertEqual([e[0] for e in ev], ['grammar', 'extra'])
        self.assertIn('half', ev[1][1]['text'])

    def test_empty_stream_yields_nothing(self):
        self.assertEqual(parse_all(''), [])
        self.assertEqual(parse_all('  \n'), [])

    def test_does_not_confuse_items_tag_prefix(self):
        ev = parse_all('<items>x</items><item><form>f</form></item>')
        self.assertEqual([e[0] for e in ev], ['grammar', 'extra'])
        self.assertEqual(ev[1][1]['text'], '<items>x</items>')


class ParseGlossTests(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(parse_gloss('<gloss><meaning>吃；食用</meaning></gloss>'), '吃；食用')

    def test_fenced_and_surrounded(self):
        t = '好的\n```xml\n<gloss>\n  <meaning>\n 出席；参加 \n</meaning>\n</gloss>\n```\n'
        self.assertEqual(parse_gloss(t), '出席；参加')

    def test_unescaped_chars_survive(self):
        self.assertEqual(parse_gloss('<meaning>A & B <x></meaning>'), 'A & B <x>')

    def test_missing_raises_format_error(self):
        for t in ('', '没有标签', '<gloss></gloss>', '<meaning>  </meaning>', '<meaning>未结束'):
            with self.assertRaises(NewsError) as cm:
                parse_gloss(t)
            self.assertEqual(cm.exception.stage, 'format')
            self.assertEqual(cm.exception.reason, '回复缺少释义')


class PromptTests(unittest.TestCase):
    def test_templates_contain_no_sample_sentence(self):
        self.assertNotIn('台風', ANALYSIS_TEMPLATE)
        self.assertIn('<selection>', ANALYSIS_TEMPLATE)
        self.assertIn('<meaning>', GLOSS_TEMPLATE)
        self.assertIn('没有选中部分时不输出 `<selection>`', ANALYSIS_TEMPLATE)
        self.assertIn('标签之外不写任何内容', ANALYSIS_TEMPLATE)

    def test_gloss_messages(self):
        msgs = gloss_messages('食べる', 'たべる', '動詞')
        self.assertEqual(msgs[0]['role'], 'system')
        self.assertIn(GLOSS_TEMPLATE, msgs[0]['content'])
        self.assertIn('中文', msgs[0]['content'])
        self.assertEqual(msgs[-1]['role'], 'user')
        for s in ('食べる', 'たべる', '動詞'):
            self.assertIn(s, msgs[-1]['content'])

    def test_analysis_messages_with_and_without_selection(self):
        m = analysis_messages('段落文', '句子文', '选中词')
        self.assertIn(ANALYSIS_TEMPLATE, m[0]['content'])
        for s in ('段落文', '句子文', '选中词'):
            self.assertIn(s, m[-1]['content'])
        m2 = analysis_messages('段落文', '句子文', None)
        self.assertNotIn('选中词', m2[-1]['content'])
        self.assertNotEqual(m[-1]['content'], m2[-1]['content'])

    def test_ask_messages_keep_last_six_rounds(self):
        msgs = ask_messages('文', None, '分析', [{'q': str(i), 'a': str(i)} for i in range(9)], '新')
        self.assertNotIn('2', [m['content'] for m in msgs if m['role'] == 'user'][:-1])
        users = [m['content'] for m in msgs if m['role'] == 'user']
        self.assertEqual(users[-7:], ['3', '4', '5', '6', '7', '8', '新'])
        self.assertEqual(msgs[0]['role'], 'system')
        self.assertEqual(msgs[-1], {'role': 'user', 'content': '新'})
        self.assertEqual([m['role'] for m in msgs[1:]], ['user', 'assistant'] * 6 + ['user'])

    def test_ask_context_carries_sentence_selection_and_analysis(self):
        msgs = ask_messages('原句ABC', '选中XYZ', '分析结果QQQ', [], '问题?')
        ctx = '\n'.join(m['content'] for m in msgs[:-1])
        for s in ('原句ABC', '选中XYZ', '分析结果QQQ'):
            self.assertIn(s, ctx)
        self.assertEqual(msgs[-1], {'role': 'user', 'content': '问题?'})
        ctx2 = '\n'.join(m['content'] for m in ask_messages('原句ABC', None, '分析', [], 'q')[:-1])
        self.assertNotIn('选中', ctx2)
        self.assertIn('中文', ctx)
        self.assertIn('对比例句', ctx)


if __name__ == '__main__':
    unittest.main()
