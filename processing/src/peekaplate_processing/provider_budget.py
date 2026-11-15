"""Fail-closed run-scoped provider-call budget reservation client."""

from __future__ import annotations

import asyncio
import os
import uuid
from typing import Any

import httpx

from peekaplate_processing.errors import ExtractionError


class ProviderBudgetError(ExtractionError):
    """Raised when the provider-call budget is exhausted or cannot be verified."""


class ProviderBudgetGate:
    """Client for reserving an atomic provider-call unit before an outbound request."""

    def __init__(self, url: str, token: str, *, timeout: float = 5.0) -> None:
        if not url or not token:
            raise ProviderBudgetError("Provider call budget gate requires a URL and token.")
        self.url = url
        self.token = token
        self.timeout = timeout

    @classmethod
    def from_env(cls, *, required: bool = False) -> ProviderBudgetGate | None:
        url = os.environ.get("PEEK_BUDGET_URL", "").strip()
        token = os.environ.get("PEEK_BUDGET_TOKEN", "").strip()
        if not url and not token:
            if required:
                raise ProviderBudgetError("Provider call budget gate is required but unconfigured.")
            return None
        if not url or not token:
            raise ProviderBudgetError("Provider call budget gate configuration is incomplete.")
        return cls(url, token)

    def reserve(self, provider: str) -> dict[str, Any]:
        """Atomically reserve 1 outbound provider call or fail closed."""
        provider_name = (provider or "").strip() or "unknown"
        reservation_key = uuid.uuid4().hex
        try:
            response = httpx.post(
                self.url,
                json={"reservation_key": reservation_key, "provider": provider_name},
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Content-Type": "application/json",
                },
                timeout=self.timeout,
                follow_redirects=False,
            )
        except (httpx.HTTPError, OSError, ValueError) as error:
            raise ProviderBudgetError("Provider call budget service is unavailable.") from error

        try:
            payload = response.json()
        except ValueError as error:
            raise ProviderBudgetError("Provider call budget service returned invalid JSON.") from error

        if not isinstance(payload, dict):
            raise ProviderBudgetError("Provider call budget service returned a malformed payload.")

        if response.status_code == 429 or payload.get("granted") is False:
            used = payload.get("used_calls")
            maximum = payload.get("max_calls")
            if isinstance(used, int) and isinstance(maximum, int):
                raise ProviderBudgetError(
                    f"Provider call budget exhausted ({used}/{maximum}); outbound request blocked."
                )
            raise ProviderBudgetError("Provider call budget exhausted; outbound request blocked.")

        if (
            response.status_code != 200
            or payload.get("granted") is not True
            or payload.get("reservation_key") != reservation_key
            or type(payload.get("used_calls")) is not int
            or type(payload.get("max_calls")) is not int
        ):
            raise ProviderBudgetError(
                f"Provider call budget reservation failed (HTTP {response.status_code})."
            )
        return payload

    async def areserve(self, provider: str) -> dict[str, Any]:
        """Async wrapper around reserve() for asyncio extraction paths."""
        return await asyncio.to_thread(self.reserve, provider)
