import json
import os
import subprocess
import unittest
from pathlib import Path

from scripts.update_catalog_core import extract_core


class CatalogCoreTests(unittest.TestCase):
    def test_core_keeps_nested_sections_and_stops_at_the_next_peer_heading(self):
        core = '含义。\n\n## 功能一\n\n完整例句。\n\n### 补充\n\n最后一行。'
        self.assertEqual(extract_core('# 视频\n\n# 核心\n\n' + core + '\n\n# 来源\n\n链接'), core)

    def test_core_variants_are_complete_without_duplicate_nested_sections(self):
        text = '# 卡片\n\n## 核心用法\n\n内容一\n\n### 核心补充\n\n内容二\n\n## 来源\n链接'
        self.assertEqual(extract_core(text), '## 核心用法\n\n内容一\n\n### 核心补充\n\n内容二')
        self.assertEqual(extract_core('# 卡片\n\n## 来源\n链接'), '')

    def test_code_fences_do_not_end_the_core_section(self):
        core = '例子\n\n```text\n# 这是代码\n```\n\n最后一行'
        self.assertEqual(extract_core('# 核心\n\n' + core + '\n\n# 来源\n链接'), core)

    def test_legacy_peer_level_function_headings_belong_to_the_core(self):
        core = '## 功能一：含义一\n\n解释一\n\n### 例句\n\n例句一\n\n## 功能二：含义二\n\n最后一行'
        self.assertEqual(extract_core('# 卡片\n\n## 核心\n\n' + core + '\n\n## 来源\n链接'), core)

    def test_catalog_core_matches_every_pinned_source_card(self):
        catalog = json.loads(Path('data/catalog.json').read_text())
        repo = Path(os.environ.get('JLPT_STUDY_ROOT', Path.home()/'projects/jlpt-study'))
        if not repo.is_dir():
            self.skipTest('Pinned study repository is unavailable')
        for card in catalog['cards']:
            source = f"jlpt-notes/grammar/{card['level'].lower()}/{card['id']}.md"
            body = subprocess.check_output(['git', '-C', str(repo), 'show', f"{catalog['revision']}:{source}"], text=True)
            self.assertEqual(card['core'], extract_core(body), card['id'])
