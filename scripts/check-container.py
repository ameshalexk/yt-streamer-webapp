#!/usr/bin/env python3
"""Test a release image with disposable persistent storage; never production data."""
import argparse
import json
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def wait_health(port, revision):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=3) as response:
                health = json.load(response)
            if not health.get('ok'):
                raise AssertionError('Unhealthy container')
            assert health['release'] == {'revision': revision, 'platform': 'linux'}, health
            return
        except (OSError, TimeoutError):
            time.sleep(0.25)
    raise RuntimeError('Container did not become healthy')


def check(image, revision):
    name = 'yt-ci-' + uuid.uuid4().hex
    volume = name + '-data'
    docker('volume', 'create', volume)
    try:
        docker('run', '-d', '--name', name, '-p', '127.0.0.1::8099', '-v', f'{volume}:/data', image)
        port = docker('port', name, '8099/tcp').rsplit(':', 1)[1]
        wait_health(port, revision)
        # Verify the effective platform paths, resolved tools, and exact stored revision.
        docker('exec', name, 'node', '--input-type=module', '-e', '''
import assert from 'node:assert/strict';
import {config} from '/app/src/config.js';
assert.equal(config.libraryDir, '/data/library');
assert.equal(config.apneICloudDir, '/data/apne-exports');
assert.equal(config.desktop.enabled, false);
assert.equal(config.desktop.inputEnabled, false);
''')
        docker('exec', name, 'yt-dlp', '--version')
        docker('exec', name, 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=6', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', '/data/library/ci-fixture.mp4')
        docker('exec', name, 'node', '-e', "require('fs').writeFileSync('/data/ci-persistence.txt','retained')")
        before = docker('exec', name, 'sha256sum', '/data/library/ci-fixture.mp4', '/data/ci-persistence.txt')
        # Recreate the container, reusing only its named data volume.
        docker('rm', '-f', name)
        docker('run', '-d', '--name', name, '-p', '127.0.0.1::8099', '-v', f'{volume}:/data', image)
        port = docker('port', name, '8099/tcp').rsplit(':', 1)[1]
        wait_health(port, revision)
        after = docker('exec', name, 'sha256sum', '/data/library/ci-fixture.mp4', '/data/ci-persistence.txt')
        assert before == after, 'Persistent files changed across container replacement'
        print(f'{image}: revision, Linux paths, FFmpeg fixture and persistence passed')
    except Exception:
        subprocess.run(['docker', 'logs', '--tail', '80', name], check=False)
        raise
    finally:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, check=False)
        subprocess.run(['docker', 'volume', 'rm', volume], stdout=subprocess.DEVNULL, check=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    check(args.image, json.loads(args.manifest.read_text())['revision'])
