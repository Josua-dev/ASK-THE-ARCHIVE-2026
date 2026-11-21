"""Resilient LLM: try the primary provider, degrade to the extractive adapter.

The fallback is never silent — `LlmResponse.model` records which engine
answered, and the UI shows it, so a degraded answer is not passed off as a
model answer.

Any transport or provider error degrades to the extractive engine. A failure
to reach the model is an infrastructure problem, not a semantic one, so the
right response is to answer from the retrieved evidence rather than to return
nothing.
"""

import logging

from app.ports.llm import DEFAULT_SUMMARISE_INSTRUCTION, LlmPort, LlmResponse

log = logging.getLogger(__name__)


class FallbackLlmAdapter(LlmPort):
    """Runs `primary` and falls back to `fallback` when the primary fails."""

    def __init__(self, primary: LlmPort, fallback: LlmPort):
        self.primary = primary
        self.fallback = fallback

    async def generate(self, system_prompt, context, question, history=None) -> LlmResponse:
        try:
            return await self.primary.generate(system_prompt, context, question, history)
        except Exception as exc:  # noqa: BLE001 - any provider failure degrades
            log.warning(
                "LLM provider %s unavailable (%s) — falling back to extractive answer",
                type(self.primary).__name__,
                str(exc)[:200],
            )
        resp = await self.fallback.generate(system_prompt, context, question, history)
        resp.model = "extractive-fallback"
        return resp

    async def generate_stream(self, system_prompt, context, question, history=None):
        try:
            async for token in self.primary.generate_stream(
                system_prompt, context, question, history
            ):
                yield token
            return
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "LLM provider %s unavailable mid-stream (%s) — falling back",
                type(self.primary).__name__,
                str(exc)[:200],
            )
        resp = await self.fallback.generate(system_prompt, context, question, history)
        resp.model = "extractive-fallback"
        yield resp.text

    async def summarise(self, system_prompt, context, instruction=None) -> LlmResponse:
        # The instruction must survive the hop through this wrapper. Forwarding
        # `None` would put the literal string "None" at the end of the prompt
        # — the model reads that as a malformed request and replies with a
        # bare "-" rather than a summary.
        resolved = (
            instruction if instruction is not None else DEFAULT_SUMMARISE_INSTRUCTION
        )
        try:
            return await self.primary.summarise(system_prompt, context, resolved)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "LLM provider %s unavailable (%s) — falling back to extractive summary",
                type(self.primary).__name__,
                str(exc)[:200],
            )
        resp = await self.fallback.summarise(system_prompt, context, resolved)
        resp.model = "extractive-fallback"
        return resp
