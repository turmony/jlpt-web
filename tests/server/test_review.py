import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

from server import review
from server.app import Application, create_server
from server.auth import Auth
from server.store import Conflict
from tests.server.review_fixture import (COMPARE, finish_unit, make_study, paper_slug, prepare_review, prepare_unit,
                                         write_json)

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

    def test_unit_view_before_recall_returns_rows_only(self):
        view = review.unit_view(self.study, 'B-01-1')
        self.assertEqual(view['unit'], {'id': 'B-01-1', 'title': 'に', 'kind': 'system',
                                        'position': ['基础体系表', 'B-01 助词用法地图', 'B-01-1 に']})
        self.assertEqual(view['session'], {'started': False, 'submitted': False, 'submitted_at': None})
        self.assertEqual(view['recall'], {'items': [{'form': 'に', 'usage': '时间点', 'card': 'N5-G-0013'},
                                                    {'form': 'へ', 'usage': '动作的方向', 'card': 'N5-G-0032'}]})
        for key in ('page', 'cards', 'paper', 'sentence', 'note'):
            self.assertNotIn(key, view)

    def test_unit_view_returns_compare_only_when_the_unit_has_one(self):
        self.assertNotIn('compare', review.unit_view(self.study, 'B-01-1'))
        prepare_unit(self.notes, 'B-01-1', compare=COMPARE)
        view = review.unit_view(self.study, 'B-01-1')
        self.assertEqual(view['compare'], COMPARE)
        self.assertNotIn('page', view)

    def test_unit_view_after_recall_rewrites_images_and_card_links(self):
        review.load_groups(self.study).start_unit(self.notes, 'B-01-1')
        view = review.unit_view(self.study, 'B-01-1')
        self.assertTrue(view['session']['started'])
        self.assertFalse(view['session']['submitted'])
        self.assertNotIn('locked_at', view['session'])
        page = view['page']
        self.assertIn('![时点に接续图](/api/review/asset?path=assets/grammar/n5/N5-G-0013-connection.png)', page)
        self.assertIn('### [N5-G-0013 助词：动作进行时点「に」](#card-N5-G-0013)', page)
        self.assertIn('### [N5-G-0032 助词：动作对象「に」](#card-N5-G-0032)', page)
        self.assertNotIn('grammar_system_unit', page)
        self.assertTrue(page.startswith('# B-01-1 に'))
        self.assertEqual(view['cards'], [
            {'id': 'N5-G-0013', 'title': '助词：动作进行时点「に」', 'core': '时间词＋に，表示动作发生的时间点。'},
            {'id': 'N5-G-0032', 'title': '助词：动作对象「に」', 'core': '## 功能一：对象\n\n「に」标出动作指向的对象。\n\n## 功能二：到达点\n\n「に」标出到达的地点。'}])
        self.assertEqual(view['paper']['slug'], UNIT_PAPER)
        self.assertEqual(view['paper']['numbers'], [1, 2, 3, 4, 5])
        self.assertNotIn('## 答案填写区', view['paper']['text'])
        self.assertIn('### 5. 三時（　）会いましょう。', view['paper']['text'])
        self.assertEqual(view['sentence'], {'card': 'N5-G-0013', 'prompt': '用本单元的语法翻译：三点见面吧。', 'text': None})
        self.assertIsNone(view['note'])

    def test_unit_without_sentence_has_no_sentence_in_its_view(self):
        prepare_unit(self.notes, 'B-01-1', sentence=False)
        review.recall(self.study, 'B-01-1')
        view = review.unit_view(self.study, 'B-01-1')
        self.assertNotIn('sentence', view)
        self.assertIsNone(view['note'])
        self.assertEqual(view['paper']['numbers'], [1, 2, 3, 4, 5])

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

    def plan_spaced(self, anchors, done=None):
        """Write the plan file; every anchored unit counts as submitted the day before its first review."""
        write_json(self.notes / 'groups/spaced-reviews.json', {'schema_version': 1, 'anchors': anchors, 'done': done or []})
        for unit, anchor in anchors.items():
            day = datetime.fromisoformat(anchor) - timedelta(days=1)
            write_json(self.notes / 'groups/submissions/r1' / f'{unit}.json',
                       {'unit_id': unit, 'submitted_at': f'{day:%Y-%m-%d}T20:00:00+08:00'})

    def test_spaced_today_lists_due_units_with_titles(self):
        today = datetime.now(review.load_spaced(self.study).TZ).date()
        self.plan_spaced({'B-01-1': today.isoformat(), 'G-009': today.isoformat(), 'G-010': (today + timedelta(days=1)).isoformat()})
        state = review.spaced_today(self.study)
        self.assertEqual(state['today'], today.isoformat())
        self.assertEqual([(group['day'], group['units']) for group in state['groups']], [(1, ['B-01-1', 'G-009'])])
        self.assertEqual(state['titles'], {'B-01-1': 'に'})

    def test_an_anchor_without_a_submission_is_not_listed(self):
        today = datetime.now(review.load_spaced(self.study).TZ).date().isoformat()
        self.plan_spaced({'G-001': today})
        (self.notes / 'groups/submissions/r1/G-001.json').unlink()
        self.assertEqual(review.spaced_today(self.study)['groups'], [])

    def test_today_carries_the_daily_new_units_only_when_the_plan_sets_them(self):
        self.assertIsNone(review.today(self.study)['daily'])
        write_json(self.notes / 'groups/plan.json', {'schema_version': 1, 'round': 1, 'daily_new': 2})
        daily = review.today(self.study)['daily']
        self.assertEqual((daily['limit'], daily['done_today'], daily['full']), (2, 0, False))
        self.assertEqual([(slot['id'], slot['status']) for slot in daily['slots']], [('B-01-1', 'current'), ('B-01-2', 'unprepared')])

    def test_spaced_today_without_a_plan_file_is_empty(self):
        state = review.spaced_today(self.study)
        self.assertEqual((state['groups'], state['done_today'], state['pending']), ([], [], 0))

    def test_submit_spaced_records_only_due_units(self):
        today = datetime.now(review.load_spaced(self.study).TZ).date().isoformat()
        self.plan_spaced({'G-001': today, 'G-002': today})
        state = review.submit_spaced(self.study, ['G-001'])
        self.assertEqual((state['done_today'], state['pending']), (['G-001'], 1))
        stored = json.loads((self.notes / 'groups/spaced-reviews.json').read_text())
        self.assertEqual(stored['done'], [{'unit': 'G-001', 'step': 1, 'date': today}])
        with self.assertRaises(Conflict):
            review.submit_spaced(self.study, ['G-001'])
        with self.assertRaises(ValueError):
            review.submit_spaced(self.study, [])

    def test_damaged_spaced_file_is_a_study_data_error_with_its_path(self):
        (self.notes / 'groups/spaced-reviews.json').write_text('{')
        with self.assertRaisesRegex(review.StudyDataError, 'groups/spaced-reviews.json'):
            review.spaced_today(self.study)

    def test_missing_spaced_module_is_study_data_error(self):
        (self.study / 'src/jlpt_notes/spaced_review.py').unlink()
        with self.assertRaisesRegex(review.StudyDataError, 'src/jlpt_notes/spaced_review.py'):
            review.spaced_today(self.study)

    def test_retired_review_cycle_has_no_days_to_review(self):
        write_json(self.notes / 'groups/plan.json', {'schema_version': 1, 'round': 1, 'review_cycle': 'off'})
        progress = review.today(self.study)['progress']
        self.assertIsNone(progress['days_to_review'])

    def test_missing_groups_module_is_study_data_error(self):
        (self.study / 'src/jlpt_notes/groups.py').unlink()
        with self.assertRaisesRegex(review.StudyDataError, 'src/jlpt_notes/groups.py'):
            review.today(self.study)

    def test_rule_refusals_become_forbidden_conflict_or_invalid(self):
        with self.assertRaises(review.Forbidden):
            review.recall(self.study, 'B-01-2')
        view = review.recall(self.study, 'B-01-1')
        self.assertIn('page', view)
        self.assertNotIn('missed', view['recall'])
        with self.assertRaises(Conflict):
            review.recall(self.study, 'B-01-1')

    def test_entering_comparison_records_nothing_about_the_overview(self):
        review.recall(self.study, 'B-01-1')
        stored = json.loads((self.notes / 'groups/submissions/r1/B-01-1.json').read_text())
        self.assertEqual(stored, {'schema_version': 1, 'unit_id': 'B-01-1', 'round': 1, 'paper': UNIT_PAPER})

    def forgets(self):
        return json.loads((self.notes / 'groups/forgets.json').read_text())

    def test_forget_needs_the_unit_entered_and_a_form_from_its_overview(self):
        with self.assertRaises(review.Forbidden):
            review.forget(self.study, 'B-01-1', 'に')
        self.assertNotIn('forgets', review.unit_view(self.study, 'B-01-1'))
        review.recall(self.study, 'B-01-1')
        for form in ('で', '', None, ['に']):
            with self.subTest(form=form), self.assertRaises(ValueError):
                review.forget(self.study, 'B-01-1', form)
        with self.assertRaises(KeyError):
            review.forget(self.study, 'B-01-2', 'に')
        self.assertFalse((self.notes / 'groups/forgets.json').exists())

    def test_each_forget_is_one_timed_record_with_the_form_and_its_cards(self):
        review.recall(self.study, 'B-01-1')
        self.assertEqual(review.unit_view(self.study, 'B-01-1')['forgets'], {})
        at = datetime(2026, 10, 26, 21, 5, 30, tzinfo=review.TZ)
        first = review.forget(self.study, 'B-01-1', 'に', now=at)
        second = review.forget(self.study, 'B-01-1', 'に', now=at)
        self.assertEqual((first['count'], second['count']), (1, 2))
        self.assertNotEqual(first['event'], second['event'])
        review.forget(self.study, 'B-01-1', 'へ', now=at)
        stored = self.forgets()
        self.assertEqual(stored['schema_version'], 1)
        self.assertEqual(stored['events'][0], {'id': first['event'], 'unit': 'B-01-1', 'form': 'に', 'cards': ['N5-G-0013'],
                                               'at': '2026-10-26T21:05:30+08:00'})
        self.assertEqual([event['form'] for event in stored['events']], ['に', 'に', 'へ'])
        self.assertEqual(review.unit_view(self.study, 'B-01-1')['forgets'], {'に': 2, 'へ': 1})

    def test_undo_forget_drops_only_that_record_and_only_within_two_minutes(self):
        review.recall(self.study, 'B-01-1')
        at = datetime(2026, 10, 26, 21, 5, 30, tzinfo=review.TZ)
        first = review.forget(self.study, 'B-01-1', 'に', now=at)
        second = review.forget(self.study, 'B-01-1', 'に', now=at)
        self.assertEqual(review.undo_forget(self.study, 'B-01-1', second['event'], now=at + timedelta(minutes=2)), {'count': 1})
        self.assertEqual([event['id'] for event in self.forgets()['events']], [first['event']])
        with self.assertRaises(Conflict):
            review.undo_forget(self.study, 'B-01-1', first['event'], now=at + timedelta(minutes=2, seconds=1))
        for unit, event in (('B-01-1', second['event']), ('B-01-1', 'nope'), ('B-01-2', first['event'])):
            with self.subTest(unit=unit, event=event), self.assertRaises(KeyError):
                review.undo_forget(self.study, unit, event, now=at)
        self.assertEqual(review.unit_view(self.study, 'B-01-1')['forgets'], {'に': 1})

    def test_damaged_forget_log_is_a_study_data_error_with_its_path(self):
        review.recall(self.study, 'B-01-1')
        for text in ('{', '{"schema_version": 1}', '[]'):
            (self.notes / 'groups/forgets.json').write_text(text)
            with self.subTest(text=text):
                with self.assertRaisesRegex(review.StudyDataError, 'groups/forgets.json'):
                    review.unit_view(self.study, 'B-01-1')
                with self.assertRaisesRegex(review.StudyDataError, 'groups/forgets.json'):
                    review.forget(self.study, 'B-01-1', 'に')

    def test_legacy_recall_text_does_not_crash_view(self):
        path = self.notes / 'groups/submissions/r1/B-01-1.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'schema_version': 1, 'unit_id': 'B-01-1', 'round': 1, 'paper': UNIT_PAPER,
                                    'recall': {'text': '回忆', 'locked_at': '2026-10-17T20:00:00+08:00'}}))
        view = review.unit_view(self.study, 'B-01-1')
        self.assertNotIn('missed', view['recall'])
        self.assertIn('page', view)

    def test_submit_unit_writes_answers_then_locks_everything(self):
        with self.assertRaises(review.Forbidden):
            review.submit_unit(self.study, 'B-01-1', {'1': {'answer': '2'}}, '三時に会いましょう。', '')
        self.assertIn('1-__,', self.paper_text())
        review.recall(self.study, 'B-01-1')
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
        self.assertEqual([item['number'] for item in view['key']], [1, 2, 3, 4, 5])
        self.assertEqual((view['key'][0]['correct'], view['key'][0]['correct_text']), ('2', view['key'][0]['correct_text']))
        self.assertIn('解析1', view['key'][0]['explanation'])
        for hidden in ('来源1', '证据', '正确项', '**题目**'):
            self.assertNotIn(hidden, view['key'][0]['explanation'])
        self.assertEqual(view['paper']['answers']['1'], {'answer': '2', 'uncertain': True})
        with self.assertRaises(Conflict):
            review.submit_unit(self.study, 'B-01-1', {'1': {'answer': '3'}}, '別の文。', '')
        self.assertIn('*1-2, 2-__', self.paper_text())

    def test_answer_key_stays_hidden_until_the_unit_is_submitted(self):
        self.assertNotIn('key', review.unit_view(self.study, 'B-01-1'))
        review.recall(self.study, 'B-01-1')
        self.assertNotIn('key', review.unit_view(self.study, 'B-01-1'))
        review.submit_unit(self.study, 'B-01-1', {}, '文。', '')
        self.assertEqual(len(review.unit_view(self.study, 'B-01-1')['key']), 5)
        (self.notes / f'quizzes/answers/{UNIT_PAPER}-answers.md').unlink()
        self.assertEqual(review.unit_view(self.study, 'B-01-1')['key'], [])

    def test_submit_unit_rejects_bad_answers_without_submitting(self):
        review.recall(self.study, 'B-01-1')
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


class AnswerOrderTests(unittest.TestCase):
    def test_order_comes_from_the_field_or_the_recommended_order_line(self):
        self.assertEqual(review._answer_order('**推荐语序**：3124（见解析）\n'), '3124')
        self.assertEqual(review._answer_order('**解析**：推荐语序：友達から(3)／もらった(1)／りんごを(2)／切って(4)＋食べました。★处'), '3124')
        self.assertIsNone(review._answer_order('**解析**：「っけ」表示确认。'))
        self.assertIsNone(review._answer_order('**解析**：推荐语序：甲(1)／乙(1)／丙(2)／丁(3)。'))


class ReviewHTTPTests(unittest.TestCase):
    SUBMIT = {'answers': {'1': {'answer': '2', 'uncertain': True}}, 'sentence': '日本に行きます。', 'note': ''}

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.study = make_study(root)
        self.notes = self.study / 'jlpt-notes'
        (root / 'static').mkdir()
        config = {'state': str(root / 'state'), 'study': str(self.study), 'static': str(root / 'static'),
                  'origin': 'http://test.local', 'secure_cookie': False, 'password_hash': Auth.hash_password('secret')}
        self.server = create_server(Application(config), ('127.0.0.1', 0))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.cookie = ''

    def request(self, path, data=None, origin='http://test.local'):
        headers = {'Cookie': self.cookie}
        if data is not None:
            headers.update({'Content-Type': 'application/json', 'Origin': origin})
        req = urllib.request.Request(self.url + path, data=None if data is None else json.dumps(data).encode(), headers=headers)
        try:
            return urllib.request.urlopen(req)
        except urllib.error.HTTPError as error:
            return error

    def login(self):
        response = self.request('/api/login', {'password': 'secret'})
        self.assertEqual(response.status, 200)
        self.cookie = response.headers['Set-Cookie'].split(';')[0]

    def paper_text(self):
        return (self.notes / f'quizzes/papers/{UNIT_PAPER}.md').read_text()

    def submission(self):
        return json.loads((self.notes / 'groups/submissions/r1/B-01-1.json').read_text())

    def test_spaced_endpoints_over_http(self):
        today = datetime.now(review.load_spaced(self.study).TZ).date().isoformat()
        write_json(self.notes / 'groups/spaced-reviews.json',
                   {'schema_version': 1, 'anchors': {'G-001': today, 'G-002': today}, 'done': []})
        for unit in ('G-001', 'G-002'):
            write_json(self.notes / 'groups/submissions/r1' / f'{unit}.json',
                       {'unit_id': unit, 'submitted_at': '2026-10-01T20:00:00+08:00'})
        for request in (lambda: self.request('/api/review/spaced'), lambda: self.request('/api/review/spaced/submit', {'units': ['G-001']})):
            self.assertEqual(request().status, 401)
        self.login()
        state = json.load(self.request('/api/review/spaced'))
        self.assertEqual([group['units'] for group in state['groups']], [['G-001', 'G-002']])
        after = json.load(self.request('/api/review/spaced/submit', {'units': ['G-001']}))
        self.assertEqual((after['done_today'], after['pending']), (['G-001'], 1))
        self.assertEqual(self.request('/api/review/spaced/submit', {'units': ['G-001']}).status, 409)
        self.assertEqual(self.request('/api/review/spaced/submit', {'units': []}).status, 400)
        self.assertEqual(self.request('/api/review/spaced/submit', {}).status, 400)
        self.assertEqual(self.request('/api/review/spaced/submit', {'units': ['G-002']}, origin='https://evil.example').status, 403)
        self.assertEqual(json.load(self.request('/api/review/spaced'))['done_today'], ['G-001'])

    def test_review_endpoints_require_login(self):
        for path in ('/api/review/today', '/api/review/units/B-01-1', '/api/review/reviews/review-01',
                     '/api/review/asset?path=assets/grammar/n5/N5-G-0013-connection.png'):
            with self.subTest(path=path):
                self.assertEqual(self.request(path).status, 401)
        self.assertEqual(self.request('/api/review/units/B-01-1/recall', {'missed': []}).status, 401)
        self.assertEqual(self.request('/api/review/units/B-01-1/submit', self.SUBMIT).status, 401)
        self.assertFalse((self.notes / 'groups/submissions').exists())

    def test_full_unit_flow_over_http(self):
        self.login()
        self.assertEqual(json.load(self.request('/api/review/today'))['state'], 'learn')
        before = json.load(self.request('/api/review/units/B-01-1'))
        for key in ('page', 'cards', 'paper', 'sentence'):
            self.assertNotIn(key, before)
        response = self.request('/api/review/units/B-01-1/recall', {'missed': []})
        self.assertEqual(response.status, 200)
        view = json.load(response)
        self.assertIn('/api/review/asset?path=assets/grammar/n5/N5-G-0013-connection.png', view['page'])
        self.assertEqual(view['paper']['numbers'], [1, 2, 3, 4, 5])
        state = json.load(self.request('/api/review/units/B-01-1/submit', self.SUBMIT))
        self.assertEqual(state['progress']['study_day'], 1)
        self.assertEqual(state['pending_grading'], [{'id': 'B-01-1', 'paper': UNIT_PAPER}])
        self.assertRegex(self.paper_text(), r'\*1-2')
        self.assertEqual(self.submission()['sentence']['text'], '日本に行きます。')
        self.assertNotIn('recall', self.submission())

    def test_unit_without_sentence_submits_with_only_a_note(self):
        prepare_unit(self.notes, 'B-01-1', sentence=False)
        self.login()
        self.request('/api/review/units/B-01-1/recall', {'missed': []})
        body = {'answers': {'1': {'answer': '2'}}, 'note': '对比页少了例句'}
        self.assertEqual(self.request('/api/review/units/B-01-1/submit', body).status, 200)
        self.assertNotIn('sentence', self.submission())
        self.assertEqual(self.submission()['note'], '对比页少了例句')
        view = json.load(self.request('/api/review/units/B-01-1'))
        self.assertTrue(view['session']['submitted'])
        self.assertNotIn('sentence', view)

    def test_second_submit_conflicts(self):
        self.login()
        self.request('/api/review/units/B-01-1/recall', {'missed': []})
        self.assertEqual(self.request('/api/review/units/B-01-1/submit', self.SUBMIT).status, 200)
        again = {'answers': {'1': {'answer': '3'}}, 'sentence': '別の文。', 'note': '改'}
        self.assertEqual(self.request('/api/review/units/B-01-1/submit', again).status, 409)
        self.assertRegex(self.paper_text(), r'\*1-2')
        self.assertEqual((self.submission()['sentence']['text'], self.submission()['note']), ('日本に行きます。', ''))
        self.assertEqual(self.request('/api/review/units/B-01-1/recall', {'missed': [0]}).status, 403)
        self.assertNotIn('recall', self.submission())

    def test_forget_endpoints_over_http(self):
        self.assertEqual(self.request('/api/review/units/B-01-1/forget', {'form': 'に'}).status, 401)
        self.login()
        self.assertEqual(self.request('/api/review/units/B-01-1/forget', {'form': 'に'}).status, 403)
        self.request('/api/review/units/B-01-1/recall', {})
        made = json.load(self.request('/api/review/units/B-01-1/forget', {'form': 'に'}))
        self.assertEqual(made['count'], 1)
        self.assertEqual(json.load(self.request('/api/review/units/B-01-1'))['forgets'], {'に': 1})
        self.assertEqual(self.request('/api/review/units/B-01-1/forget', {'form': 'で'}).status, 400)
        self.assertEqual(self.request('/api/review/units/B-01-1/forget', {'form': 'へ'}, origin='https://evil.example').status, 403)
        self.assertEqual(self.request('/api/review/units/B-01-1/forget').status, 404)
        self.assertEqual(json.load(self.request('/api/review/units/B-01-1/forget/undo', {'event': made['event']})), {'count': 0})
        self.assertEqual(self.request('/api/review/units/B-01-1/forget/undo', {'event': made['event']}).status, 404)
        self.assertEqual(json.loads((self.notes / 'groups/forgets.json').read_text())['events'], [])

    def test_recall_ignores_marks_sent_by_an_old_cached_page(self):
        self.login()
        self.assertEqual(self.request('/api/review/units/B-01-1/recall', {'missed': [1]}).status, 200)
        self.assertNotIn('recall', self.submission())

    def test_second_recall_conflicts(self):
        self.login()
        self.assertEqual(self.request('/api/review/units/B-01-1/recall', {'missed': []}).status, 200)
        self.assertEqual(self.request('/api/review/units/B-01-1/recall', {'missed': [0]}).status, 409)  # a cached old page may still send it
        self.assertNotIn('recall', self.submission())

    def test_submit_before_recall_is_forbidden(self):
        self.login()
        response = self.request('/api/review/units/B-01-1/submit', self.SUBMIT)
        self.assertEqual(response.status, 403)
        self.assertIn('尚未进入对比页', json.load(response)['error'])
        self.assertNotIn('*1-2', self.paper_text())
        self.assertFalse((self.notes / 'groups/submissions').exists())

    def test_recall_rejected_from_other_origin(self):
        self.login()
        self.assertEqual(self.request('/api/review/units/B-01-1/recall', {'missed': []}, origin='https://evil.example').status, 403)
        self.assertFalse((self.notes / 'groups/submissions').exists())

    def test_invalid_input_is_400(self):
        self.login()
        self.request('/api/review/units/B-01-1/recall', {'missed': []})
        for body in ({**self.SUBMIT, 'sentence': ''}, {**self.SUBMIT, 'answers': {'9': {'answer': '1'}}},
                     {**self.SUBMIT, 'answers': None}):
            with self.subTest(body=body):
                self.assertEqual(self.request('/api/review/units/B-01-1/submit', body).status, 400)
        self.assertNotIn('submitted_at', self.submission())

    def test_unknown_or_malformed_ids_are_404(self):
        self.login()
        for path in ('/api/review/units/../x', '/api/review/units/X-1', '/api/review/units/B-01-2',
                     '/api/review/units/%2e%2e%2fmapping', '/api/review/units/B-01-1/other', '/api/review/reviews/review-1',
                     '/api/review/reviews/B-01-1', '/api/review/nothing'):
            with self.subTest(path=path):
                self.assertEqual(self.request(path).status, 404)
        self.assertEqual(self.request('/api/review/units/X-1/recall', {'missed': []}).status, 404)

    def test_review_that_is_not_due_is_forbidden(self):
        self.login()
        self.assertEqual(self.request('/api/review/reviews/review-01').status, 403)
        self.assertEqual(self.request('/api/review/reviews/review-01/submit', {'answers': {}}).status, 403)

    def test_material_without_recall_items_is_500_with_path(self):
        self.login()
        path = self.notes / 'groups/units/B-01-1.json'
        material = json.loads(path.read_text())
        del material['recall_items']
        path.write_text(json.dumps(material))
        response = self.request('/api/review/units/B-01-1')
        self.assertEqual(response.status, 500)
        self.assertIn('groups/units/B-01-1.json', json.load(response)['error'])

    def test_corrupt_study_data_returns_500_with_path(self):
        self.login()
        path = self.notes / 'groups/submissions/r1/B-01-1.json'
        path.parent.mkdir(parents=True)
        path.write_text('{')
        for url in ('/api/review/today', '/api/review/units/B-01-1'):
            with self.subTest(url=url):
                response = self.request(url)
                self.assertEqual(response.status, 500)
                self.assertIn('groups/submissions/r1/B-01-1.json', json.load(response)['error'])

    def test_regular_papers_api_cannot_open_plan_paper(self):
        self.login()
        self.assertEqual(self.request(f'/api/quiz/papers/{UNIT_PAPER}').status, 404)
        self.assertEqual(self.request(f'/api/quiz/papers/{UNIT_PAPER}/answers', {'answers': {'1': {'answer': '2'}}}).status, 404)
        self.assertNotIn(UNIT_PAPER, [paper['slug'] for paper in json.load(self.request('/api/quiz/papers'))])
        self.assertNotIn('1-2', self.paper_text())

    def test_asset_endpoint_serves_images_only(self):
        self.login()
        response = self.request('/api/review/asset?path=assets/grammar/n5/N5-G-0013-connection.png')
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers['Content-Type'], 'image/png')
        self.assertEqual(response.headers['Cache-Control'], 'private, max-age=3600')
        self.assertEqual(response.read(), (self.notes / 'assets/grammar/n5/N5-G-0013-connection.png').read_bytes())
        for query in ('path=../../.git/config', 'path=assets/%2e%2e/%2e%2e/.git/config', 'path=%2e%2e%2f%2e%2e%2f.git%2fconfig',
                      'path=assets/%2e%2e/groups/mapping.json', '', 'path=assets/grammar/n5/N5-G-0013-connection.png&path=x'):
            with self.subTest(query=query):
                self.assertIn(self.request('/api/review/asset?' + query).status, (400, 404))
