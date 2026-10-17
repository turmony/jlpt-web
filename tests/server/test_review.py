import json
import tempfile
import unittest
from pathlib import Path

from server import review
from server.store import Conflict
from tests.server.review_fixture import finish_unit, make_study, paper_slug, prepare_review

UNIT_PAPER = '2026-10-17-b-01-1'


class ReviewModuleTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.study = make_study(self.tmp)
        self.notes = self.study / 'jlpt-notes'

    def paper_text(self, slug=UNIT_PAPER):
        return (self.notes / 'quizzes/papers' / f'{slug}.md').read_text()

    def test_today_reports_learn_state_from_study_repo(self):
        state = review.today(self.study)
        self.assertEqual(state['state'], 'learn')
        self.assertEqual(state['unit']['id'], 'B-01-1')
        self.assertEqual((state['progress']['learned'], state['progress']['total']), (0, 2))

    def test_unit_view_before_recall_hides_page_paper_and_sentence(self):
        view = review.unit_view(self.study, 'B-01-1')
        self.assertEqual(view['unit'], {'id': 'B-01-1', 'title': 'に', 'kind': 'system',
                                        'position': ['基础体系表', 'B-01 助词用法地图', 'B-01-1 に']})
        self.assertEqual(view['session'], {'started': False, 'submitted': False, 'locked_at': None, 'submitted_at': None})
        self.assertIsNone(view['recall'])
        for key in ('page', 'cards', 'paper', 'sentence', 'note'):
            self.assertNotIn(key, view)

    def test_unit_view_after_recall_rewrites_images_and_card_links(self):
        review.load_groups(self.study).start_unit(self.notes, 'B-01-1', 'に：时间')
        view = review.unit_view(self.study, 'B-01-1')
        self.assertTrue(view['session']['started'])
        self.assertFalse(view['session']['submitted'])
        self.assertRegex(view['session']['locked_at'], r'\+08:00$')
        self.assertEqual(view['recall'], 'に：时间')
        page = view['page']
        self.assertIn('![时点に接续图](/api/review/asset?path=assets/grammar/n5/N5-G-0013-connection.png)', page)
        self.assertIn('[时点に](#card-N5-G-0013)', page)
        self.assertIn('[对象に](#card-N5-G-0032)', page)
        self.assertIn('见体系表 B-01。', page)
        self.assertNotIn('grammar_system_unit', page)
        self.assertTrue(page.startswith('# B-01-1 に'))
        self.assertEqual(view['cards'], [
            {'id': 'N5-G-0013', 'title': '助词：动作进行时点「に」', 'core': '时间词＋に，表示动作发生的时间点。'},
            {'id': 'N5-G-0032', 'title': '助词：动作对象「に」', 'core': '「に」标出动作指向的对象。'}])
        self.assertEqual(view['paper']['slug'], UNIT_PAPER)
        self.assertEqual(view['paper']['numbers'], [1, 2, 3, 4, 5])
        self.assertNotIn('## 答案填写区', view['paper']['text'])
        self.assertIn('### 5. 三時（　）会いましょう。', view['paper']['text'])
        self.assertEqual(view['sentence'], {'card': 'N5-G-0013', 'prompt': '用本单元的语法翻译：三点见面吧。', 'text': None})
        self.assertIsNone(view['note'])

    def test_unknown_or_unprepared_unit_is_missing(self):
        for unit_id in ('B-01-2', 'G-001', 'B-09-9'):
            with self.subTest(unit_id=unit_id), self.assertRaises(KeyError):
                review.unit_view(self.study, unit_id)

    def test_asset_serves_png_from_assets(self):
        data, mime = review.asset(self.study, 'assets/grammar/n5/N5-G-0013-connection.png')
        self.assertEqual(mime, 'image/png')
        self.assertEqual(data, (self.notes / 'assets/grammar/n5/N5-G-0013-connection.png').read_bytes())

    def test_asset_rejects_traversal_and_symlinks(self):
        (self.tmp / 'secret.png').write_bytes(b'secret')
        (self.tmp / 'outside').mkdir()
        (self.tmp / 'outside/secret.png').write_bytes(b'secret')
        (self.notes / 'assets/link.png').symlink_to(self.tmp / 'secret.png')
        (self.notes / 'assets/linked').symlink_to(self.tmp / 'outside', target_is_directory=True)
        for path in ('../../.git/config', 'assets/../../secret.png', '/etc/passwd', 'assets/link.png',
                     'assets/linked/secret.png', 'grammar/n5/N5-G-0013.md', 'assets/grammar/n5/missing.png',
                     'assets/../groups/mapping.json', 'assets\\..\\..\\secret.png', ''):
            with self.subTest(path=path), self.assertRaises((ValueError, KeyError)):
                review.asset(self.study, path)

    def test_plan_data_error_becomes_study_data_error(self):
        path = self.notes / 'groups/submissions/r1/B-01-1.json'
        path.parent.mkdir(parents=True)
        path.write_text('{')
        with self.assertRaisesRegex(review.StudyDataError, '资料格式错误：groups/submissions/r1/B-01-1.json'):
            review.today(self.study)
        with self.assertRaisesRegex(review.StudyDataError, 'groups/submissions/r1/B-01-1.json'):
            review.unit_view(self.study, 'B-01-1')

    def test_missing_groups_module_is_study_data_error(self):
        (self.study / 'src/jlpt_notes/groups.py').unlink()
        with self.assertRaisesRegex(review.StudyDataError, 'src/jlpt_notes/groups.py'):
            review.today(self.study)

    def test_rule_refusals_become_forbidden_conflict_or_invalid(self):
        with self.assertRaises(review.Forbidden):
            review.recall(self.study, 'B-01-2', 'で')
        with self.assertRaises(ValueError) as caught:
            review.recall(self.study, 'B-01-1', '   ')
        self.assertIs(type(caught.exception), ValueError)
        view = review.recall(self.study, 'B-01-1', '  に  ')
        self.assertEqual(view['recall'], 'に')
        self.assertIn('page', view)
        with self.assertRaises(Conflict):
            review.recall(self.study, 'B-01-1', '改写')
        self.assertEqual(review.unit_view(self.study, 'B-01-1')['recall'], 'に')

    def test_submit_unit_writes_answers_then_locks_everything(self):
        with self.assertRaises(review.Forbidden):
            review.submit_unit(self.study, 'B-01-1', {'1': {'answer': '2'}}, '三時に会いましょう。', '')
        self.assertIn('1-__,', self.paper_text())
        review.recall(self.study, 'B-01-1', 'に')
        state = review.submit_unit(self.study, 'B-01-1', {'1': {'answer': '2', 'uncertain': True}},
                                   '三時に会いましょう。', '对比页少了例句')
        self.assertEqual(state['progress']['study_day'], 1)
        self.assertEqual(state['pending_grading'], [{'id': 'B-01-1', 'paper': UNIT_PAPER}])
        self.assertIn('*1-2, 2-__', self.paper_text())
        submission = json.loads((self.notes / 'groups/submissions/r1/B-01-1.json').read_text())
        self.assertEqual(submission['sentence'], {'card': 'N5-G-0013', 'text': '三時に会いましょう。'})
        self.assertEqual(submission['note'], '对比页少了例句')
        view = review.unit_view(self.study, 'B-01-1')
        self.assertTrue(view['session']['submitted'])
        self.assertEqual((view['sentence']['text'], view['note']), ('三時に会いましょう。', '对比页少了例句'))
        with self.assertRaises(Conflict):
            review.submit_unit(self.study, 'B-01-1', {'1': {'answer': '3'}}, '別の文。', '')
        self.assertIn('*1-2, 2-__', self.paper_text())

    def test_submit_unit_rejects_bad_answers_without_submitting(self):
        review.recall(self.study, 'B-01-1', 'に')
        with self.assertRaises(ValueError):
            review.submit_unit(self.study, 'B-01-1', {'9': {'answer': '1'}}, '三時に会いましょう。', '')
        self.assertNotIn('submitted_at', json.loads((self.notes / 'groups/submissions/r1/B-01-1.json').read_text()))


class ReviewSessionTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.study = make_study(Path(tmp.name), units=8)
        self.notes = self.study / 'jlpt-notes'
        self.covers = [f'B-01-{index}' for index in range(1, 8)]
        for minute, unit_id in enumerate(self.covers):
            finish_unit(self.notes, unit_id, minute)

    def test_review_view_needs_a_due_prepared_review(self):
        with self.assertRaises(review.Forbidden):
            review.review_view(self.study, 'review-01')
        prepare_review(self.notes, 'review-01', self.covers)
        view = review.review_view(self.study, 'review-01')
        self.assertEqual(view['review'], {'id': 'review-01', 'covers': self.covers})
        self.assertEqual(view['session'], {'submitted': False, 'submitted_at': None})
        self.assertEqual(view['paper']['numbers'], list(range(1, 13)))
        self.assertNotIn('## 答案填写区', view['paper']['text'])
        prepare_review(self.notes, 'review-02', self.covers)
        with self.assertRaises(review.Forbidden):
            review.review_view(self.study, 'review-02')

    def test_submit_review_writes_answers_and_closes_the_review(self):
        prepare_review(self.notes, 'review-01', self.covers)
        state = review.submit_review(self.study, 'review-01', {'12': {'answer': '4'}})
        self.assertEqual(state['progress']['reviews_done'], 1)
        self.assertEqual((state['state'], state['unit']['id']), ('not_prepared', 'B-01-8'))
        self.assertIn(', 12-4\n', (self.notes / 'quizzes/papers' / f"{paper_slug('review-01')}.md").read_text())
        view = review.review_view(self.study, 'review-01')
        self.assertTrue(view['session']['submitted'])
        with self.assertRaises(Conflict):
            review.submit_review(self.study, 'review-01', {'12': {'answer': '1'}})
