"""Unit tests for Food3D V1 Stage 0-1 (Input QA, Cutout Cleanup, Multi-view Prep).

Runs completely offline with no GPU and no ONNX weights required.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts" / "food3d"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import cutout_clean  # noqa: E402
import input_qa  # noqa: E402
import multiview_prep  # noqa: E402


def _make_textured_rgb(h: int, w: int, base_rgb: tuple[int, int, int] = (200, 140, 80)) -> np.ndarray:
    """Create a deterministic textured RGB image with sharp detail (passes sharpness QA)."""
    yy, xx = np.mgrid[0:h, 0:w]
    checker = (((yy // 4) + (xx // 4)) % 2).astype(np.int32) * 24 - 12
    rgb = np.zeros((h, w, 3), dtype=np.int32)
    for c in range(3):
        rgb[..., c] = np.clip(base_rgb[c] + checker, 0, 255)
    return rgb.astype(np.uint8)


def _circle_mask(h: int, w: int, cy: float, cx: float, radius: float) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    return ((yy - cy) ** 2 + (xx - cx) ** 2) <= (radius ** 2)


class TestFood3DInputQAAndCutout(unittest.TestCase):
    def test_border_clipping_unpadded_and_prepadded_vs_clean_circle(self) -> None:
        h, w = 512, 512
        rgb = _make_textured_rgb(h, w)

        # 1) Clean circular bowl centered with generous padding -> NOT clipped
        clean_alpha = _circle_mask(h, w, 256, 256, 150).astype(np.float32)
        clean_report = input_qa.analyze_arrays(rgb, clean_alpha)
        self.assertFalse(clean_report["publication_eligible"])
        self.assertFalse(clean_report["metrics"]["border_clipped"])
        self.assertEqual(clean_report["metrics"]["clipped_sides"], [])
        self.assertNotEqual(clean_report["triage"], "needs_reshoot_clipped")

        # 2) Unpadded border clip: bowl extends to left edge of image
        unpadded_alpha = _circle_mask(h, w, 256, 90, 150).astype(np.float32)
        unpadded_report = input_qa.analyze_arrays(rgb, unpadded_alpha)
        self.assertTrue(unpadded_report["metrics"]["border_clipped"])
        self.assertIn("left", unpadded_report["metrics"]["clipped_sides"])
        self.assertIn("border_clipped", unpadded_report["issues"])
        self.assertEqual(unpadded_report["triage"], "needs_reshoot_clipped")

        # 3) Pre-padded cutout where bowl was sliced vertically on left & right at photo time
        #    and then centered with wide transparent margins (does NOT touch image borders).
        prepadded_mask = _circle_mask(h, w, 256, 256, 170)
        prepadded_mask[:, :130] = False  # vertical slice on left
        prepadded_mask[:, 382:] = False  # vertical slice on right
        prepadded_alpha = prepadded_mask.astype(np.float32)

        prepadded_report = input_qa.analyze_arrays(rgb, prepadded_alpha)
        self.assertFalse(prepadded_report["publication_eligible"])
        self.assertEqual(prepadded_report["metrics"]["raw_border_touches"]["left"], 0.0)
        self.assertEqual(prepadded_report["metrics"]["raw_border_touches"]["right"], 0.0)
        self.assertTrue(prepadded_report["metrics"]["border_clipped"])
        self.assertIn("left", prepadded_report["metrics"]["clipped_sides"])
        self.assertIn("right", prepadded_report["metrics"]["clipped_sides"])
        self.assertEqual(prepadded_report["triage"], "needs_reshoot_clipped")

    def test_clutter_detector_flags_secondary_object(self) -> None:
        h, w = 512, 512
        rgb = _make_textured_rgb(h, w)

        main_plate = _circle_mask(h, w, 280, 260, 130)
        # Secondary detached prop in upper-left with area >= 15% of main plate
        # (r=58 -> 58^2 / 130^2 ≈ 0.199 >= 0.15)
        dessert_stand = _circle_mask(h, w, 90, 90, 58)
        alpha = (main_plate | dessert_stand).astype(np.float32)

        report = input_qa.analyze_arrays(rgb, alpha)
        self.assertFalse(report["publication_eligible"])
        self.assertTrue(report["metrics"]["clutter_detected"])
        self.assertGreaterEqual(report["metrics"]["largest_secondary_ratio"], 0.15)
        self.assertIn("clutter_detected", report["issues"])
        self.assertEqual(report["triage"], "needs_clean_cutout")

    def test_shadow_stripping_removes_halo_preserves_dark_bowl(self) -> None:
        h, w = 512, 512
        # Dark ceramic bowl (solid raw_alpha = 0.95) surrounded by a low-alpha cast shadow halo
        yy, xx = np.mgrid[0:h, 0:w]
        dist = np.hypot(yy - 256.0, xx - 256.0)
        bowl_mask = dist <= 120.0
        halo_mask = (dist > 120.0) & (dist <= 136.0)

        rgb = np.full((h, w, 3), 210, dtype=np.uint8)  # light table background
        rgb[bowl_mask] = np.array([34, 36, 40], dtype=np.uint8)  # dark ceramic bowl
        rgb[halo_mask] = np.array([62, 62, 65], dtype=np.uint8)  # neutral cast shadow

        raw_alpha = np.zeros((h, w), dtype=np.float32)
        raw_alpha[bowl_mask] = 0.95
        raw_alpha[halo_mask] = 0.45

        # QA should detect shadow contamination on the raw cutout
        qa_before = input_qa.analyze_arrays(rgb, raw_alpha)
        self.assertTrue(qa_before["metrics"]["shadow_contamination"])

        # Clean cutout with strip_shadows=True
        rgba_clean, stats = cutout_clean.postprocess_mask(
            rgb,
            raw_alpha,
            keep_main_dish=True,
            strip_shadows=True,
            pad_ratio=0.10,
            target_size=512,
        )
        self.assertGreater(stats["shadow_pixels_stripped"], int(np.sum(halo_mask) * 0.8))

        # Tight bbox before padding should match the dark bowl diameter (~241 px), not bowl+halo (~273 px)
        bbox = stats["bbox_before_pad"]
        self.assertLessEqual(bbox["width"], 245)
        self.assertGreaterEqual(bbox["width"], 235)
        self.assertLessEqual(bbox["height"], 245)
        self.assertGreaterEqual(bbox["height"], 235)
        self.assertEqual(rgba_clean.shape[0], rgba_clean.shape[1])

    def test_edge_color_decontamination(self) -> None:
        h, w = 256, 256
        yy, xx = np.mgrid[0:h, 0:w]
        dist = np.hypot(yy - 128.0, xx - 128.0)
        solid_mask = dist <= 70.0
        edge_mask = (dist > 70.0) & (dist <= 75.0)

        rgb = np.zeros((h, w, 3), dtype=np.uint8)
        rgb[solid_mask] = np.array([220, 80, 40], dtype=np.uint8)  # bright warm dish
        rgb[edge_mask] = np.array([10, 10, 10], dtype=np.uint8)  # dark contaminated fringe

        raw_alpha = np.zeros((h, w), dtype=np.float32)
        raw_alpha[solid_mask] = 1.0
        raw_alpha[edge_mask] = 0.5

        rgba_out, _ = cutout_clean.postprocess_mask(
            rgb,
            raw_alpha,
            keep_main_dish=True,
            strip_shadows=False,
            pad_ratio=0.10,
            target_size=256,
        )

        # Semi-transparent edge pixels should inherit bright warm RGB, not dark (10,10,10)
        semi = (rgba_out[..., 3] > 20) & (rgba_out[..., 3] < 240)
        self.assertTrue(np.any(semi))
        mean_r = float(np.mean(rgba_out[..., 0][semi]))
        mean_g = float(np.mean(rgba_out[..., 1][semi]))
        mean_b = float(np.mean(rgba_out[..., 2][semi]))
        self.assertGreater(mean_r, 180.0)
        self.assertGreater(mean_g, 55.0)
        self.assertLess(mean_b, 70.0)

        # Fully transparent pixels must have zeroed RGB
        transparent = rgba_out[..., 3] == 0
        self.assertTrue(np.any(transparent))
        self.assertEqual(int(rgba_out[..., :3][transparent].max()), 0)

    def test_safe_padded_framing_guarantees_margin(self) -> None:
        # Foreground occupies the entire 300x200 frame (zero initial margin)
        h, w = 200, 300
        rgb = _make_textured_rgb(h, w, (180, 120, 90))
        alpha = np.ones((h, w), dtype=np.float32)

        rgba_out, stats = cutout_clean.postprocess_mask(
            rgb,
            alpha,
            keep_main_dish=False,
            strip_shadows=False,
            pad_ratio=0.10,
            target_size=512,
        )
        out_h, out_w = rgba_out.shape[:2]
        self.assertEqual(out_h, out_w)

        fg = rgba_out[..., 3] > 2
        ys, xs = np.nonzero(fg)
        left_margin = float(xs.min()) / out_w
        right_margin = float(out_w - 1 - xs.max()) / out_w
        top_margin = float(ys.min()) / out_h
        bottom_margin = float(out_h - 1 - ys.max()) / out_h

        for side_name, margin in [
            ("left", left_margin),
            ("right", right_margin),
            ("top", top_margin),
            ("bottom", bottom_margin),
        ]:
            self.assertGreaterEqual(
                margin,
                0.09,
                f"Expected {side_name} transparent margin >= 9%, got {margin:.4f}",
            )
            self.assertGreaterEqual(stats["margin_ratios"][side_name], 0.09)

    def test_fuse_cutout_alphas_preserves_solid_bowl_strips_shadow(self) -> None:
        h, w = 256, 256
        yy, xx = np.mgrid[0:h, 0:w]
        dist = np.hypot(yy - 128.0, xx - 128.0)
        food_core = dist <= 45.0
        white_bowl = (dist > 45.0) & (dist <= 78.0)
        shadow_halo = (dist > 78.0) & (dist <= 98.0)

        rgb = np.full((h, w, 3), 210, dtype=np.uint8)
        rgb[white_bowl] = np.array([245, 244, 240], dtype=np.uint8)
        rgb[food_core] = np.array([185, 95, 55], dtype=np.uint8)
        rgb[shadow_halo] = np.array([75, 75, 78], dtype=np.uint8)

        # BiRefNet drops bright white bowl; upstream cutout_rgba kept bowl (1.0) + soft shadow (0.15)
        birefnet_alpha = np.where(food_core, 1.0, 0.0).astype(np.float32)
        existing_alpha = np.zeros((h, w), dtype=np.float32)
        existing_alpha[food_core | white_bowl] = 1.0
        existing_alpha[shadow_halo] = 0.15

        fused = cutout_clean.fuse_cutout_alphas(birefnet_alpha, existing_alpha)
        rgba_out, stats = cutout_clean.postprocess_mask(
            rgb,
            fused,
            keep_main_dish=True,
            strip_shadows=True,
            pad_ratio=0.10,
            target_size=256,
        )
        # Tight bbox must match the 157px white bowl diameter (~78*2+1), not food-only (91px) or bowl+shadow (197px).
        bbox = stats["bbox_before_pad"]
        self.assertGreaterEqual(bbox["width"], 153)
        self.assertLessEqual(bbox["width"], 161)
        self.assertGreaterEqual(bbox["height"], 153)
        self.assertLessEqual(bbox["height"], 161)
        self.assertEqual(rgba_out.shape[0], rgba_out.shape[1])

    def test_multiview_prep_selects_sharpest_per_bucket_and_writes_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            in_dir = tmp_path / "frames"
            out_dir = tmp_path / "multiview_out"
            in_dir.mkdir()

            sharp_arr = _make_textured_rgb(256, 256, (190, 130, 70))
            sharp_img = Image.fromarray(sharp_arr, mode="RGB")
            blurry_img = sharp_img.filter(ImageFilter.GaussianBlur(radius=6.0))

            # 4 buckets of 3 frames each; exact sharp frame indices: 1, 5, 6, 10
            expected_sharp_indices = [1, 5, 6, 10]
            for i in range(12):
                img = sharp_img if i in expected_sharp_indices else blurry_img
                img.save(in_dir / f"frame_{i:02d}.png")

            manifest = multiview_prep.prepare_multiview(
                in_dir,
                out_dir,
                target_frames=4,
                diameter_cm=24.5,
                skip_cutout=True,
            )

            manifest_path = out_dir / "multiview_manifest.json"
            self.assertTrue(manifest_path.is_file())
            loaded = json.loads(manifest_path.read_text(encoding="utf-8"))

            self.assertFalse(loaded["publication_eligible"])
            self.assertEqual(loaded["source_type"], "directory")
            self.assertEqual(loaded["total_candidate_frames"], 12)
            self.assertEqual(loaded["selected_count"], 4)
            self.assertEqual(loaded["diameter_cm"], 24.5)
            self.assertEqual(manifest["selected_count"], 4)

            selected_names = [Path(v["source_frame"]).name for v in loaded["views"]]
            self.assertEqual(
                selected_names,
                [f"frame_{idx:02d}.png" for idx in expected_sharp_indices],
            )
            for view in loaded["views"]:
                self.assertTrue(Path(view["view_path"]).is_file())
                self.assertGreater(view["sharpness_laplacian_var"], 100.0)

    def test_input_qa_batch_dir_cli_and_publication_eligible(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            batch = tmp_path / "dishes"
            dish_a = batch / "01_clean"
            dish_a.mkdir(parents=True)

            rgb = _make_textured_rgb(1024, 1024)
            Image.fromarray(rgb, mode="RGB").save(dish_a / "input_image.png")
            alpha = (_circle_mask(1024, 1024, 512, 512, 300).astype(np.uint8)) * 255
            rgba = np.dstack([rgb, alpha])
            Image.fromarray(rgba, mode="RGBA").save(dish_a / "cutout_rgba.png")

            out_json = tmp_path / "qa_batch.json"
            rc = input_qa.main(["--batch-dir", str(batch), "--out", str(out_json)])
            self.assertEqual(rc, 0)
            data = json.loads(out_json.read_text(encoding="utf-8"))
            self.assertFalse(data["publication_eligible"])
            self.assertEqual(data["total"], 1)
            self.assertEqual(data["counts_by_triage"]["ready_single_photo"], 1)

    def test_opaque_rgb_existing_cutout_is_skipped(self) -> None:
        import unittest.mock as mock

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            h, w = 128, 128
            rgb = _make_textured_rgb(h, w, (210, 120, 70))
            in_img = tmp_path / "dish.png"
            rgb_cutout = tmp_path / "opaque_rgb_cutout.png"
            out_rgba = tmp_path / "clean.png"
            rep_json = tmp_path / "cutout_report.json"

            Image.fromarray(rgb, mode="RGB").save(in_img)
            Image.fromarray(rgb, mode="RGB").save(rgb_cutout)

            circle_alpha = _circle_mask(h, w, 64, 64, 30).astype(np.float32)
            with mock.patch.object(cutout_clean, "infer_raw_alpha", return_value=circle_alpha):
                report = cutout_clean.clean_cutout_file(
                    in_img,
                    out_rgba,
                    existing_cutout_path=rgb_cutout,
                    report_path=rep_json,
                    pad_ratio=0.10,
                    target_size=128,
                )

            self.assertFalse(report["options"]["existing_cutout_used"])
            self.assertTrue(report["options"]["existing_cutout_skipped_reason"])
            out_arr = np.asarray(Image.open(out_rgba))
            fg_frac = float(np.mean(out_arr[..., 3] > 128))
            self.assertLess(fg_frac, 0.70)

    def test_shadow_stripping_handles_low_confidence_core(self) -> None:
        h, w = 256, 256
        yy, xx = np.mgrid[0:h, 0:w]
        dist = np.hypot(yy - 128.0, xx - 128.0)
        core = dist <= 55.0
        halo = (dist > 55.0) & (dist <= 75.0)

        rgb = np.full((h, w, 3), 215, dtype=np.uint8)
        rgb[core] = np.array([175, 85, 50], dtype=np.uint8)
        rgb[halo] = np.array([65, 65, 68], dtype=np.uint8)

        # Lower-confidence dish (0.72 < 0.85) with cast-shadow halo (0.25)
        raw_alpha = np.zeros((h, w), dtype=np.float32)
        raw_alpha[core] = 0.72
        raw_alpha[halo] = 0.25

        _, stats = cutout_clean.postprocess_mask(
            rgb,
            raw_alpha,
            keep_main_dish=True,
            strip_shadows=True,
            pad_ratio=0.10,
            target_size=256,
        )
        self.assertGreater(stats["shadow_pixels_stripped"], int(np.sum(halo) * 0.8))
        self.assertLessEqual(stats["bbox_before_pad"]["width"], 115)

    def test_multiview_video_copies_before_cleaning_scratch_dir(self) -> None:
        import unittest.mock as mock

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            fake_video = tmp_path / "orbit.mp4"
            fake_video.write_bytes(b"mock")
            out_dir = tmp_path / "mv_out"

            sharp_img = Image.fromarray(_make_textured_rgb(128, 128, (200, 140, 80)), mode="RGB")

            def fake_extract(_video: Path, scratch: Path) -> list[Path]:
                paths = []
                for idx in range(4):
                    p = scratch / f"frame_{idx:05d}.png"
                    sharp_img.save(p)
                    paths.append(p)
                return paths

            with mock.patch.object(multiview_prep, "_extract_video_frames", side_effect=fake_extract):
                manifest = multiview_prep.prepare_multiview(
                    fake_video,
                    out_dir,
                    target_frames=2,
                    skip_cutout=True,
                )

            self.assertEqual(manifest["source_type"], "video")
            self.assertEqual(manifest["selected_count"], 2)
            for v in manifest["views"]:
                self.assertTrue(Path(v["view_path"]).is_file())
            self.assertEqual(list(out_dir.glob("food3d_frames_*")), [])

    def test_create_onnx_session_configures_low_vram_cuda_options(self) -> None:
        import os
        import types
        import unittest.mock as mock

        with tempfile.TemporaryDirectory() as tmp:
            weights_dir = Path(tmp)
            (weights_dir / "birefnet-general-lite.onnx").write_bytes(b"stub")

            captured: dict[str, object] = {}

            class FakeSessionOptions:
                def __init__(self) -> None:
                    self.intra_op_num_threads = 1
                    self.enable_mem_pattern = True
                    self.enable_mem_reuse = True
                    self.graph_optimization_level = None

            class FakeSession:
                def __init__(self, path: str, sess_options: object = None, providers: object = None) -> None:
                    captured["path"] = path
                    captured["sess_options"] = sess_options
                    captured["providers"] = providers

                def get_inputs(self) -> list[object]:
                    return [types.SimpleNamespace(name="input")]

                def get_outputs(self) -> list[object]:
                    return [types.SimpleNamespace(name="output_image")]

            fake_ort = types.SimpleNamespace(
                SessionOptions=FakeSessionOptions,
                GraphOptimizationLevel=types.SimpleNamespace(ORT_ENABLE_BASIC="BASIC"),
                get_available_providers=lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"],
                InferenceSession=FakeSession,
            )

            with (
                mock.patch.dict(sys.modules, {"onnxruntime": fake_ort}),
                mock.patch.object(cutout_clean, "_preload_nvidia_cuda_libs"),
                mock.patch.dict(os.environ, {}, clear=False),
            ):
                os.environ.pop("CUDA_VISIBLE_DEVICES", None)
                _, in_name, out_name = cutout_clean.create_onnx_session(
                    model_name="birefnet-general-lite",
                    model_dir=weights_dir,
                    intra_op_threads=4,
                    prefer_gpu=True,
                )

            self.assertEqual(in_name, "input")
            self.assertEqual(out_name, "output_image")
            opts = captured["sess_options"]
            self.assertEqual(opts.graph_optimization_level, "BASIC")
            self.assertFalse(opts.enable_mem_pattern)
            self.assertFalse(opts.enable_mem_reuse)
            providers = captured["providers"]
            self.assertEqual(providers[0][0], "CUDAExecutionProvider")
            self.assertEqual(providers[0][1]["arena_extend_strategy"], "kSameAsRequested")
            self.assertEqual(providers[0][1]["cudnn_conv_use_max_workspace"], "0")
            self.assertEqual(providers[1], "CPUExecutionProvider")

            # Respect CUDA_VISIBLE_DEVICES="" by falling back to CPU only.
            with (
                mock.patch.dict(sys.modules, {"onnxruntime": fake_ort}),
                mock.patch.dict(os.environ, {"CUDA_VISIBLE_DEVICES": ""}),
            ):
                cutout_clean.create_onnx_session(
                    model_name="birefnet-general-lite",
                    model_dir=weights_dir,
                    prefer_gpu=True,
                )
            self.assertEqual(captured["providers"], ["CPUExecutionProvider"])


if __name__ == "__main__":
    unittest.main()
