import concurrent.futures
import tempfile
import unittest
from pathlib import Path

from server.auth import Auth
from server.store import Store, Conflict


class StateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'state.sqlite'
        self.store = Store(self.path)

    def test_password_and_session_survive_restart_and_revoke(self):
        auth = Auth(self.store, Auth.hash_password('a long password'))
        self.assertIsNone(auth.login('wrong'))
        token = auth.login('a long password')
        self.assertNotIn(token, self.path.read_bytes().decode(errors='ignore'))
        restarted = Auth(Store(self.path), auth.password_hash)
        self.assertTrue(restarted.check(token))
        restarted.logout(token)
        self.assertFalse(auth.check(token))
        token = auth.login('a long password', now=100)
        self.assertFalse(auth.check(token, now=100 + 366 * 86400))

    def test_submission_is_once_even_across_tabs_and_restart(self):
        self.store.put('papers', 'paper', {'questions': [{'number': 1}], 'draft': {}, 'version': 0})
        self.store.save_draft('paper', {'1': {'answer': '2', 'uncertain': True}}, 0)
        with self.assertRaises(Conflict):
            self.store.save_draft('paper', {'1': {'answer': '3'}}, 0)
        with concurrent.futures.ThreadPoolExecutor() as pool:
            results = list(pool.map(lambda _: self.store.submit('paper', 1), range(8)))
        self.assertEqual(len({r['submission']['id'] for r in results}), 1)
        restored = Store(self.path).get('papers', 'paper')
        self.assertEqual(restored['submission']['answers']['1']['answer'], '2')
        with self.assertRaises(Conflict):
            self.store.save_draft('paper', {}, 1)

    def test_preview_is_bound_and_enqueue_is_idempotent(self):
        self.store.put('previews', 'p', {'task_id': 't', 'cli': 'codex', 'prompt': 'exact', 'generation': 0})
        first = self.store.enqueue('p')
        self.assertEqual(first['prompt'], 'exact')
        self.assertEqual(self.store.enqueue('p')['id'], first['id'])
        self.store.put('previews', 'old', {'task_id': 't', 'cli': 'codex', 'prompt': 'old', 'generation': 0})
        with self.assertRaises(Conflict):
            self.store.enqueue('old')

    def test_restart_preserves_output_and_marks_interrupted(self):
        self.store.put('tasks', 't', {'id': 't', 'status': 'running', 'session': 'session-1'})
        self.store.event('t', 'message', 'still here')
        self.store.recover()
        self.assertEqual(self.store.get('tasks', 't')['status'], 'interrupted')
        self.assertEqual(self.store.get('tasks', 't')['session'], 'session-1')
        self.assertEqual(self.store.events('t')[0]['text'], 'still here')

    def test_publish_preserves_concurrent_answers_and_never_unlocks_submission(self):
        paper = {'id':'p', 'task_id':'t', 'questions':[{'number':1}], 'hashes':{'paper':'hash'}, 'draft':{}, 'version':0}
        self.store.put('tasks','t',{'id':'t','status':'checking'})
        self.store.publish_paper(paper)
        self.store.save_draft('p', {'1':{'answer':'2'}}, 0)
        self.store.submit('p', 1)
        self.store.change('tasks','t',lambda t:t.update(status='checking'))
        restored = self.store.publish_paper(paper)
        self.assertEqual(restored['submission']['answers']['1']['answer'], '2')
        with self.assertRaises(Conflict):
            self.store.publish_paper({**paper, 'hashes':{'paper':'changed'}})
        self.store.change('tasks','t',lambda t:t.update(status='checking',cancellation_requested=True))
        with self.assertRaises(Conflict):
            self.store.publish_paper(paper)

    def test_receipt_and_grade_visibility_are_atomic_and_owned(self):
        for task_id in ('a','b'):
            self.store.put('tasks',task_id,{'id':task_id,'status':'checking'})
        self.store.put('papers','p',{'submission':{'id':'sub'},'version':0})
        grade = {'submission_id':'sub','report':'result.md','score':1}
        self.store.accept_grade('a','p',grade)
        self.assertEqual(self.store.get('papers','p')['report'],'result.md')
        self.assertEqual(self.store.get('papers','p')['score'],1)
        with self.assertRaises(Conflict):
            self.store.accept_grade('b','p',grade)
        self.assertNotIn('grade',self.store.get('tasks','b'))
        self.store.put('tasks','c',{'id':'c','status':'checking','cancellation_requested':True})
        self.store.put('papers','q',{'submission':{'id':'sub2'}})
        with self.assertRaises(Conflict):
            self.store.accept_grade('c','q',{**grade,'submission_id':'sub2'})

    def test_cancelled_queue_cannot_be_claimed(self):
        self.store.put('tasks','t',{'id':'t','status':'cancelled'})
        self.assertIsNone(self.store.claim_next())
        self.store.put('tasks','t',{'id':'t','status':'queued'})
        self.assertEqual(self.store.claim_next()['status'],'running')
        self.assertIsNone(self.store.claim_next())
