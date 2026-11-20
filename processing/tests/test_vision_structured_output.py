"""Offline request-seam controls for the V4 json_schema constraint.

Only httpx.MockTransport is used: no socket, no .env, no provider response is invented.
The outbound schema must stay byte-identical to V4Batch.model_json_schema().
"""
import asyncio
import json
import unittest
from unittest.mock import patch

import httpx
import openai
from langchain_openai import ChatOpenAI
from peekaplate_processing.model_providers import GOOGLE_AI_STUDIO_HOST

from peekaplate_processing.vision_extraction import (
    V4Batch,
    V4_RESPONSE_FORMAT_NAME,
    extract_vision_v4,
    vision_response_format,
)

GOOGLE_BASE_URL = f"https://{GOOGLE_AI_STUDIO_HOST}/v1beta/openai"
PAGE = [{"page_number": 1, "image_url": "data:,"}]


def completion(content, finish_reason="stop"):
    return httpx.Response(200, json={
        "id": "synthetic",
        "object": "chat.completion",
        "created": 1,
        "model": "synthetic",
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        "choices": [{"index": 0, "finish_reason": finish_reason,
                     "message": {"role": "assistant", "content": content}}],
    })


class VisionStructuredOutputTests(unittest.TestCase):
    def run_capture(self, respond, *, base_url=GOOGLE_BASE_URL, attempts=None, extra_body=None):
        """Run one real ChatOpenAI request through MockTransport and return wire bodies."""
        captured = []

        def recording(request):
            captured.append(json.loads(request.content))
            return respond()

        async_client = httpx.AsyncClient(transport=httpx.MockTransport(recording))
        sync_client = httpx.Client(transport=httpx.MockTransport(recording))
        try:
            llm = ChatOpenAI(model="models/gemini-3-flash-preview", api_key="dummy-offline",
                             base_url=base_url, max_retries=0, extra_body=extra_body,
                             http_client=sync_client, http_async_client=async_client)
            result = extract_vision_v4(llm, PAGE, timeout=30, attempts=attempts)
        finally:
            asyncio.run(async_client.aclose())
            sync_client.close()
        return result, captured

    def test_google_request_carries_unchanged_schema_with_strict_json_schema(self):
        dish = {"page_number": 1, "name": "Soup",
                "box": {"ymin": 1, "xmin": 2, "ymax": 3, "xmax": 4}}
        (dishes, errors), captured = self.run_capture(
            lambda: completion(json.dumps({"dishes": [dish]})))
        self.assertEqual(len(captured), 1)
        payload = captured[0]
        schema = V4Batch.model_json_schema()
        self.assertEqual(payload["response_format"], {
            "type": "json_schema",
            "json_schema": {"name": V4_RESPONSE_FORMAT_NAME, "schema": schema, "strict": True},
        })
        # Identity of the contract, not a frozen constant: the wire schema is the live schema.
        self.assertEqual(json.dumps(payload["response_format"]["json_schema"]["schema"], sort_keys=True),
                         json.dumps(schema, sort_keys=True))
        self.assertEqual(payload["messages"][0]["role"], "system")
        system = payload["messages"][0]["content"]
        self.assertIn('REQUIRED JSON SCHEMA:\n' + json.dumps(schema), system)
        self.assertIn('- box: {"ymin": int, "xmin": int, "ymax": int, "xmax": int}', system)
        self.assertNotIn("[ymin, xmin, ymax, xmax]", system)
        self.assertEqual([d.name for d in dishes], ["Soup"])
        self.assertEqual(errors, [])

    def test_openrouter_sends_google_prompt_and_schema_without_dropping_routing_options(self):
        reply = lambda: completion('{"dishes":[{"name":"Soup","box":{"ymin":1,"xmin":2,"ymax":3,"xmax":4}}]}')
        _, google = self.run_capture(reply)
        (dishes, errors), router = self.run_capture(
            reply, base_url="https://openrouter.ai/api/v1",
            extra_body={"provider": {"require_parameters": True}, "reasoning": {"effort": "low"}},
        )
        (google_payload,), (router_payload,) = google, router
        self.assertEqual(router_payload["messages"], google_payload["messages"])
        self.assertEqual(router_payload["response_format"], google_payload["response_format"])
        self.assertEqual(router_payload["provider"], {"require_parameters": True})
        self.assertEqual(router_payload["reasoning"], {"effort": "low"})
        self.assertEqual(([dish.name for dish in dishes], errors), (["Soup"], []))

    def test_non_google_request_keeps_prompt_only_transport(self):
        (dishes, _), captured = self.run_capture(
            lambda: completion('{"dishes":[{"name":"Soup","box":{"ymin":1,"xmin":2,"ymax":3,"xmax":4}}]}'),
            base_url="https://example.test/v1")
        self.assertEqual(len(captured), 1)
        self.assertNotIn("response_format", captured[0])
        self.assertIn("REQUIRED JSON SCHEMA:", captured[0]["messages"][0]["content"])
        self.assertEqual([d.name for d in dishes], ["Soup"])

    def test_invalid_response_fails_or_recovers_without_a_second_request(self):
        attempts = []
        with self.assertRaises(ValueError):
            self.run_capture(lambda: completion("not-json"), attempts=attempts)
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0]["failure_class"], "parse_error")

        attempts = []
        truncated = '{"dishes":[{"name":"Soup","box":{"ymin":1,"xmin":2,"ymax":3,"xmax":4}},]}'
        (dishes, errors), captured = self.run_capture(
            lambda: completion(truncated, finish_reason="length"), attempts=attempts)
        self.assertEqual(len(captured), 1)
        self.assertEqual([d.name for d in dishes], ["Soup"])
        self.assertTrue(any("malformed" in error for error in errors))
        self.assertTrue(any("token limit" in error for error in errors))

    def test_provider_rejection_is_explicit_and_not_retried_without_the_format(self):
        attempts = []
        requests = []

        def reject(request):
            requests.append(json.loads(request.content))
            return httpx.Response(400, json={"error": {"message": "synthetic schema rejection",
                                                       "type": "invalid_request_error"}})

        async_client = httpx.AsyncClient(transport=httpx.MockTransport(reject))
        sync_client = httpx.Client(transport=httpx.MockTransport(reject))
        try:
            llm = ChatOpenAI(model="models/gemini-3-flash-preview", api_key="dummy-offline",
                             base_url=GOOGLE_BASE_URL, max_retries=0,
                             http_client=sync_client, http_async_client=async_client)
            with self.assertRaises(openai.BadRequestError):
                extract_vision_v4(llm, PAGE, timeout=30, attempts=attempts)
        finally:
            asyncio.run(async_client.aclose())
            sync_client.close()
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["response_format"]["type"], "json_schema")
        self.assertEqual(attempts[0]["failure_class"], "provider_error")

    def test_incompatible_schema_is_refused_instead_of_downgraded(self):
        with patch.object(V4Batch, "model_json_schema", return_value={"type": "array"}):
            with self.assertRaises(ValueError):
                vision_response_format(GOOGLE_BASE_URL, V4Batch.model_json_schema())


if __name__ == "__main__":
    unittest.main()