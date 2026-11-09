"""Offline, review-only photo + supplied mask + optional candidate PNG preview.

This is not a publication contract or an automatic segmentation/generation service.
"""
import argparse
import hashlib
import io
import json
import shutil
import tempfile
from pathlib import Path

from PIL import Image

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.presentation import validate_presentation_png
from peekaplate_processing.review_preview_html import REVIEW_HTML
from peekaplate_processing.spatial import (
    detail_variant, open_layer_image, read_detail_bytes, read_layer_bytes, read_t0_manifest,
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def prepare_review_preview(*, t0_manifest_path, mask_path, output_root, capture_evidence,
                           candidate_path=None, model_version=None, prompt_path=None,
                           budget_bytes=10_000_000):
    """Create-only local review artifact; mask must match the oriented T0 detail.

    A supplied generated candidate is untrusted. Invalid candidates produce a
    review artifact showing the original photograph, never an approved output.
    """
    if not capture_evidence.strip() or budget_bytes <= 0:
        raise ExtractionError('Capture evidence and a positive byte budget are required.')
    if candidate_path and (not model_version or not model_version.strip() or not prompt_path):
        raise ExtractionError('Candidate requires its actual generation prompt and model identifier.')
    manifest_bytes, t0 = read_t0_manifest(Path(t0_manifest_path))
    detail = detail_variant(t0)
    fallback = read_detail_bytes(Path(t0_manifest_path), t0, detail)
    mask_bytes = read_layer_bytes(Path(mask_path), 'Mask is missing or exceeds the input limit.')
    _, _, mask = open_layer_image(mask_bytes)
    try:
        if mask.mode != 'L' or mask.size != (detail.width, detail.height):
            raise ExtractionError('Supply a grayscale mask matching the oriented T0 detail dimensions.')
        low, high = mask.getextrema()
        if low != 0 or high == 0:
            raise ExtractionError('Mask needs transparent background (0) and a visible subject.')
        with Image.open(io.BytesIO(fallback)) as original:
            cutout = original.convert('RGBA')
        cutout.putalpha(mask)
        buffer = io.BytesIO()
        cutout.save(buffer, format='PNG')
        cutout_bytes = buffer.getvalue()
        cutout.close()
    finally:
        mask.close()
    files = {'fallback.jpg': fallback, 'cutout.png': cutout_bytes}
    warnings = ['Review only; caller evidence and identifiers are not publication approval.',
                'Supplied mask; no automatic segmentation. Shallow card motion, not 3D geometry.']
    candidate_hash = None
    prompt_hash = None
    mode = 'cutout'
    if candidate_path:
        prompt = read_layer_bytes(Path(prompt_path), 'Prompt is missing or exceeds the input limit.')
        prompt_hash = digest(prompt)
        data = read_layer_bytes(Path(candidate_path), 'Candidate is missing or exceeds the input limit.')
        candidate_hash = digest(data)
        # Bound decoding before invoking the existing presentation validator.
        try:
            _, _, decoded = open_layer_image(data)
            decoded.close()
            validate_presentation_png(data)
        except ExtractionError as error:
            mode = 'fallback'
            warnings.append(str(error))
        else:
            mode = 'generated'
            files['presentation.png'] = data
            warnings.append('AI-assisted candidate may alter food details; compare with the original.')
    identity = {'recipe': 'review-preview-v1', 't0_manifest_sha256': digest(manifest_bytes),
                'mask_sha256': digest(mask_bytes), 'candidate_sha256': candidate_hash,
                'prompt_sha256': prompt_hash, 'model_version': model_version,
                'capture_evidence': capture_evidence, 'html_sha256': digest(REVIEW_HTML.encode())}
    asset_id = 'review_' + digest(json.dumps(identity, sort_keys=True).encode())[:32]
    record = {'asset_id': asset_id, 'provenance': identity, 'dish': t0.dish.model_dump(mode='json'),
              'review': {'status': 'needs_review', 'warnings': warnings},
              'publication': {'eligible': False}, 'preview_mode': mode,
              'budget_bytes': budget_bytes,
              'files': {name: {'sha256': digest(data), 'bytes': len(data)} for name, data in files.items()}}
    selected = {'generated': 'presentation.png', 'cutout': 'cutout.png', 'fallback': 'fallback.jpg'}[mode]
    # Substitute only fixed internal filenames and enum values, never caller text.
    html = REVIEW_HTML.replace('__ASSET__', selected).replace('__MODE__', mode)
    files['index.html'] = html.encode()
    record['total_bytes'] = 0
    for _ in range(10):
        payload = (json.dumps(record, indent=2) + '\n').encode()
        total = sum(map(len, files.values())) + len(payload)
        if total == record['total_bytes']:
            break
        record['total_bytes'] = total
    files['review-manifest.json'] = payload
    if total > budget_bytes:
        raise ExtractionError('Review bundle exceeds its configured byte budget.')
    output_root = Path(output_root)
    output_root.mkdir(parents=True, exist_ok=True)
    final = output_root / asset_id
    if final.exists():
        raise ExtractionError('Review bundle already exists; existing output is never overwritten.')
    temporary = Path(tempfile.mkdtemp(prefix='.review-', dir=output_root))
    try:
        for name, data in files.items():
            (temporary / name).write_bytes(data)
        temporary.rename(final)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return final, record


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('t0-manifest', 'mask', 'output-root'):
        parser.add_argument('--' + flag, type=Path, required=True)
    parser.add_argument('--capture-evidence', required=True)
    parser.add_argument('--candidate', type=Path)
    parser.add_argument('--model-version')
    parser.add_argument('--prompt', type=Path)
    parser.add_argument('--budget-bytes', type=int, default=10_000_000)
    args = parser.parse_args(argv)
    try:
        directory, record = prepare_review_preview(
            t0_manifest_path=args.t0_manifest, mask_path=args.mask, output_root=args.output_root,
            capture_evidence=args.capture_evidence, candidate_path=args.candidate,
            model_version=args.model_version, prompt_path=args.prompt, budget_bytes=args.budget_bytes)
    except (ExtractionError, OSError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}))
        return 2
    print(json.dumps({'directory': str(directory), 'preview_mode': record['preview_mode'],
                      'review_status': 'needs_review', 'publication_eligible': False}))
    return 2 if record['preview_mode'] == 'fallback' else 0


if __name__ == '__main__':
    raise SystemExit(main())
