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
        Image.new('RGB', (32, 24), (110, 110, 120)).save(d / 'trellis2_4b_hf_modes.png')

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
        # Legacy TripoSR/Hunyuan runs may appear in historical manifests and must be excluded
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
                ],
            }

        (d / 'trellis2_4b.glb').write_bytes(glb_raw)
        artifacts_t = [
            {'path': f'{label}/trellis2_4b.glb'},
            {'path': f'{label}/trellis2_4b_hf_modes.png'},
        ]
        if not include_raw_only_trellis:
            (d / 'trellis2_4b_mobile.glb').write_bytes(glb_mob)
            artifacts_t.append({'path': f'{label}/trellis2_4b_mobile.glb'})
        runs_3d[f'{label}/trellis2-4b'] = {
            'input_label': label,
            'backend': 'TRELLIS.2-4B',
            'appearance': 'pbr_texture',
            'device': 'cuda:0+cuda:1',
            'status': 'success',
            'metrics': {'vertex_count': 42000, 'faces': 84000, 'bytes': len(glb_raw), 'has_texture': True},
            **({} if include_raw_only_trellis else {'mobile_metrics': {'vertices': 17000, 'faces': 33000, 'bytes': len(glb_mob)}}),
            'artifacts': artifacts_t,
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
                'data-view="trellis2-4b"',
                'Mobile (&lt;=35k)',
                'Full (Raw)',
                'webglcontextlost',
                'clearViewportModel',
                'no-webgl',
                'disposeMaterial',
            ):
                self.assertIn(token, viewer_html)
            for legacy_tok in ('TripoSR (Color)', 'Hunyuan3D-2mini (Mesh)', 'Side-by-Side Sync', '01_pizza/triposr.glb'):
                self.assertNotIn(legacy_tok, viewer_html)
            self.assertIn('01_pizza/trellis2_4b.glb', viewer_html)

            # Failed OpenRouter & legacy TripoSR/Hunyuan rows excluded; raw-only TRELLIS retains vertex_count and keeps mobile=None
            http_payload = build_studio_payload(res, embed_mobile_assets=False)
            self.assertEqual([d['label'] for d in http_payload['dishes']], ['01_pizza', '02_tteokbokki'])
            self.assertEqual([r['slug'] for r in http_payload['dishes'][0]['runs']], ['trellis2-4b'])
            trellis_http = http_payload['dishes'][0]['runs'][0]
            self.assertIsNone(trellis_http['mobile'])
            self.assertEqual(trellis_http['raw']['vertices'], 42000)

            standalone_payload = build_studio_payload(res, embed_mobile_assets=True)
            trellis_st = standalone_payload['dishes'][0]['runs'][0]
            self.assertIsNone(trellis_st['mobile'])
            self.assertIsNotNone(trellis_st['raw']['base64'])
            self.assertEqual(base64.b64decode(trellis_st['raw']['base64'])[:4], b'glTF')

            # Mobile + raw TRELLIS payload embeds 33k mobile GLB cleanly
            full_res = _make_sample_results(Path(tmp) / 'full', include_raw_only_trellis=False)
            full_payload = build_studio_payload(full_res, embed_mobile_assets=True)
            self.assertEqual(full_payload['dishes'][0]['runs'][0]['mobile']['faces'], 33000)
            self.assertIsNotNone(full_payload['dishes'][0]['runs'][0]['mobile']['base64'])

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
            man['runs_3d']['01_pizza/trellis2-4b']['artifacts'][0]['path'] = '../../etc/passwd'
            man_path.write_text(json.dumps(man), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'escapes'):
                build_studio_payload(res)

    def test_models_statuses_and_comparison_controls(self):
        with TemporaryDirectory() as tmp:
            res = _make_sample_results(Path(tmp))
            path = res / 'manifest.json'
            manifest = json.loads(path.read_text())
            manifest['inputs']['01_pizza'].update(title='Pizza', tier='hero', page='page12')
            for slug, status in [('moge2-relief', 'failed'), ('triposg', 'skipped'), ('hunyuan3d2', 'success'), ('hi3dgen', 'success')]:
                manifest['runs_3d']['01_pizza/' + slug] = {
                    'input_label': '01_pizza', 'status': status,
                    'artifacts': [{'path': '01_pizza/trellis2_4b.glb'}],
                }
            path.write_text(json.dumps(manifest))
            dish = build_studio_payload(res)['dishes'][0]
            self.assertEqual(dish['title'], 'Pizza')
            self.assertEqual(dish['tier'], 'hero')
            self.assertEqual(dish['page'], 'page12')
            self.assertEqual([m['slug'] for m in dish['model_statuses']], ['moge2-relief', 'trellis2-4b-hires', 'trellis2-4b', 'triposg', 'hunyuan3d2', 'hi3dgen'])
            self.assertEqual([m['status'] for m in dish['model_statuses']], ['failed', 'not_run', 'success', 'skipped', 'success', 'success'])
            self.assertEqual([r['slug'] for r in dish['runs']], ['trellis2-4b', 'hunyuan3d2', 'hi3dgen'])
            output = render_studio_html(build_studio_payload(res))
            for token in ('dish-search', 'tier-filters', 'cmp-left', 'cmp-right', 'Compare Side-by-Side', 'model-matrix'):
                self.assertIn(token, output)

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


def _mesh_glb(triangles: int, *, indexed: bool = True, tag: bytes = b'') -> bytes:
    """GLB whose JSON declares one triangle primitive; `tag` makes per-dish bytes distinguishable."""
    accessors = [{'count': triangles * 3, 'type': 'VEC3', 'componentType': 5126}]
    primitive = {'attributes': {'POSITION': 0}}
    if indexed:
        accessors = [{'count': triangles + 2, 'type': 'VEC3', 'componentType': 5126},
                     {'count': triangles * 3, 'type': 'SCALAR', 'componentType': 5125}]
        primitive['indices'] = 1
    json_bytes = json.dumps({'asset': {'version': '2.0'}, 'meshes': [{'primitives': [primitive]}],
                             'accessors': accessors}).encode('utf-8')
    while len(json_bytes) % 4:
        json_bytes += b' '
    bin_bytes = (tag or b'\x00') + b'\x00' * (-len(tag or b'\x00') % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    return (struct.pack('<4sII', b'glTF', 2, total) + struct.pack('<II', len(json_bytes), 0x4E4F534A)
            + json_bytes + struct.pack('<II', len(bin_bytes), 0x004E4942) + bin_bytes)


def _add_five_model_runs(res: Path) -> None:
    """Give 01_pizza distinct TripoSG/MoGe mesh GLBs and mark Hi3DGen skipped; 02 keeps TRELLIS only."""
    path = res / 'manifest.json'
    manifest = json.loads(path.read_text(encoding='utf-8'))
    d = res / '01_pizza'
    (d / 'triposg.glb').write_bytes(_mesh_glb(900, tag=b'P1RAWTRIPOSG'))
    (d / 'triposg_mobile.glb').write_bytes(_mesh_glb(300, tag=b'P1MOBTRIPOSG'))
    (d / 'moge2_relief_mobile.glb').write_bytes(_mesh_glb(120, indexed=False, tag=b'P1MOBMOGE'))
    (d / 'trellis2_4b_mobile.glb').write_bytes(_mesh_glb(330, tag=b'P1MOBTRELLIS'))
    (res / '02_tteokbokki' / 'trellis2_4b_mobile.glb').write_bytes(_mesh_glb(210, tag=b'P2MOBTRELLIS'))
    manifest['runs_3d']['01_pizza/triposg'] = {
        'input_label': '01_pizza', 'backend': 'TripoSG', 'status': 'success', 'appearance': 'pbr_texture',
        'metrics': {'faces': 900, 'bytes': 1}, 'mobile_metrics': {'faces': 300},
        'artifacts': [{'path': '01_pizza/triposg.glb'}, {'path': '01_pizza/triposg_mobile.glb'}],
    }
    manifest['runs_3d']['01_pizza/moge2-relief'] = {
        'input_label': '01_pizza', 'backend': 'MoGe-2', 'status': 'success', 'appearance': 'vertex_color',
        'artifacts': [{'path': '01_pizza/moge2_relief_mobile.glb'}],
    }
    manifest['runs_3d']['01_pizza/hi3dgen'] = {
        'input_label': '01_pizza', 'backend': 'Hi3DGen', 'status': 'skipped',
        'error': 'Skipped (spconv_unavailable)', 'artifacts': [],
    }
    manifest['inputs']['01_pizza'].update(title='Pizza', tier='benchmark_4')
    path.write_text(json.dumps(manifest), encoding='utf-8')


def _write_menu_manifest(root: Path) -> Path:
    menu_dir = root / 'menu'
    menu_dir.mkdir()
    Image.new('RGB', (64, 48), (10, 160, 60)).save(menu_dir / '03_pending_soup.png')
    menu = {'schema_version': 1, 'count': 3, 'dishes': [
        {'label': '01_pizza', 'title': 'Pizza', 'tier': 'benchmark_4', 'image_file': '01_pizza.png'},
        {'label': '02_tteokbokki', 'title': 'Tteokbokki', 'tier': 'benchmark_4'},
        {'label': '03_pending_soup', 'title': 'Pending Soup', 'tier': 'page12', 'page': 12,
         'image_file': '03_pending_soup.png'},
    ]}
    path = menu_dir / 'dishes_manifest.json'
    path.write_text(json.dumps(menu), encoding='utf-8')
    return path


class SplitStudioTests(unittest.TestCase):
    def test_measures_triangle_faces_from_glb_json_without_trusting_manifest(self):
        from peekaplate_processing.dish_3d_studio import measure_glb_faces
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'indexed.glb').write_bytes(_mesh_glb(7))
            (root / 'flat.glb').write_bytes(_mesh_glb(5, indexed=False))
            (root / 'empty.glb').write_bytes(_minimal_glb())
            (root / 'bad.glb').write_bytes(b'not a glb')
            self.assertEqual(measure_glb_faces(root / 'indexed.glb'), 7)
            self.assertEqual(measure_glb_faces(root / 'flat.glb'), 5)
            self.assertIsNone(measure_glb_faces(root / 'empty.glb'))
            self.assertIsNone(measure_glb_faces(root / 'bad.glb'))
            self.assertIsNone(measure_glb_faces(root / 'missing.glb'))

    def test_split_index_lists_every_menu_dish_and_dish_pages_embed_only_their_mobile_glbs(self):
        from peekaplate_processing.dish_3d_studio import build_split_studio
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            res = _make_sample_results(root)
            _add_five_model_runs(res)
            menu = _write_menu_manifest(root)
            out = root / 'split'
            index_path, dish_paths = build_split_studio(res, out, menu_manifest=menu)

            self.assertEqual(index_path, out / 'index.html')
            self.assertEqual(sorted(p.name for p in dish_paths), ['01_pizza.html', '02_tteokbokki.html'])
            index_html = index_path.read_text(encoding='utf-8')
            # Every menu dish is listed; the dish without outputs is pending for all five models
            for label in ('01_pizza', '02_tteokbokki', '03_pending_soup'):
                self.assertIn(f'data-dish="{label}"', index_html)
            self.assertIn('href="dishes/01_pizza.html"', index_html)
            self.assertNotIn('dishes/03_pending_soup.html', index_html)
            self.assertIn('data-cell="03_pending_soup/trellis2-4b" data-status="pending"', index_html)
            self.assertEqual(index_html.count('data-cell="03_pending_soup/'), 6)
            self.assertIn('data-cell="01_pizza/hi3dgen" data-status="skipped"', index_html)
            self.assertIn('data-cell="02_tteokbokki/triposg" data-status="pending"', index_html)
            self.assertIn('data-cell="01_pizza/trellis2-4b" data-status="success"', index_html)
            # Per-model coverage is stated over the full menu (TRELLIS 2 success, 1 pending of 3)
            self.assertIn('data-coverage="trellis2-4b" data-success="2" data-skipped="0" data-failed="0" data-pending="1" data-total="3"', index_html)
            # Face counts are measured from GLB bytes (330 mobile / 900 raw TripoSG), not the manifest
            self.assertIn('330 mobile faces', index_html)
            self.assertIn('data-mobile-faces="300"', index_html)
            # Index is light: no Three.js, no embedded GLB, thumbnails are separate small files
            self.assertNotIn('importmap', index_html)
            self.assertNotIn('base64', index_html)
            self.assertIn('assets/03_pending_soup/thumb.jpg', index_html)
            with Image.open(out / 'assets' / '03_pending_soup' / 'thumb.jpg') as thumb:
                self.assertLessEqual(max(thumb.size), 192)
            self.assertLess(index_path.stat().st_size, 60_000)

            pizza = (out / 'dishes' / '01_pizza.html').read_text(encoding='utf-8')
            self.assertIn(f'{DEFAULT_THREE_CDN_BASE}/build/three.module.js', pizza)
            self.assertNotIn('/vendor/three', pizza)
            embedded = {
                el_id: base64.b64decode(b64)
                for el_id, b64 in __import__('re').findall(
                    r'<script type="application/octet-stream" id="(glb-[a-z0-9-]+)">([A-Za-z0-9+/=]+)</script>', pizza)
            }
            self.assertEqual(sorted(embedded), ['glb-moge2-relief', 'glb-trellis2-4b', 'glb-triposg'])
            self.assertIn(b'P1MOBTRIPOSG', embedded['glb-triposg'])
            self.assertIn(b'P1MOBTRELLIS', embedded['glb-trellis2-4b'])
            for blob in embedded.values():
                self.assertNotIn(b'P2MOBTRELLIS', blob)  # another dish's GLB
                self.assertNotIn(b'P1RAWTRIPOSG', blob)  # full-resolution GLB is linked, not embedded
            tteok = (out / 'dishes' / '02_tteokbokki.html').read_text(encoding='utf-8')
            self.assertEqual(tteok.count('type="application/octet-stream"'), 1)
            self.assertNotIn('P1MOB', base64.b64decode(__import__('re').search(
                r'id="glb-trellis2-4b">([A-Za-z0-9+/=]+)<', tteok).group(1)).decode('latin-1'))
            # Full-resolution GLBs stay downloadable through a relative link that resolves on disk
            data = json.loads(__import__('re').search(
                r'<script id="dish-data" type="application/json">(.*?)</script>', pizza, __import__('re').S).group(1))
            self.assertIs(data['publication_eligible'], False)
            triposg = next(m for m in data['models'] if m['slug'] == 'triposg')
            self.assertEqual(triposg['name'], 'TripoSG + Photo PBR')
            self.assertEqual(triposg['raw']['faces_measured'], 900)
            self.assertEqual(((out / 'dishes') / triposg['raw']['href']).resolve(), (res / '01_pizza' / 'triposg.glb').resolve())
            self.assertEqual([m['status'] for m in data['models']], ['success', 'pending', 'success', 'success', 'pending', 'skipped'])
            for token in ('data-shader="clay"', 'data-shader="normal"', 'data-shader="base_color"', 'btn-wireframe',
                          'data-preset="top"', 'data-preset="low"', 'Compare Side-by-Side', 'cmp-left', 'cmp-right',
                          'disposeViewport', 'forceContextLoss', 'webglcontextlost', 'href="../index.html"'):
                self.assertIn(token, pizza)
            # Model-specific labels: never the hardcoded TRELLIS mesh-profile names
            self.assertNotIn('TRELLIS Fast', pizza)
            self.assertNotIn('TRELLIS Full', pizza)

    def test_split_studio_rejects_unsafe_labels_and_publication(self):
        from peekaplate_processing.dish_3d_studio import build_split_studio
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            res = _make_sample_results(root)
            menu = root / 'menu.json'
            menu.write_text(json.dumps({'dishes': [{'label': '../escape'}]}), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'label'):
                build_split_studio(res, root / 'out', menu_manifest=menu)
            man = json.loads((res / 'manifest.json').read_text(encoding='utf-8'))
            man['publication_eligible'] = True
            (res / 'manifest.json').write_text(json.dumps(man), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'publication_eligible=false'):
                build_split_studio(res, root / 'out')

    def test_rendered_legacy_studio_uses_each_model_display_name(self):
        with TemporaryDirectory() as tmp:
            res = _make_sample_results(Path(tmp))
            _add_five_model_runs(res)
            html_out = render_studio_html(build_studio_payload(res))
            self.assertNotIn('TRELLIS Fast', html_out)
            self.assertNotIn('TRELLIS Full', html_out)
            self.assertIn('data-profile="mobile">Mobile (&lt;=35k)</button>', html_out)
            self.assertIn("m.slug === run.slug)?.name || run.backend", html_out)

    def test_cli_build_pins_cdn_even_with_local_three_and_gates_legacy_single_file(self):
        from unittest import mock
        from peekaplate_processing import dish_3d_studio
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            res = _make_sample_results(root)
            three = root / 'three'
            (three / 'build').mkdir(parents=True)
            (three / 'build' / 'three.module.js').write_text('export const REVISION = "182";', encoding='utf-8')
            with mock.patch.object(dish_3d_studio, 'find_local_three_dir', return_value=three):
                self.assertEqual(dish_3d_studio.main(['--results-dir', str(res), '--build']), 0)
            viewer = (res / 'comparison_viewer.html').read_text(encoding='utf-8')
            self.assertIn(f'{DEFAULT_THREE_CDN_BASE}/build/three.module.js', viewer)
            self.assertNotIn('/vendor/three', viewer)
            self.assertTrue((res / 'studio' / 'index.html').is_file())
            self.assertTrue((res / 'studio' / 'dishes' / '01_pizza.html').is_file())
            self.assertFalse((res / 'interactive_3d_studio.html').exists())

            out = root / 'elsewhere'
            menu = _write_menu_manifest(root)
            self.assertEqual(dish_3d_studio.main(['--results-dir', str(res), '--build', '--out-dir', str(out),
                                                  '--menu-manifest', str(menu), '--legacy-single-file']), 0)
            self.assertIn('data-dish="03_pending_soup"', (out / 'index.html').read_text(encoding='utf-8'))
            self.assertTrue((res / 'interactive_3d_studio.html').is_file())

    def test_server_swaps_pinned_cdn_for_vendored_three_only_while_serving(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            res = _make_sample_results(root)
            build_studio_files(res)
            three = root / 'three'
            (three / 'build').mkdir(parents=True)
            (three / 'build' / 'three.module.js').write_text('export const REVISION = "182";', encoding='utf-8')

            def get(three_dir):
                sock_in = BytesIO(b'GET /comparison_viewer.html HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n')
                sock_out = BytesIO()

                class _Sock:
                    def makefile(self, mode, *a, **k):
                        return sock_in if 'r' in mode else sock_out

                    def sendall(self, data):
                        sock_out.write(data)

                    def close(self):
                        pass

                _StudioRequestHandler(_Sock(), ('127.0.0.1', 0), None, results_dir=res, three_dir=three_dir)
                head, _, body = sock_out.getvalue().partition(b'\r\n\r\n')
                length = int(next(ln.split(b': ')[1] for ln in head.split(b'\r\n') if ln.lower().startswith(b'content-length')))
                self.assertEqual(length, len(body))
                return body.decode('utf-8')

            self.assertIn('"/vendor/three/build/three.module.js"', get(three))
            self.assertNotIn(DEFAULT_THREE_CDN_BASE, get(three))
            self.assertIn(f'{DEFAULT_THREE_CDN_BASE}/build/three.module.js', get(None))
            # The built file on disk is never rewritten
            self.assertNotIn('/vendor/three', (res / 'comparison_viewer.html').read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
