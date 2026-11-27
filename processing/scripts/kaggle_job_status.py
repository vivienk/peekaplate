"""Report one compact status line per private Kaggle kernel, read-only.

The automated check that watches the three private dish-3D kernels needs one call instead of
five hand-run commands, and it must not confuse Kaggle's deliberately empty logs for `QUEUED`
and cancelled versions with a code failure. This tool therefore separates two facts:

* the worker status, parsed from the `KernelWorkerStatus.*` string and mapped onto the six
  stable classifications `COMPLETE`, `RUNNING`, `QUEUED`, `CANCELLED`, `ERROR`, `UNKNOWN`;
* the log, reported as `log=empty`, `log=present` or `log=not_fetched`. An empty log is never
  reported as a failure cause: only Kaggle's own `ERROR` status classifies as `ERROR`.

Every fact comes from the Kaggle CLI binary (`kaggle kernels status|files|logs`, `kaggle quota`).
The CLI runs in its own venv, so the caller's `PYTHONPATH`/`PYTHONHOME`/`PYTHONSTARTUP` are
removed from its environment: the repo's offline harness puts `processing/tests` on
`PYTHONPATH`, and that `sitecustomize` socket guard would otherwise fail every call.
Nothing here reads, prints, echoes or logs the Kaggle token; text returned by the CLI is run
through :func:`redact_secrets` before it can reach stdout, stderr or the JSON report.

Version discovery: the CLI exposes no version field in `kernels list`, so the current version
number is found by probing `kernels status <ref>/<version>` (a gallop from 1, then a binary
search for the first missing version), assuming versions are numbered contiguously. That is
`O(log n)` CLI calls per kernel, all bounded by `--timeout`.

Exit codes: 0 when every kernel was queried (a FAILED job is still a successful report), 1 when
a query failed, 2 when the CLI binary is missing (its venv lives under the volatile `/tmp`).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SCHEMA_VERSION = 1

#: Kernel refs checked by default, in reporting order.
DEFAULT_KERNELS = (
    'yacine105/peekaplate-dish-3d-multi-model-benchmark-a',
    'yacine105/peekaplate-dish-3d-trellis2-hero-batch-b',
    'yacine105/trellislast-version',
)

DEFAULT_KAGGLE_BIN = '/tmp/dish-kaggle-cli/bin/kaggle'
RECREATE_COMMAND = 'python3 -m venv /tmp/dish-kaggle-cli && /tmp/dish-kaggle-cli/bin/pip install kaggle'

EXIT_OK = 0
EXIT_QUERY_FAILED = 1
EXIT_MISSING_KAGGLE = 2

#: `kaggle kernels files` pages; the CLI caps `--page-size` at 200.
PAGE_SIZE = 200
#: Longest log line printed verbatim; longer lines are cut with an explicit marker.
MAX_LOG_LINE_CHARS = 400

UNKNOWN = 'UNKNOWN'

#: `KernelWorkerStatus` enum suffix -> one of the six stable classifications.
STATUS_CLASSIFICATION = {
    'COMPLETE': 'COMPLETE',
    'RUNNING': 'RUNNING',
    'QUEUED': 'QUEUED',
    'CANCEL_REQUESTED': 'CANCELLED',
    'CANCEL_ACKNOWLEDGED': 'CANCELLED',
    'ERROR': 'ERROR',
}
#: Classifications whose version has finished, so its log can be read at all.
TERMINAL_CLASSIFICATIONS = frozenset({'COMPLETE', 'CANCELLED', 'ERROR'})

#: Environment variables whose values must never reach any output stream.
SECRET_ENV_KEYS = ('KAGGLE_KEY', 'KAGGLE_TOKEN', 'KAGGLE_API_TOKEN', 'KAGGLE_ACCESS_TOKEN')
#: Python import switches the CLI must not inherit from the caller. The repo's offline test
#: harness puts `processing/tests` on `PYTHONPATH`, where a `sitecustomize` module installs a
#: socket guard; inheriting that path makes every `kaggle` call die with a blocked connection
#: traceback instead of reaching the API. The CLI runs in its own venv, so these are dropped.
DROPPED_CLI_ENV_KEYS = ('PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP')
#: First line of a Python traceback; useless on its own, so the exception line is reported.
TRACEBACK_HEADER = 'Traceback (most recent call last):'
#: Marker the repo's offline harness prints when it blocks a socket.
SOCKET_GUARD_MARKER = 'Network disabled by offline socket guard'
_STATUS_RE = re.compile(r'has status "([^"]+)"')
_MISSING_RE = re.compile(r'resource was not found', re.IGNORECASE)
_PAGE_TOKEN_RE = re.compile(r'^Next Page Token\s*=\s*(\S+)\s*$')
_SEPARATOR_RUN = re.compile(r'\s{2,}')
_MIN_SECRET_LEN = 8
_MISSING_PLACEHOLDER = '<redacted>'


class QueryError(RuntimeError):
    """A single Kaggle CLI query did not produce the fact it was asked for."""


def secret_values(environ=None) -> tuple[str, ...]:
    """Return the token-like environment values that must never be printed."""
    env = os.environ if environ is None else environ
    values = set()
    for key in SECRET_ENV_KEYS:
        value = env.get(key)
        if isinstance(value, str) and len(value) >= _MIN_SECRET_LEN:
            values.add(value)
    # Longest first so a secret that contains another is redacted as a whole.
    return tuple(sorted(values, key=len, reverse=True))


def redact_secrets(text: str, secrets: tuple[str, ...] = ()) -> str:
    """Replace every known secret value in ``text`` so it can be shown or stored."""
    for secret in secrets:
        if secret and secret in text:
            text = text.replace(secret, _MISSING_PLACEHOLDER)
    return text


def classify(worker_status: str) -> str:
    """Map a `KernelWorkerStatus.*` string onto a stable classification."""
    if not isinstance(worker_status, str):
        return UNKNOWN
    suffix = worker_status.strip().rsplit('.', 1)[-1]
    return STATUS_CLASSIFICATION.get(suffix, UNKNOWN)


def worker_status_suffix(worker_status: str) -> str:
    """Return the bare enum suffix, e.g. `CANCEL_ACKNOWLEDGED`."""
    if not isinstance(worker_status, str) or not worker_status.strip():
        return UNKNOWN
    return worker_status.strip().rsplit('.', 1)[-1]


def parse_worker_status(text: str) -> str | None:
    """Extract the `KernelWorkerStatus.*` string from `kaggle kernels status` output."""
    match = _STATUS_RE.search(text or '')
    return match.group(1) if match else None


def is_missing_version(text: str) -> bool:
    """True when the CLI reported an unknown reference rather than a query failure."""
    return bool(_MISSING_RE.search(text or ''))


def cli_environment(environ=None) -> dict[str, str]:
    """Return the caller's environment without the Python switches that break the CLI.

    The Kaggle CLI is an independent venv executable: it must not inherit the caller's
    `PYTHONPATH`/`PYTHONHOME`/`PYTHONSTARTUP`, because the offline unit-test harness points
    `PYTHONPATH` at `processing/tests`, whose `sitecustomize` installs a network socket guard.
    """
    env = dict(os.environ if environ is None else environ)
    for key in DROPPED_CLI_ENV_KEYS:
        env.pop(key, None)
    return env


class KaggleCli:
    """Thin read-only wrapper around the Kaggle CLI binary; redacts secrets on the way out."""

    def __init__(self, binary: str, timeout: float, secrets: tuple[str, ...] = (),
                 environ=None) -> None:
        self.binary = binary
        self.timeout = timeout
        self.secrets = tuple(secrets)
        self.env = cli_environment(environ)

    def run(self, argv: list[str]) -> tuple[int, str, str]:
        """Execute one CLI command, returning redacted `(returncode, stdout, stderr)`."""
        command = [self.binary, *argv]
        try:
            completed = subprocess.run(
                command, capture_output=True, text=True, timeout=self.timeout, check=False,
                env=self.env,
            )
        except subprocess.TimeoutExpired:
            raise QueryError(f'timed out after {self.timeout}s: kaggle {argv[0]}')
        except OSError as exc:
            raise QueryError(f'could not execute the kaggle binary: {exc.strerror or exc}')
        stdout = redact_secrets(completed.stdout or '', self.secrets)
        stderr = redact_secrets(completed.stderr or '', self.secrets)
        return completed.returncode, stdout, stderr


def _first_line(text: str) -> str:
    for line in (text or '').splitlines():
        if line.strip():
            return line.strip()
    return ''


def _failure_message(stdout: str, stderr: str, argv: list[str]) -> str:
    """Describe a failed CLI call, replacing a bare traceback header with its last line.

    The header alone (`Traceback (most recent call last):`) names no cause, so a reported
    query failure would hide that the offline socket guard or an import error stopped it.
    """
    text = stderr or stdout
    lines = [line.strip() for line in (text or '').splitlines() if line.strip()]
    message = _first_line(stderr) or _first_line(stdout)
    if not message:
        return f'kaggle {argv[0]} produced no usable output'
    if message == TRACEBACK_HEADER and lines:
        message = lines[-1]
    if SOCKET_GUARD_MARKER in text:
        message = f'{message} (offline socket guard blocked the CLI; run without the test PYTHONPATH)'
    return message


def probe_version(kaggle: KaggleCli, ref: str, version: int) -> str | None:
    """Return the worker status of ``ref/version``, or None when that version does not exist."""
    argv = ['kernels', 'status', f'{ref}/{version}']
    returncode, stdout, stderr = kaggle.run(argv)
    if returncode != 0:
        if is_missing_version(f'{stdout}\n{stderr}'):
            return None
        raise QueryError(_failure_message(stdout, stderr, argv))
    worker_status = parse_worker_status(stdout) or parse_worker_status(stderr)
    if worker_status is None:
        raise QueryError('unrecognised "kaggle kernels status" output')
    return worker_status


def discover_current_version(
    kaggle: KaggleCli, ref: str, max_version: int,
) -> tuple[int, str]:
    """Return `(version, worker_status)` for the highest existing version of ``ref``.

    Versions are assumed to be numbered contiguously, so a gallop `1, 2, 4, ...` finds a missing
    upper bound and a binary search then finds the last existing version.
    """
    statuses: dict[int, str] = {}
    candidate = 1
    while True:
        if candidate > max_version:
            raise QueryError(f'no version of {ref} exists at or below --max-version {max_version}')
        worker_status = probe_version(kaggle, ref, candidate)
        if worker_status is None:
            break
        statuses[candidate] = worker_status
        candidate *= 2
    if not statuses:
        raise QueryError(f'no published version found for {ref}')
    low, high = max(statuses), candidate
    while low + 1 < high:
        middle = (low + high) // 2
        worker_status = probe_version(kaggle, ref, middle)
        if worker_status is None:
            high = middle
        else:
            statuses[middle] = worker_status
            low = middle
    return low, statuses[low]


def parse_files_page(text: str) -> tuple[list[dict], str | None]:
    """Parse one `kaggle kernels files --format json` page into `(files, next_page_token)`."""
    token = None
    lines = []
    for line in (text or '').splitlines():
        match = _PAGE_TOKEN_RE.match(line.strip())
        if match:
            token = match.group(1)
            continue
        lines.append(line)
    body = '\n'.join(lines).strip()
    if not body or 'No files found' in body:
        return [], token
    start = body.find('[')
    if start < 0:
        raise QueryError('unrecognised "kaggle kernels files" output')
    try:
        parsed = json.loads(body[start:])
    except json.JSONDecodeError:
        raise QueryError('unrecognised "kaggle kernels files" output')
    files = [entry for entry in parsed if isinstance(entry, dict)]
    if not isinstance(parsed, list):
        files = []
    return files, token


def list_outputs(kaggle: KaggleCli, ref: str, version: int) -> int:
    """Return the number of output files for ``ref/version``.

    Only the count is reported. The `size` field of `kaggle kernels files` is NOT a byte count:
    on 2026-11-22 the entries for `yacine105/trellislast-version/32` summed to 23391 while the
    downloaded tree measured 24,620,011 B across 27 files, and per file the field disagrees with
    the downloaded bytes (01_pizza/input_image.png reported 890, measured 741092). Its unit is
    undocumented and unmeasurable, so a byte total from this command would be a fabricated
    number. Measure bytes from a downloaded tree instead.
    """
    files: list[dict] = []
    token = None
    while True:
        argv = [
            'kernels', 'files', f'{ref}/{version}', '--format', 'json',
            '--page-size', str(PAGE_SIZE),
        ]
        if token:
            argv += ['--page-token', token]
        returncode, stdout, stderr = kaggle.run(argv)
        if returncode != 0:
            raise QueryError(_failure_message(stdout, stderr, argv))
        page, token = parse_files_page(stdout)
        files.extend(page)
        if not token:
            break
    return len(files)


def read_log(kaggle: KaggleCli, ref: str, version: int, log_tail: int) -> tuple[str, list[str]]:
    """Return `(log_state, trailing_lines)` for a terminal version.

    An empty log is a normal Kaggle outcome for queued and cancelled versions, never a failure.
    """
    argv = ['kernels', 'logs', f'{ref}/{version}']
    returncode, stdout, stderr = kaggle.run(argv)
    if returncode != 0:
        raise QueryError(_failure_message(stdout, stderr, argv))
    lines = [line.rstrip() for line in stdout.splitlines() if line.strip()]
    if not lines:
        # Kaggle returns no log text for queued and cancelled versions; that is not a failure.
        return 'empty', []
    trailing = [line[:MAX_LOG_LINE_CHARS] for line in lines[-log_tail:]]
    return 'present', trailing


def parse_quota_table(text: str) -> list[dict]:
    """Parse the `kaggle quota` table into resource rows."""
    rows = []
    seen_header = False
    for raw in (text or '').splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        fields = _SEPARATOR_RUN.split(line.strip())
        if not seen_header:
            # The header starts the table and its first column is literally "resource".
            seen_header = fields[0].lower() == 'resource'
            continue
        if set(fields[0]) <= {'-'} or all(set(field) <= {'-'} for field in fields):
            continue
        if len(fields) < 4:
            continue
        rows.append({
            'resource': fields[0],
            'used': fields[1],
            'remaining': fields[2],
            'total': fields[3],
            'refresh_at': fields[4] if len(fields) > 4 else None,
        })
    return rows


def query_quota(kaggle: KaggleCli) -> dict:
    """Return `{'line': ..., 'resources': [...]}` for the current GPU/TPU quota."""
    argv = ['quota']
    returncode, stdout, stderr = kaggle.run(argv)
    if returncode != 0:
        raise QueryError(_failure_message(stdout, stderr, argv))
    rows = parse_quota_table(stdout)
    if not rows:
        raise QueryError('unrecognised "kaggle quota" output')
    parts = [
        f"{row['resource']} {row['used']} used / {row['remaining']} remaining of {row['total']}"
        for row in rows
    ]
    return {'line': 'quota: ' + '; '.join(parts), 'resources': rows}


def query_kernel(kaggle: KaggleCli, ref: str, *, log_tail: int, max_version: int) -> dict:
    """Collect one kernel record; raises QueryError when a query itself failed."""
    version, worker_status = discover_current_version(kaggle, ref, max_version)
    classification = classify(worker_status)
    terminal = classification in TERMINAL_CLASSIFICATIONS
    log_state, log_lines = 'not_fetched', []
    if terminal and log_tail > 0:
        log_state, log_lines = read_log(kaggle, ref, version, log_tail)
    output_files = list_outputs(kaggle, ref, version)
    return {
        'ref': ref,
        'query_ok': True,
        'error': None,
        'version': version,
        'worker_status': worker_status,
        'classification': classification,
        'terminal': terminal,
        'terminal_classification': (
            worker_status_suffix(worker_status) if terminal and classification != 'COMPLETE' else None
        ),
        'log': log_state,
        'log_tail': log_lines,
        'output_files': output_files,
    }


def format_kernel_line(record: dict) -> str:
    """Render one compact status line, including the terminal classification when relevant."""
    if not record.get('query_ok'):
        return f"{record['ref']} query=FAILED error={record.get('error') or 'unknown error'}"
    parts = [
        f"{record['ref']} v{record['version']}",
        f"status={record['worker_status']}",
        f"class={record['classification']}",
    ]
    if record.get('terminal_classification'):
        parts.append(f"terminal={record['terminal_classification']}")
    parts.append(f"log={record['log']}")
    parts.append(f"outputs={record['output_files']} files")
    return ' '.join(parts)


def _failed_record(ref: str, message: str) -> dict:
    return {
        'ref': ref,
        'query_ok': False,
        'error': message,
        'version': None,
        'worker_status': None,
        'classification': UNKNOWN,
        'terminal': None,
        'terminal_classification': None,
        'log': 'not_fetched',
        'log_tail': [],
        'output_files': None,
    }


def utc_timestamp() -> str:
    """Return the report timestamp in UTC, second precision, Z-suffixed."""
    return dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def build_document(records: list[dict], quota: dict | None, query_failures: int) -> dict:
    """Assemble the JSON report."""
    return {
        'schema_version': SCHEMA_VERSION,
        'generated_at': utc_timestamp(),
        'quota': quota,
        'kernels': records,
        'query_failure_count': query_failures,
    }


def parse_refs(raw: str) -> list[str]:
    """Split a comma-separated `--kernels` value."""
    return [part.strip() for part in (raw or '').split(',') if part.strip()]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        prog='kaggle_job_status.py',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        '--kernels', default=','.join(DEFAULT_KERNELS), metavar='REFS',
        help='Comma-separated owner/slug kernel refs (default: the three private dish-3D kernels).',
    )
    parser.add_argument(
        '--kaggle-bin', default=DEFAULT_KAGGLE_BIN,
        help=f'Kaggle CLI binary (default: {DEFAULT_KAGGLE_BIN}).',
    )
    parser.add_argument(
        '--log-tail', type=int, default=0, metavar='N',
        help='Print the last N non-empty log lines of terminal versions (default: 0, no log fetch).',
    )
    parser.add_argument(
        '--json-out', type=Path, default=None, metavar='PATH',
        help='Write the status report as JSON to PATH.',
    )
    parser.add_argument(
        '--timeout', type=float, default=120.0, metavar='SECONDS',
        help='Per-subprocess timeout in seconds (default: 120).',
    )
    parser.add_argument(
        '--max-version', type=int, default=64, metavar='N',
        help='Highest version number probed while discovering the current version (default: 64).',
    )
    args = parser.parse_args(argv)

    refs = parse_refs(args.kernels)
    if not refs:
        parser.error('--kernels must name at least one owner/slug ref')
    if args.log_tail < 0:
        parser.error('--log-tail must be >= 0')

    binary = str(args.kaggle_bin)
    if not (os.path.isfile(binary) and os.access(binary, os.X_OK)):
        print(
            f'kaggle CLI not found at {binary}; recreate it with: {RECREATE_COMMAND}',
            file=sys.stderr,
        )
        return EXIT_MISSING_KAGGLE

    secrets = secret_values()
    kaggle = KaggleCli(binary, args.timeout, secrets)

    records: list[dict] = []
    query_failures = 0
    for ref in refs:
        try:
            record = query_kernel(kaggle, ref, log_tail=args.log_tail, max_version=args.max_version)
        except QueryError as exc:
            query_failures += 1
            record = _failed_record(ref, str(exc))
            print(format_kernel_line(record), file=sys.stdout)
        else:
            print(format_kernel_line(record))
            for line in record['log_tail']:
                print(line)
        records.append(record)

    quota = None
    try:
        quota = query_quota(kaggle)
    except QueryError as exc:
        query_failures += 1
        print(f'quota: unavailable ({exc})', file=sys.stderr)
    else:
        print(quota['line'])

    document = build_document(records, quota, query_failures)
    if args.json_out is not None:
        payload = redact_secrets(json.dumps(document, indent=2) + '\n', secrets)
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_out).write_text(payload, encoding='utf-8')

    return EXIT_OK if query_failures == 0 else EXIT_QUERY_FAILED


if __name__ == '__main__':
    sys.exit(main())