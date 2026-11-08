import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.ocr_space import OCRSpaceClient


class OCRSpaceTests(unittest.TestCase):

    def payload(self, **changes):
        value={"OCRExitCode":1, "IsErroredOnProcessing":False, "ParsedResults":[{"FileParseExitCode":1, "ParsedText":"Soup  8.50 CAD"}]}
        value.update(changes)
        return json.dumps(value).encode()

    def transport(self, body):
        connection=MagicMock()
        connection.read.return_value=body
        opener=MagicMock()
        opener.open.return_value.__enter__.return_value=connection
        return opener

    def test_engine3_key_header_and_markdown_request_are_explicit(self):
        opener=self.transport(self.payload())
        with patch("peekaplate_processing.ocr_space.build_opener", return_value=opener):
            result=OCRSpaceClient("synthetic-key").extract(b"synthetic-image")
        request=opener.open.call_args.args[0]
        fields=parse_qs(request.data.decode())
        self.assertEqual(fields["OCREngine"], ["3"])
        self.assertEqual(fields["language"], ["auto"])
        self.assertEqual(fields["isTable"], ["true"])
        self.assertEqual(fields["isOverlayRequired"], ["true"])
        self.assertEqual(request.get_header("Apikey"), "synthetic-key")
        self.assertEqual(request.full_url, "https://api.ocr.space/parse/image")
        self.assertEqual(result["text"], "Soup  8.50 CAD")
        self.assertEqual(result["settings"]["OCREngine"], 3)

    def test_table_opt_out_serializes_false_without_changing_other_settings(self):
        opener=self.transport(self.payload())
        with patch("peekaplate_processing.ocr_space.build_opener", return_value=opener):
            client=OCRSpaceClient("synthetic-key", is_table=False)
            result=client.extract(b"synthetic-image")
        fields=parse_qs(opener.open.call_args.args[0].data.decode())
        self.assertIs(client.is_table, False)
        self.assertEqual(fields["isTable"], ["false"])
        self.assertEqual(fields["OCREngine"], ["3"])
        self.assertEqual(fields["language"], ["auto"])
        self.assertEqual(fields["isOverlayRequired"], ["true"])
        self.assertEqual(result["settings"], {"OCREngine":3, "language":"auto", "isTable":False, "isOverlayRequired":True})

    def test_table_setting_is_normalized_to_bool(self):
        for value,expected in [(0,False),(1,True)]:
            with self.subTest(value=value):
                self.assertIs(OCRSpaceClient("synthetic-key", is_table=value).is_table, expected)

    def test_table_cache_identity_preserves_default_key_and_separates_opt_out(self):
        image=b"synthetic-image"
        settings={"OCREngine":3, "language":"auto", "isTable":True, "isOverlayRequired":True}
        legacy_key=hashlib.sha256(json.dumps({"image":hashlib.sha256(image).hexdigest(), "settings":settings}, sort_keys=True).encode()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            opener=self.transport(self.payload())
            with patch("peekaplate_processing.ocr_space.build_opener", return_value=opener):
                default=OCRSpaceClient("synthetic-key", cache_dir=directory).extract(image)
                self.assertEqual(default["settings"], settings)
                self.assertTrue((Path(directory)/f"{legacy_key}.json").is_file())
                opted_out=OCRSpaceClient("synthetic-key", cache_dir=directory, is_table=False).extract(image)
                repeated=OCRSpaceClient(None, cache_dir=directory, is_table=False).extract(image)
                default_again=OCRSpaceClient(None, cache_dir=directory).extract(image)
            self.assertFalse(default["cache_hit"])
            self.assertFalse(opted_out["cache_hit"])
            self.assertIs(opted_out["settings"]["isTable"], False)
            self.assertTrue(repeated["cache_hit"])
            self.assertIs(repeated["settings"]["isTable"], False)
            self.assertTrue(default_again["cache_hit"])
            self.assertEqual(default_again["settings"], settings)
            self.assertEqual(opener.open.call_count, 2)
            self.assertEqual(len(list(Path(directory).glob("*.json"))), 2)

    def test_response_keeps_word_boxes_bound_to_uploaded_bytes(self):
        page={"FileParseExitCode":1, "ParsedText":"Soup 8.50 CAD", "TextOverlay":{"HasOverlay":True, "Lines":[{"Words":[{"WordText":"Soup", "Left":10, "Top":20, "Width":50, "Height":12}]}]}}
        opener=self.transport(self.payload(ParsedResults=[page]))
        with patch("peekaplate_processing.ocr_space.build_opener", return_value=opener):
            result=OCRSpaceClient("synthetic-key").extract(b"synthetic-image")
        self.assertEqual(result["region_status"], "available")
        self.assertEqual(result["regions"][0], {"text":"Soup", "left":10, "top":20, "width":50, "height":12})
        self.assertEqual(len(result["image_sha256"]), 64)

    def test_valid_engine3_cache_avoids_another_request_even_without_key(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch("peekaplate_processing.ocr_space.build_opener", return_value=self.transport(self.payload())) as factory:
                first=OCRSpaceClient("synthetic-key", cache_dir=directory).extract(b"image")
                second=OCRSpaceClient(None, cache_dir=directory).extract(b"image")
            self.assertFalse(first["cache_hit"])
            self.assertTrue(second["cache_hit"])
            factory.assert_called_once()
            if os.name == "posix":
                self.assertEqual(next(Path(directory).glob("*.json")).stat().st_mode&0o777, 0o600)

    def test_cache_is_separate_for_different_upload_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch("peekaplate_processing.ocr_space.build_opener", return_value=self.transport(self.payload())) as factory:
                client=OCRSpaceClient("synthetic-key", cache_dir=directory)
                client.extract(b"one")
                client.extract(b"two")
            self.assertEqual(factory.call_count, 2)
            self.assertEqual(len(list(Path(directory).glob("*.json"))), 2)

    def test_http_success_with_partial_failed_or_empty_ocr_is_rejected(self):
        bodies=[
            self.payload(OCRExitCode=2), self.payload(IsErroredOnProcessing=True),
            self.payload(ParsedResults=[]),
            self.payload(ParsedResults=[{"FileParseExitCode":-20,"ParsedText":"private details"}]),
            self.payload(ParsedResults=[{"FileParseExitCode":1,"ParsedText":""}]),
            b"invalid", b"x"*2_000_001,
        ]
        for body in bodies:
            with self.subTest(size=len(body)):
                with patch("peekaplate_processing.ocr_space.build_opener", return_value=self.transport(body)):
                    with self.assertRaises(ExtractionError) as caught:
                        OCRSpaceClient("synthetic-key").extract(b"image")
                self.assertNotIn("private details", str(caught.exception))

    def test_quota_retry_is_bounded_and_long_retry_after_is_not_ignored(self):
        opener=self.transport(self.payload())
        error=HTTPError("https://api.ocr.space",429,"private details",{"Retry-After":"1"},None)
        opener.open.side_effect=[error,opener.open.return_value]
        with patch("peekaplate_processing.ocr_space.build_opener", return_value=opener), patch("peekaplate_processing.ocr_space.time.sleep") as sleep:
            OCRSpaceClient("synthetic-key").extract(b"image")
        self.assertEqual(opener.open.call_count, 2)
        sleep.assert_called_once_with(1)
        opener.open.side_effect=HTTPError("https://api.ocr.space",429,"private details",{"Retry-After":"60"},None)
        opener.open.reset_mock()
        with patch("peekaplate_processing.ocr_space.build_opener", return_value=opener), patch("peekaplate_processing.ocr_space.time.sleep") as sleep:
            with self.assertRaises(ExtractionError):OCRSpaceClient("synthetic-key").extract(b"image")
        opener.open.assert_called_once()
        sleep.assert_not_called()

    def test_missing_demo_multiline_keys_and_oversized_uploads_fail_before_transport(self):
        for key,data in [(None,b"image"),("helloworld",b"image"),("private\nkey",b"image"),("test",b"x"*950_001)]:
            with self.subTest(key_present=bool(key)):
                with patch("peekaplate_processing.ocr_space.build_opener") as factory:
                    with self.assertRaises(ExtractionError) as caught:OCRSpaceClient(key).extract(data)
                    factory.assert_not_called()
                    self.assertNotIn("private", str(caught.exception))

    def test_server_failure_and_timeout_retry_once_then_use_success(self):
        failures=[HTTPError("https://api.ocr.space",500,"private",{},None), URLError("private"), TimeoutError("private")]
        for failure in failures:
            with self.subTest(kind=type(failure).__name__):
                opener=self.transport(self.payload())
                opener.open.side_effect=[failure,opener.open.return_value]
                with patch("peekaplate_processing.ocr_space.build_opener",return_value=opener), patch("peekaplate_processing.ocr_space.time.sleep") as sleep:
                    result=OCRSpaceClient("synthetic-key").extract(b"image")
                self.assertEqual(result["text"],"Soup  8.50 CAD")
                self.assertEqual(opener.open.call_count,2)
                sleep.assert_called_once_with(1)

    def test_persistent_server_failure_is_bounded_and_client_errors_are_not_retried(self):
        for code,calls in [(500,2),(401,1),(413,1)]:
            with self.subTest(code=code):
                opener=self.transport(self.payload())
                opener.open.side_effect=HTTPError("https://api.ocr.space",code,"private",{},None)
                with patch("peekaplate_processing.ocr_space.build_opener",return_value=opener), patch("peekaplate_processing.ocr_space.time.sleep"):
                    with self.assertRaises(ExtractionError):OCRSpaceClient("synthetic-key").extract(b"image")
                self.assertEqual(opener.open.call_count,calls)

    def test_transport_error_does_not_expose_response_or_key(self):
        opener=self.transport(self.payload())
        opener.open.side_effect=URLError("private secret")
        with patch("peekaplate_processing.ocr_space.build_opener", return_value=opener), patch("peekaplate_processing.ocr_space.time.sleep"):
            with self.assertRaises(ExtractionError) as caught:OCRSpaceClient("synthetic-key").extract(b"image")
        self.assertNotIn("private secret", str(caught.exception))
        self.assertNotIn("synthetic-key", str(caught.exception))


if __name__=="__main__":
    unittest.main()
