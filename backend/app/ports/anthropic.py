"""Anthropic adapter — Claude Sonnet 5.5 via the official Python SDK.

This is the optional hosted alternative to Ollama. Ollama remains the default
because the platform is designed to run entirely on its own infrastructure;
switching to Claude is a single environment variable (`LLM_IMPL=anthropic`).

Implementation notes:

- Model id is `claude-sonnet-5-5`, the current Sonnet generation.
- Thinking is adaptive: `thinking: {type: "adaptive"}`. The older
  `budget_tokens` form is rejected outright on this model.
- Server-side fallbacks are enabled by default so a safety refusal is
  re-routed to a fallback model instead of surfacing as an empty answer.
- Long generations use the streaming API, which avoids request timeouts on
  large contexts.
"""

import json
import re
from typing import Any, AsyncIterator, Dict, List, Optional

from app.ports.llm import (
    DEFAULT_SUMMARISE_INSTRUCTION,
    NO_ANSWER,
    LlmPort,
    LlmResponse,
)
from app.shared.citations import extract_inline_citations

# The beta that enables the server-side fallback router on the Claude API.
_FALLBACK_BETA = "server-side-fallback-2026-07-01"


class AnthropicUnavailableError(RuntimeError):
    """Raised when the Anthropic API cannot be reached or rejects the request."""


class AnthropicLlmAdapter(LlmPort):
    """Claude-backed LLM used for answering, research and extraction."""

    def __init__(
        self,
        model: str = "claude-sonnet-5-5",
        *,
        api_key: str = "",
        max_tokens: int = 8192,
        effort: str = "high",
        timeout_sec: int = 300,
    ):
        self.model = model
        self.api_key = api_key
        self.max_tokens = max_tokens
        self.effort = effort
        self.timeout_sec = timeout_sec
        self._client = None

    # ── client ────────────────────────────────────────────────────────────

    def _get_client(self):
        if self._client is None:
            try:
                from anthropic import AsyncAnthropic
            except ImportError as exc:  # pragma: no cover - optional dependency
                raise AnthropicUnavailableError(
                    "The 'anthropic' package is not installed. "
                    "Install it or use LLM_IMPL=ollama."
                ) from exc

            kwargs: Dict[str, Any] = {"timeout": self.timeout_sec, "max_retries": 2}
            if self.api_key:
                kwargs["api_key"] = self.api_key
            self._client = AsyncAnthropic(**kwargs)
        return self._client

    def _request_kwargs(self) -> Dict[str, Any]:
        """Common request options.

        `fallbacks` is included by default on this model family: when a
        request is declined by a safety classifier the platform transparently
        retries it against a fallback model rather than returning nothing.
        """
        return {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "betas": [_FALLBACK_BETA],
            "fallbacks": "default",
            "output_config": {"effort": self.effort},
        }

    async def health(self) -> dict:
        """Report whether the API is reachable with the configured credentials."""
        try:
            client = self._get_client()
            await client.models.retrieve(self.model)
        except Exception as exc:  # noqa: BLE001 - health must never raise
            return {"available": False, "error": str(exc)[:200], "model": self.model}
        return {"available": True, "model": self.model}

    # ── LlmPort ───────────────────────────────────────────────────────────

    def _messages(
        self,
        system_prompt: str,
        context: str,
        question: str,
        history: Optional[List[Dict]] = None,
    ) -> List[Dict]:
        messages: List[Dict] = []
        for turn in history or []:
            role = turn.get("role")
            content = turn.get("content")
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})
        messages.append(
            {
                "role": "user",
                "content": f"{context}\n\n---\n\nQuestion: {question}".strip(),
            }
        )
        return messages

    @staticmethod
    def _text_of(message) -> str:
        parts = []
        for block in getattr(message, "content", []) or []:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                parts.append(getattr(block, "text", "") or "")
        return "".join(parts).strip()

    async def generate(
        self,
        system_prompt: str,
        context: str,
        question: str,
        history: Optional[List[Dict]] = None,
    ) -> LlmResponse:
        client = self._get_client()
        kwargs = self._request_kwargs()
        try:
            response = await client.messages.create(
                system=system_prompt,
                messages=self._messages(system_prompt, context, question, history),
                **kwargs,
            )
        except Exception as exc:  # noqa: BLE001
            raise AnthropicUnavailableError(str(exc)) from exc

        text = self._text_of(response)
        citations = _extract_citations(text)
        return LlmResponse(
            text=text,
            citations=citations,
            found=bool(citations) or NO_ANSWER not in text,
            model=self.model,
            usage={
                "input_tokens": getattr(getattr(response, "usage", None), "input_tokens", None),
                "output_tokens": getattr(getattr(response, "usage", None), "output_tokens", None),
            },
        )

    async def generate_stream(
        self,
        system_prompt: str,
        context: str,
        question: str,
        history: Optional[List[Dict]] = None,
    ) -> AsyncIterator[str]:
        client = self._get_client()
        kwargs = self._request_kwargs()
        try:
            async with client.messages.stream(
                system=system_prompt,
                messages=self._messages(system_prompt, context, question, history),
                **kwargs,
            ) as stream:
                async for text in stream.text_stream:
                    if text:
                        yield text
        except Exception as exc:  # noqa: BLE001
            raise AnthropicUnavailableError(str(exc)) from exc

    async def summarise(
        self,
        system_prompt: str,
        context: str,
        instruction: str = DEFAULT_SUMMARISE_INSTRUCTION,
    ) -> LlmResponse:
        client = self._get_client()
        kwargs = self._request_kwargs()
        try:
            response = await client.messages.create(
                system=system_prompt,
                messages=[{"role": "user", "content": f"{context}\n\n---\n\n{instruction}"}],
                **kwargs,
            )
        except Exception as exc:  # noqa: BLE001
            raise AnthropicUnavailableError(str(exc)) from exc

        text = self._text_of(response)
        return LlmResponse(text=text, citations=[], found=bool(text), model=self.model)


def _extract_citations(text: str) -> List[int]:
    """Collect the passage indices the model cited, in ascending order."""
    return extract_inline_citations(text)
