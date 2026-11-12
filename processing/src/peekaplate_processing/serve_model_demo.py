"""Start the loopback-only diner and private model API with an ephemeral bridge token."""
import argparse
import json
import os
import secrets
import signal
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

from peekaplate_processing.generate_model import MAX_JSON_BYTES, read

TENANT = '11111111-1111-4111-8111-111111111111'
ASSET = 'review_b2f135ce8784a517ca9cf1f3fbc8fcbf'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--review-dir', required=True, type=Path)
    parser.add_argument('--state-dir', required=True, type=Path)
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[3]
    record = json.loads(read(args.review_dir / 'review-manifest.json', MAX_JSON_BYTES))
    if record.get('asset_id') != ASSET:
        parser.error('Use the registered current portion-demo review asset.')
    # Fail before starting anything rather than stopping another development server.
    for port in (5173, 5182):
        with socket.socket() as check:
            try:
                check.bind(('127.0.0.1', port))
            except OSError:
                parser.error(f'Local port {port} is already in use; stop that server first.')
    root = args.state_dir.resolve()
    destination = root / TENANT / 'reviews' / ASSET
    if destination.exists():
        if read(destination / 'review-manifest.json', MAX_JSON_BYTES) != read(args.review_dir / 'review-manifest.json', MAX_JSON_BYTES):
            parser.error('Registered source differs; choose another state directory.')
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(args.review_dir, destination, symlinks=True)
    token = secrets.token_urlsafe(48)
    api_env = {**os.environ, 'TRIPO_SERVICE_TOKEN': token, 'TRIPO_TENANT_ID': TENANT,
               'TRIPO_REVIEW_ROOT': str(root), 'PYTHONPATH': str(repo / 'processing/src')}
    diner_env = {key: value for key, value in os.environ.items() if key != 'TRIPO_API_KEY'}
    diner_env['TRIPO_SERVICE_TOKEN'] = token
    children = []
    try:
        children.append(subprocess.Popen([sys.executable, '-m', 'uvicorn',
            'peekaplate_processing.model_service:create_app', '--factory',
            '--host', '127.0.0.1', '--port', '5182'], cwd=repo, env=api_env, start_new_session=True))
        children.append(subprocess.Popen(['pnpm', '--filter', '@peekaplate/diner', 'dev'], cwd=repo, env=diner_env, start_new_session=True))
        print('Open http://127.0.0.1:5173/?scenario=portion-demo → View Portion → Preview controls.', flush=True)
        if not os.getenv('TRIPO_API_KEY'):
            print('No Tripo key configured: generation stays unavailable; 2.5D remains usable.', flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(0.5)
        return 1
    except KeyboardInterrupt:
        return 0
    finally:
        for child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


if __name__ == '__main__':
    raise SystemExit(main())
