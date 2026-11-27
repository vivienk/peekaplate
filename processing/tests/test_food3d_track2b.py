"""Offline unit tests for Track 2B mesh reconstruction pure functions."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "food3d"))

import track2b_mesh as t2b


def _make_box_mesh(center: tuple[float, float, float], size: tuple[float, float, float]):
    cx, cy, cz = center
    sx, sy, sz = size
    hx, hy, hz = sx / 2.0, sy / 2.0, sz / 2.0
    verts = np.array(
        [
            [cx - hx, cy - hy, cz - hz],
            [cx + hx, cy - hy, cz - hz],
            [cx + hx, cy + hy, cz - hz],
            [cx - hx, cy + hy, cz - hz],
            [cx - hx, cy - hy, cz + hz],
            [cx + hx, cy - hy, cz + hz],
            [cx + hx, cy + hy, cz + hz],
            [cx - hx, cy + hy, cz + hz],
        ],
        dtype=np.float64,
    )
    faces = np.array(
        [
            [0, 1, 2], [0, 2, 3],
            [4, 6, 5], [4, 7, 6],
            [0, 4, 5], [0, 5, 1],
            [2, 6, 7], [2, 7, 3],
            [0, 3, 7], [0, 7, 4],
            [1, 5, 6], [1, 6, 2],
        ],
        dtype=np.int64,
    )
    return verts, faces


class TestCameraConversion(unittest.TestCase):
    def test_opengl_opencv_round_trip(self):
        angle = 0.65
        c, s = np.cos(angle), np.sin(angle)
        c2w = np.eye(4, dtype=np.float64)
        c2w[:3, :3] = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
        c2w[:3, 3] = np.array([1.2, -0.7, 3.4])

        w2c = t2b.opengl_c2w_to_opencv_w2c(c2w)
        reconstructed = t2b.opencv_w2c_to_opengl_c2w(w2c)
        np.testing.assert_allclose(reconstructed, c2w, atol=1e-12)

    def test_opengl_projection_matrix_matches_opencv_projection(self):
        intr = {"w": 575, "h": 1024, "fl_x": 934.4, "fl_y": 934.9, "cx": 287.2, "cy": 512.3}
        c2w = np.eye(4, dtype=np.float64)
        c2w[:3, 3] = np.array([0.3, 0.5, 4.0])
        w2c_cv = t2b.opengl_c2w_to_opencv_w2c(c2w)

        pts = np.array([[0.1, -0.2, 0.4], [-0.5, 0.8, -0.3], [0.3, 0.5, 1.0]], dtype=np.float64)
        uv_cv, depth_cv = t2b.project_points_opencv(pts, w2c_cv, intr)
        self.assertTrue(np.all(depth_cv > 0))

        proj = t2b.build_opengl_projection_matrix(
            intr["w"], intr["h"], intr["fl_x"], intr["fl_y"], intr["cx"], intr["cy"], near=0.05, far=50.0
        )
        w2c_gl = np.linalg.inv(c2w)
        pts_h = np.concatenate([pts, np.ones((len(pts), 1))], axis=1)
        clip = (pts_h @ w2c_gl.T) @ proj.T
        ndc = clip[:, :2] / clip[:, 3:4]
        u_gl = (ndc[:, 0] + 1.0) * 0.5 * intr["w"]
        v_gl = (1.0 - ndc[:, 1]) * 0.5 * intr["h"]
        np.testing.assert_allclose(np.stack([u_gl, v_gl], axis=-1), uv_cv, atol=1e-9)


class TestHeldOutPoseProjectionRoundTrip(unittest.TestCase):
    def test_world_to_metric_and_blender_seating_preserve_pixels(self):
        # Arbitrary tilted orbit cameras looking at origin
        up_true = np.array([0.2, -0.8, 0.565685424949238], dtype=np.float64)
        up_true /= np.linalg.norm(up_true)
        rot_align = t2b.rotation_align_axis_to_yup(up_true)
        np.testing.assert_allclose(rot_align @ up_true, [0.0, 1.0, 0.0], atol=1e-12)
        self.assertAlmostEqual(float(np.linalg.det(rot_align)), 1.0, places=12)

        rng = np.random.default_rng(7)
        mesh_pts = rng.normal(loc=[1.5, -2.0, 0.8], scale=0.6, size=(200, 3))
        m_w2m, meta = t2b.compute_world_to_metric_transform(mesh_pts, up_true, diameter_cm=22.0)
        self.assertAlmostEqual(meta["y_min_m"], 0.0, places=5)
        self.assertAlmostEqual(max(meta["dimensions_m"][0], meta["dimensions_m"][2]), 0.22, places=4)

        # Simulate a Blender seating refinement on top of m_w2m
        m_blender = t2b.compose_blender_seating_transform(
            {"scale_factor": 1.015, "center_xy_before": [0.002, -0.003], "z_min_before": 0.001}
        )
        m_total = m_blender @ m_w2m

        # Build a held-out camera looking at mesh_pts mean
        target = mesh_pts.mean(axis=0)
        cam_pos = target + up_true * 3.0 + np.array([2.5, 0.4, -1.2])
        forward = target - cam_pos
        forward /= np.linalg.norm(forward)
        right = np.cross(forward, up_true)
        right /= np.linalg.norm(right)
        cam_up = np.cross(right, forward)
        c2w_world = np.eye(4, dtype=np.float64)
        c2w_world[:3, 0] = right
        c2w_world[:3, 1] = cam_up
        c2w_world[:3, 2] = -forward
        c2w_world[:3, 3] = cam_pos

        intr = {"w": 575, "h": 1024, "fl_x": 935.0, "fl_y": 935.5, "cx": 287.0, "cy": 512.0}
        uv_before, depth_before = t2b.project_points_opencv(
            mesh_pts, t2b.opengl_c2w_to_opencv_w2c(c2w_world), intr
        )

        pts_after = (mesh_pts @ m_total[:3, :3].T) + m_total[:3, 3]
        c2w_after = t2b.transform_opengl_c2w(c2w_world, m_total)
        uv_after, depth_after = t2b.project_points_opencv(
            pts_after, t2b.opengl_c2w_to_opencv_w2c(c2w_after), intr
        )

        np.testing.assert_allclose(uv_after, uv_before, atol=1e-9)
        scale_total = float(np.linalg.norm(m_total[:3, 0]))
        np.testing.assert_allclose(depth_after, depth_before * scale_total, atol=1e-9)

    def test_rotation_align_parallel_and_antiparallel(self):
        r_id = t2b.rotation_align_axis_to_yup(np.array([0.0, 1.0, 0.0]))
        np.testing.assert_allclose(r_id, np.eye(3), atol=1e-12)
        r_flip = t2b.rotation_align_axis_to_yup(np.array([0.0, -1.0, 0.0]))
        np.testing.assert_allclose(r_flip @ np.array([0.0, -1.0, 0.0]), [0.0, 1.0, 0.0], atol=1e-12)
        self.assertAlmostEqual(float(np.linalg.det(r_flip)), 1.0, places=12)


class TestMaskedTSDFInputs(unittest.TestCase):
    def test_prepare_masked_tsdf_depth_filters_background_alpha_and_range(self):
        depth = np.array(
            [
                [1.5, 2.0, 0.01],
                [5.0, np.nan, 100.0],
            ],
            dtype=np.float32,
        )
        alpha = np.array(
            [
                [0.9, 0.2, 0.95],
                [0.8, 0.9, 0.9],
            ],
            dtype=np.float32,
        )
        mask = np.array(
            [
                [True, True, True],
                [False, True, True],
            ],
            dtype=bool,
        )
        out = t2b.prepare_masked_tsdf_depth(depth, alpha, mask, near=0.1, far=20.0, alpha_thresh=0.5)
        expected = np.array([[1.5, 0.0, 0.0], [0.0, 0.0, 0.0]], dtype=np.float32)
        np.testing.assert_allclose(out, expected)

    def test_prepare_masked_tsdf_depth_rejects_shape_mismatch(self):
        with self.assertRaises(ValueError):
            t2b.prepare_masked_tsdf_depth(np.ones((4, 4)), np.ones((4, 3)), np.ones((4, 4), dtype=bool), 0.1, 10.0)


class TestMeshCleanupRules(unittest.TestCase):
    def test_drops_table_slab_and_floaters_and_keeps_main_dish(self):
        # Main dish (subdivided box-like: duplicate faces so it has more faces than table/floater)
        dish_v, dish_f = _make_box_mesh((0.0, 0.12, 0.0), (0.20, 0.16, 0.20))
        # Wide flat table slab at y=0 spanning >75% of footprint, height/width < 0.06
        table_v, table_f = _make_box_mesh((0.0, 0.002, 0.0), (0.50, 0.004, 0.50))
        # Tiny detached floater above
        floater_v, floater_f = _make_box_mesh((0.22, 0.28, 0.0), (0.01, 0.01, 0.01))
        # Make dish have 60 faces (5x12) so floater is tiny (<2%?) and dish is largest
        # Actually use a 3-tier dish stack sharing vertices, or repeat dish_f cleanly:
        # Even cleaner: give dish 48 faces by subdividing each triangle into 4? Let's keep 3 distinct components
        # with dish_f (12), table_f (12), floater_f (2 faces = 2/26 = 7.7%, caught by keep_main_only).
        verts = np.vstack([dish_v, table_v, floater_v])
        faces = np.vstack([dish_f, table_f + len(dish_v), floater_f[:2] + len(dish_v) + len(table_v)])

        out_v, out_f, stats = t2b.filter_mesh_components(
            verts,
            faces,
            min_face_fraction=0.02,
            table_height_ratio=0.06,
            table_footprint_ratio=0.75,
            keep_main_only=True,
            up_axis_index=1,
        )
        self.assertEqual(stats["dropped_table"], 1)
        self.assertEqual(stats["dropped_detached"], 1)
        self.assertEqual(stats["kept_components"], 1)
        self.assertEqual(len(out_f), len(dish_f))
        self.assertEqual(len(out_v), len(dish_v))
        # Main dish bounds preserved
        np.testing.assert_allclose(out_v.min(axis=0), dish_v.min(axis=0), atol=1e-9)
        np.testing.assert_allclose(out_v.max(axis=0), dish_v.max(axis=0), atol=1e-9)


class TestTrainSplitGuardAndContactSheet(unittest.TestCase):
    def test_load_train_split_strict_rejects_val_leakage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            frame = {"file_path": "images/frame_000001.png"}
            (root / "transforms_train.json").write_text(json.dumps({"frames": [frame]}), encoding="utf-8")
            (root / "transforms_val.json").write_text(json.dumps({"frames": [frame]}), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "leakage"):
                t2b.load_train_split_strict(root)

    def test_make_turntable_contact_sheet_writes_valid_png(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lit = []
            clay = []
            for az in (0, 90, 180, 270):
                p_l = root / f"lit_{az}.png"
                p_c = root / f"clay_{az}.png"
                Image.new("RGB", (64, 64), (180, 120, 80)).save(p_l)
                Image.new("RGB", (64, 64), (140, 140, 140)).save(p_c)
                lit.append(p_l)
                clay.append(p_c)
            out = t2b.make_turntable_contact_sheet(lit, clay, root / "sheet.png", "test_dish")
            self.assertTrue(out.is_file())
            with Image.open(out) as im:
                self.assertGreater(im.width, 1000)
                self.assertGreater(im.height, 700)


class TestV2FixesOffline(unittest.TestCase):
    def test_2dgs_geometry_losses_handles_3d_and_4d_normals_and_alpha_weights(self):
        h, w = 8, 10
        rn_4d = np.zeros((1, h, w, 3), dtype=np.float32)
        rn_4d[..., 2] = 1.0
        nfd_3d = np.zeros((h, w, 3), dtype=np.float32)
        nfd_3d[..., 2] = 1.0
        nfd_4d = nfd_3d[None, ...]
        distort = np.full((1, h, w, 1), 0.2, dtype=np.float32)
        alpha = np.zeros((h, w), dtype=np.float32)
        alpha[2:6, 3:7] = 1.0

        loss_aligned, stats_aligned = t2b.compute_2dgs_geometry_losses(
            rn_4d, nfd_3d, distort, alpha, normal_weight=0.05, distort_weight=0.5
        )
        loss_4d, _ = t2b.compute_2dgs_geometry_losses(
            rn_4d, nfd_4d, distort, alpha, normal_weight=0.05, distort_weight=0.5
        )
        self.assertAlmostEqual(float(loss_aligned), float(loss_4d), places=6)
        self.assertAlmostEqual(stats_aligned["normal_loss"], 0.0, places=6)
        # Foreground fraction is (4*4)/(8*10) = 0.2; distort=0.2 -> weighted mean = 0.04
        self.assertAlmostEqual(stats_aligned["distort_loss"], 0.04, places=5)

        # Flipping normals inside foreground must raise normal_loss (regression vs row-0 slice bug)
        nfd_flipped = nfd_3d.copy()
        nfd_flipped[2:6, 3:7, 2] = -1.0
        loss_flipped, stats_flipped = t2b.compute_2dgs_geometry_losses(
            rn_4d, nfd_flipped, distort, alpha, normal_weight=0.05, distort_weight=0.5
        )
        self.assertGreater(stats_flipped["normal_loss"], 0.3)
        self.assertGreater(float(loss_flipped), float(loss_aligned))

        # Shape mismatch must fail closed
        with self.assertRaises(ValueError):
            t2b.compute_2dgs_geometry_losses(rn_4d, np.zeros((h - 1, w, 3)), distort, alpha)

    def test_estimate_orbit_up_axis_portrait_orbit_and_nonplanar_fallback(self):
        # Synthetic portrait-rotated orbit around tilted true up axis:
        # cameras sit above z_orbit=0 looking at origin, but camera +Y is rotated 90 deg sideways!
        true_up = np.array([0.2, -0.6, 0.7745966692414834], dtype=np.float64)
        true_up /= np.linalg.norm(true_up)
        # Build orthonormal basis (u, v, true_up)
        ref = np.array([1.0, 0.0, 0.0]) if abs(true_up[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        u_ax = np.cross(true_up, ref)
        u_ax /= np.linalg.norm(u_ax)
        v_ax = np.cross(true_up, u_ax)

        target = np.array([0.5, -0.3, 0.2], dtype=np.float64)
        portrait_c2ws = []
        for k in range(24):
            theta = 2.0 * np.pi * k / 24.0
            pos = target + 2.5 * (np.cos(theta) * u_ax + np.sin(theta) * v_ax) + 1.2 * true_up
            fwd = target - pos
            fwd /= np.linalg.norm(fwd)
            # Standard horizon-level right/up
            right_std = np.cross(fwd, true_up)
            right_std /= np.linalg.norm(right_std)
            up_std = np.cross(right_std, fwd)
            # Rotate camera 90 deg in image plane (portrait orientation: cam +Y = -right_std)
            c2w = np.eye(4, dtype=np.float64)
            c2w[:3, 0] = up_std
            c2w[:3, 1] = -right_std
            c2w[:3, 2] = -fwd
            c2w[:3, 3] = pos
            portrait_c2ws.append(c2w)

        est_up = t2b.estimate_orbit_up_axis(portrait_c2ws)
        self.assertGreater(float(np.dot(est_up, true_up)), 0.999)

        # Non-planar spherical distribution should fall back to camera +Y
        rng = np.random.default_rng(123)
        sphere_c2ws = []
        sphere_up = np.array([0.0, 1.0, 0.0], dtype=np.float64)
        for _ in range(30):
            d = rng.normal(size=3)
            d /= np.linalg.norm(d)
            pos = 3.0 * d
            fwd = -d
            right = np.cross(fwd, sphere_up)
            if np.linalg.norm(right) < 1e-4:
                continue
            right /= np.linalg.norm(right)
            cam_up = np.cross(right, fwd)
            c2w = np.eye(4, dtype=np.float64)
            c2w[:3, 0] = right
            c2w[:3, 1] = cam_up
            c2w[:3, 2] = -fwd
            c2w[:3, 3] = pos
            sphere_c2ws.append(c2w)
        est_sphere = t2b.estimate_orbit_up_axis(sphere_c2ws)
        self.assertGreater(float(np.dot(est_sphere, sphere_up)), 0.95)

    def test_sample_unpremultiplied_bilinear_rejects_soft_alpha_edge_and_avoids_dark_bleed(self):
        rgba = np.zeros((10, 10, 4), dtype=np.float32)
        # Un-premultiplied bright orange FG across [2:8, 2:8]
        rgba[2:8, 2:8, :3] = [1.0, 0.5, 0.2]
        # Soft alpha on border [2, :] and [:, 2], solid interior [3:7, 3:7]
        rgba[2:8, 2:8, 3] = 0.6
        rgba[3:7, 3:7, 3] = 0.98
        # Slight variation in one corner with alpha=0.96 (still >= 0.95)
        rgba[4, 4, :3] = [0.8, 0.4, 0.1]
        rgba[4, 4, 3] = 0.96

        coords = np.array(
            [
                [2.4, 4.0],  # crosses soft edge x=2 (alpha=0.6) -> rejected
                [3.5, 2.3],  # crosses soft edge y=2 (alpha=0.6) -> rejected
                [5.5, 5.5],  # deep solid interior -> accepted, un-premultiplied exact color
                [4.0, 4.0],  # all 4 neighbors >= 0.96 -> accepted, exact un-premultiplied color
            ],
            dtype=np.float64,
        )
        sampled, valid = t2b.sample_unpremultiplied_bilinear(rgba, coords, min_alpha=0.95)
        self.assertEqual(valid.tolist(), [False, False, True, True])
        np.testing.assert_allclose(sampled[0], [1.0, 0.5, 0.2], atol=1e-5)
        np.testing.assert_allclose(sampled[1], [0.8, 0.4, 0.1], atol=1e-5)

    def test_stamp_glb_asset_extras_sets_publication_ineligible_and_preserves_mesh(self):
        import struct
        import trimesh

        verts, faces = _make_box_mesh((0.0, 0.5, 0.0), (1.0, 1.0, 1.0))
        with tempfile.TemporaryDirectory() as tmp:
            glb_path = Path(tmp) / "intermediate.glb"
            trimesh.Trimesh(vertices=verts, faces=faces, process=False).export(str(glb_path))
            t2b.stamp_glb_asset_extras(
                glb_path, {"publication_eligible": False, "pipeline": "food3d-track2b-dense"}
            )
            raw = glb_path.read_bytes()
            jlen = struct.unpack_from("<I", raw, 12)[0]
            gltf = json.loads(raw[20 : 20 + jlen].decode("utf-8"))
            self.assertIs(gltf["asset"]["extras"]["publication_eligible"], False)
            self.assertEqual(gltf["asset"]["extras"]["pipeline"], "food3d-track2b-dense")
            reloaded = trimesh.load(str(glb_path), force="mesh")
            self.assertEqual(len(reloaded.faces), len(faces))

    def test_dihedral_stats_and_eval_sheet_render_label(self):
        # Flat 2-triangle quad -> 0 deg; folded 90 deg -> 90 deg
        verts_flat = np.array([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], dtype=np.float64)
        faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int64)
        flat_stats = t2b.compute_dihedral_stats(verts_flat, faces)
        self.assertAlmostEqual(flat_stats["mean_deg"], 0.0, places=3)

        verts_fold = np.array([[0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0]], dtype=np.float64)
        faces_fold = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int64)
        fold_stats = t2b.compute_dihedral_stats(verts_fold, faces_fold)
        self.assertAlmostEqual(fold_stats["mean_deg"], 90.0, places=2)

        with tempfile.TemporaryDirectory() as tmp:
            sheet_path = Path(tmp) / "eval_sheet.png"
            tile = Image.new("RGB", (64, 64), (100, 140, 90))
            row = (
                {"frame_stem": "frame_000000", "fg_psnr_db": 27.5, "fg_ssim": 0.85, "fg_delta_e": 4.2},
                [tile, tile, tile],
            )
            t2b._write_eval_sheet(sheet_path, [row], render_label="Track 2B mesh (albedo)")
            self.assertTrue(sheet_path.is_file())

            # Turntable luminance measurement helper
            tt_dir = Path(tmp) / "tt"
            tt_dir.mkdir()
            for az in (0, 90, 180, 270):
                arr = np.full((64, 64, 3), 230, dtype=np.uint8)
                arr[16:48, 16:48] = (140, 100, 60)
                Image.fromarray(arr, mode="RGB").save(tt_dir / f"lit_az{az}.png")
                Image.fromarray(arr, mode="RGB").save(tt_dir / f"clay_az{az}.png")
            lum_stats = t2b.measure_turntable_luminance(tt_dir)
            self.assertEqual(set(lum_stats["lit"].keys()), {"0", "90", "180", "270"})
            self.assertGreater(lum_stats["lit"]["180"], 0.35)


class TestV3FixesOffline(unittest.TestCase):
    def test_adaptive_smooth_iterations_and_crease_preserving_blend(self):
        self.assertEqual(t2b.choose_adaptive_smooth_iterations({"mean_deg": 4.2, "gt45_pct": 0.4}, 8), 0)
        self.assertEqual(t2b.choose_adaptive_smooth_iterations({"mean_deg": 5.8, "gt45_pct": 0.6}, 8), 2)
        self.assertEqual(t2b.choose_adaptive_smooth_iterations({"mean_deg": 14.0, "gt45_pct": 3.0}, 6), 6)
        self.assertEqual(t2b.choose_adaptive_smooth_iterations({"mean_deg": 14.0, "gt45_pct": 3.0}, 0), 0)

        # 90-deg crease vertices should stay near raw positions while flat vertices move to smoothed
        raw_v = np.array([[0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0]], dtype=np.float64)
        faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int64)
        smooth_v = raw_v + 0.5
        blended = t2b.blend_crease_preserving_vertices(raw_v, smooth_v, faces, max_preserve=0.85)
        # Vertices 0 and 2 lie on the 90-deg shared edge -> preserved by 85%
        np.testing.assert_allclose(blended[0], raw_v[0] + 0.15 * 0.5, atol=1e-6)
        np.testing.assert_allclose(blended[2], raw_v[2] + 0.15 * 0.5, atol=1e-6)
        # Vertices 1 and 3 do not touch the 90-deg edge -> move fully to smoothed
        np.testing.assert_allclose(blended[1], smooth_v[1], atol=1e-6)
        np.testing.assert_allclose(blended[3], smooth_v[3], atol=1e-6)

    def test_sanitize_glb_tangents_fixes_zero_and_non_unit_vectors(self):
        import struct
        import blender_bake

        normals = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]], dtype=np.float32)
        tangents = np.array(
            [
                [0.0, 0.0, 0.0, 1.0],   # zero tangent (ACCESSOR_VECTOR3_NON_UNIT)
                [3.0, 0.0, 4.0, -2.0],  # non-unit tangent + non-unit w
                [0.0, 1.0, 0.0, 1.0],   # valid tangent
            ],
            dtype=np.float32,
        )
        bin_chunk = normals.tobytes() + tangents.tobytes()
        gltf = {
            "asset": {"version": "2.0"},
            "buffers": [{"byteLength": len(bin_chunk)}],
            "bufferViews": [
                {"buffer": 0, "byteOffset": 0, "byteLength": len(normals.tobytes())},
                {"buffer": 0, "byteOffset": len(normals.tobytes()), "byteLength": len(tangents.tobytes())},
            ],
            "accessors": [
                {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"},
                {
                    "bufferView": 1,
                    "componentType": 5126,
                    "count": 3,
                    "type": "VEC4",
                    "min": [0.0, 0.0, 0.0, -2.0],
                    "max": [3.0, 1.0, 4.0, 1.0],
                },
            ],
            "meshes": [{"primitives": [{"attributes": {"NORMAL": 0, "TANGENT": 1}}]}],
        }
        json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
        json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
        total = 12 + 8 + len(json_bytes) + 8 + len(bin_chunk)
        glb_bytes = (
            struct.pack("<III", 0x46546C67, 2, total)
            + struct.pack("<II", len(json_bytes), 0x4E4F534A)
            + json_bytes
            + struct.pack("<II", len(bin_chunk), 0x004E4942)
            + bin_chunk
        )

        with tempfile.TemporaryDirectory() as tmp:
            glb_path = Path(tmp) / "geom.glb"
            glb_path.write_bytes(glb_bytes)
            fixed = blender_bake.sanitize_glb_tangents(glb_path)
            self.assertEqual(fixed, 2)

            out = glb_path.read_bytes()
            jlen = struct.unpack_from("<I", out, 12)[0]
            out_gltf = json.loads(out[20 : 20 + jlen].decode("utf-8"))
            out_bin_off = 20 + jlen + 8
            out_t = np.frombuffer(
                out[out_bin_off + len(normals.tobytes()) : out_bin_off + len(bin_chunk)],
                dtype=np.float32,
            ).reshape(3, 4)
            norms = np.linalg.norm(out_t[:, :3], axis=1)
            np.testing.assert_allclose(norms, [1.0, 1.0, 1.0], atol=1e-5)
            # First tangent must be orthogonal to normal [0, 0, 1]
            self.assertAlmostEqual(float(np.dot(out_t[0, :3], normals[0])), 0.0, places=5)
            self.assertEqual(float(out_t[1, 3]), -1.0)
            self.assertEqual(out_gltf["accessors"][1]["min"][3], -1.0)

    def test_mask_path_fallback_and_qa_cutout_prep(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "images").mkdir()
            (root / "masks").mkdir()
            rgb = np.full((16, 16, 3), [200, 120, 60], dtype=np.uint8)
            Image.fromarray(rgb, mode="RGB").save(root / "images" / "frame_000001.jpg")
            mask = np.zeros((16, 16), dtype=np.uint8)
            mask[4:12, 4:12] = 255
            Image.fromarray(mask, mode="L").save(root / "masks" / "frame_000001.png")

            frame = {"file_path": "images/frame_000001.jpg", "mask_path": "masks/frame_000001.png"}
            self.assertEqual(
                t2b._resolve_frame_mask_path(root, frame),
                root / "masks/frame_000001.png",
            )
            (root / "transforms_train.json").write_text(json.dumps({"frames": [frame]}), encoding="utf-8")
            cutout = t2b.prepare_qa_cutout_from_train(root, root / "eval" / "ref_cutout.png")
            self.assertTrue(cutout.is_file())
            with Image.open(cutout) as im:
                self.assertEqual(im.mode, "RGBA")
                arr = np.asarray(im)
                self.assertEqual(int(arr[0, 0, 3]), 0)
                self.assertEqual(int(arr[8, 8, 3]), 255)


class TestV4PoseRefinementOffline(unittest.TestCase):
    def test_se3_delta_application_zero_small_and_general_rotation(self):
        c2w = np.eye(4, dtype=np.float64)
        c2w[:3, 3] = np.array([0.2, -0.3, 2.5])
        w2c = t2b.opengl_c2w_to_opencv_w2c(c2w)

        # Zero delta must be exact identity
        w2c_zero = t2b.apply_se3_delta_w2c(w2c, np.zeros(3), np.zeros(3))
        np.testing.assert_allclose(w2c_zero, w2c, atol=1e-12)

        # Pure Z rotation by 90 deg + translation in camera frame
        rv = np.array([0.0, 0.0, np.pi / 2.0], dtype=np.float64)
        tr = np.array([0.1, -0.2, 0.3], dtype=np.float64)
        d_mat = t2b.se3_delta_to_matrix(rv, tr)
        self.assertAlmostEqual(float(np.linalg.det(d_mat[:3, :3])), 1.0, places=12)
        np.testing.assert_allclose(d_mat[:3, :3].T @ d_mat[:3, :3], np.eye(3), atol=1e-12)
        w2c_rot = t2b.apply_se3_delta_w2c(w2c, rv, tr)
        # World origin mapped by w2c then rotated/translated by d_mat
        pt = np.array([0.3, 0.4, -0.2, 1.0], dtype=np.float64)
        np.testing.assert_allclose(w2c_rot @ pt, d_mat @ (w2c @ pt), atol=1e-12)

        # Small-angle Taylor branch continuity around 1e-6 rad
        rv_tiny = np.array([2e-7, -3e-7, 1e-7], dtype=np.float64)
        d_tiny = t2b.se3_delta_to_matrix(rv_tiny, np.array([1e-5, 0.0, -2e-5]))
        np.testing.assert_allclose(d_tiny[:3, :3].T @ d_tiny[:3, :3], np.eye(3), atol=1e-12)

    def test_gauge_fixing_keeps_anchor_camera_strictly_fixed(self):
        raw_w2cs = np.repeat(np.eye(4, dtype=np.float64)[None, ...], 4, axis=0)
        for i in range(4):
            raw_w2cs[i, 2, 3] = 1.5 + 0.2 * i
        rotvecs = np.array(
            [
                [0.1, 0.2, -0.1],  # non-zero on anchor_index=2 should be ignored for anchor
                [0.02, -0.01, 0.03],
                [0.05, 0.04, -0.02],
                [-0.03, 0.02, 0.01],
            ],
            dtype=np.float64,
        )
        trans = np.full((4, 3), 0.05, dtype=np.float64)

        refined = t2b.apply_pose_deltas_with_gauge(raw_w2cs, rotvecs, trans, anchor_index=2)
        np.testing.assert_allclose(refined[2], raw_w2cs[2], atol=1e-12)
        self.assertGreater(float(np.linalg.norm(refined[0] - raw_w2cs[0])), 1e-3)
        self.assertGreater(float(np.linalg.norm(refined[1] - raw_w2cs[1])), 1e-3)
        self.assertGreater(float(np.linalg.norm(refined[3] - raw_w2cs[3])), 1e-3)

        with self.assertRaises(ValueError):
            t2b.apply_pose_deltas_with_gauge(raw_w2cs, rotvecs, trans, anchor_index=4)

    def test_select_anchor_camera_index_picks_lowest_reprojection_error(self):
        intr = {"w": 100, "h": 100, "fl_x": 100.0, "fl_y": 100.0, "cx": 50.0, "cy": 50.0}
        c2w_good = np.eye(4, dtype=np.float64)
        c2w_good[:3, 3] = [0.0, 0.0, 2.0]
        c2w_shifted = np.eye(4, dtype=np.float64)
        c2w_shifted[:3, 3] = [0.4, -0.3, 2.0]
        mask_centered = np.zeros((100, 100), dtype=bool)
        mask_centered[45:56, 45:56] = True
        idx = t2b.select_anchor_camera_index(
            [c2w_shifted, c2w_good],
            [mask_centered, mask_centered],
            [intr, intr],
            np.array([0.0, 0.0, 0.0]),
        )
        self.assertEqual(idx, 1)

    def test_refined_train_poses_save_load_round_trip(self):
        frames = [
            {"file_path": "images/frame_000002.png", "frame_number": 2},
            {"file_path": "images/frame_000003.png", "frame_number": 3},
        ]
        raw_c2ws = [np.eye(4, dtype=np.float64), np.eye(4, dtype=np.float64)]
        raw_c2ws[0][:3, 3] = [0.0, 0.0, 2.0]
        raw_c2ws[1][:3, 3] = [1.0, 0.0, 2.0]
        rotvecs = np.array([[0.05, 0.0, 0.0], [0.0, 0.02, 0.0]], dtype=np.float64)
        trans_w = np.array([[0.1, 0.0, 0.0], [0.0, 0.01, 0.0]], dtype=np.float64)
        w2c_ref = t2b.apply_se3_delta_w2c(t2b.opengl_c2w_to_opencv_w2c(raw_c2ws[1]), rotvecs[1], trans_w[1])
        ref_c2ws = [raw_c2ws[0].copy(), t2b.opencv_w2c_to_opengl_c2w(w2c_ref)]

        with tempfile.TemporaryDirectory() as tmp:
            out_path = Path(tmp) / "refined_train_poses.json"
            saved_path, summary = t2b.save_refined_train_poses(
                out_path,
                dish="co3d_pizza",
                train_frames=frames,
                raw_c2ws=raw_c2ws,
                refined_c2ws=ref_c2ws,
                rotvecs=rotvecs,
                trans_world=trans_w,
                scale_factor_to_m=0.5,
                anchor_index=0,
                warmup_steps=1000,
                pose_reg_weight=0.01,
            )
            self.assertEqual(saved_path, out_path)
            payload = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertIs(payload["publication_eligible"], False)
            self.assertIs(payload["frames"][0]["is_anchor"], True)
            self.assertEqual(payload["frames"][0]["rot_deg"], 0.0)
            self.assertEqual(payload["frames"][0]["trans_mm"], 0.0)
            self.assertAlmostEqual(summary["mean_rot_deg"], float(np.degrees(0.02)), places=3)
            self.assertAlmostEqual(summary["mean_trans_mm"], 5.0, places=3)

            loaded = t2b.load_refined_train_poses(out_path)
            self.assertEqual(set(loaded.keys()), {"frame_000002", "frame_000003"})
            np.testing.assert_allclose(loaded["frame_000002"], raw_c2ws[0], atol=1e-12)
            np.testing.assert_allclose(loaded["frame_000003"], ref_c2ws[1], atol=1e-12)

    def test_measure_texture_sharpness_distinguishes_sharp_from_blurred(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            uv_mask = np.zeros((64, 64), dtype=np.uint8)
            uv_mask[8:56, 8:56] = 255
            mask_path = root / "uv_mask.png"
            Image.fromarray(uv_mask, mode="L").save(mask_path)

            yy, xx = np.meshgrid(np.arange(64), np.arange(64), indexing="ij")
            checker = (((xx // 2 + yy // 2) % 2) * 200 + 25).astype(np.uint8)
            sharp_rgb = np.stack([checker, checker, checker], axis=-1)
            sharp_path = root / "sharp.png"
            Image.fromarray(sharp_rgb, mode="RGB").save(sharp_path)

            flat_rgb = np.full((64, 64, 3), 125, dtype=np.uint8)
            flat_path = root / "flat.png"
            Image.fromarray(flat_rgb, mode="RGB").save(flat_path)

            s_sharp = t2b.measure_texture_sharpness(sharp_path, mask_path)
            s_flat = t2b.measure_texture_sharpness(flat_path, mask_path)
            self.assertGreater(s_sharp["mean_grad_mag"], s_flat["mean_grad_mag"] + 0.05)
            self.assertGreater(s_sharp["laplacian_var"], s_flat["laplacian_var"] + 0.01)


class TestV5BestViewTexturingOffline(unittest.TestCase):
    def test_view_scoring_prefers_frontal_close_sharp_and_interior(self):
        cos_theta = np.array([0.95, 0.45, 0.95], dtype=np.float64)
        dist = np.array([0.40, 0.35, 0.70], dtype=np.float64)
        scores = t2b.compute_texel_view_score(
            cos_theta,
            dist,
            fl_x=900.0,
            fl_y=900.0,
            local_sharpness=np.array([0.05, 0.05, 0.05]),
            ref_sharpness=0.05,
            mask_dist_px=np.array([20.0, 20.0, 20.0]),
        )
        # Frontal & closer (idx 0) beats oblique (idx 1) and far (idx 2)
        self.assertGreater(scores[0], scores[1] * 2.5)
        self.assertGreater(scores[0], scores[2] * 2.5)

        # Sharpness map distinguishes sharp textured region from blurred region
        yy, xx = np.meshgrid(np.arange(64), np.arange(64), indexing="ij")
        sharp_pat = (((xx + yy) % 2) * 0.8 + 0.1).astype(np.float32)
        sharp_rgb = np.stack([sharp_pat, sharp_pat, sharp_pat], axis=-1)
        blur_rgb = np.full((64, 64, 3), 0.5, dtype=np.float32)
        mask = np.ones((64, 64), dtype=bool)
        sh_map, sh_var = t2b.compute_view_sharpness_map(sharp_rgb, mask=mask, smooth_sigma=4.0)
        bl_map, bl_var = t2b.compute_view_sharpness_map(blur_rgb, mask=mask, smooth_sigma=4.0)
        self.assertGreater(sh_var, bl_var + 0.05)
        self.assertGreater(float(sh_map[32, 32]), float(bl_map[32, 32]) + 0.5)

        s_sharp = t2b.compute_texel_view_score(
            np.array([0.9, 0.9]),
            np.array([0.5, 0.5]),
            fl_x=900.0,
            fl_y=900.0,
            local_sharpness=np.array([sh_map[32, 32], bl_map[32, 32] + 1e-4]),
            ref_sharpness=float(sh_map[32, 32]),
            mask_dist_px=np.array([15.0, 1.0]),
        )
        self.assertGreater(s_sharp[0], s_sharp[1] * 2.0)

    def test_face_adjacency_and_potts_smoothing_eliminates_isolated_speckles(self):
        # 2x2 grid of quads split into 8 triangles; center faces have noisy 2nd view spike
        faces = np.array(
            [
                [0, 1, 3], [0, 3, 4],
                [1, 2, 4], [1, 4, 5],
                [3, 4, 6], [3, 6, 7],
                [4, 5, 7], [4, 7, 8],
            ],
            dtype=np.int64,
        )
        ea, eb = t2b.build_face_adjacency(faces)
        self.assertGreater(len(ea), 0)

        scores = np.zeros((8, 2), dtype=np.float32)
        valid = np.ones((8, 2), dtype=bool)
        # 7 faces strongly prefer view 0; face 3 slightly prefers view 1 (noise spike)
        scores[:, 0] = 10.0
        scores[:, 1] = 2.0
        scores[3, 0] = 9.5
        scores[3, 1] = 10.0
        labels = t2b.smooth_face_view_labels(scores, valid, ea, eb, potts_weight=0.30, n_iters=4)
        self.assertTrue(np.all(labels == 0))

        # Respects strict visibility: if face 3 is NOT visible in view 0, it must keep view 1
        valid[3, 0] = False
        labels_vis = t2b.smooth_face_view_labels(scores, valid, ea, eb, potts_weight=0.30, n_iters=4)
        self.assertEqual(int(labels_vis[3]), 1)

    def test_global_color_levelling_recovers_exposure_gain_and_offset(self):
        rng = np.random.default_rng(7)
        n_pts, n_views = 400, 4
        true_rgb = rng.uniform(0.15, 0.75, size=(n_pts, 3))
        true_gains = np.array(
            [
                [1.00, 1.00, 1.00],
                [0.82, 0.85, 0.88],
                [1.22, 1.18, 1.14],
                [0.96, 1.02, 0.99],
            ],
            dtype=np.float64,
        )
        true_offsets = np.array(
            [
                [0.00, 0.00, 0.00],
                [0.02, 0.01, 0.00],
                [-0.02, -0.01, -0.01],
                [0.01, -0.01, 0.01],
            ],
            dtype=np.float64,
        )
        # Observed = (true_rgb - offset) / gain so applying (gain * obs + offset) recovers true_rgb
        obs = (true_rgb[:, None, :] - true_offsets[None, :, :]) / true_gains[None, :, :]
        obs = np.clip(obs, 0.0, 1.0)
        weights = np.ones((n_pts, n_views), dtype=np.float64)
        # Add sparse visibility + 1% specular outliers
        weights[rng.random((n_pts, n_views)) < 0.2] = 0.0
        obs[5, 1] = 0.99

        gains, offsets, diag = t2b.solve_global_color_levelling(obs, weights)
        self.assertLess(diag["mean_abs_residual_after"], diag["mean_abs_residual_before"] * 0.25)
        # Pairwise corrected views agree closely
        corrected = obs * gains[None, :, :] + offsets[None, :, :]
        valid = weights > 0
        # Compare view 1 vs view 2 on shared points
        both = valid[:, 1] & valid[:, 2]
        diff_before = float(np.mean(np.abs(obs[both, 1] - obs[both, 2])))
        diff_after = float(np.mean(np.abs(corrected[both, 1] - corrected[both, 2])))
        self.assertLess(diff_after, diff_before * 0.25)

    def test_narrow_seam_band_blending_and_seam_visibility(self):
        h, w = 32, 32
        valid = np.ones((h, w), dtype=bool)
        labels = np.zeros((h, w), dtype=np.int32)
        labels[:, 16:] = 1

        primary = np.zeros((h, w, 3), dtype=np.float32)
        primary[:, :16] = [0.8, 0.3, 0.2]
        primary[:, 16:] = [0.4, 0.3, 0.2]
        other = np.zeros((h, w, 3), dtype=np.float32)
        other[:, :16] = [0.4, 0.3, 0.2]
        other[:, 16:] = [0.8, 0.3, 0.2]

        seam_before = t2b.measure_seam_visibility(primary, valid, labels)
        blended, seam_band = t2b.blend_narrow_seam_band(
            primary, other, valid, valid, labels, seam_radius_px=4.0
        )
        seam_after = t2b.measure_seam_visibility(blended, valid, labels)

        # Far from seam (col 2 and col 29) remains 100% unblended single view
        np.testing.assert_allclose(blended[16, 2], primary[16, 2], atol=1e-6)
        np.testing.assert_allclose(blended[16, 29], primary[16, 29], atol=1e-6)
        self.assertFalse(bool(seam_band[16, 2]))
        self.assertTrue(bool(seam_band[16, 15]))
        # Boundary jump across seam drops dramatically after feathering
        self.assertLess(seam_after["seam_excess_delta_e"], seam_before["seam_excess_delta_e"] * 0.25)


class TestV6FixesOffline(unittest.TestCase):
    def test_carve_mesh_by_train_masks_drops_out_of_mask_flap_preserves_interior(self):
        # Main dish box centered at origin + protruding thin flap at x = [0.22, 0.35]
        main_v, main_f = _make_box_mesh((0.0, 0.05, 0.0), (0.16, 0.08, 0.16))
        flap_v, flap_f = _make_box_mesh((0.28, 0.05, 0.0), (0.10, 0.01, 0.02))
        # Bridge flap to main_v via shared edge so it is one connected component before carving
        verts = np.vstack([main_v, flap_v])
        bridge_f = np.array([[1, 5, 8], [5, 12, 8]], dtype=np.int64)
        faces = np.vstack([main_f, flap_f + len(main_v), bridge_f])

        intr = {"w": 128, "h": 128, "fl_x": 120.0, "fl_y": 120.0, "cx": 64.0, "cy": 64.0}
        masks, w2cs, intrs = [], [], []
        for k in range(10):
            ang = 2.0 * np.pi * k / 10.0
            pos = np.array([0.8 * np.sin(ang), 0.35, 0.8 * np.cos(ang)], dtype=np.float64)
            fwd = np.array([0.0, 0.05, 0.0]) - pos
            fwd /= np.linalg.norm(fwd)
            right = np.cross(fwd, np.array([0.0, 1.0, 0.0]))
            right /= np.linalg.norm(right)
            up = np.cross(right, fwd)
            c2w = np.eye(4, dtype=np.float64)
            c2w[:3, 0] = right
            c2w[:3, 1] = up
            c2w[:3, 2] = -fwd
            c2w[:3, 3] = pos
            w2c = t2b.opengl_c2w_to_opencv_w2c(c2w)
            # Project ONLY main_v box to build clean train foreground mask (flap excluded)
            uv_m, _ = t2b.project_points_opencv(main_v, w2c, intr)
            mk = np.zeros((128, 128), dtype=bool)
            x0 = max(0, int(np.floor(uv_m[:, 0].min())) - 2)
            x1 = min(128, int(np.ceil(uv_m[:, 0].max())) + 3)
            y0 = max(0, int(np.floor(uv_m[:, 1].min())) - 2)
            y1 = min(128, int(np.ceil(uv_m[:, 1].max())) + 3)
            mk[y0:y1, x0:x1] = True
            masks.append(mk)
            w2cs.append(w2c)
            intrs.append(intr)

        out_v, out_f, _, stats = t2b.carve_mesh_by_train_masks(
            verts, faces, masks, w2cs, intrs, mask_tol_px=1.5, max_out_fraction=0.34, min_seen_views=8
        )
        self.assertGreater(stats["carved_faces"], 0)
        self.assertLess(float(out_v[:, 0].max()), 0.12)
        self.assertEqual(len(out_f), len(main_f))

    def test_trim_support_plane_drips_removes_narrow_drip_keeps_flat_base(self):
        # Main flat box sitting at y=[0.012, 0.100] + narrow hanging drip down to y=0.000
        main_v, main_f = _make_box_mesh((0.0, 0.056, 0.0), (0.20, 0.088, 0.14))
        drip_v, drip_f = _make_box_mesh((0.07, 0.006, 0.0), (0.008, 0.012, 0.010))
        verts = np.vstack([main_v, drip_v])
        faces = np.vstack([main_f, drip_f + len(main_v)])
        out_v, out_f, _, stats = t2b.trim_support_plane_drips(verts, faces, up_axis_index=1)
        self.assertTrue(stats["trimmed"])
        self.assertGreater(stats["y_support_offset"], 0.005)
        self.assertGreaterEqual(float(out_v[:, 1].min()), 0.005)
        self.assertEqual(len(out_f), len(main_f))

        # Flat-bottomed mesh with no narrow drip must not be trimmed away
        flat_v, flat_f = _make_box_mesh((0.0, 0.04, 0.0), (0.20, 0.08, 0.12))
        flat_out_v, flat_out_f, _, flat_stats = t2b.trim_support_plane_drips(flat_v, flat_f, up_axis_index=1)
        self.assertEqual(len(flat_out_f), len(flat_f))
        self.assertAlmostEqual(float(flat_out_v[:, 1].min()), 0.0, places=5)

    def test_trim_support_plane_drips_removes_attached_stalactite_while_main_base_hits_floor(self):
        import trimesh

        # Single manifold high-res flat-bottom mesh (y=[0.016..0.100]) except a broad main belly at y=0
        # AND an attached narrow hanging corner stalactite dropping to y=0.002 at (x=0.08, z=0.035)
        sphere = trimesh.creation.icosphere(subdivisions=5, radius=0.08)
        verts = np.asarray(sphere.vertices, dtype=np.float64).copy()
        faces = np.asarray(sphere.faces, dtype=np.int64).copy()
        # Squash vertically & scale horizontally like a sandwich/bun resting at y=0..0.09
        verts[:, 0] *= 1.35  # span X ~ 0.216m
        verts[:, 2] *= 0.85  # span Z ~ 0.136m
        verts[:, 1] = np.clip(verts[:, 1] * 0.65 + 0.045, 0.014, 0.098)
        # Flatten central belly down to y=0.0 so global support plane already hits y=0.0
        in_belly = (verts[:, 0] ** 2 / (0.045**2) + verts[:, 2] ** 2 / (0.035**2) <= 1.0) & (verts[:, 1] < 0.03)
        verts[in_belly, 1] = 0.0
        # Pull out a narrow connected corner stalactite (radius 5mm) down to y=0.002 at (+0.075, +0.038)
        r_drip = np.hypot(verts[:, 0] - 0.075, verts[:, 2] - 0.038)
        on_drip = (r_drip < 0.006) & (verts[:, 1] < 0.035)
        verts[on_drip, 1] = 0.002 + 0.014 * (r_drip[on_drip] / 0.006) ** 2

        out_v, out_f, _, stats = t2b.trim_support_plane_drips(verts, faces, up_axis_index=1)
        self.assertGreater(stats.get("hanging_drips_removed", 0), 0)
        rem_drip = out_v[(np.hypot(out_v[:, 0] - 0.075, out_v[:, 2] - 0.038) < 0.0035) & (out_v[:, 1] < 0.008)]
        self.assertEqual(len(rem_drip), 0)
        self.assertLess(float(out_v[:, 1].min()), 0.002)
        self.assertGreater(float(out_v[:, 1].max()), 0.085)

    def test_carve_mesh_by_train_masks_tolerates_1px_mask_clipping_with_v6_defaults(self):
        main_v, main_f = _make_box_mesh((0.0, 0.05, 0.0), (0.16, 0.08, 0.16))
        intr = {"w": 128, "h": 128, "fl_x": 120.0, "fl_y": 120.0, "cx": 64.0, "cy": 64.0}
        masks, w2cs, intrs = [], [], []
        for k in range(10):
            ang = 2.0 * np.pi * k / 10.0
            pos = np.array([0.8 * np.sin(ang), 0.35, 0.8 * np.cos(ang)], dtype=np.float64)
            fwd = np.array([0.0, 0.05, 0.0]) - pos
            fwd /= np.linalg.norm(fwd)
            right = np.cross(fwd, np.array([0.0, 1.0, 0.0]))
            right /= np.linalg.norm(right)
            up = np.cross(right, fwd)
            c2w = np.eye(4, dtype=np.float64)
            c2w[:3, 0], c2w[:3, 1], c2w[:3, 2], c2w[:3, 3] = right, up, -fwd, pos
            w2c = t2b.opengl_c2w_to_opencv_w2c(c2w)
            uv_m, _ = t2b.project_points_opencv(main_v, w2c, intr)
            mk = np.zeros((128, 128), dtype=bool)
            # Clip 1px off the top edge of masks in 40% of frames (within default 2px tolerance)
            clip_px = 1 if k < 4 else 0
            x0 = max(0, int(np.floor(uv_m[:, 0].min())))
            x1 = min(128, int(np.ceil(uv_m[:, 0].max())) + 1)
            y0 = max(0, int(np.floor(uv_m[:, 1].min())) + clip_px)
            y1 = min(128, int(np.ceil(uv_m[:, 1].max())) + 1)
            mk[y0:y1, x0:x1] = True
            masks.append(mk)
            w2cs.append(w2c)
            intrs.append(intr)
        out_v, out_f, _, stats = t2b.carve_mesh_by_train_masks(verts := main_v, faces := main_f, masks, w2cs, intrs)
        self.assertEqual(stats["carved_faces"], 0)
        self.assertEqual(len(out_f), len(faces))

    def test_fill_small_boundary_holes_and_smooth_isolated_pits(self):
        import trimesh

        sphere = trimesh.creation.icosphere(subdivisions=3, radius=0.10)
        verts = np.asarray(sphere.vertices, dtype=np.float64).copy()
        faces = np.asarray(sphere.faces, dtype=np.int64).copy()
        # Punch a tiny hole by dropping faces touching vertex 0, and inject a deep pit at vertex 100
        drop_mask = np.any(faces == 0, axis=1)
        faces_holed = faces[~drop_mask]
        verts_pitted = verts.copy()
        verts_pitted[100] *= 0.72  # sharp inward pit

        filled_v, filled_f, _, touched, h_stats = t2b.fill_small_boundary_holes(
            verts_pitted, faces_holed, max_hole_verts=100, max_hole_diam_frac=0.3
        )
        self.assertEqual(h_stats["holes_filled"], 1)
        self.assertTrue(trimesh.Trimesh(vertices=filled_v, faces=filled_f, process=False).is_watertight)

        smoothed_v, p_stats = t2b.smooth_isolated_surface_pits(
            filled_v, filled_f, seed_vertices=touched, pit_normal_dot=0.80, max_pit_cluster_verts=60, smooth_iters=8
        )
        self.assertGreater(p_stats["pit_vertices_smoothed"], 0)
        # Pitted vertex 100 radius moves back toward sphere surface radius 0.10
        r_before = float(np.linalg.norm(filled_v[100]))
        r_after = float(np.linalg.norm(smoothed_v[100]))
        self.assertGreater(r_after, r_before + 0.01)

    def test_solve_color_levelling_field_fixes_spatial_gradient_and_chroma(self):
        rng = np.random.default_rng(19)
        n_pts, n_views = 500, 6
        true_rgb = rng.uniform(0.18, 0.72, size=(n_pts, 3))
        xy_norm = rng.uniform(-0.9, 0.9, size=(n_pts, n_views, 2))
        # Synthetic camera white-balance drift + spatial left-to-right warm orange gradient
        true_g0 = np.array(
            [
                [1.00, 1.00, 1.00],
                [1.22, 1.02, 0.85],
                [0.84, 0.98, 1.15],
                [1.10, 1.08, 0.96],
                [0.92, 0.95, 1.04],
                [1.05, 1.00, 0.92],
            ],
            dtype=np.float64,
        )
        true_gx = np.array(
            [
                [0.08, 0.02, -0.05],
                [-0.07, -0.02, 0.04],
                [0.06, 0.03, -0.03],
                [-0.05, 0.01, 0.05],
                [0.04, -0.02, -0.04],
                [-0.06, 0.02, 0.03],
            ],
            dtype=np.float64,
        )
        obs = np.zeros((n_pts, n_views, 3), dtype=np.float64)
        for v in range(n_views):
            g_v = true_g0[None, v, :] + true_gx[None, v, :] * xy_norm[:, v, 0:1]
            obs[:, v, :] = np.clip(true_rgb / g_v, 0.0, 1.0)
        weights = np.ones((n_pts, n_views), dtype=np.float64)
        weights[rng.random((n_pts, n_views)) < 0.2] = 0.0

        gain_params, offsets, diag = t2b.solve_color_levelling_field(obs, weights, obs_xy_norm=xy_norm)
        self.assertLess(diag["mean_abs_residual_after"], diag["mean_abs_residual_before"] * 0.25)
        self.assertLess(diag["chroma_residual_after"], diag["chroma_residual_before"] * 0.30)
        self.assertGreater(diag["spatial_max_abs"], 0.02)

        # Evaluate apply_color_levelling_field on view 1
        uv_px = np.stack([(xy_norm[:, 1, 0] + 1.0) * 50.0, (xy_norm[:, 1, 1] + 1.0) * 50.0], axis=-1)
        srgb_in = t2b.linear_to_srgb(obs[:, 1, :])
        srgb_out = t2b.apply_color_levelling_field(srgb_in, uv_px, 100, 100, gain_params[1], offsets[1])
        self.assertEqual(srgb_out.shape, srgb_in.shape)

    def test_inpaint_unprojected_texels_replaces_dark_holes_from_neighbors(self):
        h, w = 32, 32
        valid = np.ones((h, w), dtype=bool)
        good = np.ones((h, w), dtype=bool)
        good[12:16, 12:16] = False  # unprojected pit/hole
        atlas = np.full((h, w, 3), [0.80, 0.55, 0.30], dtype=np.float32)
        atlas[12:16, 12:16] = [0.02, 0.02, 0.02]  # dark/background hole

        out, stats = t2b.inpaint_unprojected_texels(atlas, valid, good, smooth_iters=3)
        self.assertEqual(stats["inpainted_texels"], 16)
        np.testing.assert_allclose(out[13, 13], [0.80, 0.55, 0.30], atol=0.02)
        # Already projected texel stays untouched
        np.testing.assert_allclose(out[2, 2], [0.80, 0.55, 0.30], atol=1e-6)


class TestV8FineDetailNormalsOffline(unittest.TestCase):
    def test_detail_height_and_cavity_frequency_split_and_gutter_isolation(self) -> None:
        import pbr_author

        h, w = 96, 96
        valid = np.zeros((h, w), dtype=bool)
        valid[8:88, 8:88] = True

        # Uniform food base with a raised bright topping square inside a dark narrow crevice,
        # plus a uniform patch adjacent to the black UV gutter on the right (cols 72..87).
        albedo = np.full((h, w, 3), [0.45, 0.25, 0.12], dtype=np.float32)
        albedo[28:52, 28:52] = [0.82, 0.72, 0.42]
        # Narrow dark crevice around the raised square (2px moat)
        albedo[26:28, 26:54] = [0.14, 0.08, 0.04]
        albedo[52:54, 26:54] = [0.14, 0.08, 0.04]
        albedo[26:54, 26:28] = [0.14, 0.08, 0.04]
        albedo[26:54, 52:54] = [0.14, 0.08, 0.04]
        # Make UV gutter black (0) outside valid mask
        albedo[~valid] = 0.0

        masks = {
            "dry_mask": valid.astype(np.float32),
            "moist_mask": np.zeros((h, w), dtype=np.float32),
            "vessel_mask": np.zeros((h, w), dtype=np.float32),
            "wet_mask": np.zeros((h, w), dtype=np.float32),
            "liquid_mask": np.zeros((h, w), dtype=np.float32),
        }

        gx, gy, cavity, _ = pbr_author.compute_detail_height_and_cavity(
            albedo, masks, valid, cavity_strength=0.75
        )

        # No UV-gutter bleed: uniform valid border adjacent to black gutter stays flat
        self.assertLess(float(np.max(np.abs(gx[20:70, 78:87]))), 1e-4)
        self.assertGreater(float(np.min(cavity[20:70, 78:87])), 0.99)

        # Tangent-space normal signs: left edge of bright square has gx > 0 (-gx < 0 -> points left),
        # right edge has gx < 0 (-gx > 0 -> points right), top edge has gy > 0 (points +v up).
        self.assertGreater(float(gx[40, 28]), 0.01)
        self.assertLess(float(gx[40, 52]), -0.01)
        self.assertGreater(float(gy[28, 40]), 0.01)

        # Crevice moat is darkened relative to raised topping interior
        self.assertLess(float(np.mean(cavity[26:28, 32:48])), 0.85)
        self.assertGreater(float(np.mean(cavity[36:44, 36:44])), 0.98)

        # Vessel mask suppresses cavity darkening
        masks_vessel = dict(masks)
        masks_vessel["dry_mask"] = np.zeros((h, w), dtype=np.float32)
        masks_vessel["vessel_mask"] = valid.astype(np.float32)
        _, _, cav_vessel, _ = pbr_author.compute_detail_height_and_cavity(
            albedo, masks_vessel, valid, cavity_strength=0.75
        )
        self.assertGreater(float(np.min(cav_vessel[valid])), 0.90)

    def test_detail_normal_resolution_parity_1024_vs_2048(self) -> None:
        import pbr_author

        def _run_at(sz: int) -> tuple[float, float]:
            # Periodic ~8mm-scale topping bumps (32px period at 2048px, 16px at 1024px).
            yy, xx = np.meshgrid(np.linspace(0.0, 1.0, sz), np.linspace(0.0, 1.0, sz), indexing="ij")
            bump = (0.5 + 0.5 * np.sin(2.0 * np.pi * 64.0 * xx) * np.sin(2.0 * np.pi * 64.0 * yy)).astype(np.float32)
            albedo = np.stack([0.35 + 0.45 * bump, 0.25 + 0.40 * bump, 0.15 + 0.25 * bump], axis=-1)
            valid = np.ones((sz, sz), dtype=bool)
            ao = np.full((sz, sz), 0.92, dtype=np.float32)
            base_n = np.full((sz, sz, 3), [0.5, 0.5, 1.0], dtype=np.float32)
            masks = {
                "dry_mask": np.ones((sz, sz), dtype=np.float32),
                "moist_mask": np.zeros((sz, sz), dtype=np.float32),
                "vessel_mask": np.zeros((sz, sz), dtype=np.float32),
                "wet_mask": np.zeros((sz, sz), dtype=np.float32),
                "liquid_mask": np.zeros((sz, sz), dtype=np.float32),
            }
            orm, _, n_final, stats = pbr_author.synthesize_pbr_maps(
                albedo_delit=albedo,
                base_normal_rgb=base_n,
                ao=ao,
                masks=masks,
                valid_mask=valid,
                micro_normal_strength=0.0,
                detail_normal_strength=18.0,
                cavity_strength=0.75,
            )
            n_vec = n_final * 2.0 - 1.0
            np.testing.assert_allclose(np.linalg.norm(n_vec, axis=-1), 1.0, atol=1e-4)
            self.assertTrue(np.all(n_vec[..., 2] > 0.0))
            self.assertEqual(stats["metallic_max"], 0.0)
            self.assertTrue(np.all(orm[..., 2] == 0.0))
            return stats["normal_xy_abs_mean"], stats["ao_p10"]

        n2048, ao2048 = _run_at(2048)
        n1024, ao1024 = _run_at(1024)
        self.assertGreater(n2048, 0.03)
        self.assertAlmostEqual(n2048, n1024, delta=0.015)
        self.assertAlmostEqual(ao2048, ao1024, delta=0.04)

    def test_opt_in_detail_pass_report_and_run_script_flag(self) -> None:
        import pbr_author

        with tempfile.TemporaryDirectory() as tmp:
            maps_dir = Path(tmp) / "maps"
            out_off = Path(tmp) / "pbr_off"
            out_on = Path(tmp) / "pbr_on"
            maps_dir.mkdir()

            sz = 64
            yy, xx = np.meshgrid(np.arange(sz), np.arange(sz), indexing="ij")
            blob = np.exp(-(((xx - 32) ** 2 + (yy - 32) ** 2) / (6.0 ** 2))).astype(np.float32)
            rgb = np.clip(np.stack([0.30 + 0.55 * blob, 0.18 + 0.45 * blob, 0.08 + 0.25 * blob], axis=-1) * 255, 0, 255).astype(np.uint8)
            nrm = np.full((sz, sz, 3), [128, 128, 255], dtype=np.uint8)
            ao = np.full((sz, sz), 235, dtype=np.uint8)
            geom = np.full((sz, sz, 3), [128, 100, 240], dtype=np.uint8)
            mask = np.full((sz, sz), 255, dtype=np.uint8)
            Image.fromarray(rgb, mode="RGB").save(maps_dir / "basecolor.png")
            Image.fromarray(rgb, mode="RGB").save(maps_dir / "roughness.png")
            Image.fromarray(nrm, mode="RGB").save(maps_dir / "normal.png")
            Image.fromarray(ao, mode="L").save(maps_dir / "ao.png")
            Image.fromarray(geom, mode="RGB").save(maps_dir / "geom_features.png")
            Image.fromarray(mask, mode="L").save(maps_dir / "uv_mask.png")

            rep_off = pbr_author.author_pbr_maps(
                maps_dir, out_off, micro_normal_strength=0.25, occlusion_strength=0.25
            )
            rep_on = pbr_author.author_pbr_maps(
                maps_dir,
                out_on,
                micro_normal_strength=0.0,
                occlusion_strength=0.70,
                detail_normal_strength=18.0,
                cavity_strength=0.75,
            )
            self.assertEqual(rep_off["detail_normal_strength"], 0.0)
            self.assertEqual(rep_off["cavity_strength"], 0.0)
            self.assertEqual(rep_on["detail_normal_strength"], 18.0)
            self.assertEqual(rep_on["cavity_strength"], 0.75)
            self.assertGreater(rep_on["normal_xy_abs_mean"], rep_off["normal_xy_abs_mean"] * 2.0)
            self.assertLessEqual(rep_on["ao_p10"], rep_off["ao_p10"])

        run_sh = (Path(__file__).resolve().parents[1] / "scripts" / "food3d" / "run_track2b.sh").read_text(encoding="utf-8")
        self.assertIn("T2B_FINE_DETAIL=${T2B_FINE_DETAIL:-0}", run_sh)
        self.assertIn("--detail-normal-strength", run_sh)
        self.assertIn("--cavity-strength", run_sh)
        self.assertIn("--orm-max-size", run_sh)
        self.assertIn("T2B_REUSE_DIR", run_sh)

    def test_viewer_and_eval_lighting_presets_and_exp0_isolation(self) -> None:
        food3d_dir = Path(__file__).resolve().parents[1] / "scripts" / "food3d"
        viewer_html = (food3d_dir / "viewer.html").read_text(encoding="utf-8")
        eval_mjs = (food3d_dir / "render_track2b_eval.mjs").read_text(encoding="utf-8")
        exp0_html = (Path(__file__).resolve().parents[1] / "scripts" / "exp0" / "viewer.html").read_text(encoding="utf-8")

        for src in (viewer_html, eval_mjs):
            self.assertIn("params.get('lighting') || 'studio'", src)
            self.assertIn("lightingPreset === 'legacy'", src)
            self.assertIn("params.get('exposure')", src)
            self.assertIn("useLegacyLighting ? 0.96 : 1.04", src)
            self.assertIn("legacy ? 0x1b1a18 : 0xc8c7c4", src)
            self.assertIn("useLegacyLighting ? 0xfff0dc : 0xfffaf2", src)
            self.assertIn("useLegacyLighting ? 2.55 : 1.48", src)
            self.assertIn("publication_eligible: false", src)

        self.assertIn("window.__pose", viewer_html)
        self.assertIn("window.__setMode", viewer_html)
        self.assertIn("food3d:setMode", viewer_html)
        self.assertIn("RoomEnvironment", exp0_html)
        self.assertIn("window.__pose", exp0_html)


class TestV10BrightConcaveOffline(unittest.TestCase):
    def test_face_luminance_quantiles_are_weighted_and_nan_when_unseen(self):
        lum = np.array([[10.0, 20.0, 30.0, 40.0, np.inf], [5.0, 5.0, 5.0, np.inf, np.inf]], dtype=np.float32)
        w = np.array([[1.0, 1.0, 1.0, 1.0, 0.0], [1.0, 1.0, 1.0, 0.0, 0.0]], dtype=np.float32)
        q = t2b.compute_face_luminance_quantiles(lum, w, (0.5, 0.75, 0.99))
        self.assertAlmostEqual(float(q[0, 0]), 20.0, places=4)
        self.assertAlmostEqual(float(q[0, 1]), 30.0, places=4)
        self.assertAlmostEqual(float(q[1, 0]), 5.0, places=4)
        unseen = t2b.compute_face_luminance_quantiles(np.full((1, 3), np.inf), np.zeros((1, 3)), (0.5,))
        self.assertTrue(np.isnan(unseen[0, 0]))

    def test_bright_concave_target_weight_activates_concave_or_spread_texels(self):
        ao = np.array([0.60, 0.70, 0.95, 1.00, 1.00], dtype=np.float32)
        spread = np.array([0.0, 0.0, 0.0, 0.0, 0.90], dtype=np.float32)
        w = t2b.compute_bright_concave_target_weight(ao, spread)
        self.assertGreater(float(w[0]), float(w[2]))
        self.assertAlmostEqual(float(w[2]), 0.0, places=6)
        self.assertAlmostEqual(float(w[3]), 0.0, places=6)
        # spread path claims a texel with perfect AO but strong inter-view shadow spread
        self.assertGreaterEqual(float(w[4]), 0.80)

    def test_bright_concave_upper_color_prefers_bright_and_rejects_chroma_outlier(self):
        dark_olive = (150, 130, 95)
        cream = [(230, 205, 166), (232, 208, 170), (228, 203, 164), (231, 206, 168)]
        base = np.array([[0.45, 0.40, 0.30]], dtype=np.float32)
        samples = np.zeros((1, 5, 3), dtype=np.uint8)
        for i, c in enumerate([*cream, dark_olive]):
            samples[0, i] = c
        weights = np.ones((1, 5), dtype=np.float16)
        out = t2b.compute_bright_concave_upper_color(samples, weights, base)
        # Picks the cream cluster rather than the single dark self-shadowed observation.
        self.assertGreater(float(out[0, 0]), 0.80)
        self.assertGreater(float(out[0, 1]), 0.70)
        # A bright but chroma-inconsistent (green) view must not drag the mean green.
        samples2 = samples.copy()
        samples2[0, 4] = (200, 230, 170)
        out2 = t2b.compute_bright_concave_upper_color(samples2, weights, base)
        self.assertLess(float(out2[0, 1]), float(out2[0, 0]) + 0.05)

    def test_bright_concave_blend_localizes_to_concave_texels_and_keeps_base_without_views(self):
        base = np.array([[0.35, 0.30, 0.22], [0.90, 0.82, 0.66]], dtype=np.float32)  # concave, flat
        ao = np.array([0.70, 1.00], dtype=np.float32)
        spread = np.array([0.0, 0.0], dtype=np.float32)
        w = t2b.compute_bright_concave_target_weight(ao, spread)[:, None]
        samples = np.full((2, 4, 3), (232, 208, 170), dtype=np.uint8)
        weights = np.ones((2, 4), dtype=np.float16)
        weights[1] = 0.0  # flat texel has no observations (unseen -> fallback stays)
        upper = t2b.compute_bright_concave_upper_color(samples, weights, base)
        blended = (1.0 - w) * base + w * upper
        # Concave texel brightens toward the real cream observation.
        self.assertGreater(float(blended[0, 0]), float(base[0, 0]) + 0.3)
        # Flat, already-correct texel is left untouched (weight 0) and unseen row keeps base.
        np.testing.assert_allclose(blended[1], base[1], atol=1e-6)
        np.testing.assert_allclose(upper[1], base[1], atol=1e-6)

    def test_bright_concave_is_opt_in_and_wired_through_scripts(self) -> None:
        food3d_dir = Path(__file__).resolve().parents[1] / "scripts" / "food3d"
        src = (food3d_dir / "track2b_mesh.py").read_text(encoding="utf-8")
        run_sh = (food3d_dir / "run_track2b.sh").read_text(encoding="utf-8")
        self.assertIn("bright_concave: bool = False", src)
        self.assertIn("--bright-concave", src)
        self.assertIn("compute_bright_concave_upper_color", src)
        self.assertIn("T2B_BRIGHT_CONCAVE=${T2B_BRIGHT_CONCAVE:-0}", run_sh)
        self.assertIn("--bright-concave", run_sh)
        demo_sh = (food3d_dir / "food3d_demo.sh").read_text(encoding="utf-8") + (food3d_dir / "t2b_v7_recipe.sh").read_text(encoding="utf-8")
        # Opt-in only: pizza held-out lit PSNR regresses with the flag on, so the demo
        # default must stay OFF while the flag is still exposed.
        self.assertIn("T2B_BRIGHT_CONCAVE=${T2B_BRIGHT_CONCAVE:-0}", demo_sh)
        self.assertNotIn("T2B_BRIGHT_CONCAVE=${T2B_BRIGHT_CONCAVE:-1}", demo_sh)


class TestV11WetOilGlossOffline(unittest.TestCase):
    def test_specular_gloss_scores_one_bright_view_high_and_flat_texels_zero(self):
        # Texel 0: three views at 0.10 (matte). Texel 1: two views at 0.10 and one at 0.55 (highlight).
        accum_lum = np.array([0.30, 0.75], dtype=np.float64)
        accum_lum2 = np.array([3 * 0.10**2, 2 * 0.10**2 + 0.55**2], dtype=np.float64)
        accum_max = np.array([0.10, 0.55], dtype=np.float64)
        views = np.array([3, 3], dtype=np.int32)
        gloss, rel_var, enough = t2b.accumulate_specular_gloss(
            accum_lum, accum_lum2, accum_max, views, min_views=3, gloss_scale=0.32
        )
        self.assertTrue(np.all(enough))
        self.assertAlmostEqual(float(gloss[0]), 0.0, places=6)
        self.assertGreater(float(gloss[1]), float(gloss[0]))
        self.assertGreater(float(rel_var[1]), float(rel_var[0]))

    def test_specular_gloss_respects_min_views_and_clips(self):
        accum_lum = np.array([0.0, 0.10, 1.20], dtype=np.float64)
        accum_lum2 = np.array([0.0, 0.01, 1.44], dtype=np.float64)
        accum_max = np.array([9.9, 0.10, 1.40], dtype=np.float64)
        views = np.array([0, 2, 3], dtype=np.int32)
        gloss, _rel_var, enough = t2b.accumulate_specular_gloss(
            accum_lum, accum_lum2, accum_max, views, min_views=3, gloss_scale=0.32
        )
        self.assertFalse(bool(enough[0]))
        self.assertEqual(float(gloss[0]), 0.0)  # never observed
        self.assertFalse(bool(enough[1]))
        self.assertEqual(float(gloss[1]), 0.0)  # below min_views even if bright
        self.assertAlmostEqual(float(gloss[2]), 1.0, places=6)  # clipped to [0, 1]
        self.assertTrue(np.all(gloss >= 0.0) and np.all(gloss <= 1.0))

    def test_v11_flag_is_opt_in_and_wired_through_scripts(self):
        food3d_dir = Path(__file__).resolve().parents[1] / "scripts" / "food3d"
        src = (food3d_dir / "track2b_mesh.py").read_text(encoding="utf-8")
        run_sh = (food3d_dir / "run_track2b.sh").read_text(encoding="utf-8")
        pbr = (food3d_dir / "pbr_author.py").read_text(encoding="utf-8")
        self.assertIn("def accumulate_specular_gloss", src)
        self.assertIn("--specular-gloss-out", src)
        self.assertIn("T2B_WET_FOOD=${T2B_WET_FOOD:-0}", run_sh)
        self.assertIn('--wet-food', run_sh)
        self.assertIn("--oil-albedo-removal", run_sh)
        self.assertIn("--wet-food", pbr)
        self.assertIn("def compute_wet_oil_mask", pbr)
        # Default stays OFF so the recorded v9 behaviour is preserved unless opted in.
        self.assertNotIn("T2B_WET_FOOD=${T2B_WET_FOOD:-1}", run_sh)


class TestV12SolidMeshCompletionOffline(unittest.TestCase):
    @staticmethod
    def _make_open_hemisphere(
        center_xz: tuple[float, float] = (0.0, 0.0),
        radius: float = 0.09,
        y_base: float = 0.0,
        flip_winding: bool = False,
        subdivisions: int = 3,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        import trimesh

        sphere = trimesh.creation.icosphere(subdivisions=subdivisions, radius=radius)
        v = np.asarray(sphere.vertices, dtype=np.float64).copy()
        f = np.asarray(sphere.faces, dtype=np.int64).copy()
        # Keep only upper dome (all vertices with y >= -0.005 * radius), clamped cleanly at y=y_base
        keep_f = np.all(v[f, 1] >= -0.05 * radius, axis=1)
        f_sub = f[keep_f]
        used, inv = np.unique(f_sub, return_inverse=True)
        v_sub = v[used].copy()
        f_sub = inv.reshape(-1, 3).astype(np.int64)
        v_sub[:, 0] += center_xz[0]
        v_sub[:, 2] += center_xz[1]
        v_sub[:, 1] = np.maximum(v_sub[:, 1], 0.0) + y_base
        if flip_winding:
            f_sub = f_sub[:, [0, 2, 1]]
        # Bright green/white topping near top; dark brown rim near bottom
        y_norm = np.clip((v_sub[:, 1] - y_base) / max(radius, 1e-6), 0.0, 1.0)
        colors = np.stack([0.25 + 0.65 * y_norm, 0.20 + 0.70 * y_norm, 0.15 + 0.45 * y_norm], axis=-1)
        return v_sub, f_sub, colors

    def test_open_hemisphere_becomes_watertight_solid_with_flat_base_and_rim_colored_underside(self):
        import trimesh

        v_in, f_in, c_in = self._make_open_hemisphere(radius=0.09, y_base=0.015, flip_winding=True)
        tm_in = trimesh.Trimesh(vertices=v_in, faces=f_in, process=False)
        self.assertFalse(tm_in.is_watertight)

        v_out, f_out, c_out, stats = t2b.complete_solid_mesh(
            v_in, f_in, c_in, up_axis_index=1, poisson_depth=7, keep_multi_components=False
        )
        self.assertTrue(stats["is_watertight"])
        self.assertTrue(stats["is_volume"])
        self.assertEqual(stats["boundary_edges"], 0)
        self.assertEqual(stats["non_manifold_edges"], 0)
        self.assertEqual(stats["shell_count"], 1)
        self.assertAlmostEqual(float(v_out[:, 1].min()), 0.0, places=5)
        self.assertGreater(float(v_out[:, 1].max()), 0.095)

        tm_out = trimesh.Trimesh(vertices=v_out, faces=f_out, process=False)
        self.assertTrue(tm_out.is_watertight)
        self.assertGreater(float(tm_out.volume), 0.0)

        # Top vertices/detail preserved near original dome apex
        top_mask = v_out[:, 1] > 0.09
        self.assertTrue(top_mask.any())
        # Downward base vertices must stay muted/dark from lower-rim perimeter, not bright top colors
        assert c_out is not None
        vn = np.asarray(tm_out.vertex_normals, dtype=np.float64)
        down_mask = vn[:, 1] < -0.75
        self.assertTrue(down_mask.any())
        self.assertLess(float(c_out[down_mask].mean()), 0.35)

        # Direct loft + hierarchical base cap keeps vertex degree bounded (no 7000-degree center star)
        deg = np.bincount(f_out.ravel(), minlength=len(v_out))
        self.assertLessEqual(int(deg.max()), 18)
        self.assertGreater(float(c_out[top_mask].mean()), float(c_out[down_mask].mean()) + 0.30)

    def test_disjoint_two_component_open_mesh_preserves_two_watertight_shells(self):
        import trimesh

        v1, f1, c1 = self._make_open_hemisphere(center_xz=(-0.06, 0.0), radius=0.045, y_base=0.01, subdivisions=2)
        v2, f2, c2 = self._make_open_hemisphere(center_xz=(0.06, 0.0), radius=0.045, y_base=0.01, subdivisions=2)
        verts = np.vstack([v1, v2])
        faces = np.vstack([f1, f2 + len(v1)])
        colors = np.vstack([c1, c2])

        v_out, f_out, c_out, stats = t2b.complete_solid_mesh(
            verts, faces, colors, up_axis_index=1, poisson_depth=7, keep_multi_components=True
        )
        self.assertEqual(stats["shell_count"], 2)
        self.assertTrue(stats["is_watertight"])
        self.assertTrue(stats["is_volume"])
        self.assertEqual(stats["boundary_edges"], 0)
        self.assertEqual(stats["non_manifold_edges"], 0)
        self.assertIsNotNone(c_out)

        tm_out = trimesh.Trimesh(vertices=v_out, faces=f_out, process=False)
        shells = tm_out.split(only_watertight=False)
        self.assertEqual(len(shells), 2)
        for sh in shells:
            self.assertTrue(sh.is_watertight)
            self.assertGreater(float(sh.volume), 0.0)

    def test_inpaint_unprojected_isolates_downward_base_from_bright_food_bleed(self):
        h, w = 32, 32
        valid = np.zeros((h, w), dtype=bool)
        valid[2:14, 2:14] = True  # top food island
        valid[16:28, 2:14] = True  # downward base island (adjacent across tiny gutter)
        good = np.zeros((h, w), dtype=bool)
        good[2:14, 2:14] = True  # only top food is photo-projected
        downward_base = np.zeros((h, w), dtype=bool)
        downward_base[16:28, 2:14] = True

        atlas = np.zeros((h, w, 3), dtype=np.float32)
        atlas[2:14, 2:14] = [0.45, 0.90, 0.25]  # bright green avocado on top
        atlas[16:28, 2:14] = [0.01, 0.01, 0.01]  # unprojected black base

        out, stats = t2b.inpaint_unprojected_texels(
            atlas,
            valid,
            good,
            smooth_iters=3,
            downward_base_mask=downward_base,
            downward_base_color=[0.12, 0.11, 0.10],
        )
        self.assertEqual(stats["downward_base_filled"], 144)
        np.testing.assert_allclose(out[22, 8], [0.12, 0.11, 0.10], atol=1e-5)
        np.testing.assert_allclose(out[8, 8], [0.45, 0.90, 0.25], atol=1e-5)

    def test_inpaint_unprojected_does_not_bleed_across_uv_gutters_to_isolated_wall_island(self):
        h, w = 32, 32
        valid = np.zeros((h, w), dtype=bool)
        valid[2:14, 2:14] = True   # food island (salsa red)
        valid[16:28, 2:14] = True  # isolated unprojected non-base lower-wall island
        good = np.zeros((h, w), dtype=bool)
        good[2:14, 2:14] = True

        atlas = np.zeros((h, w, 3), dtype=np.float32)
        atlas[2:14, 2:14] = [0.85, 0.15, 0.08]
        atlas[16:28, 2:14] = [0.14, 0.12, 0.10]  # baked charcoal bowl exterior fallback

        out, stats = t2b.inpaint_unprojected_texels(atlas, valid, good, smooth_iters=3)
        self.assertEqual(stats["inpainted_texels"], 0)
        np.testing.assert_allclose(out[22, 8], [0.14, 0.12, 0.10], atol=1e-5)
        np.testing.assert_allclose(out[8, 8], [0.85, 0.15, 0.08], atol=1e-5)

    def test_inpaint_unprojected_fills_isolated_side_wall_island_with_tone_fallback(self):
        h, w = 32, 32
        valid = np.zeros((h, w), dtype=bool)
        valid[2:14, 2:14] = True
        valid[16:28, 2:14] = True
        good = np.zeros((h, w), dtype=bool)
        good[2:14, 2:14] = True
        iso_wall = np.zeros((h, w), dtype=bool)
        iso_wall[16:28, 2:14] = True

        atlas = np.zeros((h, w, 3), dtype=np.float32)
        atlas[2:14, 2:14] = [0.85, 0.15, 0.08]
        atlas[16:28, 2:14] = [0.95, 0.45, 0.08]  # blotchy raw TSDF wall patch

        out, stats = t2b.inpaint_unprojected_texels(
            atlas,
            valid,
            good,
            smooth_iters=3,
            isolated_wall_mask=iso_wall,
            isolated_wall_color=[0.16, 0.15, 0.14],
        )
        self.assertEqual(stats["isolated_wall_filled"], 144)
        np.testing.assert_allclose(out[22, 8], [0.16, 0.15, 0.14], atol=1e-4)
        np.testing.assert_allclose(out[8, 8], [0.85, 0.15, 0.08], atol=1e-5)

    def test_complete_solid_mesh_rejects_orange_chroma_outliers_on_rim(self):
        v_in, f_in, c_in = self._make_open_hemisphere(radius=0.09, y_base=0.02, flip_winding=True)
        # Neutral charcoal rim for lower portion, with bright orange outlier patches on a few rim vertices
        low_mask = v_in[:, 1] <= 0.045
        c_in[low_mask] = [0.12, 0.11, 0.10]
        low_ids = np.flatnonzero(low_mask)
        c_in[low_ids[:4]] = [0.98, 0.48, 0.06]

        v_out, f_out, c_out, stats = t2b.complete_solid_mesh(
            v_in, f_in, c_in, up_axis_index=1, poisson_depth=7, keep_multi_components=False
        )
        self.assertTrue(stats["is_watertight"])
        assert c_out is not None
        synth_skirt = (v_out[:, 1] > 0.001) & (v_out[:, 1] < 0.018)
        self.assertTrue(synth_skirt.any())
        skirt_chroma = np.max(c_out[synth_skirt], axis=1) - np.min(c_out[synth_skirt], axis=1)
        self.assertLess(float(np.max(skirt_chroma)), 0.10)

    def test_solid_complete_and_keep_multi_default_off_and_wired_in_scripts(self):
        food3d_dir = Path(__file__).resolve().parents[1] / "scripts" / "food3d"
        src = (food3d_dir / "track2b_mesh.py").read_text(encoding="utf-8")
        run_sh = (food3d_dir / "run_track2b.sh").read_text(encoding="utf-8")
        colab_sh = (food3d_dir / "colab_track2b.sh").read_text(encoding="utf-8")

        self.assertIn("def complete_solid_mesh", src)
        self.assertIn("complete-mesh", src)
        self.assertIn("--solid-complete", src)
        self.assertIn("--keep-multi-components", src)

        self.assertIn("T2B_SOLID_COMPLETE=${T2B_SOLID_COMPLETE:-0}", run_sh)
        self.assertIn("T2B_KEEP_MULTI_COMPONENTS=${T2B_KEEP_MULTI_COMPONENTS:-0}", run_sh)
        self.assertNotIn("T2B_SOLID_COMPLETE=${T2B_SOLID_COMPLETE:-1}", run_sh)
        self.assertNotIn("T2B_KEEP_MULTI_COMPONENTS=${T2B_KEEP_MULTI_COMPONENTS:-1}", run_sh)
        self.assertIn("--solid-complete", run_sh)
        self.assertIn("--keep-multi-components", run_sh)
        self.assertIn('if [[ "$T2B_KEEP_MULTI_COMPONENTS" != "1" ]]; then', run_sh)

        self.assertIn("T2B_SOLID_COMPLETE=${T2B_SOLID_COMPLETE:-0}", colab_sh)
        self.assertIn("T2B_KEEP_MULTI_COMPONENTS=${T2B_KEEP_MULTI_COMPONENTS:-0}", colab_sh)
        self.assertNotIn("T2B_SOLID_COMPLETE=${T2B_SOLID_COMPLETE:-1}", colab_sh)
        self.assertNotIn("T2B_KEEP_MULTI_COMPONENTS=${T2B_KEEP_MULTI_COMPONENTS:-1}", colab_sh)
        self.assertIn("--solid-complete", colab_sh)
        self.assertIn("--keep-multi-components", colab_sh)

    def test_open_bowl_notched_rim_and_stray_fragments_stay_tight_single_welded_shell(self):
        import trimesh

        # Open hemisphere dipped slightly below y=0, with an eroded rim notch and a tiny stray bottom triangle
        v_in, f_in, c_in = self._make_open_hemisphere(radius=0.09, y_base=-0.004, flip_winding=True)
        # Drop faces inside one lower-rim wedge (x > 0.03, y < 0.032) to simulate an irregular eroded skirt gap
        fc = v_in[f_in].mean(axis=1)
        notch = (fc[:, 0] > 0.03) & (fc[:, 1] < 0.032)
        f_kept = f_in[~notch]
        # Add two tiny detached fragments near y=0 inside the footprint
        frag_v = np.array(
            [
                [0.01, 0.001, 0.01],
                [0.015, 0.001, 0.01],
                [0.012, 0.003, 0.015],
                [-0.02, 0.001, -0.02],
                [-0.015, 0.001, -0.02],
                [-0.017, 0.003, -0.015],
            ],
            dtype=np.float64,
        )
        frag_c = np.full((6, 3), 0.20, dtype=np.float64)
        frag_f = np.array([[0, 1, 2], [3, 4, 5]], dtype=np.int64) + len(v_in)
        v_all = np.vstack([v_in, frag_v])
        f_all = np.vstack([f_kept, frag_f])
        c_all = np.vstack([c_in, frag_c])

        r_in_max = float(np.hypot(v_in[:, 0], v_in[:, 2]).max())
        v_out, f_out, c_out, stats = t2b.complete_solid_mesh(
            v_all, f_all, c_all, up_axis_index=1, poisson_depth=7, keep_multi_components=False
        )
        self.assertEqual(stats["shell_count"], 1)
        self.assertTrue(stats["is_watertight"])
        self.assertTrue(stats["is_volume"])
        self.assertEqual(stats["boundary_edges"], 0)
        self.assertEqual(stats["non_manifold_edges"], 0)

        # Verify no outward skirt flare beyond 3% of original radius
        r_out_max = float(np.hypot(v_out[:, 0], v_out[:, 2]).max())
        self.assertLessEqual(r_out_max, r_in_max * 1.03)

        # Verify watertight + consistent winding + positive volume + single-shell holds on BOTH raw and vertex-welded copies
        for proc in (False, True):
            tm = trimesh.Trimesh(vertices=v_out, faces=f_out, process=proc)
            self.assertTrue(tm.is_watertight, msg=f"not watertight when process={proc}")
            self.assertTrue(tm.is_winding_consistent, msg=f"inconsistent winding when process={proc}")
            self.assertTrue(tm.is_volume, msg=f"not valid volume when process={proc}")
            self.assertGreater(float(tm.volume), 0.0)
            shells = tm.split(only_watertight=False)
            self.assertEqual(len(shells), 1, msg=f"expected 1 shell when process={proc}, got {len(shells)}")

        # Synthetic notched wall + underside stay dark/muted from rim, never bright top avocado/crema
        assert c_out is not None
        tm_raw = trimesh.Trimesh(vertices=v_out, faces=f_out, process=False)
        vn = np.asarray(tm_raw.vertex_normals, dtype=np.float64)
        down_mask = vn[:, 1] < -0.75
        self.assertTrue(down_mask.any())
        self.assertLess(float(c_out[down_mask].mean()), 0.35)

        # Direct loft + hierarchical base cap keeps vertex degree bounded (no 7000-degree center star)
        deg = np.bincount(f_out.ravel(), minlength=len(v_out))
        self.assertLessEqual(int(deg.max()), 18)

    def test_blender_bake_preserves_watertight_high_mesh_without_underside_crush(self):
        import shutil
        import subprocess

        blender_bin = os.environ.get("BLENDER_BIN") or (
            "/home/yacine105/tools/blender-4.5.17-linux-x64/blender"
            if Path("/home/yacine105/tools/blender-4.5.17-linux-x64/blender").exists()
            else shutil.which("blender")
        )
        if not blender_bin:
            self.skipTest("Blender binary not present for watertight high-mesh check")

        script_dir = Path(__file__).resolve().parents[1] / "scripts" / "food3d"
        expr = (
            f"import sys; sys.path.insert(0, {str(script_dir)!r}); "
            "import bmesh, bpy, blender_bake as bb; "
            "bpy.ops.wm.read_factory_settings(use_empty=True); "
            "bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=2, radius=0.12); "
            "me = bpy.data.meshes.new('hi'); bm.to_mesh(me); bm.free(); "
            "hi = bpy.data.objects.new('hi', me); bpy.context.collection.objects.link(hi); "
            "c_rep = bb.clean_shells(hi, main_object_only=True); "
            "assert c_rep['faces_before'] == c_rep['faces_after'], c_rep; "
            "ht = bb.measure_mesh_topology(hi.data); assert ht['is_watertight']; "
            "s_rep = bb.seat_and_scale_metric(hi, 24.0, flatten_underside=False); "
            "assert s_rep['flattened_underside_verts'] == 0, s_rep"
        )
        proc = subprocess.run([blender_bin, "-b", "--python-expr", expr], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, msg=f"Blender watertight preservation test failed:\n{proc.stdout}\n{proc.stderr}")

    def test_project_train_photos_skips_downward_base_texels_in_blend_and_best_view(self):
        import importlib.util
        import json
        import shutil
        import trimesh
        from PIL import Image

        if importlib.util.find_spec("open3d") is None:
            self.skipTest("open3d required for Open3D raycast projection test")

        # Build a watertight two-face-group box whose bottom & top/sides have disjoint UV islands
        v = np.array(
            [
                [-0.06, 0.0, -0.06],
                [0.06, 0.0, -0.06],
                [0.06, 0.0, 0.06],
                [-0.06, 0.0, 0.06],  # 0..3 bottom y=0
                [-0.06, 0.06, -0.06],
                [0.06, 0.06, -0.06],
                [0.06, 0.06, 0.06],
                [-0.06, 0.06, 0.06],  # 4..7 top y=0.06
            ],
            dtype=np.float32,
        )
        # Split vertices per face so UV islands and vertex normals stay completely clean and isolated
        quads = [
            ((0, 1, 2, 3), [0.05, 0.05, 0.45, 0.45]),  # bottom (-Y): outward normal points down (0,-1,0) -> (0,1,2,3) CW from top = CCW from bottom: (0,1,2), (0,2,3)
            ((4, 7, 6, 5), [0.55, 0.05, 0.95, 0.45]),  # top (+Y)
            ((3, 2, 6, 7), [0.05, 0.55, 0.45, 0.95]),  # front (+Z)
            ((1, 0, 4, 5), [0.55, 0.55, 0.95, 0.95]),  # back (-Z)
            ((2, 1, 5, 6), [0.55, 0.55, 0.95, 0.95]),  # right (+X)
            ((0, 3, 7, 4), [0.55, 0.55, 0.95, 0.95]),  # left (-X)
        ]
        sv, sf, suv = [], [], []
        for (a, b, c, d), (u0, v0, u1, v1) in quads:
            base = len(sv)
            sv.extend([v[a], v[b], v[c], v[d]])
            suv.extend([[u0, v0], [u1, v0], [u1, v1], [u0, v1]])
            sf.extend([[base, base + 1, base + 2], [base, base + 2, base + 3]])
        sv_arr = np.asarray(sv, dtype=np.float32)
        sf_arr = np.asarray(sf, dtype=np.int32)
        suv_arr = np.asarray(suv, dtype=np.float32)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            geom_glb = root / "geom.glb"
            mesh = trimesh.Trimesh(
                vertices=sv_arr,
                faces=sf_arr,
                visual=trimesh.visual.TextureVisuals(uv=suv_arr),
                process=False,
            )
            mesh.export(str(geom_glb))

            ds_dir = root / "dataset"
            (ds_dir / "images").mkdir(parents=True, exist_ok=True)
            (ds_dir / "masks").mkdir(parents=True, exist_ok=True)
            # Small 64x64 synthetic camera frames looking diagonally UP at the underside + front from below-front
            # Frame 1 & 2 look from y=-0.12, z=+0.22 toward origin -> bottom normal (0,-1,0) has cos_theta > 0.45!
            w_img, h_img = 64, 64
            photo = np.zeros((h_img, w_img, 3), dtype=np.uint8)
            photo[:, :] = [255, 0, 255]  # glaring magenta table/camera color
            mask = np.full((h_img, w_img), 255, dtype=np.uint8)
            frames = []
            for idx, x_off in enumerate((-0.02, 0.02)):
                img_rel = f"images/frame_{idx}.png"
                msk_rel = f"masks/frame_{idx}.png"
                Image.fromarray(photo, mode="RGB").save(ds_dir / img_rel)
                Image.fromarray(mask, mode="L").save(ds_dir / msk_rel)
                cam_pos = np.array([x_off, -0.12, 0.22], dtype=np.float64)
                fwd = np.array([0.0, 0.02, 0.0], dtype=np.float64) - cam_pos
                fwd /= np.linalg.norm(fwd)
                up_hint = np.array([0.0, 1.0, 0.0], dtype=np.float64)
                right = np.cross(fwd, up_hint)
                right /= np.linalg.norm(right)
                true_up = np.cross(right, fwd)
                # OpenGL camera: -Z looks forward, +Y up, +X right
                c2w = np.eye(4, dtype=np.float64)
                c2w[:3, 0] = right
                c2w[:3, 1] = true_up
                c2w[:3, 2] = -fwd
                c2w[:3, 3] = cam_pos
                frames.append(
                    {
                        "file_path": img_rel,
                        "mask_path": msk_rel,
                        "w": w_img,
                        "h": h_img,
                        "fl_x": 70.0,
                        "fl_y": 70.0,
                        "cx": w_img * 0.5,
                        "cy": h_img * 0.5,
                        "transform_matrix": c2w.tolist(),
                    }
                )
            (ds_dir / "transforms_train.json").write_text(json.dumps({"frames": frames}), encoding="utf-8")
            ply_header = (
                "ply\n"
                "format binary_little_endian 1.0\n"
                "element vertex 1\n"
                "property float x\n"
                "property float y\n"
                "property float z\n"
                "property uchar red\n"
                "property uchar green\n"
                "property uchar blue\n"
                "end_header\n"
            ).encode("ascii")
            ply_pt = np.zeros(1, dtype=[("xyz", "<f4", 3), ("rgb", "u1", 3)])
            (ds_dir / "points3d.ply").write_bytes(ply_header + ply_pt.tobytes())

            for mode in ("blend", "best_view"):
                maps_dir = root / f"maps_{mode}"
                maps_dir.mkdir(parents=True, exist_ok=True)
                base_init = np.full((64, 64, 3), [30, 28, 25], dtype=np.uint8)
                Image.fromarray(base_init, mode="RGB").save(maps_dir / "basecolor.png")

                t2b.project_train_photos_to_uv(
                    geom_glb,
                    maps_dir,
                    ds_dir,
                    np.eye(4, dtype=np.float64),
                    texture_mode=mode,
                    inpaint_unprojected=True,
                    bright_concave=False,
                    color_levelling=False,
                )
                baked = np.asarray(Image.open(maps_dir / "basecolor.png").convert("RGB"), dtype=np.float32) / 255.0
                # UV bottom island is u=[0.05..0.45], v_uv=[0.05..0.45] -> image y = 1 - v_uv in [0.55..0.95] -> rows 39..57, cols 6..25
                bottom_patch = baked[40:56, 8:24]
                # Must NEVER receive magenta [1.0, 0.0, 1.0] from camera! Should stay dark/neutral.
                self.assertLess(float(bottom_patch[..., 0].max()), 0.35, msg=f"{mode} projected table color onto bottom!")
                self.assertLess(float(bottom_patch[..., 2].max()), 0.35, msg=f"{mode} projected blue channel onto bottom!")
                # Front/side island u=[0.05..0.45], v_uv=[0.55..0.95] -> image y in [0.05..0.45] -> rows 6..25, cols 6..25 MUST receive magenta
                side_patch = baked[8:24, 8:24]
                self.assertGreater(float(side_patch[..., 0].mean()), 0.80, msg=f"{mode} failed to project side texels")

    def test_blender_bake_closed_mesh_decimation_repairs_topology(self):
        import shutil
        import subprocess

        blender_bin = os.environ.get("BLENDER_BIN") or (
            "/home/yacine105/tools/blender-4.5.17-linux-x64/blender"
            if Path("/home/yacine105/tools/blender-4.5.17-linux-x64/blender").exists()
            else shutil.which("blender")
        )
        if not blender_bin:
            self.skipTest("Blender binary not present for headless topology repair check")

        script_dir = Path(__file__).resolve().parents[1] / "scripts" / "food3d"
        expr = (
            f"import sys; sys.path.insert(0, {str(script_dir)!r}); "
            "import bmesh, bpy, blender_bake as bb; "
            "bpy.ops.wm.read_factory_settings(use_empty=True); "
            "bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=3, radius=0.1); "
            "me = bpy.data.meshes.new('hi'); bm.to_mesh(me); bm.free(); "
            "hi = bpy.data.objects.new('hi', me); bpy.context.collection.objects.link(hi); "
            "hi_topo = bb.measure_mesh_topology(hi.data); assert hi_topo['is_watertight']; "
            "low = bb.make_low(hi, target_faces=120, is_closed_high=True); "
            "low_topo = bb.measure_mesh_topology(low.data); "
            "assert low_topo['boundary_edges'] == 0, low_topo; "
            "assert low_topo['non_manifold_edges'] == 0, low_topo; "
            "assert low_topo['is_watertight'], low_topo; "
            "bm2 = bmesh.new(); bm2.from_mesh(low.data); "
            "bmesh.ops.delete(bm2, geom=[bm2.faces[0]], context='FACES'); "
            "bm2.to_mesh(low.data); bm2.free(); "
            "assert bb.measure_mesh_topology(low.data)['boundary_edges'] > 0; "
            "bm3 = bmesh.new(); bm3.from_mesh(low.data); bb._repair_closed_bmesh(bm3); "
            "bm3.to_mesh(low.data); bm3.free(); "
            "repaired = bb.measure_mesh_topology(low.data); "
            "assert repaired['boundary_edges'] == 0 and repaired['is_watertight'], repaired"
        )
        proc = subprocess.run([blender_bin, "-b", "--python-expr", expr], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, msg=f"Blender topology test failed:\n{proc.stdout}\n{proc.stderr}")


if __name__ == "__main__":
    unittest.main()
