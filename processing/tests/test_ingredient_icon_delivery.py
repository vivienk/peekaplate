import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.ingredient_icon_delivery import HostedIconDelivery
from peekaplate_processing.ingredient_icon_generation import complete_generation, generation_request
from peekaplate_processing.ingredient_icons import IconStore
from test_ingredient_icons import png


class HostedArtworkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = IconStore(Path(self.temp.name))
        request = generation_request("grilled chicken", provider="test", model="test")
        self.key = complete_generation(self.store, request, png(), rights_confirmed=True)["asset_id"]
        self.delivery = HostedIconDelivery("https://art.example", "11111111-1111-4111-8111-111111111111", "test-token")

    def response(self, path, payload=None):
        if payload is None:
            return {"state": None}
        return {"state": {"label": payload["label"], "version": payload["expectedVersion"] + 1,
                          "status": "approved", "sha256": payload["sha256"]}}

    def test_approval_automatically_delivers_exact_bytes_and_retry_has_no_new_effect(self):
        with patch.object(HostedIconDelivery, "from_environment", return_value=self.delivery), \
             patch.object(self.delivery, "request", side_effect=self.response) as request:
            self.store.review(self.key, status="approved", reviewer="test", reason="Style checked")
            payload = request.call_args_list[1].args[1]
            import base64
            self.assertEqual(base64.b64decode(payload["pngBase64"]), png())
            self.assertEqual(payload["label"], "grilled chicken")
            self.assertEqual(payload["sourceAssetId"], self.key)
            self.assertEqual(payload["expectedVersion"], 0)
            self.store.review(self.key, status="approved", reviewer="test", reason="Style checked")
            self.assertEqual(request.call_count, 2)
        self.assertNotIn("test-token", "".join(p.read_text() for p in self.store.root.rglob("*.json")))

    def test_lost_response_retains_original_command_and_version(self):
        with patch.object(HostedIconDelivery, "from_environment", return_value=self.delivery), \
             patch.object(self.delivery, "request", side_effect=[{"state": None}, ExtractionError("network")]) as failed:
            with self.assertRaises(ExtractionError):
                self.store.review(self.key, status="approved", reviewer="test", reason="Style checked")
            original = failed.call_args_list[1].args[1]
        with patch.object(HostedIconDelivery, "from_environment", return_value=self.delivery), \
             patch.object(self.delivery, "request", side_effect=self.response) as retried:
            self.store.review(self.key, status="approved", reviewer="test", reason="Style checked")
            self.assertEqual(retried.call_count, 1)
            self.assertEqual(retried.call_args.args[1], original)

    def test_transparent_indexed_png_approval_preserves_exact_bytes_for_delivery(self):
        import base64
        data = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgAQMAAABJtOi3AAAABlBMVEUAAAD/eFCXci8oAAAAAXRSTlMAQObYZgAAAA9JREFUeJxjYKA6aKCmYQAnIACBGPqPSwAAAABJRU5ErkJggg==")
        request = generation_request("coconut", provider="test", model="test")
        key = complete_generation(self.store, request, data, rights_confirmed=True)["asset_id"]
        with patch.object(HostedIconDelivery, "from_environment", return_value=self.delivery), \
             patch.object(self.delivery, "request", side_effect=self.response) as sent:
            self.store.review(key, status="approved", reviewer="test", reason="Style checked")
        self.assertEqual(base64.b64decode(sent.call_args.args[1]["pngBase64"]), data)

    def test_unreviewed_or_rejected_art_never_delivers(self):
        with patch.object(self.delivery, "request") as request:
            with self.assertRaises(ValueError):
                self.delivery.deliver(self.store, self.key, "not reviewed")
            with patch.object(HostedIconDelivery, "from_environment", return_value=self.delivery):
                self.store.review(self.key, status="rejected", reviewer="test", reason="Wrong style")
            request.assert_not_called()

    def test_wrong_response_does_not_record_delivery(self):
        with patch.object(HostedIconDelivery, "from_environment", return_value=self.delivery), \
             patch.object(self.delivery, "request", side_effect=[{"state": None}, {"state": {"status": "approved"}}]):
            with self.assertRaises(ValueError):
                self.store.review(self.key, status="approved", reviewer="test", reason="Style checked")
        self.assertFalse((self.store.root / "delivered").exists())

    def test_configuration_rejects_partial_or_unsafe_origins(self):
        with patch.dict(os.environ, {"INGREDIENT_ICON_API_URL": "https://example.com"}, clear=True):
            with self.assertRaises(ValueError):
                HostedIconDelivery.from_environment()
        for url in ["http://example.com", "https://user:password@example.com", "https://example.com/?token=x"]:
            with self.assertRaises(ValueError):
                HostedIconDelivery(url, self.delivery.venue, "test-token")


if __name__ == "__main__":
    unittest.main()
