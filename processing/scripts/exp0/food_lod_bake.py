"""Experiment 0 (2026-11-24): clean a high-poly TRELLIS.2 dish GLB and bake game-style LODs.

Run inside Blender 4.5 LTS (headless):
    blender -b --factory-startup -P food_lod_bake.py -- \
        --input hires.glb --outdir out/ --lods 150000:2048,35000:1024

Steps, all deterministic:
1. import the GLB, weld coincident vertices
2. split into loose shells; drop tiny shells and flat full-footprint "ground slabs"; log every decision
3. per LOD: duplicate, collapse-decimate, fresh UV unwrap, then Cycles-bake base colour,
   roughness and a tangent-space normal map from the cleaned high-poly mesh (selected-to-active)
4. food material: metallic forced to 0, roughness baked; export GLB (WebP textures)

Outputs stay private R&D: every report carries publication_eligible: false (ADR 0004).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

TINY_SHELL_FRACTION = 0.002  # shells under 0.2% of faces are floaters
SLAB_HEIGHT_RATIO = 0.02  # shell height / its own horizontal extent
SLAB_FOOTPRINT_RATIO = 0.75  # shell xy extent / whole-model xy extent (both axes)
TABLE_HEIGHT_RATIO = 0.05  # looser flatness for rectangular table/background slabs
CORNER_TOLERANCE = 0.04  # vertex within 4% of extent of an xy bbox corner counts as filled


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index('--') + 1 :] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--input', required=True)
    p.add_argument('--outdir', required=True)
    p.add_argument('--lods', default='150000:2048,35000:1024')
    p.add_argument('--samples', type=int, default=4)
    p.add_argument('--main-object-only', action='store_true')
    p.add_argument('--device', choices=['CPU', 'GPU'], default='CPU')
    return p.parse_args(argv)


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path: Path) -> bpy.types.Object:
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if len(meshes) != 1:
        bpy.ops.object.select_all(action='DESELECT')
        for o in meshes:
            o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active or meshes[0]
    # bake transforms so world == local coordinates
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def bbox(verts) -> tuple[Vector, Vector]:
    xs = [v.co.x for v in verts]
    ys = [v.co.y for v in verts]
    zs = [v.co.z for v in verts]
    return Vector((min(xs), min(ys), min(zs))), Vector((max(xs), max(ys), max(zs)))


def filled_corners(verts, lo: Vector, hi: Vector) -> int:
    tol_x = (hi.x - lo.x) * CORNER_TOLERANCE
    tol_y = (hi.y - lo.y) * CORNER_TOLERANCE
    hits = set()
    for v in verts:
        cx = 0 if v.co.x - lo.x <= tol_x else 1 if hi.x - v.co.x <= tol_x else None
        cy = 0 if v.co.y - lo.y <= tol_y else 1 if hi.y - v.co.y <= tol_y else None
        if cx is not None and cy is not None:
            hits.add((cx, cy))
            if len(hits) == 4:
                break
    return len(hits)


def clean_shells(obj: bpy.types.Object, main_object_only: bool = False) -> dict:
    """Weld, then delete tiny shells and ground slabs (and, opt-in, detached objects).

    main_object_only drops kept shells whose xy footprint does not touch the largest kept
    shell: background props such as dish 18's dessert stand. It is opt-in because detached
    side bowls can be part of the dish. Returns an auditable report.
    """
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    faces_before = len(bm.faces)
    size = max(obj.dimensions)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=size * 1e-5)
    bm.faces.ensure_lookup_table()

    # connected components over shared edges (welded topology)
    seen: set[int] = set()
    shells: list[list[bmesh.types.BMFace]] = []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack = [f]
        seen.add(f.index)
        comp = []
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for e in cur.edges:
                for nf in e.link_faces:
                    if nf.index not in seen:
                        seen.add(nf.index)
                        stack.append(nf)
        shells.append(comp)
    shells.sort(key=len, reverse=True)

    lo, hi = bbox(bm.verts)
    ext = hi - lo
    report_shells = []
    doomed: list[bmesh.types.BMFace] = []
    main_box: tuple[Vector, Vector] | None = None
    gap = 0.02 * max(ext.x, ext.y)
    for i, comp in enumerate(shells):
        verts = {v for f in comp for v in f.verts}
        slo, shi = bbox(verts)
        sext = shi - slo
        horiz = max(sext.x, sext.y, 1e-9)
        frac = len(comp) / faces_before
        is_tiny = frac < TINY_SHELL_FRACTION
        spans_footprint = (
            sext.x >= SLAB_FOOTPRINT_RATIO * ext.x
            and sext.y >= SLAB_FOOTPRINT_RATIO * ext.y
            and (slo.z - lo.z) < 0.1 * max(ext.z, 1e-9)
        )
        corners = filled_corners(verts, slo, shi) if spans_footprint else 0
        # paper-thin full-footprint shells (shadow discs) or flat rectangles (table tops
        # reconstructed from the photo background); round plates leave the corners empty
        is_slab = spans_footprint and (
            sext.z / horiz < SLAB_HEIGHT_RATIO
            or (sext.z / horiz < TABLE_HEIGHT_RATIO and corners >= 3)
        )
        action = 'drop_slab' if is_slab else 'drop_tiny' if is_tiny else 'keep'
        if action == 'keep':
            if main_box is None:
                main_box = (slo, shi)
            elif main_object_only:
                mlo, mhi = main_box
                detached = (
                    slo.x > mhi.x + gap or shi.x < mlo.x - gap or slo.y > mhi.y + gap or shi.y < mlo.y - gap
                )
                if detached:
                    action = 'drop_detached'
        if action != 'keep':
            doomed.extend(comp)
        if i < 12 or action in ('drop_slab', 'drop_detached'):
            report_shells.append(
                {
                    'rank': i,
                    'faces': len(comp),
                    'face_fraction': round(frac, 5),
                    'height_over_width': round(sext.z / horiz, 4),
                    'filled_corners': corners,
                    'action': action,
                }
            )
    bmesh.ops.delete(bm, geom=doomed, context='FACES')
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    faces_after = len(bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()
    return {
        'faces_before': faces_before,
        'faces_after': faces_after,
        'shell_count': len(shells),
        'main_object_only': main_object_only,
        'dropped_detached_shells': sum(1 for s in report_shells if s['action'] == 'drop_detached'),
        'dropped_slab_shells': sum(1 for s in report_shells if s['action'] == 'drop_slab'),
        'dropped_tiny_shells': sum(
            1 for comp in shells if len(comp) / faces_before < TINY_SHELL_FRACTION
        ),
        'shells': report_shells,
    }


def make_low(high: bpy.types.Object, target_faces: int, name: str) -> bpy.types.Object:
    low = high.copy()
    low.data = high.data.copy()
    low.name = name
    bpy.context.collection.objects.link(low)
    ratio = min(1.0, target_faces / max(len(high.data.polygons), 1))
    mod = low.modifiers.new('decimate', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    bpy.ops.object.select_all(action='DESELECT')
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.ops.object.modifier_apply(modifier=mod.name)
    # fresh UVs for the baked atlas
    while low.data.uv_layers:
        low.data.uv_layers.remove(low.data.uv_layers[0])
    low.data.uv_layers.new(name='bake')
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.002)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.shade_smooth()
    low.data.materials.clear()
    return low


def food_material(name: str, size: int) -> tuple[bpy.types.Material, dict]:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Metallic'].default_value = 0.0
    imgs = {}
    for key, colorspace in (('basecolor', 'sRGB'), ('roughness', 'Non-Color'), ('normal', 'Non-Color')):
        img = bpy.data.images.new(f'{name}_{key}', size, size, alpha=False, float_buffer=False)
        img.colorspace_settings.name = colorspace
        node = nt.nodes.new('ShaderNodeTexImage')
        node.image = img
        node.name = key
        imgs[key] = (img, node)
    nt.links.new(imgs['basecolor'][1].outputs['Color'], bsdf.inputs['Base Color'])
    nt.links.new(imgs['roughness'][1].outputs['Color'], bsdf.inputs['Roughness'])
    nmap = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(imgs['normal'][1].outputs['Color'], nmap.inputs['Color'])
    nt.links.new(nmap.outputs['Normal'], bsdf.inputs['Normal'])
    return mat, imgs


def bake(high: bpy.types.Object, low: bpy.types.Object, imgs: dict, samples: int) -> dict:
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = samples
    bk = scene.render.bake
    bk.use_selected_to_active = True
    size = max(high.dimensions)
    bk.cage_extrusion = size * 0.01
    bk.max_ray_distance = size * 0.03
    bk.margin = 8
    bpy.ops.object.select_all(action='DESELECT')
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    nt = low.active_material.node_tree
    timings = {}
    for key, kind in (('basecolor', 'DIFFUSE'), ('roughness', 'ROUGHNESS'), ('normal', 'NORMAL')):
        nt.nodes.active = imgs[key][1]
        t0 = time.time()
        if kind == 'DIFFUSE':
            bk.use_pass_direct = False
            bk.use_pass_indirect = False
            bk.use_pass_color = True
        bpy.ops.object.bake(type=kind)
        timings[key] = round(time.time() - t0, 1)
    return timings


def export_glb(obj: bpy.types.Object, path: Path) -> None:
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format='GLB',
        use_selection=True,
        export_image_format='WEBP',
        export_image_quality=90,
        export_yup=True,
        export_apply=True,
    )


def main() -> None:
    args = parse_args()
    src = Path(args.input)
    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)
    reset_scene()
    t0 = time.time()
    if args.device == 'GPU':
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'CUDA'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        bpy.context.scene.cycles.device = 'GPU'
    high = import_glb(src)
    high.name = 'high'
    report = {
        'schema_version': 1,
        'experiment': 'exp0-2026-11-24',
        'publication_eligible': False,
        'input': str(src),
        'import_seconds': round(time.time() - t0, 1),
    }
    report['cleanup'] = clean_shells(high, args.main_object_only)
    lods = []
    for spec in args.lods.split(','):
        faces, tex = (int(x) for x in spec.split(':'))
        tag = f'lod_{faces // 1000}k_{tex}'
        t1 = time.time()
        low = make_low(high, faces, tag)
        mat, imgs = food_material(tag, tex)
        low.data.materials.append(mat)
        decimate_s = round(time.time() - t1, 1)
        timings = bake(high, low, imgs, args.samples)
        glb = out / f'{tag}.glb'
        export_glb(low, glb)
        lods.append(
            {
                'tag': tag,
                'faces': len(low.data.polygons),
                'texture_size': tex,
                'glb': glb.name,
                'glb_bytes': glb.stat().st_size,
                'decimate_unwrap_seconds': decimate_s,
                'bake_seconds': timings,
            }
        )
        bpy.data.objects.remove(low, do_unlink=True)
    report['lods'] = lods
    report['total_seconds'] = round(time.time() - t0, 1)
    (out / 'exp0_report.json').write_text(json.dumps(report, indent=2) + '\n')
    print('EXP0_REPORT', json.dumps(report))


if __name__ == '__main__':
    main()
