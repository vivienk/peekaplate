"""Bounded local segmentation. Only alpha changes; RGB food pixels are retained.

Inference runs in a disposable subprocess so hangs cannot occupy API workers forever.
U2NET_HOME may point to a pre-provisioned cache; rembg downloads public weights on first use.
"""
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image
from peekaplate_processing.errors import ExtractionError

MODEL = 'u2netp'
ENGINE = 'rembg-2.0.67'


def automatic_mask(image):
    with tempfile.TemporaryDirectory(prefix='peekaplate-cutout-') as directory:
        root = Path(directory)
        # Bound inference and its intermediate files while retaining source aspect ratio.
        with image.convert('RGB') as rgb:
            rgb.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            rgb.save(root / 'input.png')
        try:
            result = subprocess.run([sys.executable, '-m', 'peekaplate_processing.cutout', str(root)],
                timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env={**os.environ, 'OMP_NUM_THREADS': '2'}, check=False)
            if result.returncode or (root / 'mask.png').stat().st_size > 2_000_000:
                raise ValueError('Segmentation failed')
            metadata = json.loads((root / 'model.json').read_text())
            with Image.open(root / 'mask.png') as mask:
                if mask.mode != 'L' or max(mask.size) > 1024:
                    raise ValueError('Invalid model mask')
                mask.load()
                # Reject degenerate output; a retained photo remains the safe fallback.
                if mask.getextrema()[0] > 32 or mask.getextrema()[1] < 224:
                    raise ValueError('No separated subject')
                with mask.resize(image.size, Image.Resampling.LANCZOS) as full:
                    full = full.point(lambda x: 0 if x < 8 else 255 if x > 247 else x)
                    try:
                        output = io.BytesIO()
                        full.save(output, format='PNG')
                    finally:
                        full.close()
            return output.getvalue(), metadata
        except (OSError, ValueError, subprocess.TimeoutExpired):
            raise ExtractionError('Automatic cutout unavailable; original photo retained.') from None


def worker(directory):
    from rembg import new_session, remove
    from rembg.sessions.u2netp import U2netpSession
    root = Path(directory)
    session = new_session(MODEL, providers=['CPUExecutionProvider'])
    model = Path(U2netpSession.download_models())
    model_hash = hashlib.sha256(model.read_bytes()).hexdigest()
    with Image.open(root / 'input.png') as source:
        mask = remove(source, session=session, only_mask=True)
        try:
            mask.convert('L').save(root / 'mask.png')
        finally:
            mask.close()
    (root / 'model.json').write_text(json.dumps({'engine': ENGINE, 'model': MODEL,
        'model_sha256': model_hash, 'inference_edge': 1024}))


if __name__ == '__main__':
    worker(sys.argv[1])
