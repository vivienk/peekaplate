"""Photo ingestion -> bounded 2.5D layers -> review-only dish/revision binding.

Transparent input is reused; opaque photos are segmented locally without a supplied mask.
This processor never invents food, approves assets, or replaces a published bundle.
"""
import argparse
import hashlib
import io
import json
import shutil
import tempfile
from pathlib import Path
from uuid import UUID

from PIL import Image

from peekaplate_processing.assets import read_source
from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.spatial import open_layer_image

RECIPE = 'photo-to-portion-v2'
MAX_BUDGET = 180_000


def digest(data):
    return hashlib.sha256(data).hexdigest()


def ingest_dish_photo(*, input_path, dish_id, revision_id, output_root,
                      capture_evidence, mask_path=None, expected_sha256=None,
                      budget_bytes=MAX_BUDGET, serving_width_mm=None):
    """Create/reuse an immutable review artifact from one ingested photo.

    Mask dimensions refer to the EXIF-oriented source, not a resized T0 variant.
    Callers retain tenant authorization; supplied IDs are validated, not authorized.
    """
    dish_id, revision_id = str(UUID(str(dish_id))), str(UUID(str(revision_id)))
    if (not isinstance(capture_evidence, str) or not capture_evidence.strip() or len(capture_evidence) > 4096
            or type(budget_bytes) is not int or not 0 < budget_bytes <= MAX_BUDGET):
        raise ExtractionError('Evidence and a delivery budget up to 180000 bytes are required.')
    if serving_width_mm is not None and (type(serving_width_mm) is not int or not 30 <= serving_width_mm <= 1000):
        raise ExtractionError('Owner serving width must be an integer from 30 to 1000 mm.')
    data = read_source(Path(input_path))
    source_hash = digest(data)
    if expected_sha256 is not None and source_hash != expected_sha256:
        raise ExtractionError('Photo source hash conflict.')
    mask_bytes = read_source(Path(mask_path)) if mask_path else None
    image_format, has_alpha, image = open_layer_image(data)
    automatic = None
    segmentation_failed = False
    if not mask_bytes:
        with image.convert('RGBA') as probe:
            with probe.getchannel('A') as alpha:
                needs_cutout = alpha.getextrema()[0] == 255
        if needs_cutout:
            from peekaplate_processing.cutout import automatic_mask
            try:
                mask_bytes, automatic = automatic_mask(image)
            except ExtractionError:
                segmentation_failed = True
    identity = {'recipe': RECIPE, 'dish_id': dish_id, 'revision_id': revision_id,
                'source_sha256': source_hash, 'mask_sha256': digest(mask_bytes) if mask_bytes else None,
                'budget_bytes': budget_bytes, 'capture_evidence': capture_evidence,
                'serving_width_mm': serving_width_mm, 'segmentation': automatic, 'segmentation_failed': segmentation_failed}
    asset_id = 'portion_' + digest(json.dumps(identity, sort_keys=True).encode())[:32]
    prefix = f'https://portion-ingestion.invalid/{asset_id}/'
    files = {'photo.' + {'PNG': 'png', 'WEBP': 'webp', 'JPEG': 'jpg'}[image_format]: data}
    reason, portion = ('automatic_cutout_unavailable' if segmentation_failed else None), None
    try:
        rgba = image.convert('RGBA')
        try:
            if mask_bytes:
                try:
                    _, _, mask = open_layer_image(mask_bytes)
                except ExtractionError:
                    reason = 'invalid_mask'
                else:
                    try:
                        if mask.mode != 'L' or mask.size != image.size:
                            reason = 'invalid_mask'
                        else:
                            rgba.putalpha(mask)
                    finally:
                        mask.close()

            alpha = rgba.getchannel('A')
            low, high = alpha.getextrema()
            foreground_bounds = alpha.point(lambda value: 255 if value >= 128 else 0).getbbox()
            alpha.close()
            if reason is None and (low != 0 or high == 0):
                reason = 'cutout_requires_visible_subject_and_transparent_background'
            if reason is None:
                # Reuse exact transparent WebP bytes if no orientation/resize/mask is needed.
                def candidates():
                    if image_format == 'WEBP' and not mask_bytes and max(image.size) <= 2048 and not image.getexif():
                        yield data, image.size
                    for edge in (640, 512, 384):
                        candidate = rgba.copy()
                        try:
                            candidate.thumbnail((edge, edge), Image.Resampling.LANCZOS)
                            for quality in (85, 75, 65):
                                buffer = io.BytesIO()
                                candidate.save(buffer, format='WEBP', quality=quality, method=6)
                                yield buffer.getvalue(), candidate.size
                        finally:
                            candidate.close()
                for foreground, (width, height) in candidates():
                    background = f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}"></svg>'.encode()
                    if len(foreground) + len(background) > budget_bytes:
                        continue
                    files.update({'dish.webp': foreground, 'background.svg': background})
                    portion = {'schema_version': 1, 'dish_id': dish_id, 'dish_revision_id': revision_id,
                               'width': width, 'height': height,
                               'motion': {'max_yaw_degrees': 3, 'max_pitch_degrees': 3},
                               'layers': [{'url': prefix + name, 'sha256': digest(files[name]),
                                           'size_bytes': len(files[name]), 'depth': depth}
                                          for name, depth in [('background.svg', 0), ('dish.webp', 1)]]}
                    if serving_width_mm is not None and foreground_bounds:
                        fraction = (foreground_bounds[2] - foreground_bounds[0]) / image.width
                        if fraction < 0.01:
                            portion = None
                            reason = 'foreground_too_small_to_measure'
                        else:
                            portion['physical_size'] = {'width_mm': serving_width_mm,
                                'foreground_width_fraction': fraction, 'source': 'owner'}
                    break
                if portion is None:
                    reason = reason or 'delivery_budget_exceeded'
        finally:
            rgba.close()
    finally:
        image.close()
    record = {'schema_version': 1, 'asset_id': asset_id, 'provenance': identity,
              'status': 'ready' if portion else 'fallback_retained', 'reason': reason,
              'review': {'status': 'needs_review'}, 'publication': {'eligible': False},
              'fallback': next(iter(files)), 'portion': portion,
              'files': {name: {'sha256': digest(value), 'size_bytes': len(value)} for name, value in files.items()}}
    payload = (json.dumps(record, indent=2) + '\n').encode()
    files['portion-ingestion.json'] = payload
    output_root = Path(output_root)
    output_root.mkdir(parents=True, exist_ok=True)
    final = output_root / asset_id

    def verify_existing():
        if not final.is_dir() or any(not (final / name).is_file() or (final / name).read_bytes() != value for name, value in files.items()):
            raise ExtractionError('Existing ingestion artifact failed integrity verification.')

    if final.exists():
        verify_existing()
        return final, record
    temporary = Path(tempfile.mkdtemp(prefix='.portion-', dir=output_root))
    try:
        for name, value in files.items():
            (temporary / name).write_bytes(value)
        try:
            temporary.rename(final)
        except OSError:
            if not final.exists():
                raise
            verify_existing()
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return final, record


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--dish-id')
    parser.add_argument('--revision-id')
    parser.add_argument('--capture-evidence')
    parser.add_argument('--mask', type=Path)
    parser.add_argument('--expected-sha256')
    parser.add_argument('--serving-width-mm', type=int)
    parser.add_argument('--budget-bytes', type=int, default=MAX_BUDGET)
    parser.add_argument('--output-root', required=True, type=Path)
    parser.add_argument('--batch', type=Path, help='JSON photo ingestion jobs; source paths are relative to source-root.')
    parser.add_argument('--source-root', type=Path)
    args = parser.parse_args(argv)
    try:
        if args.batch:
            if not args.source_root or args.batch.stat().st_size > 100_000:
                raise ExtractionError('Bounded batch and source-root required.')
            jobs = json.loads(args.batch.read_text())['jobs']
            if not isinstance(jobs, list) or not 1 <= len(jobs) <= 100:
                raise ExtractionError('Batch requires 1 to 100 photos.')
            source_root = args.source_root.resolve()
            results = []
            for job in jobs:
                source = (source_root / job['source']).resolve()
                if not source.is_relative_to(source_root):
                    raise ExtractionError('Photo path leaves source-root.')
                directory, record = ingest_dish_photo(input_path=source, dish_id=job['dish_id'],
                    revision_id=job['revision_id'], capture_evidence=job['capture_evidence'],
                    expected_sha256=job.get('sha256'), output_root=args.output_root,
                    budget_bytes=args.budget_bytes, serving_width_mm=job.get('serving_width_mm'))
                results.append({'source': job['source'], 'directory': str(directory), 'record': record})
            print(json.dumps({'results': results}))
            return 0
        if not all((args.input, args.dish_id, args.revision_id, args.capture_evidence)):
            raise ExtractionError('Input, dish identity, revision and evidence are required.')
        directory, record = ingest_dish_photo(input_path=args.input, dish_id=args.dish_id,
            revision_id=args.revision_id, capture_evidence=args.capture_evidence,
            mask_path=args.mask, expected_sha256=args.expected_sha256,
            budget_bytes=args.budget_bytes, output_root=args.output_root)
        print(json.dumps({'directory': str(directory), **record}))
        return 0
    except (ExtractionError, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
