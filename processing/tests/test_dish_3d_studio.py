"""Offline unit tests for the interactive Three.js 3D Dish Studio generator and loopback server."""

from __future__ import annotations

import base64
from io import BytesIO
import json
from pathlib import Path
import struct
from tempfile import TemporaryDirectory
import unittest

from PIL import Image

from peekaplate_processing.dish_3d_studio import (
    DEFAULT_THREE_CDN_BASE,
    THREE_VERSION,
    _StudioRequestHandler,
    _resolve_safe_path,
    build_studio_files,
    build_studio_payload,
    create_studio_server,
    render_studio_html,
    resolve_default_three_base_url,
)


def _minimal_glb() -> bytes:
    json_bytes = json.dumps({'asset': {'version': '2.0'}}).encode('utf-8')
    while len(json_bytes) % 4:
        json_bytes += b' '
    bin_bytes = b'\x00\x00\x00\x00'
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    return (
        struct.pack('<4sII', b'glTF', 2, total)
        + struct.pack('<II', len(json_bytes), 0x4E4F534A)
        + json_bytes
        + struct.pack('<II', len(bin_bytes), 0x004E4942)
        + bin_bytes
    )


def _make_sample_results(
    root: Path,
    *,
    publication_eligible: bool = False,
    include_failed_openrouter: bool = False,
    include_raw_only_trellis: bool = False,
) -> Path:
    res = root / 'results'
    res.mkdir(parents=True, exist_ok=True)
    glb_raw = _minimal_glb()
    glb_mob = _minimal_glb()

    inputs = {}
    runs_3d = {}
    if include_failed_openrouter:
        inputs['00_openrouter_429'] = {
            'label': '00_openrouter_429',
            'image_status': 'failed',
            'image_error': 'HTTP 429',
            'artifacts': [],
        }

    for label in ('01_pizza', '02_tteokbokki'):
        d = res / label
        d.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (48, 36), (200, 120, 40)).save(d / 'input_image.png')
        Image.new('RGBA', (48, 36), (200, 120, 40, 255)).save(d / 'cutout_rgba.png')
        Image.new('RGB', (32, 24), (90, 90, 100)).save(d / 'triposr_hf_modes.png')
        Image.new('RGB', (32, 24), (110, 110, 120)).save(d / 'hunyuan3d_2mini_hf_modes.png')

        (d / 'triposr.glb').write_bytes(glb_raw)
        (d / 'triposr_mobile.glb').write_bytes(glb_mob)
        (d / 'hunyuan3d_2mini.glb').write_bytes(glb_raw)
        (d / 'hunyuan3d_2mini_mobile.glb').write_bytes(glb_mob)

        sha = 'a' * 64
        (d / 'job_manifest.json').write_text(
            json.dumps({
                'job_id': f'job-{label}',
                'dish_label': label,
                'publication_eligible': publication_eligible,
                'source_sha256': sha,
            }),
            encoding='utf-8',
        )
        inputs[label] = {
            'label': label,
            'image_source': 'user-uploaded-dataset',
            'image_status': 'success',
            'size': [48, 36],
            'source_sha256': sha,
            'cutout_metrics': {
                'plate_preserved': True,
                'plate_added_pct': 12.5,
                'plate_method': 'grounding_dino_sam',
                'fg_coverage_pct': 65.0,
            },
            'artifacts': [
                {'path': f'{label}/input_image.png', 'sha256': sha, 'bytes': 100},
                {'path': f'{label}/cutout_rgba.png', 'sha256': sha, 'bytes': 100},
                {'path': f'{label}/job_manifest.json', 'sha256': sha, 'bytes': 100},
            ],
        }
        for backend_slug, backend_name, appearance in (
            ('triposr', 'TripoSR', 'vertex_color'),
            ('hunyuan3d-2mini', 'Hunyuan3D-2mini', 'geometry_only'),
        ):
            stem = 'triposr' if backend_slug == 'triposr' else 'hunyuan3d_2mini'
            runs_3d[f'{label}/{backend_slug}'] = {
                'input_label': label,
                'backend': backend_name,
                'appearance': appearance,
                'device': 'cuda:0',
                'status': 'success',
                'metrics': {'vertices': 50000, 'faces': 100000, 'bytes': len(glb_raw), 'has_vertex_color': appearance == 'vertex_color'},
                'mobile_metrics': {'vertices': 17000, 'faces': 34000, 'bytes': len(glb_mob)},
                'artifacts': [
                    {'path': f'{label}/{stem}.glb'},
                    {'path': f'{label}/{stem}_mobile.glb'},
                    {'path': f'{label}/{stem}_hf_modes.png'},
                ],
            }

        if include_raw_only_trellis:
            (d / 'trellis2_4b.glb').write_bytes(glb_raw)
            runs_3d[f'{label}/trellis2-4b'] = {
                'input_label': label,
                'backend': 'TRELLIS.2-4B',
                'appearance': 'pbr_texture',
                'device': 'cuda:0',
                'status': 'success',
                'metrics': {'vertex_count': 42000, 'faces': 84000, 'bytes': len(glb_raw), 'has_texture': True},
                'artifacts': [{'path': f'{label}/trellis2_4b.glb'}],
            }

    manifest = {
        'schema_version': 1,
        'demo_label': 'Private single-photo 3D demo (not published T0/T1/T2 menu evidence)',
        'publication_eligible': publication_eligible,
        'plate_preservation_mode': 'preserve_plate',
        'inputs': inputs,
        'runs_3d': runs_3d,
    }
    (res / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return res


class Dish3DStudioTests(unittest.TestCase):
    def test_builds_http_and_standalone_interactive_studios_with_three_and_fallbacks(self):
        with TemporaryDirectory() as tmp:
            res = _make_sample_results(Path(tmp), include_failed_openrouter=True, include_raw_only_trellis=True)
            viewer_path, standalone_path = build_studio_files(res, three_base_url='/vendor/three')
            self.assertTrue(viewer_path.is_file())
            self.assertTrue(standalone_path.is_file())

            viewer_html = viewer_path.read_text(encoding='utf-8')
            self.assertIn('/vendor/three/build/three.module.js', viewer_html)
            self.assertIn('OrbitControls.js', viewer_html)
            self.assertIn('GLTFLoader.js', viewer_html)
            self.assertIn('RoomEnvironment.js', viewer_html)
            self.assertIn('publication_eligible=false', viewer_html)
            for token in (
                'data-shader="clay"',
                'data-shader="normal"',
                'data-shader="base_color"',
                'btn-wireframe',
                'data-view="compare"',
                'data-view="trellis2-4b"',
                'webglcontextlost',
                'clearViewportModel',
                'no-webgl',
                'disposeMaterial',
            ):
                self.assertIn(token, viewer_html)
            self.assertIn('01_pizza/triposr.glb', viewer_html)

            # Failed OpenRouter rows excluded; raw-only TRELLIS retains vertex_count and keeps mobile=None
            http_payload = build_studio_payload(res, embed_mobile_assets=False)
            self.assertEqual([d['label'] for d in http_payload['dishes']], ['01_pizza', '02_tteokbokki'])
            trellis_http = next(r for r in http_payload['dishes'][0]['runs'] if r['slug'] == 'trellis2-4b')
            self.assertIsNone(trellis_http['mobile'])
            self.assertEqual(trellis_http['raw']['vertices'], 42000)

            standalone_payload = build_studio_payload(res, embed_mobile_assets=True)
            trellis_st = next(r for r in standalone_payload['dishes'][0]['runs'] if r['slug'] == 'trellis2-4b')
            self.assertIsNone(trellis_st['mobile'])
            self.assertIsNotNone(trellis_st['raw']['base64'])
            self.assertEqual(base64.b64decode(trellis_st['raw']['base64'])[:4], b'glTF')

            standalone_html = standalone_path.read_text(encoding='utf-8')
            self.assertIn(DEFAULT_THREE_CDN_BASE, standalone_html)
            self.assertIn(THREE_VERSION, standalone_html)

    def test_escapes_script_tags_prevents_token_collision_and_blocks_publication_or_traversal(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            res = _make_sample_results(root)
            man_path = res / 'manifest.json'
            man = json.loads(man_path.read_text(encoding='utf-8'))
            man['demo_label'] = 'test</script><!--__MODE_TAG__--><script>alert(1)</script>'
            man_path.write_text(json.dumps(man), encoding='utf-8')
            viewer_path, _ = build_studio_files(res)
            html_out = viewer_path.read_text(encoding='utf-8')
            self.assertNotIn('</script><script>alert(1)</script>', html_out)
            self.assertNotIn('<!--__MODE_TAG__-->', html_out)
            self.assertIn('\\u003c/script>', html_out)

            # Reject publication_eligible=true on manifest, job_manifest, and render_studio_html
            man['publication_eligible'] = True
            man_path.write_text(json.dumps(man), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'publication_eligible=false'):
                build_studio_payload(res)
            with self.assertRaisesRegex(ValueError, 'publication_eligible=false'):
                render_studio_html({'publication_eligible': True})

            man['publication_eligible'] = False
            man_path.write_text(json.dumps(man), encoding='utf-8')
            jm_path = res / '01_pizza' / 'job_manifest.json'
            jm = json.loads(jm_path.read_text(encoding='utf-8'))
            jm['publication_eligible'] = True
            jm_path.write_text(json.dumps(jm), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'publication_eligible'):
                build_studio_payload(res)

            # Reset job_manifest and reject inputs[].artifacts & runs_3d[].artifacts traversal
            jm['publication_eligible'] = False
            jm_path.write_text(json.dumps(jm), encoding='utf-8')
            man['inputs']['01_pizza']['artifacts'][0]['path'] = '../../etc/passwd'
            man_path.write_text(json.dumps(man), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'escapes'):
                build_studio_payload(res)

            man['inputs']['01_pizza']['artifacts'][0]['path'] = '01_pizza/input_image.png'
            man['runs_3d']['01_pizza/triposr']['artifacts'][0]['path'] = '../../etc/passwd'
            man_path.write_text(json.dumps(man), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'escapes'):
                build_studio_payload(res)

    def test_loopback_http_server_mimes_traversal_and_missing_three_fallback(self):
        self.assertEqual(resolve_default_three_base_url(None), DEFAULT_THREE_CDN_BASE)
        self.assertEqual(resolve_default_three_base_url(Path('/tmp/three')), '/vendor/three')

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            res = _make_sample_results(root)
            build_studio_files(res, three_base_url='/vendor/three')
            three = root / 'three'
            (three / 'build').mkdir(parents=True)
            (three / 'build' / 'three.module.js').write_text('export const REVISION = "182";', encoding='utf-8')
            outside = root / 'secret.txt'
            outside.write_text('secret', encoding='utf-8')

            self.assertEqual(_resolve_safe_path('/', res, three), (res / 'comparison_viewer.html').resolve())
            self.assertIsNone(_resolve_safe_path('/../secret.txt', res, three))
            self.assertIsNone(_resolve_safe_path('/vendor/three/../../secret.txt', res, three))
            self.assertIsNone(_resolve_safe_path('/missing%00.js', res, three))

            server, _ = create_studio_server(res, port=0, three_dir=three)
            try:
                self.assertEqual(server.server_address[0], '127.0.0.1')
            finally:
                server.server_close()

            class _FakeSocket:
                def __init__(self, raw_req: bytes):
                    self._in = BytesIO(raw_req)
                    self._out = BytesIO()

                def makefile(self, mode, *args, **kwargs):
                    return self._in if 'r' in mode else self._out

                def sendall(self, data: bytes) -> None:
                    self._out.write(data)

                def close(self) -> None:
                    pass

            def do_http_get(path: str):
                sock = _FakeSocket(f'GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n'.encode('ascii'))
                _StudioRequestHandler(sock, ('127.0.0.1', 0), None, results_dir=res, three_dir=three)
                raw_resp = sock._out.getvalue()
                head, _, body = raw_resp.partition(b'\r\n\r\n')
                lines = head.decode('latin-1').split('\r\n')
                status_code = int(lines[0].split()[1])
                headers = {k.lower(): v for k, _, v in (ln.partition(': ') for ln in lines[1:] if ': ' in ln)}
                return status_code, headers, body

            st, hdrs, _ = do_http_get('/comparison_viewer.html')
            self.assertEqual(st, 200)
            self.assertEqual(hdrs.get('content-type'), 'text/html; charset=utf-8')
            self.assertEqual(hdrs.get('x-content-type-options'), 'nosniff')
            self.assertEqual(hdrs.get('cache-control'), 'no-store')

            st, hdrs, js_body = do_http_get('/vendor/three/build/three.module.js')
            self.assertEqual(st, 200)
            self.assertEqual(hdrs.get('content-type'), 'application/javascript; charset=utf-8')
            self.assertIn(b'REVISION', js_body)

            st, hdrs, glb_body = do_http_get('/01_pizza/triposr_mobile.glb')
            self.assertEqual(st, 200)
            self.assertEqual(hdrs.get('content-type'), 'model/gltf-binary')
            self.assertEqual(glb_body[:4], b'glTF')

            st, _, _ = do_http_get('/../secret.txt')
            self.assertEqual(st, 404)


if __name__ == '__main__':
    unittest.main(verbosity=2)
