"""Unit tests for Food3D V1 Stage 3a PBR authoring (no GPU or Blender required)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parents[1] / 'scripts' / 'food3d'
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import pbr_author  # noqa: E402


class TestFood3DPbrAuthor(unittest.TestCase):
    def test_combine_normals_rnm_identity_and_blending(self) -> None:
        h, w = 16, 16
        up = np.zeros((h, w, 3), dtype=np.float32)
        up[..., 2] = 1.0

        tilted = np.zeros((h, w, 3), dtype=np.float32)
        tilted[..., 0] = 0.35
        tilted[..., 1] = -0.25
        tilted[..., 2] = np.sqrt(1.0 - 0.35**2 - 0.25**2)

        # Identity: base with up micro-normal returns base.
        out_id1 = pbr_author.combine_normals_rnm(tilted, up)
        np.testing.assert_allclose(out_id1, tilted, atol=1e-5)

        # Identity: up base with tilted micro-normal returns tilted.
        out_id2 = pbr_author.combine_normals_rnm(up, tilted)
        np.testing.assert_allclose(out_id2, tilted, atol=1e-5)

        # Non-zero blending produces unit-length tangent normals with z > 0.
        micro = np.zeros((h, w, 3), dtype=np.float32)
        micro[..., 0] = -0.20
        micro[..., 1] = 0.30
        micro[..., 2] = np.sqrt(1.0 - 0.20**2 - 0.30**2)
        blended = pbr_author.combine_normals_rnm(tilted, micro)
        lengths = np.linalg.norm(blended, axis=-1)
        np.testing.assert_allclose(lengths, np.ones((h, w), dtype=np.float32), atol=1e-5)
        self.assertTrue(np.all(blended[..., 2] > 0.0))
        self.assertFalse(np.allclose(blended, tilted, atol=1e-2))

    def test_combine_normals_rnm_preserves_grazing_angle_normal(self) -> None:
        base = np.array([[[0.95, 0.0, 0.31]]], dtype=np.float32)
        detail = np.array([[[0.6, 0.0, 0.8]]], dtype=np.float32)

        blended = pbr_author.combine_normals_rnm(base, detail)

        np.testing.assert_allclose(np.linalg.norm(blended, axis=-1), 1.0, atol=1e-5)
        self.assertGreater(float(blended[0, 0, 2]), 0.05)
        self.assertLess(float(blended[0, 0, 2]), 0.2)

    def test_delight_albedo_attenuates_specular_spikes_preserves_matte_food(self) -> None:
        h, w = 64, 64
        valid = np.ones((h, w), dtype=bool)
        ao = np.ones((h, w), dtype=np.float32)

        # Saturated matte orange-red food base.
        albedo = np.zeros((h, w, 3), dtype=np.float32)
        albedo[..., 0] = 0.72
        albedo[..., 1] = 0.28
        albedo[..., 2] = 0.12

        # Inject a localized white specular highlight spike in the center.
        albedo[28:36, 28:36, :] = 0.99

        delit, highlight_cue, delta_e = pbr_author.delight_albedo(albedo, ao, valid)

        # Highlight spike should be detected and meaningfully attenuated.
        self.assertGreater(float(np.mean(highlight_cue[30:34, 30:34])), 0.5)
        self.assertLess(float(np.mean(delit[30:34, 30:34])), 0.92)
        self.assertGreater(delta_e, 0.0)

        # Matte saturated food far from the highlight should remain nearly unchanged.
        np.testing.assert_allclose(delit[4:12, 4:12], albedo[4:12, 4:12], atol=1e-3)

    def test_surface_masks_and_pbr_synthesis_separate_vessel_wet_and_dry(self) -> None:
        rng = np.random.default_rng(42)
        h, w = 96, 96
        valid = np.ones((h, w), dtype=bool)
        ao = np.full((h, w), 0.9, dtype=np.float32)
        highlight_cue = np.zeros((h, w), dtype=np.float32)

        albedo = np.zeros((h, w, 3), dtype=np.float32)
        geom = np.zeros((h, w, 3), dtype=np.float32)

        # Region 1 (rows 0..31): outer smooth white plate rim (vessel_mask).
        albedo[0:32, :, :] = 0.92
        geom[0:32, :, 0] = 0.65  # height_norm
        geom[0:32, :, 1] = 0.90  # radius_norm > 0.74
        geom[0:32, :, 2] = 0.85  # normal_z

        # Region 2 (rows 32..63): flat recessed smooth broth (wet_mask).
        albedo[32:64, :, :] = np.array([0.45, 0.22, 0.08], dtype=np.float32)
        geom[32:64, :, 0] = 0.20  # height_norm < 0.42
        geom[32:64, :, 1] = 0.30  # radius_norm
        geom[32:64, :, 2] = 0.95  # normal_z > 0.78

        # Region 3 (rows 64..95): high-frequency crispy batter (dry_mask).
        noise = rng.uniform(-0.22, 0.22, size=(32, w, 1)).astype(np.float32)
        batter = np.clip(np.array([0.74, 0.54, 0.25], dtype=np.float32) + noise, 0.05, 0.95)
        albedo[64:96, :, :] = batter
        geom[64:96, :, 0] = 0.75  # height_norm
        geom[64:96, :, 1] = 0.35  # radius_norm
        geom[64:96, :, 2] = 0.80  # normal_z

        masks = pbr_author.compute_food_masks(albedo, geom, ao, highlight_cue, valid)

        # Check interior of each band (avoiding 4px transition border).
        self.assertGreater(float(np.mean(masks['vessel_mask'][4:28, 4:92])), 0.75)
        self.assertGreater(float(np.mean(masks['wet_mask'][36:60, 4:92])), 0.75)
        self.assertGreater(float(np.mean(masks['dry_mask'][68:92, 4:92])), 0.75)

        # Synthesize ORM, Clearcoat, and Normal.
        base_normal = np.zeros((h, w, 3), dtype=np.float32)
        base_normal[..., 0] = 0.5
        base_normal[..., 1] = 0.5
        base_normal[..., 2] = 1.0

        orm, clearcoat, normal_final, stats = pbr_author.synthesize_pbr_maps(
            albedo_delit=albedo,
            base_normal_rgb=base_normal,
            ao=ao,
            masks=masks,
            valid_mask=valid,
        )

        # Strictly non-metallic everywhere.
        self.assertEqual(stats['metallic_max'], 0.0)
        self.assertTrue(np.all(orm[..., 2] == 0.0))

        # Spatially varying roughness across wet/vessel/dry.
        self.assertGreaterEqual(stats['roughness_std'], 0.08)
        self.assertLess(
            float(np.mean(orm[36:60, 4:92, 1])),
            float(np.mean(orm[68:92, 4:92, 1])),
        )

        # Clearcoat active on wet broth, strictly zero on dry batter.
        self.assertGreater(stats['clearcoat_wet_mean'], 0.55)
        self.assertEqual(stats['clearcoat_dry_mean'], 0.0)
        self.assertTrue(np.all(clearcoat[68:92, 4:92, 0] == 0.0))

        # Final normal map encodes valid unit-length normals with z > 0.
        n_vec = normal_final * 2.0 - 1.0
        n_len = np.linalg.norm(n_vec, axis=-1)
        np.testing.assert_allclose(n_len, np.ones((h, w), dtype=np.float32), atol=1e-4)
        self.assertTrue(np.all(n_vec[..., 2] > 0.0))

    def test_dilate_uv_gutters_fills_from_nearest_valid_pixel(self) -> None:
        h, w = 32, 32
        valid = np.zeros((h, w), dtype=bool)
        valid[8:24, 8:24] = True

        arr = np.zeros((h, w, 3), dtype=np.float32)
        arr[8:24, 8:16] = np.array([0.9, 0.2, 0.1], dtype=np.float32)
        arr[8:24, 16:24] = np.array([0.1, 0.8, 0.3], dtype=np.float32)

        dilated = pbr_author.dilate_uv_gutters(arr, valid, max_dist=6)

        # Pixels inside valid mask are untouched.
        np.testing.assert_allclose(dilated[valid], arr[valid])
        # Gutter just left of left half inherits left half color.
        np.testing.assert_allclose(dilated[12, 4], np.array([0.9, 0.2, 0.1], dtype=np.float32))
        # Gutter just right of right half inherits right half color.
        np.testing.assert_allclose(dilated[12, 27], np.array([0.1, 0.8, 0.3], dtype=np.float32))
        # Far gutter beyond max_dist remains zero.
        np.testing.assert_allclose(dilated[0, 0], np.zeros(3, dtype=np.float32))

    def test_author_pbr_maps_end_to_end_report_contract(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            maps_dir = Path(tmp) / 'maps'
            out_dir = Path(tmp) / 'pbr'
            report_path = Path(tmp) / 'pbr_report.json'
            maps_dir.mkdir()

            size = 32
            rgb = np.full((size, size, 3), 160, dtype=np.uint8)
            nrm = np.zeros((size, size, 3), dtype=np.uint8)
            nrm[..., 0] = 128
            nrm[..., 1] = 128
            nrm[..., 2] = 255
            ao = np.full((size, size), 220, dtype=np.uint8)
            geom = np.zeros((size, size, 3), dtype=np.uint8)
            geom[..., 0] = 128
            geom[..., 1] = 100
            geom[..., 2] = 240
            mask = np.zeros((size, size), dtype=np.uint8)
            mask[4:28, 4:28] = 255

            Image.fromarray(rgb, mode='RGB').save(maps_dir / 'basecolor.png')
            Image.fromarray(rgb, mode='RGB').save(maps_dir / 'roughness.png')
            Image.fromarray(nrm, mode='RGB').save(maps_dir / 'normal.png')
            Image.fromarray(ao, mode='L').save(maps_dir / 'ao.png')
            Image.fromarray(geom, mode='RGB').save(maps_dir / 'geom_features.png')
            Image.fromarray(mask, mode='L').save(maps_dir / 'uv_mask.png')

            report = pbr_author.author_pbr_maps(maps_dir, out_dir, report_path)
            self.assertFalse(report['publication_eligible'])
            self.assertEqual(report['metallic_max'], 0.0)

            # Lower micro_normal_strength should keep normal_final closer to base normal
            out_dir_low = Path(tmp) / 'pbr_low'
            Image.fromarray(
                np.clip(np.random.default_rng(1).normal(128, 30, (size, size, 3)), 20, 235).astype(np.uint8),
                mode='RGB',
            ).save(maps_dir / 'basecolor.png')
            pbr_author.author_pbr_maps(maps_dir, out_dir, report_path, micro_normal_strength=0.65)
            pbr_author.author_pbr_maps(maps_dir, out_dir_low, Path(tmp) / 'pbr_low.json', micro_normal_strength=0.15)
            n_high = np.asarray(Image.open(out_dir / 'normal_final.png'), dtype=np.float32)
            n_low = np.asarray(Image.open(out_dir_low / 'normal_final.png'), dtype=np.float32)
            flat = np.array([128.0, 128.0, 255.0], dtype=np.float32)
            self.assertLess(np.abs(n_low - flat).mean(), np.abs(n_high - flat).mean())

            disk_report = json.loads(report_path.read_text(encoding='utf-8'))
            self.assertIs(disk_report['publication_eligible'], False)
            self.assertIn('micro_normal_strength', disk_report)
            self.assertIn('occlusion_strength', disk_report)
            self.assertIn('wet_fraction', disk_report)
            for fname in (
                'basecolor_delit.png',
                'orm.png',
                'clearcoat.png',
                'normal_final.png',
                'pbr_masks_debug.png',
            ):
                self.assertTrue((out_dir / fname).is_file(), f'Missing {fname}')

    def test_baked_pizza_like_food_stays_mostly_matte_and_wet_cap_enforces_bound(self) -> None:
        h, w = 64, 64
        valid = np.ones((h, w), dtype=bool)
        ao = np.full((h, w), 0.9, dtype=np.float32)
        highlight_cue = np.zeros((h, w), dtype=np.float32)

        # Simulate dark-to-midtone saturated baked cheese/crust on a flat pizza top & rim.
        albedo = np.zeros((h, w, 3), dtype=np.float32)
        albedo[..., 0] = 0.48
        albedo[..., 1] = 0.24
        albedo[..., 2] = 0.10
        geom = np.zeros((h, w, 3), dtype=np.float32)
        geom[..., 0] = 0.50  # mid height
        geom[..., 1] = 0.85  # outer crust rim (should NOT trigger ceramic vessel)
        geom[..., 2] = 0.90  # upward-facing

        masks = pbr_author.compute_food_masks(albedo, geom, ao, highlight_cue, valid)
        self.assertLess(float(np.mean(masks['wet_mask'][valid] >= 0.5)), 0.02)
        self.assertLess(float(np.mean(masks['vessel_mask'][valid] >= 0.5)), 0.05)

        # Force high wet region (recessed broth) and verify wet_cap clamps it cleanly.
        geom_broth = np.zeros((h, w, 3), dtype=np.float32)
        geom_broth[..., 0] = 0.15
        geom_broth[..., 1] = 0.25
        geom_broth[..., 2] = 0.95
        # Make top half slightly smoother/more wet than bottom half
        albedo_broth = np.full((h, w, 3), 0.35, dtype=np.float32)
        albedo_broth[..., 1] = 0.20
        albedo_broth[..., 2] = 0.08
        masks_uncapped = pbr_author.compute_food_masks(albedo_broth, geom_broth, ao, highlight_cue, valid)
        self.assertGreater(float(np.mean(masks_uncapped['wet_mask'][valid] >= 0.5)), 0.50)

        masks_capped = pbr_author.compute_food_masks(
            albedo_broth, geom_broth, ao, highlight_cue, valid, wet_cap=0.05
        )
        self.assertLessEqual(float(np.mean(masks_capped['wet_mask'][valid] >= 0.5)), 0.05)

    def test_author_pbr_maps_logs_strengths_and_wet_cap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            maps_dir = Path(tmp) / 'maps'
            out_dir = Path(tmp) / 'pbr'
            maps_dir.mkdir()
            size = 32
            rgb = np.full((size, size, 3), 160, dtype=np.uint8)
            nrm = np.full((size, size, 3), [128, 128, 255], dtype=np.uint8)
            ao = np.full((size, size), 220, dtype=np.uint8)
            geom = np.full((size, size, 3), [40, 60, 245], dtype=np.uint8)
            mask = np.full((size, size), 255, dtype=np.uint8)
            Image.fromarray(rgb, mode='RGB').save(maps_dir / 'basecolor.png')
            Image.fromarray(rgb, mode='RGB').save(maps_dir / 'roughness.png')
            Image.fromarray(nrm, mode='RGB').save(maps_dir / 'normal.png')
            Image.fromarray(ao, mode='L').save(maps_dir / 'ao.png')
            Image.fromarray(geom, mode='RGB').save(maps_dir / 'geom_features.png')
            Image.fromarray(mask, mode='L').save(maps_dir / 'uv_mask.png')

            report = pbr_author.author_pbr_maps(
                maps_dir,
                out_dir,
                micro_normal_strength=0.25,
                occlusion_strength=0.25,
                wet_cap=0.04,
            )
            self.assertEqual(report['micro_normal_strength'], 0.25)
            self.assertEqual(report['occlusion_strength'], 0.25)
            self.assertEqual(report['wet_cap'], 0.04)
            self.assertLessEqual(report['wet_fraction'], 0.04)


    def test_cap_mask_fraction_over_half_enforces_bound_and_noops(self) -> None:
        h, w = 32, 32
        valid = np.ones((h, w), dtype=bool)
        mask = np.full((h, w), 1.0, dtype=np.float32)

        # cap=None and cap >= 1.0 leave the mask untouched (and return a copy).
        np.testing.assert_allclose(pbr_author.cap_mask_fraction_over_half(mask, valid, None), 1.0)
        np.testing.assert_allclose(pbr_author.cap_mask_fraction_over_half(mask, valid, 1.0), 1.0)
        capped = pbr_author.cap_mask_fraction_over_half(mask, valid, 0.25)
        self.assertIsNot(capped, mask)
        self.assertLessEqual(float(np.mean(capped[valid] >= 0.5)), 0.25)
        # cap=0.0 zeroes every texel deterministically.
        self.assertEqual(float(np.max(pbr_author.cap_mask_fraction_over_half(mask, valid, 0.0))), 0.0)

    def test_cap_mask_fraction_over_half_only_touches_texels_above_cutoff(self) -> None:
        h, w = 20, 20
        valid = np.ones((h, w), dtype=bool)
        mask = np.zeros((h, w), dtype=np.float32)
        mask[:2, :] = 1.0  # 10% of texels already at 1.0
        capped = pbr_author.cap_mask_fraction_over_half(mask, valid, 0.5)
        np.testing.assert_allclose(capped[:2, :], 1.0)

    def _wet_oil_fixture(self, h: int = 64, w: int = 64):
        """Three top-facing bands: pale mozzarella, dark matte crust, orange grease."""
        albedo = np.zeros((h, w, 3), dtype=np.float32)
        geom = np.zeros((h, w, 3), dtype=np.float32)
        ao = np.full((h, w), 0.9, dtype=np.float32)
        valid = np.ones((h, w), dtype=bool)

        # Band 1: pale, low-chroma mozzarella (blue/red ~0.96, linear luminance ~0.55).
        albedo[0:22, :, :] = np.array([0.86, 0.84, 0.82], dtype=np.float32)
        # Band 2: dark saturated baked crust (blue/red ~0.2, linear luminance ~0.05).
        albedo[22:44, :, :] = np.array([0.42, 0.18, 0.08], dtype=np.float32)
        # Band 3: saturated orange grease.
        albedo[44:64, :, :] = np.array([0.86, 0.42, 0.10], dtype=np.float32)
        geom[:, :, 2] = 0.92  # top-facing everywhere
        return albedo, geom, ao, valid

    def test_wet_oil_mask_selects_pale_cheese_and_grease_not_dark_crust(self) -> None:
        albedo, geom, ao, valid = self._wet_oil_fixture()
        highlight_cue = np.zeros_like(ao)
        masks = pbr_author.compute_food_masks(albedo, geom, ao, highlight_cue, valid)

        oil = pbr_author.compute_wet_oil_mask(albedo, masks, valid, highlight_cue, normal_z_map=geom[..., 2])

        self.assertTrue(np.all(oil >= 0.0) and np.all(oil <= 1.0))
        cheese = float(np.mean(oil[4:18, 8:56]))
        crust = float(np.mean(oil[26:40, 8:56]))
        grease = float(np.mean(oil[48:60, 8:56]))
        self.assertGreater(cheese, 0.5)
        self.assertGreater(grease, 0.5)
        self.assertLess(crust, 0.1)
        self.assertGreater(cheese, crust)

    def test_wet_oil_mask_excludes_vessel_and_requires_top_facing(self) -> None:
        albedo, geom, ao, valid = self._wet_oil_fixture()
        geom[0:22, :, 2] = 0.10  # downward-facing plate surface under the pale band
        highlight_cue = np.zeros_like(ao)
        masks = pbr_author.compute_food_masks(albedo, geom, ao, highlight_cue, valid)
        masks['vessel_mask'] = masks['vessel_mask'].copy()
        masks['vessel_mask'][0:22, :] = 1.0

        oil = pbr_author.compute_wet_oil_mask(albedo, masks, valid, highlight_cue, normal_z_map=geom[..., 2])
        self.assertLess(float(np.mean(oil[4:18, 8:56])), 0.05)

    def test_wet_oil_mask_gloss_cue_only_adds_evidence(self) -> None:
        albedo, geom, ao, valid = self._wet_oil_fixture()
        # Make the crust band a strong view-angle glossy candidate with no albedo colour evidence.
        gloss = np.zeros((64, 64), dtype=np.float32)
        gloss[22:44, :] = 1.0
        masks = pbr_author.compute_food_masks(albedo, geom, ao, np.zeros_like(ao), valid)

        base = pbr_author.compute_wet_oil_mask(albedo, masks, valid, np.zeros_like(ao), normal_z_map=geom[..., 2])
        with_gloss = pbr_author.compute_wet_oil_mask(
            albedo, masks, valid, np.zeros_like(ao), specular_gloss=gloss, normal_z_map=geom[..., 2]
        )
        self.assertLess(float(np.mean(base[26:40, 8:56])), 0.1)
        self.assertGreater(float(np.mean(with_gloss[26:40, 8:56])), 0.5)
        # Evidence only accumulates: the mask can never fall where the gloss cue is added.
        self.assertTrue(np.all(with_gloss >= base - 1e-6))

    def test_synthesize_pbr_maps_wet_oil_lowers_roughness_and_adds_modest_clearcoat(self) -> None:
        albedo, _geom, ao, valid = self._wet_oil_fixture()
        # Force the legacy masks to a matte dry surface so the roughness drop is attributable
        # to the wet/oil mask alone (not to the pre-existing recessed-broth wet_mask).
        zero = np.zeros((64, 64), dtype=np.float32)
        masks = {
            'vessel_mask': zero,
            'dry_mask': np.ones((64, 64), dtype=np.float32),
            'wet_mask': zero,
            'liquid_mask': zero,
            'moist_mask': zero,
        }
        oil = np.zeros((64, 64), dtype=np.float32)
        oil[0:22, :] = 1.0
        base_normal = np.zeros((64, 64, 3), dtype=np.float32)
        base_normal[..., 2] = 1.0

        orm_plain, coat_plain, _, _ = pbr_author.synthesize_pbr_maps(
            albedo_delit=albedo, base_normal_rgb=base_normal, ao=ao, masks=masks, valid_mask=valid
        )
        orm_oil, coat_oil, _, stats = pbr_author.synthesize_pbr_maps(
            albedo_delit=albedo,
            base_normal_rgb=base_normal,
            ao=ao,
            masks=masks,
            valid_mask=valid,
            wet_oil_mask=oil,
        )

        r_plain = float(np.mean(orm_plain[4:18, 8:56, 1]))
        r_oil = float(np.mean(orm_oil[4:18, 8:56, 1]))
        self.assertLess(r_oil, r_plain)
        self.assertGreaterEqual(r_oil, 0.25 - 1e-3)
        self.assertLessEqual(r_oil, 0.40 + 1e-3)
        # Dry crust band outside the mask is near-identical.
        np.testing.assert_allclose(orm_oil[26:40, 8:56, 1], orm_plain[26:40, 8:56, 1], atol=1e-6)
        # Clearcoat appears on the oil band and stays modest; metallic stays zero.
        self.assertGreater(float(np.mean(coat_oil[4:18, 8:56, 0])), 0.05)
        self.assertLessEqual(float(np.max(coat_oil[4:18, 8:56, 0])), 0.15 + 1e-6)
        self.assertTrue(np.all(orm_oil[..., 2] == 0.0))
        self.assertEqual(stats['metallic_max'], 0.0)
        self.assertGreater(stats['wet_oil_fraction'], 0.0)
        self.assertGreater(stats['wet_oil_mean'], 0.0)

    def test_author_pbr_maps_wet_food_darkens_albedo_only_inside_the_mask(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            maps_dir = Path(tmp) / 'maps'
            maps_dir.mkdir()
            size = 64
            albedo = np.zeros((size, size, 3), dtype=np.float32)
            albedo[0:32] = np.array([0.86, 0.84, 0.82], dtype=np.float32)
            albedo[32:64] = np.array([0.30, 0.20, 0.12], dtype=np.float32)
            Image.fromarray((albedo * 255.0 + 0.5).astype(np.uint8), mode='RGB').save(maps_dir / 'basecolor.png')
            nrm = np.zeros((size, size, 3), dtype=np.uint8)
            nrm[..., 0], nrm[..., 1], nrm[..., 2] = 128, 128, 255
            Image.fromarray(nrm, mode='RGB').save(maps_dir / 'normal.png')
            Image.fromarray(np.full((size, size), 230, dtype=np.uint8), mode='L').save(maps_dir / 'ao.png')
            geom = np.zeros((size, size, 3), dtype=np.uint8)
            geom[..., 1], geom[..., 2] = 40, 240  # interior radius, top-facing
            Image.fromarray(geom, mode='RGB').save(maps_dir / 'geom_features.png')
            Image.fromarray(np.full((size, size), 255, dtype=np.uint8), mode='L').save(maps_dir / 'uv_mask.png')

            legacy = pbr_author.author_pbr_maps(maps_dir, Path(tmp) / 'legacy', wet_cap=0.04)
            wet = pbr_author.author_pbr_maps(
                maps_dir,
                Path(tmp) / 'wet',
                wet_cap=0.04,
                wet_food=True,
                oil_albedo_removal=0.18,
            )

            self.assertFalse(legacy['wet_food'])
            self.assertEqual(legacy['wet_oil_fraction'], 0.0)
            self.assertTrue(wet['wet_food'])
            self.assertEqual(wet['oil_albedo_removal'], 0.18)
            self.assertGreater(wet['oil_albedo_delta_e'], 0.0)
            self.assertLessEqual(wet['wet_oil_fraction'], wet['wet_oil_cap'])
            self.assertEqual(wet['metallic_max'], 0.0)

            base_legacy = np.asarray(Image.open(Path(tmp) / 'legacy' / 'basecolor_delit.png'), dtype=np.float32)
            base_wet = np.asarray(Image.open(Path(tmp) / 'wet' / 'basecolor_delit.png'), dtype=np.float32)
            orm_legacy = np.asarray(Image.open(Path(tmp) / 'legacy' / 'orm.png'), dtype=np.float32)
            orm_wet = np.asarray(Image.open(Path(tmp) / 'wet' / 'orm.png'), dtype=np.float32)
            coat_legacy = np.asarray(Image.open(Path(tmp) / 'legacy' / 'clearcoat.png'), dtype=np.float32)
            coat_wet = np.asarray(Image.open(Path(tmp) / 'wet' / 'clearcoat.png'), dtype=np.float32)
            self.assertLess(float(np.mean(base_wet[8:24, 8:56, 0])), float(np.mean(base_legacy[8:24, 8:56, 0])))
            self.assertGreater(float(np.mean(coat_wet[8:24, 8:56, 0])), float(np.mean(coat_legacy[8:24, 8:56, 0])))
            # Dark saturated band carries no wet/oil evidence, so it must be untouched.
            np.testing.assert_allclose(base_wet[40:60, 8:56], base_legacy[40:60, 8:56], atol=1.0)
            np.testing.assert_allclose(orm_wet[40:60, 8:56], orm_legacy[40:60, 8:56], atol=1.0)

    def test_wet_oil_mask_is_zero_without_evidence(self) -> None:
        h, w = 32, 32
        valid = np.ones((h, w), dtype=bool)
        albedo = np.full((h, w, 3), 0.25, dtype=np.float32)  # dark, saturated, no pale or grease cue
        geom = np.zeros((h, w, 3), dtype=np.float32)
        geom[..., 2] = 0.95
        ao = np.full((h, w), 0.9, dtype=np.float32)
        masks = pbr_author.compute_food_masks(albedo, geom, ao, np.zeros_like(ao), valid)
        oil = pbr_author.compute_wet_oil_mask(albedo, masks, valid, np.zeros_like(ao), normal_z_map=geom[..., 2])
        self.assertLess(float(np.mean(oil[valid] >= 0.5)), 0.05)

    def test_delight_albedo_skips_ao_lift_on_dark_vessel_regions_and_tightens_vessel_clearcoat(self) -> None:
        h, w = 32, 32
        valid = np.ones((h, w), dtype=bool)
        ao = np.full((h, w), 0.35, dtype=np.float32)
        albedo = np.zeros((h, w, 3), dtype=np.float32)
        albedo[0:16] = np.array([0.08, 0.08, 0.08], dtype=np.float32)   # linear lum < 0.01 < 0.15 (dark vessel)
        albedo[16:32] = np.array([0.76, 0.72, 0.68], dtype=np.float32)  # bright top/food (lum >= 0.15)
        delit, _, _ = pbr_author.delight_albedo(albedo, ao, valid)
        np.testing.assert_allclose(delit[2:14, 2:30], albedo[2:14, 2:30], atol=1e-5)
        self.assertGreater(float(np.mean(delit[18:30, 2:30])), float(np.mean(albedo[18:30, 2:30])) + 0.03)

        zero = np.zeros((h, w), dtype=np.float32)
        masks = {
            'vessel_mask': np.ones((h, w), dtype=np.float32),
            'dry_mask': zero,
            'wet_mask': zero,
            'liquid_mask': zero,
            'moist_mask': zero,
        }
        base_n = np.zeros((h, w, 3), dtype=np.float32)
        base_n[..., 2] = 1.0
        _, coat, _, _ = pbr_author.synthesize_pbr_maps(albedo, base_n, ao, masks, valid)
        cc_r = float(np.mean(coat[..., 1]))
        self.assertGreaterEqual(cc_r, 0.08 - 1e-4)
        self.assertLessEqual(cc_r, 0.12 + 1e-4)

    def test_pack_pbr_glb_zeros_global_sheen_color(self) -> None:
        pack_src = (SCRIPT_DIR / 'pack_pbr_glb.mjs').read_text(encoding='utf-8')
        self.assertIn('.setSheenColorFactor([0.0, 0.0, 0.0])', pack_src)


if __name__ == '__main__':
    unittest.main()
