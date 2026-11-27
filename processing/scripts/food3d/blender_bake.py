"""Food3D V1 Stage 2: headless Blender 4.5 cleanup, metric seating, UV packing, and Cycles baking.

Run inside Blender 4.5 LTS (headless, Python 3.11 + bpy/bmesh/mathutils only):
    blender -b --factory-startup -P blender_bake.py -- \
        --input hires.glb --outdir out/ --lods 150000:2048,35000:1024 \
        [--main-object-only] [--drop-shadow-disc] \
        [--diameter-cm 24.0] [--calibrated] \
        [--samples 4] [--ao-samples 16]

Outputs stay private R&D: every report carries publication_eligible: false.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import time
from collections import deque
from pathlib import Path

import numpy as np

try:
    import bmesh
    import bpy
    from mathutils import Vector
except ImportError:  # Allow offline unit tests to import pure GLB helpers outside Blender.
    bmesh = None  # type: ignore[assignment]
    bpy = None  # type: ignore[assignment]
    Vector = None  # type: ignore[assignment]

TINY_SHELL_FRACTION = 0.002
SLAB_HEIGHT_RATIO = 0.02
SLAB_FOOTPRINT_RATIO = 0.75
TABLE_HEIGHT_RATIO = 0.05
CORNER_TOLERANCE = 0.04
SHARP_EDGE_ANGLE_DEG = 65.0
UNDERSIDE_FLATTEN_FRACTION = 0.012


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments passed after Blender's '--' separator."""
    argv = sys.argv[sys.argv.index('--') + 1 :] if '--' in sys.argv else []
    parser = argparse.ArgumentParser(description='Food3D V1 Blender cleanup and Cycles baking.')
    parser.add_argument('--input', required=True, help='Input high-res GLB path.')
    parser.add_argument('--outdir', required=True, help='Output directory for maps, geom GLB, and report.')
    parser.add_argument('--lods', default='150000:2048,35000:1024', help='Comma-separated faces:texsize pairs.')
    parser.add_argument('--main-object-only', action='store_true', help='Drop detached side shells.')
    parser.add_argument('--drop-shadow-disc', action='store_true', help='Drop lower flat drop-shadow discs.')
    parser.add_argument('--diameter-cm', type=float, default=24.0, help='Target horizontal diameter in cm.')
    parser.add_argument('--calibrated', action='store_true', help='Mark diameter as calibrated.')
    parser.add_argument('--samples', type=int, default=4, help='Cycles samples for primary bakes.')
    parser.add_argument('--ao-samples', type=int, default=16, help='AO shader ray count.')
    parser.add_argument('--device', choices=['CPU', 'GPU'], default='CPU', help='Cycles compute device.')
    return parser.parse_args(argv)


def reset_scene() -> None:
    """Start from a clean empty Blender scene."""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path: Path) -> bpy.types.Object:
    """Import GLB, join multiple mesh objects if needed, and apply transforms."""
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        raise RuntimeError(f'No mesh objects found in {path}')
    if len(meshes) != 1:
        bpy.ops.object.select_all(action='DESELECT')
        for obj in meshes:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active or meshes[0]
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def compute_bbox(verts) -> tuple[Vector, Vector]:
    """Return axis-aligned min and max corners for a collection of vertices."""
    xs = [v.co.x for v in verts]
    ys = [v.co.y for v in verts]
    zs = [v.co.z for v in verts]
    return Vector((min(xs), min(ys), min(zs))), Vector((max(xs), max(ys), max(zs)))


def count_filled_corners(verts, lo: Vector, hi: Vector) -> int:
    """Count how many XY bounding-box corners have at least one nearby vertex."""
    tol_x = (hi.x - lo.x) * CORNER_TOLERANCE
    tol_y = (hi.y - lo.y) * CORNER_TOLERANCE
    hits: set[tuple[int, int]] = set()
    for v in verts:
        cx = 0 if v.co.x - lo.x <= tol_x else 1 if hi.x - v.co.x <= tol_x else None
        cy = 0 if v.co.y - lo.y <= tol_y else 1 if hi.y - v.co.y <= tol_y else None
        if cx is not None and cy is not None:
            hits.add((cx, cy))
            if len(hits) == 4:
                break
    return len(hits)


def clean_shells(
    obj: bpy.types.Object,
    main_object_only: bool = False,
    drop_shadow_disc: bool = False,
    skip_weld_if_watertight: bool = True,
) -> dict:
    """Weld vertices (unless already closed manifold), classify connected shells, and drop unwanted shells."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    faces_before = len(bm.faces)
    already_closed = (
        faces_before > 0
        and all(not e.is_boundary and len(e.link_faces) == 2 for e in bm.edges)
    )
    if not (skip_weld_if_watertight and already_closed):
        size = max(obj.dimensions) if max(obj.dimensions) > 0 else 1.0
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=size * 1e-5)
    bm.faces.index_update()
    bm.faces.ensure_lookup_table()

    seen: set[bmesh.types.BMFace] = set()
    shells: list[list[bmesh.types.BMFace]] = []
    for f in bm.faces:
        if f in seen:
            continue
        stack = [f]
        seen.add(f)
        comp: list[bmesh.types.BMFace] = []
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for e in cur.edges:
                for nf in e.link_faces:
                    if nf not in seen:
                        seen.add(nf)
                        stack.append(nf)
        shells.append(comp)
    shells.sort(key=len, reverse=True)

    lo, hi = compute_bbox(bm.verts)
    ext = hi - lo
    gap = 0.02 * max(ext.x, ext.y)
    main_box: tuple[Vector, Vector] | None = None
    main_horiz = 0.0

    report_shells = []
    doomed: list[bmesh.types.BMFace] = []
    dropped_counts = {
        'drop_tiny': 0,
        'drop_slab': 0,
        'drop_detached': 0,
        'drop_shadow_disc': 0,
    }

    for rank, comp in enumerate(shells):
        verts = {v for f in comp for v in f.verts}
        slo, shi = compute_bbox(verts)
        sext = shi - slo
        horiz = max(sext.x, sext.y, 1e-9)
        frac = len(comp) / max(faces_before, 1)
        h_over_w = sext.z / horiz

        is_tiny = frac < TINY_SHELL_FRACTION
        spans_footprint = (
            sext.x >= SLAB_FOOTPRINT_RATIO * ext.x
            and sext.y >= SLAB_FOOTPRINT_RATIO * ext.y
            and (slo.z - lo.z) < 0.1 * max(ext.z, 1e-9)
        )
        corners = count_filled_corners(verts, slo, shi) if spans_footprint else 0
        is_slab = spans_footprint and (
            h_over_w < SLAB_HEIGHT_RATIO
            or (h_over_w < TABLE_HEIGHT_RATIO and corners >= 3)
        )

        if is_slab:
            action = 'drop_slab'
        elif is_tiny:
            action = 'drop_tiny'
        else:
            action = 'keep'

        if action == 'keep':
            if main_box is None:
                main_box = (slo, shi)
                main_horiz = horiz
            else:
                if drop_shadow_disc:
                    is_shadow_disc = (
                        slo.z <= lo.z + 0.06 * ext.z
                        and shi.z <= lo.z + 0.22 * ext.z
                        and h_over_w < 0.045
                        and horiz >= 0.92 * main_horiz
                    )
                    if is_shadow_disc:
                        action = 'drop_shadow_disc'
                if action == 'keep' and main_object_only:
                    mlo, mhi = main_box
                    detached = (
                        slo.x > mhi.x + gap
                        or shi.x < mlo.x - gap
                        or slo.y > mhi.y + gap
                        or shi.y < mlo.y - gap
                    )
                    if detached:
                        action = 'drop_detached'

        if action != 'keep':
            doomed.extend(comp)
            dropped_counts[action] += 1

        entry = {
            'rank': rank,
            'faces': len(comp),
            'face_fraction': round(frac, 5),
            'height_over_width': round(h_over_w, 4),
            'filled_corners': corners,
            'z_min': round(slo.z, 5),
            'z_max': round(shi.z, 5),
            'action': action,
        }
        if rank < 16 or action != 'drop_tiny':
            report_shells.append(entry)
            print(
                f'[shell {rank}] faces={len(comp)} frac={frac:.5f} '
                f'h/w={h_over_w:.4f} corners={corners} action={action}'
            )

    if doomed:
        bmesh.ops.delete(bm, geom=doomed, context='FACES')
        loose = [v for v in bm.verts if not v.link_faces]
        if loose:
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
        'drop_shadow_disc': drop_shadow_disc,
        'dropped_tiny_shells': dropped_counts['drop_tiny'],
        'dropped_slab_shells': dropped_counts['drop_slab'],
        'dropped_detached_shells': dropped_counts['drop_detached'],
        'dropped_shadow_disc_shells': dropped_counts['drop_shadow_disc'],
        'shells': report_shells,
    }


def seat_and_scale_metric(
    obj: bpy.types.Object,
    diameter_cm: float,
    flatten_underside: bool = True,
) -> dict:
    """Center XY, seat z_min at 0 (flattening open undersides when requested), and scale to diameter_cm."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    if not bm.verts:
        bm.free()
        raise RuntimeError('Cleaned mesh has no vertices.')

    lo, hi = compute_bbox(bm.verts)
    cx = 0.5 * (lo.x + hi.x)
    cy = 0.5 * (lo.y + hi.y)
    z_min = lo.z
    height = max(hi.z - lo.z, 1e-9)
    flatten_thresh = UNDERSIDE_FLATTEN_FRACTION * height

    flattened_verts = 0
    for v in bm.verts:
        v.co.x -= cx
        v.co.y -= cy
        v.co.z -= z_min
        if flatten_underside and v.co.z < flatten_thresh:
            v.co.z = 0.0
            flattened_verts += 1

    lo2, hi2 = compute_bbox(bm.verts)
    ext2 = hi2 - lo2
    horiz_ext = max(ext2.x, ext2.y, 1e-9)
    target_m = diameter_cm / 100.0
    scale = target_m / horiz_ext
    for v in bm.verts:
        v.co *= scale

    lo3, hi3 = compute_bbox(bm.verts)
    ext3 = hi3 - lo3
    bm.to_mesh(me)
    bm.free()
    me.update()
    return {
        'diameter_cm': diameter_cm,
        'scale_factor': round(scale, 6),
        'center_xy_before': [round(cx, 6), round(cy, 6)],
        'z_min_before': round(z_min, 6),
        'flattened_underside_verts': flattened_verts,
        'dimensions_m': [round(ext3.x, 5), round(ext3.y, 5), round(ext3.z, 5)],
        'z_min_m': round(lo3.z, 6),
    }


def compute_uv_metrics(me: bpy.types.Mesh) -> tuple[int, float]:
    """Compute UV island count and clamped UV coverage ratio in [0, 1]."""
    bm = bmesh.new()
    bm.from_mesh(me)
    uv_layer = bm.loops.layers.uv.active
    if uv_layer is None or not bm.faces:
        bm.free()
        return 0, 0.0

    bm.faces.ensure_lookup_table()
    total_area = 0.0
    for f in bm.faces:
        uvs = [loop[uv_layer].uv for loop in f.loops]
        if len(uvs) >= 3:
            a = uvs[0]
            for idx in range(1, len(uvs) - 1):
                b = uvs[idx]
                c = uvs[idx + 1]
                total_area += 0.5 * abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))

    # Build UV island connected components across shared edges with continuous UVs.
    def _face_vert_uv(face: bmesh.types.BMFace, vert: bmesh.types.BMVert):
        for loop in face.loops:
            if loop.vert == vert:
                return loop[uv_layer].uv
        return None

    seen: set[int] = set()
    islands = 0
    eps_sq = 1e-10
    for f in bm.faces:
        if f.index in seen:
            continue
        islands += 1
        stack = [f]
        seen.add(f.index)
        while stack:
            cur = stack.pop()
            for e in cur.edges:
                if len(e.link_faces) != 2:
                    continue
                other = e.link_faces[0] if e.link_faces[1] == cur else e.link_faces[1]
                if other.index in seen:
                    continue
                v0, v1 = e.verts[0], e.verts[1]
                u_c0 = _face_vert_uv(cur, v0)
                u_o0 = _face_vert_uv(other, v0)
                u_c1 = _face_vert_uv(cur, v1)
                u_o1 = _face_vert_uv(other, v1)
                if (
                    u_c0 is not None
                    and u_o0 is not None
                    and u_c1 is not None
                    and u_o1 is not None
                    and (u_c0 - u_o0).length_squared <= eps_sq
                    and (u_c1 - u_o1).length_squared <= eps_sq
                ):
                    seen.add(other.index)
                    stack.append(other)

    bm.free()
    return islands, round(min(max(total_area, 0.0), 1.0), 5)


def measure_mesh_topology(me: bpy.types.Mesh) -> dict:
    """Measure boundary edges, non-manifold edges, and closed watertight status of a Blender mesh."""
    bm = bmesh.new()
    bm.from_mesh(me)
    boundary_edges = sum(1 for e in bm.edges if e.is_boundary)
    non_manifold_edges = sum(1 for e in bm.edges if len(e.link_faces) > 2)
    face_count = len(bm.faces)
    bm.free()
    return {
        'boundary_edges': int(boundary_edges),
        'non_manifold_edges': int(non_manifold_edges),
        'is_watertight': bool(boundary_edges == 0 and non_manifold_edges == 0 and face_count > 0),
    }


def _repair_closed_bmesh(bm: bmesh.types.BMesh) -> None:
    """Close boundary loops and prune non-manifold fin faces opened by decimation."""
    for _ in range(4):
        bmesh.ops.dissolve_degenerate(bm, dist=1e-6, edges=bm.edges)
        degen = [f for f in bm.faces if f.calc_area() <= 1e-12]
        if degen:
            bmesh.ops.delete(bm, geom=degen, context='FACES')
        bm.edges.ensure_lookup_table()
        bm.faces.ensure_lookup_table()

        nm_faces = {f for e in bm.edges if len(e.link_faces) > 2 for f in e.link_faces}
        if nm_faces:
            bmesh.ops.delete(bm, geom=list(nm_faces), context='FACES')
            bm.edges.ensure_lookup_table()

        open_edges = [e for e in bm.edges if e.is_boundary]
        if not open_edges and not nm_faces:
            break
        if open_edges:
            bmesh.ops.holes_fill(bm, edges=open_edges, sides=0)
            ngons = [f for f in bm.faces if len(f.verts) > 3]
            if ngons:
                bmesh.ops.triangulate(bm, faces=ngons)
            bm.edges.ensure_lookup_table()
            bm.faces.ensure_lookup_table()

    loose_edges = [e for e in bm.edges if not e.link_faces]
    if loose_edges:
        bmesh.ops.delete(bm, geom=loose_edges, context='EDGES')
    loose_verts = [v for v in bm.verts if not v.link_faces]
    if loose_verts:
        bmesh.ops.delete(bm, geom=loose_verts, context='VERTS')
    if bm.faces:
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))


def _unwrap_and_pack_low_mesh(low: bpy.types.Object) -> None:
    """Unwrap non-overlapping UV islands and pack downward-bottom islands into a compact corner strip."""
    while low.data.uv_layers:
        low.data.uv_layers.remove(low.data.uv_layers[0])
    low.data.uv_layers.new(name='bake')
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(
        angle_limit=math.radians(89.0),
        island_margin=0.00025,
        area_weight=0.75,
        correct_aspect=True,
    )
    bpy.ops.object.mode_set(mode='OBJECT')

    bm = bmesh.new()
    bm.from_mesh(low.data)
    bm.faces.ensure_lookup_table()
    uv = bm.loops.layers.uv.active
    n_f = len(bm.faces)
    is_bot_face = [False] * n_f
    if uv is not None and n_f > 0:
        visited = [False] * n_f
        for i in range(n_f):
            if visited[i]:
                continue
            comp: list[bmesh.types.BMFace] = []
            tot_area = 0.0
            bot_area = 0.0
            q = deque([bm.faces[i]])
            visited[i] = True
            while q:
                cf = q.popleft()
                comp.append(cf)
                fa = cf.calc_area()
                tot_area += fa
                if cf.normal.z < -0.55:
                    bot_area += fa
                for loop in cf.loops:
                    key = (round(loop[uv].uv.x, 5), round(loop[uv].uv.y, 5))
                    for oloop in loop.vert.link_loops:
                        nf = oloop.face
                        if not visited[nf.index] and (round(oloop[uv].uv.x, 5), round(oloop[uv].uv.y, 5)) == key:
                            visited[nf.index] = True
                            q.append(nf)
            if tot_area > 0.0 and (bot_area / tot_area) >= 0.75:
                for cf in comp:
                    is_bot_face[cf.index] = True
    bm.free()

    has_bot = any(is_bot_face)
    has_vis = any(not b for b in is_bot_face)
    if has_bot and has_vis:
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='DESELECT')
        bpy.ops.object.mode_set(mode='OBJECT')
        for idx, poly in enumerate(low.data.polygons):
            poly.select = not is_bot_face[idx]
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.uv.pack_islands(margin=0.0003, rotate=True, scale=True)
        bpy.ops.object.mode_set(mode='OBJECT')

        bm = bmesh.new()
        bm.from_mesh(low.data)
        bm.faces.ensure_lookup_table()
        uv = bm.loops.layers.uv.active
        for idx, f in enumerate(bm.faces):
            if not is_bot_face[idx]:
                for loop in f.loops:
                    loop[uv].uv.x = 0.002 + 0.996 * loop[uv].uv.x
                    loop[uv].uv.y = 0.080 + 0.918 * loop[uv].uv.y
        bm.to_mesh(low.data)
        bm.free()
        low.data.update()

        for idx, poly in enumerate(low.data.polygons):
            poly.select = is_bot_face[idx]
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.uv.pack_islands(margin=0.001, rotate=True, scale=True)
        bpy.ops.object.mode_set(mode='OBJECT')

        bm = bmesh.new()
        bm.from_mesh(low.data)
        bm.faces.ensure_lookup_table()
        uv = bm.loops.layers.uv.active
        for idx, f in enumerate(bm.faces):
            if is_bot_face[idx]:
                for loop in f.loops:
                    loop[uv].uv.x = 0.002 + 0.250 * loop[uv].uv.x
                    loop[uv].uv.y = 0.002 + 0.074 * loop[uv].uv.y
        bm.to_mesh(low.data)
        bm.free()
        low.data.update()
    else:
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.pack_islands(margin=0.0003, rotate=True, scale=True)
        bpy.ops.object.mode_set(mode='OBJECT')


def make_low(
    high: bpy.types.Object,
    target_faces: int,
    name: str,
    is_closed_high: bool = False,
) -> tuple[bpy.types.Object, int, float]:
    """Decimate, apply sharp-edge weighted normals (Blender 4.5), and pack fresh UVs."""
    low = high.copy()
    low.data = high.data.copy()
    low.name = name
    bpy.context.collection.objects.link(low)

    ratio = min(1.0, target_faces / max(len(high.data.polygons), 1))
    dec = low.modifiers.new('decimate', 'DECIMATE')
    dec.decimate_type = 'COLLAPSE'
    dec.ratio = ratio
    dec.use_collapse_triangulate = True

    bpy.ops.object.select_all(action='DESELECT')
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.ops.object.modifier_apply(modifier=dec.name)

    # Dissolve degenerate decimated faces/edges before marking sharp edges and UV unwrapping,
    # and mark edges sharp above SHARP_EDGE_ANGLE_DEG (65 deg) with smooth faces (Blender 4.5).
    sharp_rad = math.radians(SHARP_EDGE_ANGLE_DEG)
    bm = bmesh.new()
    bm.from_mesh(low.data)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-6, edges=bm.edges)
    degen_faces = [f for f in bm.faces if f.calc_area() <= 1e-12]
    if degen_faces:
        bmesh.ops.delete(bm, geom=degen_faces, context='FACES')
    if is_closed_high:
        _repair_closed_bmesh(bm)
    ngons = [f for f in bm.faces if len(f.verts) > 3]
    if ngons:
        bmesh.ops.triangulate(bm, faces=ngons)
    loose_verts = [v for v in bm.verts if not v.link_faces]
    if loose_verts:
        bmesh.ops.delete(bm, geom=loose_verts, context='VERTS')
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > sharp_rad:
            e.smooth = False
        else:
            e.smooth = True
    bm.to_mesh(low.data)
    bm.free()
    low.data.update()

    wn = low.modifiers.new('weighted_normal', 'WEIGHTED_NORMAL')
    wn.mode = 'FACE_AREA'
    wn.weight = 50
    wn.keep_sharp = True
    bpy.ops.object.modifier_apply(modifier=wn.name)

    _unwrap_and_pack_low_mesh(low)

    uv_islands, uv_coverage = compute_uv_metrics(low.data)
    low.data.materials.clear()
    return low, uv_islands, uv_coverage


def create_bake_target_material(name: str, size: int) -> tuple[bpy.types.Material, dict[str, tuple[bpy.types.Image, bpy.types.ShaderNode]]]:
    """Create a material with unlinked Principled BSDF and unlinked Image Texture bake targets.

    Keeping all bake target nodes unlinked prevents Cycles circular dependency warnings.
    """
    mat = bpy.data.materials.new(f'{name}_bake_mat')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    if bsdf is not None:
        bsdf.inputs['Metallic'].default_value = 0.0
        bsdf.inputs['Roughness'].default_value = 0.5

    specs = (
        ('basecolor', 'sRGB'),
        ('roughness', 'Non-Color'),
        ('normal', 'Non-Color'),
        ('ao', 'Non-Color'),
        ('geom_features', 'Non-Color'),
        ('uv_mask', 'Non-Color'),
    )
    imgs: dict[str, tuple[bpy.types.Image, bpy.types.ShaderNode]] = {}
    for key, colorspace in specs:
        img = bpy.data.images.new(f'{name}_{key}', size, size, alpha=False, float_buffer=False)
        img.colorspace_settings.name = colorspace
        node = nt.nodes.new('ShaderNodeTexImage')
        node.image = img
        node.name = key
        imgs[key] = (img, node)
    return mat, imgs


def build_ao_override_material(ao_samples: int, distance: float) -> bpy.types.Material:
    """Build an emission shader driven by local Ambient Occlusion."""
    mat = bpy.data.materials.new('_food3d_ao_override')
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    emit = nt.nodes.new('ShaderNodeEmission')
    emit.inputs['Strength'].default_value = 1.0
    ao = nt.nodes.new('ShaderNodeAmbientOcclusion')
    ao.samples = ao_samples
    ao.only_local = True
    ao.inputs['Distance'].default_value = distance
    nt.links.new(ao.outputs['AO'], emit.inputs['Color'])
    nt.links.new(emit.outputs['Emission'], out.inputs['Surface'])
    return mat


def build_geom_features_override_material(z_min: float, height: float, r_max: float) -> bpy.types.Material:
    """Build an emission shader encoding (R=height_norm, G=radial_norm, B=clamp(Normal.z, 0, 1))."""
    mat = bpy.data.materials.new('_food3d_geom_override')
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new('ShaderNodeOutputMaterial')
    emit = nt.nodes.new('ShaderNodeEmission')
    emit.inputs['Strength'].default_value = 1.0
    geom = nt.nodes.new('ShaderNodeNewGeometry')
    sep_pos = nt.nodes.new('ShaderNodeSeparateXYZ')
    sep_nrm = nt.nodes.new('ShaderNodeSeparateXYZ')
    comb = nt.nodes.new('ShaderNodeCombineColor')

    nt.links.new(geom.outputs['Position'], sep_pos.inputs['Vector'])
    nt.links.new(geom.outputs['Normal'], sep_nrm.inputs['Vector'])

    # R = clamp((Z - z_min) / max(height, 1e-6), 0, 1)
    z_sub = nt.nodes.new('ShaderNodeMath')
    z_sub.operation = 'SUBTRACT'
    z_sub.inputs[1].default_value = z_min
    z_div = nt.nodes.new('ShaderNodeMath')
    z_div.operation = 'DIVIDE'
    z_div.use_clamp = True
    z_div.inputs[1].default_value = max(height, 1e-6)
    nt.links.new(sep_pos.outputs['Z'], z_sub.inputs[0])
    nt.links.new(z_sub.outputs['Value'], z_div.inputs[0])

    # G = clamp(sqrt(X^2 + Y^2) / max(r_max, 1e-6), 0, 1)
    x_sq = nt.nodes.new('ShaderNodeMath')
    x_sq.operation = 'MULTIPLY'
    nt.links.new(sep_pos.outputs['X'], x_sq.inputs[0])
    nt.links.new(sep_pos.outputs['X'], x_sq.inputs[1])

    y_sq = nt.nodes.new('ShaderNodeMath')
    y_sq.operation = 'MULTIPLY'
    nt.links.new(sep_pos.outputs['Y'], y_sq.inputs[0])
    nt.links.new(sep_pos.outputs['Y'], y_sq.inputs[1])

    xy_sum = nt.nodes.new('ShaderNodeMath')
    xy_sum.operation = 'ADD'
    nt.links.new(x_sq.outputs['Value'], xy_sum.inputs[0])
    nt.links.new(y_sq.outputs['Value'], xy_sum.inputs[1])

    r_sqrt = nt.nodes.new('ShaderNodeMath')
    r_sqrt.operation = 'SQRT'
    nt.links.new(xy_sum.outputs['Value'], r_sqrt.inputs[0])

    r_div = nt.nodes.new('ShaderNodeMath')
    r_div.operation = 'DIVIDE'
    r_div.use_clamp = True
    r_div.inputs[1].default_value = max(r_max, 1e-6)
    nt.links.new(r_sqrt.outputs['Value'], r_div.inputs[0])

    # B = clamp(Normal.z, 0, 1)
    nz_clamp = nt.nodes.new('ShaderNodeMath')
    nz_clamp.operation = 'ADD'
    nz_clamp.use_clamp = True
    nz_clamp.inputs[1].default_value = 0.0
    nt.links.new(sep_nrm.outputs['Z'], nz_clamp.inputs[0])

    nt.links.new(z_div.outputs['Value'], comb.inputs['Red'])
    nt.links.new(r_div.outputs['Value'], comb.inputs['Green'])
    nt.links.new(nz_clamp.outputs['Value'], comb.inputs['Blue'])
    nt.links.new(comb.outputs['Color'], emit.inputs['Color'])
    nt.links.new(emit.outputs['Emission'], out.inputs['Surface'])
    return mat


def build_uv_mask_override_material() -> bpy.types.Material:
    """Build a solid white emission shader for exact UV coverage mask baking."""
    mat = bpy.data.materials.new('_food3d_uv_mask_override')
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    emit = nt.nodes.new('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (1.0, 1.0, 1.0, 1.0)
    emit.inputs['Strength'].default_value = 1.0
    nt.links.new(emit.outputs['Emission'], out.inputs['Surface'])
    return mat


def save_baked_image(img: bpy.types.Image, out_path: Path) -> None:
    """Save a baked image buffer directly to PNG."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.filepath_raw = str(out_path)
    img.file_format = 'PNG'
    img.save()


def _set_override_material(obj: bpy.types.Object, mat: bpy.types.Material) -> None:
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def bake_all_maps(
    high: bpy.types.Object,
    low: bpy.types.Object,
    imgs: dict[str, tuple[bpy.types.Image, bpy.types.ShaderNode]],
    maps_dir: Path,
    samples: int,
    ao_samples: int,
) -> dict[str, float]:
    """Run all 6 selected-to-active Cycles bakes and save PNG maps."""
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    bk = scene.render.bake
    bk.use_selected_to_active = True
    size = max(high.dimensions) if max(high.dimensions) > 0 else 0.24
    bk.cage_extrusion = size * 0.01
    bk.max_ray_distance = size * 0.03
    bk.normal_space = 'TANGENT'

    bpy.ops.object.select_all(action='DESELECT')
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    nt = low.active_material.node_tree

    timings: dict[str, float] = {}

    def _run_pass(key: str, bake_type: str, pass_samples: int, margin: int) -> None:
        scene.cycles.samples = pass_samples
        bk.margin = margin
        nt.nodes.active = imgs[key][1]
        if bake_type == 'DIFFUSE':
            bk.use_pass_direct = False
            bk.use_pass_indirect = False
            bk.use_pass_color = True
        t0 = time.time()
        bpy.ops.object.bake(type=bake_type)
        save_baked_image(imgs[key][0], maps_dir / f'{key}.png')
        timings[key] = round(time.time() - t0, 2)

    # Cycles' diffuse color pass needs a diffuse lobe even on fully metallic surfaces.
    basecolor_overrides = []
    try:
        for material in set(high.data.materials):
            if material is None or not material.use_nodes:
                continue
            tree = material.node_tree
            for node in tree.nodes:
                if node.type != 'BSDF_PRINCIPLED':
                    continue
                for name in ('Metallic', 'Transmission Weight', 'Coat Weight'):
                    socket = node.inputs.get(name)
                    if socket is None:
                        continue
                    removed_sources = []
                    basecolor_overrides.append((tree, socket, socket.default_value, removed_sources))
                    for link in tuple(socket.links):
                        source = link.from_socket
                        tree.links.remove(link)
                        removed_sources.append(source)
                    socket.default_value = 0.0

        _run_pass('basecolor', 'DIFFUSE', samples, margin=12)
    finally:
        for tree, socket, default_value, removed_sources in basecolor_overrides:
            socket.default_value = default_value
            for source in removed_sources:
                tree.links.new(source, socket)

    _run_pass('roughness', 'ROUGHNESS', samples, margin=12)
    _run_pass('normal', 'NORMAL', samples, margin=12)

    # 4-6: Temporary override emission passes on high; always restore high's original materials.
    orig_mats = list(high.data.materials)
    orig_poly_mats = [p.material_index for p in high.data.polygons]

    verts = high.data.vertices
    z_vals = [v.co.z for v in verts]
    z_min = min(z_vals)
    height = max(max(z_vals) - z_min, 1e-6)
    r_max = max((math.hypot(v.co.x, v.co.y) for v in verts), default=1e-6)

    ao_mat = build_ao_override_material(ao_samples=ao_samples, distance=size * 0.22)
    geom_mat = build_geom_features_override_material(z_min=z_min, height=height, r_max=r_max)
    mask_mat = build_uv_mask_override_material()

    try:
        _set_override_material(high, ao_mat)
        _run_pass('ao', 'EMIT', samples, margin=12)

        _set_override_material(high, geom_mat)
        _run_pass('geom_features', 'EMIT', 1, margin=12)

        _set_override_material(high, mask_mat)
        _run_pass('uv_mask', 'EMIT', 1, margin=0)
    finally:
        high.data.materials.clear()
        for m in orig_mats:
            high.data.materials.append(m)
        if orig_mats:
            for p, idx in zip(high.data.polygons, orig_poly_mats):
                p.material_index = idx
        for tmp_mat in (ao_mat, geom_mat, mask_mat):
            bpy.data.materials.remove(tmp_mat, do_unlink=True)

    return timings


def _stamp_glb_asset_extras(glb_path: Path, extras: dict) -> None:
    """Update asset.extras in a binary glTF (.glb) file in-place."""
    raw = glb_path.read_bytes()
    if len(raw) < 20:
        raise ValueError(f'Invalid GLB file (too short): {glb_path}')
    magic, version, total_len = struct.unpack_from('<III', raw, 0)
    if magic != 0x46546C67 or version != 2:
        raise ValueError(f'Invalid GLB header in {glb_path}')
    offset = 12
    gltf_json = None
    bin_chunk = b''
    limit = min(len(raw), total_len)
    while offset + 8 <= limit:
        chunk_len, chunk_type = struct.unpack_from('<II', raw, offset)
        offset += 8
        chunk_data = raw[offset : offset + chunk_len]
        offset += chunk_len
        if chunk_type == 0x4E4F534A:
            gltf_json = json.loads(chunk_data.decode('utf-8'))
        elif chunk_type == 0x004E4942:
            bin_chunk = chunk_data
    if gltf_json is None:
        raise ValueError(f'Missing JSON chunk in {glb_path}')
    asset = gltf_json.setdefault('asset', {})
    existing = asset.get('extras')
    if not isinstance(existing, dict):
        existing = {}
    existing.update(extras)
    asset['extras'] = existing
    json_bytes = json.dumps(gltf_json, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    if len(json_bytes) % 4 != 0:
        json_bytes += b' ' * (4 - (len(json_bytes) % 4))
    has_bin = len(bin_chunk) > 0
    if has_bin and len(bin_chunk) % 4 != 0:
        bin_chunk += b'\x00' * (4 - (len(bin_chunk) % 4))
    new_total = 12 + 8 + len(json_bytes) + (8 + len(bin_chunk) if has_bin else 0)
    out = bytearray()
    out += struct.pack('<III', 0x46546C67, 2, new_total)
    out += struct.pack('<II', len(json_bytes), 0x4E4F534A)
    out += json_bytes
    if has_bin:
        out += struct.pack('<II', len(bin_chunk), 0x004E4942)
        out += bin_chunk
    glb_path.write_bytes(bytes(out))


def _orthonormal_tangent_for_normal(normal: np.ndarray) -> np.ndarray:
    """Return a unit XYZ vector orthogonal to a vertex normal."""
    n = np.asarray(normal, dtype=np.float64)
    n_len = float(np.linalg.norm(n))
    if not np.isfinite(n_len) or n_len < 1e-8:
        return np.array([1.0, 0.0, 0.0], dtype=np.float32)
    n = n / n_len
    ref = np.array([1.0, 0.0, 0.0], dtype=np.float64) if abs(n[0]) < 0.9 else np.array([0.0, 1.0, 0.0], dtype=np.float64)
    t = ref - float(np.dot(ref, n)) * n
    t_len = float(np.linalg.norm(t))
    if not np.isfinite(t_len) or t_len < 1e-8:
        return np.array([1.0, 0.0, 0.0], dtype=np.float32)
    return (t / t_len).astype(np.float32)


def _accessor_array_view(
    gltf_json: dict,
    bin_buf: bytearray,
    acc_idx: int,
    expected_comps: int,
) -> np.ndarray | None:
    """Return a writable float32 numpy view of a glTF VEC3/VEC4 accessor inside bin_buf."""
    accessors = gltf_json.get('accessors', [])
    buffer_views = gltf_json.get('bufferViews', [])
    if acc_idx < 0 or acc_idx >= len(accessors):
        return None
    acc = accessors[acc_idx]
    if acc.get('componentType') != 5126:  # FLOAT
        return None
    count = int(acc.get('count', 0))
    if count <= 0:
        return None
    bv_idx = acc.get('bufferView')
    if bv_idx is None or bv_idx < 0 or bv_idx >= len(buffer_views):
        return None
    bv = buffer_views[bv_idx]
    start = int(bv.get('byteOffset', 0)) + int(acc.get('byteOffset', 0))
    stride = int(bv.get('byteStride', expected_comps * 4))
    if stride < expected_comps * 4 or start + (count - 1) * stride + expected_comps * 4 > len(bin_buf):
        return None
    return np.ndarray(
        shape=(count, expected_comps),
        dtype='<f4',
        buffer=bin_buf,
        offset=start,
        strides=(stride, 4),
    )


def sanitize_glb_tangents(glb_path: Path) -> int:
    """Ensure every VEC4 TANGENT accessor entry in a GLB has unit-length XYZ and +/-1 W."""
    raw = glb_path.read_bytes()
    if len(raw) < 20:
        raise ValueError(f'Invalid GLB file (too short): {glb_path}')
    magic, version, total_len = struct.unpack_from('<III', raw, 0)
    if magic != 0x46546C67 or version != 2:
        raise ValueError(f'Invalid GLB header in {glb_path}')

    offset = 12
    gltf_json = None
    bin_chunk = b''
    limit = min(len(raw), total_len)
    while offset + 8 <= limit:
        chunk_len, chunk_type = struct.unpack_from('<II', raw, offset)
        offset += 8
        chunk_data = raw[offset : offset + chunk_len]
        offset += chunk_len
        if chunk_type == 0x4E4F534A:
            gltf_json = json.loads(chunk_data.decode('utf-8'))
        elif chunk_type == 0x004E4942:
            bin_chunk = chunk_data
    if gltf_json is None:
        raise ValueError(f'Missing JSON chunk in {glb_path}')
    if not bin_chunk:
        return 0

    bin_buf = bytearray(bin_chunk)
    fixed_count = 0
    seen_accessors: set[int] = set()

    for mesh in gltf_json.get('meshes', []):
        for prim in mesh.get('primitives', []):
            attrs = prim.get('attributes', {})
            t_idx = attrs.get('TANGENT')
            if t_idx is None or t_idx in seen_accessors:
                continue
            seen_accessors.add(int(t_idx))
            tangents = _accessor_array_view(gltf_json, bin_buf, int(t_idx), 4)
            if tangents is None:
                continue
            n_idx = attrs.get('NORMAL')
            normals = _accessor_array_view(gltf_json, bin_buf, int(n_idx), 3) if n_idx is not None else None

            xyz = tangents[:, :3].astype(np.float64)
            w = tangents[:, 3].astype(np.float64)
            norms = np.linalg.norm(xyz, axis=1)
            finite_xyz = np.all(np.isfinite(xyz), axis=1)
            bad_len = (~finite_xyz) | (norms < 1e-6)
            renorm = finite_xyz & (norms >= 1e-6) & (np.abs(norms - 1.0) > 1e-4)
            bad_w = (~np.isfinite(w)) | (np.abs(np.abs(w) - 1.0) > 1e-4)

            if bad_len.any():
                for idx in np.flatnonzero(bad_len):
                    n_vec = normals[idx] if (normals is not None and idx < len(normals)) else np.array([0.0, 0.0, 1.0])
                    tangents[idx, :3] = _orthonormal_tangent_for_normal(n_vec)
                    w_val = float(w[idx]) if np.isfinite(w[idx]) and w[idx] != 0.0 else 1.0
                    tangents[idx, 3] = 1.0 if w_val >= 0.0 else -1.0
                fixed_count += int(bad_len.sum())
            if renorm.any():
                tangents[renorm, :3] = (xyz[renorm] / norms[renorm, None]).astype(np.float32)
                fixed_count += int(renorm.sum())
            if bad_w.any():
                for idx in np.flatnonzero(bad_w):
                    w_val = float(tangents[idx, 3])
                    tangents[idx, 3] = -1.0 if (np.isfinite(w_val) and w_val < 0.0) else 1.0
                if not bad_len.any():
                    fixed_count += int(bad_w.sum())

            acc = gltf_json['accessors'][int(t_idx)]
            if 'min' in acc:
                acc['min'] = [float(x) for x in tangents.min(axis=0)]
            if 'max' in acc:
                acc['max'] = [float(x) for x in tangents.max(axis=0)]

    if fixed_count == 0:
        return 0

    json_bytes = json.dumps(gltf_json, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    if len(json_bytes) % 4 != 0:
        json_bytes += b' ' * (4 - (len(json_bytes) % 4))
    bin_out = bytes(bin_buf)
    if len(bin_out) % 4 != 0:
        bin_out += b'\x00' * (4 - (len(bin_out) % 4))

    new_total = 12 + 8 + len(json_bytes) + 8 + len(bin_out)
    out = bytearray()
    out += struct.pack('<III', 0x46546C67, 2, new_total)
    out += struct.pack('<II', len(json_bytes), 0x4E4F534A)
    out += json_bytes
    out += struct.pack('<II', len(bin_out), 0x004E4942)
    out += bin_out
    glb_path.write_bytes(bytes(out))
    return fixed_count


def export_geom_glb(low: bpy.types.Object, path: Path, name: str) -> None:
    """Export low-poly mesh with a clean placeholder Principled BSDF material."""
    placeholder = bpy.data.materials.new(f'{name}_placeholder')
    placeholder.use_nodes = True
    bsdf = placeholder.node_tree.nodes.get('Principled BSDF')
    if bsdf is not None:
        bsdf.inputs['Metallic'].default_value = 0.0
        bsdf.inputs['Roughness'].default_value = 0.5

    low.data.materials.clear()
    low.data.materials.append(placeholder)
    low['publication_eligible'] = False
    low['pipeline'] = 'food3d-v1-geom'
    low.data['publication_eligible'] = False
    bpy.context.scene['publication_eligible'] = False

    bpy.ops.object.select_all(action='DESELECT')
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format='GLB',
        use_selection=True,
        export_tangents=True,
        export_yup=True,
        export_apply=True,
        export_extras=True,
    )
    fixed_tangents = sanitize_glb_tangents(path)
    if fixed_tangents:
        print(f'[sanitize_glb_tangents] Fixed {fixed_tangents} invalid tangents in {path.name}')
    _stamp_glb_asset_extras(path, {'publication_eligible': False, 'pipeline': 'food3d-v1-geom'})


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
        for dev in prefs.devices:
            dev.use = True
        bpy.context.scene.cycles.device = 'GPU'
    else:
        bpy.context.scene.cycles.device = 'CPU'

    high = import_glb(src)
    high.name = 'high'
    import_s = round(time.time() - t0, 2)

    cleanup = clean_shells(
        high,
        main_object_only=args.main_object_only,
        drop_shadow_disc=args.drop_shadow_disc,
    )
    high_topo_pre = measure_mesh_topology(high.data)
    seating = seat_and_scale_metric(
        high,
        diameter_cm=args.diameter_cm,
        flatten_underside=not bool(high_topo_pre['is_watertight']),
    )
    high_topo = measure_mesh_topology(high.data)
    is_closed_high = bool(high_topo['is_watertight'])

    lods = []
    for spec in args.lods.split(','):
        spec = spec.strip()
        if not spec:
            continue
        faces, tex = (int(x) for x in spec.split(':'))
        tag = f'lod_{faces // 1000}k_{tex}'
        maps_dir = out / f'{tag}_maps'
        maps_dir.mkdir(parents=True, exist_ok=True)

        t1 = time.time()
        low, uv_islands, uv_coverage = make_low(high, faces, tag, is_closed_high=is_closed_high)
        lod_topo = measure_mesh_topology(low.data)
        bake_mat, imgs = create_bake_target_material(tag, tex)
        low.data.materials.append(bake_mat)
        decimate_s = round(time.time() - t1, 2)

        timings = bake_all_maps(
            high=high,
            low=low,
            imgs=imgs,
            maps_dir=maps_dir,
            samples=args.samples,
            ao_samples=args.ao_samples,
        )

        geom_glb = out / f'{tag}_geom.glb'
        export_geom_glb(low, geom_glb, tag)
        face_count = len(low.data.polygons)
        texels_per_face = round((uv_coverage * tex * tex) / max(face_count, 1), 2)
        lods.append(
            {
                'tag': tag,
                'faces': face_count,
                'texture_size': tex,
                'uv_island_count': uv_islands,
                'uv_coverage_ratio': uv_coverage,
                'texels_per_face': texels_per_face,
                'boundary_edges': lod_topo['boundary_edges'],
                'non_manifold_edges': lod_topo['non_manifold_edges'],
                'is_watertight': lod_topo['is_watertight'],
                'maps_dir': maps_dir.name,
                'geom_glb': geom_glb.name,
                'geom_glb_bytes': geom_glb.stat().st_size,
                'decimate_unwrap_seconds': decimate_s,
                'bake_seconds': timings,
            }
        )

        # Clean up per-LOD datablocks to keep memory bounded.
        low_mesh = low.data
        bpy.data.objects.remove(low, do_unlink=True)
        bpy.data.meshes.remove(low_mesh, do_unlink=True)
        for img, _ in imgs.values():
            bpy.data.images.remove(img, do_unlink=True)
        bpy.data.materials.remove(bake_mat, do_unlink=True)

    report = {
        'schema_version': 1,
        'pipeline': 'food3d-v1-stage2',
        'publication_eligible': False,
        'input': str(src),
        'diameter_cm': args.diameter_cm,
        'calibrated': bool(args.calibrated),
        'seating': seating,
        'cleanup': cleanup,
        'lods': lods,
        'import_seconds': import_s,
        'total_seconds': round(time.time() - t0, 2),
    }
    report_path = out / 'bake_report.json'
    report_path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print('BAKE_REPORT', json.dumps(report))


if __name__ == '__main__':
    main()
