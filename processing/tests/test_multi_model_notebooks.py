"""Offline regressions for the two recoverable `benchmark-a/3` model failures.

Read from the generated notebook cells (never from the generator's own strings), so a hand edit of
`notebooks/*.ipynb` or a generator regression that drops either repair fails here.

Evidence (`/tmp/out-a3`, `peekaplate-dish-3d-multi-model-benchmark-a/3`, 19 dishes):

1. `TripoSG + Photo PBR` — 19/19 `RuntimeError: mat1 and mat2 must have the same dtype, but got
   Float and Half`. The cell built the pipeline with
   `TripoSGPipeline.from_pretrained(weights, torch_dtype=torch.float16).to('cuda')`, which leaves the
   DINOv2 image encoder in float32; `TripoSGPipeline` derives `latents.dtype` from
   `image_embeds.dtype`, so float32 features entered FP16 DiT linears.
2. `Hi3DGen Normal-Bridge` — 19/19 `CalledProcessError: Command '['ninja']' returned non-zero exit
   status 1.`, raised while `import spconv` rebuilt `cumm`; the failing recipe is `g++` (not `nvcc`)
   and it dies on `fatal error: tensorview/pybind_utils.h: No such file or directory`, i.e. the
   wheel's build directory lacks the vendored headers it references. Not a missing toolkit and not a
   T4 `sm_75` arch mismatch, so `TORCH_CUDA_ARCH_LIST` cannot repair it: the honest outcome is one
   measured shard `skip`, never 19 opaque per-dish failures.
"""

from __future__ import annotations

import ast
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import types
import unittest
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[2]
NOTEBOOK_DIR = REPO_ROOT / 'notebooks'
NOTEBOOK_A = NOTEBOOK_DIR / 'dish-3d-multi-model-bench-a.ipynb'
NOTEBOOK_B = NOTEBOOK_DIR / 'dish-3d-multi-model-bench-b.ipynb'
GENERATOR = REPO_ROOT / 'processing' / 'scripts' / 'build_multi_model_notebooks.py'

TRIPOSG_HEADER = '# Benchmark Option 3: VAST AI TripoSG'
HI3DGEN_HEADER = '# Benchmark Option 5: Stable-X Hi3DGen'
HUNYUAN2_HEADER = '# Benchmark Option 4: Tencent Hunyuan3D-2'
HUNYUAN21_HEADER = '# Benchmark Option 4b: Tencent Hunyuan3D-2.1'
HUNYUAN21_CODE_REV = '82920d643c0dc2f7bfd7255f45f62d386edfe60c'
HUNYUAN21_REVISION = '0b94677654c57bb9a6b6845cd7b704ccf551d327'
SPAR3D_HEADER = '# Benchmark Option 5b: Stability AI SPAR3D'
SPAR3D_CODE_REV = 'fdc311b16809e6a8adc2f5a3407ebb3db1a95bd1'
SPAR3D_REVISION = '5699918cb34f55cd7d828493d2725f3038313761'

# The measured environment markers that make a Hi3DGen setup failure a dependency skip, not a model
# error: the `spconv` wheel, its `cumm` C++ backend, the vendored `tensorview` headers it is missing,
# and the `ninja` line the observed `/3` failure ended on.
HI3DGEN_ENVIRONMENT_MARKERS = ('spconv', 'cumm', 'tensorview', 'ninja')


# --------------------------------------------------------------------------- notebook cell helpers


def code_cell_sources(notebook_path: Path) -> list[str]:
    notebook = json.loads(Path(notebook_path).read_text(encoding='utf-8'))
    return [''.join(cell['source']) for cell in notebook['cells'] if cell['cell_type'] == 'code']


def cell_starting_with(sources: list[str], header: str) -> str:
    for source in sources:
        if source.startswith(header):
            return source
    raise AssertionError(f'No generated code cell starts with {header!r}')


def parse(source: str, filename: str = 'cell') -> ast.Module:
    return ast.parse(source, filename=filename)


def dotted(node: ast.AST) -> str:
    """Render a `Name`/`Attribute` chain as `a.b.c`; anything else renders empty."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return f'{dotted(node.value)}.{node.attr}' if dotted(node.value) else node.attr
    return ''


def call_chain(node: ast.AST) -> list[ast.Call]:
    """The nested calls of a call expression, outermost first (`f(x).g(y)` -> [g, f] -> [f, g])."""
    calls: list[ast.Call] = []
    while True:
        if isinstance(node, ast.Call):
            calls.append(node)
            node = node.func
        elif isinstance(node, ast.Attribute):
            node = node.value
        else:
            break
    return list(reversed(calls))


def call_name(call: ast.Call) -> str:
    """The bare method/function name of a call (`x.to(...)` -> `to`, `f(...)` -> `f`)."""
    func = call.func
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return ''


def _is_float16(node: ast.AST | None) -> bool:
    if isinstance(node, ast.Attribute):
        return node.attr in ('float16', 'half')
    if isinstance(node, ast.Name):
        return node.id in ('float16', 'half')
    return False


def _cast_dtype(call: ast.Call) -> str | None:
    """The dtype a `.to(...)` call requests, from its keyword or its trailing positional argument."""
    for keyword in call.keywords:
        if keyword.arg == 'dtype' and _is_float16(keyword.value):
            return 'float16'
    for arg in call.args[1:]:
        if _is_float16(arg):
            return 'float16'
    return None


def _update_status_values(node: ast.AST) -> set[str]:
    """Every `rec.update(status='...')` value in a node."""
    values: set[str] = set()
    for child in ast.walk(node):
        if not isinstance(child, ast.Call) or not dotted(child.func).endswith('.update'):
            continue
        for keyword in child.keywords:
            if keyword.arg == 'status' and isinstance(keyword.value, ast.Constant):
                values.add(str(keyword.value.value))
    return values


def _labelled_loop(tree: ast.Module, key_suffix: str) -> ast.For:
    for node in ast.walk(tree):
        if not isinstance(node, ast.For) or dotted(node.iter) != 'ACTIVE_LABELS':
            continue
        for child in ast.walk(node):
            if isinstance(child, ast.Constant) and isinstance(child.value, str) and child.value.endswith(key_suffix):
                return node
    raise AssertionError(f'No `for label in ACTIVE_LABELS:` loop records a {key_suffix!r} run')


def try_guarding_assignment(tree: ast.AST, name: str) -> ast.Try:
    """The `try` whose own body binds `name`, i.e. the guard written for that statement."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        for statement in node.body:
            if isinstance(statement, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == name for target in statement.targets
            ):
                return node
    raise AssertionError(f'No try/except guards the `{name} = ...` statement')


def try_with_handler_assignment(tree: ast.AST, name: str) -> ast.Try:
    """The `try` whose handler binds `name`, i.e. the guard that records the failure."""
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        for handler in node.handlers:
            for statement in ast.walk(handler):
                if isinstance(statement, ast.Assign) and any(
                    isinstance(target, ast.Name) and target.id == name for target in statement.targets
                ):
                    return node
    raise AssertionError(f'No except handler records `{name} = ...`')


def _handler_try(node: ast.AST, *, needs_raise: bool | None = None) -> ast.Try | None:
    """A `try` node under `node` whose handlers do (or do not) re-raise."""
    for child in ast.walk(node):
        if not isinstance(child, ast.Try) or not child.handlers:
            continue
        raises = any(isinstance(inner, ast.Raise) for handler in child.handlers for inner in ast.walk(handler))
        if needs_raise is None or needs_raise == raises:
            return child
    return None


def _assert_isolated_per_dish(testcase: unittest.TestCase, source: str, key_suffix: str, tag: str) -> None:
    """One dish/model failure must stay a record, never abort the notebook run."""
    tree = parse(source, f'{tag}_cell')
    loop = _labelled_loop(tree, key_suffix)
    guarded = _handler_try(loop, needs_raise=False)
    testcase.assertIsNotNone(guarded, f'{tag}: the per-dish loop has no non-raising try/except')
    statuses: set[str] = set()
    for handler in guarded.handlers:
        statuses |= _update_status_values(handler)
    testcase.assertIn('failed', statuses, f'{tag}: the per-dish handler must record status="failed"')
    for handler in guarded.handlers:
        testcase.assertFalse(
            any(isinstance(inner, ast.Raise) for inner in ast.walk(handler)),
            f'{tag}: the per-dish handler re-raises and aborts the notebook run',
        )


# ------------------------------------------------------------------ TripoSG conditioning dtype


def assert_triposg_conditioning_dtype_matches_model(testcase: unittest.TestCase, source: str) -> None:
    """The conditioning path must be cast to the model dtype, not left in float32."""
    tree = parse(source, 'triposg_cell')

    # No fp32/fp64 pin anywhere: the upstream cast is fp16, so a pin would either double VRAM or
    # recreate the mismatch. `torch.float32` must not appear at all in this cell.
    fp32 = [node for node in ast.walk(tree) if isinstance(node, ast.Attribute) and node.attr in ('float32', 'float64')
            and dotted(node.value) == 'torch']
    testcase.assertEqual(fp32, [], 'TripoSG cell pins a torch float32/float64 dtype instead of casting to fp16')

    candidate = None
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if any(isinstance(target, ast.Name) and target.id == '_candidate_pipe' for target in node.targets):
            candidate = node
    testcase.assertIsNotNone(candidate, 'TripoSG cell no longer builds `_candidate_pipe`')
    chain = call_chain(candidate.value)
    testcase.assertTrue(
        any(call_name(call) == 'from_pretrained' for call in chain),
        'TripoSG cell no longer loads the pipeline with `.from_pretrained`',
    )
    pipeline_cast = [call for call in chain if call_name(call) == 'to' and _cast_dtype(call) == 'float16']
    testcase.assertTrue(
        pipeline_cast,
        'TripoSG pipeline is not cast to fp16 on the pipeline itself (`.to(device, torch.float16)`); '
        '`from_pretrained(torch_dtype=...)` alone leaves the DINOv2 encoder in float32 and reproduces '
        '`mat1 and mat2 must have the same dtype, but got Float and Half`',
    )

    encoder_cast = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and call_name(node) == 'to'
        and dotted(node.func.value) == '_candidate_pipe.image_encoder_dinov2'
        and _cast_dtype(node) == 'float16'
    ]
    testcase.assertTrue(
        encoder_cast,
        'The DINOv2 image encoder (the component that decides `latents.dtype`) is not cast to fp16',
    )

    probe = try_guarding_assignment(tree, '_triposg_dtypes')
    for handler in probe.handlers:
        testcase.assertFalse(
            any(isinstance(inner, ast.Raise) for inner in ast.walk(handler)),
            'The dtype probe re-raises, so an unusable diagnostic still loses the shard',
        )
        testcase.assertTrue(
            any(isinstance(inner, ast.Call) and dotted(inner.func) == 'print' for inner in ast.walk(handler)),
            'The dtype probe handler must print its measured reason instead of failing silently',
        )
    else_source = '\n'.join(ast.get_source_segment(source, node) or '' for node in probe.orelse)
    testcase.assertIn(
        'float16', else_source,
        'The dtype probe no longer fails closed when a measured component dtype is not fp16 '
        '(benchmark-a/4 lost its setup report to a `TypeError` in the probe itself)',
    )

    assignments = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == 'triposg_pipe' for target in node.targets)
        and isinstance(node.value, ast.Name) and node.value.id == '_candidate_pipe'
    ]
    testcase.assertTrue(assignments, 'The cell no longer publishes the cast pipeline as `triposg_pipe`')
    testcase.assertGreater(
        assignments[0].lineno, probe.lineno,
        '`triposg_pipe` is published before the dtype checks, so a probe failure leaves a usable-but-'
        'unverified pipeline (the benchmark-a/4 ordering defect)',
    )
    setup_guard = try_with_handler_assignment(tree, 'triposg_setup_err')
    testcase.assertFalse(
        any(isinstance(inner, ast.Raise) for handler in setup_guard.handlers for inner in ast.walk(handler)),
        'A TripoSG setup failure now aborts the notebook instead of recording `triposg_setup_err`',
    )

    _assert_isolated_per_dish(testcase, source, '/triposg', 'TripoSG')


# ----------------------------------------------------------------- Hi3DGen spconv probe & skip


def assert_hi3dgen_spconv_failure_is_a_measured_skip(testcase: unittest.TestCase, setup: str, generation: str) -> None:
    """`spconv` must be probed before use and its failure recorded as one shard skip."""
    setup_tree = parse(setup, 'hi3dgen_setup_cell')

    string_names = {
        target.id: node.value.value
        for node in ast.walk(setup_tree)
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)
        for target in node.targets if isinstance(target, ast.Name)
    }

    def _probe_script(child: ast.AST) -> str:
        if isinstance(child, ast.Constant) and isinstance(child.value, str):
            return child.value
        if isinstance(child, ast.Name):
            return string_names.get(child.id, '')
        return ''

    probes = [
        node for node in ast.walk(setup_tree)
        if isinstance(node, ast.Call)
        and dotted(node.func) == 'subprocess.run'
        and any(
            'import spconv.pytorch' in _probe_script(child)
            for arg in node.args for child in ast.walk(arg)
        )
    ]
    testcase.assertTrue(
        probes,
        'Hi3DGen no longer probes `import spconv.pytorch` in a child process; importing it in-process '
        "reproduces `CalledProcessError: Command '['ninja']' returned non-zero exit status 1.`",
    )
    probe_call = probes[0]
    keywords = {keyword.arg for keyword in probe_call.keywords}
    testcase.assertTrue(
        {'capture_output', 'text', 'timeout'} <= keywords,
        'The spconv probe must capture child output so its failure line can be recorded, and be bounded',
    )

    failure_if = [
        node for node in ast.walk(setup_tree)
        if isinstance(node, ast.If)
        and any(isinstance(child, ast.Attribute) and child.attr == 'returncode' for child in ast.walk(node.test))
    ]
    testcase.assertTrue(failure_if, 'The spconv probe result is not checked (`_probe.returncode`)')
    body_source = '\n'.join(ast.get_source_segment(setup, node) or '' for node in failure_if[0].body)
    testcase.assertIn('uninstall', body_source, 'An unusable spconv wheel is not removed before the shard skip')
    testcase.assertIn('_spconv_installed', body_source, 'The unusable wheel is not named in its own skip reason')
    reasons = [
        node for node in ast.walk(failure_if[0])
        if isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call) and dotted(node.exc.func) == 'RuntimeError'
    ]
    testcase.assertTrue(reasons, 'The unusable spconv wheel does not raise a classified skip reason')
    reason = ast.get_source_segment(setup, reasons[0]) or ''
    testcase.assertIn('spconv_unavailable:', reason, 'The spconv skip reason lost its machine-readable prefix')

    unavailable = [
        node for node in ast.walk(setup_tree)
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == 'hi3d_unavailable' for target in node.targets
        )
        # The pre-set `hi3d_unavailable = False` is not the classification.
        and node.value is not None and not (isinstance(node.value, ast.Constant) and node.value.value is False)
    ]
    testcase.assertTrue(unavailable, 'The setup handler no longer classifies `hi3d_unavailable`')
    classifier = ast.get_source_segment(setup, unavailable[0].value) or ''
    testcase.assertIn(
        'spconv_unavailable:', classifier,
        'The explicit probe reason is no longer classified as a skip',
    )
    for marker in HI3DGEN_ENVIRONMENT_MARKERS:
        testcase.assertIn(
            marker, classifier,
            f'A measured environment failure mentioning {marker!r} is not classified as a skip: the '
            'no-wheel fallback then records 19 `failed` dishes instead of one actionable skip',
        )

    setup_guard = try_with_handler_assignment(setup_tree, 'hi3d_unavailable')
    testcase.assertEqual(len(setup_guard.handlers), 1, 'The Hi3DGen setup block must catch its own failure')
    testcase.assertFalse(
        any(isinstance(inner, ast.Raise) for inner in ast.walk(setup_guard.handlers[0])),
        'A Hi3DGen setup failure now aborts the notebook instead of recording `hi3d_err`',
    )
    testcase.assertTrue(
        any(isinstance(inner, ast.Call) and dotted(inner.func) == 'print' for handler in setup_guard.handlers
            for inner in ast.walk(handler)),
        'Hi3DGen setup failure is swallowed without printing its measured reason',
    )

    generation_tree = parse(generation, 'hi3dgen_generation_cell')
    unavailable_guard = [
        node for node in ast.walk(generation_tree)
        if isinstance(node, ast.If)
        and any(
            isinstance(child, ast.Compare) and dotted(child.left) in ('hi3d_pipe', 'normal_pred')
            for child in ast.walk(node.test)
        )
    ]
    testcase.assertTrue(unavailable_guard, 'The generation loop no longer short-circuits an unavailable Hi3DGen')
    guard = unavailable_guard[0]
    skip_branch = [
        node for node in ast.walk(guard)
        if isinstance(node, ast.If) and any(
            isinstance(child, ast.Name) and child.id == 'hi3d_unavailable' for child in ast.walk(node.test)
        )
    ]
    testcase.assertTrue(skip_branch, 'The unavailable Hi3DGen branch no longer tests `hi3d_unavailable`')
    skip_status = _update_status_values(skip_branch[0].body[0] if skip_branch[0].body else skip_branch[0])
    testcase.assertIn(
        'skipped', skip_status,
        'A dependency-unavailable Hi3DGen records something other than `skipped`',
    )
    failed_status: set[str] = set()
    for node in skip_branch[0].orelse:
        failed_status |= _update_status_values(node)
    testcase.assertIn(
        'failed', failed_status,
        'A genuine Hi3DGen setup error must still record `failed`, not be hidden as a skip',
    )
    guard_source = ast.get_source_segment(generation, guard) or ''
    testcase.assertIn('RUNS_3D[key] = rec', guard_source, 'A skipped Hi3DGen run is not recorded in RUNS_3D')
    testcase.assertIn('continue', guard_source, 'A skipped Hi3DGen run does not continue to the next dish')

    _assert_isolated_per_dish(testcase, generation, '/hi3dgen', 'Hi3DGen')


# ------------------------------------------------------- Hi3DGen setup executed with recorded fakes
#
# Root cause measured in benchmark-a/3 and /5: the installed cp313 `cumm_cu126-0.7.11` /
# `spconv_cu126-2.3.8` manylinux wheels already contain compiled `core_cc` extensions, but
# `pccm.utils.project_is_editable()` reports any package as an editable checkout when
# `site-packages/setup.py` or `site-packages/.gitignore` exists, and `cumm`/`spconv` then JIT-rebuild
# themselves with `ninja` against headers the binary wheel does not ship. `CUMM_DISABLE_JIT=1` and
# `SPCONV_DISABLE_JIT=1` are the packages' own switches that skip that rebuild.

HI3DGEN_SETUP_START = "if 'hi3dgen' in ENABLED_MODELS:"
HI3DGEN_GENERATION_START = '    for label in ACTIVE_LABELS:'
HI3DGEN_SHIM_START = 'def _install_xformers_sdpa_shim'
PCCM_JIT_SWITCHES = ('CUMM_DISABLE_JIT', 'SPCONV_DISABLE_JIT')


class _WeightsReached(Exception):
    """Raised by the fake weight download: setup got past every spconv gate."""


def run_hi3dgen_setup(cell: str, probe_outcome: subprocess.CompletedProcess | BaseException) -> dict:
    """Execute the generated Hi3DGen header + setup block up to the weight download, with fakes."""
    header = cell[: cell.index(HI3DGEN_SHIM_START)]
    setup = cell[cell.index(HI3DGEN_SETUP_START): cell.index(HI3DGEN_GENERATION_START)]
    calls: list[dict] = []

    def fake_run(cmd, env=None, **kwargs):
        calls.append({'kind': 'run', 'cmd': [str(part) for part in cmd], 'env': dict(env or {})})

    def fake_subprocess_run(cmd, **kwargs):
        calls.append({
            'kind': 'probe', 'cmd': [str(part) for part in cmd], 'env': dict(kwargs.get('env') or {}),
            'kwargs': kwargs,
        })
        if isinstance(probe_outcome, BaseException):
            raise probe_outcome
        return probe_outcome

    def fake_snapshot_download(**kwargs):
        calls.append({'kind': 'weights', 'environ': {name: os.environ.get(name) for name in PCCM_JIT_SWITCHES}})
        raise _WeightsReached('weights reached')

    fake_subprocess = types.SimpleNamespace(
        run=fake_subprocess_run,
        TimeoutExpired=subprocess.TimeoutExpired,
        CompletedProcess=subprocess.CompletedProcess,
    )
    hub = types.ModuleType('huggingface_hub')
    hub.snapshot_download = fake_snapshot_download
    with TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {}, clear=False), \
            mock.patch.dict(sys.modules, {'huggingface_hub': hub}):
        for name in PCCM_JIT_SWITCHES:
            os.environ.pop(name, None)
        scratch = Path(tmp)
        (scratch / 'Stable3DGen-src').mkdir()
        namespace = {
            'ENABLED_MODELS': ['hi3dgen'], 'SCRATCH_ROOT': scratch, 'REVISIONS': {}, 'os': os,
            'subprocess': fake_subprocess, 'run': fake_run, 'PYTHON': 'python3', 'HF_TOKEN': '',
            '_install_xformers_sdpa_shim': lambda: True,
        }
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            exec(compile(header + setup, 'hi3dgen_setup_cell', 'exec'), namespace)
    namespace['calls'] = calls
    namespace['printed'] = printed.getvalue()
    return namespace


class Hi3DGenSetupBehaviourTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cell = cell_starting_with(code_cell_sources(NOTEBOOK_A), HI3DGEN_HEADER)

    def test_pccm_jit_is_disabled_for_install_probe_and_in_kernel_import(self):
        ok = subprocess.CompletedProcess(
            ['python3'], 0, "pccm editable markers: ['setup.py']\nspconv smoke ok: cuda (3, 8)\n", '',
        )
        ns = run_hi3dgen_setup(self.cell, ok)
        installs = [call for call in ns['calls'] if call['kind'] == 'run' and 'install' in call['cmd']]
        probes = [call for call in ns['calls'] if call['kind'] == 'probe']
        weights = [call for call in ns['calls'] if call['kind'] == 'weights']
        self.assertTrue(installs and probes and weights, ns['calls'])
        for name in PCCM_JIT_SWITCHES:
            self.assertEqual(installs[0]['env'].get(name), '1', f'{name} missing from the spconv install env')
            self.assertEqual(probes[0]['env'].get(name), '1', f'{name} missing from the spconv probe env')
            self.assertEqual(
                weights[0]['environ'].get(name), '1',
                f'{name} is not set in the kernel before Hi3DGen imports spconv in-process',
            )
        self.assertFalse(ns['hi3d_unavailable'])
        self.assertEqual(ns['hi3d_err'], '_WeightsReached: weights reached')
        self.assertIn('spconv smoke ok: cuda (3, 8)', ns['printed'], 'The passing probe output is not logged')
        self.assertIn("pccm editable markers: ['setup.py']", ns['printed'])

    def test_probe_runs_a_real_sparse_convolution_with_bounded_time(self):
        ok = subprocess.CompletedProcess(['python3'], 0, 'spconv smoke ok: cuda (3, 8)\n', '')
        ns = run_hi3dgen_setup(self.cell, ok)
        probe = [call for call in ns['calls'] if call['kind'] == 'probe'][0]
        script = probe['cmd'][-1]
        ast.parse(script, filename='spconv_smoke')
        for needle in ('import spconv.pytorch', 'SparseConvTensor', 'SubMConv3d', "torch.cuda.is_available()"):
            self.assertIn(needle, script)
        self.assertTrue(0 < probe['kwargs'].get('timeout', 0) <= 900, 'The spconv probe is unbounded')

    def test_failed_probe_is_one_measured_skip_and_removes_the_wheel(self):
        failed = subprocess.CompletedProcess(
            ['python3'], 1, '', 'FAILED: [code=1] TensorViewBind.h.gch\nninja: build stopped: subcommand failed.\n',
        )
        ns = run_hi3dgen_setup(self.cell, failed)
        self.assertTrue(ns['hi3d_unavailable'])
        self.assertTrue(
            ns['hi3d_err'].startswith('RuntimeError: spconv_unavailable:spconv-cu126:ninja: build stopped'),
            ns['hi3d_err'],
        )
        self.assertTrue(any(call['kind'] == 'run' and 'uninstall' in call['cmd'] for call in ns['calls']))
        self.assertFalse(any(call['kind'] == 'weights' for call in ns['calls']))

    def test_probe_timeout_is_a_measured_skip(self):
        ns = run_hi3dgen_setup(self.cell, subprocess.TimeoutExpired(['python3'], 600))
        self.assertTrue(ns['hi3d_unavailable'])
        self.assertIn('spconv_unavailable:spconv-cu126:', ns['hi3d_err'])
        self.assertIn('timed out', ns['hi3d_err'])
        self.assertFalse(any(call['kind'] == 'weights' for call in ns['calls']))

    def test_xformers_sdpa_shim_returns_tensor_matching_dense_sdpa(self):
        try:
            import torch
            import torch.nn.functional as F
        except ImportError:
            fallback = '/tmp/claude-1000/-home-yacine105-t3-code-handoff-peekaplate/6605ea66-db40-4188-907a-62e90c91d4b6/scratchpad/venv-spconv/lib/python3.12/site-packages'
            if Path(fallback).is_dir() and fallback not in sys.path:
                sys.path.insert(0, fallback)
            import torch
            import torch.nn.functional as F

        # Execute shim installer in isolated namespace
        ns = {'torch': torch}
        for mod in ('xformers', 'xformers.ops', 'xformers.ops.fmha'):
            sys.modules.pop(mod, None)

        spec = importlib.util.spec_from_file_location('build_multi_model_notebooks', GENERATOR)
        gen = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gen)
        exec(gen.XFORMERS_SHIM, ns)
        installed = ns['_install_xformers_sdpa_shim']()
        self.assertFalse(installed)

        import xformers.ops as xops
        import xformers.ops.fmha as xfmha

        B, H, C = 1, 2, 8
        seqlens = [4, 6]
        M = sum(seqlens)
        torch.manual_seed(42)
        q = torch.randn(B, M, H, C)
        k = torch.randn(B, M, H, C)
        v = torch.randn(B, M, H, C)

        mask = xfmha.BlockDiagonalMask.from_seqlens(seqlens)

        # Compare with dense SDPA per block
        out1 = F.scaled_dot_product_attention(
            q[:, 0:4].transpose(1, 2), k[:, 0:4].transpose(1, 2), v[:, 0:4].transpose(1, 2)
        ).transpose(1, 2)
        out2 = F.scaled_dot_product_attention(
            q[:, 4:10].transpose(1, 2), k[:, 4:10].transpose(1, 2), v[:, 4:10].transpose(1, 2)
        ).transpose(1, 2)
        expected = torch.cat([out1, out2], dim=1)

        result = xops.memory_efficient_attention(q, k, v, mask)
        # Real xformers returns a Tensor [B, M, H, C], NOT a tuple (out,)
        self.assertIsInstance(result, torch.Tensor)
        self.assertTrue(torch.allclose(result, expected, atol=1e-5))

        # Hi3DGen and TRELLIS callers index [0] to drop batch=1: assert shape is [M, H, C]
        dropped_batch = result[0]
        self.assertEqual(dropped_batch.shape, (M, H, C))

        # Also verify unmasked call returns Tensor [B, M, H, C]
        unmasked = xops.memory_efficient_attention(q, k, v)
        self.assertIsInstance(unmasked, torch.Tensor)
        expected_unmasked = F.scaled_dot_product_attention(
            q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2)
        ).transpose(1, 2)
        self.assertTrue(torch.allclose(unmasked, expected_unmasked, atol=1e-5))


class MultiModelNotebookTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources_a = code_cell_sources(NOTEBOOK_A)
        cls.sources_b = code_cell_sources(NOTEBOOK_B)

    def test_triposg_conditioning_dtype_matches_model_dtype(self):
        assert_triposg_conditioning_dtype_matches_model(self, cell_starting_with(self.sources_a, TRIPOSG_HEADER))

    def test_triposg_repair_is_identical_in_bench_b(self):
        self.assertEqual(
            cell_starting_with(self.sources_a, TRIPOSG_HEADER),
            cell_starting_with(self.sources_b, TRIPOSG_HEADER),
            'bench-b was regenerated from a different generator state than bench-a',
        )

    def test_hi3dgen_spconv_unavailability_is_one_measured_skip(self):
        assert_hi3dgen_spconv_failure_is_a_measured_skip(
            self,
            cell_starting_with(self.sources_a, HI3DGEN_HEADER),
            cell_starting_with(self.sources_a, HI3DGEN_HEADER),
        )

    def test_hi3dgen_repair_is_identical_in_bench_b(self):
        self.assertEqual(
            cell_starting_with(self.sources_a, HI3DGEN_HEADER),
            cell_starting_with(self.sources_b, HI3DGEN_HEADER),
            'bench-b was regenerated from a different generator state than bench-a',
        )

    def test_hunyuan3d2_paint_installs_xatlas(self):
        cell = cell_starting_with(self.sources_a, HUNYUAN2_HEADER)
        self.assertIn('xatlas', cell, 'xatlas must be included in the hunyuan3d2 paint pass pip install')

    def test_hunyuan3d21_pinned_commit_and_revision(self):
        cell = cell_starting_with(self.sources_a, HUNYUAN21_HEADER)
        self.assertIn(HUNYUAN21_CODE_REV, cell, 'hunyuan3d21 must clone/checkout pinned commit 82920d64...')
        self.assertIn(HUNYUAN21_REVISION, cell, 'hunyuan3d21 must use pinned revision 0b946776...')
        self.assertIn("REVISIONS['hunyuan3d21']", cell, "REVISIONS['hunyuan3d21'] must be recorded")
        self.assertIn('hy3dshape', cell, 'hunyuan3d21 must place hy3dshape on sys.path')
        self.assertIn('snapshot_download', cell, 'hunyuan3d21 must use snapshot_download to pin weights')
        self.assertIn('hunyuan3d-dit-v2-1/*', cell, 'hunyuan3d21 must filter download to shape model subfolder')

    def test_hunyuan3d21_uses_fp16(self):
        cell = cell_starting_with(self.sources_a, HUNYUAN21_HEADER)
        self.assertIn('float16', cell, 'hunyuan3d21 pipeline must be loaded/cast in fp16')

    def test_hunyuan3d21_uses_octree_256(self):
        cell = cell_starting_with(self.sources_a, HUNYUAN21_HEADER)
        self.assertIn('octree_resolution=256', cell, 'hunyuan3d21 must run with octree_resolution=256')
        self.assertIn("mc_algo='mc'", cell, "hunyuan3d21 must run with mc_algo='mc'")

    def test_hunyuan3d21_uses_photo_projection(self):
        cell = cell_starting_with(self.sources_a, HUNYUAN21_HEADER)
        self.assertIn('bake_photographic_uv_pbr_glb', cell, 'hunyuan3d21 must use bake_photographic_uv_pbr_glb')
        self.assertIn("'pbr_photo_projection'", cell, "hunyuan3d21 appearance must be 'pbr_photo_projection'")
        self.assertIn('mobile_status', cell, 'hunyuan3d21 must handle mobile decimation status')

    def test_spar3d_pinned_commit_and_revision(self):
        cell = cell_starting_with(self.sources_a, SPAR3D_HEADER)
        self.assertIn(SPAR3D_CODE_REV, cell, 'spar3d must clone/checkout pinned commit fdc311b1...')
        self.assertIn(SPAR3D_REVISION, cell, 'spar3d must use pinned revision 5699918cb34f55cd7d828493d2725f3038313761...')
        self.assertIn("REVISIONS['spar3d']", cell, "REVISIONS['spar3d'] must be recorded")
        self.assertIn('SPAR3D.from_pretrained', cell, 'spar3d must load with SPAR3D.from_pretrained')
        self.assertIn('snapshot_download', cell, 'spar3d must use snapshot_download to pin weights')

    def test_spar3d_builds_cuda_extensions_with_sm75(self):
        cell = cell_starting_with(self.sources_a, SPAR3D_HEADER)
        self.assertIn('TORCH_CUDA_ARCH_LIST', cell, 'spar3d must set TORCH_CUDA_ARCH_LIST')
        self.assertIn('7.5', cell, 'spar3d must build for sm_75')
        self.assertIn('texture_baker', cell, 'spar3d must install texture_baker')
        self.assertIn('uv_unwrapper', cell, 'spar3d must install uv_unwrapper')
        self.assertIn('c++20', cell, 'spar3d must rewrite c++17 if pinned')

    def test_spar3d_uses_fp16_autocast_and_isolated_per_dish(self):
        cell = cell_starting_with(self.sources_a, SPAR3D_HEADER)
        self.assertIn('float16', cell, 'spar3d must use float16 on T4')
        self.assertIn('torch.autocast', cell, 'spar3d must wrap inference in torch.autocast')
        _assert_isolated_per_dish(self, cell, '/spar3d', 'SPAR3D')

    def test_spar3d_setup_failure_is_one_measured_skip(self):
        cell = cell_starting_with(self.sources_a, SPAR3D_HEADER)
        self.assertIn("status='skipped'", cell, 'spar3d setup failure must record status="skipped"')
        self.assertIn('spar3d_model is None', cell, 'spar3d must skip dishes when spar3d_model is None')

    def test_spar3d_repair_is_identical_in_bench_b(self):
        self.assertEqual(
            cell_starting_with(self.sources_a, SPAR3D_HEADER),
            cell_starting_with(self.sources_b, SPAR3D_HEADER),
            'SPAR3D runner cell differs between Benchmark A and Benchmark B',
        )

    def test_spar3d_mobile_decimation_and_export(self):
        cell = cell_starting_with(self.sources_a, SPAR3D_HEADER)
        self.assertIn('MAX_MOBILE_FACES', cell, 'spar3d must enforce MAX_MOBILE_FACES for mobile GLB')
        self.assertIn('spar3d_mobile.glb', cell, 'spar3d must export mobile GLB')
        self.assertIn('spar3d.glb', cell, 'spar3d must export raw GLB')

    def test_secret_source_searches_recursively_for_hf_token(self):
        c0 = self.sources_b[0]
        ns = {}
        exec(c0, ns)
        secret_source = ns['secret_source']
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            token_dir = root / 'level1' / 'level2' / 'level3'
            token_dir.mkdir(parents=True)
            token_file = token_dir / 'hf_token.txt'
            token_file.write_text('deep-token-value\n', encoding='utf-8')
            val, src = secret_source('HF_TOKEN', input_root=root, environ={})
            self.assertEqual(val, 'deep-token-value')
            self.assertEqual(src, 'dataset:level1/level2/level3/hf_token.txt')

    def test_trellis_missing_token_aborts_early_and_prints_tree(self):
        c0 = self.sources_b[0]
        c2 = self.sources_b[2]
        ns = {}
        exec(c0, ns)
        self.assertIn('trellis2-4b', ns['ENABLED_MODELS'])

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'ds1' / 'sub').mkdir(parents=True)
            (root / 'ds1' / 'sub' / 'test.txt').write_text('dummy')

            ns['secret_source'] = lambda name, **kw: (None, 'missing')
            tree_called = []
            ns['dump_kaggle_input_tree'] = lambda root='/kaggle/input', max_depth=3: tree_called.append((root, max_depth))

            fake_torch = mock.MagicMock()
            fake_torch.cuda.is_available.return_value = True
            fake_torch.cuda.device_count.return_value = 1
            prop = mock.MagicMock()
            prop.total_memory = 16 * 1024**3
            prop.name = 'Tesla T4'
            fake_torch.cuda.get_device_properties.return_value = prop
            fake_torch.cuda.get_device_capability.return_value = (7, 5)
            fake_torch.version.cuda = '12.1'
            fake_torch.__version__ = '2.1.0'
            with mock.patch.dict(sys.modules, {'torch': fake_torch}):
                with self.assertRaises(RuntimeError) as cm:
                    exec(c2, ns)
            self.assertIn('Aborting kernel early', str(cm.exception))
            self.assertEqual(tree_called, [('/kaggle/input', 3)])

    def test_non_trellis_missing_token_does_not_abort(self):
        c0 = self.sources_a[0]
        c2 = self.sources_a[2]
        ns = {}
        exec(c0, ns)
        self.assertNotIn('trellis2-4b', ns['ENABLED_MODELS'])

        ns['secret_source'] = lambda name, **kw: (None, 'missing')
        tree_called = []
        ns['dump_kaggle_input_tree'] = lambda root='/kaggle/input', max_depth=3: tree_called.append((root, max_depth))
        early_lines = []
        for line in c2.splitlines():
            if line.startswith('import torch') or line.startswith('if not torch.cuda'):
                break
            early_lines.append(line)
        exec('\n'.join(early_lines), ns)
        self.assertEqual(tree_called, [])

    def test_trellis_falls_back_to_food_only_cutout_and_records_receipt(self):
        trellis_cell = cell_starting_with(self.sources_b, 'def _default_trellis_pipeline_type')
        # Verify the old skip message is removed from the generated notebook
        self.assertNotIn('Skipped (plate_preserved is false or missing).', trellis_cell)
        self.assertIn('plate not preserved', trellis_cell)
        self.assertIn('plate_preserved=is_plate_preserved', trellis_cell)

        # Test receipt building records plate_preserved and plate_method
        c0 = self.sources_b[0]
        ns = {}
        exec(c0, ns)
        build_receipt = ns['build_worker_receipt']
        jm = {'job_id': 'job-18', 'dish_label': '18_choco', 'source_sha256': '0' * 64}
        in_entry = {
            'cutout_metrics': {'plate_preserved': False, 'plate_method': 'food_only_fallback'}
        }
        dish_runs = {
            '18_choco/trellis2-4b': {
                'backend': 'TRELLIS.2-4B',
                'status': 'success',
                'plate_preserved': False,
                'plate_method': 'food_only_fallback',
            }
        }
        receipt = build_receipt(jm, in_entry, dish_runs, '/tmp')
        t_model = receipt['models']['TRELLIS.2-4B']
        self.assertIs(t_model['plate_preserved'], False)
        self.assertEqual(t_model['plate_method'], 'food_only_fallback')

    def test_notebooks_are_the_generator_output_not_a_hand_edit(self):
        spec = importlib.util.spec_from_file_location('build_multi_model_notebooks', GENERATOR)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)

        with TemporaryDirectory() as tmp:
            self.assertEqual(module.main(['--out-dir', tmp]), 0)
            for committed in (NOTEBOOK_A, NOTEBOOK_B):
                regenerated = Path(tmp) / committed.name
                self.assertTrue(regenerated.is_file(), f'the generator stopped emitting {committed.name}')
                self.assertEqual(
                    json.loads(regenerated.read_text(encoding='utf-8')),
                    json.loads(committed.read_text(encoding='utf-8')),
                    f'{committed.name} is not the current generator output; regenerate it instead of '
                    'editing notebook JSON by hand',
                )

if __name__ == '__main__':
    unittest.main()