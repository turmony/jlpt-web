"""A throwaway study repository for the /review/ tests.

It carries the real rule module (`src/jlpt_notes/groups.py`) copied from the
study repository, a committed mapping with system units B-01-1…, two grammar
cards with connection images, and the uncommitted materials of unit B-01-1.
"""
import json
import os
import shutil
import struct
import subprocess
import unittest
import zlib
from pathlib import Path

STUDY_ROOT = Path(os.environ.get('JLPT_STUDY_ROOT', '/root/projects/jlpt-study'))
GROUPS = Path('src/jlpt_notes/groups.py')
TOPS = ('ものごとの様子', 'ものごとの関係', 'もの・こと', '人との関係', '場所・時間', '考え・感情')
CARDS = {'N5-G-0013': '助词：动作进行时点「に」', 'N5-G-0032': '助词：动作对象「に」'}
CORES = {'N5-G-0013': '时间词＋に，表示动作发生的时间点。', 'N5-G-0032': '「に」标出动作指向的对象。'}
SENTENCE_PROMPT = '用本单元的语法翻译：三点见面吧。'
RECALL_ITEMS = [{'card': 'N5-G-0013', 'form': 'に', 'usage': '时间点'},
                {'card': 'N5-G-0032', 'form': 'へ', 'usage': '动作的方向'}]

UNIT_PAGE = '''# B-01-1 に

## 成员接续图

### [N5-G-0013 助词：动作进行时点「に」](../grammar/n5/N5-G-0013.md)

![时点に接续图](../assets/grammar/n5/N5-G-0013-connection.png)

### [N5-G-0032 助词：动作对象「に」](../grammar/n5/N5-G-0032.md#核心)

![对象に接续图](../assets/grammar/n5/N5-G-0032-connection.png)
'''

QUESTIONS = (('毎朝七時（　）起きます。', 'で', 'に', 'を', 'が'),
             ('友だち（　）手紙を書きました。', 'に', 'で', 'を', 'の'),
             ('日曜日（　）デパートへ行きます。', 'が', 'に', 'を', 'で'),
             ('先生（　）質問しました。', 'を', 'で', 'に', 'と'),
             ('三時（　）会いましょう。', 'の', 'を', 'で', 'に'))


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def write_markdown(path, metadata, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('---\n' + json.dumps(metadata, ensure_ascii=False, indent=2) + '\n---\n\n' + body, encoding='utf-8')


def png(width=8, height=8):
    """A small, decodable grey PNG."""
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    rows = b''.join(b'\x00' + b'\x80' * width for _ in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def paper_slug(item_id):
    return f'2026-10-17-{item_id.lower()}'


def mapping(units):
    return {
        'schema_version': 1,
        'source': 'https://hagoromo-text.work/',
        'attribution': '分类来源：機能語用例文データベース「はごろも」，仅用于个人学习；未收录其释义与例句。',
        'categories': [{'top': top, 'mids': ['不明確']} for top in TOPS],
        'batches': ['B'],
        'systems': {'B-01': {'title': '助词用法地图', 'order': 1}},
        'units': {f'B-01-{index}': {'title': {1: 'に', 2: 'で・を'}.get(index, f'小节{index}'), 'order': index,
                                    'system': 'B-01'} for index in range(1, units + 1)},
        'cards': {card: {'paths': [{'role': 'primary', 'unit': 'B-01-1', 'sense': sense}]}
                  for card, sense in (('N5-G-0013', '时点に'), ('N5-G-0032', '对象に'))},
    }


def write_paper(notes, slug, count):
    questions = ''.join(f'### {number}. {stem}\n\n' + ''.join(f'{index}. {option}\n' for index, option in enumerate(options, 1)) + '\n'
                        for number, (stem, *options) in enumerate((QUESTIONS * 3)[:count], 1))
    sheet = ', '.join(f'{number}-__' for number in range(1, count + 1))
    path = notes / 'quizzes/papers' / f'{slug}.md'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'# {slug} 练习（{count} 题）\n\n## 第一部分\n\n{questions}## 答案填写区\n\n```text\n{sheet}\n```\n',
                    encoding='utf-8')


def prepare_unit(notes, unit_id='B-01-1'):
    """Unit page, unit material and five-question paper, left uncommitted as the plan prepares them."""
    write_markdown(notes / 'groups' / f'{unit_id}.md',
                   {'id': unit_id, 'kind': 'grammar_system_unit', 'schema_version': 1, 'title': 'に', 'order': 1,
                    'members': [{'card': card, 'role': 'primary', 'sense': title} for card, title in CARDS.items()]},
                   UNIT_PAGE)
    write_json(notes / 'groups/units' / f'{unit_id}.json',
               {'schema_version': 1, 'unit_id': unit_id, 'paper': paper_slug(unit_id),
                'recall_items': RECALL_ITEMS,
                'sentence': {'card': 'N5-G-0013', 'prompt': SENTENCE_PROMPT}})
    write_paper(notes, paper_slug(unit_id), 5)


def finish_unit(notes, unit_id, minute):
    """A unit submission as the server leaves it after 交卷."""
    write_json(notes / 'groups/submissions/r1' / f'{unit_id}.json',
               {'schema_version': 1, 'unit_id': unit_id, 'round': 1, 'paper': paper_slug(unit_id),
                'recall': {'marks': [{'card': item['card'], 'item': index, 'recalled': True}
                                     for index, item in enumerate(RECALL_ITEMS)],
                           'locked_at': '2026-10-17T20:00:00+08:00'},
                'sentence': {'card': 'N5-G-0013', 'text': '三時に会いましょう。'}, 'note': '',
                'submitted_at': f'2026-10-17T20:{minute:02d}:00+08:00'})


def prepare_review(notes, review_id, covers):
    write_json(notes / 'groups/reviews' / f'{review_id}.json',
               {'schema_version': 1, 'review_id': review_id, 'round': 1, 'covers': list(covers),
                'paper': paper_slug(review_id)})
    write_paper(notes, paper_slug(review_id), 12)


def make_study(tmp, units=2):
    source = STUDY_ROOT / GROUPS
    if not source.is_file():
        raise unittest.SkipTest(f'Study rule module is unavailable: {source}')
    study = Path(tmp) / 'study'
    notes = study / 'jlpt-notes'
    (study / GROUPS).parent.mkdir(parents=True)
    shutil.copy2(source, study / GROUPS)
    git(study, 'init', '-q')
    git(study, 'config', 'user.name', 'Test')
    git(study, 'config', 'user.email', 'test@example.invalid')
    git(study, 'config', 'commit.gpgsign', 'false')
    write_json(notes / 'groups/mapping.json', mapping(units))
    for card, title in CARDS.items():
        write_markdown(notes / 'grammar/n5' / f'{card}.md',
                       {'id': card, 'kind': 'grammar', 'level': 'N5', 'title': title, 'card_revision': 1,
                        'schema_version': 1, 'source': {'screenshot': f'assets/grammar/n5/{card}-connection.png'},
                        'tags': [], 'confusions': []},
                       f'# {title}\n\n# 核心\n\n{CORES[card]}\n\n# 来源\n\n[视频](https://example.invalid/{card})\n')
        image = notes / 'assets/grammar/n5' / f'{card}-connection.png'
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(png())
    git(study, 'add', '-A')
    git(study, 'commit', '-q', '-m', 'mapping and cards')
    prepare_unit(notes)
    return study
