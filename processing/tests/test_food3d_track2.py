"""Offline tests for the Food3D Track 2 pipeline."""

from __future__ import annotations

import gzip
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "food3d"))

import build_track2_report as track2_report
import co3d_to_colmap as converter
import multiview_prep


class TestFFmpeg(unittest.TestCase):
    def test_modern_command_and_legacy_fallback(self):
        for stderr in (None, b"Unrecognized option 'fps_mode'."):
            with tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp)
                expected = [output / f"frame_{i:05d}.png" for i in (1, 2)]

                def extract(command, **kwargs):
                    if stderr and "-fps_mode" in command:
                        return subprocess.CompletedProcess(command, 8, stderr=stderr)
                    for path in expected:
                        Image.new("RGB", (8, 8)).save(path)
                    return subprocess.CompletedProcess(command, 0, stderr=b"")

                with patch.object(multiview_prep.subprocess, "run", side_effect=extract) as run:
                    self.assertEqual(multiview_prep._extract_video_frames(Path("orbit.mp4"), output), expected)
                self.assertEqual(run.call_count, 2 if stderr else 1)
                self.assertEqual(run.call_args_list[0].args[0][-3:-1], ["-fps_mode", "passthrough"])
                if stderr:
                    self.assertEqual(run.call_args_list[1].args[0][-3:-1], ["-vsync", "0"])

    def test_extraction_requires_two_frames(self):
        for count in (0, 1):
            with self.subTest(count=count), tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp)

                def extract(command, **kwargs):
                    if count:
                        Image.new("RGB", (8, 8)).save(output / "frame_00001.png")
                    return subprocess.CompletedProcess(command, 0, stderr=b"")

                with patch.object(multiview_prep.subprocess, "run", side_effect=extract):
                    with self.assertRaisesRegex(RuntimeError, "at least 2"):
                        multiview_prep._extract_video_frames(Path("orbit.mp4"), output)

    def test_video_manifest_preserves_source_frame_numbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "orbit.mp4"
            video.touch()
            out = root / "prepared"

            def extract(command, **kwargs):
                for number in (42, 73):
                    Image.new("RGB", (64, 64)).save(Path(command[-1] % number))
                return subprocess.CompletedProcess(command, 0, stderr=b"")

            with patch.object(multiview_prep.subprocess, "run", side_effect=extract):
                report = multiview_prep.prepare_multiview(video, out, target_frames=2, skip_cutout=True)
            self.assertEqual([v["source_frame"] for v in report["views"]], [
                f"{video}#frame=42", f"{video}#frame=73",
            ])
            self.assertEqual([v["source_frame_index"] for v in report["views"]], [42, 73])
            self.assertEqual(list(out.glob("food3d_frames_*")), [])

    def test_prepare_rejects_too_few_candidates_or_selections(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "orbit.mp4"
            video.touch()
            out = root / "prepared"
            with self.assertRaisesRegex(ValueError, "at least 2"):
                multiview_prep.prepare_multiview(video, out, target_frames=1, skip_cutout=True)
            with patch.object(multiview_prep, "_extract_video_frames", return_value=[video]):
                with self.assertRaisesRegex(RuntimeError, "at least 2"):
                    multiview_prep.prepare_multiview(video, out, skip_cutout=True)
            with (
                patch.object(multiview_prep, "_extract_video_frames", return_value=[video, video]),
                patch.object(multiview_prep, "select_sharpest_per_bucket", return_value=[(0, video, 1.0)]),
                self.assertRaisesRegex(RuntimeError, "at least 2"),
            ):
                multiview_prep.prepare_multiview(video, out, skip_cutout=True)
            self.assertFalse((out / "multiview_manifest.json").exists())

    def test_failure_includes_exit_code_and_stderr(self):
        for errors in (
            [b"invalid input"],
            [b"Unrecognized option 'other'\ninvalid input near fps_mode"],
            [b"Unrecognized option 'fps_mode'", b"invalid input"],
        ):
            results = [subprocess.CompletedProcess([], 8, stderr=error) for error in errors]
            with tempfile.TemporaryDirectory() as tmp:
                with patch.object(multiview_prep.subprocess, "run", side_effect=results) as run:
                    with self.assertRaisesRegex(RuntimeError, r"(?s)exit 8.*invalid input"):
                        multiview_prep._extract_video_frames(Path("orbit.mp4"), Path(tmp))
                    self.assertEqual(run.call_count, len(errors))


def _rotation_y(angle):
    c, s = np.cos(angle), np.sin(angle)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


class TestCO3DConversion(unittest.TestCase):
    def test_camera_projection_round_trip_with_resize(self):
        R = _rotation_y(0.43)
        T = np.array([0.4, -0.2, 3.2])
        focal = [2.6, 2.1]
        principal = [0.23, -0.17]
        original = (817, 553)
        resized = (320, 217)
        points = np.array([[0.1, 0.4, 0.6], [-0.7, 0.8, -0.5], [0.2, 0, 0.1]])
        camera = converter.pytorch3d_ndc_to_opencv_and_opengl(R, T, focal, principal, original, resized)

        p3d = points @ R + T
        ndc = p3d[:, :2] / p3d[:, 2:] * focal + principal
        expected = (np.array(original) / 2 - ndc * (min(original) / 2)) * (
            np.array(resized) / original
        )
        actual, _ = camera.project(points)
        gl = (points - camera.transform_matrix[:3, 3]) @ camera.transform_matrix[:3, :3]
        k = camera.intrinsics
        projected_gl = gl[:, :2] / (-gl[:, 2:]) * [k["fl_x"], -k["fl_y"]] + [k["cx"], k["cy"]]
        np.testing.assert_allclose(actual, expected, atol=1e-3, rtol=0)
        np.testing.assert_allclose(projected_gl, expected, atol=1e-3, rtol=0)

    def _make_capture(self, root, *, inconsistent=False):
        category = root / "pizza"
        category.mkdir()
        h, w = 64, 96
        y, x = np.ogrid[:h, :w]
        frames = []
        for i in range(12):
            stem = f"source_{i:06d}"
            image_path = f"pizza/{stem}.png"
            mask_path = f"pizza/{stem}_mask.png"
            rgb = np.full((h, w, 3), (187, 133, 79), dtype=np.uint8)
            cx = 25 if i % 2 == 0 else 70
            if not inconsistent:
                cx = w // 2
            mask = ((x - cx) ** 2 + (y - h // 2) ** 2 <= (1 if i == 10 else 12) ** 2)
            mask_u8 = mask.astype(np.uint8) * 255
            if not inconsistent and i != 10:
                mask_u8[0, 0] = 60
            if i == 8:
                rgb[:] = 10
            Image.fromarray(rgb).save(root / image_path)
            if i != 11:
                Image.fromarray(mask_u8).save(root / mask_path)
            frames.append({
                "sequence_name": "a_capture", "frame_number": str(i + 10),
                "meta": {"frame_type": "test_unseen" if i == 9 else "train_known"},
                "image": {"path": image_path, "size": [h, w]},
                "mask": {"path": mask_path},
                "viewpoint": {
                    "R": _rotation_y(0 if inconsistent else i * np.pi / 4).tolist(),
                    "T": [0, 0, 4], "focal_length": [2, 2], "principal_point": [0, 0],
                    "intrinsics_format": "ndc_isotropic",
                },
            })
        with gzip.open(category / "frame_annotations.jgz", "wt", encoding="utf-8") as stream:
            json.dump([{**frames[0], "sequence_name": "z_capture"}, *reversed(frames)], stream)
        return category

    def test_filtering_and_visual_hull_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            category = self._make_capture(root)
            out = root / "converted"
            report = converter.convert_co3d_sequence(root, out, max_dim=73)
            self.assertEqual(report["valid_frames"], 8)
            self.assertEqual(report["skipped_frames"], 4)
            self.assertGreaterEqual(report["mean_mask_hit_rate"], 0.85)
            self.assertEqual(report["initial_point_count"], 20000)
            self.assertFalse(report["ellipsoid_fallback"])
            self.assertEqual(report["transforms_mode"], "train_val_split")
            self.assertFalse((out / "transforms.json").exists())
            train_transforms = json.loads((out / "transforms_train.json").read_text())
            val_transforms = json.loads((out / "transforms_val.json").read_text())
            self.assertFalse(train_transforms["publication_eligible"])
            self.assertFalse(val_transforms["publication_eligible"])
            self.assertFalse((out / "masks").exists())
            self.assertTrue((out / "eval_masks").is_dir())
            self.assertTrue(val_transforms["frames"][0]["eval_mask_path"].startswith("eval_masks/"))
            self.assertEqual((train_transforms["w"], train_transforms["h"]), (73, 49))
            all_frames = sorted([*train_transforms["frames"], *val_transforms["frames"]], key=lambda f: f["frame_number"])
            self.assertEqual([frame["frame_number"] for frame in all_frames], list(range(10, 18)))
            header, points = (out / "points3d.ply").read_bytes().split(b"end_header\n", maxsplit=1)
            self.assertIn(b"element vertex 20000\n", header)
            self.assertEqual(len(points), 20000 * 15)
            with Image.open(out / val_transforms["frames"][0]["file_path"]) as image:
                self.assertEqual(image.getpixel((0, 0)), (0, 0, 0, 0))
                self.assertEqual(image.getpixel((36, 24)), (187, 133, 79, 255))

            rgb_out = root / "rgb"
            converter.convert_co3d_sequence(category, rgb_out, sequence="a_capture", mask_mode="rgb", max_points=300)
            with Image.open(rgb_out / val_transforms["frames"][0]["file_path"]) as image:
                self.assertEqual(image.mode, "RGB")
            with self.assertRaisesRegex(RuntimeError, "at least 2"):
                converter.convert_co3d_sequence(category, root / "too-few", sequence="z_capture")

    def test_held_out_rgb_and_masks_cannot_change_initial_points(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            category = self._make_capture(root)
            before, after = root / "before", root / "after"
            options = {"eval_split_every": 2, "max_points": 800}
            report = converter.convert_co3d_sequence(category, before, **options)
            self.assertEqual((report["train_frames"], report["eval_frames"]), (4, 4))
            self.assertEqual(report["eval_split_every"], 2)
            self.assertEqual(report["eval_frame_numbers"], [10, 12, 14, 16])
            self.assertEqual(report["eval_frame_stems"], [f"frame_{i:06d}" for i in (10, 12, 14, 16)])
            for i in range(0, 8, 2):
                stem = f"source_{i:06d}"
                Image.new("RGB", (96, 64), (15, 240, 80)).save(category / f"{stem}.png")
                mask = Image.new("L", (96, 64))
                mask.paste(255, (5, 12, 25, 40))
                mask.save(category / f"{stem}_mask.png")
            changed = converter.convert_co3d_sequence(category, after, **options)
            self.assertEqual((before / "points3d.ply").read_bytes(), (after / "points3d.ply").read_bytes())
            self.assertEqual(changed["train_mean_mask_hit_rate"], report["train_mean_mask_hit_rate"])
            self.assertGreaterEqual(changed["train_mean_mask_hit_rate"], 0.85)
            self.assertLess(changed["mean_mask_hit_rate"], 0.85)

            # Blacking out held-out frame 10 must drop only that eval frame without shifting roles.
            Image.new("RGB", (96, 64), (0, 0, 0)).save(category / "source_000000.png")
            dropped_dir = root / "dropped_eval"
            dropped = converter.convert_co3d_sequence(category, dropped_dir, **options)
            self.assertEqual((before / "points3d.ply").read_bytes(), (dropped_dir / "points3d.ply").read_bytes())
            self.assertEqual((before / "transforms_train.json").read_bytes(), (dropped_dir / "transforms_train.json").read_bytes())
            self.assertFalse((dropped_dir / "transforms.json").exists())
            self.assertEqual(dropped["train_frames"], 4)
            self.assertEqual(dropped["eval_frames"], 3)
            self.assertEqual(dropped["eval_frame_numbers"], [12, 14, 16])
            self.assertTrue(dropped["eval_stride_shifted_by_dropped_frames"])
            dropped_val = json.loads((dropped_dir / "transforms_val.json").read_text())
            self.assertEqual([f["frame_number"] for f in dropped_val["frames"]], [12, 14, 16])
            brush_dir = root / "brush_dropped"
            eval_dir = brush_dir / "eval_10"
            eval_dir.mkdir(parents=True)
            for frame in dropped_val["frames"]:
                Image.open(dropped_dir / frame["file_path"]).convert("RGB").save(eval_dir / Path(frame["file_path"]).name)
            eval_rep = track2_report.build_eval_report("dropped", dropped_dir, brush_dir, 2, root / "dropped_rep")
            self.assertEqual(eval_rep["eval_views_count"], 3)
            (eval_dir / "frame_000011.png").touch()
            with self.assertRaisesRegex(RuntimeError, "training frame"):
                track2_report.build_eval_report("dropped", dropped_dir, brush_dir, 2, root / "dropped_rep")
            (dropped_dir / "transforms.json").write_text("{}")
            with self.assertRaisesRegex(RuntimeError, "mixes transforms.json"):
                track2_report.build_eval_report("dropped", dropped_dir, brush_dir, 2, root / "dropped_rep")

    def test_two_camera_intrinsics_and_split_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            category = self._make_capture(root)
            annotations = category / "frame_annotations.jgz"
            with gzip.open(annotations, "rt") as stream:
                frames = [item for item in json.load(stream) if int(item["frame_number"]) in (10, 11)
                          and item["sequence_name"] == "a_capture"]
            frames.sort(key=lambda item: int(item["frame_number"]))
            keys = ("w", "h", "fl_x", "fl_y", "cx", "cy")
            out = root / "converted"
            for varied in (False, True):
                with self.subTest(varied=varied):
                    if varied:
                        frames[1]["viewpoint"].update(focal_length=[2.1, 1.9], principal_point=[0.02, -0.02])
                    with gzip.open(annotations, "wt") as stream:
                        json.dump(frames, stream)
                    report = converter.convert_co3d_sequence(category, out, eval_split_every=0, max_points=800)
                    self.assertEqual((report["train_frames"], report["eval_frames"]), (2, 0))
                    self.assertEqual(report["mean_mask_hit_rate"], report["train_mean_mask_hit_rate"])
                    transforms = json.loads((out / "transforms.json").read_text())
                    expected = (96, 64, 64, 64, 48, 32)
                    self.assertEqual(tuple(transforms["frames"][0][key] for key in keys), expected)
                    if varied:
                        self.assertTrue(set(keys).isdisjoint(transforms))
                        np.testing.assert_allclose(
                            [transforms["frames"][1][key] for key in keys],
                            [96, 64, 67.2, 60.8, 47.36, 32.64],
                        )
                    else:
                        self.assertEqual(tuple(transforms[key] for key in keys), expected)
            with self.assertRaisesRegex(ValueError, "eval_split_every"):
                converter.convert_co3d_sequence(category, out, eval_split_every=-1)
            with self.assertRaisesRegex(RuntimeError, "at least 2"):
                converter.convert_co3d_sequence(category, out)

    def test_rgba_downsize_excludes_background_color(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            category = self._make_capture(root)
            with gzip.open(category / "frame_annotations.jgz", "rt") as stream:
                item = json.load(stream)[0]
            rgb = np.full((64, 96, 3), (0, 0, 255), dtype=np.uint8)
            alpha = np.full((64, 96), 127, dtype=np.uint8)
            rgb[10:54, 11:49] = (255, 0, 0)
            alpha[10:54, 11:49] = 255
            alpha[10:54, 48] = 210
            Image.fromarray(rgb).save(root / item["image"]["path"])
            Image.fromarray(alpha).save(root / item["mask"]["path"])
            for subdir in ("images", "eval_masks"):
                (root / subdir).mkdir()
            view, frame = converter._prepare_view(item, category, root, "rgba", 29)
            with Image.open(view.image_path) as image, Image.open(root / frame["eval_mask_path"]) as mask:
                resized = np.asarray(image)
                retained = resized[..., 3] > 0
                self.assertTrue(np.any(retained & (resized[..., 3] < 255)))
                self.assertTrue(np.all(resized[retained, 2] == 0))
                self.assertTrue(np.all(resized[retained, 0] == 255))
                np.testing.assert_array_equal(view.mask, np.asarray(mask) > 127)

    def test_inconsistent_masks_fail_with_diagnostics(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            category = self._make_capture(root, inconsistent=True)
            out = root / "converted"
            with self.assertRaisesRegex(RuntimeError, "mean_mask_hit_rate .* below 0.85"):
                converter.convert_co3d_sequence(category, out, max_points=800)
            report = json.loads((out / "conversion_report.json").read_text())
            self.assertLess(report["train_mean_mask_hit_rate"], 0.85)
            self.assertTrue((out / "transforms_train.json").is_file())


class TestTrack2Report(unittest.TestCase):
    def test_metrics_and_known_lab_shift(self):
        mask = np.zeros((32, 32), dtype=bool)
        mask[8:-8, 8:-8] = True
        gt = np.zeros((32, 32, 3), dtype=np.float32)
        gt[mask] = (1, 0, 0)
        equal = track2_report.compute_pair_metrics(gt, gt, mask)
        for metric in ("full_psnr_db", "fg_psnr_db"):
            self.assertEqual(equal[metric], 100)
        for metric in ("full_ssim", "fg_ssim"):
            self.assertAlmostEqual(equal[metric], 1, places=4)
        self.assertEqual(equal["fg_delta_e"], 0)
        other = gt.copy()
        other[mask] = (0, 1, 0)
        shifted = track2_report.compute_pair_metrics(gt, other, mask)
        self.assertAlmostEqual(shifted["fg_delta_e"], 170.57, places=1)
        other = gt.copy()
        other[~mask] = 1
        background_only = track2_report.compute_pair_metrics(gt, other, mask)
        self.assertEqual(background_only["fg_psnr_db"], 100)
        self.assertLess(background_only["full_psnr_db"], 10)
        self.assertAlmostEqual(background_only["fg_ssim"], 1.0, places=4)
        self.assertEqual(background_only["fg_delta_e"], 0)

    def test_match_stems_and_sequential_indices(self):
        frames = [{"file_path": f"images/frame_{i:06d}.png"} for i in range(10, 14)]
        for strategy, names in (
            ("filename_stem", ["frame_000010.png", "render_frame_000012.png"]),
            ("sequential_eval_split_index", ["eval_00000.png", "view_1.png"]),
        ):
            actual, pairs = track2_report.match_eval_renders(list(map(Path, reversed(names))), frames, 2)
            self.assertEqual(actual, strategy)
            self.assertEqual([frame for frame, _ in pairs], frames[::2])
        with self.assertRaisesRegex(RuntimeError, "No Brush eval PNG"):
            track2_report.match_eval_renders([], frames, 2)
        with self.assertRaisesRegex(RuntimeError, "coverage"):
            track2_report.match_eval_renders([Path("eval_00000.png")], frames, 2)
        _, partial = track2_report.match_eval_renders(
            [Path("eval_00000.png")], frames, 2, allow_partial=True,
        )
        self.assertEqual(partial[0][0], frames[0])
        _, explicit = track2_report.match_eval_renders(
            [Path("frame_000011.png")], frames, 2, expected_eval_stems=["frame_000011"],
        )
        self.assertEqual(explicit[0][0], frames[1])
        for names in (
            ["frame_000010.png", "view_0.png"], ["view_2.png"],
            ["frame_000011.png"], ["frame_000000.png"],
        ):
            with self.subTest(names=names), self.assertRaises(RuntimeError):
                track2_report.match_eval_renders(list(map(Path, names)), frames, 2, allow_partial=True)

    def test_eval_checkpoint_requires_unique_highest_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "unrelated.png").touch()
            with self.assertRaisesRegex(RuntimeError, "eval_<step>"):
                track2_report.discover_eval_renders(root)
            older = root / "eval_9"
            newest = root / "eval_10"
            nested = newest / "nested"
            older.mkdir()
            nested.mkdir(parents=True)
            (older / "old.png").touch()
            (nested / "nested.png").touch()
            (newest / "render.png").touch()
            self.assertEqual(track2_report.discover_eval_renders(root), (10, [newest / "render.png"]))
            (nested / "eval_010").mkdir()
            with self.assertRaisesRegex(RuntimeError, "unique"):
                track2_report.discover_eval_renders(root)

    def test_eval_checkpoint_and_track1_reject_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            brush = root / "brush"
            (brush / "eval_9").mkdir(parents=True)
            (brush / "eval_10").symlink_to(brush / "eval_9", target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                track2_report.discover_eval_renders(brush)
            (brush / "eval_10").unlink()
            (brush / "eval_10").mkdir()
            outside = root / "outside.png"
            outside.touch()
            (brush / "eval_10" / "frame_000010.png").symlink_to(outside)
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                track2_report.discover_eval_renders(brush)

            dishes = root / "dishes"
            report_dir = dishes / "reports" / "d"
            report_dir.mkdir(parents=True)
            (report_dir / "track2_metrics.json").write_text(json.dumps({"dish": "d", "summary": {}}))
            t1_root = root / "track1"
            (t1_root / "dish").mkdir(parents=True)
            outside_json = root / "outside.json"
            outside_json.write_text("{}")
            (t1_root / "dish" / "qa_report.json").symlink_to(outside_json)
            with self.assertRaisesRegex(RuntimeError, "escapes"):
                track2_report.build_studio(dishes, root / "studio.html", t1_root)

    def test_converter_and_report_reject_symlinked_manifests(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            category = TestCO3DConversion()._make_capture(root)
            out = root / "converted"
            out.mkdir()
            sentinel = root / "sentinel.txt"
            sentinel.write_text("KEEP_ME")
            (out / "transforms_train.json").symlink_to(sentinel)
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                converter.convert_co3d_sequence(category, out, max_points=400)
            self.assertEqual(sentinel.read_text(), "KEEP_ME")

            clean_out = root / "clean_dataset"
            converter.convert_co3d_sequence(category, clean_out, max_points=400)
            brush = root / "brush"
            eval_dir = brush / "eval_10"
            eval_dir.mkdir(parents=True)
            for name in ("transforms_train.json", "transforms_val.json", "conversion_report.json"):
                ds = root / f"ds_{name}"
                ds.mkdir()
                for sub in ("images", "eval_masks"):
                    (ds / sub).mkdir()
                for f in (clean_out / "images").iterdir():
                    (ds / "images" / f.name).write_bytes(f.read_bytes())
                for f in (clean_out / "eval_masks").iterdir():
                    (ds / "eval_masks" / f.name).write_bytes(f.read_bytes())
                for other in ("transforms_train.json", "transforms_val.json", "conversion_report.json"):
                    src = clean_out / other
                    if other == name:
                        (ds / other).symlink_to(src)
                    else:
                        (ds / other).write_bytes(src.read_bytes())
                with self.assertRaisesRegex(RuntimeError, "symlink"):
                    track2_report.build_eval_report("d", ds, brush, 8, root / f"rep_{name}")

    def test_pair_rejects_escaping_ground_truth_or_mask(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset = root / "dataset"
            dataset.mkdir()
            outside = root / "outside.png"
            Image.new("RGB", (8, 8), "red").save(outside)
            Image.new("L", (8, 8), 255).save(dataset / "local.png")
            (dataset / "link.png").symlink_to(outside)
            for key in ("file_path", "eval_mask_path"):
                for escaped in ("../outside.png", str(outside), "link.png"):
                    frame = {"file_path": "local.png", "eval_mask_path": "local.png", "w": 8, "h": 8}
                    frame[key] = escaped
                    with self.subTest(key=key, escaped=escaped), self.assertRaisesRegex(RuntimeError, "escapes"):
                        track2_report._load_pair(dataset, frame, outside)

    def test_studio_rejects_escaping_report_and_assets(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            root = parent / "dishes"
            report_dir = root / "dish"
            report_dir.mkdir(parents=True)
            outside = parent / "outside.png"
            outside.touch()
            (report_dir / "link.png").symlink_to(outside)
            sibling = root / "sibling.png"
            sibling.touch()
            report = report_dir / "track2_metrics.json"
            out = root / "studio.html"
            for key, asset in (
                ("eval_sheet", "../sibling.png"), ("eval_sheet", "link.png"),
                ("orbit_video", "../../outside.png"), ("orbit_video", str(outside)),
                ("orbit_video", "link.png"),
            ):
                report.write_text(json.dumps({key: asset}))
                with self.subTest(key=key, asset=asset), self.assertRaisesRegex(RuntimeError, "escapes"):
                    track2_report.build_studio(root, out)
            report.unlink()
            (report_dir / "link.png").unlink()
            report_dir.rmdir()
            (parent / report.name).write_text("{}")
            report_dir.symlink_to(parent, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "escapes"):
                track2_report.build_studio(root, out)

    def test_eval_and_studio_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset = root / "dataset"
            brush = root / "brush"
            latest = brush / "eval_100"
            older = brush / "eval_20"
            track1 = root / "track1" / "dish"
            for directory in (dataset / "images", dataset / "masks", latest, older, track1):
                directory.mkdir(parents=True)
            (older / "invalid.png").touch()
            (brush / "splats_100.ply").write_text("ply\nformat ascii 1.0\nelement vertex 31\nend_header\n")
            mask = Image.new("L", (64, 48), 0)
            mask.paste(255, (16, 12, 48, 36))
            rgba = Image.new("RGBA", mask.size, (110, 85, 35))
            rgba.putalpha(mask)
            render = Image.new("RGBA", mask.size, "white")
            render.alpha_composite(rgba)
            frames = []
            for i in range(8):
                name = f"frame_{10 + i:06d}.png"
                rgba.save(dataset / "images" / name)
                mask.save(dataset / "masks" / name)
                frames.append({
                    "file_path": f"images/{name}", "mask_path": f"masks/{name}",
                    "w": 64, "h": 48, "frame_number": i + 10,
                })
                if i % 2 == 0:
                    render.convert("RGB").save(latest / name)
            (dataset / "transforms.json").write_text(json.dumps({"frames": frames}))
            (dataset / "conversion_report.json").write_text(json.dumps({
                "valid_frames": 8, "mean_mask_hit_rate": 0.94, "initial_point_count": 500,
                "eval_split_every": 2, "eval_frame_stems": [Path(f["file_path"]).stem for f in frames[::2]],
            }))
            (track1 / "qa_report.json").write_text(json.dumps({
                "verdict": "WARN", "checks": {"photo_fidelity": {"silhouette_iou": 0.91}},
            }))
            orbit = brush / "dish #1.mp4"
            orbit.touch()
            video_manifest = root / "multiview_manifest.json"
            video_manifest.write_text(json.dumps({"source_type": "video", "selected_count": 8}))
            dish = '</script><script>alert("test")</script> & <img>\u2028\u2029'
            out = root / "reports" / "dish"
            with self.assertRaisesRegex(RuntimeError, "eval_split_every"):
                track2_report.build_eval_report(dish, dataset, brush, 3, out)
            black = track2_report.build_eval_report(dish, dataset, brush, 2, out, background="black")
            self.assertLess(black["summary"]["full_psnr_db"]["mean"], 10)
            self.assertEqual(black["summary"]["fg_psnr_db"]["mean"], 100)
            self.assertEqual(black["background"], "black")
            report = track2_report.build_eval_report(
                dish, dataset, brush, 2, out, video_prep_manifest=video_manifest, orbit_video=orbit,
                background="white",
            )
            self.assertFalse(report["publication_eligible"])
            self.assertEqual(report["eval_views_count"], 4)
            self.assertEqual(report["eval_checkpoint_step"], 100)
            self.assertFalse(report["allow_partial"])
            self.assertEqual(report["background"], "white")
            self.assertEqual(report["summary"]["full_psnr_db"]["mean"], 100)
            self.assertEqual(report["ply_stats"]["splat_vertex_count"], 31)
            self.assertEqual(report["video_prep_stats"]["selected_count"], 8)
            self.assertEqual(report["dataset_stats"]["mean_mask_hit_rate"], 0.94)
            with Image.open(out / "track2_eval_sheet.png") as sheet:
                self.assertGreater(sheet.height, 1280)

            html = root / "studio" / "track2_studio.html"
            track2_report.build_studio(root, html, track1.parent)
            source = html.read_text()
            self.assertNotIn(dish, source)
            payload = source.split('<script id="track2-manifest" type="application/json">')[1].split("</script>")[0]
            for encoded in (r"\u003c", r"\u003e", r"\u0026", r"\u2028", r"\u2029"):
                self.assertIn(encoded, payload)
            manifest = json.loads(payload)
            self.assertFalse(manifest["publication_eligible"])
            self.assertEqual(manifest["dishes"][0]["dish"], dish)
            self.assertEqual(manifest["dishes"][0]["orbit_video"], "../brush/dish%20%231.mp4")
            self.assertEqual(manifest["track1"][0]["iou"], 0.91)

            render_path = latest / Path(frames[0]["file_path"]).name
            render.resize((32, 24), Image.Resampling.LANCZOS).save(render_path)
            resized = track2_report.build_eval_report(dish, dataset, brush, 2, out, background="white")
            self.assertGreater(resized["views"][0]["full_psnr_db"], 35)
            render.resize((32, 16)).save(render_path)
            with self.assertRaisesRegex(RuntimeError, "aspect ratio"):
                track2_report.build_eval_report(dish, dataset, brush, 2, out)


if __name__ == "__main__":
    unittest.main()
