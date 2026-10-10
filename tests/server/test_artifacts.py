import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from server.artifacts import safe_file, validate_grade, append_attempts
from server.git import commit_exercise


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_paths_reject_traversal_and_symlink(self):
        (self.root / 'good').write_text('yes')
        (self.root / 'link').symlink_to(self.root / 'good')
        self.assertEqual(safe_file(self.root, 'good').read_text(), 'yes')
        for path in ('../bad', '/etc/passwd', 'link'):
            with self.assertRaises(ValueError):
                safe_file(self.root, path)

    def test_grade_checks_submission_answers_score_and_full_report(self):
        paper = {'id': 'slug', 'questions': [{'id': 'N3-Q-0001', 'number': 1, 'revision': 1,
                 'item_type': 'text_grammar', 'section': 'form', 'correct_option': '2', 'tested_cards': ['N3-G-0001']}],
                 'submission': {'id': 'sub', 'answers': {'1': {'answer': '2', 'uncertain': True}}}}
        report = '# 试卷成绩\n## 成绩概览\n- 全卷得分：1／1\n- N3卷曲线：1\n## 全部考点清单\n| 1 | N3-G-0001 | test | ✓ |\n## 逐题全解析\n#### 第 1 题 ✓（N3-Q-0001）\n**题目**：x\n**翻译**：x\n**你的答案**：2\n**接续规则**：x\n**意思**：x\n**解析**：x\n## 薄弱区结论\n### 仍薄弱\n无\n### 已攻克\nx'
        row = {'number': 1, 'question_id': 'N3-Q-0001', 'revision': 1, 'item_type': 'text_grammar',
               'selected_option': '2', 'is_correct': True, 'uncertain': True, 'error_tags': [], 'date': '2026-10-10'}
        handoff = {'submission_id': 'sub', 'score': 1, 'rows': [row]}
        self.assertEqual(validate_grade(paper, handoff, report), [row])
        for changed in ({'submission_id': 'wrong'}, {'score': 0}, {'rows': [{**row, 'selected_option': '3'}]},
                        {'rows': [{**row, 'is_correct': False}]}, {'rows': [row, row]}):
            with self.assertRaises(ValueError):
                validate_grade(paper, {**handoff, **changed}, report)
        with self.assertRaises(ValueError):
            validate_grade(paper, handoff, '模型说完成了')

    def test_attempts_append_preserves_history_and_is_idempotent(self):
        path = self.root / 'attempts.jsonl'
        old = b'{"old":true}\n'
        path.write_bytes(old)
        rows = [{'question_id': 'N3-Q-0001', 'number': 1, 'is_correct': True}]
        append_attempts(path, 'sub', rows)
        first = path.read_bytes()
        self.assertTrue(first.startswith(old))
        append_attempts(path, 'sub', rows)
        self.assertEqual(path.read_bytes(), first)
        with self.assertRaises(ValueError):
            append_attempts(path, 'sub', [{'question_id': 'N3-Q-0002'}])

    def test_git_commit_contains_only_related_files_and_retry_is_once(self):
        def git(*args):
            return subprocess.check_output(['git', '-C', str(self.root), *args], text=True).strip()
        git('init', '-b', 'web-study')
        git('config', 'user.email', 'test@example.com')
        git('config', 'user.name', 'Test')
        (self.root / 'unrelated').write_text('old')
        git('add', 'unrelated')
        git('commit', '-m', 'base')
        (self.root / 'unrelated').write_text('pending')
        git('add', 'unrelated')
        (self.root / 'exercise').write_text('done')
        before_index = git('diff', '--cached')
        sha = commit_exercise(self.root, 'task-1', ['exercise'])
        self.assertEqual(git('show', '--format=', '--name-only', sha), 'exercise')
        self.assertEqual(git('show', f'{sha}:unrelated'), 'old')
        self.assertEqual(git('diff', '--cached', '--', 'unrelated'), before_index)
        self.assertEqual(git('status', '--short', '--', 'exercise'), '')
        self.assertEqual(commit_exercise(self.root, 'task-1', ['exercise']), sha)
        self.assertEqual(git('rev-list', '--count', 'HEAD'), '2')

    def test_report_cannot_contradict_the_submission_or_result(self):
        paper = {'questions':[{'number':1,'id':'N3-Q-0001','revision':1,'item_type':'text_grammar','section':'form','correct_option':'2'}],
                 'submission':{'id':'s','answers':{'1':{'answer':'2'}}}}
        row={'number':1,'question_id':'N3-Q-0001','revision':1,'item_type':'text_grammar','selected_option':'2',
             'is_correct':True,'uncertain':False,'error_tags':[],'date':'2026-10-10'}
        report='## 成绩概览\n全卷得分：1／1\n曲线\n## 全部考点清单\n| 1 | N3-G-0001 | test | ✓ |\n## 逐题全解析\n#### 第 1 题 ✓（N3-Q-0001）\n题目 翻译 接续规则 意思 解析\n**你的答案**：2（内容）\n## 薄弱区结论\n仍薄弱 已攻克'
        for changed in (report.replace('**你的答案**：2','**你的答案**：3'), report.replace('题 ✓','题 ✗'),
                        report.replace('test | ✓','test | ✗')):
            with self.assertRaises(ValueError):
                validate_grade(paper,{'submission_id':'s','score':1,'rows':[row]},changed)
