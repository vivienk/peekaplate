"""Export explicitly reviewed decorative artwork for the diner build.

This trusted operator command exports no dishes, evidence or approval of food
facts. Commit its output through normal code review before rebuilding the diner.
"""
import argparse
import base64
import io
import json
import shutil
import tempfile
import unicodedata
from pathlib import Path

from PIL import Image

from .ingredient_icons import IconStore, ingredient_identity


def export_diner_icons(store, selections, output):
    """Selections map exact display names to reviewed immutable asset IDs.

    Output must be new, preventing stale approved files from surviving a refresh.
    Stage everything first: a bad selection never yields a partial catalogue.
    """
    output = Path(output)
    if output.exists():
        raise ValueError("Use a new output directory")
    if not isinstance(selections, dict) or len(selections) > 1000:
        raise ValueError("Expected at most 1000 named selections")
    manifest, files = {}, {}
    for name, key in selections.items():
        if not isinstance(name, str) or not isinstance(key, str):
            raise ValueError("Invalid artwork selection")
        identity = ingredient_identity(name)
        label = " ".join(unicodedata.normalize("NFKC", name).lower().split())
        if not identity or label in manifest or not store.resolve(key, identity):
            raise ValueError("Every selection must have matching reviewed artwork")
        asset = store.asset(key)
        data = base64.b64decode(store._read("blobs", asset.asset_sha256)["base64"], validate=True)
        # Recheck bytes read for export, not just the earlier catalogue lookup.
        import hashlib
        if hashlib.sha256(data).hexdigest() != asset.asset_sha256:
            raise ValueError("Asset changed during export")
        with Image.open(io.BytesIO(data)) as picture:
            extension = {"PNG": "png", "WEBP": "webp"}[picture.format]
        filename = f"{asset.asset_sha256}.{extension}"
        files[filename] = data
        manifest[label] = filename
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".ingredient-icons-", dir=output.parent))
    try:
        for filename, data in files.items():
            (stage / filename).write_bytes(data)
        (stage / "catalogue.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
        stage.rename(output)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalogue", type=Path, required=True)
    parser.add_argument("--selections", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        with args.selections.open("rb") as handle:
            raw = handle.read(200_001)
        if len(raw) > 200_000:
            raise ValueError("Selections too large")
        export_diner_icons(IconStore(args.catalogue), json.loads(raw), args.output)
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        parser.exit(1, "Export failed; check approved selections and use a new output directory.\n")
    print("Exported reviewed diner decorations; food publication gates are unchanged.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
