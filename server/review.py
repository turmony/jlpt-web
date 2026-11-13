"""Grammar-network review plan, served to `/review/`.

The plan rules have one implementation: the study repository's
`src/jlpt_notes/groups.py`, and the spaced review (FSRS) rules theirs,
`src/jlpt_notes/spaced_review.py`, both loaded here by file path. This module
only reads the unit page, member cards, images and papers for the web, has the
review records rebuilt after every review write, and turns rule refusals and
damaged study data into HTTP-shaped errors.
"""
import importlib.util
import json
import re
import sys
import threading
import traceback
import uuid
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import quote, unquote

from scripts.update_catalog_core import extract_core

from . import papers
from .papers import atomic_write, safe_file
from .store import Conflict

NOTES = 'jlpt-notes'
RULES = 'src/jlpt_notes/groups.py'
SPACED = 'src/jlpt_notes/spaced_review.py'
# Every tap of 忘了 in the usage overview, written only by this site; later statistics read it.
FORGETS = 'groups/forgets.json'
FORGET_UNDO = timedelta(minutes=2)
TZ = timezone(timedelta(hours=8))
IMAGES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif'}
FRONTMATTER = re.compile(r'\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)', re.S)
# `[text](target)` or `![alt](target "title")`; nested brackets are left alone.
LINK = re.compile(r'(!?)\[([^\[\]]*)\]\(\s*<?([^()\s<>]*)>?(?:\s+"[^"]*")?\s*\)')
CARD_PAGE = re.compile(r'grammar/n[1-5]/(N[1-5]-G-\d{4,})\.md')
ANSWER_SECTION = re.compile(r'^### 第 (\d+) 题.*$', re.M)
ANSWER_CORRECT = re.compile(r'^\*\*正确项\*\*：\s*(\d+)（(.*?)）\s*$', re.M)
# Lines of an answer-file section that the review page does not repeat (the paper shows the stem; sources stay in the file).
ANSWER_ORDER_FIELD = re.compile(r'^\*\*推荐语序\*\*：\s*([1-4]{4})', re.M)
ANSWER_ORDER_TEXT = re.compile(r'推荐语序：([^＋。\n]*)')
ANSWER_SKIP = re.compile(r'^\*\*(?:题目|考点|来源|证据|正确项)\*\*[：:]')


class Forbidden(Exception):
    """The plan does not allow this now (HTTP 403)."""


class StudyDataError(Exception):
    """The study repository cannot be used as it stands (HTTP 500); the message names the file."""


_modules = {}
_load_lock = threading.Lock()
# One learner action at a time, so two tabs cannot interleave answer writes and submission.
_write_lock = threading.Lock()


def load_groups(study_root):
    return _load(study_root, RULES)


def load_spaced(study_root):
    return _load(study_root, SPACED)


def _load(study_root, relative):
    path = Path(study_root) / relative
    try:
        stamp = path.stat().st_mtime_ns
    except OSError:
        raise StudyDataError(f'找不到学习仓库的规则模块：{path}') from None
    with _load_lock:
        cached = _modules.get(path)
        if cached and cached[0] == stamp:
            return cached[1]
        name = f'_jlpt_study_{path.stem}_{len(_modules)}_{stamp}'
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception as error:
            sys.modules.pop(name, None)
            raise StudyDataError(f'学习仓库的规则模块无法加载：{path}（{error}）') from error
        _modules[path] = (stamp, module)
        return module


@contextmanager
def _rules(study_root):
    groups = load_groups(study_root)
    try:
        yield groups
    except groups.PlanActionError as error:
        raise {'not_allowed': Forbidden, 'conflict': Conflict}.get(error.code, ValueError)(str(error)) from error
    except groups.PlanDataError as error:
        raise StudyDataError('资料格式错误：' + str(error)) from error


@contextmanager
def _spaced_rules(study_root):
    spaced = load_spaced(study_root)
    try:
        yield spaced
    except spaced.SpacedError as error:
        raise {'conflict': Conflict, 'data': StudyDataError}.get(error.code, ValueError)(str(error)) from error


def _notes(study_root):
    return Path(study_root) / NOTES


def today(study_root):
    with _rules(study_root) as groups:
        return groups.plan_state(_notes(study_root))


def spaced_today(study_root):
    """The review panel: units due today (FSRS), units reviewed today, units that may be reviewed, and their titles."""
    notes = _notes(study_root)
    with _spaced_rules(study_root) as spaced:
        return _with_titles(study_root, spaced.due_state(notes))


def submit_spaced(study_root, units):
    """Record the selected units as reviewed today (all or none), then rebuild the review records."""
    notes = _notes(study_root)
    with _write_lock:
        with _spaced_rules(study_root) as spaced:
            state = spaced.record(notes, units)
        error = _rewrite_records(study_root)
        return _with_records_error(_with_titles(study_root, state), error)


def _with_titles(study_root, state):
    shown = set(state['eligible']) | set(state['done_today']) | {entry['unit'] for entry in state['due']}
    with _rules(study_root) as groups:
        titles = {unit.id: unit.title for unit in groups.load_catalog(_notes(study_root)).units if unit.id in shown}
    return {**state, 'titles': titles}


def _rewrite_records(study_root):
    """Rebuild `groups/review-records.json` after a raw review write; `None`, or why it failed.

    The raw write already stands and is never undone, so any failure here is only reported back as
    `records_error`: an error answer would make the learner repeat an action that was in fact recorded.
    """
    try:
        spaced = load_spaced(study_root)
    except StudyDataError as error:
        return str(error)
    try:
        spaced.write_records(_notes(study_root))
    except spaced.SpacedError as error:
        return str(error)
    except Exception as error:
        sys.stderr.write('review records rewrite failed:\n' + traceback.format_exc())
        sys.stderr.flush()
        return f'{type(error).__name__}: {error}'
    return None


def _with_records_error(result, error):
    return {**result, 'records_error': error} if error is not None else result


def _prepared_unit(groups, notes, unit_id):
    unit = next((unit for unit in groups.load_catalog(notes).units if unit.id == unit_id), None)
    if unit is None or not groups.is_prepared(notes, unit_id):
        raise KeyError(unit_id)
    return unit


def unit_view(study_root, unit_id):
    notes = _notes(study_root)
    with _rules(study_root) as groups:
        unit = _prepared_unit(groups, notes, unit_id)
        material = groups.unit_material(notes, unit_id)
        submission = _submission(groups, notes, unit_id) or {}
        view = {
            'unit': {'id': unit.id, 'title': unit.title, 'kind': unit.kind, 'position': _position(groups, unit)},
            'session': {'started': bool(submission), 'submitted': _finished(submission),
                        'submitted_at': submission.get('submitted_at')},
            # `card` lets each form in the overview jump to its card's connection image.
            'recall': {'items': [{'form': item['form'], 'usage': item['usage'], 'card': item['card']}
                                 for item in material['recall_items']]},
        }
        if 'overview_note' in material:
            view['overview_note'] = material['overview_note']
        if 'compare' in material:
            view['compare'] = material['compare']
        if not submission:
            return view
        key = _answer_key(study_root, material['paper']) if _finished(submission) else None
        # Units prepared from 2026-10-21 on have no sentence prompt; older ones keep theirs.
        sentence = {}
        if 'sentence' in material:
            written = submission.get('sentence') if isinstance(submission.get('sentence'), dict) else {}
            sentence = {'sentence': {'card': material['sentence']['card'], 'prompt': material['sentence']['prompt'],
                                     'text': written.get('text')}}
        return {**view,
                'forgets': _forget_counts(_forget_log(notes), unit_id),
                **({'key': key} if key is not None else {}),
                'page': _rewrite(_body(notes, f'groups/{unit_id}.md'), 'groups'),
                'cards': [_card(notes, card) for card in unit.members],
                'paper': _paper(study_root, material['paper']),
                **sentence,
                'note': submission.get('note')}


def review_view(study_root, review_id):
    notes = _notes(study_root)
    with _rules(study_root) as groups:
        try:
            material = groups.review_material(notes, review_id)
        except KeyError:
            raise Forbidden(f'{review_id} 复习卷尚未准备') from None
        submission = _submission(groups, notes, review_id)
        if not _finished(submission) and not groups.can_answer(notes, review_id):
            raise Forbidden(f'{review_id} 未到期或复习卷尚未准备')
        finished = _finished(submission)
        return {'review': {'id': review_id, 'covers': material['covers']},
                'session': {'submitted': finished,
                            'submitted_at': submission.get('submitted_at') if submission else None},
                'paper': _paper(study_root, material['paper']),
                **({'key': _answer_key(study_root, material['paper'])} if finished else {})}


def recall(study_root, unit_id):
    """Leave the usage overview (用法总览) and start the unit; nothing about the overview is recorded."""
    with _write_lock, _rules(study_root) as groups:
        groups.start_unit(_notes(study_root), unit_id)
    return unit_view(study_root, unit_id)


def forget(study_root, unit_id, form, now=None):
    """Record one 忘了 for a form of an entered unit's usage overview, with the cards behind that form."""
    notes = _notes(study_root)
    with _write_lock, _rules(study_root) as groups:
        _prepared_unit(groups, notes, unit_id)
        if not _submission(groups, notes, unit_id):
            raise Forbidden('先进入对比页，再标记忘了')
        items = groups.unit_material(notes, unit_id)['recall_items']
        cards = list(dict.fromkeys(item['card'] for item in items if item['form'] == form))
        if not isinstance(form, str) or not cards:
            raise ValueError('用法总览里没有这个语法形式')
        events = _forget_log(notes)
        event = {'id': uuid.uuid4().hex, 'unit': unit_id, 'form': form, 'cards': cards,
                 'at': (now or datetime.now(TZ)).isoformat(timespec='seconds')}
        _save_forget_log(notes, [*events, event])
        return _with_records_error({'event': event['id'], 'count': _forget_counts([*events, event], unit_id)[form]},
                                   _rewrite_records(study_root))


def undo_forget(study_root, unit_id, event_id, now=None):
    """Drop one 忘了 tapped by mistake; only a record from the last two minutes can be taken back."""
    notes = _notes(study_root)
    with _write_lock:
        events = _forget_log(notes)
        event = next((event for event in events if event.get('id') == event_id and event.get('unit') == unit_id), None)
        if event is None:
            raise KeyError(event_id)
        if (now or datetime.now(TZ)) - datetime.fromisoformat(event['at']) > FORGET_UNDO:
            raise Conflict('已超过两分钟，不能撤销这次忘了')
        events.remove(event)
        _save_forget_log(notes, events)
        return _with_records_error({'count': _forget_counts(events, unit_id).get(event['form'], 0)},
                                   _rewrite_records(study_root))


def _forget_log(notes):
    path = notes / FORGETS
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as error:
        raise StudyDataError(f'忘了记录无法读取：{path}（{error}）') from error
    events = data.get('events') if isinstance(data, dict) else None
    if not isinstance(events, list) or not all(isinstance(event, dict) for event in events):
        raise StudyDataError(f'忘了记录格式错误：{path}')
    return events


def _save_forget_log(notes, events):
    data = {'schema_version': 1, 'events': events}
    atomic_write(notes / FORGETS, (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode())


def _forget_counts(events, unit_id):
    return dict(Counter(event.get('form') for event in events if event.get('unit') == unit_id))


def submit_unit(study_root, unit_id, answers, sentence, note):
    """交卷 a unit, then rebuild the review records: a newly learned unit joins them."""
    notes = _notes(study_root)
    with _write_lock, _rules(study_root) as groups:
        _ensure_answerable(groups, notes, unit_id, '尚未进入对比页')
        papers.write_plan_answers(study_root, groups.unit_material(notes, unit_id)['paper'], answers)
        groups.submit_unit(notes, unit_id, sentence, note)
        error = _rewrite_records(study_root)
        return _with_records_error(groups.plan_state(notes), error)


def submit_review(study_root, review_id, answers):
    notes = _notes(study_root)
    with _write_lock, _rules(study_root) as groups:
        _ensure_answerable(groups, notes, review_id, '未到期或复习卷尚未准备')
        papers.write_plan_answers(study_root, groups.review_material(notes, review_id)['paper'], answers)
        groups.submit_review(notes, review_id)
        return groups.plan_state(notes)


def asset(study_root, path):
    """An image below `jlpt-notes/assets/`, read live from the study repository."""
    if not isinstance(path, str) or not path.startswith('assets/'):
        raise ValueError('只允许读取 assets/ 下的图片')
    mime = IMAGES.get(PurePosixPath(path).suffix.lower())
    if mime is None:
        raise ValueError('只允许读取图片')
    return safe_file(_notes(study_root), path).read_bytes(), mime


def _ensure_answerable(groups, notes, item_id, refusal):
    if not groups.can_answer(notes, item_id):
        if _finished(_submission(groups, notes, item_id)):
            raise Conflict(f'{item_id} 已交卷')
        raise Forbidden(f'{item_id} {refusal}')


def _position(groups, unit):
    if unit.kind == 'system':
        return [groups.SYSTEM_SECTION_TITLE, f'{unit.system} {unit.system_title}', f'{unit.id} {unit.title}']
    return [unit.top, unit.mid, f'{unit.id} {unit.title}']


def _finished(submission):
    return bool(submission) and submission.get('submitted_at') is not None


def _submission(groups, notes, item_id):
    """This round's submission file for a unit or review; `None` before it exists."""
    path = groups.submission_path(notes, groups.read_round(notes), item_id)
    relative = path.relative_to(notes).as_posix()
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        raise StudyDataError(f'资料格式错误：{relative}：{error}') from error
    if not isinstance(data, dict):
        raise StudyDataError(f'资料格式错误：{relative}：顶层必须是 JSON 对象')
    return data


def _answer_key(study_root, slug):
    """Correct option and explanation per question from the paper's answer file; only handed out after 交卷."""
    relative = f'{papers.QUIZZES}/answers/{slug}-answers.md'
    try:
        text = safe_file(study_root, relative).read_text(encoding='utf-8')
    except (ValueError, OSError):
        return []
    marks = list(ANSWER_SECTION.finditer(text))
    key = []
    for index, mark in enumerate(marks):
        section = text[mark.end():marks[index + 1].start() if index + 1 < len(marks) else len(text)]
        correct = ANSWER_CORRECT.search(section)
        explanation = '\n'.join(line for line in section.splitlines() if not ANSWER_SKIP.match(line)).strip()
        key.append({'number': int(mark[1]), 'order': _answer_order(section),
                    'correct': correct[1] if correct else None,
                    'correct_text': correct[2] if correct else None,
                    'explanation': _rewrite(explanation, 'quizzes/answers')})
    return key


def _answer_order(section):
    """Option numbers of a sorting question in the recommended order, e.g. '3124'; `None` for other questions."""
    field = ANSWER_ORDER_FIELD.search(section)
    if field:
        return field[1]
    text = ANSWER_ORDER_TEXT.search(section)
    digits = re.findall(r'\(([1-4])\)', text[1]) if text else []
    return ''.join(digits) if len(digits) == 4 and len(set(digits)) == 4 else None


def _paper(study_root, slug):
    paper = papers.read_plan_paper(study_root, slug)
    return {key: paper[key] for key in ('slug', 'text', 'numbers', 'answers')}


def _document(notes, relative):
    try:
        text = safe_file(notes, relative).read_text(encoding='utf-8')
    except (ValueError, OSError) as error:
        raise StudyDataError(f'资料格式错误：{relative}：无法读取（{error}）') from error
    match = FRONTMATTER.match(text)
    if not match:
        return {}, text
    try:
        metadata = json.loads(match[1])
    except ValueError as error:
        raise StudyDataError(f'资料格式错误：{relative}：前置元数据不是 JSON（{error}）') from error
    return metadata if isinstance(metadata, dict) else {}, text[match.end():].lstrip('\r\n')


def _body(notes, relative):
    return _document(notes, relative)[1]


def _card(notes, card_id):
    folder = f'grammar/{card_id[:2].lower()}'
    metadata, body = _document(notes, f'{folder}/{card_id}.md')
    title = metadata.get('title')
    return {'id': card_id, 'title': title if isinstance(title, str) else card_id,
            'core': _rewrite(extract_core(body), folder)}


def _rewrite(markdown, folder):
    """Serve images through the asset endpoint and point member-card links at their sections.

    Targets are relative to `folder` (below `jlpt-notes`). Other relative links keep only their text.
    """
    def replace(match):
        image, text, target = match.groups()
        if re.match(r'[a-z][a-z0-9+.-]*:|#', target, re.I):
            return match[0]
        resolved = _resolve(folder, target)
        if image:
            if resolved and resolved.startswith('assets/') and PurePosixPath(resolved).suffix.lower() in IMAGES:
                return f'![{text}](/api/review/asset?path={quote(resolved)})'
            return text
        card = CARD_PAGE.fullmatch(resolved or '')
        return f'[{text}](#card-{card[1]})' if card else text

    return LINK.sub(replace, markdown)


def _resolve(folder, target):
    path = unquote(target.split('#', 1)[0].split('?', 1)[0])
    if not path or path.startswith('/'):
        return None
    parts = []
    for part in PurePosixPath(folder, path).parts:
        if part == '..':
            if not parts:
                return None
            parts.pop()
        elif part != '.':
            parts.append(part)
    return '/'.join(parts)
