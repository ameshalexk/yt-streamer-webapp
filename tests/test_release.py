import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_release', ROOT / 'scripts/package-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_both_artifacts_are_bound_to_commit_and_exclude_working_state(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            repo = root / 'repo'
            repo.mkdir()
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            (repo / 'webapp').mkdir()
            (repo / 'webapp/source.js').write_text('committed source')
            (repo / 'ha-addon').mkdir()
            for file in ['Dockerfile', 'build.yaml', 'config.yaml']:
                (repo / 'ha-addon' / file).write_bytes((ROOT / 'ha-addon' / file).read_bytes())
            subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Release Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture'], check=True)
            (repo / 'webapp/source.js').write_text('uncommitted change')
            (repo / 'webapp/data').mkdir()
            (repo / 'webapp/data/private').write_text('must never be packaged')
            with patch.object(release, 'ROOT', repo):
                manifest = release.package('HEAD', root / 'dist')
            revision = manifest['revision']
            self.assertRegex(revision, r'^[a-f0-9]{40}$')
            for asset in manifest['assets']:
                archive = root / 'dist' / asset['file']
                self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), asset['sha256'])
                with tarfile.open(archive) as bundle:
                    names = bundle.getnames()
                    self.assertFalse(any('/data/' in name for name in names))
                    folder = 'webapp' if '-mac-' in asset['file'] else 'ha-addon'
                    metadata = json.load(bundle.extractfile(folder + '/release.json'))
                    self.assertEqual(metadata['revision'], revision)
                    if folder == 'webapp':
                        self.assertEqual(bundle.extractfile('webapp/source.js').read(), b'committed source')
                    else:
                        self.assertIn(f'ARG APP_REF={revision}', bundle.extractfile('ha-addon/Dockerfile').read().decode())
                        self.assertIn(f'APP_REF: "{revision}"', bundle.extractfile('ha-addon/build.yaml').read().decode())
                        self.assertIn(revision[:12], bundle.extractfile('ha-addon/config.yaml').read().decode())
            self.assertEqual(json.loads((root / 'dist/manifest.json').read_text()), manifest)

    def test_bad_ref_never_produces_artifacts(self):
        with tempfile.TemporaryDirectory() as scratch:
            with self.assertRaises(subprocess.CalledProcessError):
                release.package('definitely-not-a-real-ref', Path(scratch) / 'dist')
            self.assertFalse((Path(scratch) / 'dist').exists())


if __name__ == '__main__':
    unittest.main()
