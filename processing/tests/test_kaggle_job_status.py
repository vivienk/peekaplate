"""Offline checks for the read-only Kaggle job status report (no network, mocked CLI)."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest import mock

_SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'kaggle_job_status.py'
_spec = importlib.util.spec_from_file_location('kaggle_job_status', _SCRIPT)
module = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = module
_spec.loader.exec_module(module)

REF = 'yacine105/trellislast-version'
OTHER_REF = 'yacine105/peekaplate-dish-3d-multi-model-benchmark-a'

#: What the CLI prints (on stderr, exit code 1) for a version that does not exist.
NOT_FOUND_STDERR = (
    '404 Client Error: Not Found for url: https://api.kaggle.com/v1/kernels.KernelsApiService/'
    'GetKernelSessionStatus\n'
    '\n'
    'The resource was not found. Check the spelling of the reference you passed.\n'
    'References are usually \'<owner>/<slug>\', which you can find in the resource\'s URL.\n'
)

QUOTA_TABLE = (
    'resource  used   remaining  total   refreshAt\n'
    '--------  -----  ---------  ------  -------------------------\n'
    'GPU       7.47h  37.53h     45.00h  2026-11-28T00:00:00+00:00\n'
    'TPU       0.00h  20.00h     20.00h  2026-11-28T00:00:00+00:00\n'
)

KERNEL_RECORD_KEYS = {
    'ref', 'query_ok', 'error', 'version', 'worker_status', 'classification', 'terminal',
    'terminal_classification', 'log', 'log_tail', 'output_files',
}


class FakeKernelCli:
    """Stand-in for the Kaggle CLI binary; answers status/files/logs/quota from a script."""

    def __init__(self, versions, *, logs='', pages=None, quota=QUOTA_TABLE, status_failure=None):
        self.versions = dict(versions)
        self.logs = logs
        self.pages = list(pages) if pages is not None else [[]]
        self.quota = quota
        self.status_failure = status_failure
        self.commands: list[tuple[str, ...]] = []
        self.calls: list[dict] = []
        self.page_calls = 0

    def __call__(self, argv, **kwargs):
        command = list(argv)
        self.commands.append(tuple(command))
        self.calls.append(kwargs)
        return_code, stdout, stderr = self._respond(command[1:])
        return subprocess.CompletedProcess(command, return_code, stdout, stderr)

    def _respond(self, args):
        if args[:2] == ['kernels', 'status']:
            if self.status_failure is not None:
                return 1, '', self.status_failure + '\n'
            target = args[2]
            version = int(target.rsplit('/', 1)[1])
            status = self.versions.get(version)
            if status is None:
                return 1, '', NOT_FOUND_STDERR
            return 0, f'{target} has status "{status}"\n', ''
        if args[:2] == ['kernels', 'files']:
            index = self.page_calls
            self.page_calls += 1
            if index >= len(self.pages):
                raise AssertionError(f'unscripted files page {index}')
            prefix = f'Next Page Token = tok{index}\n' if index + 1 < len(self.pages) else ''
            return 0, prefix + json.dumps(self.pages[index], indent=2) + '\n', ''
        if args[:2] == ['kernels', 'logs']:
            return 0, self.logs, ''
        if args[:1] == ['quota']:
            return 0, self.quota, ''
        raise AssertionError(f'unexpected command: {args}')


class KaggleJobStatusTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.binary = Path(self._tmp.name) / 'kaggle'
        self.binary.write_text('#!/bin/sh\nexit 0\n', encoding='utf-8')
        self.binary.chmod(0o755)

    def run_main(self, fake, *args, env=None, binary=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        argv = ['--kaggle-bin', str(binary or self.binary), *args]
        with mock.patch.object(module.subprocess, 'run', side_effect=fake):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                if env is None:
                    code = module.main(argv)
                else:
                    with mock.patch.dict(os.environ, env):
                        code = module.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def status_lines(self, stdout):
        return [line for line in stdout.splitlines() if line.startswith('yacine105/')]

    # -- classification -------------------------------------------------------------------

    def test_classify_maps_the_six_stable_classifications(self):
        cases = {
            'KernelWorkerStatus.COMPLETE': 'COMPLETE',
            'KernelWorkerStatus.RUNNING': 'RUNNING',
            'KernelWorkerStatus.QUEUED': 'QUEUED',
            'KernelWorkerStatus.CANCEL_ACKNOWLEDGED': 'CANCELLED',
            'KernelWorkerStatus.CANCEL_REQUESTED': 'CANCELLED',
            'KernelWorkerStatus.ERROR': 'ERROR',
            'KernelWorkerStatus.SOMETHING_NEW': 'UNKNOWN',
            '': 'UNKNOWN',
            None: 'UNKNOWN',
        }
        observed = {raw: module.classify(raw) for raw in cases}
        self.assertEqual(observed, cases)
        self.assertEqual(
            {module.classify(raw) for raw in cases},
            {'COMPLETE', 'RUNNING', 'QUEUED', 'CANCELLED', 'ERROR', 'UNKNOWN'},
        )

    def test_parse_worker_status_reads_the_cli_line(self):
        text = f'{REF}/6 has status "KernelWorkerStatus.COMPLETE"\n'
        self.assertEqual(module.parse_worker_status(text), 'KernelWorkerStatus.COMPLETE')
        self.assertIsNone(module.parse_worker_status('nothing useful here'))

    def test_one_line_per_kernel_for_every_classification(self):
        for raw, expected in (
            ('KernelWorkerStatus.COMPLETE', 'COMPLETE'),
            ('KernelWorkerStatus.RUNNING', 'RUNNING'),
            ('KernelWorkerStatus.QUEUED', 'QUEUED'),
            ('KernelWorkerStatus.CANCEL_ACKNOWLEDGED', 'CANCELLED'),
            ('KernelWorkerStatus.ERROR', 'ERROR'),
            ('KernelWorkerStatus.SOMETHING_NEW', 'UNKNOWN'),
        ):
            with self.subTest(raw=raw):
                fake = FakeKernelCli({1: raw}, pages=[[{'name': 'a.glb', 'size': 7}]])
                code, stdout, stderr = self.run_main(fake, '--kernels', REF)
                self.assertEqual(code, 0, stderr)
                self.assertEqual(len(self.status_lines(stdout)), 1, stdout)
                self.assertIn(f'class={expected}', stdout)
                self.assertIn('outputs=1 files', stdout)

    # -- log handling ---------------------------------------------------------------------

    def test_terminal_line_reports_version_status_and_terminal_classification(self):
        fake = FakeKernelCli(
            {1: 'KernelWorkerStatus.COMPLETE', 2: 'KernelWorkerStatus.ERROR'},
            pages=[[{'name': 'a.glb', 'size': 7}, {'name': 'b.json', 'size': 3}]],
        )
        code, stdout, stderr = self.run_main(fake, '--kernels', REF)
        self.assertEqual(code, 0, stderr)
        self.assertIn(
            f'{REF} v2 status=KernelWorkerStatus.ERROR class=ERROR terminal=ERROR '
            'log=not_fetched outputs=2 files',
            stdout,
        )
        self.assertIn('quota: GPU 7.47h used / 37.53h remaining of 45.00h', stdout)

    def test_empty_log_is_reported_and_never_a_failure(self):
        fake = FakeKernelCli({1: 'KernelWorkerStatus.CANCEL_ACKNOWLEDGED'}, logs='\n')
        code, stdout, stderr = self.run_main(fake, '--kernels', REF, '--log-tail', '3')
        self.assertEqual(code, 0, stderr)
        self.assertIn(f'{REF} v1', stdout)
        self.assertIn('class=CANCELLED', stdout)
        self.assertIn('terminal=CANCEL_ACKNOWLEDGED', stdout)
        self.assertIn('log=empty', stdout)
        self.assertIn('outputs=0 files', stdout)
        # An empty log must not be turned into a failure cause.
        self.assertNotIn('ERROR', stdout)
        self.assertNotIn('FAILED', stdout)
        self.assertNotIn('error=', stdout)
        self.assertEqual(len(self.status_lines(stdout)), 1, stdout)

    def test_log_tail_prints_only_trailing_non_empty_lines(self):
        logs = 'first line\n\n   \nsecond line\n\nthird line\nfourth line\n\n\n'
        fake = FakeKernelCli({1: 'KernelWorkerStatus.COMPLETE'}, logs=logs)
        code, stdout, stderr = self.run_main(fake, '--kernels', REF, '--log-tail', '2')
        self.assertEqual(code, 0, stderr)
        self.assertIn('log=present', stdout)
        lines = stdout.splitlines()
        self.assertIn('log=present', lines[0])
        self.assertEqual(lines[1:3], ['third line', 'fourth line'])
        self.assertNotIn('first line', stdout)
        self.assertNotIn('second line', stdout)
        self.assertEqual([line for line in lines if not line.strip()], [])

    def test_zero_log_tail_never_fetches_logs(self):
        fake = FakeKernelCli({1: 'KernelWorkerStatus.COMPLETE'}, logs='some output\n')
        code, stdout, stderr = self.run_main(fake, '--kernels', REF)
        self.assertEqual(code, 0, stderr)
        self.assertIn('log=not_fetched', stdout)
        self.assertNotIn('some output', stdout)
        self.assertFalse([command for command in fake.commands if command[1:3] == ('kernels', 'logs')])

    def test_running_and_queued_versions_do_not_fetch_logs(self):
        for raw in ('KernelWorkerStatus.RUNNING', 'KernelWorkerStatus.QUEUED'):
            with self.subTest(raw=raw):
                fake = FakeKernelCli({1: raw}, logs='live\n')
                code, stdout, stderr = self.run_main(fake, '--kernels', REF, '--log-tail', '2')
                self.assertEqual(code, 0, stderr)
                self.assertIn('log=not_fetched', stdout)
                self.assertNotIn('live', stdout)

    def test_outputs_paginate_across_page_tokens(self):
        fake = FakeKernelCli(
            {1: 'KernelWorkerStatus.COMPLETE'},
            pages=[
                [{'name': 'a.glb', 'size': 5}, {'name': 'b.glb', 'size': 6}],
                [{'name': 'c.glb', 'size': 7}],
            ],
        )
        code, stdout, stderr = self.run_main(fake, '--kernels', REF)
        self.assertEqual(code, 0, stderr)
        self.assertIn('outputs=3 files', stdout)
        files_commands = [c for c in fake.commands if c[1:3] == ('kernels', 'files')]
        self.assertEqual(len(files_commands), 2)
        self.assertIn('--page-token', files_commands[1])

    def test_output_size_field_is_never_reported_as_bytes(self):
        """Regression: the `kaggle kernels files` size field is not a byte count.

        Measured on 2026-11-22 against `yacine105/trellislast-version/32`: the entries summed to
        23391 while the downloaded tree held 24,620,011 B, and `01_pizza/input_image.png` was
        reported as 890 against 741092 measured bytes. A byte total derived from that field is a
        fabricated number, so the status line and JSON must not carry one.
        """
        fake = FakeKernelCli(
            {1: 'KernelWorkerStatus.COMPLETE'},
            pages=[[{'name': 'input_image.png', 'size': 890}, {'name': 'a.glb', 'size': 3}]],
        )
        code, stdout, stderr = self.run_main(fake, '--kernels', REF)
        self.assertEqual(code, 0, stderr)
        self.assertIn('outputs=2 files\n', stdout)
        self.assertNotRegex(stdout, r'outputs=\d+ files/\d+')
        self.assertNotIn(' B\n', stdout)
        self.assertNotIn('893', stdout)
        json_out = Path(self._tmp.name) / 'status.json'
        fake = FakeKernelCli(
            {1: 'KernelWorkerStatus.COMPLETE'},
            pages=[[{'name': 'input_image.png', 'size': 890}, {'name': 'a.glb', 'size': 3}]],
        )
        code, _, stderr = self.run_main(fake, '--kernels', REF, '--json-out', str(json_out))
        self.assertEqual(code, 0, stderr)
        document = json.loads(json_out.read_text(encoding='utf-8'))
        self.assertNotIn('output_bytes', document['kernels'][0])

    # -- CLI plumbing ---------------------------------------------------------------------

    def test_cli_environment_drops_the_offline_test_harness_pythonpath(self):
        """The CLI is its own venv: inheriting `processing/tests` installs a socket guard."""
        fake = FakeKernelCli({1: 'KernelWorkerStatus.COMPLETE'})
        code, _, stderr = self.run_main(
            fake, '--kernels', REF,
            env={
                'PYTHONPATH': '/repo/processing/src:/repo/processing/tests',
                'PYTHONHOME': '/opt/python',
                'PYTHONSTARTUP': '/repo/hook.py',
                'KAGGLE_CONFIG_DIR': '/home/someone/.kaggle',
                'HOME': '/home/someone',
            },
        )
        self.assertEqual(code, 0, stderr)
        self.assertTrue(fake.calls)
        for call in fake.calls:
            env = call['env']
            for dropped in module.DROPPED_CLI_ENV_KEYS:
                self.assertNotIn(dropped, env)
            self.assertEqual(env['KAGGLE_CONFIG_DIR'], '/home/someone/.kaggle')
            self.assertEqual(env['HOME'], '/home/someone')

    def test_socket_guard_traceback_names_a_cause_and_the_guard(self):
        """A bare `Traceback (most recent call last):` must never be the whole report."""
        guard = (
            'Traceback (most recent call last):\n'
            '  File "/tmp/dish-kaggle-cli/lib/python3.14/site-packages/urllib3/connection.py", '
            'line 239, in _new_conn\n'
            'AssertionError: Network disabled by offline socket guard: blocked connection to '
            "('34.54.168.202', 443)\n"
        )
        fake = FakeKernelCli({1: 'KernelWorkerStatus.COMPLETE'}, status_failure=guard.rstrip('\n'))
        code, stdout, _ = self.run_main(fake, '--kernels', REF)
        self.assertEqual(code, 1)
        self.assertIn('query=FAILED', stdout)
        line = next(line for line in stdout.splitlines() if line.startswith(f'{REF} '))
        self.assertNotIn(f'error={module.TRACEBACK_HEADER}', line)
        self.assertIn(module.SOCKET_GUARD_MARKER, line)
        self.assertIn('run without the test PYTHONPATH', line)
        self.assertIn("('34.54.168.202', 443)", line)

    def test_failure_message_uses_the_last_traceback_line(self):
        stdout = ''
        stderr = 'Traceback (most recent call last):\n  File "x.py", line 1\nKeyError: hf_token\n'
        self.assertEqual(
            module._failure_message(stdout, stderr, ['kernels', 'status']), 'KeyError: hf_token',
        )
        self.assertEqual(
            module._failure_message('', 'plain failure\n', ['quota']), 'plain failure',
        )
        self.assertEqual(
            module._failure_message('', '', ['quota']), 'kaggle quota produced no usable output',
        )

    def test_timeout_is_applied_per_subprocess(self):
        fake = FakeKernelCli({1: 'KernelWorkerStatus.QUEUED'})
        code, _, stderr = self.run_main(fake, '--kernels', REF, '--timeout', '7')
        self.assertEqual(code, 0, stderr)
        self.assertTrue(fake.calls)
        for call in fake.calls:
            self.assertEqual(call['timeout'], 7.0)
            self.assertTrue(call['capture_output'])

    def test_unknown_ref_is_a_query_failure(self):
        fake = FakeKernelCli({})
        code, stdout, stderr = self.run_main(fake, '--kernels', REF)
        self.assertEqual(code, 1)
        self.assertIn(f'{REF} query=FAILED', stdout)
        self.assertIn('no published version found', stdout)

    def test_json_output_keys(self):
        fake = FakeKernelCli(
            {1: 'KernelWorkerStatus.CANCEL_ACKNOWLEDGED'},
            logs='\n',
            pages=[[{'name': 'worker_output.json', 'size': 42}]],
        )
        json_path = Path(self._tmp.name) / 'report' / 'status.json'
        code, stdout, stderr = self.run_main(
            fake, '--kernels', REF, '--log-tail', '2', '--json-out', str(json_path),
        )
        self.assertEqual(code, 0, stderr)
        document = json.loads(json_path.read_text(encoding='utf-8'))
        self.assertEqual(
            set(document),
            {'schema_version', 'generated_at', 'quota', 'kernels', 'query_failure_count'},
        )
        self.assertEqual(document['schema_version'], module.SCHEMA_VERSION)
        self.assertRegex(document['generated_at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        self.assertEqual(document['query_failure_count'], 0)
        self.assertEqual(
            document['quota']['line'],
            'quota: GPU 7.47h used / 37.53h remaining of 45.00h; '
            'TPU 0.00h used / 20.00h remaining of 20.00h',
        )
        self.assertEqual([row['resource'] for row in document['quota']['resources']], ['GPU', 'TPU'])
        self.assertEqual(len(document['kernels']), 1)
        record = document['kernels'][0]
        self.assertEqual(set(record), KERNEL_RECORD_KEYS)
        self.assertEqual(record['ref'], REF)
        self.assertEqual(record['version'], 1)
        self.assertEqual(record['worker_status'], 'KernelWorkerStatus.CANCEL_ACKNOWLEDGED')
        self.assertEqual(record['classification'], 'CANCELLED')
        self.assertEqual(record['terminal_classification'], 'CANCEL_ACKNOWLEDGED')
        self.assertEqual(record['log'], 'empty')
        self.assertEqual(record['log_tail'], [])
        self.assertEqual(record['output_files'], 1)
        self.assertNotIn('output_bytes', record)

    def test_missing_binary_exits_2_with_recreation_hint(self):
        fake = FakeKernelCli({1: 'KernelWorkerStatus.COMPLETE'})
        absent = Path(self._tmp.name) / 'volatile' / 'kaggle'
        code, stdout, stderr = self.run_main(fake, '--kernels', REF, binary=absent)
        self.assertEqual(code, 2)
        self.assertEqual(stdout, '')
        self.assertEqual(len(stderr.splitlines()), 1, stderr)
        self.assertIn(module.RECREATE_COMMAND, stderr)
        self.assertIn(
            'python3 -m venv /tmp/dish-kaggle-cli && /tmp/dish-kaggle-cli/bin/pip install kaggle',
            stderr,
        )
        self.assertFalse(fake.commands)

    def test_default_kernels_are_the_three_private_refs(self):
        self.assertEqual(
            module.DEFAULT_KERNELS,
            (
                'yacine105/peekaplate-dish-3d-multi-model-benchmark-a',
                'yacine105/peekaplate-dish-3d-trellis2-hero-batch-b',
                'yacine105/trellislast-version',
            ),
        )
        self.assertEqual(module.parse_refs(','.join(module.DEFAULT_KERNELS)), list(module.DEFAULT_KERNELS))
        self.assertEqual(module.parse_refs(' a/b , c/d '), ['a/b', 'c/d'])

    # -- secret handling -------------------------------------------------------------------

    def test_token_in_the_environment_never_reaches_the_log_lines(self):
        token = 'sup3rsecret-token-value-0123456789'
        fake = FakeKernelCli(
            {1: 'KernelWorkerStatus.COMPLETE'}, logs=f'training with key {token}\n',
        )
        code, stdout, stderr = self.run_main(
            fake, '--kernels', REF, '--log-tail', '1', env={'KAGGLE_KEY': token},
        )
        self.assertEqual(code, 0, stderr)
        self.assertIn('<redacted>', stdout)
        self.assertNotIn(token, stdout)
        self.assertNotIn(token, stderr)

    def test_token_in_the_environment_never_reaches_an_error_message(self):
        token = 'sup3rsecret-token-value-0123456789'
        fake = FakeKernelCli({1: 'KernelWorkerStatus.COMPLETE'}, status_failure=f'boom {token}')
        code, stdout, stderr = self.run_main(
            fake, '--kernels', REF, '--timeout', '5', env={'KAGGLE_KEY': token},
        )
        self.assertEqual(code, 1)
        self.assertIn('query=FAILED', stdout)
        self.assertNotIn(token, stdout)
        self.assertNotIn(token, stderr)
        # The tool reads the token from no file of its own.
        self.assertNotIn('access_token', _SCRIPT.read_text(encoding='utf-8'))

    def test_redact_secrets_helper(self):
        secrets = module.secret_values({'KAGGLE_KEY': 'abcdefgh123', 'PATH': '/usr/bin'})
        self.assertEqual(secrets, ('abcdefgh123',))
        self.assertEqual(
            module.redact_secrets('x abcdefgh123 y', secrets), 'x <redacted> y',
        )


if __name__ == '__main__':
    unittest.main()