import importlib.util
import json
import os
import re
import subprocess
import uuid
from datetime import date
from pathlib import Path, PurePosixPath

QUIZZES = 'jlpt-notes/quizzes'
PIPELINE = '.claude/skills/quiz-generate/scripts/quiz_pipeline.py'


def safe_file(root, name):
    root = Path(root).resolve()
    if not isinstance(name, str) or not name or '\\' in name:
        raise ValueError('文件路径无效')
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '.git' in path.parts:
        raise ValueError('不允许访问此路径')
    cursor = root
    for part in path.parts:
        cursor /= part
        if cursor.is_symlink():
            raise ValueError('不允许符号链接产物')
    if not cursor.is_file():
        raise ValueError(f'产物文件不存在：{name}')
    return cursor


def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with tmp.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def trusted_pipeline(root):
    path = safe_file(root, PIPELINE)
    baseline = subprocess.check_output(['git', '-C', str(root), 'show', f'HEAD:{PIPELINE}'])
    if path.read_bytes() != baseline:
        raise ValueError('资料库校验工具发生未提交修改，拒绝运行')
    spec = importlib.util.spec_from_file_location('study_quiz_pipeline', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_paper(root, slug, requirements):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*', slug):
        raise ValueError('试卷名称无效')
    manifest_name = f'{QUIZZES}/sources/{slug}/manifest.json'
    manifest = json.loads(safe_file(root, manifest_name).read_text())
    pipeline = trusted_pipeline(root)
    errors = pipeline.validate_data(manifest, Path(root), 'final')
    if errors:
        raise ValueError('出卷清单检查失败：\n' + '\n'.join(errors))
    if manifest['quiz']['slug'] != slug:
        raise ValueError('试卷与清单关联不一致')
    questions = manifest['questions']
    if not isinstance(requirements, dict) or requirements.get('level') != manifest['quiz']['level'] or requirements.get('count') != len(questions):
        raise ValueError('缺少已确定的范围与题量，或实际产物不匹配')
    counts = {section: sum(q['section'] == section for q in questions) for section in ('form', 'order', 'cloze')}
    if requirements.get('sections') != counts:
        raise ValueError('实际题型与已确定需求不符')
    cards = requirements.get('cards')
    actual = {card for q in questions for card in q['tested_cards']}
    if not isinstance(cards, list) or actual != set(cards):
        raise ValueError('实际考点范围与已确定需求不符')
    files = [manifest_name]
    rendered = {f'{QUIZZES}/papers/{slug}.md': pipeline.render_paper(manifest),
                f'{QUIZZES}/answers/{slug}-answers.md': pipeline.render_answers(manifest)}
    for question in questions:
        rendered[f"{QUIZZES}/questions/{question['id']}.md"] = pipeline.render_card(question, manifest['quiz']['level'])
        for evidence in question['source']['evidence_paths']:
            name = f'jlpt-notes/{evidence}'
            safe_file(root, name)
            files.append(name)
            # Source-cache metadata is part of the adopted source evidence, not the whole cache.
            metadata = str(PurePosixPath(name).parent / 'source.json')
            if (Path(root) / metadata).is_file():
                safe_file(root, metadata)
                files.append(metadata)
    for name, expected in rendered.items():
        if safe_file(root, name).read_text() != expected:
            raise ValueError(f'产物与最终清单不一致：{name}')
        files.append(name)
    return {'id': slug, 'title': manifest['quiz']['title'], 'level': manifest['quiz']['level'], 'questions': questions,
            'requirements': requirements, 'files': sorted(set(files)), 'draft': {}, 'version': 0}


def run_validators(root, paper):
    counts = [sum(q['section'] == section for q in paper['questions']) for section in ('form', 'order', 'cloze')]
    commands = [
        ['uv', 'run', 'python', '.claude/skills/quiz-generate/scripts/validate_quiz.py',
         '--paper', f"{QUIZZES}/papers/{paper['id']}.md", '--answers', f"{QUIZZES}/answers/{paper['id']}-answers.md",
         '--structure', ','.join(map(str, counts)), '--level', paper['level']],
        ['uv', 'run', 'python', '-m', 'jlpt_notes', 'validate-links', '--root', 'jlpt-notes'],
        ['uv', 'run', 'python', '-m', 'jlpt_notes', 'validate-reader-links', '--root', 'jlpt-notes'],
    ]
    results = []
    for command in commands:
        p = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=180)
        results.append({'command': command, 'code': p.returncode, 'output': (p.stdout + p.stderr)[-16000:]})
        if p.returncode:
            raise ValueError('项目校验失败：' + ' '.join(command) + '\n' + results[-1]['output'])
    return results


def validate_grade(paper, handoff, report):
    submission = paper.get('submission')
    if not submission or handoff.get('submission_id') != submission['id']:
        raise ValueError('成绩不对应已交卷作答')
    rows = handoff.get('rows')
    if not isinstance(rows, list) or len(rows) != len(paper['questions']):
        raise ValueError('成绩记录题量不一致')
    by_number = {r.get('number'): r for r in rows}
    if len(by_number) != len(rows):
        raise ValueError('成绩记录题号重复')
    for q in paper['questions']:
        row = by_number.get(q['number'])
        answer = submission['answers'][str(q['number'])]
        if row is None or any(row.get(key) != q[key] for key in ('revision', 'item_type')) or row.get('question_id') != q['id']:
            raise ValueError('成绩记录与题卡不匹配')
        if row.get('selected_option') != answer['answer'] or row.get('uncertain') != answer.get('uncertain', False):
            raise ValueError('成绩记录改写了已交卷答案')
        if not isinstance(row.get('is_correct'), bool) or not isinstance(row.get('error_tags'), list):
            raise ValueError('判分 schema 无效')
        if (row['is_correct'] and row['error_tags']) or (not row['is_correct'] and not 1 <= len(row['error_tags']) <= 3):
            raise ValueError('错因标签不符合判卷规则')
        date.fromisoformat(row['date'])
        if q['section'] != 'order' and row['is_correct'] != (answer['answer'] == str(q['correct_option'])):
            raise ValueError('选择题判分与唯一答案不符')
        match = re.search(rf'^####\s+第\s*{q["number"]}\s*题\b(.*?)(?=^####|^## |\Z)', report, re.M | re.S)
        if not match or q['id'] not in match[0]:
            raise ValueError('报告缺少题号对应的逐题解析')
        expected_mark = '✓' if row['is_correct'] else '✗'
        wrong_mark = '✗' if row['is_correct'] else '✓'
        heading = match[0].splitlines()[0]
        if expected_mark not in heading or wrong_mark in heading:
            raise ValueError('报告逐题判定与记录不一致')
        reported_answer = re.search(r'\*\*你的(?:答案|语序)\*\*\s*[：:]\s*(\d+)', match[0])
        if not reported_answer or reported_answer[1] != answer['answer']:
            raise ValueError('报告中的用户答案与正式交卷不一致')
        if any(label not in match[0] for label in ('题目', '翻译', '接续规则', '意思', '解析')) or not ('你的答案' in match[0] or '你的语序' in match[0]):
            raise ValueError('逐题解析六要素不完整')
        if q['section'] == 'order' and '拼句' not in match[0]:
            raise ValueError('排序题缺少完整拼句判定')
        if not re.search(rf'^\|\s*{q["number"]}\s*\|', report, re.M):
            raise ValueError('报告考点表未覆盖全部题目')
        table_row = re.search(rf'^\|\s*{q["number"]}\s*\|.*$', report, re.M)[0]
        result = table_row.split('|')[-2]
        if expected_mark not in result or wrong_mark in result:
            raise ValueError('报告考点表判定与记录不一致')
    score = sum(row['is_correct'] for row in rows)
    if type(handoff.get('score')) is not int or handoff['score'] != score:
        raise ValueError('总分与逐题判分不一致')
    recorded = re.search(r'全卷得分[：:]\s*(\d+)\s*[／/]\s*(\d+)', report)
    if not recorded or tuple(map(int, recorded.groups())) != (score, len(rows)):
        raise ValueError('报告总分与判分记录不一致')
    headings = ['## 成绩概览', '## 全部考点清单', '## 逐题全解析', '## 薄弱区结论']
    positions = [report.find(h) for h in headings]
    if -1 in positions or positions != sorted(positions) or '曲线' not in report or '仍薄弱' not in report or '已攻克' not in report:
        raise ValueError('报告五段结构不完整')
    return rows


def append_attempts(path, submission_id, rows):
    path = Path(path)
    old = path.read_bytes() if path.exists() else b''
    if old and not old.endswith(b'\n'):
        raise ValueError('历史记录末尾缺少换行，拒绝改写历史')
    normalized = [{**{k: v for k, v in row.items() if k != 'number'}, 'web_submission_id': submission_id} for row in rows]
    existing = [json.loads(line) for line in old.splitlines() if line.strip()]
    previous = [row for row in existing if row.get('web_submission_id') == submission_id]
    if previous:
        if previous != normalized:
            raise ValueError('同一交卷已有不同作答记录，拒绝重复追加')
        return
    data = old + b''.join((json.dumps(row, ensure_ascii=False) + '\n').encode() for row in normalized)
    atomic_write(path, data)
