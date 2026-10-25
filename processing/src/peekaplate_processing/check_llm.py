"""One small schema request using the configured model; no OCR or files written."""
import argparse
import json
import os
import re

from dotenv import load_dotenv

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.run_pipeline import configured_llm
from peekaplate_processing.workflow import run_menu_graph


def response_preview(raw, llm):
    """Opt-in preview for the fixed synthetic check, never the menu pipeline."""
    content = getattr(raw, "content", None)
    text = content if isinstance(content, str) else "[non-text content]"
    secrets = [value for name, value in os.environ.items() if any(word in name.upper() for word in ("KEY", "TOKEN", "SECRET", "PASSWORD")) and len(value) >= 6]
    key = getattr(llm, "openai_api_key", None)

    if key is not None:
        secrets.append(key.get_secret_value())

    for secret in sorted(set(secrets), key=len, reverse=True):
        if secret:
            text = text.replace(secret, "[REDACTED]")

    text = re.sub(r"sk-[A-Za-z0-9_-]+", "[REDACTED]", text)
    finish = getattr(raw, "response_metadata", {}).get("finish_reason")

    if not isinstance(finish, str) or finish not in {"stop", "length", "content_filter", "tool_calls", "function_call"}:
        finish = "other"
    print(json.dumps({"finish_reason": finish, "content_characters": len(content) if isinstance(content, str) else None, "content_preview": text[:4000], "preview_truncated": len(text) > 4000}, ensure_ascii=True), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--show-response", action="store_true", help="Print a bounded, key-redacted response preview for the synthetic check only.")
    args = parser.parse_args(argv)
    load_dotenv(override=False, interpolate=False)

    try:
        llm = configured_llm()

    except ExtractionError as error:
        print(error)
        return 1
    print(f"Testing {llm.model_name} with one synthetic page and the actual dish schema.", flush=True)
    preview = (lambda raw: response_preview(raw, llm)) if args.show_response else None
    result = run_menu_graph(llm, [{"page_number": 1, "text": "Soup 8.50 CAD"}], on_response=preview)

    for error in result["errors"]:
        print(error)

    if not result["errors"] and result["dishes"]:
        print(f"Schema test passed: {len(result['dishes'])} grounded dish(es). Full-menu accuracy is not assessed.")
        return 0

    if not result["errors"]:
        print("Schema response was usable but contained no dishes for the test page.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
