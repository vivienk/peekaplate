"""Offline unit tests for Food3D video-to-dataset pure functions."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "food3d"))

import co3d_to_colmap
import cutout_clean
import track2b_mesh as t2b
import video_to_dataset as v2d


def _rotation_y(angle: float) -> np.ndarray:
    c, s = np.cos(angle), np.sin(angle)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]], dtype=np.float64)


class TestFrameSelectionAndSplit(unittest.TestCase):
    def test_select_sharpest_bucket_indices_picks_sharpest_per_uniform_bucket(self):
        # 12 frames split into 4 buckets of 3: [0..2], [3..5], [6..8], [9..11]
        scores = [10.0, 50.0, 20.0, 80.0, 15.0, 30.0, 5.0, 9.0, 42.0, 11.0, 99.0, 12.0]
        selected = v2d.select_sharpest_bucket_indices(scores, target_frames=4)
        self.assertEqual(selected, [1, 3, 8, 10])

        # target_frames >= len(scores) retains all indices in order
        all_selected = v2d.select_sharpest_bucket_indices(scores, target_frames=20)
        self.assertEqual(all_selected, list(range(len(scores))))

        with self.assertRaises(ValueError):
            v2d.select_sharpest_bucket_indices([1.0], target_frames=2)
        with self.assertRaises(ValueError):
            v2d.select_sharpest_bucket_indices(scores, target_frames=1)

    def test_freeze_eval_split_indices_deterministic_every_nth(self):
        self.assertEqual(v2d.freeze_eval_split_indices(16, eval_split_every=8), {0, 8})
        self.assertEqual(v2d.freeze_eval_split_indices(17, eval_split_every=8), {0, 8, 16})
        self.assertEqual(v2d.freeze_eval_split_indices(10, eval_split_every=0), set())
        with self.assertRaises(ValueError):
            v2d.freeze_eval_split_indices(1, eval_split_every=8)
        with self.assertRaises(ValueError):
            v2d.freeze_eval_split_indices(10, eval_split_every=-1)


class TestMaskFeatureRestriction(unittest.TestCase):
    def test_filter_keypoints_keeps_all_fg_and_caps_bg_by_distance(self):
        mask = np.zeros((100, 100), dtype=bool)
        mask[30:70, 30:70] = True

        # 10 fg keypoints + 40 bg keypoints (20 near, 20 far)
        rng = np.random.default_rng(7)
        fg_xy = np.column_stack([rng.uniform(35, 65, 10), rng.uniform(35, 65, 10)])
        near_bg_xy = np.column_stack([rng.uniform(75, 82, 20), rng.uniform(40, 60, 20)])
        far_bg_xy = np.column_stack([rng.uniform(0, 5, 20), rng.uniform(0, 5, 20)])
        xy = np.vstack([fg_xy, near_bg_xy, far_bg_xy]).astype(np.float32)
        kp = np.hstack([xy, np.ones((len(xy), 4), dtype=np.float32)])
        desc = np.arange(len(xy) * 4, dtype=np.uint8).reshape(len(xy), 4)

        kp_out, desc_out, stats = v2d.filter_keypoints_with_mask(
            kp, desc, mask, dilate_px=2, max_bg_fraction=0.35, min_bg_keep=5, max_bg_keep=6
        )
        self.assertEqual(stats["raw_fg"], 10)
        self.assertEqual(stats["kept_fg"], 10)
        self.assertEqual(stats["kept_bg"], 5)  # floor(10 * 0.35 / 0.65) == 5
        self.assertEqual(len(kp_out), 15)
        self.assertEqual(len(desc_out), 15)
        # All kept background points come from near_bg (indices 10..29), none from far_bg (30..49)
        kept_bg_x = kp_out[10:, 0]
        self.assertTrue(np.all(kept_bg_x >= 70.0))


class TestColmapToOpenGLCameraConversion(unittest.TestCase):
    def test_colmap_w2c_to_opengl_round_trip_and_projection_parity(self):
        rot_cv = _rotation_y(0.57) @ np.array(
            [[1.0, 0.0, 0.0], [0.0, 0.96, -0.28], [0.0, 0.28, 0.96]], dtype=np.float64
        )
        t_cv = np.array([0.35, -0.42, 3.8], dtype=np.float64)
        w2c_3x4 = np.hstack([rot_cv, t_cv[:, None]])
        intr = {"w": 1000, "h": 800, "fl_x": 920.0, "fl_y": 918.0, "cx": 495.0, "cy": 405.0}

        cam = v2d.colmap_w2c_to_opencv_and_opengl(
            w2c_3x4, intr, original_size=(1000, 800), output_size=(500, 400)
        )
        self.assertEqual((cam.intrinsics["w"], cam.intrinsics["h"]), (500, 400))
        self.assertAlmostEqual(cam.intrinsics["fl_x"], 460.0)
        self.assertAlmostEqual(cam.intrinsics["cx"], 247.5)

        # Round-trip OpenGL c2w back to COLMAP w2c
        w2c_round = v2d.opengl_c2w_to_colmap_w2c(cam.transform_matrix)
        np.testing.assert_allclose(w2c_round[:3, :4], w2c_3x4, atol=1e-12)
        np.testing.assert_allclose(t2b.opengl_c2w_to_opencv_w2c(cam.transform_matrix), w2c_round, atol=1e-12)

        # Verify 3D point projection parity between OpenCV and OpenGL camera conventions
        pts = np.array([[0.2, 0.3, -0.1], [-0.4, 0.1, 0.5], [0.0, -0.2, 0.2]], dtype=np.float64)
        uv_cv, depth_cv = cam.project(pts)
        self.assertTrue(np.all(depth_cv > 0))
        proj_gl = t2b.build_opengl_projection_matrix(
            cam.intrinsics["w"],
            cam.intrinsics["h"],
            cam.intrinsics["fl_x"],
            cam.intrinsics["fl_y"],
            cam.intrinsics["cx"],
            cam.intrinsics["cy"],
            near=0.05,
            far=50.0,
        )
        w2c_gl = np.linalg.inv(cam.transform_matrix)
        pts_h = np.concatenate([pts, np.ones((len(pts), 1))], axis=1)
        clip = (pts_h @ w2c_gl.T) @ proj_gl.T
        ndc = clip[:, :2] / clip[:, 3:4]
        u_gl = (ndc[:, 0] + 1.0) * 0.5 * cam.intrinsics["w"]
        v_gl = (1.0 - ndc[:, 1]) * 0.5 * cam.intrinsics["h"]
        np.testing.assert_allclose(np.stack([u_gl, v_gl], axis=-1), uv_cv, atol=1e-9)


class TestTransformsAndHullWriting(unittest.TestCase):
    def test_write_dataset_outputs_train_only_hull_and_strict_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for sub in ("images", "eval_masks"):
                (root / sub).mkdir(parents=True)

            w, h = 96, 64
            intr = {"w": w, "h": h, "fl_x": 80.0, "fl_y": 80.0, "cx": 48.0, "cy": 32.0}
            y, x = np.ogrid[:h, :w]
            train_mask = ((x - w // 2) ** 2 + (y - h // 2) ** 2) <= 14**2

            def _build_views(indices: list[int], mask_arr: np.ndarray, color: tuple[int, int, int]):
                views, frames = [], []
                for i in indices:
                    angle = i * (2.0 * np.pi / 10.0)
                    rot = _rotation_y(angle)
                    # Place camera at radius 4 looking at origin
                    t_cv = np.array([0.0, 0.0, 4.0], dtype=np.float64)
                    w2c = np.hstack([rot, t_cv[:, None]])
                    cam = v2d.colmap_w2c_to_opencv_and_opengl(w2c, intr)
                    fname = f"frame_{i + 1:06d}.png"
                    rgb = np.full((h, w, 3), color, dtype=np.uint8)
                    alpha = mask_arr.astype(np.uint8) * 255
                    rgba, clean_a = v2d.resize_rgba_premultiplied(rgb, alpha, (w, h))
                    Image.fromarray(rgba, mode="RGBA").save(root / "images" / fname)
                    Image.fromarray(clean_a, mode="L").save(root / "eval_masks" / fname)
                    yy, xx = np.nonzero(mask_arr)
                    views.append(
                        co3d_to_colmap.View(
                            camera=cam,
                            mask=mask_arr,
                            centroid=np.array([float(xx.mean()), float(yy.mean())]),
                            radius_px=float(np.sqrt(xx.size / np.pi)),
                            image_path=root / "images" / fname,
                        )
                    )
                    frames.append(
                        {
                            "file_path": f"images/{fname}",
                            "eval_mask_path": f"eval_masks/{fname}",
                            "frame_number": i + 1,
                            **cam.intrinsics,
                            "transform_matrix": cam.transform_matrix.tolist(),
                        }
                    )
                return views, frames

            eval_set = v2d.freeze_eval_split_indices(10, eval_split_every=5)  # {0, 5}
            train_idx = [i for i in range(10) if i not in eval_set]
            eval_idx = sorted(eval_set)

            t_views, t_frames = _build_views(train_idx, train_mask, (180, 120, 70))
            # Give eval views an off-center mask to verify eval never enters points3d.ply
            eval_mask = np.zeros_like(train_mask)
            eval_mask[2:18, 2:18] = True
            e_views, e_frames = _build_views(eval_idx, eval_mask, (10, 240, 40))

            report = v2d.write_dataset_outputs(
                root,
                t_views,
                e_views,
                t_frames,
                e_frames,
                {"registered_frames": 10, "mean_reprojection_error_px": 0.42},
                voxel_res=24,
                max_points=500,
                eval_split_every=5,
            )
            self.assertFalse(report["publication_eligible"])
            self.assertEqual(report["train_frames"], 8)
            self.assertEqual(report["eval_frames"], 2)
            self.assertGreaterEqual(report["train_mean_mask_hit_rate"], 0.85)
            self.assertLess(report["mean_mask_hit_rate"], report["train_mean_mask_hit_rate"])

            tr_json = json.loads((root / "transforms_train.json").read_text(encoding="utf-8"))
            va_json = json.loads((root / "transforms_val.json").read_text(encoding="utf-8"))
            self.assertFalse(tr_json["publication_eligible"])
            self.assertFalse(va_json["publication_eligible"])
            self.assertEqual(tr_json["camera_model"], "OPENCV")
            self.assertEqual(tr_json["ply_file_path"], "points3d.ply")
            self.assertNotIn("ply_file_path", va_json)
            self.assertEqual(len(tr_json["frames"]), 8)
            self.assertEqual(len(va_json["frames"]), 2)
            self.assertTrue((root / "points3d.ply").is_file())
            self.assertFalse((root / "transforms.json").exists())


class TestInframeCutoutAndPremultipliedResize(unittest.TestCase):
    def test_clean_inframe_rgba_preserves_dimensions_and_strips_offcenter_clutter(self):
        h, w = 80, 120
        rgb = np.full((h, w, 3), 210, dtype=np.uint8)
        # Main centered dish
        rgb[25:55, 45:75] = (190, 95, 40)
        alpha = np.zeros((h, w), dtype=np.float32)
        alpha[25:55, 45:75] = 0.99
        # Small corner clutter
        alpha[2:10, 2:10] = 0.95

        rgba, stats = cutout_clean.clean_inframe_rgba(rgb, alpha, keep_main_dish=True, strip_shadows=True)
        self.assertEqual(rgba.shape, (h, w, 4))
        self.assertEqual(stats["output_size"], [w, h])
        self.assertEqual(stats["components_dropped"], 1)
        # Corner clutter removed and RGB zeroed where transparent
        self.assertEqual(rgba[5, 5, 3], 0)
        self.assertEqual(tuple(rgba[5, 5, :3]), (0, 0, 0))
        # Center dish retained
        self.assertGreater(rgba[40, 60, 3], 240)

    def test_target_xy_selects_consistent_dish_over_larger_foreground_clutter(self):
        h, w = 120, 80
        rgb = np.full((h, w, 3), 180, dtype=np.uint8)
        alpha = np.zeros((h, w), dtype=np.float32)
        # Small dish at upper half (y=20..40, x=25..45) -> area 400
        alpha[20:40, 25:45] = 0.99
        # Much larger table clutter at bottom half (y=70..115, x=5..75) -> area 3150
        alpha[70:115, 5:75] = 0.99

        rgba, stats = cutout_clean.clean_inframe_rgba(
            rgb, alpha, keep_main_dish=True, strip_shadows=False, target_xy=(35.0, 30.0)
        )
        self.assertEqual(stats["components_dropped"], 1)
        self.assertGreater(rgba[30, 35, 3], 240)
        self.assertEqual(rgba[90, 40, 3], 0)

    def test_estimate_consensus_3d_center_ignores_secondary_large_clutter(self):
        intr = {"w": 120, "h": 120, "fl_x": 110.0, "fl_y": 110.0, "cx": 60.0, "cy": 60.0}
        true_center = np.array([0.2, -0.1, 0.3], dtype=np.float64)
        clutter_world = np.array([-0.9, 1.1, -0.5], dtype=np.float64)
        cams_and_masks = []
        y, x = np.ogrid[:120, :120]
        for k in range(12):
            ang = k * (2.0 * np.pi / 12.0)
            pos = true_center + np.array([3.5 * np.cos(ang), 1.5, 3.5 * np.sin(ang)])
            fwd = true_center - pos
            fwd /= np.linalg.norm(fwd)
            right = np.cross(fwd, np.array([0.0, 1.0, 0.0]))
            right /= np.linalg.norm(right)
            cam_down = np.cross(fwd, right)
            rot_cv = np.vstack([right, cam_down, fwd])
            t_cv = -rot_cv @ pos
            cam = v2d.colmap_w2c_to_opencv_and_opengl(np.hstack([rot_cv, t_cv[:, None]]), intr)
            uv_dish, _ = cam.project(true_center[None, :])
            mask = ((x - uv_dish[0, 0]) ** 2 + (y - uv_dish[0, 1]) ** 2) <= 10**2
            # Add huge secondary clutter on 4 of 12 views (33% outlier frames)
            if k in (2, 3, 4, 5):
                uv_clut, depth_clut = cam.project(clutter_world[None, :])
                if depth_clut[0] > 0:
                    mask |= ((x - uv_clut[0, 0]) ** 2 + (y - uv_clut[0, 1]) ** 2) <= 24**2
            cams_and_masks.append((cam, mask))

        est = v2d.estimate_consensus_3d_center(cams_and_masks)
        self.assertLess(float(np.linalg.norm(est - true_center)), 0.05)

    def test_resize_rgba_premultiplied_prevents_black_bleed(self):
        rgb = np.full((40, 60, 3), (0, 0, 255), dtype=np.uint8)
        alpha = np.zeros((40, 60), dtype=np.uint8)
        rgb[10:30, 15:45] = (255, 0, 0)
        alpha[10:30, 15:45] = 255
        rgba, clean_a = v2d.resize_rgba_premultiplied(rgb, alpha, (30, 20))
        self.assertEqual(rgba.shape, (20, 30, 4))
        fg = clean_a > 0
        self.assertTrue(np.any(fg))
        self.assertTrue(np.all(rgba[fg, 2] == 0))
        self.assertTrue(np.all(rgba[fg, 0] == 255))


class TestOrbitCoverageAndRanking(unittest.TestCase):
    def test_compute_orbit_coverage_full_circle_gapped_arc_and_degenerate(self):
        # Full 360-degree tilted circle (36 cameras, 10 deg spacing)
        angles = np.linspace(0.0, 2.0 * np.pi, 36, endpoint=False)
        flat = np.column_stack([2.0 * np.cos(angles), 2.0 * np.sin(angles), np.zeros_like(angles)])
        tilted = flat @ _rotation_y(0.45).T + np.array([1.2, -0.5, 0.8])
        full_cov = v2d.compute_orbit_coverage(tilted)
        self.assertAlmostEqual(full_cov["max_azimuth_gap_deg"], 10.0, places=2)
        self.assertAlmostEqual(full_cov["orbit_span_deg"], 350.0, places=2)
        self.assertAlmostEqual(full_cov["radius_ratio"], 1.0, places=3)
        self.assertAlmostEqual(full_cov["radius_p95_p05_ratio"], 1.0, places=3)

        # Gapped 180-degree arc (centroid shifts inward, yielding ~118-deg azimuth gap > 100 deg)
        arc_angles = np.linspace(0.0, np.pi, 19)
        arc = np.column_stack([2.0 * np.cos(arc_angles), 2.0 * np.sin(arc_angles), np.zeros_like(arc_angles)])
        arc_cov = v2d.compute_orbit_coverage(arc)
        self.assertGreater(arc_cov["max_azimuth_gap_deg"], 100.0)
        self.assertLess(arc_cov["orbit_span_deg"], 260.0)

        # Degenerate (< 2 cameras)
        for empty_or_one in (np.zeros((0, 3), dtype=np.float64), np.array([[1.0, 2.0, 3.0]], dtype=np.float64)):
            deg_cov = v2d.compute_orbit_coverage(empty_or_one)
            self.assertEqual(deg_cov["orbit_span_deg"], 0.0)
            self.assertEqual(deg_cov["max_azimuth_gap_deg"], 360.0)

    def test_rank_sfm_candidate_pass_prefers_smooth_360_orbit(self):
        smooth_360 = {
            "registered_frames": 76,
            "mean_reprojection_error_px": 0.65,
            "orbit_coverage": {
                "orbit_span_deg": 345.0,
                "max_azimuth_gap_deg": 15.0,
                "radius_ratio": 1.2,
                "radius_p95_p05_ratio": 1.15,
            },
        }
        broken_radius = {
            "registered_frames": 80,
            "mean_reprojection_error_px": 0.55,
            "orbit_coverage": {
                "orbit_span_deg": 345.0,
                "max_azimuth_gap_deg": 15.0,
                "radius_ratio": 3.5,
                "radius_p95_p05_ratio": 2.8,
            },
        }
        large_gap = {
            "registered_frames": 80,
            "mean_reprojection_error_px": 0.55,
            "orbit_coverage": {
                "orbit_span_deg": 240.0,
                "max_azimuth_gap_deg": 120.0,
                "radius_ratio": 1.2,
                "radius_p95_p05_ratio": 1.15,
            },
        }
        better_reproj = {
            "registered_frames": 76,
            "mean_reprojection_error_px": 0.35,
            "orbit_coverage": dict(smooth_360["orbit_coverage"]),
        }
        failed = {"registered_frames": 1, "mean_reprojection_error_px": None, "orbit_coverage": {}}

        s_smooth = v2d.rank_sfm_candidate_pass(smooth_360, total_frames=80)
        s_broken = v2d.rank_sfm_candidate_pass(broken_radius, total_frames=80)
        s_gap = v2d.rank_sfm_candidate_pass(large_gap, total_frames=80)
        s_reproj = v2d.rank_sfm_candidate_pass(better_reproj, total_frames=80)
        s_fail = v2d.rank_sfm_candidate_pass(failed, total_frames=80)

        self.assertGreater(s_smooth, s_broken)
        self.assertGreater(s_smooth, s_gap)
        self.assertGreater(s_reproj, s_smooth)
        self.assertLess(s_fail, -1e8)

        # Two broken-radius candidates: 51/80 submodel must beat collapsed 20/80 fragment
        larger_submodel = {
            "registered_frames": 51,
            "mean_reprojection_error_px": 0.67,
            "orbit_coverage": {"orbit_span_deg": 210.0, "max_azimuth_gap_deg": 150.0, "radius_ratio": 9.1},
        }
        tiny_fragment = {
            "registered_frames": 20,
            "mean_reprojection_error_px": 0.49,
            "orbit_coverage": {"orbit_span_deg": 214.6, "max_azimuth_gap_deg": 145.4, "radius_ratio": 5.95},
        }
        self.assertGreater(
            v2d.rank_sfm_candidate_pass(larger_submodel, total_frames=80),
            v2d.rank_sfm_candidate_pass(tiny_fragment, total_frames=80),
        )

    def test_needs_sfm_fallback_skips_when_all_frames_registered(self):
        full_reg = {
            "registered_frames": 80,
            "orbit_coverage": {"max_azimuth_gap_deg": 103.0, "radius_ratio": 4.5},
        }
        self.assertFalse(v2d._needs_sfm_fallback(full_reg, target_min_reg=60, total_frames=80))
        partial_reg = {
            "registered_frames": 51,
            "orbit_coverage": {"max_azimuth_gap_deg": 155.0, "radius_ratio": 9.1},
        }
        self.assertTrue(v2d._needs_sfm_fallback(partial_reg, target_min_reg=60, total_frames=80))


class TestCliFlagsAndCutoutForwarding(unittest.TestCase):
    def test_cli_flags_parse_and_forward_to_clean_inframe_rgba(self):
        parser = v2d.build_arg_parser()
        default_args = parser.parse_args(["in.mp4", "out_dir"])
        self.assertTrue(default_args.keep_main_dish)
        self.assertTrue(default_args.strip_shadows)
        self.assertEqual(default_args.camera_model, "PINHOLE")

        custom_args = parser.parse_args(
            [
                "in.mp4",
                "out_dir",
                "--no-strip-shadows",
                "--no-keep-main-dish",
                "--camera-model",
                "SIMPLE_RADIAL",
            ]
        )
        self.assertFalse(custom_args.keep_main_dish)
        self.assertFalse(custom_args.strip_shadows)
        self.assertEqual(custom_args.camera_model, "SIMPLE_RADIAL")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video_path = root / "dish.mp4"
            video_path.write_bytes(b"fake")
            out_dir = root / "dataset"

            w, h = 96, 64
            intr = {"w": w, "h": h, "fl_x": 80.0, "fl_y": 80.0, "cx": 48.0, "cy": 32.0}
            y, x = np.ogrid[:h, :w]
            fg = ((x - w // 2) ** 2 + (y - h // 2) ** 2) <= 14**2

            def _fake_extract(_video, raw_dir):
                paths = []
                for i in range(10):
                    p = Path(raw_dir) / f"frame_{i + 1:06d}.png"
                    arr = np.full((h, w, 3), 120 + i, dtype=np.uint8)
                    Image.fromarray(arr, mode="RGB").save(p)
                    paths.append(p)
                return paths

            def _fake_infer(_rgb_work, _sess, _in_name, _out_name):
                alpha = np.zeros((h, w), dtype=np.float32)
                alpha[fg] = 0.99
                return alpha

            def _fake_sfm(_rgb_dir, image_names, _masks, _sfm_dir, **kwargs):
                self.assertEqual(kwargs["camera_model"], "SIMPLE_RADIAL")
                poses = {}
                centers = []
                for idx, name in enumerate(image_names):
                    ang = idx * (2.0 * np.pi / len(image_names))
                    rot = _rotation_y(ang)
                    t_cv = np.array([0.0, 0.0, 4.0], dtype=np.float64)
                    w2c = np.hstack([rot, t_cv[:, None]])
                    poses[name] = (w2c, dict(intr))
                    centers.append(-rot.T @ t_cv)
                cov = v2d.compute_orbit_coverage(np.stack(centers, axis=0))
                return {
                    "poses_by_name": poses,
                    "registered_frames": len(image_names),
                    "total_input_frames": len(image_names),
                    "registration_rate": 1.0,
                    "mean_reprojection_error_px": 0.35,
                    "num_colmap_points3d": 120,
                    "selected_pass": "fg_guided",
                    "selected_camera_model": "SIMPLE_RADIAL",
                    "orbit_coverage": cov,
                    "sfm_submodels": [
                        {
                            "id": 0,
                            "registered_frames": len(image_names),
                            "first_frame": image_names[0],
                            "last_frame": image_names[-1],
                            "mean_reprojection_error_px": 0.35,
                        }
                    ],
                    "feature_stats": {"raw_total": 100, "raw_fg": 80, "raw_bg": 20, "kept_fg": 80, "kept_bg": 20},
                    "passes_tried": [],
                    "extract_seconds": 0.1,
                    "match_seconds": 0.1,
                    "map_seconds": 0.1,
                    "scale_summary": {},
                }

            observed_cutout_kwargs: list[dict[str, object]] = []
            orig_clean = cutout_clean.clean_inframe_rgba

            def _spy_clean(rgb_arr, raw_alpha, **kwargs):
                observed_cutout_kwargs.append(dict(kwargs))
                return orig_clean(rgb_arr, raw_alpha, **kwargs)

            with (
                mock.patch.object(v2d.multiview_prep, "_extract_video_frames", side_effect=_fake_extract),
                mock.patch.object(v2d.multiview_prep, "_score_frame_sharpness", return_value=10.0),
                mock.patch.object(v2d.cutout_clean, "create_onnx_session", return_value=(None, "in", "out")),
                mock.patch.object(v2d.cutout_clean, "infer_raw_alpha_with_session", side_effect=_fake_infer),
                mock.patch.object(v2d.cutout_clean, "clean_inframe_rgba", side_effect=_spy_clean),
                mock.patch.object(v2d, "_run_pycolmap_sfm", side_effect=_fake_sfm),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                rc = v2d.main(
                    [
                        str(video_path),
                        str(out_dir),
                        "--target-frames",
                        "10",
                        "--eval-split-every",
                        "5",
                        "--voxel-res",
                        "24",
                        "--max-points",
                        "500",
                        "--no-strip-shadows",
                        "--no-keep-main-dish",
                        "--camera-model",
                        "SIMPLE_RADIAL",
                    ]
                )

            self.assertEqual(rc, 0)
            self.assertEqual(len(observed_cutout_kwargs), 10)
            self.assertTrue(all(kw["keep_main_dish"] is False for kw in observed_cutout_kwargs))
            self.assertTrue(all(kw["strip_shadows"] is False for kw in observed_cutout_kwargs))
            report = json.loads((out_dir / "conversion_report.json").read_text(encoding="utf-8"))
            self.assertFalse(report["publication_eligible"])
            self.assertFalse(report["keep_main_dish"])
            self.assertFalse(report["strip_shadows"])
            self.assertEqual(report["camera_model_colmap"], "SIMPLE_RADIAL")
            self.assertIn("orbit_coverage", report)
            self.assertEqual(len(report["sfm_submodels"]), 1)

    def test_video_to_dataset_falls_back_to_cpu_if_gpu_cutout_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video_path = root / "orbit.mp4"
            video_path.write_bytes(b"fake")
            out_dir = root / "ds"
            rgb = np.full((32, 32, 3), 180, dtype=np.uint8)

            def _fake_extract(_video: Path, scratch: Path) -> list[Path]:
                paths = []
                for idx in range(3):
                    p = scratch / f"frame_{idx:06d}.png"
                    Image.fromarray(rgb, mode="RGB").save(p)
                    paths.append(p)
                return paths

            def _fake_sfm(rgb_dir: Path, image_names, _masks, _sfm_dir, **_kwargs):
                intr = {"w": 32, "h": 32, "fl_x": 32.0, "fl_y": 32.0, "cx": 16.0, "cy": 16.0}
                poses = {}
                for idx, name in enumerate(image_names):
                    rot = _rotation_y(idx * (2.0 * np.pi / len(image_names)))
                    w2c = np.hstack([rot, np.array([[0.0], [0.0], [4.0]])])
                    poses[name] = (w2c, dict(intr))
                return {
                    "selected_camera_model": "PINHOLE",
                    "selected_pass": "fg_guided",
                    "registered_frames": len(image_names),
                    "total_input_frames": len(image_names),
                    "registration_rate": 1.0,
                    "mean_reprojection_error_px": 0.4,
                    "num_colmap_points3d": 50,
                    "poses_by_name": poses,
                    "orbit_coverage": {"orbit_span_deg": 300.0},
                    "sfm_submodels": [],
                    "feature_stats": {},
                    "passes_tried": [],
                    "extract_seconds": 0.1,
                    "match_seconds": 0.1,
                    "map_seconds": 0.1,
                    "scale_summary": {},
                }

            session_calls: list[bool] = []

            def _fake_create_sess(*_args, prefer_gpu: bool = False, **_kwargs):
                session_calls.append(prefer_gpu)
                return ("gpu_sess" if prefer_gpu else "cpu_sess", "in", "out")

            def _fake_infer(_img, session, *_args):
                if session == "gpu_sess":
                    raise RuntimeError("CUDA out of memory")
                alpha = np.zeros((32, 32), dtype=np.float32)
                alpha[4:28, 4:28] = 1.0
                return alpha

            import os

            with (
                mock.patch.dict(os.environ, {}, clear=False),
                mock.patch.object(v2d.multiview_prep, "_extract_video_frames", side_effect=_fake_extract),
                mock.patch.object(v2d.multiview_prep, "_score_frame_sharpness", return_value=10.0),
                mock.patch.object(v2d.cutout_clean, "create_onnx_session", side_effect=_fake_create_sess),
                mock.patch.object(v2d.cutout_clean, "infer_raw_alpha_with_session", side_effect=_fake_infer),
                mock.patch.object(v2d, "_run_pycolmap_sfm", side_effect=_fake_sfm),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                os.environ.pop("CUDA_VISIBLE_DEVICES", None)
                report = v2d.video_to_dataset(
                    video_path, out_dir, target_frames=3, eval_split_every=0, voxel_res=16, max_points=100
                )

            self.assertEqual(session_calls, [True, False])
            self.assertEqual(report["registered_frames"], 3)


if __name__ == "__main__":
    unittest.main()
