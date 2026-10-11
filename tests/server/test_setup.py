import json
import os
import subprocess
import tempfile
import unittest
import sys
from pathlib import Path
from unittest.mock import patch
from scripts.setup_study import materialize_images, prepare


class SetupTests(unittest.TestCase):
    def test_prepare_refuses_to_replace_an_unmigrated_legacy_installation(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)/'service'
            (base/'repos/jlpt-study').mkdir(parents=True)
            projects = Path(tmp)/'projects'
            with patch('scripts.setup_study.subprocess.run', side_effect=AssertionError('不得克隆新仓库')), self.assertRaisesRegex(ValueError, '迁移'):
                prepare(base, 'a'*40, projects)
            self.assertFalse((projects/'jlpt-study').exists())

    def test_prepare_uses_projects_directory_and_preserves_existing_learning_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)/'service'
            projects = Path(tmp)/'projects'
            repo = projects/'jlpt-study'; repo.mkdir(parents=True)
            def git(*args): return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
            git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
            (repo/'README.md').write_text('learning repo')
            git('add', '.'); git('commit', '-m', 'base'); git('remote', 'add', 'origin', 'https://example.com/study.git')
            revision = git('rev-parse', 'HEAD')
            actual_repo, worktree = prepare(base, revision, projects)
            self.assertEqual(actual_repo, repo)
            self.assertEqual(worktree, repo/'.worktrees/web-study')
            self.assertEqual(git('status', '--porcelain'), '')
            notes = worktree/'notes.txt'; notes.write_text('unfinished learning')
            self.assertEqual(prepare(base, revision, projects), (repo, worktree))
            self.assertEqual(notes.read_text(), 'unfinished learning')
            self.assertEqual(git('remote', 'get-url', '--push', 'origin'), str(base/'push-disabled'))

    def test_configure_server_updates_study_location_and_preserves_authentication(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)/'service'; state = base/'state'; state.mkdir(parents=True)
            projects = Path(tmp)/'projects'
            config_path = state/'config.json'
            config_path.write_text(json.dumps({'password_hash':'existing-hash', 'study':'old-directory'}))
            result = subprocess.run([sys.executable, 'scripts/configure_server.py', '--base', str(base),
                                     '--projects', str(projects), '--origin', 'https://example.com'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            config = json.loads(config_path.read_text())
            self.assertEqual(config['study'], str(projects/'jlpt-study/.worktrees/web-study'))
            self.assertEqual(config['password_hash'], 'existing-hash')
            self.assertFalse((state/'website-password').exists())

    def test_materializes_only_pinned_catalog_images_despite_dirty_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'repo'; root.mkdir()
            def git(*args): return subprocess.check_output(['git','-C',str(root),*args], text=True).strip()
            git('init','-b','main'); git('config','user.email','test@example.com'); git('config','user.name','Test')
            image=root/'jlpt-notes/assets/grammar/n3/card.png'; image.parent.mkdir(parents=True); image.write_bytes(b'original image')
            git('add','.'); git('commit','-m','base'); revision=git('rev-parse','HEAD')
            image.write_bytes(b'dirty image')
            catalog={'revision':revision,'cards':[{'images':{'connection':f'./images/{revision}/assets/grammar/n3/card.png','example':None}}]}
            output=Path(tmp)/'static'
            materialize_images(root,catalog,output)
            destination=output/'grammar/images'/revision/'assets/grammar/n3/card.png'
            self.assertEqual(destination.read_bytes(), b'original image')
            rollback=Path(tmp)/'rollback.png'; os.link(destination,rollback)
            inode=destination.stat().st_ino
            materialize_images(root,catalog,output)
            self.assertEqual(destination.stat().st_ino,inode)
            with patch('tarfile.ExFileObject.read',side_effect=OSError('interrupted image export')):
                with self.assertRaises(OSError): materialize_images(root,catalog,output)
            self.assertEqual(destination.read_bytes(),b'original image')
            self.assertEqual(rollback.read_bytes(),b'original image')
            destination.write_bytes(b'previous image')
            materialize_images(root,catalog,output)
            self.assertEqual(destination.read_bytes(),b'original image')
            self.assertEqual(rollback.read_bytes(),b'previous image')
            self.assertNotEqual(destination.stat().st_ino,rollback.stat().st_ino)
            catalog['cards'][0]['images']['connection']=f'./images/{revision}/../bad'
            with self.assertRaises(ValueError): materialize_images(root,catalog,output)
