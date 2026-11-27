"""Offline unit tests for watertight MoGe-2 relief GLB export and photo UV PBR baker."""

from __future__ import annotations

from io import BytesIO
import hashlib
import json
from pathlib import Path
import struct
from tempfile import TemporaryDirectory
import unittest

import numpy as np
from PIL import Image, ImageDraw, ImageOps

from peekaplate_processing.multi_model_3d import (
    MAX_MOBILE_FACES,
    _decimate_vertex_cluster,
    bake_photographic_uv_pbr_glb,
    build_moge2_relief_and_ceramic_plate_glb,
    check_watertight_edges,
    run_local_moge2_relief_batch,
    stage_source_image,
    write_pbr_glb,
)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _kaggle_style_png(path: Path, *, size: tuple[int, int] = (64, 48), seed: int = 7) -> bytes:
    """Write a PNG whose re-encode emits different deflate bytes for identical pixels.

    Kaggle's Pillow/zlib emitted a different deflate stream for the same pixels, which is exactly how
    a re-encoded staging copy replaced the measured dataset digest in v32.
    """
    rng = np.random.default_rng(seed)
    pixels = rng.integers(0, 256, size=(size[1], size[0], 3), dtype=np.uint8)
    Image.fromarray(pixels, 'RGB').save(path, format='PNG', compress_level=1)
    return path.read_bytes()


def _naive_reencode(path: Path) -> bytes:
    """The pre-fix staging path: decode, normalize, and re-encode into a fresh PNG."""
    buffer = BytesIO()
    with Image.open(path) as im:
        ImageOps.exif_transpose(im).convert('RGB').save(buffer, format='PNG', optimize=True)
    return buffer.getvalue()


def _parse_glb_chunks(glb_path: Path) -> tuple[dict, bytes]:
    raw = glb_path.read_bytes()
    magic, version, total = struct.unpack('<4sII', raw[:12])
    assert magic == b'glTF'
    assert version == 2
    assert total == len(raw)
    json_len, json_type = struct.unpack('<II', raw[12:20])
    assert json_type == 0x4E4F534A
    json_obj = json.loads(raw[20:20 + json_len].decode('utf-8'))
    bin_off = 20 + json_len
    bin_len, bin_type = struct.unpack('<II', raw[bin_off:bin_off + 8])
    assert bin_type == 0x004E4942
    bin_bytes = raw[bin_off + 8:bin_off + 8 + bin_len]
    return json_obj, bin_bytes


class MultiModel3DTests(unittest.TestCase):
    def test_staging_copies_source_bytes_verbatim_when_no_transformation_is_needed(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            src = root / '01_pizza.png'
            original = _kaggle_style_png(src)
            # Non-vacuous reproducer: the pre-fix staging bytes differ from the source photo bytes.
            self.assertNotEqual(_naive_reencode(src), original)

            staged_path = root / 'input_image.png'
            staging = stage_source_image(src, staged_path)

            self.assertEqual(staged_path.read_bytes(), original)
            self.assertEqual(staging['input_filename'], 'input_image.png')
            self.assertEqual(staging['source_sha256'], _sha256(original))
            self.assertEqual(staging['input_image_sha256'], staging['source_sha256'])
            self.assertEqual(staging['input_transformation'], 'none')
            self.assertTrue(staging['input_byte_identical'])
            self.assertEqual(staging['source_bytes'], len(original))
            self.assertEqual(staging['size'], [64, 48])

    def test_staging_keeps_source_identity_when_a_transformation_is_required(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            src = root / '01_rotated.jpg'
            # EXIF orientation 6 = rotate 90 deg: a real transformation, so PNG staging must re-encode.
            exif = Image.Exif()
            exif[0x0112] = 6
            Image.new('RGB', (40, 24), (200, 120, 60)).save(src, format='JPEG', quality=95, exif=exif)
            original = src.read_bytes()

            staged_path = root / 'input_image.png'
            staging = stage_source_image(src, staged_path)
            staged_bytes = staged_path.read_bytes()

            self.assertEqual(staging['source_sha256'], _sha256(original))
            self.assertEqual(staging['input_image_sha256'], _sha256(staged_bytes))
            self.assertNotEqual(staging['input_image_sha256'], staging['source_sha256'])
            self.assertFalse(staging['input_byte_identical'])
            self.assertIn('exif_transpose', staging['input_transformation'])
            self.assertIn('png_encode', staging['input_transformation'])
            with Image.open(staged_path) as staged:
                self.assertEqual(staged.format, 'PNG')
                self.assertIn(staged.getexif().get(0x0112), (None, 1))
                self.assertEqual(list(staged.size), [24, 40])

    def test_batch_manifest_separates_source_bytes_from_staged_artifact(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            ds = root / 'dataset'
            ds.mkdir()
            original = _kaggle_style_png(ds / '01_pizza.png')
            Image.new('RGB', (32, 20), (30, 30, 40)).save(ds / '02_tteokbokki.png')

            out_dir = root / 'out'
            manifest = run_local_moge2_relief_batch(ds, out_dir)

            entry = manifest['inputs']['01_pizza']
            self.assertEqual(entry['source_sha256'], _sha256(original))
            self.assertEqual(entry['source_bytes'], len(original))
            self.assertEqual(entry['input_filename'], 'input_image.png')
            self.assertEqual(entry['input_image_sha256'], entry['source_sha256'])
            self.assertEqual(entry['input_transformation'], 'none')
            self.assertTrue(entry['input_byte_identical'])
            self.assertEqual((out_dir / '01_pizza' / 'input_image.png').read_bytes(), original)
            # Keys other code reads stay present and unchanged in meaning.
            self.assertEqual(entry['image_status'], 'success')
            self.assertEqual(entry['size'], [64, 48])
            self.assertIn('cutout_metrics', entry)
            self.assertEqual(
                [artifact['path'] for artifact in entry['artifacts']],
                ['01_pizza/input_image.png', '01_pizza/cutout_rgba.png', '01_pizza/job_manifest.json'],
            )

            job_manifest = json.loads((out_dir / '01_pizza' / 'job_manifest.json').read_text(encoding='utf-8'))
            self.assertEqual(job_manifest['job_id'], 'rd-01_pizza')
            self.assertIs(job_manifest['publication_eligible'], False)
            self.assertEqual(job_manifest['source_sha256'], _sha256(original))
            self.assertEqual(job_manifest['input_image_sha256'], job_manifest['source_sha256'])
            self.assertEqual(job_manifest['input_transformation'], 'none')
            self.assertTrue(job_manifest['input_byte_identical'])

    def test_batch_manifest_declares_derived_digest_for_transformed_source(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            ds = root / 'dataset'
            ds.mkdir()
            exif = Image.Exif()
            exif[0x0112] = 6
            src = ds / '03_rotated.jpg'
            Image.new('RGB', (48, 32), (180, 70, 40)).save(src, format='JPEG', quality=95, exif=exif)
            original = src.read_bytes()

            out_dir = root / 'out'
            manifest = run_local_moge2_relief_batch(ds, out_dir)

            entry = manifest['inputs']['03_rotated']
            staged_path = out_dir / '03_rotated' / 'input_image.png'
            self.assertEqual(entry['source_sha256'], _sha256(original))
            self.assertNotEqual(entry['input_image_sha256'], entry['source_sha256'])
            self.assertEqual(entry['input_image_sha256'], _sha256(staged_path.read_bytes()))
            self.assertIn('exif_transpose', entry['input_transformation'])
            self.assertFalse(entry['input_byte_identical'])
            job_manifest = json.loads((out_dir / '03_rotated' / 'job_manifest.json').read_text(encoding='utf-8'))
            self.assertEqual(job_manifest['source_sha256'], _sha256(original))
            self.assertEqual(job_manifest['input_image_sha256'], _sha256(staged_path.read_bytes()))

    def test_moge2_relief_watertight_glb_bounds_and_mobile_limit(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Draw concave bowl/plate with non-circular protrusion to stress-test pinch elimination & manifoldness
            im = Image.new('RGBA', (192, 160), (0, 0, 0, 0))
            draw = ImageDraw.Draw(im)
            draw.ellipse((24, 24, 150, 140), fill=(195, 110, 65, 255))
            draw.rectangle((120, 60, 175, 92), fill=(210, 180, 110, 255))
            cutout = root / 'cutout_rgba.png'
            im.save(cutout)

            # Synthetic height map array simulates MoGe-2 depth inference output
            yy, xx = np.mgrid[0:160, 0:192]
            depth = 2.0 - 0.5 * np.exp(-((yy - 80) ** 2 + (xx - 90) ** 2) / 900.0)

            raw_glb = root / 'moge2_relief.glb'
            mob_glb = root / 'moge2_relief_mobile.glb'
            res = build_moge2_relief_and_ceramic_plate_glb(
                cutout,
                raw_glb,
                mob_glb,
                depth_map=depth.astype(np.float32),
                raw_grid_res=120,
                mobile_grid_res=86,
            )

            self.assertFalse(res['publication_eligible'])
            self.assertTrue(res['raw']['watertight'])
            self.assertEqual(res['raw']['boundary_edges'], 0)
            self.assertEqual(res['raw']['nonmanifold_edges'], 0)
            self.assertTrue(res['mobile']['watertight'])
            self.assertEqual(res['mobile']['boundary_edges'], 0)
            self.assertLessEqual(res['mobile']['faces'], MAX_MOBILE_FACES)

            gltf_raw, bin_bytes = _parse_glb_chunks(raw_glb)
            self.assertFalse(gltf_raw['asset']['extras']['publication_eligible'])
            self.assertGreaterEqual(len(gltf_raw['images']), 1)
            pos_acc = gltf_raw['accessors'][1]
            bv_pos = gltf_raw['bufferViews'][pos_acc['bufferView']]
            pts = np.frombuffer(
                bin_bytes[bv_pos['byteOffset']:bv_pos['byteOffset'] + bv_pos['byteLength']],
                dtype=np.float32,
            ).reshape(-1, 3)
            self.assertEqual(len(pts), pos_acc['count'])
            for axis in range(3):
                self.assertAlmostEqual(pos_acc['min'][axis], float(pts[:, axis].min()), places=5)
                self.assertAlmostEqual(pos_acc['max'][axis], float(pts[:, axis].max()), places=5)
            # Resting ceramic foot touches y >= 0
            self.assertGreaterEqual(pos_acc['min'][1], -1e-5)

    def test_bake_photographic_uv_pbr_glb_and_batch_runner(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            ds = root / 'dataset'
            ds.mkdir()
            # Two dataset dishes: one with explicit _mask.png, one unmasked
            img1 = Image.new('RGB', (128, 128), (28, 34, 44))
            ImageDraw.Draw(img1).ellipse((20, 20, 108, 108), fill=(200, 95, 45))
            img1.save(ds / '05_ikari_steak_ramen.png')
            mask1 = Image.new('L', (128, 128), 0)
            ImageDraw.Draw(mask1).ellipse((20, 20, 108, 108), fill=255)
            mask1.save(ds / '05_ikari_steak_ramen_mask.png')

            img2 = Image.new('RGB', (128, 128), (30, 30, 35))
            ImageDraw.Draw(img2).ellipse((28, 28, 100, 100), fill=(185, 165, 80))
            img2.save(ds / '15_zaru_ramen.png')

            # Also test bake_photographic_uv_pbr_glb on a closed icosphere/tetra box
            verts = np.array([
                [-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1],
                [0, 1.2, 0], [0, -0.5, 0],
            ], dtype=np.float32)
            faces = np.array([
                [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4],
                [1, 0, 5], [2, 1, 5], [3, 2, 5], [0, 3, 5],
            ], dtype=np.uint32)
            wt, b, nm = check_watertight_edges(faces)
            self.assertTrue(wt and b == 0 and nm == 0)

            out_dir = root / 'out'
            man = run_local_moge2_relief_batch(ds, out_dir)
            self.assertFalse(man['publication_eligible'])
            self.assertEqual(sorted(man['inputs'].keys()), ['05_ikari_steak_ramen', '15_zaru_ramen'])
            self.assertEqual(
                man['inputs']['05_ikari_steak_ramen']['cutout_metrics']['plate_method'],
                'precomputed_pdf_smask',
            )
            self.assertTrue((out_dir / '05_ikari_steak_ramen' / 'moge2_relief.glb').is_file())
            self.assertTrue((out_dir / '15_zaru_ramen' / 'moge2_relief_mobile.glb').is_file())

            baked = bake_photographic_uv_pbr_glb(
                verts,
                faces,
                out_dir / '05_ikari_steak_ramen' / 'cutout_rgba.png',
                root / 'baked.glb',
                root / 'baked_mobile.glb',
                texture_size=256,
            )
            self.assertTrue(baked['raw']['has_texture'])
            self.assertEqual(baked['raw']['faces'], len(faces))
            self.assertTrue((root / 'baked_mobile.glb').is_file())
            _ = write_pbr_glb

    def test_decimation_never_returns_the_unchanged_mesh(self):
        """Kaggle benchmark-a/4 shipped 5,445,228-face `mobile` GLBs: the old loop returned its input.

        A volumetric triangle soup is the adversarial case: voxel clustering costs O(bins^3), so the
        six-round decay from 130 bins could not meet the ceiling and fell through to `return input`.
        The contract is now "smallest reachable mesh", and the baker decides whether it is shippable.
        """
        rng = np.random.default_rng(11)
        triangles = 120_000
        verts = rng.random((triangles * 3, 3), dtype=np.float32)
        faces = np.arange(triangles * 3, dtype=np.uint32).reshape(triangles, 3)
        dec_v, dec_f = _decimate_vertex_cluster(verts, faces, MAX_MOBILE_FACES)
        self.assertLess(len(dec_f), len(faces), 'decimation returned the unchanged mesh')
        self.assertGreater(len(dec_f), 0)
        self.assertGreater(len(dec_v), 0)
        self.assertEqual(dec_v.dtype, np.float32)
        self.assertEqual(dec_f.dtype, np.uint32)
        # A planar grid, where clustering does reach the ceiling, still lands under the limit.
        side = 512
        xs, zs = np.meshgrid(np.linspace(-1, 1, side), np.linspace(-1, 1, side))
        grid_v = np.stack([xs.ravel(), np.zeros(side * side), zs.ravel()], axis=1).astype(np.float32)
        idx = np.arange(side * side).reshape(side, side)
        quads = np.stack([
            idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel(),
            idx[1:, 1:].ravel(), idx[1:, :-1].ravel(),
        ], axis=1).astype(np.uint32)
        grid_f = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]], axis=0).astype(np.uint32)
        flat_v, flat_f = _decimate_vertex_cluster(grid_v, grid_f, MAX_MOBILE_FACES)
        self.assertLessEqual(len(flat_f), MAX_MOBILE_FACES)
        self.assertGreater(len(flat_v), 0)

    def test_unreachable_ceiling_raises_instead_of_returning_the_raw_mesh(self):
        verts = np.array([[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]], dtype=np.float32)
        faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.uint32)
        with self.assertRaises(ValueError):
            _decimate_vertex_cluster(verts, faces, 1)
        # A target the clustering already satisfies is returned untouched.
        same_v, same_f = _decimate_vertex_cluster(verts, faces, 2)
        self.assertEqual(len(same_f), 2)
        self.assertTrue(np.array_equal(same_f, faces))

    def test_bake_omits_a_mobile_glb_it_cannot_ceiling(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            cutout = root / 'cutout_rgba.png'
            im = Image.new('RGBA', (96, 96), (0, 0, 0, 0))
            ImageDraw.Draw(im).ellipse((8, 8, 88, 88), fill=(190, 105, 60, 255))
            im.save(cutout)
            rng = np.random.default_rng(5)
            triangles = 20_000
            verts = rng.random((triangles * 3, 3), dtype=np.float32)
            faces = np.arange(triangles * 3, dtype=np.uint32).reshape(triangles, 3)
            mobile = root / 'baked_mobile.glb'
            baked = bake_photographic_uv_pbr_glb(
                verts, faces, cutout, root / 'baked.glb', mobile,
                texture_size=128, max_mobile_faces=4,
            )
            self.assertTrue(baked['raw']['has_texture'])
            self.assertIsNone(baked['mobile'])
            self.assertIn('refusing to export an oversized mobile GLB', baked['mobile_error'])
            self.assertFalse(mobile.exists())
            self.assertTrue((root / 'baked.glb').is_file())

    def test_moge2_relief_sanitizes_nonfinite_depth_and_normal_maps(self):
        nb_scope = {}
        nb_cells = json.loads(
            (Path(__file__).resolve().parents[2] / 'notebooks' / 'trellislast-version.ipynb').read_text(encoding='utf-8')
        )['cells']
        exec(compile(''.join(nb_cells[1]['source']), 'cell_1', 'exec'), nb_scope)
        exec(compile(''.join(nb_cells[2]['source']), 'cell_2', 'exec'), nb_scope)
        validate_glb = nb_scope['validate_glb']

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            im = Image.new('RGBA', (160, 120), (0, 0, 0, 0))
            ImageDraw.Draw(im).ellipse((20, 15, 140, 105), fill=(190, 105, 60, 255))
            cutout = root / 'cutout_rgba.png'
            im.save(cutout)

            # Same-resolution and resized depth cases: >10% foreground border + all background = +inf, plus NaN specks.
            yy, xx = np.mgrid[0:120, 0:160]
            dist2 = ((yy - 60) / 40.0) ** 2 + ((xx - 80) / 55.0) ** 2
            depth_same = (1.8 - 0.4 * np.exp(-dist2)).astype(np.float32)
            depth_same[dist2 > 0.72] = np.inf
            depth_same[58:62, 78:82] = np.nan

            normal_f = np.zeros((120, 160, 3), dtype=np.float32)
            normal_f[..., 2] = 1.0
            normal_f[dist2 > 0.72] = np.inf
            normal_f[58:62, 78:82] = np.nan

            for case, dm in (
                ('same_res', depth_same),
                ('resized', depth_same[::2, ::2]),
                ('all_inf_fallback', np.full((120, 160), np.inf, dtype=np.float32)),
            ):
                with self.subTest(case=case):
                    raw_glb = root / f'{case}_raw.glb'
                    mob_glb = root / f'{case}_mob.glb'
                    res = build_moge2_relief_and_ceramic_plate_glb(
                        cutout,
                        raw_glb,
                        mob_glb,
                        depth_map=dm,
                        normal_map=normal_f,
                        raw_grid_res=90,
                        mobile_grid_res=60,
                    )
                    self.assertTrue(res['raw']['watertight'])
                    self.assertEqual(res['raw']['boundary_edges'], 0)
                    self.assertTrue(res['mobile']['watertight'])
                    self.assertEqual(res['mobile']['boundary_edges'], 0)
                    for path in (raw_glb, mob_glb):
                        meta = validate_glb(path)
                        self.assertTrue(meta['has_texture'])
                        gltf, bin_bytes = _parse_glb_chunks(path)
                        pos_acc = gltf['accessors'][1]
                        bv_pos = gltf['bufferViews'][pos_acc['bufferView']]
                        pts = np.frombuffer(
                            bin_bytes[bv_pos['byteOffset']:bv_pos['byteOffset'] + bv_pos['byteLength']],
                            dtype=np.float32,
                        ).reshape(-1, 3)
                        self.assertTrue(np.isfinite(pts).all())

            # write_pbr_glb rejects direct non-finite attributes cleanly
            with self.assertRaises(ValueError):
                write_pbr_glb(
                    np.array([[0.0, np.nan, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]], dtype=np.float32),
                    np.array([[0, 1, 2]], dtype=np.uint32),
                    np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]], dtype=np.float32),
                    Image.new('RGB', (8, 8), (128, 128, 128)),
                    root / 'bad_nan.glb',
                )


if __name__ == '__main__':
    unittest.main(verbosity=2)
