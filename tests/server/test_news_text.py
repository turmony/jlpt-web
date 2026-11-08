import importlib.util
import unittest

HAVE_FUGASHI = importlib.util.find_spec('fugashi') is not None
if not HAVE_FUGASHI:
    print('test_news_text: skipped, fugashi is not installed (use the news venv: requirements-news.txt)')


@unittest.skipUnless(HAVE_FUGASHI, 'fugashi is not installed')
class NewsTextTests(unittest.TestCase):
    def setUp(self):
        from server.news_text import split_sentences, tokenize, to_sentences
        self.split_sentences, self.tokenize, self.to_sentences = split_sentences, tokenize, to_sentences

    def test_split_keeps_quotes_whole(self):
        self.assertEqual(self.split_sentences('彼は「明日行く。必ず。」と言った。次だ'),
                         ['彼は「明日行く。必ず。」と言った。', '次だ'])

    def test_split_on_newline_and_drops_blank_sentences(self):
        self.assertEqual(self.split_sentences('一つ目\n\n  \n二つ目！？三つ目'), ['一つ目', '二つ目！？', '三つ目'])

    def test_unclosed_quote_does_not_swallow_following_lines(self):
        self.assertEqual(self.split_sentences('「閉じない。\n次の行。'), ['「閉じない。', '次の行。'])

    def test_tokens_carry_reading_lemma_and_tappable(self):
        toks = self.tokenize('台風は強い勢力で接近し、10日に到着。')
        by = {t['s']: t for t in toks}
        self.assertEqual(by['勢力']['r'], 'せいりょく')
        self.assertTrue(by['勢力']['t'])
        self.assertEqual(by['勢力']['p'], '名詞')
        self.assertEqual(by['接近']['l'], '接近')
        self.assertFalse(by['、']['t'])
        self.assertFalse(by['10']['t'])
        self.assertTrue(by['は']['t'])  # particles are tappable

    def test_symbols_and_fullwidth_digits_are_not_tappable(self):
        by = {t['s']: t for t in self.tokenize('割合は３．５％だった')}
        for s in ('３', '．', '５', '％'):
            self.assertFalse(by[s]['t'], s)
        self.assertTrue(by['割合']['t'])

    def test_whitespace_survives_as_untappable_tokens(self):
        text = 'A社は 発表した'
        toks = self.tokenize(text)
        self.assertEqual(''.join(t['s'] for t in toks), text)
        space = [t for t in toks if t['s'].isspace()]
        self.assertEqual(len(space), 1)
        self.assertFalse(space[0]['t'])

    def test_every_token_has_all_fields(self):
        for t in self.tokenize('ぴよぴよ XYZ123 ほげふがうー'):
            self.assertEqual(set(t), {'s', 'r', 'l', 'p', 't'})
            self.assertTrue(all(isinstance(t[k], str) for k in 'srlp'))
            self.assertIsInstance(t['t'], bool)

    def test_tokens_reassemble_original_text(self):
        text = '首相は「検討する」と述べた\n見出しに句点なし'
        joined = ''.join(t['s'] for s in self.to_sentences(text, 0) for t in s['tokens'])
        self.assertEqual(joined.replace('\n', ''), text.replace('\n', ''))

    def test_sentence_ids_continue_from_start(self):
        self.assertEqual([s['id'] for s in self.to_sentences('一。二。', 5)], [5, 6])


class TokenizerUnavailableTests(unittest.TestCase):
    def test_tokenize_raises_when_fugashi_missing(self):
        import sys
        from unittest import mock
        from server import news_text
        with mock.patch.object(news_text, '_tagger', None), \
                mock.patch.dict(sys.modules, {'fugashi': None}):
            with self.assertRaises(news_text.TokenizerUnavailable):
                news_text.tokenize('テスト')


if __name__ == '__main__':
    unittest.main()
