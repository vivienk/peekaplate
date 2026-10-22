import io
import os
import tempfile
import unittest
from contextlib import chdir, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from peekaplate_processing.extract_menus import extract_menus, main


class ConfigurationTests(unittest.TestCase):

    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.directory=Path(self.temporary.name)
        self.input=self.directory/"menu.txt"
        self.input.write_text("Name: Soup", encoding="utf-8")
        self.output=self.directory/"report.json"
        self.environment=self.directory/"keys.env"
        self.environment.write_text(
            "OCR_SPACE_API_KEY=example-ocr-test-key\n"
            "MENU_AI_API_KEY=example-openrouter-test-key\n"
            "MENU_AI_API_URL=https://openrouter.ai/api/v1/chat/completions\n"
            "MENU_AI_MODEL=openrouter/free\n",
            encoding="utf-8",
        )
        self.result=extract_menus(self.input)

    def tearDown(self):
        self.temporary.cleanup()

    def run_cli(self, arguments, environment=None):
        output=io.StringIO()
        errors=io.StringIO()
        with patch.dict(os.environ, environment or {}, clear=True), redirect_stdout(output), redirect_stderr(errors):
            with patch("peekaplate_processing.extract_menus.extract_menus", return_value=self.result) as extract:
                status=main(["--input", str(self.input), "--output", str(self.output), *arguments])
        return status,extract.call_args.kwargs,output.getvalue()+errors.getvalue()

    def test_explicit_env_file_configures_openrouter_and_ocr_without_exposing_keys(self):
        status,arguments,messages=self.run_cli(["--mode", "ai", "--env-file", str(self.environment)])
        self.assertEqual(status, 0)
        self.assertEqual(arguments["api_url"], "https://openrouter.ai/api/v1/chat/completions")
        self.assertEqual(arguments["model"], "openrouter/free")
        self.assertEqual(arguments["api_key"], "example-openrouter-test-key")
        self.assertEqual(arguments["ocr_api_key"], "example-ocr-test-key")
        for key in ["example-openrouter-test-key", "example-ocr-test-key"]:
            self.assertNotIn(key, messages)
            self.assertNotIn(key, self.output.read_text())

    def test_shell_keys_and_cli_provider_options_override_env_file(self):
        status,arguments,_=self.run_cli(
            ["--mode", "ai", "--env-file", str(self.environment), "--api-url", "https://provider.example/chat", "--model", "explicit-model"],
            {"MENU_AI_API_KEY":"shell-ai-key", "OCR_SPACE_API_KEY":"shell-ocr-key"},
        )
        self.assertEqual(status, 0)
        self.assertEqual(arguments["api_key"], "shell-ai-key")
        self.assertEqual(arguments["ocr_api_key"], "shell-ocr-key")
        self.assertEqual(arguments["api_url"], "https://provider.example/chat")
        self.assertEqual(arguments["model"], "explicit-model")

    def test_default_env_file_is_loaded_from_working_directory(self):
        (self.directory/".env").write_text(self.environment.read_text(), encoding="utf-8")
        with chdir(self.directory):
            status,arguments,_=self.run_cli(["--mode", "ai"])
        self.assertEqual(status, 0)
        self.assertEqual(arguments["model"], "openrouter/free")
        self.assertEqual(arguments["api_key"], "example-openrouter-test-key")

    def test_env_file_values_are_literal_without_variable_interpolation(self):
        self.environment.write_text('MENU_AI_API_KEY="${SHELL_SECRET}"\n', encoding="utf-8")
        status,arguments,_=self.run_cli(["--env-file", str(self.environment)], {"SHELL_SECRET":"must-not-expand"})
        self.assertEqual(status, 0)
        self.assertEqual(arguments["api_key"], "${SHELL_SECRET}")

    def test_absent_env_file_preserves_local_extraction(self):
        with patch.dict(os.environ, {}, clear=True), redirect_stdout(io.StringIO()):
            status=main(["--input", str(self.input), "--output", str(self.output), "--env-file", str(self.directory/"missing.env")])
        self.assertEqual(status, 0)
        self.assertIn('"name": "Soup"', self.output.read_text())

    def test_invalid_env_encoding_has_sanitized_error(self):
        self.environment.write_bytes(b"MENU_AI_API_KEY=\xff\xfe")
        errors=io.StringIO()
        with patch.dict(os.environ, {}, clear=True), redirect_stderr(errors):
            with self.assertRaises(SystemExit) as raised:
                main(["--input", str(self.input), "--output", str(self.output), "--env-file", str(self.environment)])
        self.assertEqual(raised.exception.code, 1)
        self.assertIn("UTF-8", errors.getvalue())
        self.assertFalse(self.output.exists())
