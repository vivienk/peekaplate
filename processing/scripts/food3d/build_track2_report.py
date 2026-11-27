"""Evaluate local Brush held-out renders and build a private Food3D studio."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from urllib.parse import quote

import numpy as np
from PIL import Image, ImageDraw, ImageOps
from scipy import ndimage

if __package__:
    from .qa_gate import compute_windowed_ssim, srgb_to_lab
else:
    from qa_gate import compute_windowed_ssim, srgb_to_lab


STAMP = "R&D ONLY - publication_eligible: false"


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def discover_eval_renders(brush_out: Path) -> tuple[int, list[Path]]:
    brush_root = brush_out.resolve()
    directories: list[tuple[int, Path]] = []
    seen_dirs: set[Path] = set()
    for path in sorted(brush_out.rglob("eval_*")):
        match = re.fullmatch(r"eval_(\d+)", path.name)
        if not match:
            continue
        if path.is_symlink():
            raise RuntimeError(f"Brush eval directory escapes or is a symlink: {path}")
        if not path.is_dir():
            continue
        resolved_dir = path.resolve()
        if not resolved_dir.is_relative_to(brush_root) or resolved_dir in seen_dirs:
            raise RuntimeError(f"Brush eval directory escapes or aliases {brush_out}: {path}")
        seen_dirs.add(resolved_dir)
        directories.append((int(match[1]), path))
    if not directories:
        raise RuntimeError(f"No Brush eval_<step> directory found under {brush_out}")
    highest = max(step for step, _ in directories)
    latest = [path for step, path in directories if step == highest]
    if len(latest) != 1:
        raise RuntimeError(f"Expected a unique Brush eval directory at step {highest}")
    selected_dir = latest[0]
    selected_res = selected_dir.resolve()
    renders: list[Path] = []
    for png in sorted(selected_dir.glob("*.png")):
        if png.is_symlink():
            raise RuntimeError(f"Brush eval render escapes or is a symlink: {png}")
        if not png.resolve().is_relative_to(selected_res):
            raise RuntimeError(f"Brush eval render escapes checkpoint directory: {png}")
        if png.is_file():
            renders.append(png)
    return highest, renders


def match_eval_renders(
    renders: list[Path], frames: list[dict], split_every: int,
    expected_eval_stems: list[str] | None = None, allow_partial: bool = False,
):
    if split_every < 1:
        raise ValueError("eval_split_every must be at least 1")
    if not renders:
        raise RuntimeError("No Brush eval PNG renders found")
    frames_by_stem = {Path(frame["file_path"]).stem: frame for frame in frames}
    if len(frames_by_stem) != len(frames):
        raise RuntimeError("Dataset frame stems must be unique")
    if expected_eval_stems is None:
        expected_eval_stems = [Path(frame["file_path"]).stem for frame in frames[::split_every]]
    indices = {stem: i for i, stem in enumerate(expected_eval_stems)}
    if len(indices) != len(expected_eval_stems) or indices.keys() - frames_by_stem.keys():
        raise RuntimeError("Expected held-out stems must be unique dataset frame stems")
    held_out = [frames_by_stem[stem] for stem in expected_eval_stems]
    pairs, strategies = {}, set()
    for render in renders:
        candidates = [
            stem for stem in frames_by_stem
            if re.search(rf"(?<![A-Za-z0-9]){re.escape(stem)}(?![A-Za-z0-9])", render.stem)
        ]
        if len(candidates) == 1:
            stem = candidates[0]
            if stem not in indices:
                raise RuntimeError(f"Render {render} matches a training frame")
            index = indices[stem]
            strategies.add("filename_stem")
        else:
            ordinal = re.fullmatch(r"(?:(?:eval|view)_)?(\d+)", render.stem)
            if candidates or not ordinal:
                raise RuntimeError(f"Cannot match Brush eval render {render} to a held-out frame")
            index = int(ordinal[1])
            strategies.add("sequential_eval_split_index")
        if index >= len(held_out) or index in pairs:
            raise RuntimeError(f"Invalid or duplicate held-out index {index} for {render}")
        pairs[index] = (held_out[index], render)
    if not allow_partial and len(pairs) != len(held_out):
        raise RuntimeError(f"Incomplete held-out coverage: matched {len(pairs)} of {len(held_out)} frames")
    return "+".join(sorted(strategies)), [pairs[index] for index in sorted(pairs)]


def compute_masked_windowed_ssim(
    img_a: np.ndarray, img_b: np.ndarray, mask: np.ndarray, sigma: float = 1.5,
) -> float:
    """Compute luminance SSIM with Gaussian moments normalized over foreground pixels."""
    weights = np.array([0.299, 0.587, 0.114])
    lum_a, lum_b = img_a @ weights, img_b @ weights
    m = mask.astype(np.float32)

    def gaussian(values: np.ndarray) -> np.ndarray:
        return ndimage.gaussian_filter(values, sigma=sigma, truncate=3.33)

    w = gaussian(m)
    valid = mask & (w > 1e-6)
    normalizer = np.maximum(w, 1e-6)
    mu_a = np.where(valid, gaussian(lum_a * m) / normalizer, 0.0)
    mu_b = np.where(valid, gaussian(lum_b * m) / normalizer, 0.0)
    sig_a2 = np.maximum(gaussian(lum_a**2 * m) / normalizer - mu_a**2, 0.0)
    sig_b2 = np.maximum(gaussian(lum_b**2 * m) / normalizer - mu_b**2, 0.0)
    sig_ab = gaussian(lum_a * lum_b * m) / normalizer - mu_a * mu_b
    c1, c2 = 0.01**2, 0.03**2
    ssim_map = ((2 * mu_a * mu_b + c1) * (2 * sig_ab + c2)) / (
        (mu_a**2 + mu_b**2 + c1) * (sig_a2 + sig_b2 + c2)
    )
    return float(np.clip(ssim_map[mask].mean(), -1.0, 1.0))


def compute_pair_metrics(gt: np.ndarray, render: np.ndarray, mask: np.ndarray) -> dict[str, float]:
    """Score normalized RGB images, with a boolean foreground mask."""
    if not mask.any():
        raise RuntimeError("Held-out mask has no foreground at render resolution")
    error = (gt - render) ** 2
    return {
        "full_psnr_db": float(-10 * np.log10(max(1e-10, error.mean()))),
        "fg_psnr_db": float(-10 * np.log10(max(1e-10, error[mask].mean()))),
        "full_ssim": compute_windowed_ssim(gt, render),
        "fg_ssim": compute_masked_windowed_ssim(gt, render, mask),
        "fg_delta_e": float(np.linalg.norm(srgb_to_lab(gt[mask]) - srgb_to_lab(render[mask]), axis=-1).mean()),
    }


def _load_pair(dataset_dir: Path, frame: dict, render_path: Path, background: str = "black"):
    dataset_root = dataset_dir.resolve()
    gt_path = (dataset_dir / frame["file_path"]).resolve()
    mask_rel = frame.get("eval_mask_path") or frame["mask_path"]
    mask_path = (dataset_dir / mask_rel).resolve()
    for path in (gt_path, mask_path):
        if not path.is_relative_to(dataset_root):
            raise RuntimeError(f"Ground-truth image or mask escapes dataset root: {path}")
    with Image.open(render_path) as source:
        render = source.convert("RGBA")
    with Image.open(gt_path) as source:
        gt = source.convert("RGBA")
    with Image.open(mask_path) as source:
        mask = source.convert("L")
    if mask.size != gt.size or gt.size != (frame["w"], frame["h"]):
        raise RuntimeError(f"Ground-truth dimensions disagree for {frame['file_path']}")
    w, h = render.size
    gt_w, gt_h = gt.size
    if abs(w * gt_h - h * gt_w) > max(gt_w, gt_h):
        raise RuntimeError(f"Render aspect ratio differs from ground truth for {render_path}")
    gt = gt.resize(render.size, Image.Resampling.LANCZOS)
    mask = np.asarray(mask.resize(render.size, Image.Resampling.NEAREST)) > 127
    render = np.asarray(render, dtype=np.float32) / 255
    gt = np.asarray(gt, dtype=np.float32) / 255
    bg = 1.0 if background == "white" else 0.0
    gt_rgb = gt[..., :3] * gt[..., 3:] + bg * (1 - gt[..., 3:])
    render_rgb = render[..., :3] * render[..., 3:] + bg * (1 - render[..., 3:])
    return gt_rgb, render_rgb, mask


def _diagnostic_tiles(gt: np.ndarray, render: np.ndarray) -> list[Image.Image]:
    images = (gt, render, np.clip(3 * np.abs(gt - render), 0, 1))
    return [
        ImageOps.contain(Image.fromarray(np.rint(image * 255).astype(np.uint8)), (320, 320))
        for image in images
    ]


def _write_eval_sheet(
    path: Path,
    rows: list[tuple[dict, list[Image.Image]]],
    render_label: str = "Brush 3DGS Render",
) -> None:
    sheet = Image.new("RGB", (1000, 88 + 354 * len(rows)), "#18232c")
    draw = ImageDraw.Draw(sheet)
    draw.text((16, 10), STAMP, fill="white")
    labels = ("Real Held-Out GT", render_label, "3x Abs Diff Error Map")
    for column, label in enumerate(labels):
        draw.text((16 + column * 328, 39), label, fill="white")
    for row, (view, tiles) in enumerate(rows):
        y = 60 + row * 354
        draw.text((16, y), (
            f"{view['frame_stem']} | FG PSNR {view['fg_psnr_db']:.1f} dB | "
            f"SSIM {view['fg_ssim']:.3f} | dE {view['fg_delta_e']:.1f}"
        ), fill="white")
        for column, tile in enumerate(tiles):
            sheet.paste(tile, (12 + 328 * column + (320 - tile.width) // 2, y + 20 + (320 - tile.height) // 2))
    draw.text((16, sheet.height - 24), STAMP, fill="white")
    sheet.save(path)


def _ply_stats(brush_out: Path) -> dict:
    files = sorted(brush_out.rglob("*.ply"))
    if not files:
        return {"brush_ply_path": None, "ply_mb": None, "splat_vertex_count": None}
    def checkpoint(path: Path) -> int:
        steps = re.findall(r"\d+", path.stem)
        return int(steps[-1]) if steps else -1

    path = max(files, key=lambda file: (checkpoint(file), file))
    vertex_count = None
    with path.open("rb") as stream:
        if stream.readline(256).strip() == b"ply":
            for _ in range(512):
                line = stream.readline(4096).strip()
                if not line or line == b"end_header":
                    break
                match = re.fullmatch(rb"element vertex (\d+)", line)
                if match:
                    vertex_count = int(match[1])
                    break
    return {
        "brush_ply_path": str(path.resolve()),
        "ply_mb": path.stat().st_size / 1_000_000,
        "splat_vertex_count": vertex_count,
    }


def _ensure_local_dataset_file(dataset_root: Path, path: Path) -> Path:
    if path.is_symlink() or not path.resolve().is_relative_to(dataset_root):
        raise RuntimeError(f"Dataset file must not be a symlink or escape root: {path}")
    return path


def _load_dataset_split(dataset_dir: Path) -> tuple[list[dict], list[dict] | None]:
    dataset_root = dataset_dir.resolve()
    single = dataset_dir / "transforms.json"
    train_path = dataset_dir / "transforms_train.json"
    val_path = dataset_dir / "transforms_val.json"
    for candidate in (single, train_path, val_path):
        if candidate.exists() or candidate.is_symlink():
            _ensure_local_dataset_file(dataset_root, candidate)
    if train_path.exists() or val_path.exists():
        if single.exists():
            raise RuntimeError(
                f"Dataset {dataset_dir} mixes transforms.json with transforms_train/val.json"
            )
        if not (train_path.is_file() and val_path.is_file()):
            raise RuntimeError(
                f"Dataset {dataset_dir} must provide both transforms_train.json and transforms_val.json"
            )
        train_frames = _read_json(train_path)["frames"]
        val_frames = _read_json(val_path)["frames"]
        train_stems = {Path(frame["file_path"]).stem for frame in train_frames}
        val_stems = [Path(frame["file_path"]).stem for frame in val_frames]
        if len(train_stems) != len(train_frames) or len(set(val_stems)) != len(val_stems):
            raise RuntimeError("Dataset split frame stems must be unique")
        if train_stems & set(val_stems):
            raise RuntimeError("transforms_train.json and transforms_val.json share duplicate frames")
        return [*train_frames, *val_frames], val_frames
    return _read_json(single)["frames"], None


def build_eval_report(
    dish: str, dataset_dir: Path, brush_out: Path, eval_split_every: int, out_dir: Path,
    video_prep_manifest: Path | None = None, orbit_video: Path | None = None,
    *, allow_partial: bool = False, background: str = "black",
) -> dict:
    if background not in ("black", "white"):
        raise ValueError("background must be black or white")
    frames, val_frames = _load_dataset_split(dataset_dir)
    conversion_path = dataset_dir / "conversion_report.json"
    if conversion_path.exists() or conversion_path.is_symlink():
        _ensure_local_dataset_file(dataset_dir.resolve(), conversion_path)
    conversion = _read_json(conversion_path) if conversion_path.is_file() else {}
    if "eval_split_every" in conversion and conversion["eval_split_every"] != eval_split_every:
        raise RuntimeError("eval_split_every disagrees with conversion_report.json")
    if val_frames is not None:
        expected_eval_stems = [Path(frame["file_path"]).stem for frame in val_frames]
        if "eval_frame_stems" in conversion and conversion["eval_frame_stems"] != expected_eval_stems:
            raise RuntimeError("eval_frame_stems disagrees with transforms_val.json")
    else:
        expected_eval_stems = conversion.get("eval_frame_stems")
    step, renders = discover_eval_renders(brush_out)
    strategy, pairs = match_eval_renders(renders, frames, eval_split_every, expected_eval_stems, allow_partial)
    expected_count = len(expected_eval_stems) if expected_eval_stems is not None else len(frames[::eval_split_every])
    selected = {i * len(pairs) // 4 for i in range(4)}
    views, sheet_rows = [], []
    for index, (frame, path) in enumerate(pairs):
        gt, render, mask = _load_pair(dataset_dir, frame, path, background)
        view = {
            "frame_number": frame["frame_number"],
            "frame_stem": Path(frame["file_path"]).stem,
            "render_path": str(path.relative_to(brush_out)),
            **compute_pair_metrics(gt, render, mask),
        }
        views.append(view)
        if index in selected:
            sheet_rows.append((view, _diagnostic_tiles(gt, render)))

    summary = {}
    for metric in ("full_psnr_db", "fg_psnr_db", "full_ssim", "fg_ssim", "fg_delta_e"):
        values = [view[metric] for view in views]
        summary[metric] = {
            "mean": float(np.mean(values)), "median": float(np.median(values)),
            "min": min(values), "max": max(values), "p10": float(np.percentile(values, 10)),
        }
    video_prep = _read_json(video_prep_manifest) if video_prep_manifest else None
    if orbit_video is not None and not orbit_video.is_file():
        raise RuntimeError(f"Orbit video does not exist: {orbit_video}")
    out_dir.mkdir(parents=True, exist_ok=True)
    sheet_name = "track2_eval_sheet.png"
    _write_eval_sheet(out_dir / sheet_name, sheet_rows)
    report = {
        "publication_eligible": False, "dish": dish, "matching_strategy": strategy,
        "eval_views_count": len(views), "expected_eval_views_count": expected_count,
        "eval_checkpoint_step": step, "allow_partial": bool(allow_partial), "background": background,
        "summary": summary, "views": views,
        "dataset_stats": {
            "valid_frames": conversion.get("valid_frames", len(frames)),
            "mean_mask_hit_rate": conversion.get("mean_mask_hit_rate"),
            "initial_point_count": conversion.get("initial_point_count"),
        },
        "video_prep_stats": {
            key: video_prep.get(key) for key in (
                "source_type", "target_frames", "total_candidate_frames", "selected_count", "counts_by_triage",
            )
        } if video_prep is not None else None,
        "ply_stats": _ply_stats(brush_out),
        "orbit_video": os.path.relpath(orbit_video, out_dir) if orbit_video else None,
        "eval_sheet": sheet_name,
    }
    (out_dir / "track2_metrics.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def _track1_reports(root: Path | None) -> list[dict]:
    if not root:
        return []
    root_res = root.resolve()
    reports = []
    for path in sorted(root.rglob("qa_report.json")):
        if path.is_symlink() or not path.resolve().is_relative_to(root_res):
            raise RuntimeError(f"Track 1 QA report escapes root: {path}")
        qa = _read_json(path)
        checks = qa.get("checks", {})
        fidelity = checks.get("photo_fidelity", {})
        reports.append({
            "dish": path.parent.name, "verdict": qa.get("verdict"),
            "iou": fidelity.get("silhouette_iou"), "ssim": fidelity.get("ssim"),
            "delta_e": fidelity.get("delta_e"),
            "relit_p95": checks.get("relighting", {}).get("relit_p95_diff"),
        })
    return reports


def build_studio(dishes_root: Path, out_html: Path, track1_root: Path | None = None) -> Path:
    paths = sorted(set(dishes_root.glob("reports/*/track2_metrics.json")) |
                   set(dishes_root.glob("*/track2_metrics.json")))
    if not paths:
        raise RuntimeError(f"No Track 2 metrics under {dishes_root}")
    dishes_root_res = dishes_root.resolve()
    dishes = []
    for path in paths:
        report_dir = path.parent.resolve()
        if not report_dir.is_relative_to(dishes_root_res) or not path.resolve().is_relative_to(dishes_root_res):
            raise RuntimeError(f"Track 2 report escapes dishes root: {path}")
        report = _read_json(path)
        for key, root in (("eval_sheet", report_dir), ("orbit_video", dishes_root_res)):
            if report.get(key):
                asset = (report_dir / report[key]).resolve()
                if not asset.is_relative_to(root):
                    raise RuntimeError(f"Track 2 {key} escapes its allowed directory: {asset}")
                # Encode URL-significant filename characters, keeping these local relative URLs.
                report[key] = quote(os.path.relpath(asset, out_html.parent.resolve()))
        report["publication_eligible"] = False
        dishes.append(report)
    manifest = json.dumps({
        "publication_eligible": False, "dishes": dishes, "track1": _track1_reports(track1_root),
    }, indent=2, ensure_ascii=False)
    for character in "<>&\u2028\u2029":
        manifest = manifest.replace(character, f"\\u{ord(character):04x}")
    out_html.parent.mkdir(parents=True, exist_ok=True)
    out_html.write_text(STUDIO_HTML.replace("TRACK2_MANIFEST_JSON", manifest), encoding="utf-8")
    return out_html


STUDIO_HTML = """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PeekaPlate Food3D Track 2 Studio</title>
<style>
  :root { color-scheme: dark; font: 16px/1.5 system-ui, sans-serif; background: #141c23; color: #eff5f6; }
  body { max-width: 1240px; margin: auto; padding: 24px; }
  header, section, article { padding: 20px; margin-bottom: 20px; background: #202c35; border-radius: 12px; }
  header p { color: #ffd293; }
  h1, h2, h3, p { margin-top: 0; }
  img, video { width: 100%; height: auto; border-radius: 8px; align-self: start; }
  .media { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 350px), 1fr)); gap: 16px; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #42515c; text-align: left; padding: 8px; }
  button { font: inherit; color: #aff5e1; background: #253640; border: 1px solid #6a8991; border-radius: 6px; padding: 4px 8px; cursor: pointer; }
</style>
<header>
  <h1>PeekaPlate Food3D Track 2 Studio</h1>
  <p>R&D ONLY — publication_eligible: false (ADR 0004)</p>
  <div>$0 Local RTX 3060 Vulkan + Brush v0.3.0</div>
</header>
<main>
  <section>
    <h2>Track 2 held-out evaluation</h2>
    <div class="scroll"><table id="summary"></table></div>
  </section>
  <article id="dish"></article>
  <section>
    <h2>Track 1 and Track 2 comparison</h2>
    <p>Track 1 evaluates single-photo GLBs against the source photo and checks geometry, materials
    and relighting. Track 2 evaluates real multi-view 3DGS against held-out camera frames.
    The two protocols use different reference views, so their image scores cannot rank the tracks directly.</p>
    <div class="scroll" id="track1"></div>
  </section>
</main>
<script id="track2-manifest" type="application/json">TRACK2_MANIFEST_JSON</script>
<script>
  const manifest = JSON.parse(document.getElementById('track2-manifest').textContent);
  const element = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const number = (value, decimals) => Number.isFinite(value) ? value.toFixed(decimals) : '—';
  function tableHead(table, columns) {
    const row = table.createTHead().insertRow();
    for (const name of columns) {
      const th = element('th', name);
      th.scope = 'col';
      row.append(th);
    }
    return table.createTBody();
  }
  const panel = document.getElementById('dish');
  const buttons = [];
  function selectDish(index) {
    const dish = manifest.dishes[index];
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
    const media = element('div');
    media.className = 'media';
    if (dish.eval_sheet) {
      const image = element('img');
      image.setAttribute('src', dish.eval_sheet);
      image.setAttribute('alt', 'Held-out evaluation sheet for ' + dish.dish);
      media.append(image);
    }
    if (dish.orbit_video) {
      const video = element('video');
      for (const attribute of ['controls', 'loop', 'muted', 'playsinline']) video.setAttribute(attribute, '');
      video.muted = true;
      video.preload = 'metadata';
      video.setAttribute('src', dish.orbit_video);
      media.append(video);
    }
    panel.replaceChildren(element('h2', dish.dish), media);
  }
  const summary = tableHead(document.getElementById('summary'), [
    'Dish', 'Scored / expected', 'Full PSNR (dB)', 'FG PSNR (dB)', 'Full SSIM', 'FG SSIM', 'FG ΔE', 'PLY (MB)'
  ]);
  manifest.dishes.forEach((dish, index) => {
    const row = summary.insertRow();
    const button = element('button', dish.dish);
    button.addEventListener('click', () => selectDish(index));
    buttons.push(button);
    row.insertCell().append(button);
    const score = (key, decimals) => number(dish.summary?.[key]?.mean, decimals);
    for (const value of [
      dish.eval_views_count + ' / ' + (dish.expected_eval_views_count ?? '—'),
      score('full_psnr_db', 1), score('fg_psnr_db', 1), score('full_ssim', 3),
      score('fg_ssim', 3), score('fg_delta_e', 1), number(dish.ply_stats?.ply_mb, 2)
    ]) row.insertCell().textContent = value;
  });
  selectDish(0);
  const comparison = document.getElementById('track1');
  if (manifest.track1.length) {
    const table = element('table');
    const body = tableHead(table, ['Track 1 dish', 'QA verdict', 'Photo IoU', 'Photo SSIM', 'Photo ΔE', 'Relighting p95']);
    for (const report of manifest.track1) {
      const row = body.insertRow();
      for (const value of [
        report.dish, report.verdict ?? '—', number(report.iou, 3),
        number(report.ssim, 3), number(report.delta_e, 1), number(report.relit_p95, 1)
      ]) row.insertCell().textContent = value;
    }
    comparison.append(table);
  } else {
    comparison.append(element('p', 'No Track 1 QA reports supplied.'));
  }
</script>
</html>
"""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    evaluate = commands.add_parser("eval")
    evaluate.add_argument("--dish", required=True)
    evaluate.add_argument("--dataset-dir", type=Path, required=True)
    evaluate.add_argument("--brush-out", type=Path, required=True)
    evaluate.add_argument("--eval-split-every", type=int, required=True)
    evaluate.add_argument("--allow-partial", action="store_true")
    evaluate.add_argument("--background", choices=("black", "white"), default="black")
    evaluate.add_argument("--out-dir", type=Path, required=True)
    evaluate.add_argument("--video-prep-manifest", type=Path)
    evaluate.add_argument("--orbit-video", type=Path)
    studio = commands.add_parser("studio")
    studio.add_argument("--dishes-root", type=Path, required=True)
    studio.add_argument("--out-html", type=Path, required=True)
    studio.add_argument("--track1-root", type=Path)
    args = vars(parser.parse_args(argv))
    try:
        if args.pop("command") == "eval":
            build_eval_report(**args)
            print(args["out_dir"] / "track2_metrics.json")
        else:
            print(build_studio(**args))
    except (RuntimeError, ValueError, OSError) as exc:
        parser.exit(1, f"{exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
