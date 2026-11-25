"""Configurable Model Providers interface for menu extraction.

Provides an extensible registry supporting:
- google_studio / gemini (Google AI Studio)
- openrouter, qwen, glm, deepseek (OpenRouter unified gateway)
- nara (Nara Router)
- openai (Direct OpenAI API)

Supports explicit selection via --provider or MENU_AI_PROVIDER env var,
otherwise Nara Router or generic MENU_AI_* settings.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, ClassVar, Literal
from urllib.parse import urlsplit

import httpx
from langchain_openai import ChatOpenAI
from peekaplate_processing.errors import ExtractionError

DEFAULT_TIMEOUT = 120
DEFAULT_MAX_TOKENS = 16384
# Verified working models tested on physical menu imagery
WorkingModel = Literal[
    "models/gemini-3-flash-preview",
    "qwen/qwen3.8-flash",
    "z-ai/glm-5.3-flash",
    "deepseek/deepseek-v4.1-flash",
]
VERIFIED_WORKING_MODELS: tuple[WorkingModel, ...] = (
    "models/gemini-3-flash-preview",
    "qwen/qwen3.8-flash",
    "z-ai/glm-5.3-flash",
    "deepseek/deepseek-v4.1-flash",
)


@dataclass(frozen=True)
class ModelProviderConfig:
    name: str
    key_vars: tuple[str, ...]
    url_var: str | None
    model_var: str | None
    default_url: str | None
    default_model: str | None
    extra_body: dict[str, Any] | None = None
    reasoning_effort: str | None = None
    strict_vision_schema: ClassVar[bool] = False

    def request_options(self, model: str) -> dict[str, Any]:
        options: dict[str, Any] = {"extra_body": dict(self.extra_body or {})}
        if self.reasoning_effort:
            options["reasoning_effort"] = self.reasoning_effort
        return options


class GoogleAIStudioProvider(ModelProviderConfig):
    strict_vision_schema = True


class OpenRouterProvider(ModelProviderConfig):
    strict_vision_schema = True

    def request_options(self, model: str) -> dict[str, Any]:
        extra = {"provider": {"require_parameters": True}, **(self.extra_body or {})}
        if model in {"google/gemini-3-flash-preview", "google/gemini-3-flash-preview:free"}:
            extra["reasoning"] = {"effort": "low"}
        return {"extra_body": extra}


def supports_strict_vision_schema(base_url: str | None) -> bool:
    if not base_url:
        return False
    try:
        host = urlsplit(base_url).hostname
    except ValueError:
        return False
    return _VISION_PROVIDERS.get(host, ModelProviderConfig).strict_vision_schema


GOOGLE_AI_STUDIO_HOST = "generativelanguage.googleapis.com"
_VISION_PROVIDERS = {
    GOOGLE_AI_STUDIO_HOST: GoogleAIStudioProvider,
    "openrouter.ai": OpenRouterProvider,
}


# Registry of known supported providers
PROVIDER_REGISTRY: dict[str, ModelProviderConfig] = {
    "google_studio": GoogleAIStudioProvider(
        name="google_studio",
        key_vars=("GEMINI_API_KEY", "GOOGLE_AI_API_KEY", "GOOGLE_API_KEY"),
        url_var="GEMINI_API_URL",
        model_var="GEMINI_MODEL",
        default_url="https://generativelanguage.googleapis.com/v1beta/openai",
        default_model="models/gemini-3-flash-preview",
        extra_body=None,
        # Gemini 3 thinking tokens count against max_tokens; dense menus were truncated at default effort.
        reasoning_effort="low",
    ),
    "gemini": GoogleAIStudioProvider(
        name="gemini",
        key_vars=("GEMINI_API_KEY", "GOOGLE_AI_API_KEY", "GOOGLE_API_KEY"),
        url_var="GEMINI_API_URL",
        model_var="GEMINI_MODEL",
        default_url="https://generativelanguage.googleapis.com/v1beta/openai",
        default_model="models/gemini-3-flash-preview",
        extra_body=None,
        reasoning_effort="low",
    ),
    "openrouter": OpenRouterProvider(
        name="openrouter",
        key_vars=("OPENROUTER_API_KEY",),
        url_var="OPENROUTER_API_URL",
        model_var="OPENROUTER_MODEL",
        default_url="https://openrouter.ai/api/v1",
        default_model="google/gemini-3-flash-preview",
        extra_body={"reasoning": {"enabled": False}},
    ),
    "qwen": OpenRouterProvider(
        name="qwen",
        key_vars=("OPENROUTER_API_KEY",),
        url_var="MENU_AI_API_URL",
        model_var="MENU_AI_MODEL",
        default_url="https://openrouter.ai/api/v1",
        default_model="qwen/qwen3.8-flash",
        extra_body={"reasoning": {"enabled": False}},
    ),
    "glm": OpenRouterProvider(
        name="glm",
        key_vars=("OPENROUTER_API_KEY",),
        url_var="MENU_AI_API_URL",
        model_var="MENU_AI_MODEL",
        default_url="https://openrouter.ai/api/v1",
        default_model="z-ai/glm-5.3-flash",
    ),
    "deepseek": OpenRouterProvider(
        name="deepseek",
        key_vars=("OPENROUTER_API_KEY",),
        url_var="MENU_AI_API_URL",
        model_var="MENU_AI_MODEL",
        default_url="https://openrouter.ai/api/v1",
        default_model="deepseek/deepseek-v4.1-flash",
    ),
    "nara": ModelProviderConfig(
        name="nara",
        key_vars=("NARA_ROUTER_KEY",),
        url_var="NARA_ROUTER_URL",
        model_var="NARA_ROUTER_MODEL",
        default_url="https://router.bynara.id/v1",
        default_model=None,
        reasoning_effort="none",
    ),
    "openai": ModelProviderConfig(
        name="openai",
        key_vars=("OPENAI_API_KEY",),
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
    env_max = environ.get("MENU_AI_MAX_TOKENS", "").strip()
    if env_max and env_max.isdigit():
        max_tokens = int(env_max)
    if provider_name is None:
        provider_name = environ.get("MENU_AI_PROVIDER", "").strip().lower() or None

    if provider_name:
        canon_name = provider_name.lower().replace("-", "_")
        if canon_name not in PROVIDER_REGISTRY:
            known = ", ".join(sorted(PROVIDER_REGISTRY.keys()))
            raise ExtractionError(f"Unknown model provider '{provider_name}'. Supported: {known}")
        config = PROVIDER_REGISTRY[canon_name]
        return _build_client_from_config(config, timeout=timeout, max_tokens=max_tokens, environ=environ)

    # 2. Backward-compatible auto-detection order: Nara Router -> Generic MENU_AI_*
    nara_names = ("NARA_ROUTER_KEY", "NARA_ROUTER_URL", "NARA_ROUTER_MODEL")

    if any(environ.get(n) for n in nara_names):
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

    if url.hostname == "openrouter.ai":
        options = PROVIDER_REGISTRY["openrouter"].request_options(model)
    elif url.hostname == "router.bynara.id":
        options = PROVIDER_REGISTRY["nara"].request_options(model)
    else:
        options = {"extra_body": {}}

    return ChatOpenAI(
        **options,
        model=model,
        api_key=key,
        base_url=base_url,
        timeout=timeout,
        max_retries=0,
        max_tokens=max_tokens,
        http_async_client=httpx.AsyncClient(timeout=timeout),
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
    if config.name == "openrouter":
        url_val = url_val or environ.get("MENU_AI_API_URL", "").strip()
    endpoint = url_val or config.default_url
    if not endpoint:
        raise ExtractionError(f"Provider '{config.name}' missing URL configuration.")

    model_val = (environ.get(config.model_var, "") if config.model_var else "").strip()
    if config.name == "openrouter":
        model_val = model_val or environ.get("MENU_AI_MODEL", "").strip()
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

    return ChatOpenAI(
        **config.request_options(model),
        model=model,
        api_key=key,
        base_url=base_url,
        timeout=timeout,
        max_retries=0,
        max_tokens=max_tokens,
        http_async_client=httpx.AsyncClient(timeout=timeout),
    )
def create_cascading_clients(*, timeout: int | float = DEFAULT_TIMEOUT) -> list[tuple[str, ChatOpenAI]]:
    """Return configured clients in priority order: google_studio -> qwen -> glm -> openrouter.

    A provider whose model and endpoint repeat an earlier entry is skipped, so one model is never retried twice.
    """
    cascade_order = ("google_studio", "qwen", "glm", "openrouter")
    available: list[tuple[str, ChatOpenAI]] = []
    seen: set[tuple[str, str]] = set()
    # MENU_AI_* belongs to the generic client. In the automatic cascade, pairing
    # its endpoint with OPENROUTER_API_KEY could send that key to another provider,
    # and its model override would collapse the distinct OpenRouter candidates.
    cascade_env = dict(os.environ)
    cascade_env.pop("MENU_AI_API_URL", None)
    cascade_env.pop("MENU_AI_MODEL", None)
    cascade_env.pop("OPENROUTER_API_URL", None)
    cascade_env.pop("OPENROUTER_MODEL", None)
    for prov_name in cascade_order:
        try:
            client = create_model_client(provider_name=prov_name, timeout=timeout, env=cascade_env)
        except ExtractionError:
            continue
        identity = (str(client.openai_api_base), client.model_name)
        if identity not in seen:
            seen.add(identity)
            available.append((prov_name, client))
    return available
