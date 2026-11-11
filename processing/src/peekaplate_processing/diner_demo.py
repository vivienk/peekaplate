"""Build a development-only diner fixture using PR25's actual review processor.

This deliberately has no publication/upload path and accepts no generated candidate.
"""
import argparse
import hashlib
import io
import json
import tempfile
from pathlib import Path

from PIL import Image

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.review_preview import prepare_review_preview


def prepare_diner_demo(*, t0_manifest_path, mask_path, output_dir, capture_evidence):
    """Run the photo + supplied-mask recipe and export its verified output for DEV."""
    output_dir = Path(output_dir)
    if output_dir.exists():
        raise ExtractionError('Demo output already exists; choose a new directory.')
    with tempfile.TemporaryDirectory(prefix='peekaplate-diner-review-') as temporary:
        review_dir, review = prepare_review_preview(
            t0_manifest_path=t0_manifest_path, mask_path=mask_path,
            output_root=Path(temporary), capture_evidence=capture_evidence)
        with Image.open(review_dir / 'cutout.png') as cutout:
            width, height = cutout.size
            if max(width, height) > 2048:
                raise ExtractionError('Diner demo dimensions exceed 2048 pixels.')
            buffer = io.BytesIO()
            cutout.save(buffer, format='WEBP', quality=85, method=6)
            foreground = buffer.getvalue()
        with Image.new('RGB', (width, height), '#2a2d36') as background:
            buffer = io.BytesIO()
            background.save(buffer, format='WEBP', lossless=True)
            backdrop = buffer.getvalue()
        if len(foreground) + len(backdrop) > 180_000:
            raise ExtractionError('Diner demo layers exceed the 180 KB delivery budget.')
        files = {'dish.webp': foreground, 'background.webp': backdrop,
                 'photo.jpg': (review_dir / 'fallback.jpg').read_bytes()}
        layers = [{'url': 'https://portion-demo.invalid/' + name,
                   'sha256': hashlib.sha256(files[name]).hexdigest(),
                   'size_bytes': len(files[name]), 'depth': depth}
                  for name, depth in [('background.webp', 0), ('dish.webp', 0.7)]]
        # Keep the actual processor identity and review boundary alongside delivery data.
        record = {'recipe': 'diner-demo-from-pr25-review-v1',
                  'review_manifest': review,
                  'portion': {'schema_version': 1,
                              'dish_id': review['dish']['dish_id'],
                              'dish_revision_id': review['dish']['revision_id'],
                              'width': width, 'height': height,
                              'motion': {'max_yaw_degrees': 3, 'max_pitch_degrees': 3},
                              'layers': layers}}
        files['demo.json'] = (json.dumps(record, indent=2) + '\n').encode()
        output_dir.parent.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir()  # Create-only: never overwrite an existing fixture.
        for name, data in files.items():
            (output_dir / name).write_bytes(data)
    return record


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('t0-manifest', 'mask', 'output-dir'):
        parser.add_argument('--' + flag, required=True, type=Path)
    parser.add_argument('--capture-evidence', required=True)
    args = parser.parse_args(argv)
    try:
        record = prepare_diner_demo(t0_manifest_path=args.t0_manifest,
            mask_path=args.mask, output_dir=args.output_dir,
            capture_evidence=args.capture_evidence)
    except (ExtractionError, OSError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}))
        return 2
    print(json.dumps({'status': 'prepared', 'review_asset_id':
        record['review_manifest']['asset_id'], 'publication_eligible': False}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
