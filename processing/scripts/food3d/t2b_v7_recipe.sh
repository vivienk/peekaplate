# Shared Track 2B "v7 recipe" defaults, sourced by food3d_demo.sh and colab_track2b.sh.
# shellcheck shell=bash
# v7 recipe (2026-11-26): best on hotdog and sandwich, on par with v5 for pizza.
# Every value can be overridden from the environment.
V2D_MAX_DIM=${V2D_MAX_DIM:-1920}
T2B_STEPS=${T2B_STEPS:-9000}
export T2B_TEXTURE_MODE=${T2B_TEXTURE_MODE:-best_view}
export T2B_VOXEL_DIVISIONS=${T2B_VOXEL_DIVISIONS:-512}
export T2B_TSDF_CUBE_PADDING=${T2B_TSDF_CUBE_PADDING:-1.15}
export T2B_TSDF_TRUNC_VOXELS=${T2B_TSDF_TRUNC_VOXELS:-5.0}
export T2B_REFINE_STOP_ITER=${T2B_REFINE_STOP_ITER:-6000}
export T2B_POTTS_WEIGHT=${T2B_POTTS_WEIGHT:-0.75}
export T2B_SEAM_WIDTH_PX=${T2B_SEAM_WIDTH_PX:-3.0}
export T2B_TRIM_DRIPS=${T2B_TRIM_DRIPS:-1}
export T2B_REPAIR_PITS=${T2B_REPAIR_PITS:-1}
export T2B_INPAINT_UNPROJECTED=${T2B_INPAINT_UNPROJECTED:-1}
# Opt-in only: bright-concave upper-percentile texturing fixes grey/self-shadowed concave
# crumb (co3d_hotdog) and improves sandwich/hotdog albedo+lit held-out metrics, but it
# over-brightens co3d_pizza and lowers its held-out lit PSNR by 0.33 dB, so the default
# stays OFF. Set T2B_BRIGHT_CONCAVE=1 for hotdog-like geometries with a deep concavity.
export T2B_BRIGHT_CONCAVE=${T2B_BRIGHT_CONCAVE:-0}
export T2B_BRIGHT_CONCAVE_Q_LO=${T2B_BRIGHT_CONCAVE_Q_LO:-0.60}
export T2B_BRIGHT_CONCAVE_Q_HI=${T2B_BRIGHT_CONCAVE_Q_HI:-0.92}
# Off by default: in v6 they dulled colours (color-field) and bled sausage colour onto the hotdog bun (mask-carve).
export T2B_COLOR_FIELD=${T2B_COLOR_FIELD:-0}
export T2B_MASK_CARVE=${T2B_MASK_CARVE:-0}
# Opt-in only: the v11 wet/oily film improves pizza (+0.16 dB) and sandwich (+0.25 dB) held-out lit
# metrics and makes highlights sweep with the light, but mildly regresses co3d_hotdog and needs a
# human visual review, so the default stays OFF. To enable it, also supply the per-LOD view-angle
# gloss maps from `project-uv --specular-gloss-out` via T2B_SPECULAR_GLOSS_MAP[_35K].
export T2B_WET_FOOD=${T2B_WET_FOOD:-0}
export T2B_SPECULAR_GLOSS_MAP=${T2B_SPECULAR_GLOSS_MAP:-}
export T2B_SPECULAR_GLOSS_MAP_35K=${T2B_SPECULAR_GLOSS_MAP_35K:-}
