"""Build a TRELLIS.2-4B max-detail-only gallery from a merged results directory.

Each dish page loads the full-resolution GLB by URL (not embedded) and renders it
unlit with its base-colour texture. It also shows the source photo and cutout with
direct links. Pages are written to ``<results>/trellis-max/`` and must be served over
HTTP from ``<results>`` (for example ``python -m http.server``), because the GLBs are
fetched by relative URL.

Private R&D output: ``publication_eligible`` stays false.
"""
from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path

RUN_SLUG = 'trellis2-4b-hires'
THREE = 'https://cdn.jsdelivr.net/npm/three@0.182.0'
_SAFE = re.compile(r'^[A-Za-z0-9_-]+$')

STYLE = """
:root{color-scheme:dark;--bg:#0b0f14;--card:#141a22;--line:#26303c;--fg:#e6edf3;--mut:#8b98a5;--acc:#4c8dff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
a{color:var(--acc)}header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line)}
h1{font-size:18px;margin:0}.mut{color:var(--mut);font-size:12px}.btn{display:inline-block;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);text-decoration:none;font-size:13px}
.btn[aria-disabled=true]{opacity:.4;pointer-events:none}
"""

INDEX_STYLE = STYLE + """
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;text-decoration:none;color:var(--fg)}
.card img{width:100%;aspect-ratio:1;object-fit:cover;display:block}.card div{padding:8px 10px}.card b{display:block}
"""

DISH_STYLE = STYLE + """
main{display:grid;grid-template-columns:300px 1fr;height:calc(100vh - 58px)}
aside{border-right:1px solid var(--line);padding:16px;overflow:auto}aside img{width:100%;border-radius:8px;display:block;margin:6px 0 4px;background:#222}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:13px}dt{color:var(--mut)}dd{margin:0}
#view{position:relative}#view canvas{display:block}#status{position:absolute;left:12px;bottom:12px;background:#000a;padding:4px 8px;border-radius:6px;font-size:12px}
@media (max-width:760px){main{grid-template-columns:1fr;height:auto}#view{height:70vh}}
"""

VIEWER_JS = """
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
const box = document.getElementById('view'), status = document.getElementById('status');
const renderer = new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
box.prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x1b2129);
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
function resize(){const w=box.clientWidth,h=box.clientHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();}
addEventListener('resize', resize); resize();
const t0 = performance.now();
new GLTFLoader().load(GLB_URL, (g) => {
  let faces = 0;
  g.scene.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    // Base colour: unlit, showing only the albedo texture / vertex colour.
    o.material = new THREE.MeshBasicMaterial({map: src.map || null, color: src.color || 0xffffff,
      vertexColors: !!o.geometry.attributes.color, side: THREE.DoubleSide});
    faces += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
  });
  const b = new THREE.Box3().setFromObject(g.scene), c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3()).length();
  g.scene.position.sub(c); scene.add(g.scene);
  camera.position.set(0, s * 0.75, s * 1.35); camera.near = s / 1000; camera.far = s * 20; camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0); controls.update();
  status.textContent = `Full resolution · base colour · ${Math.round(faces).toLocaleString()} faces · loaded in ${((performance.now()-t0)/1000).toFixed(1)} s`;
}, (e) => { if (e.total) status.textContent = `Loading full-resolution mesh… ${Math.round(e.loaded / e.total * 100)}%`; },
  (err) => { status.textContent = 'Failed to load GLB: ' + err; });
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
"""


def _safe(label: str) -> str:
    if not _SAFE.match(label):
        raise ValueError(f'Unsafe dish label: {label!r}')
    return label


def build(results: Path) -> Path:
    manifest = json.loads((results / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('publication_eligible') is not False:
        raise ValueError('Refusing to build from a manifest that is not publication_eligible=false.')
    dishes = []
    for key, run in sorted((manifest.get('runs_3d') or {}).items()):
        label, _, slug = key.partition('/')
        if slug != RUN_SLUG or run.get('status') != 'success':
            continue
        label = _safe(label)
        glb = next((a['path'] for a in run.get('artifacts', []) if a['path'].endswith('_hires.glb')), None)
        if not glb or not (results / glb).is_file():
            continue
        inp = (manifest.get('inputs') or {}).get(label, {})
        metrics = run.get('metrics') or {}
        dishes.append({'label': label, 'title': inp.get('title') or label, 'glb': glb,
                       'bytes': (results / glb).stat().st_size, 'faces': metrics.get('faces'),
                       'seconds': metrics.get('elapsed_seconds')})
    out = results / 'trellis-max'
    out.mkdir(exist_ok=True)
    e = html.escape
    cards = []
    for i, d in enumerate(dishes):
        lab = d['label']
        thumb = f'../studio/assets/{lab}/thumb.jpg'
        if not (results / 'studio' / 'assets' / lab / 'thumb.jpg').is_file():
            thumb = f'../{lab}/input_image.png'
        cards.append(f'<a class="card" href="{lab}.html"><img loading="lazy" src="{e(thumb)}" alt="">'
                     f'<div><b>{e(d["title"])}</b><span class="mut">{lab[:2]} · '
                     f'{(d["faces"] or 0) / 1e3:.0f}k faces · {d["bytes"] / 2**20:.1f} MB</span></div></a>')
        prev_a = (f'<a class="btn" href="{dishes[i - 1]["label"]}.html">Previous</a>' if i else
                  '<a class="btn" aria-disabled="true">Previous</a>')
        next_a = (f'<a class="btn" href="{dishes[i + 1]["label"]}.html">Next</a>' if i + 1 < len(dishes) else
                  '<a class="btn" aria-disabled="true">Next</a>')
        img, cut = f'../{lab}/input_image.png', f'../{lab}/cutout_rgba.png'
        mins = f'{d["seconds"] / 60:.1f} min' if d['seconds'] else '—'
        page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{e(d["title"])} · TRELLIS max</title>
<style>{DISH_STYLE}</style>
<script type="importmap">{{"imports":{{"three":"{THREE}/build/three.module.js","three/addons/":"{THREE}/examples/jsm/"}}}}</script></head><body>
<header><div><h1>{e(d["title"])}</h1><span class="mut">{lab} · TRELLIS.2-4B max detail (L4, 1024 cascade, 4K texture) · full resolution · base colour · drag to orbit, scroll to zoom</span></div>
<nav><a class="btn" href="index.html">All dishes</a> {prev_a} {next_a}</nav></header>
<main><aside>
<div class="mut">Source photo</div><a href="{img}" target="_blank" rel="noopener"><img src="{img}" alt="Source photo of {e(d["title"])}"></a>
<a href="{img}" target="_blank" rel="noopener">Open source image ↗</a>
<div class="mut" style="margin-top:14px">Cutout used for 3D</div><a href="{cut}" target="_blank" rel="noopener"><img src="{cut}" alt="Cutout"></a>
<a href="{cut}" target="_blank" rel="noopener">Open cutout ↗</a>
<dl style="margin-top:14px"><dt>Faces</dt><dd>{(d["faces"] or 0):,}</dd><dt>GLB</dt><dd>{d["bytes"] / 2**20:.1f} MB · <a href="../{e(d["glb"])}" download>download</a></dd>
<dt>Generation</dt><dd>{mins}</dd><dt>Status</dt><dd>private R&amp;D · publication_eligible=false</dd></dl>
</aside><div id="view"><div id="status">Loading full-resolution mesh…</div></div></main>
<script type="module">const GLB_URL = {json.dumps("../" + d["glb"])};{VIEWER_JS}</script>
</body></html>'''
        (out / f'{lab}.html').write_text(page, encoding='utf-8')
    index = f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>TRELLIS max gallery</title><style>{INDEX_STYLE}</style></head><body>
<header><div><h1>TRELLIS.2-4B max detail</h1><span class="mut">{len(dishes)}/41 dishes · full-resolution meshes, base colour · private R&amp;D, publication_eligible=false</span></div>
<a class="btn" href="../studio/index.html">All-model studio</a></header>
<div class="grid">{"".join(cards)}</div></body></html>'''
    (out / 'index.html').write_text(index, encoding='utf-8')
    return out / 'index.html'


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('results', type=Path, help='Merged results directory (has manifest.json).')
    print(build(ap.parse_args(argv).results))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
