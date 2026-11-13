import json
import tempfile
import unittest
from pathlib import Path

from peekaplate_processing.ingredient_icon_export import export_diner_icons, main
from peekaplate_processing.ingredient_icons import IconStore, ingredient_identity
from test_ingredient_icons import png


class DinerIconExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = IconStore(self.root / "store")
        self.key = self.store.register(png(), ingredient_id=ingredient_identity("coconut"),
                                       origin="generated", provenance="Synthetic test",
                                       recipe="test.v1", rights_confirmed=True)

    def approve(self):
        self.store.review(self.key, status="approved", reviewer="Test", reason="Synthetic test")

    def test_coconut_review_export_bytes_and_exact_name_manifest(self):
        self.approve()
        selections = self.root / "selections.json"
        selections.write_text(json.dumps({"  COCONUT  ": self.key}))
        output = self.root / "export"
        self.assertEqual(main(["--catalogue", str(self.store.root), "--selections", str(selections),
                               "--output", str(output)]), 0)
        manifest = json.loads((output / "catalogue.json").read_text())
        self.assertEqual(list(manifest), ["coconut"])
        self.assertEqual((output / manifest["coconut"]).read_bytes(), png())
        self.assertEqual(len(list(output.iterdir())), 2)
        with self.assertRaises(ValueError):
            export_diner_icons(self.store, {}, output)

    def test_pending_rejected_wrong_ingredient_and_corruption_never_export(self):
        output = self.root / "export"
        with self.assertRaises(ValueError):
            export_diner_icons(self.store, {"Coconut": self.key}, output)
        self.approve()
        for selections in [{"Coconut milk": self.key}, {"Coconut": self.key, " coconut ": self.key},
                           {"Coconut": self.key, "Salmon": self.key}, {"../coconut": self.key}]:
            with self.assertRaises(ValueError):
                export_diner_icons(self.store, selections, output)
            self.assertFalse(output.exists())
        asset = self.store.asset(self.key)
        self.store._path("blobs", asset.asset_sha256).write_text('{"base64":"eA=="}')
        with self.assertRaises(ValueError):
            export_diner_icons(self.store, {"Coconut": self.key}, output)
        self.assertFalse(output.exists())

    def test_rejected_art_is_not_exported(self):
        self.store.review(self.key, status="rejected", reviewer="Test", reason="Wrong style")
        with self.assertRaises(ValueError):
            export_diner_icons(self.store, {"Coconut": self.key}, self.root / "export")


if __name__ == "__main__":
    unittest.main()
