import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from scripts.setup_study import materialize_images


class SetupTests(unittest.TestCase):
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
            self.assertEqual((output/'grammar/images'/revision/'assets/grammar/n3/card.png').read_bytes(), b'original image')
            materialize_images(root,catalog,output)
            catalog['cards'][0]['images']['connection']=f'./images/{revision}/../bad'
            with self.assertRaises(ValueError): materialize_images(root,catalog,output)
