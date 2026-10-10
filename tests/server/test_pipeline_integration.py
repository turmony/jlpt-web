"""Run the actual pinned study tools on their own mechanical test fixture."""
import importlib.util
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

from server.artifacts import validate_paper, run_validators, QUIZZES, PIPELINE
from server.store import Store
from server.worker import Worker


@unittest.skipUnless(os.environ.get('JLPT_STUDY_ROOT'), 'Set JLPT_STUDY_ROOT to run real upstream validators')
class PipelineIntegrationTests(unittest.TestCase):
    def test_generation_submission_grade_failed_commit_and_recovery(self):
        study=Path(os.environ['JLPT_STUDY_ROOT'])
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'study';root.mkdir()
            process=subprocess.Popen(['git','-C',str(study),'archive','HEAD','.claude/skills/quiz-generate','src','pyproject.toml','uv.lock'],stdout=subprocess.PIPE)
            with tarfile.open(fileobj=process.stdout,mode='r|') as archive:
                archive.extractall(root,filter='data')
            process.stdout.close();self.assertEqual(process.wait(),0)
            fixtures=root/'.claude/skills/quiz-generate/scripts/tests/fixtures/env-basic/jlpt-notes'
            shutil.copytree(fixtures,root/'jlpt-notes')
            def git(*args):return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()
            git('init','-b','web-study');git('config','user.email','test@example.com');git('config','user.name','Test')
            attempts=root/QUIZZES/'attempts.jsonl';attempts.write_text('')
            git('add','.');git('commit','-m','mechanical fixture base')
            path=root/'.claude/skills/quiz-generate/scripts/tests/test_quiz_pipeline.py'
            spec=importlib.util.spec_from_file_location('upstream_test_fixture',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            data=module.make_draft();slug=data['quiz']['slug']
            evidence=root/QUIZZES/'sources/cache/evidence.md';evidence.parent.mkdir(parents=True,exist_ok=True);evidence.write_text('日本語NETの原例文：雨が降ったのに、試合は続けられた。\n')
            draft=root/'draft.json';draft.write_text(json.dumps(data,ensure_ascii=False))
            result=subprocess.run(['uv','run','--no-dev','python',PIPELINE,'render','--root','.', '--draft',str(draft),'--final'],cwd=root,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            requirements={'level':'N4','count':1,'cards':['N4-G-0001'],'sections':{'form':1,'order':0,'cloze':0}}
            paper=validate_paper(root,slug,requirements)
            self.assertEqual(len(paper['questions']),1)
            self.assertEqual(len(run_validators(root,paper)),3)
            store=Store(Path(tmp)/'state.sqlite');worker=Worker(store,root)
            task={'id':'fixture-task','generation':1,'cli':'codex','status':'checking'};store.put('tasks',task['id'],task)
            folder=root/QUIZZES/'web/fixture-task';folder.mkdir(parents=True)
            handoff={'task_id':task['id'],'turn':1,'operation':'generate','slug':slug,'requirements':requirements}
            (folder/'turn-1.json').write_text(json.dumps(handoff))
            worker.process_handoff(task)
            self.assertEqual(store.get('tasks',task['id'])['status'],'ready')
            store.save_draft(slug,{'1':{'answer':'1','uncertain':False}},0)
            submitted=store.submit(slug,1);worker.export_submissions()
            report=f'# {slug}\n## 成绩概览\n全卷得分：1／1\nN4卷曲线：1\n## 全部考点清单\n| 1 | N4-G-0001 | のに | ✓ |\n## 逐题全解析\n#### 第 1 题 ✓（N4-Q-0007）\n**题目**：雨が降った（　）、試合は続けられた。\n**翻译**：尽管下雨比赛继续。\n**你的答案**：1（のに）\n**接续规则**：普通形＋のに\n**意思**：尽管\n**解析**：逆接\n## 薄弱区结论\n### 仍薄弱\n无\n### 已攻克\nN4-G-0001'
            report_path=root/QUIZZES/f'results/{slug}-result.md';report_path.parent.mkdir(parents=True,exist_ok=True);report_path.write_text(report)
            handoff={'task_id':task['id'],'turn':2,'operation':'grade','slug':slug,'submission_id':submitted['submission']['id'],
                     'report':str(report_path.relative_to(root)),'score':1,'rows':[{'number':1,'question_id':'N4-Q-0007','revision':1,
                     'item_type':'form_choice','selected_option':'1','is_correct':True,'uncertain':False,'error_tags':[],'date':'2026-10-10'}]}
            (folder/'turn-2.json').write_text(json.dumps(handoff));task.update(generation=2,status='checking');store.put('tasks',task['id'],task)
            git('config','user.name','');git('config','user.email','')
            with self.assertRaises(RuntimeError):worker.process_handoff(task)
            self.assertEqual(store.get('papers',slug)['score'],1)
            first_attempts=attempts.read_bytes();self.assertEqual(len(first_attempts.splitlines()),1)
            git('config','user.name','Test');git('config','user.email','test@example.com')
            store.recover();self.assertEqual(store.get('tasks',task['id'])['status'],'commit_failed')
            worker.commit(store.get('tasks',task['id']))
            sha=git('rev-parse','HEAD');worker.commit(store.get('tasks',task['id']))
            self.assertEqual(git('rev-parse','HEAD'),sha)
            self.assertEqual(git('rev-list','--count','HEAD'),'2')
            self.assertEqual(attempts.read_bytes(),first_attempts)
            files=git('show','--format=','--name-only',sha).splitlines()
            self.assertNotIn('draft.json',files)
            self.assertTrue(all(name.startswith(QUIZZES+'/') for name in files))
            self.assertEqual(git('diff','--cached'),'')
