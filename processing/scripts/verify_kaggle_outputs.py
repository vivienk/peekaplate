"""Verify private Kaggle dish-3D output directories: GLB structure, digests, cutout provenance.

This is a read-only forensic gate for downloaded Kaggle result trees. It never renders,
publishes or repairs an artifact, and it treats every output as private R&D
(`publication_eligible: false`).

Per dish subdirectory (a directory that contains `job_manifest.json` or
`worker_output.json`) the verifier records measured numbers, not claims:

* every `*.glb`: glTF magic, version, declared length, JSON/BIN chunk layout, strict JSON,
  primitive attributes, accessor counts, index consistency, buffer bounds, embedded texture
  bytes, PNG/JPEG/WebP magic and pixel dimensions, non-finite POSITION/NORMAL/TEXCOORD_0
  values, declared accessor `min`/`max` consistency, degenerate faces and watertight edge
  counts; every artifact also carries a measured `quality` block (see below);
* sha256 of every `.glb`/`.png` artifact compared with every digest declared in
  `job_manifest.json`, `worker_output.json` and the source `manifest.json`, including
  declared byte sizes and conflicting declarations (dish `*.json` metadata is verified too
  whenever a digest for it is declared);
* `input_image.png` vs `cutout_rgba.png` (or the `*_cutout.png` variant): dimensions, alpha
  coverage, bounding box, claimed coverage/bbox deltas, and that every cutout pixel with
  alpha > 0 keeps the source RGB and lies inside the source's opaque region;
* `manifest.json` top level: `publication_eligible` must be `false`, plus the model list,
  per-dish run counts and any dish whose run status is not `success`.

Structural GLB validation reuses `validate_glb` (`peekaplate_processing.generate_model`,
the repository's Tripo gate, which owns `MAX_GLB_BYTES`) and
`check_watertight_edges` (`peekaplate_processing.multi_model_3d`). The task brief located
both in `multi_model_3d`; only the edge check lives there, so each is imported from its
owning module. Granular probes run in addition to `validate_glb` so a failure is reported
as an explainable measurement instead of one opaque message.

Exit code is `0` only when no finding of severity `error` was recorded; `1` otherwise
(warnings alone keep exit code `0` and stay listed in the report). `trimesh` is not
installed and is not imported: geometry is decoded from the BIN chunk with `numpy`.

Mesh quality is a separate, documented measurement block, not a structural verdict:

* per artifact `quality` (also mirrored in `measurements.indices` for the existing keys):
  vertex and triangle counts, boundary edges (undirected edges used by one triangle),
  non-manifold edges (used by three or more), degenerate triangles (zero area at the
  documented tolerance, or a repeated vertex index), texture count with pixel dimensions and
  mime type, and bytes-per-face;
* per source `quality`: medians and watertight/open-shell counts over every measured GLB,
  plus how many artifacts could not be measured and why;
* the integrity pass/fail rule is unchanged: quality numbers never raise an error and never
  turn an error into a pass, so a structurally valid but visually thin/open mesh still exits
  `0` and is graded as an open shell instead of being called good.

Deliberate scope limits:

* A texture is required when the run declaration implies one (`appearance` in
  `pbr_texture` / `captured_photo_uv_pbr`, or `has_texture: true`) or when the GLB already
  embeds images. Geometry-only and vertex-colour backends (`geometry_only`,
  `vertex_color`) legitimately export GLBs without UVs, normals or textures, so those are
  reported as measurements, not failures (verified against the 2026-11-22 TRELLIS/TripoSR
  trees).
* Non-watertight meshes are reported as measured `warning` numbers: edge counts are a
  quality metric, not a structural defect, and open boundaries were present in V20-style
  exports (`0` in Kaggle V31).
* Preview/scene boilerplate at the source root (`comparison_sheet.png`,
  `docker_blueprint/*`, `*.zip`, `*.html`) is not hashed: this gate covers dish artifacts.
"""

from __future__ import annotations

import argparse
import hashlib
from io import BytesIO
import json
import statistics
import struct
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image

from peekaplate_processing.dish_3d_studio import _safe_child_path
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.generate_model import MAX_GLB_BYTES, validate_glb
from peekaplate_processing.multi_model_3d import check_watertight_edges

SCHEMA_VERSION = 1
REPORT_LABEL = 'private Kaggle dish-3D output verification (read-only, publication_eligible: false)'

GLB_JSON_CHUNK = 0x4E4F534A
GLB_BIN_CHUNK = 0x004E4942
ATTRIBUTE_COMPONENTS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT2': 4, 'MAT3': 9, 'MAT4': 16}
COMPONENT_TYPES = {
    5120: ('i1', 1), 5121: ('u1', 1), 5122: ('i2', 2), 5123: ('u2', 2), 5125: ('u4', 4), 5126: ('f4', 4),
}
#: Primitive attributes decoded from the BIN chunk.
FLOAT_ATTRIBUTES = ('POSITION', 'NORMAL', 'TEXCOORD_0')
#: Declared appearances that promise an embedded base-colour texture.
TEXTURED_APPEARANCES = frozenset({'pbr_texture', 'captured_photo_uv_pbr'})
#: Declared appearances that promise per-vertex colour instead of a texture atlas.
GEOMETRY_ONLY_APPEARANCES = frozenset({'geometry_only', 'vertex_color'})
IMAGE_MAGIC = {
    b'\x89PNG\r\n\x1a\n': 'png',
    b'\xff\xd8\xff': 'jpeg',
    b'RIFF': 'webp',
}
MIME_MAGIC = {'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp'}
#: Claim tolerance between measured coverage/bounding box and the recorded cutout metrics.
COVERAGE_TOLERANCE_PP = 1.0
BBOX_TOLERANCE_PX = 2
#: Absolute tolerance for a declared accessor `min`/`max` versus the decoded values.
BOUNDS_TOLERANCE = 1e-4
#: Bounded console output.
MAX_PRINTED_FINDINGS = 24
#: Declared run statuses grouped by what they mean for the artifact tree.
STATUS_OK = frozenset({'success', 'available', 'complete', 'completed'})
STATUS_SKIPPED = frozenset({'skipped', 'not_run', 'pending', 'missing', 'not_available', 'none'})
#: Severity ranking used when two declarations describe the same run.
_STATUS_RANK = {'ok': 0, 'skipped': 1, 'failed': 2}
#: Version of the measured (not verdict) mesh-quality block.
QUALITY_SCHEMA_VERSION = 1
#: Absolute degeneracy floor for a triangle's area, in the GLB's own model units squared.
#: A triangle at or below this floor encloses no surface: it cannot shade, cast or occlude.
#: The floor is deliberately tiny so a legitimately small face is never retroactively "bad";
#: a NaN/inf coordinate is *not* counted here (that is already an `glb_attribute_nonfinite`
#: error), because an unmeasurable face is not the same thing as a zero-area face.
DEGENERATE_AREA_TOLERANCE = 1e-12
#: Bounded per-dish quality output in the console summary.
MAX_PRINTED_QUALITY_LINES = 24
#: How each quality number is defined, so a reader can reproduce it instead of trusting a label.
QUALITY_DEFINITIONS = {
    'boundary_edges': 'undirected vertex-pair edges used by exactly one triangle (an open shell)',
    'nonmanifold_edges': ('undirected vertex-pair edges used by three or more triangles; a '
                          'duplicated coincident face lands here because each of its edges is then '
                          'used four times'),
    'degenerate_triangles': ('triangle area in model units squared <= '
                             f'{DEGENERATE_AREA_TOLERANCE} or a repeated vertex index'),
    'watertight': 'measured boundary_edges == 0 and nonmanifold_edges == 0 and triangles > 0',
    'welded_vertices': ('distinct POSITION values among referenced vertices, compared exactly '
                        'after folding -0.0 into 0.0; UV/normal seams split one position into '
                        'several glTF vertices, so index topology overstates open edges'),
    'welded_boundary_edges': 'boundary_edges recomputed on welded vertex ids',
    'welded_nonmanifold_edges': 'nonmanifold_edges recomputed on welded vertex ids',
    'welded_watertight': ('welded_boundary_edges == 0 and welded_nonmanifold_edges == 0 and '
                          'triangles > 0; null when any referenced position is non-finite'),
    'shell_count': ('connected components of triangles that share a welded vertex; 1 means the '
                    'plate and food are one fused surface, 2+ large shells means separate objects'),
    'main_shell_triangle_pct': 'triangles in the largest shell / all triangles x 100 (2 decimals)',
    'shells_ge_1pct': 'shells holding at least 1% of the triangles',
    'bytes_per_face': 'GLB file bytes divided by triangles (rounding: 3 decimals)',
    'texture_pixels': 'decoded pixel width x height of each embedded image',
    'scope': ('the first mesh\'s first primitive, the same one structural validation reads; a '
              'multi-primitive GLB is not summed here'),
    'verdict_effect': ('none: quality is a measurement, so it never adds an error finding and '
                       'never converts an error finding into a pass'),
}


def _status_state(status: str) -> str:
    """Classify one declared run status as `ok`, `skipped` or `failed`."""
    normalised = status.strip().lower()
    if normalised in STATUS_OK:
        return 'ok'
    if normalised in STATUS_SKIPPED:
        return 'skipped'
    return 'failed'


class UnsafeArtifactPath(ValueError):
    """A declared artifact path is absolute, empty, or escapes its source directory."""


def _finding_check(finding_id: str) -> str:
    """Classify a finding id into the check that raised it (machine-readable grouping)."""
    if finding_id.startswith('image_'):
        return 'image'
    if finding_id.startswith('glb_') or finding_id.startswith('artifact_'):
        return 'artifact'
    if finding_id.startswith('run_status_'):
        return 'run_status'
    if finding_id in ('manifest_missing', 'manifest_malformed', 'manifest_publication_eligible',
                      'job_manifest_publication_eligible', 'worker_output_publication_eligible',
                      'source_missing', 'dish_missing'):
        return 'manifest'
    return 'metadata'


def _finding(finding_id: str, severity: str, subject: str, detail: str,
             measured: dict[str, Any] | None = None) -> dict[str, Any]:
    record: dict[str, Any] = {'id': finding_id, 'check': _finding_check(finding_id),
                              'severity': severity, 'subject': subject, 'detail': detail}
    if measured:
        record['measured'] = measured
    return record


def _error(finding_id: str, subject: str, detail: str,
           measured: dict[str, Any] | None = None) -> dict[str, Any]:
    return _finding(finding_id, 'error', subject, detail, measured)


def _warning(finding_id: str, subject: str, detail: str,
             measured: dict[str, Any] | None = None) -> dict[str, Any]:
    return _finding(finding_id, 'warning', subject, detail, measured)


def _sha256_file(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _rel(source_dir: Path, path: Path) -> str:
    return path.relative_to(source_dir).as_posix()


def _declared_path(source_dir: Path, rel_path: object, *, subject: str) -> Path:
    """Resolve a declaration-relative path, rejecting empty, absolute and traversal forms."""
    if not isinstance(rel_path, str) or not rel_path.strip() or '\x00' in rel_path:
        raise UnsafeArtifactPath(f'Invalid declared artifact path: {rel_path!r}')
    candidate = Path(rel_path)
    if candidate.is_absolute() or rel_path.startswith(('/', '\\')) or '..' in candidate.parts:
        raise UnsafeArtifactPath(f'Declared artifact path escapes {subject}: {rel_path!r}')
    resolved = _safe_child_path(source_dir, rel_path)
    if not resolved.is_relative_to(source_dir.resolve()):
        raise UnsafeArtifactPath(f'Declared artifact path escapes {subject}: {rel_path!r}')
    return resolved


def _declared_input_digest(payload: dict[str, Any]) -> tuple[str, Any] | None:
    """Return `(key, digest)` for the staged `input_image.png` bytes.

    Newer runs record two identities: `input_image_sha256` for the bytes actually written to the
    job directory (verbatim source copy when that is lossless) and `source_sha256` for the
    original upload. A re-encoded stage makes them differ, so the staged key is preferred and
    `source_sha256` is only the legacy fallback for manifests written before that split.
    """
    for key in ('input_image_sha256', 'source_sha256'):
        if payload.get(key) is not None:
            return key, payload[key]
    return None


def _load_json(path: Path, findings: list[dict[str, Any]], *, subject: str) -> dict[str, Any] | None:
    """Load one dish/source JSON document; a malformed document is an error finding."""
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        findings.append(_error('metadata_unreadable', subject, f'{type(exc).__name__}: {exc}'))
        return None
    if not isinstance(payload, dict):
        findings.append(_error('metadata_unreadable', subject, 'JSON document is not an object'))
        return None
    return payload


class Declarations:
    """Every digest/appearance claim made about one source tree, keyed by source-relative path."""

    def __init__(self, source_dir: Path, findings: list[dict[str, Any]]) -> None:
        self.source_dir = source_dir
        self.findings = findings
        self.digests: dict[str, dict[str, Any]] = {}
        self.appearances: dict[str, str | None] = {}
        self.missing_declared: dict[str, str] = {}
        self.texture_claims: dict[str, bool] = {}
        self.job_payloads: dict[str, dict[str, Any]] = {}
        self.worker_payloads: dict[str, dict[str, Any]] = {}

    def digest(self, rel_path: object, digest: object, origin: str, *, size: object = None) -> None:
        """Record one declared sha256 (and optional byte size) for a source-relative path."""
        if not isinstance(rel_path, str) or not rel_path:
            return
        if not isinstance(digest, str) or len(digest) != 64:
            self.findings.append(_error('artifact_digest_invalid', origin,
                                        f'Malformed sha256 declaration {digest!r}'))
            return
        known = self.digests.get(rel_path)
        if known is None:
            self.digests[rel_path] = {'sha256': digest.lower(), 'bytes': size, 'origin': origin}
            return
        if known['sha256'] != digest.lower():
            self.findings.append(_error(
                'artifact_digest_conflict', rel_path,
                f'Declared sha256 differs between {known["origin"]} and {origin}',
                {'declared': known['sha256'], 'other': digest.lower()},
            ))
            return
        if known['bytes'] is None and isinstance(size, int):
            known['bytes'] = size

    def declare_path(self, rel: object, origin: str) -> str | None:
        """Validate a declared relative path; return its normalised form when it is usable."""
        try:
            resolved = _declared_path(self.source_dir, rel, subject=origin)
        except UnsafeArtifactPath as exc:
            self.findings.append(_error('artifact_unsafe_path', origin, str(exc), {'path': rel}))
            return None
        rel_str = _rel(self.source_dir, resolved)
        if not resolved.exists():
            self.missing_declared.setdefault(rel_str, origin)
        return rel_str


def _collect_declarations(source_dir: Path, manifest: dict[str, Any] | None,
                          dishes: list[Path], findings: list[dict[str, Any]]) -> Declarations:
    """Gather every declared digest, byte size and appearance from the three manifests."""
    declarations = Declarations(source_dir, findings)

    def add_artifacts(entries: object, origin: str) -> None:
        for art in entries or []:
            if not isinstance(art, dict):
                continue
            rel = declarations.declare_path(art.get('path'), origin)
            if rel is not None:
                declarations.digest(rel, art.get('sha256'), origin, size=art.get('bytes'))

    if manifest is not None:
        for group in ('inputs', 'runs_3d'):
            for key, record in sorted((manifest.get(group) or {}).items()):
                if not isinstance(record, dict):
                    continue
                origin = f'manifest.json:{group}.{key}'
                add_artifacts(record.get('artifacts') or [], origin)
                if record.get('mobile_glb_path') is not None:
                    declarations.declare_path(record.get('mobile_glb_path'), f'{origin}.mobile_glb_path')
                for art in record.get('artifacts') or []:
                    if not isinstance(art, dict) or not isinstance(art.get('path'), str):
                        continue
                    try:
                        rel_path = _declared_path(source_dir, art['path'], subject=origin)
                    except UnsafeArtifactPath:
                        continue
                    rel = _rel(source_dir, rel_path)
                    if isinstance(record.get('appearance'), str):
                        declarations.appearances.setdefault(rel, record['appearance'])
                    metrics = record.get('metrics')
                    if isinstance(metrics, dict) and isinstance(metrics.get('has_texture'), bool):
                        declarations.texture_claims.setdefault(rel, metrics['has_texture'])
        add_artifacts((manifest.get('extras') or []), 'manifest.json:extras')

    for dish_dir in dishes:
        label = dish_dir.name
        job_manifest = dish_dir / 'job_manifest.json'
        if job_manifest.is_file():
            payload = _load_json(job_manifest, findings, subject=_rel(source_dir, job_manifest))
            if payload is not None:
                declarations.job_payloads[label] = payload
                input_name = payload.get('input_filename')
                input_rel = (f'{label}/{input_name}'
                             if isinstance(input_name, str) and '/' not in input_name and input_name
                             else f'{label}/input_image.png')
                if payload.get('input_image_sha256') is not None or payload.get('source_sha256') is not None:
                    key, digest = _declared_input_digest(payload)
                    declarations.digest(input_rel, digest,
                                        f'{label}/job_manifest.json:{key}')
                if payload.get('cutout_sha256') is not None:
                    declarations.digest(f'{label}/cutout_rgba.png', payload['cutout_sha256'],
                                        f'{label}/job_manifest.json:cutout_sha256')
                for profile in payload.get('export_profiles') or {}:
                    if profile not in ('raw', 'mobile'):
                        findings.append(_warning('metadata_unknown_export_profile',
                                                 f'{label}/job_manifest.json',
                                                 f'Unknown export profile {profile!r}'))
        worker_output = dish_dir / 'worker_output.json'
        if worker_output.is_file():
            payload = _load_json(worker_output, findings, subject=_rel(source_dir, worker_output))
            if payload is not None:
                declarations.worker_payloads[label] = payload
                if payload.get('input_image_sha256') is not None or payload.get('source_sha256') is not None:
                    key, digest = _declared_input_digest(payload)
                    declarations.digest(f'{label}/input_image.png', digest,
                                        f'{label}/worker_output.json:{key}')
                if payload.get('cutout_sha256') is not None:
                    declarations.digest(f'{label}/cutout_rgba.png', payload['cutout_sha256'],
                                        f'{label}/worker_output.json:cutout_sha256')
                for model, record in sorted((payload.get('models') or {}).items()):
                    if not isinstance(record, dict):
                        continue
                    for key in ('raw_glb', 'mobile_glb'):
                        entry = record.get(key)
                        if not isinstance(entry, dict) or entry.get('path') is None:
                            continue
                        origin = f'{label}/worker_output.json:models.{model}.{key}'
                        rel = declarations.declare_path(entry.get('path'), origin)
                        if rel is not None:
                            declarations.digest(rel, entry.get('sha256'), origin, size=entry.get('bytes'))
                            if isinstance(record.get('appearance'), str):
                                declarations.appearances.setdefault(rel, record['appearance'])
                            if isinstance(entry.get('has_texture'), bool):
                                declarations.texture_claims.setdefault(rel, entry['has_texture'])
    return declarations

def _decode_accessor(doc: dict[str, Any], bin_chunk: bytes,
                     index: object) -> tuple[np.ndarray, dict[str, Any]]:
    """Decode one glTF accessor from the BIN chunk into a `(count, components)` array."""
    accessors = doc.get('accessors')
    views = doc.get('bufferViews')
    if not isinstance(accessors, list) or not isinstance(views, list):
        raise ValueError('document has no accessors/bufferViews arrays')
    if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(accessors):
        raise ValueError(f'accessor index {index!r} is out of range')
    accessor = accessors[index]
    if not isinstance(accessor, dict):
        raise ValueError(f'accessor {index} is not an object')
    component_type = accessor.get('componentType')
    if component_type not in COMPONENT_TYPES:
        raise ValueError(f'accessor {index} has unsupported componentType {component_type!r}')
    dtype, component_size = COMPONENT_TYPES[component_type]
    kind = accessor.get('type')
    if kind not in ATTRIBUTE_COMPONENTS:
        raise ValueError(f'accessor {index} has unsupported type {kind!r}')
    components = ATTRIBUTE_COMPONENTS[kind]
    count = accessor.get('count')
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        raise ValueError(f'accessor {index} has invalid count {count!r}')
    view_index = accessor.get('bufferView')
    if not isinstance(view_index, int) or isinstance(view_index, bool) or not 0 <= view_index < len(views):
        raise ValueError(f'accessor {index} has no decodable bufferView')
    view = views[view_index]
    if not isinstance(view, dict):
        raise ValueError(f'bufferView {view_index} is not an object')
    view_offset = view.get('byteOffset', 0)
    view_length = view.get('byteLength')
    accessor_offset = accessor.get('byteOffset', 0)
    if (not isinstance(view_offset, int) or isinstance(view_offset, bool)
            or not isinstance(view_length, int) or isinstance(view_length, bool)
            or not isinstance(accessor_offset, int) or isinstance(accessor_offset, bool)
            or view_offset < 0 or accessor_offset < 0 or view_length <= 0):
        raise ValueError(f'accessor {index} has invalid bufferView bounds')
    if view_offset + view_length > len(bin_chunk):
        raise ValueError(f'bufferView {view_index} exceeds the BIN chunk')
    natural = component_size * components
    stride = view.get('byteStride') or natural
    if not isinstance(stride, int) or isinstance(stride, bool) or stride < natural:
        raise ValueError(f'bufferView {view_index} has invalid byteStride {stride!r}')
    info: dict[str, Any] = {
        'count': count,
        'type': kind,
        'component_type': component_type,
        'byte_stride': stride,
        'buffer_view': view_index,
    }
    if count == 0:
        return np.zeros((0, components), dtype=np.dtype(dtype)), info
    base = view_offset + accessor_offset
    end = base + stride * (count - 1) + natural
    if end > view_offset + view_length or end > len(bin_chunk):
        raise ValueError(f'accessor {index} reads past its bufferView')
    array = np.ndarray(shape=(count, components), dtype=np.dtype(dtype), buffer=bin_chunk,
                       offset=base, strides=(stride, component_size))
    return array, info


def _vec(values: object) -> list[float] | None:
    """Render a numeric vector as JSON-safe floats (non-finite values stay visible as strings)."""
    try:
        array = np.asarray(values, dtype=np.float64).reshape(-1)
    except (TypeError, ValueError):
        return None
    return [float(value) if np.isfinite(value) else str(float(value)) for value in array]


def _image_dimensions(payload: bytes) -> tuple[int | None, int | None]:
    """Decode an embedded image's pixel dimensions; an unreadable payload stays `(None, None)`."""
    try:
        with Image.open(BytesIO(payload)) as image:
            width, height = image.size
            return int(width), int(height)
    except (OSError, ValueError, Image.DecompressionBombError):
        return None, None


def _image_magic(payload: bytes) -> tuple[str | None, dict[str, Any]]:
    """Return the detected embedded image format for one image byte string."""
    for magic, name in IMAGE_MAGIC.items():
        if payload.startswith(magic):
            return name, {'bytes': len(payload), 'magic': name}
    return None, {'bytes': len(payload), 'magic': payload[:4].hex()}


def _check_declared_bounds(doc: dict[str, Any], index: object, name: str, array: np.ndarray,
                           rel: str, findings: list[dict[str, Any]]) -> None:
    """Compare a declared accessor `min`/`max` with the decoded values when both exist."""
    accessors = doc.get('accessors') or []
    if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(accessors):
        return
    accessor = accessors[index]
    if not isinstance(accessor, dict):
        return
    for key, reducer in (('min', np.min), ('max', np.max)):
        declared = accessor.get(key)
        if not isinstance(declared, list) or not declared:
            continue
        try:
            declared_values = np.asarray([float(value) for value in declared], dtype=np.float64)
        except (TypeError, ValueError):
            findings.append(_error('glb_accessor_bounds_nonfinite', rel,
                                   f'{name} accessor declares non-numeric {key}',
                                   {'attribute': name, 'key': key}))
            continue
        if not np.isfinite(declared_values).all():
            findings.append(_error('glb_accessor_bounds_nonfinite', rel,
                                   f'{name} accessor declares a non-finite {key} value',
                                   {'attribute': name, 'key': key, 'declared': _vec(declared_values)}))
            continue
        if array.size == 0 or array.shape[1] != declared_values.size:
            continue
        values = array.astype(np.float64)
        rows = values[np.isfinite(values).all(axis=1)]
        if rows.size == 0:
            continue
        measured = reducer(rows, axis=0)
        tolerance = BOUNDS_TOLERANCE * np.maximum(1.0, np.abs(declared_values))
        if not np.all(np.abs(measured - declared_values) <= tolerance):
            findings.append(_error(
                'glb_accessor_bounds_inconsistent', rel,
                f'{name} accessor declares {key} {_vec(declared_values)} but the decoded values give '
                f'{_vec(measured)}',
                {'attribute': name, 'key': key, 'declared': _vec(declared_values), 'measured': _vec(measured)},
            ))


def _inspect_textures(doc: dict[str, Any], images: list[Any], bin_chunk: bytes, rel: str,
                      findings: list[dict[str, Any]]) -> dict[str, Any]:
    """Validate every embedded image payload and report the aggregate texture state."""
    views = doc.get('bufferViews') if isinstance(doc.get('bufferViews'), list) else []
    textures: list[dict[str, Any]] = []
    state = 'absent'
    for position, image in enumerate(images):
        entry: dict[str, Any] = {'index': position}
        if not isinstance(image, dict):
            findings.append(_error('glb_texture_invalid', rel, f'images[{position}] is not an object'))
            state = 'invalid'
            continue
        if 'uri' in image:
            findings.append(_error('glb_texture_invalid', rel,
                                   f'images[{position}] uses a uri instead of embedded bytes'))
            state = 'invalid'
            continue
        view_index = image.get('bufferView')
        if (not isinstance(view_index, int) or isinstance(view_index, bool)
                or not 0 <= view_index < len(views) or not isinstance(views[view_index], dict)):
            findings.append(_error('glb_texture_buffer_invalid', rel,
                                   f'images[{position}] references bufferView {view_index!r}',
                                   {'buffer_view': view_index}))
            state = 'invalid'
            continue
        view = views[view_index]
        offset = view.get('byteOffset', 0)
        length = view.get('byteLength')
        entry['buffer_view'] = view_index
        if (not isinstance(offset, int) or isinstance(offset, bool) or offset < 0
                or not isinstance(length, int) or isinstance(length, bool) or length <= 0
                or offset + length > len(bin_chunk)):
            findings.append(_error('glb_texture_buffer_invalid', rel,
                                   f'images[{position}] bufferView range {offset}+{length} is outside the '
                                   f'{len(bin_chunk)}-byte BIN chunk',
                                   {'buffer_view': view_index, 'byte_offset': offset, 'byte_length': length}))
            state = 'invalid'
            continue
        payload = bin_chunk[offset:offset + length]
        magic, info = _image_magic(payload)
        width, height = _image_dimensions(payload)
        entry.update({'bytes': length, 'detected_magic': magic, 'mime_type': image.get('mimeType'),
                      'width': width, 'height': height})
        expected = MIME_MAGIC.get(image.get('mimeType'))
        if magic is None or length < 16:
            findings.append(_error('glb_texture_invalid', rel,
                                   f'images[{position}] is not PNG/JPEG/WebP ({length} bytes, prefix '
                                   f'{payload[:4].hex()})',
                                   {'buffer_view': view_index, 'bytes': length, 'prefix': payload[:4].hex()}))
            state = 'invalid'
        elif expected is not None and expected != magic:
            findings.append(_warning(
                'glb_texture_mime_mismatch', rel,
                f'images[{position}] declares {image.get("mimeType")!r} but the payload is {magic}',
                {'declared': image.get('mimeType'), 'detected': magic},
            ))
        if state == 'absent':
            state = 'valid'
        textures.append(entry)
    return {'state': state, 'textures': textures}


def _yes_no(value: bool | None) -> str:
    return '-' if value is None else ('yes' if value else 'no')


def _shell_triangle_sizes(faces: np.ndarray, vertex_count: int) -> list[int]:
    """Triangle count of every connected shell (shared welded vertex), largest first.

    Vectorised min-label propagation with pointer jumping: no recursion and no Python loop per
    triangle, so a ~300k-face TRELLIS mesh measures in well under a second.
    """
    if not len(faces):
        return []
    a = np.concatenate([faces[:, 0], faces[:, 1], faces[:, 2]])
    b = np.concatenate([faces[:, 1], faces[:, 2], faces[:, 0]])
    labels = np.arange(vertex_count, dtype=np.int64)
    while True:
        lowest = np.minimum(labels[a], labels[b])
        updated = labels.copy()
        np.minimum.at(updated, a, lowest)
        np.minimum.at(updated, b, lowest)
        while True:
            jumped = updated[updated]
            if np.array_equal(jumped, updated):
                break
            updated = jumped
        if np.array_equal(updated, labels):
            break
        labels = updated
    counts = np.bincount(labels[faces[:, 0]], minlength=vertex_count)
    return sorted((int(count) for count in counts if count), reverse=True)


def _welded_topology(positions: np.ndarray, faces: np.ndarray) -> dict[str, Any]:
    """Edge and shell topology after welding coincident positions (exact, -0.0 == 0.0)."""
    block: dict[str, Any] = {
        'welded_reason': None,
        'welded_vertices': None,
        'welded_boundary_edges': None,
        'welded_nonmanifold_edges': None,
        'welded_watertight': None,
        'shell_count': None,
        'main_shell_triangle_pct': None,
        'shells_ge_1pct': None,
        'shell_triangle_sizes_top5': None,
    }
    if not len(faces):
        block['welded_reason'] = 'no triangles'
        return block
    referenced = np.unique(faces.reshape(-1))
    if not np.isfinite(positions[referenced]).all():
        block['welded_reason'] = 'non-finite POSITION values: welding would be meaningless'
        return block
    folded = positions.astype(np.float64) + 0.0  # folds -0.0 into 0.0 before exact comparison
    _, weld = np.unique(folded, axis=0, return_inverse=True)
    weld = np.asarray(weld, dtype=np.int64).reshape(-1)
    welded_faces = weld[faces]
    watertight, boundary, nonmanifold = check_watertight_edges(welded_faces)
    sizes = _shell_triangle_sizes(welded_faces, int(weld.max()) + 1)
    total = int(len(faces))
    block.update({
        'welded_vertices': int(len(np.unique(weld[referenced]))),
        'welded_boundary_edges': int(boundary),
        'welded_nonmanifold_edges': int(nonmanifold),
        'welded_watertight': bool(watertight),
        'shell_count': len(sizes),
        'main_shell_triangle_pct': round(100.0 * sizes[0] / total, 2) if sizes else None,
        'shells_ge_1pct': sum(1 for size in sizes if size * 100 >= total),
        'shell_triangle_sizes_top5': sizes[:5],
    })
    return block


def _mesh_quality(positions: np.ndarray | None, faces: np.ndarray | None, *,
                  artifact_bytes: int | None, textures: list[dict[str, Any]]) -> dict[str, Any]:
    """Measure one mesh's quality numbers; a measurement block, never a verdict.

    Every number is derived from the decoded BIN chunk, so a model that looks wrong to a human
    still produces a number a reviewer can argue with. `measured: false` (with a `reason`) marks
    an artifact whose geometry could not be decoded; that gap is reported, never scored as good.
    """
    pixels = [[entry.get('width'), entry.get('height')] for entry in textures]
    block: dict[str, Any] = {
        'schema_version': QUALITY_SCHEMA_VERSION,
        'measured': False,
        'reason': None,
        'vertices': None,
        'triangles': None,
        'boundary_edges': None,
        'nonmanifold_edges': None,
        'degenerate_triangles': None,
        'degenerate_repeated_index_triangles': None,
        'watertight': None,
        'texture_count': len(textures),
        'texture_pixels': pixels,
        'texture_mime_types': [entry.get('mime_type') for entry in textures],
        'bytes_per_face': None,
        'definitions': QUALITY_DEFINITIONS,
    }
    block.update(_welded_topology(np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64)))
    block['welded_reason'] = 'geometry was not decoded'
    if positions is None:
        block['reason'] = 'POSITION accessor was not decoded'
        return block
    block['vertices'] = int(positions.shape[0])
    if faces is None:
        block['reason'] = 'no index buffer: the primitive has no explicit triangle list'
        return block
    block['triangles'] = int(faces.shape[0])
    watertight, boundary, nonmanifold = check_watertight_edges(faces)
    block['boundary_edges'] = int(boundary)
    block['nonmanifold_edges'] = int(nonmanifold)
    block['watertight'] = bool(watertight)
    block.update(_welded_topology(positions, faces.astype(np.int64)))
    repeated_index = ((faces[:, 0] == faces[:, 1]) | (faces[:, 1] == faces[:, 2])
                      | (faces[:, 0] == faces[:, 2]))
    block['degenerate_repeated_index_triangles'] = int(np.sum(repeated_index))
    block['degenerate_triangles'] = int(np.sum(repeated_index))
    if len(faces):
        corners = positions.astype(np.float64)[faces]
        cross = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
        area = 0.5 * np.linalg.norm(cross, axis=1)
        zero_area = area <= DEGENERATE_AREA_TOLERANCE  # NaN (non-finite) stays False, never zero
        # The union, not the larger of the two: a repeated index is degenerate even when its
        # coordinates are non-finite (those faces are already an `glb_attribute_nonfinite` error).
        block['degenerate_triangles'] = int(np.sum(zero_area | repeated_index))
    block['measured'] = True
    if artifact_bytes and block['triangles']:
        block['bytes_per_face'] = round(artifact_bytes / block['triangles'], 3)
    return block


def _inspect_glb(path: Path, rel: str, *, appearance: str | None, texture_expected: bool | None,
                 declared: dict[str, Any] | None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Inspect one `.glb`; return a measurement record plus every finding raised about it."""
    findings: list[dict[str, Any]] = []
    record: dict[str, Any] = {
        'path': rel,
        'bytes': None,
        'sha256': None,
        'declared_sha256': (declared or {}).get('sha256'),
        'declared_bytes': (declared or {}).get('bytes'),
        'declared_origin': (declared or {}).get('origin'),
        'digest': 'missing',
        'appearance': appearance,
        'declared_texture_expectation': texture_expected,
        'measurements': {},
        'quality': _mesh_quality(None, None, artifact_bytes=None, textures=[]),
        'passed': False,
    }
    try:
        raw = path.read_bytes()
    except OSError as exc:
        findings.append(_error('artifact_unreadable', rel, f'{type(exc).__name__}: {exc}'))
        return record, findings
    record['bytes'] = len(raw)
    record['sha256'] = hashlib.sha256(raw).hexdigest()

    if declared is None:
        findings.append(_error('artifact_digest_missing', rel,
                               'No manifest, job_manifest or worker_output declares a digest for this artifact'))
    elif record['declared_sha256'] == record['sha256']:
        record['digest'] = 'match'
    else:
        record['digest'] = 'mismatch'
        findings.append(_error('artifact_digest_mismatch', rel,
                               'On-disk sha256 differs from every declared digest',
                               {'declared': record['declared_sha256'], 'measured': record['sha256']}))
    declared_bytes = record['declared_bytes']
    if isinstance(declared_bytes, int) and declared_bytes != record['bytes']:
        findings.append(_error('artifact_size_mismatch', rel,
                               f'Declared {declared_bytes} bytes, file has {record["bytes"]}',
                               {'declared': declared_bytes, 'measured': record['bytes']}))

    measurements: dict[str, Any] = record['measurements']
    measurements['bytes'] = len(raw)
    if len(raw) > MAX_GLB_BYTES:
        findings.append(_error('glb_oversized', rel, f'{len(raw)} bytes exceeds the {MAX_GLB_BYTES}-byte limit'))
        return record, findings

    try:
        measurements['reused_validate_glb'] = validate_glb(raw)
    except ExtractionError as exc:
        findings.append(_error('glb_structural_validation_failed', rel, f'validate_glb: {exc}'))

    if len(raw) < 12 or raw[:4] != b'glTF':
        findings.append(_error('glb_magic_invalid', rel,
                               f'First bytes are {raw[:4]!r}, expected b"glTF"',
                               {'prefix': raw[:4].hex()}))
        return record, findings
    version, declared_length = struct.unpack_from('<II', raw, 4)
    measurements['version'] = version
    measurements['declared_length'] = declared_length
    if version != 2:
        findings.append(_error('glb_version_unsupported', rel, f'glTF version {version}, expected 2'))
    if declared_length != len(raw):
        findings.append(_error('glb_length_mismatch', rel,
                               f'Header declares {declared_length} bytes, file has {len(raw)}',
                               {'declared': declared_length, 'measured': len(raw)}))
        if declared_length > len(raw):
            return record, findings

    chunks: list[tuple[int, bytes]] = []
    offset = 12
    while offset < len(raw):
        if offset + 8 > len(raw):
            findings.append(_error('glb_chunk_invalid', rel, 'Truncated chunk header'))
            return record, findings
        size, kind = struct.unpack_from('<II', raw, offset)
        offset += 8
        if size % 4 or size <= 0 or offset + size > len(raw):
            findings.append(_error('glb_chunk_invalid', rel,
                                   f'Chunk 0x{kind:08x} declares {size} bytes with {len(raw) - offset} available',
                                   {'chunk_type': kind, 'declared_size': size, 'available': len(raw) - offset}))
            return record, findings
        chunks.append((kind, raw[offset:offset + size]))
        offset += size
    if len(chunks) != 2 or chunks[0][0] != GLB_JSON_CHUNK or chunks[1][0] != GLB_BIN_CHUNK:
        kinds = [f'0x{kind:08x}' for kind, _ in chunks]
        findings.append(_error('glb_chunk_invalid', rel,
                               f'Expected one JSON and one BIN chunk, found {kinds}', {'chunks': kinds}))
        return record, findings
    json_chunk, bin_chunk = chunks[0][1], chunks[1][1]
    measurements['json_chunk_bytes'] = len(json_chunk)
    measurements['bin_chunk_bytes'] = len(bin_chunk)

    try:
        text = json_chunk.decode('utf-8').rstrip('\x00 ')
    except UnicodeDecodeError as exc:
        findings.append(_error('glb_json_invalid', rel, f'JSON chunk is not UTF-8: {exc}'))
        return record, findings

    def _reject_constant(token: str) -> None:
        raise ValueError(f'non-standard JSON constant {token}')

    try:
        json.loads(text, parse_constant=_reject_constant)
        strict = True
    except ValueError:
        strict = False
    try:
        doc = json.loads(text)
    except ValueError as exc:
        findings.append(_error('glb_json_invalid', rel, f'JSON chunk does not parse: {exc}'))
        return record, findings
    measurements['strict_json'] = strict
    if not strict:
        findings.append(_error('glb_json_nonstrict', rel,
                               'JSON chunk is not strict JSON: literal NaN/Infinity is invalid glTF'))
    if not isinstance(doc, dict):
        findings.append(_error('glb_json_invalid', rel, 'JSON chunk is not an object'))
        return record, findings

    def _walk_uris(node: object) -> bool:
        if isinstance(node, dict):
            return any(key in node for key in ('uri', 'url')) or any(_walk_uris(v) for v in node.values())
        if isinstance(node, list):
            return any(_walk_uris(v) for v in node)
        return False

    if _walk_uris(doc):
        findings.append(_error('glb_external_resource', rel, 'Document references an external uri/url'))

    asset = doc.get('asset')
    measurements['asset_version'] = asset.get('version') if isinstance(asset, dict) else None
    buffers = doc.get('buffers')
    if not isinstance(buffers, list) or not buffers or not isinstance(buffers[0], dict):
        findings.append(_error('glb_buffer_length_invalid', rel, 'Document declares no buffer'))
        return record, findings
    buffer_length = buffers[0].get('byteLength')
    measurements['buffer_byte_length'] = buffer_length
    if (not isinstance(buffer_length, int) or isinstance(buffer_length, bool)
            or not 0 < buffer_length <= len(bin_chunk)):
        findings.append(_error('glb_buffer_length_invalid', rel,
                               f'Buffer byteLength {buffer_length!r} is not within the {len(bin_chunk)}-byte BIN chunk',
                               {'declared': buffer_length, 'bin_chunk_bytes': len(bin_chunk)}))
        return record, findings

    meshes = doc.get('meshes')
    measurements['meshes'] = len(meshes) if isinstance(meshes, list) else 0
    primitives = (meshes[0].get('primitives') if isinstance(meshes, list) and meshes
                  and isinstance(meshes[0], dict) else None)
    if not isinstance(primitives, list) or not primitives or not isinstance(primitives[0], dict):
        findings.append(_error('glb_primitive_missing', rel, 'First mesh declares no primitive'))
        return record, findings
    primitive = primitives[0]
    measurements['primitives'] = len(primitives)
    measurements['mode'] = primitive.get('mode', 4)
    attributes = primitive.get('attributes')
    if not isinstance(attributes, dict) or not attributes:
        findings.append(_error('glb_attribute_missing', rel, 'Primitive declares no attributes'))
        return record, findings
    measurements['attributes'] = sorted(str(name) for name in attributes)

    images = doc.get('images') if isinstance(doc.get('images'), list) else []
    texture_state = _inspect_textures(doc, images, bin_chunk, rel, findings)
    measurements['textures'] = texture_state['textures']
    measurements['texture_state'] = texture_state['state']
    embeds_images = texture_state['state'] == 'valid'
    if texture_expected is None:
        expected = embeds_images
    else:
        expected = bool(texture_expected)
    measurements['texture_expected'] = expected
    if expected and not embeds_images:
        findings.append(_error('glb_texture_missing', rel,
                               f'Run declares a textured appearance ({appearance!r}) but the GLB texture state is '
                               f'{texture_state["state"]}',
                               {'appearance': appearance, 'images': len(images)}))

    accessors: dict[str, dict[str, Any]] = {}
    position_values: np.ndarray | None = None
    required = ['POSITION']
    if expected or embeds_images:
        required.append('TEXCOORD_0')
    if appearance in TEXTURED_APPEARANCES or (appearance is None and expected):
        required.append('NORMAL')
    for name in FLOAT_ATTRIBUTES:
        if name not in attributes:
            if name in required:
                findings.append(_error('glb_attribute_missing', rel,
                                       f'Primitive lacks required attribute {name}',
                                       {'attribute': name, 'attributes': measurements['attributes']}))
            continue
        try:
            array, info = _decode_accessor(doc, bin_chunk, attributes[name])
        except ValueError as exc:
            findings.append(_error('glb_attribute_invalid', rel, f'{name}: {exc}', {'attribute': name}))
            continue
        values = array.astype(np.float64)
        info['elements'] = int(values.size)
        info['nonfinite_elements'] = int((~np.isfinite(values)).sum())
        info['nonfinite_vertices'] = int((~np.isfinite(values).all(axis=1)).sum()) if values.size else 0
        if values.size and info['nonfinite_elements']:
            finite_rows = values[np.isfinite(values).all(axis=1)]
            if finite_rows.size:
                info['finite_min'] = _vec(finite_rows.min(axis=0))
                info['finite_max'] = _vec(finite_rows.max(axis=0))
            findings.append(_error(
                'glb_attribute_nonfinite', rel,
                f'{name} holds {info["nonfinite_elements"]} non-finite values of {info["elements"]} across '
                f'{info["nonfinite_vertices"]} of {values.shape[0]} vertices',
                {'attribute': name, 'nonfinite_elements': info['nonfinite_elements'],
                 'elements': info['elements'], 'nonfinite_vertices': info['nonfinite_vertices'],
                 'vertices': int(values.shape[0])},
            ))
        if info['count'] == 0:
            findings.append(_error('glb_accessor_zero_count', rel, f'{name} accessor count is 0',
                                   {'attribute': name}))
        if name == 'POSITION' and values.size:
            finite_rows = values[np.isfinite(values).all(axis=1)]
            if finite_rows.size:
                info['min'] = _vec(finite_rows.min(axis=0))
                info['max'] = _vec(finite_rows.max(axis=0))
        accessors[name] = info
        if name == 'POSITION':
            position_values = array
        _check_declared_bounds(doc, attributes[name], name, array, rel, findings)
    measurements['accessors'] = accessors

    counts = {name: info['count'] for name, info in accessors.items()}
    if len(set(counts.values())) > 1:
        findings.append(_error('glb_attribute_count_mismatch', rel,
                               f'Attribute counts differ: {counts}', counts))
    position_count = counts.get('POSITION', 0)
    mode = primitive.get('mode', 4)

    index_info: dict[str, Any] = {'present': False}
    faces_decoded: np.ndarray | None = None
    if 'indices' in primitive:
        index_array, info = None, {}
        try:
            index_array, info = _decode_accessor(doc, bin_chunk, primitive['indices'])
        except ValueError as exc:
            findings.append(_error('glb_index_invalid', rel, f'indices: {exc}'))
        if index_array is not None:
            flat = index_array.reshape(-1).astype(np.int64)
            index_info = dict(info)
            index_info['present'] = True
            index_info['max_index'] = int(flat.max()) if flat.size else None
            index_info['min_index'] = int(flat.min()) if flat.size else None
            if flat.size == 0 or flat.size % 3:
                findings.append(_error('glb_index_invalid', rel,
                                       f'{flat.size} indices are not a non-empty multiple of 3',
                                       {'indices': int(flat.size)}))
            elif index_info['max_index'] >= position_count or index_info['min_index'] < 0:
                findings.append(_error('glb_index_invalid', rel,
                                       f'Index range [{index_info["min_index"]}, {index_info["max_index"]}] is '
                                       f'outside the POSITION count {position_count}',
                                       {'min_index': index_info['min_index'],
                                        'max_index': index_info['max_index'],
                                        'position_count': position_count}))
            else:
                faces = flat.reshape(-1, 3)
                degenerate = int(((faces[:, 0] == faces[:, 1]) | (faces[:, 1] == faces[:, 2])
                                  | (faces[:, 0] == faces[:, 2])).sum())
                watertight, boundary, nonmanifold = check_watertight_edges(faces)
                index_info['faces'] = int(len(faces))
                index_info['degenerate_faces'] = degenerate
                index_info['boundary_edges'] = boundary
                index_info['nonmanifold_edges'] = nonmanifold
                index_info['watertight'] = bool(watertight)
                faces_decoded = faces
                if boundary or nonmanifold:
                    findings.append(_warning(
                        'glb_mesh_not_watertight', rel,
                        f'{boundary} boundary and {nonmanifold} non-manifold edges in {len(faces)} faces',
                        {'boundary_edges': boundary, 'nonmanifold_edges': nonmanifold, 'faces': int(len(faces))},
                    ))
                if degenerate:
                    findings.append(_warning('glb_degenerate_faces', rel,
                                             f'{degenerate} faces repeat a vertex index',
                                             {'degenerate_faces': degenerate, 'faces': int(len(faces))}))
    else:
        vertex_count = accessors.get('POSITION', {}).get('count', 0)
        if mode == 4 and vertex_count % 3:
            findings.append(_error('glb_index_invalid', rel,
                                   f'Non-indexed triangle list has {vertex_count} vertices, not a multiple of 3'))
        else:
            findings.append(_warning('glb_indices_absent', rel,
                                     f'Primitive has no index accessor; {vertex_count} vertices are implicit',
                                     {'vertices': vertex_count}))
    measurements['indices'] = index_info
    record['quality'] = _mesh_quality(position_values, faces_decoded, artifact_bytes=len(raw),
                                      textures=measurements['textures'])

    record['passed'] = not any(finding['severity'] == 'error' for finding in findings)
    return record, findings


def _resolve_input_image(dish_dir: Path) -> Path | None:
    candidate = dish_dir / 'input_image.png'
    if candidate.is_file():
        return candidate
    matches = sorted(dish_dir.glob('*input*.png'))
    return matches[0] if matches else None


def _resolve_cutout(dish_dir: Path) -> Path | None:
    candidate = dish_dir / 'cutout_rgba.png'
    if candidate.is_file():
        return candidate
    matches = sorted(dish_dir.glob('*cutout*.png'))
    return matches[0] if matches else None


def _image_compare(source_dir: Path, dish_dir: Path, claims: dict[str, Any],
                   findings: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Measure the cutout/source pair: dimensions, alpha coverage and pixel provenance."""
    label = dish_dir.name
    input_path = _resolve_input_image(dish_dir)
    cutout_path = _resolve_cutout(dish_dir)
    if input_path is None or cutout_path is None:
        missing = [name for name, path in (('input_image.png', input_path), ('cutout', cutout_path))
                   if path is None]
        findings.append(_error('image_missing', f'{label}/',
                               f'Missing image artifacts: {missing}', {'missing': missing}))
        return None
    record: dict[str, Any] = {
        'source_image': _rel(source_dir, input_path),
        'cutout': _rel(source_dir, cutout_path),
    }
    try:
        with Image.open(input_path) as source_image:
            source_image.load()
            source_rgba = np.asarray(source_image.convert('RGBA'))
            record['source_dimensions'] = [source_image.width, source_image.height]
            record['source_format'] = source_image.format
            record['source_mode'] = source_image.mode
        with Image.open(cutout_path) as cutout_image:
            cutout_image.load()
            cutout_rgba = np.asarray(cutout_image.convert('RGBA'))
            record['cutout_dimensions'] = [cutout_image.width, cutout_image.height]
            record['cutout_format'] = cutout_image.format
            record['cutout_mode'] = cutout_image.mode
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        findings.append(_error('image_unreadable', f'{label}/', f'{type(exc).__name__}: {exc}'))
        return None

    if source_rgba.shape != cutout_rgba.shape:
        findings.append(_error('image_dimension_mismatch', f'{label}/',
                               f'Source is {source_rgba.shape[1]}x{source_rgba.shape[0]} RGBA, cutout is '
                               f'{cutout_rgba.shape[1]}x{cutout_rgba.shape[0]}',
                               {'source': list(source_rgba.shape), 'cutout': list(cutout_rgba.shape)}))
        return record

    alpha = cutout_rgba[..., 3]
    foreground = alpha >= 128
    record['alpha_nonzero_coverage_pct'] = round(float((alpha > 0).mean() * 100.0), 2)
    record['alpha_half_coverage_pct'] = round(float(foreground.mean() * 100.0), 2)
    record['opaque_source_coverage_pct'] = round(float((source_rgba[..., 3] > 0).mean() * 100.0), 2)
    record['alpha_fully_opaque_pct'] = round(float((alpha == 255).mean() * 100.0), 2)
    record['transition_pixels'] = int(((alpha > 0) & (alpha < 255)).sum())
    record['foreground_pixels'] = int((alpha > 0).sum())
    rows = np.flatnonzero(alpha.any(axis=1))
    cols = np.flatnonzero(alpha.any(axis=0))
    bbox = [int(cols[0]), int(rows[0]), int(cols[-1]), int(rows[-1])] if rows.size and cols.size else None
    record['bbox_inclusive'] = bbox

    claimed = {key: (claims or {}).get(key)
               for key in ('fg_coverage_pct', 'food_coverage_pct', 'plate_added_pct', 'bbox')}
    record['claimed'] = claimed
    claimed_coverage = claimed.get('fg_coverage_pct')
    if isinstance(claimed_coverage, (int, float)) and not isinstance(claimed_coverage, bool):
        delta = round(record['alpha_half_coverage_pct'] - float(claimed_coverage), 2)
        record['coverage_delta_pp'] = delta
        if abs(delta) > COVERAGE_TOLERANCE_PP:
            findings.append(_warning(
                'image_coverage_claim_mismatch', f'{label}/',
                f'Measured alpha>=128 coverage {record["alpha_half_coverage_pct"]}% differs from the claimed '
                f'fg_coverage_pct {claimed_coverage}%',
                {'measured_pct': record['alpha_half_coverage_pct'], 'claimed_pct': claimed_coverage,
                 'delta_pp': delta},
            ))
    claimed_bbox = claimed.get('bbox')
    if bbox is not None and isinstance(claimed_bbox, list) and len(claimed_bbox) == 4:
        try:
            deviation = int(max(abs(int(bbox[i]) - int(claimed_bbox[i])) for i in range(4)))
        except (TypeError, ValueError):
            deviation = None
        if deviation is not None:
            record['bbox_deviation_px'] = deviation
            if deviation > BBOX_TOLERANCE_PX:
                findings.append(_warning(
                    'image_bbox_claim_mismatch', f'{label}/',
                    f'Measured alpha>0 bbox {bbox} differs from the claimed bbox {claimed_bbox} by {deviation}px',
                    {'measured': bbox, 'claimed': claimed_bbox, 'deviation_px': deviation},
                ))

    mask = alpha > 0
    source_opaque = source_rgba[..., 3] > 0
    pixels_outside = int((mask & ~source_opaque).sum())
    record['cutout_pixels_outside_source'] = pixels_outside
    if pixels_outside:
        findings.append(_error('image_cutout_outside_source', f'{label}/',
                               f'{pixels_outside} cutout pixels have alpha>0 where the source is transparent',
                               {'pixels': pixels_outside}))
    deltas = np.abs(cutout_rgba[..., :3].astype(np.int16) - source_rgba[..., :3].astype(np.int16)).max(axis=-1)
    differing = int(((deltas > 0) & mask).sum())
    record['pixels_differing_from_source'] = differing
    record['max_rgb_delta'] = int(deltas[mask].max()) if mask.any() else 0
    if differing:
        findings.append(_error(
            'image_cutout_invented_pixels', f'{label}/',
            f'{differing} foreground cutout pixels differ from the captured source pixel (max channel delta '
            f'{record["max_rgb_delta"]})',
            {'pixels': differing, 'max_channel_delta': record['max_rgb_delta'],
             'foreground_pixels': record['foreground_pixels']},
        ))
    return record


def _dish_statuses(worker: dict[str, Any], manifest: dict[str, Any] | None,
                   label: str) -> dict[str, str]:
    """Collect the declared run status of every model/run that produced this dish.

    `worker_output.json` names models by display label; `manifest.json` keys runs by a slug that
    carries the same display label in `backend`. Both are folded onto one key per model so a
    single failed run is reported once. A mobile export status is only kept when its model run
    succeeded, because `mobile_status: "not_run"` next to a failed model adds no information.
    """
    statuses: dict[str, str] = {}
    worker_models = worker.get('models')
    if isinstance(worker_models, dict):
        for model, record in sorted(worker_models.items()):
            if not isinstance(record, dict):
                continue
            status = str(record.get('status'))
            statuses[str(model)] = status
            mobile_status = record.get('mobile_status')
            if isinstance(mobile_status, str) and _status_state(status) == 'ok':
                statuses[f'{model}/mobile'] = mobile_status
    runs = (manifest or {}).get('runs_3d')
    if isinstance(runs, dict):
        for key, record in sorted(runs.items()):
            if not isinstance(key, str) or not key.startswith(f'{label}/') or not isinstance(record, dict):
                continue
            backend = record.get('backend')
            name = backend if isinstance(backend, str) and backend else key.split('/', 1)[1]
            status = str(record.get('status'))
            previous = statuses.get(name)
            if previous is None or _STATUS_RANK[_status_state(previous)] < _STATUS_RANK[_status_state(status)]:
                statuses[name] = status
    return statuses


def _verify_dish(source_dir: Path, dish_dir: Path, manifest: dict[str, Any] | None,
                 declarations: Declarations) -> dict[str, Any]:
    """Verify one dish directory; return its measurements and every finding about it."""
    label = dish_dir.name
    findings: list[dict[str, Any]] = []
    worker = declarations.worker_payloads.get(label) or {}
    statuses = _dish_statuses(worker, manifest, label)
    states = {name: _status_state(status) for name, status in statuses.items()}
    failed_runs = {name: statuses[name] for name, state in states.items() if state == 'failed'}
    for name, state in sorted(states.items()):
        if state == 'ok':
            continue
        if state == 'skipped':
            findings.append(_warning('run_status_skipped', f'{label}/',
                                     f'Run {name!r} status is {statuses[name]!r}, not "success"',
                                     {'run': name, 'status': statuses[name]}))
        else:
            findings.append(_error('run_status_failed', f'{label}/',
                                   f'Run {name!r} status is {statuses[name]!r}, not "success"',
                                   {'run': name, 'status': statuses[name]}))

    glb_paths = sorted(path for path in dish_dir.glob('*.glb') if path.is_file())
    if not glb_paths:
        # A dish whose every declared run was skipped owes no mesh: `TRELLIS.2-4B` skipped for a
        # missing HF token is an absent artifact, not a broken one. Any undeclared, successful or
        # failed run still makes the absence an error.
        if states and all(state == 'skipped' for state in states.values()):
            findings.append(_warning(
                'glb_artifact_absent_for_skipped_runs', f'{label}/',
                'Dish directory contains no .glb artifact because every declared run is skipped',
                {'runs': {name: statuses[name] for name in sorted(statuses)}},
            ))
        else:
            findings.append(_error(
                'glb_artifact_missing', f'{label}/', 'Dish directory contains no .glb artifact'))
    glb_records: list[dict[str, Any]] = []
    for path in glb_paths:
        rel = _rel(source_dir, path)
        declared = declarations.digests.get(rel)
        appearance = declarations.appearances.get(rel)
        texture_claim = declarations.texture_claims.get(rel)
        if appearance in TEXTURED_APPEARANCES:
            texture_expected: bool | None = True
        elif appearance in GEOMETRY_ONLY_APPEARANCES:
            texture_expected = bool(texture_claim) if isinstance(texture_claim, bool) else False
        elif isinstance(texture_claim, bool):
            texture_expected = texture_claim
        else:
            texture_expected = None
        record, glb_findings = _inspect_glb(
            path, rel, appearance=appearance, texture_expected=texture_expected, declared=declared,
        )
        if declared is None and failed_runs:
            glb_findings.append(_error(
                'artifact_for_failed_run', rel,
                f'GLB exists in a dish with failed runs ({sorted(failed_runs)}) and no digest declares it',
                {'failed_runs': failed_runs},
            ))
        glb_records.append(record)
        findings.extend(glb_findings)

    image_files: list[dict[str, Any]] = []
    for path in sorted(dish_dir.glob('*.png')):
        if not path.is_file():
            continue
        rel = _rel(source_dir, path)
        declared = declarations.digests.get(rel)
        digest = _sha256_file(path)
        entry = {
            'path': rel,
            'bytes': path.stat().st_size,
            'sha256': digest,
            'declared_sha256': (declared or {}).get('sha256'),
            'digest': 'missing',
        }
        if declared is None:
            findings.append(_error('artifact_digest_missing', rel,
                                   'No manifest, job_manifest or worker_output declares a digest for this image'))
        elif declared['sha256'] == digest:
            entry['digest'] = 'match'
        else:
            entry['digest'] = 'mismatch'
            findings.append(_error('artifact_digest_mismatch', rel,
                                   'On-disk sha256 differs from every declared digest',
                                   {'declared': declared['sha256'], 'measured': digest}))
        image_files.append(entry)

    metadata_files: list[dict[str, Any]] = []
    for path in sorted(dish_dir.glob('*.json')):
        if not path.is_file():
            continue
        rel = _rel(source_dir, path)
        declared = declarations.digests.get(rel)
        digest = _sha256_file(path)
        entry = {
            'path': rel,
            'bytes': path.stat().st_size,
            'sha256': digest,
            'declared_sha256': (declared or {}).get('sha256'),
            'digest': 'not_declared',
        }
        if declared is None:
            pass
        elif declared['sha256'] == digest:
            entry['digest'] = 'match'
        else:
            entry['digest'] = 'mismatch'
            findings.append(_error('artifact_digest_mismatch', rel,
                                   'On-disk sha256 differs from the declared metadata digest',
                                   {'declared': declared['sha256'], 'measured': digest}))
        metadata_files.append(entry)

    cutout_claims = worker.get('cutout_metrics')
    if not isinstance(cutout_claims, dict):
        inputs = (manifest or {}).get('inputs')
        entry = inputs.get(label) if isinstance(inputs, dict) else None
        cutout_claims = entry.get('cutout_metrics') if isinstance(entry, dict) else None
    image_record = _image_compare(source_dir, dish_dir, cutout_claims or {}, findings)

    record: dict[str, Any] = {
        'label': label,
        'statuses': statuses,
        'failed_runs': failed_runs,
        'glbs': glb_records,
        'image_files': image_files,
        'metadata_files': metadata_files,
        'images': image_record,
        'images_passed': image_record is not None and not any(
            finding['severity'] == 'error' and finding['check'] == 'image' for finding in findings),
        'findings': [finding['id'] for finding in findings],
        'passed': not any(finding['severity'] == 'error' for finding in findings),
    }
    for finding in findings:
        finding['dish'] = label
    declarations.findings.extend(findings)
    return record


def _require_private(payload: dict[str, Any], subject: str, findings: list[dict[str, Any]],
                     finding_id: str) -> None:
    """A private R&D tree must declare `publication_eligible: false` in every manifest."""
    if payload.get('publication_eligible') is not False:
        findings.append(_error(finding_id, subject,
                               f'publication_eligible must be false, found '
                               f'{payload.get("publication_eligible")!r}'))


def measure_glb_quality(path: Path | str, *, rel: str | None = None) -> dict[str, Any]:
    """Measure one standalone GLB's `quality` block, reusing the verifier's single decoder.

    Findings are discarded on purpose: this returns measurements only, so a consumer (the model
    report) can never accidentally promote a structural error or a visual judgement into a pass.
    """
    record, _findings = _inspect_glb(Path(path), rel or str(path), appearance=None,
                                     texture_expected=None, declared=None)
    return dict(record['quality'])


def _source_quality(glb_records: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate measured quality over every GLB of one source; unmeasured artifacts stay visible."""
    measured = [glb['quality'] for glb in glb_records if (glb.get('quality') or {}).get('measured')]
    unmeasured = [
        {'path': glb['path'], 'reason': (glb.get('quality') or {}).get('reason')}
        for glb in glb_records if not (glb.get('quality') or {}).get('measured')
    ]
    faces = [float(entry['triangles']) for entry in measured if entry.get('triangles')]
    boundaries = [float(entry['boundary_edges']) for entry in measured
                  if entry.get('boundary_edges') is not None]
    per_face = [float(entry['bytes_per_face']) for entry in measured
                if entry.get('bytes_per_face') is not None]
    watertight = sum(1 for entry in measured if entry.get('watertight'))
    welded_boundaries = [float(entry['welded_boundary_edges']) for entry in measured
                         if entry.get('welded_boundary_edges') is not None]
    shells = [float(entry['shell_count']) for entry in measured
              if entry.get('shell_count') is not None]
    main_shell = [float(entry['main_shell_triangle_pct']) for entry in measured
                  if entry.get('main_shell_triangle_pct') is not None]
    textures = [pixel for entry in measured for pixel in entry.get('texture_pixels') or []]
    return {
        'schema_version': QUALITY_SCHEMA_VERSION,
        'artifacts': len(glb_records),
        'artifacts_measured': len(measured),
        'artifacts_unmeasured': len(unmeasured),
        'unmeasured': unmeasured,
        'watertight_glbs': watertight,
        'open_shell_glbs': len(measured) - watertight,
        'watertight_pct': round(100.0 * watertight / len(measured), 2) if measured else None,
        'median_faces': statistics.median(faces) if faces else None,
        'min_faces': min(faces) if faces else None,
        'max_faces': max(faces) if faces else None,
        'median_boundary_edges': statistics.median(boundaries) if boundaries else None,
        'min_boundary_edges': min(boundaries) if boundaries else None,
        'max_boundary_edges': max(boundaries) if boundaries else None,
        'total_nonmanifold_edges': sum(int(entry['nonmanifold_edges'] or 0) for entry in measured),
        'welded_watertight_glbs': sum(1 for entry in measured if entry.get('welded_watertight')),
        'median_welded_boundary_edges': (statistics.median(welded_boundaries)
                                         if welded_boundaries else None),
        'median_shell_count': statistics.median(shells) if shells else None,
        'median_main_shell_triangle_pct': statistics.median(main_shell) if main_shell else None,
        'total_degenerate_triangles': sum(int(entry['degenerate_triangles'] or 0) for entry in measured),
        'texture_pixels_observed': [pixel for pixel in textures if pixel[0] and pixel[1]],
        'median_bytes_per_face': statistics.median(per_face) if per_face else None,
        'definitions': QUALITY_DEFINITIONS,
        'note': ('Quality is measured, not graded: it never raises an error and never turns a '
                 'structural error into a pass. An open shell with many boundary edges is a thin '
                 'surface, not a solid, however small its triangle count looks.'),
    }


def _zero_counts() -> dict[str, int]:
    """The complete counter set for one source, so an early return never drops a key."""
    return {
        'dishes': 0,
        'dishes_passed': 0,
        'dishes_with_non_success_runs': 0,
        'glb_artifacts': 0,
        'glb_passed': 0,
        'glb_failed': 0,
        'glb_digest_missing': 0,
        'glb_digest_mismatch': 0,
        'png_artifacts': 0,
        'png_digest_missing': 0,
        'png_digest_mismatch': 0,
        'image_pairs': 0,
        'image_pairs_passed': 0,
        'errors': 0,
        'warnings': 0,
    }


def verify_source(source_dir: Path | str) -> dict[str, Any]:
    """Verify one Kaggle result directory; return the machine-readable source report."""
    source_dir = Path(source_dir)
    findings: list[dict[str, Any]] = []
    report: dict[str, Any] = {
        'source': str(source_dir),
        'exists': source_dir.is_dir(),
        'manifest': None,
        'counts': {},
        'dishes': [],
        'quality': _source_quality([]),
        'findings': findings,
        'passed': False,
    }
    if not source_dir.is_dir():
        findings.append(_error('source_missing', str(source_dir), 'Source directory does not exist'))
        counts = _zero_counts()
        counts['errors'] = len(findings)
        report['counts'] = counts
        return report

    manifest: dict[str, Any] | None = None
    manifest_path = source_dir / 'manifest.json'
    if not manifest_path.is_file():
        findings.append(_error('manifest_missing', 'manifest.json', 'Source directory has no manifest.json'))
    else:
        manifest = _load_json(manifest_path, findings, subject='manifest.json')
    if manifest is not None:
        _require_private(manifest, 'manifest.json', findings, 'manifest_publication_eligible')
        if not isinstance(manifest.get('inputs'), dict):
            findings.append(_error('manifest_malformed', 'manifest.json', 'inputs is not an object'))
        if not isinstance(manifest.get('runs_3d'), dict):
            findings.append(_error('manifest_malformed', 'manifest.json', 'runs_3d is not an object'))

    dishes = sorted(
        path for path in source_dir.iterdir()
        if path.is_dir() and ((path / 'job_manifest.json').is_file() or (path / 'worker_output.json').is_file())
    )
    if not dishes:
        findings.append(_error('dish_missing', str(source_dir),
                               'No dish subdirectory contains job_manifest.json or worker_output.json'))

    declarations = _collect_declarations(source_dir, manifest, dishes, findings)
    for dish_dir in dishes:
        payload = declarations.job_payloads.get(dish_dir.name)
        if payload is not None:
            _require_private(payload, f'{dish_dir.name}/job_manifest.json', findings,
                             'job_manifest_publication_eligible')
        worker = declarations.worker_payloads.get(dish_dir.name)
        if worker is not None:
            _require_private(worker, f'{dish_dir.name}/worker_output.json', findings,
                             'worker_output_publication_eligible')

    dish_reports = [_verify_dish(source_dir, dish_dir, manifest, declarations) for dish_dir in dishes]
    report['dishes'] = dish_reports
    for rel, origin in sorted(declarations.missing_declared.items()):
        findings.append(_error('artifact_missing', rel,
                               f'Declared by {origin} but absent from the tree'))

    glb_records = [glb for dish in dish_reports for glb in dish['glbs']]
    report['quality'] = _source_quality(glb_records)
    models = set()
    runs = (manifest or {}).get('runs_3d') if isinstance((manifest or {}).get('runs_3d'), dict) else {}
    per_dish_runs: dict[str, dict[str, int]] = {}
    for key, record in sorted(runs.items()):
        if not isinstance(key, str) or not isinstance(record, dict):
            continue
        label = key.split('/', 1)[0]
        bucket = per_dish_runs.setdefault(label, {'runs': 0, 'success': 0, 'non_success': 0})
        bucket['runs'] += 1
        if record.get('status') == 'success':
            bucket['success'] += 1
        else:
            bucket['non_success'] += 1
        backend = record.get('backend')
        if isinstance(backend, str):
            models.add(backend)
    for dish in dish_reports:
        for name in dish['statuses']:
            models.add(name.split('/mobile')[0])
    errors = sum(1 for finding in findings if finding['severity'] == 'error')
    warnings = sum(1 for finding in findings if finding['severity'] == 'warning')
    report['manifest'] = {
        'present': manifest is not None,
        'publication_eligible': (manifest or {}).get('publication_eligible'),
        'schema_version': (manifest or {}).get('schema_version'),
        'models': sorted(models),
        'run_count': sum(bucket['runs'] for bucket in per_dish_runs.values()),
        'per_dish_runs': dict(sorted(per_dish_runs.items())),
    }
    report['counts'] = {
        'dishes': len(dish_reports),
        'dishes_passed': sum(1 for dish in dish_reports if dish['passed']),
        'dishes_with_non_success_runs': sum(
            1 for dish in dish_reports
            if any(_status_state(status) != 'ok' for status in dish['statuses'].values())),
        'glb_artifacts': len(glb_records),
        'glb_passed': sum(1 for glb in glb_records if glb['passed']),
        'glb_failed': sum(1 for glb in glb_records if not glb['passed']),
        'glb_digest_missing': sum(1 for glb in glb_records if glb['digest'] == 'missing'),
        'glb_digest_mismatch': sum(1 for glb in glb_records if glb['digest'] == 'mismatch'),
        'png_artifacts': sum(len(dish['image_files']) for dish in dish_reports),
        'png_digest_missing': sum(1 for dish in dish_reports for entry in dish['image_files']
                                  if entry['digest'] == 'missing'),
        'png_digest_mismatch': sum(1 for dish in dish_reports for entry in dish['image_files']
                                   if entry['digest'] == 'mismatch'),
        'image_pairs': sum(1 for dish in dish_reports if dish['images']),
        'image_pairs_passed': sum(1 for dish in dish_reports if dish['images_passed']),
        'errors': errors,
        'warnings': warnings,
    }
    report['passed'] = errors == 0
    return report


def _count_by_id(findings: list[dict[str, Any]]) -> list[tuple[str, str, int]]:
    """Aggregate findings into `(id, severity, count)` rows, worst first."""
    counts: dict[tuple[str, str], int] = {}
    for finding in findings:
        key = (finding['severity'], finding['id'])
        counts[key] = counts.get(key, 0) + 1
    return [(finding_id, severity, count) for (severity, finding_id), count in
            sorted(counts.items(), key=lambda item: (item[0][0] != 'error', -item[1], item[0][1]))]


def render_markdown(report: dict[str, Any]) -> str:
    """Render a compact Markdown summary of one verification report."""
    lines: list[str] = [
        '# Kaggle dish-3D output verification',
        '',
        REPORT_LABEL,
        '',
    ]
    verdict = 'PASS (no error findings)' if report['ok'] else f'FAIL ({report["counts"]["errors"]} error findings)'
    lines += [
        '| Source | Verdict | Dishes | GLB ok/total | Digest missing/mismatch | Image pairs | Errors | Warnings |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ]
    for source in report['sources']:
        counts = source['counts']
        lines.append(
            f'| `{source["source"]}` | {"PASS" if source["passed"] else "FAIL"} | {counts["dishes"]} | '
            f'{counts["glb_passed"]}/{counts["glb_artifacts"]} | '
            f'{counts["glb_digest_missing"]}/{counts["glb_digest_mismatch"]} | '
            f'{counts["image_pairs_passed"]}/{counts["image_pairs"]} | {counts["errors"]} | {counts["warnings"]} |'
        )
    lines += ['', f'**Verdict:** {verdict}', '']

    for source in report['sources']:
        manifest = source['manifest'] or {}
        lines += [
            f'## `{source["source"]}`',
            '',
            f'- publication_eligible: `{manifest.get("publication_eligible")!r}`',
            f'- models: {", ".join(f"`{name}`" for name in manifest.get("models") or []) or "none"}',
            f'- runs: {manifest.get("run_count", 0)}; dishes with non-success runs: '
            f'{source["counts"]["dishes_with_non_success_runs"]}',
            '',
            '| Dish | Status | GLB ok/fail | Digest missing | Cutout dims | alpha>=128% (claim) | maxRGB delta / '
            'invented px | bbox delta px | Errors | Warnings | Failing artifacts |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ]
        dish_findings = [finding for finding in source['findings'] if finding.get('dish')]
        for dish in source['dishes']:
            glb_ok = sum(1 for glb in dish['glbs'] if glb['passed'])
            glb_fail = len(dish['glbs']) - glb_ok
            digest_missing = sum(1 for glb in dish['glbs'] if glb['digest'] == 'missing')
            images = dish['images'] or {}
            dims = images.get('cutout_dimensions')
            dims_text = f'{dims[0]}x{dims[1]}' if dims else 'n/a'
            claim = (images.get('claimed') or {}).get('fg_coverage_pct')
            coverage = images.get('alpha_half_coverage_pct')
            coverage_text = (f'{coverage}% ({claim}%)' if coverage is not None and claim is not None
                             else f'{coverage}%' if coverage is not None else 'n/a')
            delta = images.get('max_rgb_delta')
            delta_text = 'n/a' if delta is None else f'{delta} / {images.get("pixels_differing_from_source")}'
            bbox_text = str(images.get('bbox_deviation_px', 'n/a'))
            status_text = '; '.join(f'{name}={status}' for name, status in sorted(dish['statuses'].items())
                                     if _status_state(status) != 'ok') or 'ok'
            dish_errors = [finding for finding in dish_findings
                           if finding.get('dish') == dish['label'] and finding['severity'] == 'error']
            dish_warnings = [finding for finding in dish_findings
                             if finding.get('dish') == dish['label'] and finding['severity'] == 'warning']
            failing = sorted({finding['subject'] for finding in dish_errors
                              if finding['check'] == 'artifact'})
            failing_text = '<br>'.join(f'`{path}`' for path in failing) or '-'
            lines.append(
                f'| `{dish["label"]}` | {status_text} | {glb_ok}/{glb_fail} | {digest_missing} | {dims_text} | '
                f'{coverage_text} | {delta_text} | {bbox_text} | {len(dish_errors)} | {len(dish_warnings)} | '
                f'{failing_text} |'
            )
        lines += ['', '### Mesh quality (measured)', '',
                  '| Artifact | Vertices | Triangles | Boundary edges | Non-manifold edges | '
                  'Degenerate triangles | Textures (px) | Bytes/face | Watertight | '
                  'Welded boundary / non-manifold | Welded watertight | Shells | Main shell % |',
                  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
        for dish in source['dishes']:
            for glb in dish['glbs']:
                quality = glb.get('quality') or {}
                if not quality.get('measured'):
                    lines.append(f'| `{glb["path"]}` | not measured: {quality.get("reason")} '
                                 '| - | - | - | - | - | - | - | - | - | - | - |')
                    continue
                pixels = ', '.join(f'{width}x{height}' for width, height
                                   in quality.get('texture_pixels') or []) or 'none'
                lines.append(
                    f'| `{glb["path"]}` | {quality["vertices"]} | {quality["triangles"]} | '
                    f'{quality["boundary_edges"]} | {quality["nonmanifold_edges"]} | '
                    f'{quality["degenerate_triangles"]} | {pixels} | '
                    f'{quality["bytes_per_face"]} | {"yes" if quality["watertight"] else "no"} | '
                    f'{quality.get("welded_boundary_edges")} / '
                    f'{quality.get("welded_nonmanifold_edges")} | '
                    f'{_yes_no(quality.get("welded_watertight"))} | '
                    f'{quality.get("shell_count")} | {quality.get("main_shell_triangle_pct")} |'
                )
        quality_summary = source.get('quality') or {}
        lines += [
            '',
            f'- measured GLBs: {quality_summary.get("artifacts_measured")}/'
            f'{quality_summary.get("artifacts")}; watertight: '
            f'{quality_summary.get("watertight_glbs")} '
            f'({quality_summary.get("watertight_pct")}%); median faces: '
            f'{quality_summary.get("median_faces")}; median boundary edges: '
            f'{quality_summary.get("median_boundary_edges")}; welded watertight: '
            f'{quality_summary.get("welded_watertight_glbs")}; median welded boundary edges: '
            f'{quality_summary.get("median_welded_boundary_edges")}; median shells: '
            f'{quality_summary.get("median_shell_count")}',
            f'- quality is a measurement, not a verdict: it never adds an error and never turns an '
            f'error into a pass (see the `quality` block of the JSON report)',
            '',
        ]
        lines += ['', '### Findings by id', '', '| Id | Severity | Count |', '| --- | --- | --- |']
        for finding_id, severity, count in _count_by_id(source['findings']):
            lines.append(f'| `{finding_id}` | {severity} | {count} |')
        lines += ['', '### Error detail', '', '| Subject | Id | Measured / detail |', '| --- | --- | --- |']
        errors = [finding for finding in source['findings'] if finding['severity'] == 'error']
        for finding in errors[:200]:
            measured = json.dumps(finding.get('measured') or {}, sort_keys=True)
            lines.append(f'| `{finding["subject"]}` | `{finding["id"]}` | {finding["detail"]} {measured} |')
        if len(errors) > 200:
            lines.append(f'| ... | ... | {len(errors) - 200} further error findings in the JSON report |')
        lines.append('')
    return '\n'.join(lines) + '\n'


def _print_summary(report: dict[str, Any]) -> None:
    """Print a bounded console summary; secrets and raw binary never appear here."""
    for source in report['sources']:
        counts = source['counts']
        print(f'[{ "PASS" if source["passed"] else "FAIL" }] {source["source"]}')
        print(f'  dishes={counts["dishes"]} passed={counts["dishes_passed"]} '
              f'glb={counts["glb_passed"]}/{counts["glb_artifacts"]} '
              f'digest_missing={counts["glb_digest_missing"]} digest_mismatch={counts["glb_digest_mismatch"]} '
              f'image_pairs={counts["image_pairs"]} errors={counts["errors"]} warnings={counts["warnings"]}')
        quality = source.get('quality') or {}
        printed = 0
        for dish in source['dishes']:
            for glb in dish['glbs']:
                if printed >= MAX_PRINTED_QUALITY_LINES:
                    break
                printed += 1
                block = glb.get('quality') or {}
                if not block.get('measured'):
                    print(f'  quality {glb["path"]}: not measured ({block.get("reason")})')
                    continue
                pixels = ','.join(f'{width}x{height}' for width, height
                                  in block.get('texture_pixels') or []) or 'none'
                print(f'  quality {glb["path"]}: vertices={block["vertices"]} '
                      f'triangles={block["triangles"]} boundary_edges={block["boundary_edges"]} '
                      f'nonmanifold_edges={block["nonmanifold_edges"]} '
                      f'degenerate_triangles={block["degenerate_triangles"]} textures={pixels} '
                      f'bytes_per_face={block["bytes_per_face"]} '
                      f'watertight={"yes" if block["watertight"] else "no"} '
                      f'welded_boundary_edges={block.get("welded_boundary_edges")} '
                      f'welded_nonmanifold_edges={block.get("welded_nonmanifold_edges")} '
                      f'shells={block.get("shell_count")} '
                      f'main_shell_pct={block.get("main_shell_triangle_pct")}')
        if printed < sum(len(dish['glbs']) for dish in source['dishes']):
            total = sum(len(dish['glbs']) for dish in source['dishes'])
            print(f'  ... {total - printed} more artifacts (see --json-out)')
        print(f'  quality summary: measured={quality.get("artifacts_measured")}/'
              f'{quality.get("artifacts")} watertight={quality.get("watertight_glbs")} '
              f'({quality.get("watertight_pct")}%) median_faces={quality.get("median_faces")} '
              f'median_boundary_edges={quality.get("median_boundary_edges")} '
              f'welded_watertight={quality.get("welded_watertight_glbs")} '
              f'median_welded_boundary_edges={quality.get("median_welded_boundary_edges")} '
              f'median_shells={quality.get("median_shell_count")}')
        errors = [finding for finding in source['findings'] if finding['severity'] == 'error']
        for finding in errors[:MAX_PRINTED_FINDINGS]:
            measured = ''
            if finding.get('measured'):
                measured = ' ' + json.dumps(finding['measured'], sort_keys=True)
            print(f'  - {finding["id"]}: {finding["subject"]}: {finding["detail"]}{measured}')
        if len(errors) > MAX_PRINTED_FINDINGS:
            print(f'  ... {len(errors) - MAX_PRINTED_FINDINGS} more error findings (see --json-out)')
    counts = report['counts']
    print(f'Overall: {"PASS" if report["ok"] else "FAIL"} '
          f'errors={counts["errors"]} warnings={counts["warnings"]} sources={counts["sources"]}')


def verify_sources(source_dirs: Iterable[Path | str]) -> dict[str, Any]:
    """Verify every source directory and return the aggregate report."""
    sources = [verify_source(path) for path in source_dirs]
    counts = {
        'sources': len(sources),
        'sources_passed': sum(1 for source in sources if source['passed']),
        'errors': sum(source['counts']['errors'] for source in sources),
        'warnings': sum(source['counts']['warnings'] for source in sources),
        'dishes': sum(source['counts']['dishes'] for source in sources),
        'glb_artifacts': sum(source['counts']['glb_artifacts'] for source in sources),
        'glb_passed': sum(source['counts']['glb_passed'] for source in sources),
        'glb_failed': sum(source['counts']['glb_failed'] for source in sources),
        'glb_digest_missing': sum(source['counts']['glb_digest_missing'] for source in sources),
        'glb_digest_mismatch': sum(source['counts']['glb_digest_mismatch'] for source in sources),
        'image_pairs': sum(source['counts']['image_pairs'] for source in sources),
        'image_pairs_passed': sum(source['counts']['image_pairs_passed'] for source in sources),
    }
    failure_ids: dict[str, int] = {}
    for source in sources:
        for finding in source['findings']:
            if finding['severity'] == 'error':
                failure_ids[finding['id']] = failure_ids.get(finding['id'], 0) + 1
    return {
        'schema_version': SCHEMA_VERSION,
        'label': REPORT_LABEL,
        'ok': counts['errors'] == 0,
        'counts': counts,
        'quality': {
            'schema_version': QUALITY_SCHEMA_VERSION,
            'artifacts': sum(source['quality']['artifacts'] for source in sources),
            'artifacts_measured': sum(source['quality']['artifacts_measured'] for source in sources),
            'artifacts_unmeasured': sum(source['quality']['artifacts_unmeasured'] for source in sources),
            'watertight_glbs': sum(source['quality']['watertight_glbs'] for source in sources),
            'open_shell_glbs': sum(source['quality']['open_shell_glbs'] for source in sources),
            'definitions': QUALITY_DEFINITIONS,
            'note': ('Measured mesh quality across every source; it never contributes to the PASS/FAIL '
                     'verdict in `counts`/`ok`, so an open shell is reported as an open shell rather '
                     'than hidden behind a structural PASS.'),
        },
        'failure_ids': dict(sorted(failure_ids.items(), key=lambda item: (-item[1], item[0]))),
        'sources': sources,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, prog='verify_kaggle_outputs.py',
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', type=Path, action='append', default=[], metavar='DIR',
                        help='Kaggle results directory containing dish subdirectories; repeatable.')
    parser.add_argument('--json-out', type=Path, default=None, metavar='PATH',
                        help='Write the machine-readable findings report to PATH.')
    parser.add_argument('--md-out', type=Path, default=None, metavar='PATH',
                        help='Write a compact Markdown summary table to PATH.')
    args = parser.parse_args(argv)
    if not args.source:
        parser.error('at least one --source DIR is required')

    report = verify_sources(args.source)
    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(report, indent=2, sort_keys=False) + '\n', encoding='utf-8')
    if args.md_out is not None:
        args.md_out.parent.mkdir(parents=True, exist_ok=True)
        args.md_out.write_text(render_markdown(report), encoding='utf-8')
    _print_summary(report)
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
