#!/usr/bin/env python3
"""Package both deployment targets from one immutable Git commit (never live data)."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def package(ref, output):
    revision = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', f'{ref}^{{commit}}'], text=True).strip()
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Expected full commit SHA')
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    metadata = {'schemaVersion': 1, 'revision': revision}
    with tempfile.TemporaryDirectory(prefix='yt-release-') as scratch:
        staging = Path(scratch)
        archive = subprocess.check_output(['git', '-C', str(ROOT), 'archive', revision, 'webapp', 'ha-addon'])
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            # git archive comes from the trusted repository, without runtime state.
            source.extractall(staging, filter='data')
        (staging / 'webapp/release.json').write_text(json.dumps(metadata) + '\n')
        addon = staging / 'ha-addon'
        (addon / 'release.json').write_text(json.dumps(metadata) + '\n')
        for name in ['Dockerfile', 'build.yaml']:
            target = addon / name
            content = target.read_text()
            if name == 'Dockerfile':
                content, count = re.subn(r'(?m)^ARG APP_REF=[0-9a-f]{40}$', f'ARG APP_REF={revision}', content)
            else:
                content, count = re.subn(r'(?m)^(\s+APP_REF:) "[0-9a-f]{40}"$', rf'\1 "{revision}"', content)
            if count != 1:
                raise ValueError(f'Missing or ambiguous source pin in {name}')
            target.write_text(content)
        config = addon / 'config.yaml'
        content, count = re.subn(r'(?m)^version: "[^"]+"$', f'version: "2.1.0-pipeline-{revision[:12]}"', config.read_text())
        if count != 1:
            raise ValueError('Missing add-on version')
        config.write_text(content)
        assets = []
        for platform, folder in [('mac', 'webapp'), ('ha', 'ha-addon')]:
            name = f'yt-streamer-{platform}-{revision}.tar.gz'
            target = output / name
            with tarfile.open(target, 'w:gz') as bundle:
                bundle.add(staging / folder, arcname=folder)
            assets.append({'file': name, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
        manifest = {**metadata, 'assets': assets}
        (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (output / 'SHA256SUMS').write_text(''.join(f"{asset['sha256']}  {asset['file']}\n" for asset in assets))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ref', default='HEAD')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    print(json.dumps(package(args.ref, args.output)))
