"""Papers written by the agent's quiz-generate skill, answered on the web.

The web page only fills the paper's own `## 答案填写区` block, which quiz-grade
reads (`N-答案`, `*N-答案` when uncertain). Grading and commits stay with the agent.

Papers registered by the grammar-network plan (`groups/units/*.json`,
`groups/reviews/*.json`) are answered only through `/review/`, so the regular
paper API neither lists nor opens them.
"""
import json
import os
import re
import uuid
from pathlib import Path, PurePosixPath

from .store import Conflict

QUIZZES = 'jlpt-notes/quizzes'
GROUPS = 'jlpt-notes/groups'


def safe_file(root, name):
    """Resolve a repository-relative file without absolute paths, `..`, `.git` or symlinks."""
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
            raise ValueError('不允许符号链接')
    if not cursor.is_file():
        raise ValueError(f'文件不存在：{name}')
    return cursor


def atomic_write(path, data):
    path = Path(path)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with tmp.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


SLUG = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9-]{0,150}')
ANSWER_HEADING = '## 答案填写区'
# An answer line holds tokens such as `1-__`, `21-2314` or `*22-3`; section labels never start with a number.
ANSWER_LINE = re.compile(r'^\s*\*?\d+-')
TOKEN = re.compile(r'(\*?)(\d+)-([^\s,，、]*)')
VALUE = re.compile(r'[1-9]{1,8}')


def _paper_path(root, slug):
    if not isinstance(slug, str) or not SLUG.fullmatch(slug):
        raise ValueError('试卷名称无效')
    name = f'{QUIZZES}/papers/{slug}.md'
    if not (Path(root) / name).is_file():
        raise KeyError(slug)
    return safe_file(root, name)


def plan_slugs(root):
    """Paper slugs named by the plan's unit and review materials."""
    slugs = set()
    for folder in ('units', 'reviews'):
        for entry in sorted((Path(root) / GROUPS / folder).glob('*.json')):
            try:
                text = entry.read_text()
            except (OSError, UnicodeDecodeError):
                continue
            try:
                found = [json.loads(text).get('paper')]
            except (ValueError, AttributeError):
                # A damaged material file still hides its paper rather than exposing it.
                found = re.findall(r'"paper"\s*:\s*"([^"\\]+)"', text)
            slugs.update(slug for slug in found if isinstance(slug, str))
    return slugs


def _regular_path(root, slug):
    path = _paper_path(root, slug)
    if slug in plan_slugs(root):
        raise KeyError(slug)
    return path


def _plan_path(root, slug):
    path = _paper_path(root, slug)
    if slug not in plan_slugs(root):
        raise KeyError(slug)
    return path


def _result_text(root, slug):
    try:
        return safe_file(root, f'{QUIZZES}/results/{slug}-result.md').read_text()
    except ValueError:
        return None


def _answer_block(text):
    """Return (start, end) offsets of the answer fence body, or None."""
    heading = text.rfind('\n' + ANSWER_HEADING)
    if heading < 0:
        return None
    fence = re.compile(r'^```[^\n]*\n', re.M).search(text, heading)
    if not fence:
        return None
    close = text.find('\n```', fence.end() - 1)
    return (fence.end(), close + 1) if close >= 0 else None


def _parse(text):
    block = _answer_block(text)
    answers = {}
    if block:
        for line in text[block[0]:block[1]].splitlines():
            if ANSWER_LINE.match(line):
                for star, number, value in TOKEN.findall(line):
                    value = '' if set(value) <= {'_'} else value
                    answers[number] = {'answer': value, 'uncertain': bool(star) and bool(value)}
    return answers


def _summary(root, path):
    text = path.read_text()
    answers = _parse(text)
    title = next((line[2:].strip() for line in text.splitlines() if line.startswith('# ')), path.stem)
    answered = sum(1 for item in answers.values() if item['answer'])
    status = 'graded' if _result_text(root, path.stem) is not None else 'submitted' if answered else 'new'
    date = path.stem[:10] if re.match(r'\d{4}-\d{2}-\d{2}', path.stem) else ''
    return text, answers, {'slug': path.stem, 'title': title, 'date': date,
                           'questions': len(answers), 'answered': answered, 'status': status}


RECENT = 20


def list_papers(root, limit=RECENT):
    folder = Path(root) / QUIZZES / 'papers'
    hidden = plan_slugs(root)
    result = []
    natural = lambda path: [int(part) if part.isdigit() else part for part in re.split(r'(\d+)', path.stem)]
    for entry in sorted(folder.glob('*.md'), key=natural, reverse=True) if folder.is_dir() else []:
        if entry.stem in hidden:
            continue
        try:
            result.append(_summary(root, _paper_path(root, entry.stem))[2])
        except ValueError:
            continue
        if len(result) == limit:
            break
    return result


def _read(root, path):
    text, answers, summary = _summary(root, path)
    return {**summary, 'text': text, 'answers': answers,
            'numbers': sorted(int(number) for number in answers), 'result': _result_text(root, path.stem)}


def read_paper(root, slug):
    return _read(root, _regular_path(root, slug))


def read_plan_paper(root, slug):
    """A plan paper without its answer area; answers come back in `answers`."""
    paper = _read(root, _plan_path(root, slug))
    heading = paper['text'].rfind('\n' + ANSWER_HEADING)
    return {**paper, 'text': paper['text'][:heading] if heading >= 0 else paper['text']}


def fill_sheet(text, answers):
    """Return the paper text with its answer block filled from validated answers."""
    def token(match):
        item = answers.get(match[2], {})
        value = item.get('answer', '')
        return f"{'*' if value and item.get('uncertain') else ''}{match[2]}-{value or '__'}"

    start, end = _answer_block(text)
    body = ''.join(TOKEN.sub(token, line) if ANSWER_LINE.match(line) else line
                   for line in text[start:end].splitlines(keepends=True))
    return text[:start] + body + text[end:]


def write_answers(root, slug, answers):
    """Replace the whole answer sheet; numbers left out become blank again."""
    _write(root, _regular_path(root, slug), answers)
    return read_paper(root, slug)


def write_plan_answers(root, slug, answers):
    _write(root, _plan_path(root, slug), answers)
    return read_plan_paper(root, slug)


def _write(root, path, answers):
    if _result_text(root, path.stem) is not None:
        raise Conflict('这份试卷已判分，不能再修改作答')
    text = path.read_text()
    known = _parse(text)
    if not known:
        raise ValueError('试卷没有答案填写区')
    if not isinstance(answers, dict) or not set(answers) <= set(known):
        raise ValueError('作答题号无效')
    for item in answers.values():
        if not isinstance(item, dict) or not isinstance(item.get('answer'), str):
            raise ValueError('作答格式无效')
        if item['answer'] and not VALUE.fullmatch(item['answer']):
            raise ValueError('答案只能是选项编号或排序编号，例如 3 或 2314')
        if not isinstance(item.get('uncertain', False), bool):
            raise ValueError('不确定标记无效')

    atomic_write(path, fill_sheet(text, answers).encode())
