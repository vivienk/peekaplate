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
    parser.add_argument('--review-dir', type=Path, help='Optional registered Tripo review source; photo upload needs no key.')
    parser.add_argument('--state-dir', required=True, type=Path)
    parser.add_argument('--port', type=int, default=5173)
    parser.add_argument('--api-port', type=int, default=5182)
    args = parser.parse_args(argv)
    if args.port == args.api_port or not all(1024 <= value <= 65535 for value in (args.port, args.api_port)):
        parser.error('Choose distinct unprivileged local ports.')
    repo = Path(__file__).resolve().parents[3]
    if args.review_dir:
        record = json.loads(read(args.review_dir / 'review-manifest.json', MAX_JSON_BYTES))
        if record.get('asset_id') != ASSET:
            parser.error('Use the registered current portion-demo review asset.')
    # Fail before starting anything rather than stopping another development server.
    for port in (args.port, args.api_port):
        with socket.socket() as check:
            try:
                check.bind(('127.0.0.1', port))
            except OSError:
                parser.error(f'Local port {port} is already in use; stop that server first.')
    root = args.state_dir.resolve()
    destination = root / TENANT / 'reviews' / ASSET
    if args.review_dir and destination.exists():
        if read(destination / 'review-manifest.json', MAX_JSON_BYTES) != read(args.review_dir / 'review-manifest.json', MAX_JSON_BYTES):
            parser.error('Registered source differs; choose another state directory.')
    elif args.review_dir:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(args.review_dir, destination, symlinks=True)
    token = secrets.token_urlsafe(48)
    api_env = {**os.environ, 'TRIPO_SERVICE_TOKEN': token, 'TRIPO_TENANT_ID': TENANT,
               'TRIPO_REVIEW_ROOT': str(root), 'PYTHONPATH': str(repo / 'processing/src')}
    diner_env = {key: value for key, value in os.environ.items() if key != 'TRIPO_API_KEY'}
    diner_env['TRIPO_SERVICE_TOKEN'] = token
    diner_env['PORTION_DEMO_PORT'] = str(args.port)
    diner_env['PORTION_API_PORT'] = str(args.api_port)
    children = []
    try:
        children.append(subprocess.Popen([sys.executable, '-m', 'uvicorn',
            'peekaplate_processing.model_service:create_app', '--factory',
            '--host', '127.0.0.1', '--port', str(args.api_port)], cwd=repo, env=api_env, start_new_session=True))
        children.append(subprocess.Popen(['pnpm', '--filter', '@peekaplate/diner', 'exec', 'vite', '--host', '127.0.0.1', '--port', str(args.port), '--strictPort'], cwd=repo, env=diner_env, start_new_session=True))
        print(f'Open http://127.0.0.1:{args.port}/ → a menu dish → Try your dish photo → automatic View Portion.', flush=True)
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
