"""Private upload adapter, registered on the existing authenticated review service."""
import base64
import json
import tempfile
import threading
from pathlib import Path
from uuid import UUID

from fastapi import Request
from starlette.concurrency import run_in_threadpool
from peekaplate_processing.portion_ingestion import ingest_dish_photo
from peekaplate_processing.sources import MAX_SOURCE_BYTES


def register_portion_routes(app, *, authorized, reply, root, processor=ingest_dish_photo):
    slots = threading.BoundedSemaphore(1)

    @app.post('/v1/portion-uploads/{dish_id}/{revision_id}')
    async def upload(dish_id: UUID, revision_id: UUID, request: Request):
        if not authorized(request):
            return reply({'error': 'unauthorized'}, 401)
        raw_width = request.headers.get('x-serving-width-mm')
        if raw_width is not None and (not raw_width.isascii() or not raw_width.isdigit() or len(raw_width) > 4 or not 30 <= int(raw_width) <= 1000):
            return reply({'error': 'invalid_serving_width'}, 422)
        serving_width = int(raw_width) if raw_width is not None else None
        raw_plate = request.headers.get('x-plate-calibration')
        try:
            if raw_plate is not None and len(raw_plate) > 2048:
                return reply({'error': 'calibration_too_large'}, 413)
            plate = json.loads(raw_plate) if raw_plate is not None else None
        except ValueError:
            return reply({'error': 'invalid_plate_calibration'}, 422)
        if not slots.acquire(blocking=False):
            return reply({'error': 'busy'}, 429)
        try:
            body = bytearray()
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_SOURCE_BYTES:
                    return reply({'error': 'request_too_large'}, 413)
                body.extend(chunk)
            if not body:
                return reply({'error': 'empty_photo'}, 422)
            def process():
                with tempfile.TemporaryDirectory(prefix='portion-upload-') as temporary:
                    source = Path(temporary) / 'photo'
                    source.write_bytes(body)
                    directory, record = processor(input_path=source, dish_id=dish_id,
                        revision_id=revision_id, output_root=root / 'portions',
                        capture_evidence='Private local photo upload; review required', serving_width_mm=serving_width, plate_calibration=plate)
                    # Delivery is bounded by the 180KB portion contract. Never expose disk paths.
                    layers = {}
                    if record['portion']:
                        for layer in record['portion']['layers']:
                            name = layer['url'].rsplit('/', 1)[-1]
                            layers[layer['url']] = base64.b64encode((directory / name).read_bytes()).decode('ascii')
                    return {'status': record['status'], 'reason': record['reason'],
                        'portion': record['portion'], 'layers': layers,
                        'review_status': 'needs_review', 'publication_eligible': False}
            try:
                return reply(await run_in_threadpool(process))
            except Exception:
                return reply({'error': 'photo_processing_failed'}, 422)
        finally:
            slots.release()
