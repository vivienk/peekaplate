"""Configurable Model Providers interface for menu extraction.

Provides an extensible registry supporting:
- google_studio / gemini (Google AI Studio)
- openrouter (OpenRouter unified gateway)
- a2agent (A2Agent / MiniMax)
- nara (Nara Router)
- openai (Direct OpenAI API)

Supports explicit selection via --provider or MENU_AI_PROVIDER env var,
with automatic precedence fallback matching the repository contract.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlsplit

from langchain_openai import ChatOpenAI
from peekaplate_processing.errors import ExtractionError

DEFAULT_TIMEOUT = 120
DEFAULT_MAX_TOKENS = 16384


@dataclass(frozen=True)
class ModelProviderConfig:
    name: str
    key_vars: tuple[str, ...]
    url_var: str | None
    model_var: str | None
    default_url: str | None
    default_model: str | None
    extra_body: dict[str, Any] | Callable[[str], dict[str, Any]] | None = None
    reasoning_effort: str | None = None


# Registry of known supported providers
PROVIDER_REGISTRY: dict[str, ModelProviderConfig] = {
    "google_studio": ModelProviderConfig(
        name="google_studio",
        key_vars=("GEMINI_API_KEY", "GOOGLE_API_KEY", "MENU_AI_API_KEY"),
        url_var="GEMINI_API_URL",
        model_var="GEMINI_MODEL",
        default_url="https://generativelanguage.googleapis.com/v1beta/openai",
        default_model="models/gemini-3-flash-preview",
        extra_body=None,
    ),
    "gemini": ModelProviderConfig(
        name="gemini",
        key_vars=("GEMINI_API_KEY", "GOOGLE_API_KEY", "MENU_AI_API_KEY"),
        url_var="GEMINI_API_URL",
        model_var="GEMINI_MODEL",
        default_url="https://generativelanguage.googleapis.com/v1beta/openai",
        default_model="models/gemini-3-flash-preview",
        extra_body=None,
    ),
    "openrouter": ModelProviderConfig(
        name="openrouter",
        key_vars=("OPENROUTER_API_KEY", "MENU_AI_API_KEY"),
        url_var="MENU_AI_API_URL",
        model_var="MENU_AI_MODEL",
        default_url="https://openrouter.ai/api/v1",
        default_model="google/gemini-3-flash-preview",
        extra_body={"reasoning": {"enabled": False}, "provider": {"require_parameters": True}},
    ),
    "a2agent": ModelProviderConfig(
        name="a2agent",
        key_vars=("a2agent_api_key",),
        url_var="a2agent_url",
        model_var="a2agent_api_MODEL",
        default_url="https://api.a2agent.me/v1",
        default_model="minimax-m3",
        extra_body=None,
    ),
    "nara": ModelProviderConfig(
        name="nara",
        key_vars=("NARA_ROUTER_KEY",),
        url_var="NARA_ROUTER_URL",
        model_var="NARA_ROUTER_MODEL",
        default_url="https://router.bynara.id/v1",
        default_model="minimax-m3.1-flash:free",
        reasoning_effort="none",
    ),
    "openai": ModelProviderConfig(
        name="openai",
        key_vars=("OPENAI_API_KEY", "MENU_AI_API_KEY"),
        url_var="MENU_AI_API_URL",
        model_var="MENU_AI_MODEL",
        default_url="https://api.openai.com/v1",
        default_model="gpt-4o-mini",
        extra_body=None,
    ),
}


def create_model_client(
    provider_name: str | None = None,
    *,
    timeout: int | float = DEFAULT_TIMEOUT,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    env: dict[str, str] | None = None,
) -> ChatOpenAI:
    """Instantiate a ChatOpenAI client based on provider config or environment auto-detection."""
    environ = os.environ if env is None else env

    # 1. Explicit provider selection
    if provider_name is None:
        provider_name = environ.get("MENU_AI_PROVIDER", "").strip().lower() or None

    if provider_name:
        canon_name = provider_name.lower().replace("-", "_")
        if canon_name not in PROVIDER_REGISTRY:
            known = ", ".join(sorted(PROVIDER_REGISTRY.keys()))
            raise ExtractionError(f"Unknown model provider '{provider_name}'. Supported: {known}")
        config = PROVIDER_REGISTRY[canon_name]
        return _build_client_from_config(config, timeout=timeout, max_tokens=max_tokens, environ=environ)

    # 2. Backward-compatible auto-detection order:
    # A2Agent -> Nara Router -> Generic MENU_AI_*
    a2_names = ("a2agent_api_key", "a2agent_url", "a2agent_api_MODEL")
    nara_names = ("NARA_ROUTER_KEY", "NARA_ROUTER_URL", "NARA_ROUTER_MODEL")

    if any(environ.get(n) for n in a2_names):
        names = a2_names
    elif any(environ.get(n) for n in nara_names):
        names = nara_names
    else:
        names = ("MENU_AI_API_KEY", "MENU_AI_API_URL", "MENU_AI_MODEL")

    key, endpoint, model = (environ.get(n, "").strip() for n in names)
    if not all((key, endpoint, model)):
        raise ExtractionError(f"Set {', '.join(names)} in .env.")

    base_url = endpoint.removesuffix("/").removesuffix("/chat/completions")
    try:
        url = urlsplit(base_url)
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError
    except ValueError:
        raise ExtractionError("Use an HTTPS model endpoint without embedded credentials.") from None
    if (url.hostname or "").endswith("googleapis.com") and not model.startswith("models/"):
        model = f"models/{model}"

    extra = (
        {"reasoning": {"enabled": False}, "provider": {"require_parameters": True}}
        if url.hostname == "openrouter.ai"
        else {}
    )
    reasoning = {"reasoning_effort": "none"} if url.hostname == "router.bynara.id" else {}

    return ChatOpenAI(
        **reasoning,
        model=model,
        api_key=key,
        base_url=base_url,
        timeout=timeout,
        max_retries=0,
        max_tokens=max_tokens,
        extra_body=extra,
    )


def _build_client_from_config(
    config: ModelProviderConfig,
    *,
    timeout: int | float,
    max_tokens: int,
    environ: dict[str, str] | os._Environ[str],
) -> ChatOpenAI:
    # Resolve API Key
    key = None
    for var in config.key_vars:
        val = environ.get(var, "").strip()
        if val:
            key = val
            break
    if not key:
        expected = " or ".join(config.key_vars)
        raise ExtractionError(f"Provider '{config.name}' requires setting {expected} in .env.")

    # Resolve URL & Model
    url_val = (environ.get(config.url_var, "") if config.url_var else "").strip()
    endpoint = url_val or config.default_url
    if not endpoint:
        raise ExtractionError(f"Provider '{config.name}' missing URL configuration.")

    model_val = (environ.get(config.model_var, "") if config.model_var else "").strip()
    model = model_val or config.default_model
    if not model:
        raise ExtractionError(f"Provider '{config.name}' missing Model configuration.")

    base_url = endpoint.removesuffix("/").removesuffix("/chat/completions")
    try:
        url = urlsplit(base_url)
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError
    except ValueError:
        raise ExtractionError("Use an HTTPS model endpoint without embedded credentials.") from None
    if (url.hostname or "").endswith("googleapis.com") and not model.startswith("models/"):
        model = f"models/{model}"

    # Compute extra body
    extra: dict[str, Any] = {}
    if callable(config.extra_body):
        extra = config.extra_body(url.hostname or "")
    elif isinstance(config.extra_body, dict):
        extra = dict(config.extra_body)

    reasoning: dict[str, Any] = {}
    if config.reasoning_effort:
        reasoning["reasoning_effort"] = config.reasoning_effort

    return ChatOpenAI(
        **reasoning,
        model=model,
        api_key=key,
        base_url=base_url,
        timeout=timeout,
        max_retries=0,
        max_tokens=max_tokens,
        extra_body=extra,
    )
def create_cascading_clients(*, timeout: int | float = DEFAULT_TIMEOUT) -> list[tuple[str, ChatOpenAI]]:
    """Return configured clients in priority order: google_studio -> openrouter -> a2agent."""
    cascade_order = ("google_studio", "openrouter", "a2agent")
    available: list[tuple[str, ChatOpenAI]] = []
    for prov_name in cascade_order:
        try:
            client = create_model_client(provider_name=prov_name, timeout=timeout)
            available.append((prov_name, client))
        except ExtractionError:
            continue
    return available
