"""Keep the OpenAI key in memory for a loopback-only synthetic dashboard session."""
import getpass
import os
from pathlib import Path
import subprocess
import sys
import warnings

if not sys.stdin.isatty():
    raise SystemExit('Run directly in Terminal for hidden key entry.')
warnings.simplefilter('error', getpass.GetPassWarning)
key = getpass.getpass('Restricted PeekaPlate OpenAI key (hidden): ').strip()
if not key.startswith('sk-') or len(key) < 30 or any(c.isspace() for c in key):
    raise SystemExit('Invalid key format. Nothing started.')
project = input('OpenAI project ID (not a secret): ').strip()
if not project.startswith('proj_') or not project[5:].isalnum():
    raise SystemExit('Invalid project ID. Nothing started.')
env = os.environ.copy()
env['OWNER_AI_OPENAI_API_KEY'] = key
env['OWNER_AI_OPENAI_PROJECT_ID'] = project
env.pop('OWNER_AI_LOCAL_MOCK', None)
root = Path(__file__).resolve().parent.parent
exit_code = 0
try:
    result = subprocess.run(['node', '--import', './scripts/node-ts-hooks.mjs',
                    'backend/scripts/owner-ai-local.ts'], cwd=root, env=env, check=False)
    exit_code = result.returncode if result.returncode >= 0 else 1
except OSError:
    print('Dashboard could not start. Check Node and local dependencies.', file=sys.stderr)
    exit_code = 1
except KeyboardInterrupt:
    pass
finally:
    env.pop('OWNER_AI_OPENAI_API_KEY', None)
    key = ''

sys.exit(exit_code)
