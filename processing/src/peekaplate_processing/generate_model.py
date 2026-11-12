"""Private, resumable cutout → Tripo → validated GLB review pipeline (no publication)."""
import argparse
import fcntl
import hashlib
import io
import json
import os
import struct
import tempfile
import time
from pathlib import Path
from uuid import UUID

from PIL import Image

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.tripo import MAX_GLB_BYTES, MODEL, TripoClient, TripoRejected, identifier

MAX_IMAGE_BYTES = 10_000_000
MAX_JSON_BYTES = 1_000_000
TERMINAL = {'failed', 'cancelled', 'banned', 'expired'}
OPTIONS = {'model': MODEL, 'texture': True, 'pbr': True,
           'texture_quality': 'standard', 'texture_version': 'v3.0-20250812',
           'face_limit': 50_000, 'enable_image_autofix': False,
           'texture_alignment': 'original_image', 'orientation': 'align_image', 'auto_size': False}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path, limit):
    if Path(path).is_symlink():
        raise ExtractionError('Review inputs must be regular local files, not symlinks.')
    with Path(path).open('rb') as stream:
        data = stream.read(limit + 1)
    if not data or len(data) > limit:
        raise ExtractionError('Input is empty or exceeds its byte limit.')
    return data


def atomic(path, data):
    fd, temporary = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save(directory, job):
    atomic(directory / 'job.json', (json.dumps(job, indent=2) + '\n').encode())


def validate_png(data):
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format != 'PNG' or image.mode != 'RGBA' or not 256 <= min(image.size) <= max(image.size) <= 2048:
                raise ValueError()
            image.load()
            low, high = image.getchannel('A').getextrema()
            if low != 0 or high == 0:
                raise ValueError()
            return image.size
    except (ValueError, OSError, Image.DecompressionBombError):
        raise ExtractionError('Source must be a 256–2048px transparent RGBA cutout PNG.') from None


def validate_glb(data):
    """Structural validation, not visual fidelity approval or a complete glTF validator."""
    if len(data) < 28 or len(data) > MAX_GLB_BYTES or data[:4] != b'glTF':
        raise ExtractionError('Invalid or oversized GLB.')
    version, length = struct.unpack_from('<II', data, 4)
    if version != 2 or length != len(data):
        raise ExtractionError('GLB header or length mismatch.')
    offset, chunks = 12, []
    while offset < len(data):
        if offset + 8 > len(data):
            raise ExtractionError('Truncated GLB chunk.')
        size, kind = struct.unpack_from('<II', data, offset)
        offset += 8
        if size % 4 or offset + size > len(data):
            raise ExtractionError('Invalid GLB chunk length.')
        chunks.append((kind, data[offset:offset + size]))
        offset += size
    if len(chunks) != 2 or chunks[0][0] != 0x4E4F534A or chunks[1][0] != 0x004E4942:
        raise ExtractionError('Expected a self-contained GLB JSON and BIN pair.')
    if len(chunks[0][1]) > 5_000_000:
        raise ExtractionError('GLB JSON exceeds its byte limit.')
    try:
        doc = json.loads(chunks[0][1])
        if doc['asset']['version'] != '2.0' or not doc.get('meshes') or not doc.get('scenes'):
            raise ValueError()
        buffers = doc['buffers']
        if len(buffers) != 1 or not 0 < buffers[0]['byteLength'] <= len(chunks[1][1]):
            raise ValueError()
        if len(chunks[1][1]) - buffers[0]['byteLength'] > 3:
            raise ValueError()
        views, accessors = doc['bufferViews'], doc['accessors']
        def at(items, index):
            if type(index) is not int or not 0 <= index < len(items):
                raise ValueError()
            return items[index]
        for view in views:
            if (view['buffer'] != 0 or view.get('byteOffset', 0) < 0 or view['byteLength'] <= 0
                    or view.get('byteOffset', 0) + view['byteLength'] > buffers[0]['byteLength']):
                raise ValueError()
        for mesh in doc['meshes']:
            if not mesh.get('primitives'):
                raise ValueError()
            for primitive in mesh['primitives']:
                position = at(accessors, primitive['attributes']['POSITION'])
                view = at(views, position['bufferView'])
                count = position['count']
                stride = view.get('byteStride', 12)
                if (position['type'] != 'VEC3' or position['componentType'] != 5126
                        or type(count) is not int or count < 3 or stride < 12
                        or position.get('byteOffset', 0) < 0
                        or position.get('byteOffset', 0) + (count - 1) * stride + 12 > view['byteLength']):
                    raise ValueError()
        for scene in doc['scenes']:
            if not scene.get('nodes'):
                raise ValueError()
            for node in scene['nodes']:
                at(doc['nodes'], node)
        # No external textures/buffers, data URIs or extension URLs in private output.
        def check(value):
            if isinstance(value, dict):
                if 'uri' in value or 'url' in value:
                    raise ValueError()
                for child in value.values():
                    check(child)
            elif isinstance(value, list):
                for child in value:
                    check(child)
        check(doc)
        return {'meshes': len(doc['meshes']), 'bytes': len(data), 'sha256': digest(data)}
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
        raise ExtractionError('GLB must contain a scene, mesh and embedded resources.') from None


def prepare(review_dir, output_dir, source='cutout'):
    review_dir, output_dir = Path(review_dir), Path(output_dir)
    if source not in ('cutout', 'presentation'):
        raise ExtractionError('Choose cutout or presentation explicitly.')
    raw = read(review_dir / 'review-manifest.json', MAX_JSON_BYTES)
    try:
        review = json.loads(raw)
        if review['provenance']['recipe'] != 'review-preview-v1' or review['publication']['eligible'] is not False:
            raise ValueError()
        if review['review']['status'] != 'needs_review':
            raise ValueError()
        for key in ('dish_id', 'revision_id'):
            UUID(review['dish'][key])
        filename = source + '.png'
        image = read(review_dir / filename, MAX_IMAGE_BYTES)
        fallback = read(review_dir / 'fallback.jpg', MAX_IMAGE_BYTES)
        for name, data in [(filename, image), ('fallback.jpg', fallback)]:
            if review['files'][name]['sha256'] != digest(data) or review['files'][name]['bytes'] != len(data):
                raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise ExtractionError('Invalid PR25 review manifest or source hash/identity mismatch.') from None
    width, height = validate_png(image)
    job = {'schema_version': 1, 'recipe': 'tripo-review-v1', 'provider': 'tripo',
           'status': 'prepared', 'task_id': None, 'dish': review['dish'],
           'source': {'review_asset_id': review['asset_id'], 'review_manifest_sha256': digest(raw),
                      'variant': source, 'sha256': digest(image), 'bytes': len(image),
                      'width': width, 'height': height},
           'fallback': {'sha256': digest(fallback), 'bytes': len(fallback)},
           'options': dict(OPTIONS), 'review': {'status': 'needs_review'},
           'publication': {'eligible': False},
           'warnings': ['Generated geometry may invent unseen food or plate surfaces.',
                        'Not a calibrated serving-size measurement; review before any use.']}
    output_dir.mkdir(parents=True, exist_ok=False)
    atomic(output_dir / 'source.png', image)
    atomic(output_dir / 'fallback.jpg', fallback)
    save(output_dir, job)
    atomic(output_dir / 'index.html', REVIEW_HTML.encode())
    return job


def run(directory, client, *, timeout=600, interval=5, clock=time.monotonic, sleep=time.sleep):
    directory = Path(directory)
    if not 0 < timeout <= 1800 or not 1 <= interval <= 60:
        raise ExtractionError('Wait must be 1–1800 seconds; poll interval must be 1–60 seconds.')
    # Advisory process lock released even on crashes. Concurrent starts cannot submit twice.
    with (directory / '.run.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ExtractionError('This job is already running in another process.') from None
        job = json.loads(read(directory / 'job.json', MAX_JSON_BYTES))
        if job.get('recipe') != 'tripo-review-v1' or job.get('options') != OPTIONS or job.get('publication') != {'eligible': False}:
            raise ExtractionError('Invalid local job configuration.')
        source = read(directory / 'source.png', MAX_IMAGE_BYTES)
        fallback = read(directory / 'fallback.jpg', MAX_IMAGE_BYTES)
        if (digest(source) != job['source']['sha256'] or digest(fallback) != job['fallback']['sha256']):
            raise ExtractionError('Saved source or fallback hash mismatch.')
        validate_png(source)
        if job['status'] == 'ready':
            result = validate_glb(read(directory / 'model.glb', MAX_GLB_BYTES))
            if result != job['output']:
                raise ExtractionError('Saved model hash mismatch.')
            return job
        if job['status'] in TERMINAL:
            return job
        if job['status'] in ('submitting', 'submission_unknown'):
            raise ExtractionError('Submission outcome unknown. Reconcile in Tripo; do not automatically resubmit.')
        if not job.get('task_id'):
            if job['status'] not in ('prepared', 'uploading'):
                raise ExtractionError('Job state lacks a task ID; manual reconciliation required.')
            job.pop('error_code', None)
            try:
                if client.balance() == 0:
                    raise TripoRejected(2010)
                job['status'] = 'uploading'
                save(directory, job)
                token = client.upload(source)
            except TripoRejected as error:
                job['status'] = 'prepared'
                job['error_code'] = error.reason
                save(directory, job)
                return job
            job['status'] = 'submitting'
            save(directory, job)  # Persist BEFORE the potentially billable call.
            try:
                task_id = client.submit(token, job['options'])
                job['task_id'] = identifier(task_id)
            except TripoRejected as error:
                job['status'] = 'prepared'
                job['error_code'] = error.reason
                save(directory, job)
                return job
            except Exception:
                job['status'] = 'submission_unknown'
                save(directory, job)
                raise ExtractionError('Submission outcome unknown; job was not automatically retried.') from None
            job['status'] = 'queued'
            save(directory, job)
        deadline = clock() + timeout
        while clock() < deadline:
            task = client.task(job['task_id'], timeout=min(30, max(0.1, deadline - clock())))
            if task.get('task_id') != job['task_id'] or task.get('type') != 'image_to_model':
                raise ExtractionError('Tripo task identity or type mismatch.')
            state = task.get('status')
            job['status'] = state if state in TERMINAL | {'queued', 'running', 'success'} else 'waiting'
            progress = task.get('progress')
            if type(progress) is int and 0 <= progress <= 100:
                job['progress'] = progress
            save(directory, job)
            if state in TERMINAL:
                return job
            if state == 'success':
                # A download failure keeps the task ID for a fresh URL on the next run.
                data = client.download(task.get('output', {}).get('model_url'))
                result = validate_glb(data)
                atomic(directory / 'model.glb', data)
                job['output'] = result
                job['status'] = 'ready'
                save(directory, job)
                return job
            sleep(min(interval, max(0, deadline - clock())))
        job['status'] = 'waiting'
        save(directory, job)
        return job


REVIEW_HTML = '''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PeekaPlate · 3D review</title>
<style>body{margin:24px auto;padding:0 20px;max-width:760px;background:#2a2d36;color:#fafafa;font:16px system-ui}
model-viewer,img{width:100%;height:450px;object-fit:contain}button,a{color:inherit;margin:8px;padding:10px}
button{background:#383d49;border:1px solid #aaa;border-radius:8px}[hidden]{display:none!important}</style>
<h1>Dish 3D review</h1><p>Private draft · needs review · not published</p>
<p id="status" role="status">Loading job status…</p>
<img id="fallback" src="source.png" alt="Original input cutout; retained while 3D is unavailable">
<model-viewer hidden id="model" src="model.glb" loading="eager" camera-controls touch-action="pan-y"
 interaction-prompt-style="basic" alt="Unreviewed generated dish geometry"></model-viewer>
<button id="compare" hidden>Show source cutout</button><button id="reset" hidden>Reset view</button>
<p><a href="source.png">Input PNG</a> · <a href="fallback.jpg">Original photo</a> · <a id="download" hidden href="model.glb" download>Download GLB</a></p>
<p>Check ingredients, plate shape, underside and invented surfaces. This model is not a portion measurement.</p>
<script type="module">
const status = document.querySelector('#status'), model = document.querySelector('#model');
const fallback = document.querySelector('#fallback'), compare = document.querySelector('#compare');
const reset = document.querySelector('#reset');
const unavailable = () => { model.hidden=true; fallback.hidden=false; compare.hidden=true;
 reset.hidden=true; status.textContent='3D unavailable. Showing the source cutout.'; };
try {
 const job=await (await fetch('job.json',{cache:'no-store'})).json();
 status.textContent='Generation: '+job.status+'. Source cutout remains available.';
 if(job.status==='ready') {
  document.querySelector('#download').hidden=false;
  const timer=setTimeout(unavailable,30000);
  model.addEventListener('load',()=>{clearTimeout(timer);model.hidden=false;fallback.hidden=true;
   compare.hidden=false;reset.hidden=false;status.textContent='Drag to rotate. Generated draft needs review.';});
  model.addEventListener('error',()=>{clearTimeout(timer);unavailable();});
  try { await import('https://ajax.googleapis.com/ajax/libs/model-viewer/4.4.0/model-viewer.min.js'); }
  catch { clearTimeout(timer);unavailable(); }
 }
} catch { unavailable(); }
compare.onclick=()=>{model.hidden=!model.hidden;fallback.hidden=!model.hidden;
 compare.textContent=model.hidden?'Show generated 3D':'Show source cutout';};
reset.onclick=()=>{model.cameraOrbit='0deg 75deg 105%';model.cameraTarget='auto auto auto';model.fieldOfView='auto';};
</script></html>'''


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prep = commands.add_parser('prepare', help='Verify/copy a PR25 review input; no network or credits.')
    prep.add_argument('--review-dir', type=Path, required=True)
    prep.add_argument('--output-dir', type=Path, required=True)
    prep.add_argument('--source', choices=['cutout', 'presentation'], default='cutout')
    execute = commands.add_parser('run', help='Submit once or resume an existing Tripo task.')
    execute.add_argument('--job-dir', type=Path, required=True)
    execute.add_argument('--wait-seconds', type=int, default=600)
    args = parser.parse_args(argv)
    try:
        if args.command == 'prepare':
            job = prepare(args.review_dir, args.output_dir, args.source)
        else:
            job = run(args.job_dir, TripoClient(os.getenv('TRIPO_API_KEY')),
                      timeout=args.wait_seconds)
        print(json.dumps({'status': job['status'], 'task_id': job['task_id'],
                          'review_status': 'needs_review', 'publication_eligible': False,
                          'error_code': job.get('error_code')}))
        if args.command == 'run' and job.get('error_code'):
            return 2
        return 0 if job['status'] in ('prepared', 'ready') else 3 if job['status'] not in TERMINAL else 2
    except (ExtractionError, OSError, ValueError, KeyError, TypeError):
        print(json.dumps({'status': 'error', 'message': 'Generation did not complete. Inspect local job state; never blindly resubmit.'}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
