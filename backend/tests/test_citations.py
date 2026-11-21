"""Citation markers, and the instruction the summariser is given.

Two regressions are pinned here. Both were found by running the real model
against the real archive, not by reading the code:

- Told to "reference supporting passages inline with [n] markers", a 7B
  instruct model writes "[n1]". A parser that accepts only "[1]" throws that
  citation away, so a correct answer arrives with no sources and the service
  reports "not found". The parser has to accept the forms a model actually
  produces.
- The fallback wrapper forwarded a missing summarise instruction as the
  literal string "None", so the model was asked to summarise
  "...\\n\\n---\\n\\nNone" and replied with a bare "-".

Neither of these can be caught by a mock, because the drift is in what the
model writes. These tests pin the parsing and the forwarding, which is where
the correction belongs.
"""

import asyncio

from app.modules.chat.service import _extract_citation_indices
from app.ports.fallback import FallbackLlmAdapter
from app.ports.llm import DEFAULT_SUMMARISE_INSTRUCTION, LlmPort, LlmResponse
from app.shared.citations import extract_inline_citations


class TestInlineCitationParsing:
    def test_canonical_marker(self):
        assert extract_inline_citations("The value is 250,000 over three years [1].") == [1]

    def test_model_writes_n_prefixed_marker(self):
        """The drift that broke the live demo: "[n1]", not "[1]"."""
        assert extract_inline_citations(
            "The value is 250,000 over three years [n1]."
        ) == [1]

    def test_n_prefix_is_case_insensitive_and_may_be_spaced(self):
        assert extract_inline_citations("a [N 2] b [n3] c") == [2, 3]

    def test_several_passages_in_one_bracket(self):
        assert extract_inline_citations("x [1,2] y [3]") == [1, 2, 3]

    def test_no_markers(self):
        assert extract_inline_citations("The archive does not contain this.") == []

    def test_non_citation_brackets_are_ignored(self):
        assert extract_inline_citations("see [note 1] and [Appendix]") == []

    def test_indices_are_unique_and_ascending(self):
        assert extract_inline_citations("[3] then [1] then [3] then [2]") == [1, 2, 3]

    def test_empty_text(self):
        assert extract_inline_citations("") == []

    def test_chat_service_uses_the_shared_parser(self):
        assert _extract_citation_indices("value [n1]") == [1]


class _RecordingLlm(LlmPort):
    """A primary that records the instruction it was handed."""

    def __init__(self):
        self.instructions: list[str] = []

    async def generate(self, system_prompt, context, question, history=None):
        return LlmResponse(text="", citations=[], found=False, model="stub")

    async def summarise(
        self, system_prompt, context, instruction=DEFAULT_SUMMARISE_INSTRUCTION
    ):
        self.instructions.append(instruction)
        return LlmResponse(text="ok", citations=[], found=True, model="stub")


class TestFallbackSummariseInstruction:
    def test_omitted_instruction_is_not_forwarded_as_none(self):
        primary = _RecordingLlm()
        fallback = FallbackLlmAdapter(primary, primary)

        asyncio.run(fallback.summarise("system", "context"))

        assert primary.instructions == [DEFAULT_SUMMARISE_INSTRUCTION]
        assert "None" not in primary.instructions[0]

    def test_explicit_instruction_is_forwarded_unchanged(self):
        primary = _RecordingLlm()
        fallback = FallbackLlmAdapter(primary, primary)

        asyncio.run(fallback.summarise("system", "context", "List the obligations."))

        assert primary.instructions == ["List the obligations."]

    def test_fallback_engine_also_receives_a_real_instruction(self):
        class _FailingPrimary(_RecordingLlm):
            async def summarise(self, system_prompt, context, instruction=None):
                raise RuntimeError("provider down")

        class _RecordingFallback(_RecordingLlm):
            pass

        primary = _FailingPrimary()
        secondary = _RecordingFallback()
        fallback = FallbackLlmAdapter(primary, secondary)

        asyncio.run(fallback.summarise("system", "context"))

        assert secondary.instructions == [DEFAULT_SUMMARISE_INSTRUCTION]
