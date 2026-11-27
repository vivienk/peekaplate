"""Offline unit tests for Track 2B Menu Dishes 3D Studio generator and viewer enhancements."""

from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

FOOD3D_DIR = Path(__file__).resolve().parents[1] / 'scripts' / 'food3d'
if str(FOOD3D_DIR) not in sys.path:
    sys.path.insert(0, str(FOOD3D_DIR))

import build_track2b_studio as studio  # noqa: E402


def _extract_manifest(html_text: str) -> dict:
    match = re.search(
        r'<script id="studio-manifest" type="application/json">(.*?)</script>',
        html_text,
        flags=re.DOTALL,
    )
    if not match:
        raise AssertionError('studio-manifest JSON script tag missing')
    return json.loads(match.group(1))


def _write_png(path: Path, color: tuple[int, int, int] = (120, 140, 160)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new('RGB', (16, 16), color).save(path, format='PNG')


def _create_fixture_dish(
    recon_dir: Path,
    dish: str,
    *,
    glb_150_bytes: int = 2048,
    glb_35_bytes: int = 1024,
    extra_reason: str = '[photo_fidelity] ssim 0.075 < 0.15',
) -> Path:
    dish_dir = recon_dir / dish
    (dish_dir / 'eval').mkdir(parents=True, exist_ok=True)
    (dish_dir / 'pbr_150k').mkdir(parents=True, exist_ok=True)
    (recon_dir / 'datasets' / dish).mkdir(parents=True, exist_ok=True)

    (dish_dir / 'lod_150k_2048.pbr.glb').write_bytes(b'glTF' + b'\x00' * (glb_150_bytes - 4))
    (dish_dir / 'lod_35k_1024.pbr.glb').write_bytes(b'glTF' + b'\x00' * (glb_35_bytes - 4))

    (dish_dir / 'qa_report_150k.json').write_text(
        json.dumps(
            {
                'schema_version': 1,
                'publication_eligible': False,
                'verdict': 'FAIL',
                'reasons': [extra_reason],
                'warnings': ['[photo_fidelity] delta_e 27.06 > 18.0'],
                'checks': {
                    'gltf_budget': {
                        'status': 'PASS',
                        'glb_bytes': glb_150_bytes,
                        'max_bytes': 5242880,
                        'triangles': 150000,
                        'max_tris': 155000,
                        'validate_ok': True,
                    },
                    'geometry': {
                        'status': 'PASS',
                        'extents': [0.24, 0.09, 0.23],
                        'seated': True,
                        'shells': 12,
                        'faces': 150000,
                        'bake_diameter_cm': 24.0,
                        'bake_calibrated': False,
                    },
                    'pbr_material': {
                        'status': 'PASS',
                        'metallic_factor': 0.0,
                        'roughness_mean': 0.61,
                        'roughness_std': 0.22,
                        'clearcoat_mean': 0.10,
                        'clearcoat_std': 0.12,
                        'has_normal_texture': True,
                        'has_occlusion_texture': True,
                        'has_clearcoat': True,
                    },
                    'photo_fidelity': {
                        'status': 'FAIL',
                        'poses_evaluated': 216,
                        'best_pose': {'az': -30, 'el': 50, 'file': 'pose_az-30_el50.png'},
                        'match': 0.6442,
                        'silhouette_iou': 0.8775,
                        'delta_e': 27.06,
                        'ssim': 0.0745,
                        'detail_corr': 0.0748,
                        'reasons': ['ssim 0.075 < 0.15'],
                        'warnings': ['delta_e 27.06 > 18.0'],
                    },
                    'relighting': {
                        'status': 'PASS',
                        'relit_mean_diff': 5.727,
                        'relit_p95_diff': 14.0,
                        'min_p95_diff': 8.0,
                        'foreground_pixels': 108744,
                    },
                },
            }
        ),
        encoding='utf-8',
    )

    (dish_dir / 'qa_report_35k.json').write_text(
        json.dumps(
            {
                'schema_version': 1,
                'publication_eligible': False,
                'verdict': 'PASS',
                'reasons': [],
                'warnings': [],
                'checks': {
                    'gltf_budget': {
                        'status': 'PASS',
                        'glb_bytes': glb_35_bytes,
                        'max_bytes': 5242880,
                        'triangles': 35000,
                        'max_tris': 40000,
                        'validate_ok': True,
                    },
                    'geometry': {'status': 'PASS', 'faces': 35000, 'seated': True},
                    'pbr_material': {'status': 'PASS', 'roughness_mean': 0.63, 'roughness_std': 0.22},
                },
            }
        ),
        encoding='utf-8',
    )

    (dish_dir / 'track2b_recon_meta.json').write_text(
        json.dumps(
            {
                'schema_version': 1,
                'pipeline': 'food3d-track2b-2dgs-tsdf',
                'publication_eligible': False,
                'dish': dish,
                'train_views_used': 70,
                'steps': 15000,
                'final_splats': 388015,
                'train_seconds': 728.56,
                'tsdf_seconds': 89.19,
                'tsdf_settings': {'voxel_divisions': 768},
                'train_photometric': {'full_psnr_db': 30.41, 'fg_psnr_db': 29.38},
                'train_silhouette_iou': 0.9615,
                'dense_faces': 2248858,
                'world_to_metric': {'diameter_cm': 24.0, 'calibrated': False, 'dimensions_m': [0.24, 0.09, 0.23]},
                'remote': {'host': 'colab', 'gpu': 'NVIDIA L4', 'mem_total_gib': 53.0},
            }
        ),
        encoding='utf-8',
    )

    (dish_dir / 'eval' / 'score_summary.json').write_text(
        json.dumps(
            {
                'schema_version': 1,
                'publication_eligible': False,
                'albedo': {
                    'full_psnr_db': {'mean': 18.14},
                    'fg_psnr_db': {'mean': 16.84},
                    'full_ssim': {'mean': 0.598},
                    'fg_ssim': {'mean': 0.466},
                    'fg_delta_e': {'mean': 12.89},
                },
                'lit': {
                    'full_psnr_db': {'mean': 17.03},
                    'fg_psnr_db': {'mean': 15.87},
                    'full_ssim': {'mean': 0.551},
                    'fg_ssim': {'mean': 0.407},
                    'fg_delta_e': {'mean': 16.05},
                },
            }
        ),
        encoding='utf-8',
    )

    (recon_dir / 'datasets' / dish / 'conversion_report.json').write_text(
        json.dumps(
            {
                'publication_eligible': False,
                'train_frames': 70,
                'eval_frames': 10,
                'registered_frames': 80,
                'target_frames': 80,
                'sampled_views': 32,
                'registration_rate': 1.0,
                'mean_reprojection_error_px': 0.8042,
                'num_colmap_points3d': 38003,
            }
        ),
        encoding='utf-8',
    )

    for rel in (
        'eval/turntable_contact_sheet.png',
        'eval/heldout_eval_sheet_lit.png',
        'eval/heldout_eval_sheet_albedo.png',
        'eval/fidelity_diag.png',
        'pbr_150k/pbr_masks_debug.png',
    ):
        _write_png(dish_dir / rel)
    return dish_dir


class TestTrack2BStudioDiscoveryAndMetrics(unittest.TestCase):
    def test_discovers_valid_dishes_and_skips_non_dish_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            recon = Path(tmp)
            for ignored in ('datasets', 'colab', 'logs', '_refs', '_three', '.hidden', 'empty_dir'):
                (recon / ignored).mkdir(parents=True, exist_ok=True)
            (recon / 'datasets' / 'fake_dish').mkdir(parents=True)
            (recon / 'datasets' / 'fake_dish' / 'lod_150k_2048.pbr.glb').write_bytes(b'glTF')

            _create_fixture_dish(recon, 'refined_burrito_bowl')
            dish_35_only = recon / 'refined_taco'
            dish_35_only.mkdir()
            (dish_35_only / 'lod_35k_1024.pbr.glb').write_bytes(b'glTF')

            self.assertEqual(studio.discover_dishes(recon), ['refined_burrito_bowl', 'refined_taco'])

    def test_extracts_exact_metrics_copies_assets_and_enforces_disclosure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            recon = root / 'recon'
            refs = root / 'refs'
            recon.mkdir()
            refs.mkdir()

            _create_fixture_dish(recon, 'refined_burrito_bowl', glb_150_bytes=4223604, glb_35_bytes=1642060)
            _write_png(refs / 'burrito_bowl.png', (200, 120, 80))

            out_html = studio.build_track2b_studio(recon, refs_dir=refs)
            self.assertEqual(out_html, recon / 'studio.html')
            self.assertTrue(out_html.is_file())
            self.assertTrue((recon / 'viewer.html').is_file())
            self.assertFalse((recon / 'viewer.html').is_symlink())
            self.assertTrue((recon / '_three').is_symlink())
            self.assertTrue((recon / '_three' / 'build' / 'three.module.js').is_file())
            self.assertTrue((recon / '_refs' / 'burrito_bowl.png').is_file())
            self.assertFalse((recon / '_refs' / 'burrito_bowl.png').is_symlink())

            html_text = out_html.read_text(encoding='utf-8')
            manifest = _extract_manifest(html_text)
            self.assertIs(manifest['publication_eligible'], False)
            self.assertIn('Flow', manifest['disclosure'])
            self.assertIn('unverified', manifest['disclosure'])

            dish = manifest['dishes'][0]
            self.assertIs(dish['publication_eligible'], False)
            self.assertEqual(dish['variants']['150k']['mb'], '4.03 MB')
            self.assertEqual(dish['variants']['150k']['triangles'], 150000)
            self.assertEqual(dish['variants']['150k']['verdict'], 'FAIL')
            self.assertEqual(dish['variants']['35k']['mb'], '1.57 MB')
            self.assertEqual(dish['variants']['35k']['triangles'], 35000)
            self.assertEqual(dish['variants']['35k']['verdict'], 'PASS')
            self.assertEqual(dish['dataset']['train_frames'], 70)
            self.assertEqual(dish['dataset']['eval_frames'], 10)
            self.assertEqual(dish['dataset']['registered_frames'], 80)
            self.assertEqual(dish['dataset']['sampled_views'], 32)
            self.assertEqual(dish['recon_meta']['remote_gpu'], 'NVIDIA L4')
            self.assertAlmostEqual(dish['heldout_eval']['lit']['fg_ssim']['mean'], 0.407, places=3)
            self.assertEqual(dish['assets']['reference_photo'], '_refs/burrito_bowl.png')
            self.assertEqual(dish['assets']['fidelity_diag'], 'refined_burrito_bowl/eval/fidelity_diag.png')

            # Disclosure & ADR 0004 badges in HTML + ratings export JS
            self.assertIn('publication_eligible: false', html_text)
            self.assertIn('ADR 0004', html_text)
            self.assertIn('Flow footage', html_text)
            self.assertIn('publication_eligible: false,', html_text)
            self.assertNotIn('.innerHTML', html_text)

            # Zero external CDN links; only localhost helper text allowed
            urls = re.findall(r'https?://[^\s"\'<>`]+', html_text)
            self.assertTrue(all(u.startswith('http://localhost:8767') for u in urls), f'Unexpected URLs: {urls}')


class TestTrack2BStudioSecurityAndEscaping(unittest.TestCase):
    def test_rejects_symlinks_across_dishes_reports_glbs_images_and_refs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outside = root / 'outside'
            outside.mkdir()
            (outside / 'secret.json').write_text('{"verdict": "PASS"}', encoding='utf-8')
            (outside / 'secret.glb').write_bytes(b'glTF')
            _write_png(outside / 'secret.png')

            # 1. Symlinked dish dir
            recon1 = root / 'recon_dish_sym'
            recon1.mkdir()
            (recon1 / 'evil_dish').symlink_to(outside)
            with self.assertRaises(RuntimeError):
                studio.discover_dishes(recon1)

            # 2. Symlinked JSON report
            recon2 = root / 'recon_json_sym'
            recon2.mkdir()
            d2 = _create_fixture_dish(recon2, 'refined_bowl')
            (d2 / 'qa_report_150k.json').unlink()
            (d2 / 'qa_report_150k.json').symlink_to(outside / 'secret.json')
            with self.assertRaises(RuntimeError):
                studio.build_track2b_studio(recon2)

            # 3. Symlinked GLB
            recon3 = root / 'recon_glb_sym'
            recon3.mkdir()
            d3 = _create_fixture_dish(recon3, 'refined_bowl')
            (d3 / 'lod_150k_2048.pbr.glb').unlink()
            (d3 / 'lod_150k_2048.pbr.glb').symlink_to(outside / 'secret.glb')
            with self.assertRaises(RuntimeError):
                studio.build_track2b_studio(recon3)

            # 4. Symlinked eval PNG
            recon4 = root / 'recon_png_sym'
            recon4.mkdir()
            d4 = _create_fixture_dish(recon4, 'refined_bowl')
            (d4 / 'eval' / 'fidelity_diag.png').unlink()
            (d4 / 'eval' / 'fidelity_diag.png').symlink_to(outside / 'secret.png')
            with self.assertRaises(RuntimeError):
                studio.build_track2b_studio(recon4)

            # 5. Symlinked ref photo
            recon5 = root / 'recon_ref_sym'
            recon5.mkdir()
            _create_fixture_dish(recon5, 'refined_bowl')
            refs = root / 'refs'
            refs.mkdir()
            (refs / 'bowl.png').symlink_to(outside / 'secret.png')
            with self.assertRaises(RuntimeError):
                studio.build_track2b_studio(recon5, refs_dir=refs)

            # 6. Escaping dish name
            with self.assertRaises(RuntimeError):
                studio.build_track2b_studio(recon5, dishes=['../outside'])

    def test_escapes_script_and_html_injection_in_manifest_and_title(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            recon = Path(tmp)
            evil = '</script><script>alert("xss")</script>&<>'
            _create_fixture_dish(recon, 'refined_burrito_bowl', extra_reason=evil)
            out_html = studio.build_track2b_studio(recon, title=f'Studio {evil}')
            html_text = out_html.read_text(encoding='utf-8')

            self.assertNotIn('<script>alert("xss")</script>', html_text)
            manifest = _extract_manifest(html_text)
            self.assertEqual(manifest['dishes'][0]['qa_150k']['reasons'][0], evil)
            self.assertIn('&lt;/script&gt;&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;&amp;&lt;&gt;', html_text)


class TestViewerBackwardCompatibilityAndNewControls(unittest.TestCase):
    def test_viewer_supports_hud_zero_autorotate_and_postmessage_controls(self) -> None:
        viewer_text = (FOOD3D_DIR / 'viewer.html').read_text(encoding='utf-8')
        self.assertIn("params.get('hud') !== '0'", viewer_text)
        self.assertIn("params.get('autoRotate') === '1'", viewer_text)
        self.assertIn("controls.autoRotateSpeed = 1.6", viewer_text)
        self.assertIn("data.type === 'food3d:setAutoRotate'", viewer_text)
        self.assertIn("data.type === 'food3d:resetCamera'", viewer_text)
        self.assertIn('setCameraPose(initAzDeg, initElDeg)', viewer_text)
        self.assertIn('publication_eligible: false', viewer_text)


if __name__ == '__main__':
    unittest.main()
