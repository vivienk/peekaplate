"""Unit tests for Food3D V1 Stage 4-5 QA Gate & Studio (offline, no Chromium)."""

from __future__ import annotations

import hashlib
import io
import json
import struct
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import numpy as np
from PIL import Image

FOOD3D_DIR = Path(__file__).resolve().parents[1] / 'scripts' / 'food3d'
if str(FOOD3D_DIR) not in sys.path:
    sys.path.insert(0, str(FOOD3D_DIR))

import build_studio  # noqa: E402
import qa_gate  # noqa: E402


def _pad4(data: bytes, pad_byte: bytes = b'\x00') -> bytes:
    rem = len(data) % 4
    return data if rem == 0 else data + pad_byte * (4 - rem)


def _encode_webp(arr_rgb: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr_rgb.astype(np.uint8), mode='RGB').save(buf, format='WEBP', lossless=True)
    return buf.getvalue()


def _build_synthetic_pbr_glb(
    out_path: Path,
    *,
    metallic_factor: float = 0.0,
    metallic_channel_val: int = 0,
    flat_roughness: bool = False,
    flat_clearcoat: bool = False,
    include_clearcoat: bool = True,
    include_normal: bool = True,
    include_occlusion: bool = True,
    tri_count: int = 12,
    include_publication_flag: bool = True,
) -> Path:
    """Build a minimal valid binary glTF 2.0 (.glb) with embedded WebP textures."""
    h, w = 64, 64
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)

    # ORM image: R=AO, G=Roughness, B=Metallic
    ao_ch = np.full((h, w), 220, dtype=np.uint8)
    if flat_roughness:
        rough_ch = np.full((h, w), 140, dtype=np.uint8)
    else:
        rough_ch = np.clip(40 + 180 * (xx / (w - 1)), 0, 255).astype(np.uint8)
    metal_ch = np.full((h, w), metallic_channel_val, dtype=np.uint8)
    orm_bytes = _encode_webp(np.stack([ao_ch, rough_ch, metal_ch], axis=-1))

    # Clearcoat image: R=clearcoat factor, G=clearcoat roughness, B=0
    if flat_clearcoat:
        cc_r = np.full((h, w), 120, dtype=np.uint8)
    else:
        cc_r = np.clip(20 + 210 * (yy / (h - 1)), 0, 255).astype(np.uint8)
    cc_bytes = _encode_webp(
        np.stack([cc_r, np.full((h, w), 60, dtype=np.uint8), np.zeros((h, w), dtype=np.uint8)], axis=-1)
    )

    # Normal image
    norm_bytes = _encode_webp(
        np.stack(
            [
                np.full((h, w), 128, dtype=np.uint8),
                np.full((h, w), 128, dtype=np.uint8),
                np.full((h, w), 255, dtype=np.uint8),
            ],
            axis=-1,
        )
    )

    # Pack BIN chunk
    bin_parts: list[bytes] = []
    buffer_views: list[dict] = []
    offset = 0

    def add_bv(raw: bytes) -> int:
        nonlocal offset
        padded = _pad4(raw, b'\x00')
        bv_idx = len(buffer_views)
        buffer_views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(raw)})
        bin_parts.append(padded)
        offset += len(padded)
        return bv_idx

    bv_orm = add_bv(orm_bytes)
    bv_cc = add_bv(cc_bytes)
    bv_norm = add_bv(norm_bytes)

    images = [
        {'bufferView': bv_orm, 'mimeType': 'image/webp'},
        {'bufferView': bv_cc, 'mimeType': 'image/webp'},
        {'bufferView': bv_norm, 'mimeType': 'image/webp'},
    ]
    textures = [
        {'extensions': {'EXT_texture_webp': {'source': 0}}},
        {'extensions': {'EXT_texture_webp': {'source': 1}}},
        {'extensions': {'EXT_texture_webp': {'source': 2}}},
    ]

    material: dict = {
        'name': 'synthetic_food_pbr',
        'pbrMetallicRoughness': {
            'metallicFactor': metallic_factor,
            'roughnessFactor': 1.0,
            'metallicRoughnessTexture': {'index': 0},
        },
    }
    if include_occlusion:
        material['occlusionTexture'] = {'index': 0}
    if include_normal:
        material['normalTexture'] = {'index': 2}
    material['extensions'] = {'KHR_materials_sheen': {'sheenRoughnessFactor': 0.5}}
    if include_clearcoat:
        material['extensions'].update({
            'KHR_materials_clearcoat': {
                'clearcoatFactor': 1.0,
                'clearcoatTexture': {'index': 1},
                'clearcoatRoughnessFactor': 1.0,
                'clearcoatRoughnessTexture': {'index': 1},
            }
        })

    bin_chunk = b''.join(bin_parts)
    gltf = {
        'asset': {'version': '2.0'},
        'extensionsUsed': ['EXT_texture_webp', *material['extensions']],
        'buffers': [{'byteLength': len(bin_chunk)}],
        'bufferViews': buffer_views,
        'images': images,
        'textures': textures,
        'materials': [material],
        'accessors': [
            {'componentType': 5123, 'count': tri_count * 3, 'type': 'SCALAR'},
        ],
        'meshes': [
            {'primitives': [{'attributes': {'POSITION': 0}, 'indices': 0, 'material': 0}]}
        ],
    }

    if include_publication_flag:
        gltf['asset']['extras'] = {'publication_eligible': False}

    json_bytes = _pad4(json.dumps(gltf, separators=(',', ':')).encode('utf-8'), b' ')
    total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_chunk)
    header = struct.pack('<III', qa_gate.GLB_MAGIC, 2, total_len)
    json_hdr = struct.pack('<II', len(json_bytes), qa_gate.CHUNK_JSON)
    bin_hdr = struct.pack('<II', len(bin_chunk), qa_gate.CHUNK_BIN)
    out_path.write_bytes(header + json_hdr + json_bytes + bin_hdr + bin_chunk)
    return out_path


def _make_synthetic_dish_rgba(
    size: int = 224,
    *,
    shift_x: int = 0,
    color_shift: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> np.ndarray:
    """Create a textured circular dish RGBA float32 image in [0, 1]."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    cx = size / 2.0 + shift_x
    cy = size / 2.0
    dist = np.hypot(xx - cx, yy - cy)
    alpha = (dist <= size * 0.34).astype(np.float32)

    # Rich food-like radial + sinusoidal texture so gradient correlation & SSIM are meaningful
    wave = 0.5 + 0.5 * np.sin(xx * 0.18) * np.cos(yy * 0.16)
    r = np.clip(0.74 + 0.18 * wave + color_shift[0], 0.0, 1.0)
    g = np.clip(0.42 + 0.22 * wave + color_shift[1], 0.0, 1.0)
    b = np.clip(0.18 + 0.14 * (1.0 - wave) + color_shift[2], 0.0, 1.0)
    rgb = np.stack([r, g, b], axis=-1) * alpha[..., None]
    return np.concatenate([rgb, alpha[..., None]], axis=-1).astype(np.float32)


class TestFood3DQAGate(unittest.TestCase):
    def test_fidelity_windowed_ssim_delta_e_iou_identical_and_degraded(self) -> None:
        photo = qa_gate.normalise_rgba(_make_synthetic_dish_rgba())
        same = qa_gate.normalise_rgba(_make_synthetic_dish_rgba())
        degraded = qa_gate.normalise_rgba(
            _make_synthetic_dish_rgba(color_shift=(-0.35, 0.25, 0.45))
        )

        s_same = qa_gate.score_fidelity_pair(photo, same)
        self.assertGreater(s_same['silhouette_iou'], 0.99)
        self.assertLess(s_same['delta_e'], 0.5)
        self.assertGreater(s_same['ssim'], 0.99)
        self.assertGreater(s_same['detail_corr'], 0.99)

        s_deg = qa_gate.score_fidelity_pair(photo, degraded)
        self.assertGreater(s_deg['delta_e'], 20.0)
        self.assertLess(s_deg['match'], s_same['match'])

    def test_photo_fidelity_pose_search_and_diag_image(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cutout = root / 'cutout_clean.png'
            poses_dir = root / 'poses'
            poses_dir.mkdir()
            diag = root / 'fidelity_diag.png'

            ref = _make_synthetic_dish_rgba()
            Image.fromarray((ref * 255).astype(np.uint8), 'RGBA').save(cutout)

            # Save one bad pose and one exact-match pose
            bad = _make_synthetic_dish_rgba(color_shift=(-0.4, 0.3, 0.4))
            Image.fromarray((bad * 255).astype(np.uint8), 'RGBA').save(poses_dir / 'pose_az0_el30.png')
            Image.fromarray((ref * 255).astype(np.uint8), 'RGBA').save(poses_dir / 'pose_az90_el40.png')
            (poses_dir / 'poses.json').write_text(
                json.dumps(
                    {
                        'publication_eligible': False,
                        'poses': [
                            {'az': 0, 'el': 30, 'file': 'pose_az0_el30.png'},
                            {'az': 90, 'el': 40, 'file': 'pose_az90_el40.png'},
                        ],
                    }
                ),
                encoding='utf-8',
            )

            res = qa_gate.check_photo_fidelity(cutout, poses_dir, diag_img_path=diag)
            self.assertEqual(res['status'], 'PASS')
            self.assertEqual(res['best_pose']['az'], 90)
            self.assertEqual(res['best_pose']['el'], 40)
            self.assertGreater(res['ssim'], 0.99)
            self.assertTrue(diag.exists())

    def test_relighting_check_passes_on_shifted_highlight_and_fails_on_identical(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            h, w = 128, 128
            yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
            bg = np.full((h, w, 3), 230.0, dtype=np.float32)
            dish = np.hypot(xx - 64.0, yy - 64.0) <= 40.0

            img_a = bg.copy()
            img_b = bg.copy()
            # Base dish color
            img_a[dish] = [130.0, 82.0, 48.0]
            img_b[dish] = [130.0, 82.0, 48.0]

            # Specular highlight shifts from upper-left to lower-right
            hl_a = np.exp(-(((xx - 50.0) ** 2 + (yy - 50.0) ** 2) / (2.0 * 10.0 ** 2)))
            hl_b = np.exp(-(((xx - 78.0) ** 2 + (yy - 76.0) ** 2) / (2.0 * 10.0 ** 2)))
            img_a[dish] = np.clip(img_a[dish] + 95.0 * hl_a[dish, None], 0, 255)
            img_b[dish] = np.clip(img_b[dish] + 95.0 * hl_b[dish, None], 0, 255)

            p_a = root / 'relit_0.png'
            p_b = root / 'relit_120.png'
            Image.fromarray(img_a.astype(np.uint8), 'RGB').save(p_a)
            Image.fromarray(img_b.astype(np.uint8), 'RGB').save(p_b)

            passed = qa_gate.check_relighting(p_a, p_b)
            self.assertEqual(passed['status'], 'PASS')
            self.assertGreaterEqual(passed['relit_p95_diff'], 8.0)

            failed = qa_gate.check_relighting(p_a, p_a)
            self.assertEqual(failed['status'], 'FAIL')
            self.assertEqual(failed['relit_p95_diff'], 0.0)

            rgba_a = np.dstack((img_a, dish * 255)).astype(np.uint8)
            rgba_b = np.dstack((img_b, dish * 255)).astype(np.uint8)
            rgba_b[~dish, :3] = 0
            Image.fromarray(rgba_a).save(p_a)
            Image.fromarray(rgba_b).save(p_b)
            passed = qa_gate.check_relighting(p_a, p_b)
            self.assertEqual(passed['status'], 'PASS')
            self.assertEqual(passed['foreground_pixels'], int(dish.sum()))

            rgba_b[..., 3] = 0
            Image.fromarray(rgba_b).save(p_b)
            failed = qa_gate.check_relighting(p_a, p_b)
            self.assertEqual(failed['status'], 'FAIL')
            self.assertEqual(failed['foreground_pixels'], 0)

    def test_glb_pbr_audit_pass_and_defective_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            good_glb = _build_synthetic_pbr_glb(root / 'good.glb')
            good_res = qa_gate.audit_glb_pbr(good_glb)
            self.assertEqual(good_res['status'], 'PASS', msg=str(good_res))
            self.assertEqual(good_res['metallic_factor'], 0.0)
            self.assertGreaterEqual(good_res['roughness_std'], 0.06)
            self.assertGreaterEqual(good_res['clearcoat_std'], 0.04)

            bad_metal = _build_synthetic_pbr_glb(root / 'bad_metal.glb', metallic_factor=0.8)
            res_metal = qa_gate.audit_glb_pbr(bad_metal)
            self.assertEqual(res_metal['status'], 'FAIL')

            bad_metal_ch = _build_synthetic_pbr_glb(root / 'bad_metal_ch.glb', metallic_channel_val=1)
            res_metal_ch = qa_gate.audit_glb_pbr(bad_metal_ch)
            self.assertEqual(res_metal_ch['status'], 'FAIL')

            bad_rough = _build_synthetic_pbr_glb(root / 'bad_rough.glb', flat_roughness=True)
            res_rough = qa_gate.audit_glb_pbr(bad_rough)
            self.assertEqual(res_rough['status'], 'FAIL')

            bad_cc = _build_synthetic_pbr_glb(root / 'bad_cc.glb', flat_clearcoat=True)
            res_cc = qa_gate.audit_glb_pbr(bad_cc)
            self.assertEqual(res_cc['status'], 'FAIL')

            budget_ok = qa_gate.check_gltf_budget(good_glb, max_bytes=1_000_000, max_tris=100, skip_cli_validate=True)
            self.assertEqual(budget_ok['status'], 'PASS')
            self.assertEqual(budget_ok['triangles'], 12)

            budget_fail = qa_gate.check_gltf_budget(good_glb, max_bytes=100, max_tris=5, skip_cli_validate=True)
            self.assertEqual(budget_fail['status'], 'FAIL')

    def test_budget_requires_publication_flag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            glb = _build_synthetic_pbr_glb(Path(tmp) / 'model.glb', include_publication_flag=False)
            result = qa_gate.check_gltf_budget(glb, skip_cli_validate=True)
            self.assertEqual(result['status'], 'FAIL')
            self.assertIn('publication_eligible', ' '.join(result['reasons']))

    def test_pose_manifest_checks_loaded_count_and_hero_digest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hero = _build_synthetic_pbr_glb(root / 'hero.glb')
            pose = root / 'pose.png'
            Image.fromarray((_make_synthetic_dish_rgba() * 255).astype(np.uint8)).save(pose)
            manifest = root / 'poses.json'
            metadata = {
                'poses': [{'az': 0, 'el': 0, 'file': pose.name}],
                'expected_poses': 1,
                'source_glb_sha256': hashlib.sha256(hero.read_bytes()).hexdigest(),
            }
            manifest.write_text(json.dumps(metadata))
            self.assertEqual(
                qa_gate.check_photo_fidelity(pose, root, expected_glb_path=hero)['status'], 'PASS'
            )
            for changes, count, reason in (
                ({'source_glb_sha256': '0' * 64}, 1, 'SHA-256'),
                ({'expected_poses': 2}, 1, 'expected_poses'),
                ({'poses': [*metadata['poses'], {'az': 15, 'el': 0, 'file': 'missing.png'}]}, 1, 'missing.png'),
            ):
                with self.subTest(reason=reason):
                    manifest.write_text(json.dumps({**metadata, **changes}))
                    result = qa_gate.check_photo_fidelity(pose, root, expected_glb_path=hero)
                    self.assertEqual(result['status'], 'FAIL')
                    self.assertEqual(result['poses_evaluated'], count)
                    self.assertIn(reason, ' '.join(result['reasons']))

    def test_geometry_welds_uv_and_normal_seams_for_shell_count(self) -> None:
        import trimesh

        with tempfile.TemporaryDirectory() as tmp:
            mesh = trimesh.creation.box()
            mesh.apply_translation([0, 0.5, 0])
            soup = trimesh.Trimesh(
                vertices=mesh.vertices[mesh.faces].reshape(-1, 3),
                faces=np.arange(mesh.faces.size).reshape(-1, 3),
                vertex_normals=np.repeat(mesh.face_normals, 3, axis=0),
                visual=trimesh.visual.texture.TextureVisuals(
                    uv=np.tile([[0, 0], [1, 0], [0, 1]], (len(mesh.faces), 1)),
                ),
                process=False,
            )
            glb = Path(tmp) / 'seam_split.glb'
            soup.export(glb)
            self.assertGreater(len(trimesh.load(glb, force='mesh').split(only_watertight=False)), 1)
            result = qa_gate.check_geometry(geom_glb=glb)
            self.assertEqual(result['status'], 'PASS')
            self.assertEqual(result['shells'], 1)
            self.assertEqual(result['faces'], 12)

    def test_pbr_masks_variation_outside_valid_uv_pixels(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            glb = _build_synthetic_pbr_glb(root / 'hero.glb')
            mask = np.zeros((128, 128), dtype=np.uint8)
            mask[10:14, 10:14] = 255
            mask_path = root / 'uv_mask.png'
            Image.fromarray(mask).save(mask_path)
            result = qa_gate.audit_glb_pbr(glb, uv_mask_path=mask_path)
            self.assertEqual(result['status'], 'FAIL')
            self.assertLess(result['roughness_std'], 0.06)
            self.assertLess(result['clearcoat_std'], 0.04)

    def test_studio_manifest_escapes_script_special_characters(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dish = '</script>&\u2028\u2029'
            studio = build_studio.build_studio_html(Path(tmp), [{'dish': dish}])
            html = studio.read_text(encoding='utf-8')
            manifest = html.split('type="application/json">', 1)[1].split('</script>', 1)[0]
            self.assertEqual(json.loads(manifest)['dishes'][0]['dish'], dish)
            for escaped in (r'\u003c', r'\u003e', r'\u0026', r'\u2028', r'\u2029'):
                self.assertIn(escaped, manifest)

    def test_cli_fail_verdict_exits_nonzero_only_in_strict_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, redirect_stdout(io.StringIO()):
            root = Path(tmp)
            glb = _build_synthetic_pbr_glb(root / 'hero.glb')
            image = root / 'image.png'
            Image.new('RGBA', (16, 16)).save(image)
            report = root / 'qa_report.json'
            args = [
                '--glb', str(glb), '--cutout', str(image), '--poses-dir', str(root),
                '--relit-a', str(image), '--relit-b', str(image), '--out', str(report),
                '--skip-cli-validate',
            ]
            self.assertEqual(qa_gate.main(args), 0)
            self.assertEqual(json.loads(report.read_text())['verdict'], 'FAIL')
            self.assertEqual(qa_gate.main([*args, '--strict']), 1)
            self.assertEqual(json.loads(report.read_text())['verdict'], 'FAIL')

    def test_geometry_bake_report_schema_and_fidelity_warn_separation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bake_json = root / 'bake_report.json'
            bake_json.write_text(
                json.dumps(
                    {
                        'diameter_cm': 24.0,
                        'calibrated': False,
                        'seating': {'z_min_m': 0.0},
                        'cleanup': {
                            'shell_count': 3,
                            'shells': [{'action': 'keep'}, {'action': 'drop_slab'}],
                        },
                        'lods': [{'faces': 149999}],
                    }
                ),
                encoding='utf-8',
            )
            geom = qa_gate.check_geometry(geom_glb=None, bake_report_path=bake_json)
            self.assertEqual(geom['status'], 'PASS')
            self.assertTrue(geom['seated'])
            self.assertEqual(geom['shells'], 1)
            self.assertEqual(geom['faces'], 149999)

            verdict, reasons, warnings = qa_gate.compute_overall_verdict(
                {
                    'gltf_budget': {'status': 'PASS', 'reasons': []},
                    'photo_fidelity': {
                        'status': 'WARN',
                        'reasons': [],
                        'warnings': ['ssim 0.243 < 0.45'],
                    },
                }
            )
            self.assertEqual(verdict, 'WARN')
            self.assertEqual(reasons, [])
            self.assertEqual(warnings, ['[photo_fidelity] ssim 0.243 < 0.45'])

    def test_check_photo_fidelity_uses_heldout_albedo_summary_when_provided(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hero = _build_synthetic_pbr_glb(root / 'hero.glb')
            pose = root / 'pose.png'
            cutout = root / 'cutout.png'
            Image.fromarray((_make_synthetic_dish_rgba() * 255).astype(np.uint8)).save(pose)
            # Dish cutout with intentionally shifted/darker RGB so coarse pose grid would FAIL
            bad_rgba = _make_synthetic_dish_rgba()
            bad_rgba[..., :3] = 0.05
            Image.fromarray((bad_rgba * 255).astype(np.uint8)).save(cutout)
            (root / 'poses.json').write_text(
                json.dumps(
                    {
                        'poses': [{'az': 0, 'el': 0, 'file': pose.name}],
                        'expected_poses': 1,
                        'source_glb_sha256': hashlib.sha256(hero.read_bytes()).hexdigest(),
                    }
                )
            )
            self.assertEqual(
                qa_gate.check_photo_fidelity(cutout, root, expected_glb_path=hero)['status'], 'FAIL'
            )

            summary = root / 'score_summary.json'
            summary.write_text(
                json.dumps(
                    {
                        'albedo': {
                            'fg_psnr_db': {'mean': 17.8},
                            'fg_ssim': {'mean': 0.63},
                            'fg_delta_e': {'mean': 10.1},
                        }
                    }
                )
            )
            res_pass = qa_gate.check_photo_fidelity(
                cutout, root, expected_glb_path=hero, score_summary_path=summary
            )
            self.assertEqual(res_pass['status'], 'PASS')
            self.assertEqual(res_pass['fidelity_source'], 'heldout_albedo')

            summary.write_text(
                json.dumps(
                    {
                        'albedo': {
                            'fg_psnr_db': {'mean': 13.0},
                            'fg_ssim': {'mean': 0.22},
                            'fg_delta_e': {'mean': 24.0},
                        }
                    }
                )
            )
            res_fail = qa_gate.check_photo_fidelity(
                cutout, root, expected_glb_path=hero, score_summary_path=summary
            )
            self.assertEqual(res_fail['status'], 'FAIL')
            self.assertIn('heldout_albedo fg_ssim', ' '.join(res_fail['reasons']))


if __name__ == '__main__':
    unittest.main()
