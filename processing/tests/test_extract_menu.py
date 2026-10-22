import json
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal
from http.client import IncompleteRead
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

from peekaplate_processing import DishDraft
from peekaplate_processing.extract_menus import main
from peekaplate_processing.menu_text import ExtractionError, extract_dishes as extract_menus
from peekaplate_processing.storage import save_drafts


class MenuExtractionTests(unittest.TestCase):

    def setUp(self):
        self.fixture=Path(__file__).parent/"fixtures"/"menu.txt"
        self.menu_text=self.fixture.read_text(encoding="utf-8")
        self.ai_dish={
            "name":"Tomato Soup",
            "description":"Slow-cooked tomato soup.",
            "category":"Starters",
            "price_amount":"8.50",
            "price_currency":"CAD",
            "ingredients":["tomatoes", "onion", "basil"],
            "source_text":self.menu_text.split("\n\n")[0],
        }

    def response(self, dishes=None, finish_reason="stop"):
        content=json.dumps({"dishes":[self.ai_dish] if dishes is None else dishes})
        return json.dumps({"choices":[{
            "finish_reason":finish_reason,
            "message":{"content":content},
        }]}).encode()

    def call_ai(self, response, **options):
        with patch("peekaplate_processing.menu_text.build_opener") as factory:
            connection=MagicMock()
            connection.read.return_value=response
            factory.return_value.open.return_value.__enter__.return_value=connection
            drafts=extract_menus(
                self.menu_text,
                "synthetic-menu-1",
                mode="ai",
                api_url="https://example.invalid/v1/chat/completions",
                model="test-model",
                **options,
            )
            return drafts,factory.return_value.open

    def test_fixture_extracts_three_dishes_with_checked_fields(self):
        drafts=extract_menus(self.menu_text, "synthetic-menu-1")

        self.assertEqual([draft.name for draft in drafts], ["Tomato Soup", "Garden Salad", "Chef's Special"])
        self.assertTrue(all(isinstance(draft, DishDraft) for draft in drafts))
        self.assertEqual(drafts[0].price_amount, Decimal("8.50"))
        self.assertEqual(drafts[0].price_currency, "CAD")
        self.assertEqual(drafts[0].category, "Starters")
        self.assertEqual(drafts[0].description, "Slow-cooked tomato soup.")
        self.assertEqual(drafts[0].ingredients, ["tomatoes", "onion", "basil"])
        self.assertEqual(drafts[1].price_amount, Decimal("10.00"))
        self.assertIsNone(drafts[1].price_currency)
        self.assertIsNone(drafts[1].ingredients)
        self.assertIsNone(drafts[2].price_amount)
        self.assertTrue(all(draft.source_id=="synthetic-menu-1" for draft in drafts))
        self.assertTrue(all(draft.source_text in self.menu_text for draft in drafts))
        self.assertTrue(all(draft.status=="needs_review" for draft in drafts))

    def test_unknown_fields_get_warnings_without_inventing_ingredients(self):
        drafts=extract_menus("Name: Basil Soup\nDescription: A soup with basil.", "menu-1")
        draft=drafts[0]

        self.assertIsNone(draft.ingredients)
        self.assertIsNone(draft.price_amount)
        self.assertIsNone(draft.price_currency)
        self.assertIn("Ingredients are unknown.", draft.review_warnings)
        self.assertIn("Price is unknown.", draft.review_warnings)

    def test_inline_description_price_prefix_and_crlf_are_supported(self):
        text="Toast — Toasted bread — CAD 5.00\r\nIngredients: bread; butter\r\n"
        draft=extract_menus(text, "menu-1")[0]

        self.assertEqual(draft.name, "Toast")
        self.assertEqual(draft.description, "Toasted bread")
        self.assertEqual(draft.price_amount, Decimal("5.00"))
        self.assertEqual(draft.ingredients, ["bread", "butter"])
        self.assertIn(draft.source_text, text)

    def test_labelled_unpriced_dish_can_have_a_price_field(self):
        draft=extract_menus("Name: Soup\nPrice: CAD 0\nDescription: Complimentary soup.", "menu-1")[0]

        self.assertEqual(draft.price_amount, Decimal("0"))
        self.assertEqual(draft.price_currency, "CAD")

    def test_unsupported_or_ambiguous_local_input_fails_without_partial_results(self):
        invalid_inputs=[
            "Soup for 2",
            "Soup — -8.50 CAD",
            "Soup — 8,50 CAD",
            "Soup — USD 8.50 CAD",
            "Soup — 8.50 CAD\nPrice: 9.00 CAD",
            "Name: Soup\nCategory: Starters\nCategory: Mains",
            "Soup — 8.50 CAD\nIngredients: tomatoes,",
            "Soup — 8.50 CAD\n\nUnrecognized second block",
        ]
        for text in invalid_inputs:
            with self.subTest(text=text):
                with self.assertRaises(ExtractionError):
                    extract_menus(text, "menu-1")

    def test_input_limits_and_modes_are_checked_before_processing(self):
        for text,source_id,options in [
            ("", "menu-1", {}),
            ("   ", "menu-1", {}),
            ("Name: Soup", "   ", {}),
            ("Name: Soup\0", "menu-1", {}),
            ("x"*100_001, "menu-1", {}),
            ("Name: Soup", "menu-1", {"mode":"unknown"}),
        ]:
            with self.subTest(source_id=source_id, options=options):
                with self.assertRaises(ExtractionError):
                    extract_menus(text, source_id, **options)

    def test_ai_request_and_validated_results_use_configured_provider(self):
        drafts,request=self.call_ai(self.response(), api_key="synthetic-test-key", timeout=12)
        sent_request=request.call_args.args[0]
        payload=json.loads(sent_request.data)

        self.assertEqual(payload["model"], "test-model")
        self.assertEqual(payload["response_format"], {"type":"json_object"})
        self.assertEqual(json.loads(payload["messages"][1]["content"])["menu_text"], self.menu_text)
        self.assertEqual(sent_request.get_header("Authorization"), "Bearer synthetic-test-key")
        self.assertEqual(request.call_args.kwargs["timeout"], 12)
        self.assertEqual(drafts[0].source_id, "synthetic-menu-1")
        self.assertEqual(drafts[0].price_amount, Decimal("8.50"))
        self.assertIn("AI extraction requires human verification.", drafts[0].review_warnings)

    def test_ai_rejects_authority_fields_and_unsupported_facts(self):
        changes=[
            {"source_id":"another-source"},
            {"status":"published"},
            {"image_id":"invented-image"},
            {"name":"Lobster"},
            {"description":"Contains lobster."},
            {"category":"Desserts"},
            {"ingredients":["lobster"]},
            {"price_amount":"999.00"},
            {"price_currency":"EUR"},
            {"source_text":"This excerpt was invented."},
        ]
        for change in changes:
            with self.subTest(change=change):
                with self.assertRaises(ExtractionError):
                    self.call_ai(self.response([{**self.ai_dish, **change}]))

    def test_ai_rejects_malformed_empty_or_truncated_responses(self):
        responses=[
            b"not json",
            b"{}",
            b"x"*1_048_577,
            self.response([]),
            self.response(finish_reason="length"),
            json.dumps({"choices":[{"finish_reason":"stop", "message":{"content":"```json\n{}\n```"}}]}).encode(),
            json.dumps({"choices":[{"finish_reason":"stop", "message":{"content":'{"dishes":[],"extra":true}'}}]}).encode(),
        ]
        for response in responses:
            with self.subTest(size=len(response)):
                with self.assertRaises(ExtractionError):
                    self.call_ai(response)

    def test_ai_configuration_is_required_and_transport_errors_are_sanitized(self):
        for options in [
            {},
            {"api_url":"https://example.invalid/chat/completions"},
            {"api_url":"file:///tmp/provider", "model":"test"},
            {"api_url":"http://example.invalid/chat/completions", "model":"test"},
            {"api_url":"https://user:password@example.invalid/chat/completions", "model":"test"},
            {"api_url":"https://example.invalid/chat/completions", "model":"test", "timeout":0},
        ]:
            with self.subTest(options=options):
                with self.assertRaises(ExtractionError):
                    extract_menus(self.menu_text, "menu-1", mode="ai", **options)

        for error in [URLError("private provider details"), HTTPError("https://example.invalid", 401, "private provider details", {}, None), IncompleteRead(b"private provider details")]:
            with self.subTest(error_type=type(error).__name__):
                with patch("peekaplate_processing.menu_text.build_opener") as factory:
                    factory.return_value.open.side_effect=error
                    with self.assertRaises(ExtractionError) as caught:
                        extract_menus(self.menu_text, "menu-1", mode="ai", api_url="https://example.invalid/chat/completions", model="test")
                    self.assertNotIn("private provider details", str(caught.exception))
                    factory.return_value.open.assert_called_once()

    def test_ai_rejects_multiline_keys_without_exposing_them(self):
        with self.assertRaises(ExtractionError) as caught:
            self.call_ai(self.response(), api_key="synthetic-private-key\ninvalid")
        self.assertNotIn("synthetic-private-key", str(caught.exception))

    def test_ai_rejects_partial_numeric_matches_in_comma_prices(self):
        self.menu_text="Soup — 8,50 CAD"
        dish={"name":"Soup", "price_amount":"8", "source_text":self.menu_text}
        with self.assertRaises(ExtractionError):
            self.call_ai(self.response([dish]))

    def test_ai_dish_limit_and_nonlist_results_are_rejected(self):
        for dishes in [[self.ai_dish]*101, {"name":"Soup"}, [None]]:
            with self.subTest(result_type=type(dishes).__name__):
                with self.assertRaises(ExtractionError):
                    self.call_ai(self.response(dishes))

    def test_review_rejects_ingredients_supported_only_by_partial_words(self):
        self.menu_text="Champignon Soup"
        dish={"name":"Champignon Soup", "ingredients":["ham"], "source_text":self.menu_text}
        with self.assertRaises(ExtractionError):
            self.call_ai(self.response([dish]))

        self.menu_text="Ham Soup\nIngredients: ham, sea salt"
        dish={"name":"Ham Soup", "ingredients":["ham", "sea salt"], "source_text":self.menu_text}
        drafts,_=self.call_ai(self.response([dish]))
        self.assertEqual(drafts[0].ingredients, ["ham", "sea salt"])

    def test_review_accepts_sentence_punctuation_without_partial_numeric_matches(self):
        for suffix in [".", ", served hot."]:
            with self.subTest(suffix=suffix):
                self.menu_text=f"Soup costs CAD 8.50{suffix}"
                dish={"name":"Soup", "price_amount":"8.50", "price_currency":"CAD", "source_text":self.menu_text}
                drafts,_=self.call_ai(self.response([dish]))
                self.assertEqual(drafts[0].price_amount, Decimal("8.50"))

        self.menu_text="Soup costs CAD 1,000"
        dish={"name":"Soup", "price_amount":"1", "source_text":self.menu_text}
        with self.assertRaises(ExtractionError):
            self.call_ai(self.response([dish]))

    def test_review_normalizes_unknown_empty_ingredient_lists(self):
        self.menu_text="Soup — 8.50 CAD"
        dish={"name":"Soup", "ingredients":[], "source_text":self.menu_text}
        drafts,_=self.call_ai(self.response([dish]))

        self.assertIsNone(drafts[0].ingredients)
        self.assertIn("Ingredients are unknown.", drafts[0].review_warnings)

    def test_save_validated_json_preserves_decimals_and_existing_files(self):
        drafts=extract_menus(self.menu_text, "menu-1")
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/"work"/"drafts.json"
            save_drafts(drafts, output)
            original=output.read_bytes()
            saved=json.loads(original)

            self.assertEqual(saved[0]["price_amount"], "8.50")
            self.assertEqual([DishDraft.model_validate(item) for item in saved], drafts)
            with self.assertRaises(ExtractionError):
                save_drafts(drafts, output)
            self.assertEqual(output.read_bytes(), original)

    def test_invalid_drafts_do_not_create_output(self):
        draft=extract_menus("Name: Soup", "menu-1")[0]
        draft.review_warnings.append(123)
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/"drafts.json"
            with self.assertRaises(ExtractionError):
                save_drafts([draft], output)
            self.assertFalse(output.exists())

    def test_cli_reads_menu_and_saves_drafts_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/"drafts.json"
            result=subprocess.run(
                [sys.executable, "-m", "peekaplate_processing.extract_menus", "--input", str(self.fixture), "--output", str(output)],
                capture_output=True,
                text=True,
                timeout=10,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            report=json.loads(output.read_text())
            self.assertEqual(report["status"], "complete")
            dishes=report["drafts"]
            self.assertEqual(len(dishes), 3)
            self.assertTrue(dishes[0]["source_id"].startswith("sha256:"))
            self.assertIn("Saved 3 drafts", result.stdout)

    def test_cli_rejects_invalid_input_without_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/"menu.txt"
            source.write_text("Unrecognized text", encoding="utf-8")
            output=Path(directory)/"drafts.json"
            result=subprocess.run(
                [sys.executable, "-m", "peekaplate_processing.extract_menus", "--input", str(source), "--output", str(output)],
                capture_output=True,
                text=True,
                timeout=10,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(output.read_text())["status"], "failed")
            self.assertNotIn("Traceback", result.stderr)

    def test_cli_existing_output_is_rejected_before_calling_ai(self):
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/"drafts.json"
            output.write_text("previous output", encoding="utf-8")
            with patch("peekaplate_processing.menu_text._extract_ai") as request:
                with self.assertRaises(SystemExit):
                    with patch("sys.stderr"):
                        main(["--input", str(self.fixture), "--output", str(output), "--mode", "ai"])
                request.assert_not_called()
            self.assertEqual(output.read_text(), "previous output")


if __name__=="__main__":
    unittest.main()
