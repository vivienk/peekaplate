"""Offline checks for the read-only Kaggle dish-3D output verifier."""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
from tempfile import TemporaryDirectory
import unittest

import numpy as np
from PIL import Image, ImageDraw

_SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'verify_kaggle_outputs.py'
_spec = importlib.util.spec_from_file_location('verify_kaggle_outputs', _SCRIPT)
module = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = module
_spec.loader.exec_module(module)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _png_bytes(image: Image.Image) -> bytes:
    from io import BytesIO
    buffer = BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def _texture_png(size: int = 8) -> bytes:
    image = Image.new('RGB', (size, size), (196, 110, 58))
    draw = ImageDraw.Draw(image)
    draw.rectangle((2, 2, size - 3, size - 3), fill=(232, 176, 92))
    return _png_bytes(image)


def _array_bytes(array: np.ndarray, dtype: str) -> bytes:
    return np.ascontiguousarray(array, dtype=dtype).tobytes()


def _glb_bytes(
    *,
    positions: np.ndarray,
    normals: np.ndarray | None = None,
    uvs: np.ndarray | None = None,
    indices: np.ndarray | None = None,
    image: bytes | None = None,
    mime_type: str = 'image/png',
    declared_length: int | None = None,
    accessor_bounds: bool = True,
    trunctated_indices: bool = False,
) -> bytes:
    """Build one tiny but structurally valid GLB (the verifier must not trust its own writer)."""
    bin_parts: list[bytes] = []
    views: list[dict] = []
    accessors: list[dict] = []

    def add_view(data: bytes, target: int | None = None) -> int:
        pad = (-len(data)) % 4
        offset = sum(len(part) for part in bin_parts)
        bin_parts.append(data + b'\x00' * pad)
        view = {'buffer': 0, 'byteOffset': offset, 'byteLength': len(data)}
        if target is not None:
            view['target'] = target
        views.append(view)
        return len(views) - 1

    def add_accessor(array: np.ndarray, kind: str, component_type: int, dtype: str,
                     target: int = 34962, bounds: bool = False) -> int:
        data = _array_bytes(array, dtype)
        if trunctated_indices and kind == 'SCALAR':
            data = data[:-4]
        view_index = add_view(data, target)
        accessor = {'bufferView': view_index, 'componentType': component_type,
                    'count': int(len(array)), 'type': kind}
        if bounds and array.size:
            numeric = np.asarray(array, dtype=np.float64)
            accessor['min'] = [float(value) for value in numeric.min(axis=0)]
            accessor['max'] = [float(value) for value in numeric.max(axis=0)]
        accessors.append(accessor)
        return len(accessors) - 1

    attributes: dict[str, int] = {}
    attributes['POSITION'] = add_accessor(np.asarray(positions, dtype=np.float32), 'VEC3', 5126, '<f4',
                                          bounds=accessor_bounds)
    if normals is not None:
        attributes['NORMAL'] = add_accessor(np.asarray(normals, dtype=np.float32), 'VEC3', 5126, '<f4')
    if uvs is not None:
        attributes['TEXCOORD_0'] = add_accessor(np.asarray(uvs, dtype=np.float32), 'VEC2', 5126, '<f4')

    primitive: dict = {'attributes': attributes, 'mode': 4}
    if indices is not None:
        primitive['indices'] = add_accessor(np.asarray(indices, dtype=np.uint32).reshape(-1), 'SCALAR',
                                            5125, '<u4', target=34963)

    doc: dict = {
        'asset': {'version': '2.0', 'generator': 'peekaplate-verifier-test'},
        'scene': 0,
        'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0}],
        'meshes': [{'primitives': [primitive]}],
        'accessors': accessors,
        'bufferViews': views,
        'buffers': [{'byteLength': 0}],
    }
    if image is not None:
        image_view = add_view(image)
        doc['images'] = [{'bufferView': image_view, 'mimeType': mime_type}]
        doc['samplers'] = [{}]
        doc['textures'] = [{'sampler': 0, 'source': 0}]
        doc['materials'] = [{'name': 'captured',
                             'pbrMetallicRoughness': {'baseColorTexture': {'index': 0},
                                                      'metallicFactor': 0.0, 'roughnessFactor': 0.5}}]

    binary = b''.join(bin_parts)
    doc['buffers'][0]['byteLength'] = len(binary)
    json_bytes = json.dumps(doc, separators=(',', ':'), allow_nan=True).encode('utf-8')
    json_bytes += b' ' * ((-len(json_bytes)) % 4)
    binary += b'\x00' * ((-len(binary)) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(binary)
    header = struct.pack('<4sII', b'glTF', 2, total if declared_length is None else declared_length)
    return (header + struct.pack('<II', len(json_bytes), module.GLB_JSON_CHUNK) + json_bytes
            + struct.pack('<II', len(binary), module.GLB_BIN_CHUNK) + binary)


def _pyramid() -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """A small closed mesh so the watertight check has a real answer."""
    positions = np.array([
        [-1.0, 0.0, -1.0],
        [1.0, 0.0, -1.0],
        [1.0, 0.0, 1.0],
        [-1.0, 0.0, 1.0],
        [0.0, 1.5, 0.0],
    ], dtype=np.float32)
    normals = np.tile(np.array([[0.0, 1.0, 0.0]], dtype=np.float32), (5, 1))
    uvs = np.array([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.5, 0.5]], dtype=np.float32)
    indices = np.array([[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4], [0, 3, 2], [0, 2, 1]],
                       dtype=np.uint32)
    return positions, normals, uvs, indices


def _cube() -> tuple[np.ndarray, np.ndarray]:
    """A closed 12-triangle cube: every undirected edge is used exactly twice."""
    positions = np.array([
        [-1.0, -1.0, -1.0], [1.0, -1.0, -1.0], [1.0, 1.0, -1.0], [-1.0, 1.0, -1.0],
        [-1.0, -1.0, 1.0], [1.0, -1.0, 1.0], [1.0, 1.0, 1.0], [-1.0, 1.0, 1.0],
    ], dtype=np.float32)
    indices = np.array([
        [0, 2, 1], [0, 3, 2],          # -Z
        [4, 5, 6], [4, 6, 7],          # +Z
        [0, 1, 5], [0, 5, 4],          # -Y
        [3, 7, 6], [3, 6, 2],          # +Y
        [0, 4, 7], [0, 7, 3],          # -X
        [1, 2, 6], [1, 6, 5],          # +X
    ], dtype=np.uint32)
    return positions, indices


def _seam_split_cube() -> tuple[np.ndarray, np.ndarray]:
    """The closed cube exported the way a UV-atlased GLB is: every face owns its own four
    vertices, so coincident positions carry different indices along every seam."""
    positions, indices = _cube()
    split_positions = positions[indices.reshape(-1)]
    split_indices = np.arange(len(split_positions), dtype=np.uint32).reshape(-1, 3)
    return split_positions.astype(np.float32), split_indices


def _open_plane() -> tuple[np.ndarray, np.ndarray]:
    """Two triangles over four vertices: the perimeter is four single-use (boundary) edges."""
    positions = np.array([
        [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 0.0, 1.0],
    ], dtype=np.float32)
    indices = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.uint32)
    return positions, indices


def _shared_edge_mesh() -> tuple[np.ndarray, np.ndarray]:
    """Three triangles that all use the undirected edge (0, 1): one non-manifold seam."""
    positions = np.array([
        [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.5, 1.0],
    ], dtype=np.float32)
    indices = np.array([[0, 1, 2], [1, 0, 3], [0, 1, 4]], dtype=np.uint32)
    return positions, indices


def _degenerate_mesh() -> tuple[np.ndarray, np.ndarray]:
    """One collinear (zero-area) triangle plus one real triangle; no vertex index repeats."""
    positions = np.array([
        [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 1.0, 0.0],
    ], dtype=np.float32)
    indices = np.array([[0, 1, 2], [0, 1, 3]], dtype=np.uint32)
    return positions, indices


def _mesh_glb(positions: np.ndarray, indices: np.ndarray, *, image: bytes | None = None,
              mime_type: str = 'image/png') -> bytes:
    normals = np.tile(np.array([[0.0, 1.0, 0.0]], dtype=np.float32), (len(positions), 1))
    uvs = np.tile(np.array([[0.5, 0.5]], dtype=np.float32), (len(positions), 1))
    return _glb_bytes(positions=positions, normals=normals, uvs=uvs, indices=indices,
                      image=image, mime_type=mime_type)


def _clean_glb(*, image: bytes | None = None, nan: bool = False, **kwargs) -> bytes:
    positions, normals, uvs, indices = _pyramid()
    if nan:
        positions = positions.copy()
        positions[0, 1] = np.nan
    if image is None and not kwargs.pop('without_texture', False):
        image = _texture_png()
    return _glb_bytes(positions=positions, normals=normals, uvs=uvs, indices=indices,
                      image=image, **kwargs)


def _source_images(size: tuple[int, int] = (40, 32)) -> tuple[bytes, bytes, dict]:
    """Build an opaque source photo plus its alpha cutout, and measure the claims it supports."""
    width, height = size
    source = Image.new('RGB', size, (28, 30, 34))
    draw = ImageDraw.Draw(source)
    draw.ellipse((6, 6, width - 7, height - 7), fill=(176, 96, 48))
    draw.ellipse((14, 10, width - 15, height - 13), fill=(238, 190, 96))
    cutout = source.convert('RGBA')
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).ellipse((6, 6, width - 7, height - 7), fill=255)
    cutout.putalpha(mask)
    rgba = np.asarray(cutout)
    alpha = rgba[..., 3]
    rows = np.flatnonzero(alpha.any(axis=1))
    cols = np.flatnonzero(alpha.any(axis=0))
    metrics = {
        'fg_coverage_pct': round(float((alpha >= 128).mean() * 100.0), 2),
        'food_coverage_pct': round(float((alpha >= 128).mean() * 100.0), 2),
        'bbox': [int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1],
        'plate_added_pct': 0.0,
    }
    return _png_bytes(source), _png_bytes(cutout), metrics


def _artifact(root: Path, rel: str) -> dict:
    path = root / rel
    return {'path': rel, 'sha256': _sha(path.read_bytes()), 'bytes': path.stat().st_size}


def _build_tree(root: Path, *, labels: tuple[str, ...] = ('01_alpha', '02_beta'),
                nan_paths: set[str] | None = None, undeclared_paths: set[str] | None = None,
                wrong_digest_paths: set[str] | None = None, extra_declared: tuple[str, ...] = (),
                publication_eligible: bool = False, missing_texture_paths: set[str] | None = None,
                truncated_length_paths: set[str] | None = None,
                model_status: str = 'success',
                split_input_digest: bool = False) -> Path:
    """Write a Kaggle-shaped result tree: dish dirs, manifest.json, job_manifest, worker_output."""
    root.mkdir(parents=True, exist_ok=True)
    nan_paths = nan_paths or set()
    undeclared_paths = undeclared_paths or set()
    wrong_digest_paths = wrong_digest_paths or set()
    missing_texture_paths = missing_texture_paths or set()
    truncated_length_paths = truncated_length_paths or set()

    inputs: dict[str, dict] = {}
    runs: dict[str, dict] = {}
    extras: list[dict] = []
    for label in labels:
        dish = root / label
        dish.mkdir(parents=True, exist_ok=True)
        source_png, cutout_png, metrics = _source_images()
        raw_rel, mobile_rel = f'{label}/moge2_relief.glb', f'{label}/moge2_relief_mobile.glb'
        produced = model_status == 'success'
        if produced:
            (dish / 'moge2_relief.glb').write_bytes(_clean_glb(
                nan=raw_rel in nan_paths,
                declared_length=1024 if raw_rel in truncated_length_paths else None,
                without_texture=raw_rel in missing_texture_paths,
            ))
            (dish / 'moge2_relief_mobile.glb').write_bytes(_clean_glb(
                nan=mobile_rel in nan_paths,
                declared_length=1024 if mobile_rel in truncated_length_paths else None,
                without_texture=mobile_rel in missing_texture_paths,
            ))
        (dish / 'input_image.png').write_bytes(source_png)
        (dish / 'cutout_rgba.png').write_bytes(cutout_png)

        def declared(rel: str, *, where: str) -> dict | None:
            if rel in undeclared_paths:
                return None
            entry = _artifact(root, rel)
            if rel in wrong_digest_paths:
                entry['sha256'] = '0' * 64
            return entry

        worker_models: dict = {}
        raw_entry = declared(raw_rel, where='worker') if produced else None
        mobile_entry = declared(mobile_rel, where='worker') if produced else None
        worker_models['MoGe-2 Relief + Ceramic Plate'] = {
            'status': model_status,
            'appearance': 'captured_photo_uv_pbr',
            **({'raw_glb': raw_entry} if raw_entry else {}),
            **({'mobile_glb': mobile_entry} if mobile_entry else {}),
        }
        worker = {
            'schema_version': 1,
            'job_id': f'demo-{label}',
            'dish_label': label,
            'publication_eligible': False,
            # A re-encoded stage keeps the original digest apart from the staged bytes.
            **({'input_image_sha256': _sha(source_png), 'source_sha256': '1' * 64}
               if split_input_digest else {'source_sha256': _sha(source_png)}),
            'cutout_sha256': _sha(cutout_png),
            'cutout_metrics': metrics,
            'models': worker_models,
        }
        (dish / 'worker_output.json').write_bytes(
            (json.dumps(worker, indent=2) + '\n').encode('utf-8'))
        (dish / 'job_manifest.json').write_bytes((json.dumps({
            'schema_version': 1,
            'job_id': f'demo-{label}',
            'dish_label': label,
            'publication_eligible': False,
            'input_filename': 'input_image.png',
            **({'input_image_sha256': _sha(source_png), 'source_sha256': '1' * 64}
               if split_input_digest else {'source_sha256': _sha(source_png)}),
            'export_profiles': {'raw': {'trellis_decimation_target': 300000},
                                'mobile': {'max_faces': 35000}},
        }, indent=2) + '\n').encode('utf-8'))

        input_artifacts = [_artifact(root, f'{label}/input_image.png'),
                           _artifact(root, f'{label}/cutout_rgba.png')]
        inputs[label] = {
            'label': label,
            'image_status': 'success',
            'cutout_metrics': metrics,
            'artifacts': input_artifacts,
        }
        run_artifacts = [entry for entry in (raw_entry, mobile_entry) if entry]
        runs[f'{label}/moge2-relief'] = {
            'input_label': label,
            'backend': 'MoGe-2 Relief + Ceramic Plate',
            'appearance': 'captured_photo_uv_pbr',
            'status': model_status,
            'metrics': {'has_texture': True, 'has_vertex_color': False},
            'artifacts': run_artifacts,
        }
        extras.append(_artifact(root, f'{label}/worker_output.json'))

    extras.extend(entry for entry in (_artifact(root, rel) for rel in extra_declared) if entry)
    manifest = {
        'schema_version': 3,
        'purpose': 'private single-photo 3D demo',
        'demo_label': 'private (verifier fixture)',
        'publication_eligible': publication_eligible,
        'prompt': 'synthetic verifier fixture, no real dish photo',
        'inputs': inputs,
        'runs_3d': runs,
        'extras': extras,
    }
    (root / 'manifest.json').write_bytes((json.dumps(manifest, indent=2) + '\n').encode('utf-8'))
    return root


def _ids(findings: list[dict]) -> set[str]:
    return {finding['id'] for finding in findings}


def _find(findings: list[dict], finding_id: str, subject: str | None = None) -> dict | None:
    for finding in findings:
        if finding['id'] == finding_id and (subject is None or finding['subject'] == subject):
            return finding
    return None


class VerifyKaggleOutputsGlbTests(unittest.TestCase):
    def test_valid_minimal_glb_passes_every_structural_check(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'clean.glb'
            data = _clean_glb()
            path.write_bytes(data)
            record, findings = module._inspect_glb(
                path, 'clean.glb', appearance='captured_photo_uv_pbr', texture_expected=True,
                declared={'sha256': _sha(data), 'bytes': len(data), 'origin': 'test'},
            )
            self.assertEqual([], findings)
            self.assertTrue(record['passed'])
            self.assertEqual('match', record['digest'])
            measurements = record['measurements']
            self.assertEqual(5, measurements['accessors']['POSITION']['count'])
            self.assertEqual(0, measurements['accessors']['POSITION']['nonfinite_elements'])
            self.assertEqual('valid', measurements['texture_state'])
            self.assertEqual('png', measurements['textures'][0]['detected_magic'])
            self.assertTrue(measurements['indices']['watertight'])
            self.assertEqual(0, measurements['indices']['boundary_edges'])

    def test_truncated_length_field_is_a_length_finding(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'truncated.glb'
            data = _clean_glb(declared_length=1024)
            path.write_bytes(data)
            record, findings = module._inspect_glb(
                path, 'truncated.glb', appearance=None, texture_expected=None, declared=None,
            )
            finding = _find(findings, 'glb_length_mismatch')
            self.assertIsNotNone(finding)
            self.assertEqual(len(data), finding['measured']['measured'])
            self.assertEqual(1024, finding['measured']['declared'])
            self.assertIn('glb_structural_validation_failed', _ids(findings))
            self.assertFalse(record['passed'])

    def test_nan_position_is_reported_with_measured_counts(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'nan.glb'
            data = _clean_glb(nan=True)
            path.write_bytes(data)
            record, findings = module._inspect_glb(
                path, 'nan.glb', appearance='captured_photo_uv_pbr', texture_expected=True,
                declared={'sha256': _sha(data), 'bytes': len(data), 'origin': 'test'},
            )
            finding = _find(findings, 'glb_attribute_nonfinite')
            self.assertIsNotNone(finding)
            self.assertEqual('POSITION', finding['measured']['attribute'])
            self.assertEqual(1, finding['measured']['nonfinite_vertices'])
            self.assertEqual(1, finding['measured']['nonfinite_elements'])
            # The Y channel is NaN, so the declared accessor bounds are NaN as well.
            self.assertIsNotNone(_find(findings, 'glb_accessor_bounds_nonfinite'))
            self.assertFalse(record['passed'])

    def test_missing_texture_is_reported_when_the_run_declares_pbr(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'untextured.glb'
            data = _clean_glb(without_texture=True)
            path.write_bytes(data)
            record, findings = module._inspect_glb(
                path, 'untextured.glb', appearance='pbr_texture', texture_expected=True,
                declared={'sha256': _sha(data), 'bytes': len(data), 'origin': 'test'},
            )
            finding = _find(findings, 'glb_texture_missing')
            self.assertIsNotNone(finding)
            self.assertEqual(0, finding['measured']['images'])
            self.assertEqual('absent', record['measurements']['texture_state'])
            self.assertFalse(record['passed'])

    def test_geometry_only_artifact_without_texture_is_not_a_failure(self):
        with TemporaryDirectory() as tmp:
            positions, _, _, indices = _pyramid()
            data = _glb_bytes(positions=positions, indices=indices)
            path = Path(tmp) / 'geometry_only.glb'
            path.write_bytes(data)
            record, findings = module._inspect_glb(
                path, 'geometry_only.glb', appearance='geometry_only', texture_expected=False,
                declared={'sha256': _sha(data), 'bytes': len(data), 'origin': 'test'},
            )
            self.assertNotIn('glb_texture_missing', _ids(findings))
            self.assertTrue(record['passed'])

    def test_index_reference_outside_position_count_is_rejected(self):
        with TemporaryDirectory() as tmp:
            positions, normals, uvs, indices = _pyramid()
            bad_indices = indices.copy()
            bad_indices[0, 0] = 99
            data = _glb_bytes(positions=positions, normals=normals, uvs=uvs, indices=bad_indices,
                              image=_texture_png())
            path = Path(tmp) / 'bad_index.glb'
            path.write_bytes(data)
            record, findings = module._inspect_glb(
                path, 'bad_index.glb', appearance='captured_photo_uv_pbr', texture_expected=True,
                declared={'sha256': _sha(data), 'bytes': len(data), 'origin': 'test'},
            )
            self.assertIsNotNone(_find(findings, 'glb_index_invalid'))
            self.assertFalse(record['passed'])


class VerifyKaggleOutputsQualityTests(unittest.TestCase):
    """Measured mesh quality: exact numbers for synthetic meshes, never a verdict."""

    def _inspect(self, data: bytes, *, name: str = 'mesh.glb',
                 texture_expected: bool | None = None) -> tuple[dict, list[dict]]:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / name
            path.write_bytes(data)
            return module._inspect_glb(
                path, name, appearance=None, texture_expected=texture_expected,
                declared={'sha256': _sha(data), 'bytes': len(data), 'origin': 'test'},
            )

    def test_closed_cube_is_watertight_with_zero_boundary_edges(self):
        positions, indices = _cube()
        data = _mesh_glb(positions, indices, image=_texture_png())
        record, findings = self._inspect(data)
        self.assertEqual([], findings)
        quality = record['quality']
        self.assertTrue(quality['measured'])
        self.assertIsNone(quality['reason'])
        self.assertEqual(8, quality['vertices'])
        self.assertEqual(12, quality['triangles'])
        self.assertEqual(0, quality['boundary_edges'])
        self.assertEqual(0, quality['nonmanifold_edges'])
        self.assertEqual(0, quality['degenerate_triangles'])
        self.assertEqual(0, quality['degenerate_repeated_index_triangles'])
        self.assertTrue(quality['watertight'])
        self.assertEqual(1, quality['texture_count'])
        self.assertEqual([[8, 8]], quality['texture_pixels'])
        self.assertEqual(['image/png'], quality['texture_mime_types'])
        self.assertEqual(round(len(data) / 12, 3), quality['bytes_per_face'])
        self.assertEqual(module.QUALITY_SCHEMA_VERSION, quality['schema_version'])
        self.assertEqual(module.QUALITY_DEFINITIONS, quality['definitions'])
        # The quality block is a measurement: it never turns a pass into a fail or vice versa.
        self.assertTrue(record['passed'])

    def test_seam_split_closed_cube_is_open_by_index_but_watertight_once_welded(self):
        """UV seams duplicate vertices: index topology reads a closed solid as 36 open edges.

        Live TRELLIS.2 GLBs measured ~104k index boundary edges but a median of 0 once
        coincident positions are welded, so the welded numbers are what describe the shape.
        """
        positions, indices = _seam_split_cube()
        record, _ = self._inspect(_mesh_glb(positions, indices))
        quality = record['quality']
        self.assertEqual(36, quality['vertices'])
        self.assertFalse(quality['watertight'])
        self.assertEqual(36, quality['boundary_edges'])
        self.assertEqual(8, quality['welded_vertices'])
        self.assertEqual(0, quality['welded_boundary_edges'])
        self.assertEqual(0, quality['welded_nonmanifold_edges'])
        self.assertTrue(quality['welded_watertight'])
        self.assertEqual(1, quality['shell_count'])
        self.assertEqual(100.0, quality['main_shell_triangle_pct'])
        self.assertEqual(1, quality['shells_ge_1pct'])
        self.assertIn('welded_boundary_edges', module.QUALITY_DEFINITIONS)
        self.assertIn('shell_count', module.QUALITY_DEFINITIONS)

    def test_two_disjoint_cubes_are_two_shells_of_equal_size(self):
        """A plate exported beside, not fused with, its food reads as two large shells."""
        first, first_indices = _seam_split_cube()
        second = first + np.array([5.0, 0.0, 0.0], dtype=np.float32)
        positions = np.vstack([first, second]).astype(np.float32)
        indices = np.vstack([first_indices, first_indices + len(first)]).astype(np.uint32)
        record, _ = self._inspect(_mesh_glb(positions, indices))
        quality = record['quality']
        self.assertEqual(16, quality['welded_vertices'])
        self.assertTrue(quality['welded_watertight'])
        self.assertEqual(2, quality['shell_count'])
        self.assertEqual(50.0, quality['main_shell_triangle_pct'])
        self.assertEqual(2, quality['shells_ge_1pct'])
        self.assertEqual([12, 12], quality['shell_triangle_sizes_top5'])

    def test_negative_zero_welds_with_positive_zero(self):
        flat, _ = _open_plane()
        flat = flat.copy()
        flat[0, 0] = -0.0
        # Index 4 is the origin again, written as +0.0; index 0 holds it as -0.0.
        dup = np.vstack([flat, np.array([[0.0, 0.0, 0.0]], dtype=np.float32)])
        tri = np.array([[0, 1, 2], [4, 2, 3]], dtype=np.uint32)
        quality = module._mesh_quality(dup.astype(np.float32), tri, artifact_bytes=10, textures=[])
        self.assertEqual(4, quality['welded_vertices'])
        self.assertEqual(4, quality['welded_boundary_edges'])
        self.assertEqual(1, quality['shell_count'])

    def test_non_finite_positions_leave_welded_topology_unmeasured(self):
        positions, indices = _cube()
        positions = positions.copy()
        positions[0, 0] = np.nan
        quality = module._mesh_quality(positions, indices.astype(np.int64), artifact_bytes=10,
                                       textures=[])
        self.assertTrue(quality['measured'])
        self.assertIsNone(quality['welded_boundary_edges'])
        self.assertIsNone(quality['shell_count'])
        self.assertIn('non-finite', quality['welded_reason'])

    def test_open_plane_reports_four_boundary_edges_and_is_not_watertight(self):
        positions, indices = _open_plane()
        data = _mesh_glb(positions, indices)
        record, findings = self._inspect(data)
        quality = record['quality']
        self.assertEqual(4, quality['vertices'])
        self.assertEqual(2, quality['triangles'])
        self.assertEqual(4, quality['boundary_edges'])
        self.assertEqual(0, quality['nonmanifold_edges'])
        self.assertEqual(0, quality['degenerate_triangles'])
        self.assertFalse(quality['watertight'])
        self.assertEqual(0, quality['texture_count'])
        self.assertEqual([], quality['texture_pixels'])
        self.assertEqual(round(len(data) / 2, 3), quality['bytes_per_face'])
        self.assertEqual(['glb_mesh_not_watertight'], sorted(_ids(findings)))
        self.assertTrue(record['passed'], 'an open shell is a warning, not a structural error')

    def test_shared_edge_is_counted_non_manifold(self):
        positions, indices = _shared_edge_mesh()
        record, _ = self._inspect(_mesh_glb(positions, indices))
        quality = record['quality']
        self.assertEqual(5, quality['vertices'])
        self.assertEqual(3, quality['triangles'])
        self.assertEqual(1, quality['nonmanifold_edges'])
        self.assertEqual(6, quality['boundary_edges'])
        self.assertFalse(quality['watertight'])

    def test_zero_area_triangle_is_counted_degenerate_without_repeated_indices(self):
        positions, indices = _degenerate_mesh()
        record, _ = self._inspect(_mesh_glb(positions, indices))
        quality = record['quality']
        self.assertEqual(2, quality['triangles'])
        self.assertEqual(1, quality['degenerate_triangles'])
        self.assertEqual(0, quality['degenerate_repeated_index_triangles'])
        self.assertEqual(4, quality['boundary_edges'])
        self.assertEqual(0, quality['nonmanifold_edges'])
        self.assertFalse(quality['watertight'])

    def test_triangle_that_repeats_an_index_is_degenerate(self):
        """A sliver ([0,1,1]) encloses no area: it must be counted, not hidden in edge counts."""
        positions = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                             dtype=np.float32)
        indices = np.array([[0, 1, 2], [0, 1, 1]], dtype=np.uint32)
        record, _ = self._inspect(_mesh_glb(positions, indices))
        quality = record['quality']
        self.assertEqual(2, quality['triangles'])
        self.assertEqual(1, quality['degenerate_repeated_index_triangles'])
        self.assertEqual(1, quality['degenerate_triangles'])
        self.assertEqual(1, quality['nonmanifold_edges'])
        self.assertEqual(3, quality['boundary_edges'])
        self.assertFalse(quality['watertight'])

    def test_quality_stays_unmeasured_when_the_primitive_has_no_index_buffer(self):
        cube_positions, _ = _cube()
        # Nine vertices is a whole number of implicit triangles, so only the absent index
        # buffer keeps this mesh unmeasured.
        positions = np.vstack([cube_positions, np.array([[0.0, 0.0, 2.0]], dtype=np.float32)])
        record, findings = self._inspect(_glb_bytes(positions=positions, indices=None))
        quality = record['quality']
        self.assertFalse(quality['measured'])
        self.assertIn('no index buffer', quality['reason'])
        self.assertIsNone(quality['triangles'])
        self.assertIsNone(quality['boundary_edges'])
        self.assertEqual(9, quality['vertices'])
        # The gap stays visible as the pre-existing warning; quality invents no verdict.
        self.assertEqual(['glb_indices_absent'], sorted(_ids(findings)))
        self.assertTrue(record['passed'])

    def test_quality_summary_uses_medians_and_leaves_unmeasured_artifacts_visible(self):
        cube_positions, cube_indices = _cube()
        plane_positions, plane_indices = _open_plane()
        cube = module._mesh_quality(cube_positions, cube_indices, artifact_bytes=1200,
                                    textures=[{'width': 8, 'height': 8, 'mime_type': 'image/png'}])
        plane = module._mesh_quality(plane_positions, plane_indices, artifact_bytes=600,
                                    textures=[])
        unmeasured = module._mesh_quality(None, None, artifact_bytes=None, textures=[])
        summary = module._source_quality([
            {'path': 'a/cube.glb', 'quality': cube},
            {'path': 'a/plane.glb', 'quality': plane},
            {'path': 'a/broken.glb', 'quality': unmeasured},
        ])
        self.assertEqual(3, summary['artifacts'])
        self.assertEqual(2, summary['artifacts_measured'])
        self.assertEqual(1, summary['artifacts_unmeasured'])
        self.assertEqual([{'path': 'a/broken.glb', 'reason': 'POSITION accessor was not decoded'}],
                         summary['unmeasured'])
        self.assertEqual(1, summary['watertight_glbs'])
        self.assertEqual(1, summary['open_shell_glbs'])
        self.assertEqual(50.0, summary['watertight_pct'])
        self.assertEqual(7.0, summary['median_faces'])
        self.assertEqual(2, summary['min_faces'])
        self.assertEqual(12, summary['max_faces'])
        self.assertEqual(2.0, summary['median_boundary_edges'])
        self.assertEqual(0, summary['min_boundary_edges'])
        self.assertEqual(4, summary['max_boundary_edges'])
        self.assertEqual(1, summary['welded_watertight_glbs'])
        self.assertEqual(2.0, summary['median_welded_boundary_edges'])
        self.assertEqual(1.0, summary['median_shell_count'])
        self.assertEqual(100.0, summary['median_main_shell_triangle_pct'])
        self.assertEqual([[8, 8]], summary['texture_pixels_observed'])
        self.assertEqual(module.QUALITY_DEFINITIONS, summary['definitions'])
        self.assertIn('never turns a', summary['note'])

    def test_source_json_and_console_carry_the_measured_quality(self):
        with TemporaryDirectory() as tmp:
            root = _build_tree(Path(tmp) / 'results', labels=('01_alpha',))
            report = module.verify_sources([root])
            source = report['sources'][0]
            quality = source['quality']
            self.assertEqual(2, quality['artifacts'])
            self.assertEqual(2, quality['artifacts_measured'])
            self.assertEqual(2, quality['watertight_glbs'])
            self.assertEqual(100.0, quality['watertight_pct'])
            self.assertEqual(6.0, quality['median_faces'])
            self.assertEqual(0.0, quality['median_boundary_edges'])
            self.assertEqual([[8, 8], [8, 8]], quality['texture_pixels_observed'])
            # Aggregate block: quality is reported but excluded from the integrity verdict.
            self.assertEqual(2, report['quality']['artifacts'])
            self.assertEqual(2, report['quality']['watertight_glbs'])
            self.assertTrue(report['ok'])
            glb = source['dishes'][0]['glbs'][0]
            self.assertEqual(5, glb['quality']['vertices'])
            self.assertEqual(6, glb['quality']['triangles'])
            json.dumps(report)  # the report must stay JSON-serialisable

            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                module._print_summary(report)
            printed = buffer.getvalue()
            self.assertIn('quality 01_alpha/moge2_relief.glb: vertices=5 triangles=6 '
                          'boundary_edges=0 nonmanifold_edges=0 degenerate_triangles=0 '
                          'textures=8x8', printed)
            self.assertIn('quality summary: measured=2/2 watertight=2 (100.0%)', printed)


class VerifyKaggleOutputsTreeTests(unittest.TestCase):
    def test_clean_tree_exits_zero_with_a_populated_report(self):
        with TemporaryDirectory() as tmp:
            root = _build_tree(Path(tmp) / 'results')
            report = module.verify_sources([root])
            self.assertTrue(report['ok'], report['failure_ids'])
            self.assertEqual(0, report['counts']['errors'])
            self.assertEqual(2, report['counts']['dishes'])
            self.assertEqual(4, report['counts']['glb_artifacts'])
            self.assertEqual(4, report['counts']['glb_passed'])
            self.assertEqual(2, report['counts']['image_pairs_passed'])
            source = report['sources'][0]
            self.assertEqual(['MoGe-2 Relief + Ceramic Plate'], source['manifest']['models'])
            self.assertIs(False, source['manifest']['publication_eligible'])
            dish = source['dishes'][0]
            self.assertEqual('match', dish['glbs'][0]['digest'])
            self.assertEqual(0, dish['images']['pixels_differing_from_source'])
            self.assertEqual([40, 32], dish['images']['cutout_dimensions'])
            self.assertIsNotNone(dish['images']['bbox_inclusive'])

            json_out, md_out = Path(tmp) / 'nested' / 'report.json', Path(tmp) / 'nested' / 'report.md'
            exit_code = module.main(['--source', str(root), '--json-out', str(json_out),
                                     '--md-out', str(md_out)])
            self.assertEqual(0, exit_code)
            self.assertTrue(json_out.is_file())
            markdown = md_out.read_text(encoding='utf-8')
            self.assertIn('| Source | Verdict |', markdown)
            self.assertIn('`01_alpha`', markdown)
            self.assertIn(str(root), markdown)
            self.assertIn('PASS', markdown)

    def test_corrupted_tree_exits_one_with_the_expected_finding_id(self):
        with TemporaryDirectory() as tmp:
            root = _build_tree(Path(tmp) / 'results', nan_paths={'02_beta/moge2_relief_mobile.glb'})
            report = module.verify_sources([root])
            self.assertFalse(report['ok'])
            self.assertEqual(1, report['counts']['glb_failed'])
            finding = _find(report['sources'][0]['findings'], 'glb_attribute_nonfinite',
                            '02_beta/moge2_relief_mobile.glb')
            self.assertIsNotNone(finding)
            self.assertEqual(1, finding['measured']['nonfinite_vertices'])
            self.assertEqual('error', finding['severity'])
            exit_code = module.main(['--source', str(root),
                                     '--json-out', str(Path(tmp) / 'report.json'),
                                     '--md-out', str(Path(tmp) / 'report.md')])
            self.assertEqual(1, exit_code)
            markdown = (Path(tmp) / 'report.md').read_text(encoding='utf-8')
            self.assertIn('FAIL', markdown)
            self.assertIn('glb_attribute_nonfinite', markdown)

    def test_digest_mismatch_and_missing_digest_are_explicit_findings(self):
        with TemporaryDirectory() as tmp:
            root = _build_tree(
                Path(tmp) / 'results',
                wrong_digest_paths={'01_alpha/moge2_relief.glb'},
                undeclared_paths={'02_beta/moge2_relief_mobile.glb'},
            )
            report = module.verify_sources([root])
            self.assertFalse(report['ok'])
            findings = report['sources'][0]['findings']
            mismatch = _find(findings, 'artifact_digest_mismatch', '01_alpha/moge2_relief.glb')
            self.assertIsNotNone(mismatch)
            self.assertEqual('0' * 64, mismatch['measured']['declared'])
            self.assertEqual(_sha((root / '01_alpha/moge2_relief.glb').read_bytes()),
                             mismatch['measured']['measured'])
            missing = _find(findings, 'artifact_digest_missing', '02_beta/moge2_relief_mobile.glb')
            self.assertIsNotNone(missing)
            self.assertEqual(1, report['counts']['glb_digest_mismatch'])
            self.assertEqual(1, report['counts']['glb_digest_missing'])

    def test_traversal_artifact_path_is_rejected_without_reading_outside_the_tree(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / 'results'
            outside = Path(tmp) / 'escape.glb'
            outside.write_bytes(_clean_glb())
            _build_tree(root, labels=('01_alpha',), extra_declared=())
            manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
            manifest['extras'].append({'path': '../escape.glb', 'sha256': _sha(outside.read_bytes()),
                                       'bytes': outside.stat().st_size})
            (root / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
            report = module.verify_sources([root])
            unsafe = _find(report['sources'][0]['findings'], 'artifact_unsafe_path')
            self.assertIsNotNone(unsafe)
            self.assertIn('../escape.glb', unsafe['detail'])
            self.assertTrue(outside.is_file())
            subjects = {glb['path'] for dish in report['sources'][0]['dishes'] for glb in dish['glbs']}
            self.assertNotIn('escape.glb', subjects)

    def test_missing_declared_artifact_and_public_tree_are_errors(self):
        with TemporaryDirectory() as tmp:
            root = _build_tree(Path(tmp) / 'results', publication_eligible=True,
                               extra_declared=())
            (root / '02_beta/moge2_relief.glb').unlink()
            report = module.verify_sources([root])
            self.assertFalse(report['ok'])
            findings = report['sources'][0]['findings']
            self.assertIsNotNone(_find(findings, 'manifest_publication_eligible', 'manifest.json'))
            self.assertIsNotNone(_find(findings, 'artifact_missing', '02_beta/moge2_relief.glb'))
            missing_glb = _find(findings, 'glb_artifact_missing', '')
            self.assertIsNone(missing_glb)  # the mobile GLB is still present in that dish

    def test_truncated_glb_in_a_tree_fails_the_source(self):
        with TemporaryDirectory() as tmp:
            root = _build_tree(Path(tmp) / 'results', labels=('01_alpha',),
                               truncated_length_paths={'01_alpha/moge2_relief.glb'})
            report = module.verify_sources([root])
            self.assertFalse(report['ok'])
            finding = _find(report['sources'][0]['findings'], 'glb_length_mismatch',
                            '01_alpha/moge2_relief.glb')
            self.assertIsNotNone(finding)
            self.assertEqual('artifact', finding['check'])

    def test_cutout_pixels_that_invent_color_are_rejected(self):
        with TemporaryDirectory() as tmp:
            root = _build_tree(Path(tmp) / 'results', labels=('01_alpha',))
            repaint = Image.open(root / '01_alpha/cutout_rgba.png').convert('RGBA')
            pixels = repaint.load()
            width, height = repaint.size
            for x in range(width):
                for y in range(height):
                    red, green, blue, alpha = pixels[x, y]
                    if alpha > 0:
                        pixels[x, y] = (255, 0, 255, alpha)
                        break
                else:
                    continue
                break
            repaint.save(root / '01_alpha/cutout_rgba.png')
            manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
            cutout = _artifact(root, '01_alpha/cutout_rgba.png')
            manifest['inputs']['01_alpha']['artifacts'] = [cutout]
            worker = json.loads((root / '01_alpha/worker_output.json').read_text(encoding='utf-8'))
            worker['cutout_sha256'] = cutout['sha256']
            (root / '01_alpha/worker_output.json').write_text(json.dumps(worker, indent=2),
                                                             encoding='utf-8')
            manifest['extras'] = [e for e in manifest['extras']
                                  if not e['path'].endswith('worker_output.json')]
            (root / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
            report = module.verify_sources([root])
            self.assertFalse(report['ok'])
            finding = _find(report['sources'][0]['findings'], 'image_cutout_invented_pixels',
                            '01_alpha/')
            self.assertIsNotNone(finding)
            self.assertEqual(1, finding['measured']['pixels'])
            self.assertEqual(0, report['counts']['image_pairs_passed'])

    def test_metadata_digest_mismatch_is_reported(self):
        with TemporaryDirectory() as tmp:
            root = _build_tree(Path(tmp) / 'results', labels=('01_alpha',))
            worker_path = root / '01_alpha/worker_output.json'
            worker = json.loads(worker_path.read_text(encoding='utf-8'))
            worker['dish_label'] = 'tampered-after-recording'
            worker_path.write_text(json.dumps(worker, indent=2), encoding='utf-8')
            report = module.verify_sources([root])
            self.assertFalse(report['ok'])
            finding = _find(report['sources'][0]['findings'], 'artifact_digest_mismatch',
                            '01_alpha/worker_output.json')
            self.assertIsNotNone(finding)
            metadata = report['sources'][0]['dishes'][0]['metadata_files']
            digests = {entry['path']: entry['digest'] for entry in metadata}
            self.assertEqual('mismatch', digests['01_alpha/worker_output.json'])
            self.assertEqual('not_declared', digests['01_alpha/job_manifest.json'])

    def test_all_runs_skipped_owes_no_glb_and_is_a_warning_not_an_error(self):
        """A token-blocked TRELLIS run produces no mesh; that absence is not a defect."""
        with TemporaryDirectory() as tmp:
            root = _build_tree(Path(tmp) / 'results', labels=('01_alpha',), model_status='skipped')
            report = module.verify_sources([root])
            findings = report['sources'][0]['findings']
            self.assertEqual(report['counts']['errors'], 0, report['failure_ids'])
            self.assertTrue(report['ok'], report['failure_ids'])
            self.assertNotIn('glb_artifact_missing', _ids(findings))
            absent = _find(findings, 'glb_artifact_absent_for_skipped_runs', '01_alpha/')
            self.assertIsNotNone(absent)
            self.assertEqual(absent['severity'], 'warning')
            self.assertEqual(absent['measured']['runs'], {'MoGe-2 Relief + Ceramic Plate': 'skipped'})
            self.assertIsNotNone(_find(findings, 'run_status_skipped', '01_alpha/'))
            self.assertEqual(report['counts']['glb_artifacts'], 0)

    def test_failed_run_without_a_glb_is_still_an_error(self):
        with TemporaryDirectory() as tmp:
            root = _build_tree(Path(tmp) / 'results', labels=('01_alpha',), model_status='failed')
            report = module.verify_sources([root])
            findings = report['sources'][0]['findings']
            self.assertFalse(report['ok'])
            self.assertIsNotNone(_find(findings, 'glb_artifact_missing', '01_alpha/'))
            self.assertIsNone(_find(findings, 'glb_artifact_absent_for_skipped_runs', '01_alpha/'))
            self.assertIsNotNone(_find(findings, 'run_status_failed', '01_alpha/'))

    def test_input_image_is_verified_against_the_staged_digest(self):
        """`source_sha256` describes the upload, so a re-encoded stage must not be a mismatch."""
        with TemporaryDirectory() as tmp:
            root = _build_tree(Path(tmp) / 'results', labels=('01_alpha',), split_input_digest=True)
            job = json.loads((root / '01_alpha/job_manifest.json').read_text(encoding='utf-8'))
            staged = module._sha256_file(root / '01_alpha/input_image.png')
            self.assertEqual(job['input_image_sha256'], staged)
            self.assertNotEqual(job['source_sha256'], staged)
            report = module.verify_sources([root])
            findings = report['sources'][0]['findings']
            self.assertTrue(report['ok'], report['failure_ids'])
            self.assertIsNone(_find(findings, 'artifact_digest_mismatch'))
            self.assertIsNone(_find(findings, 'artifact_digest_missing'))
            entries = {entry['path']: entry
                       for entry in report['sources'][0]['dishes'][0]['image_files']}
            self.assertEqual(entries['01_alpha/input_image.png']['digest'], 'match')
            self.assertEqual(entries['01_alpha/input_image.png']['declared_sha256'], staged)
            self.assertEqual(entries['01_alpha/cutout_rgba.png']['digest'], 'match')
            self.assertEqual(
                module._declared_input_digest({'input_image_sha256': 'a' * 64, 'source_sha256': 'b' * 64}),
                ('input_image_sha256', 'a' * 64),
            )
            self.assertEqual(
                module._declared_input_digest({'source_sha256': 'b' * 64}),
                ('source_sha256', 'b' * 64),
            )
            self.assertIsNone(module._declared_input_digest({}))

    def test_source_missing_is_reported_instead_of_crashing(self):
        with TemporaryDirectory() as tmp:
            report = module.verify_sources([Path(tmp) / 'absent'])
            self.assertFalse(report['ok'])
            self.assertIn('source_missing', report['failure_ids'])
            self.assertEqual(0, report['counts']['dishes'])


if __name__ == '__main__':
    unittest.main()