"""Helpers for consuming structured output from a language model.

Model output is untrusted input. It may be wrapped in a fenced code block,
surrounded by prose, truncated mid-object, or contain fields of the wrong
type. Everything in this module exists so the intelligence modules can parse
that output defensively and never persist an invented value.

The rule the whole platform depends on: when the model cannot be parsed, the
feature degrades to an honest empty result. It never falls back to a
hardcoded example.
"""

import json
import re
from typing import Any, Iterable, Optional

# A fenced code block, with or without a language tag.
_FENCE = re.compile(r"```[a-zA-Z0-9_+-]*\s*(.*?)```", re.DOTALL)


def strip_fences(text: str) -> str:
    """Remove the first fenced code block wrapper, if present."""
    if not text:
        return ""
    match = _FENCE.search(text)
    if match:
        return match.group(1).strip()
    return text.strip()


def parse_json_object(text: str) -> Optional[dict]:
    """Parse a JSON object out of model output.

    Handles the three shapes that occur in practice: a bare object, an object
    inside a fenced code block, and an object surrounded by prose. Returns
    ``None`` when nothing parseable is found — callers treat that as "the
    model produced nothing usable" and produce an empty result.
    """
    if not text:
        return None

    for candidate in (text.strip(), strip_fences(text)):
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            parsed = None
        if isinstance(parsed, dict):
            return parsed

        # Fall back to the outermost brace pair in the raw text.
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start != -1 and end > start:
            try:
                parsed = json.loads(candidate[start : end + 1])
            except (json.JSONDecodeError, ValueError):
                continue
            if isinstance(parsed, dict):
                return parsed
    return None


def normalise_whitespace(text: str) -> str:
    """Collapse runs of whitespace so two renderings of a line compare equal."""
    return " ".join((text or "").split())


def contains_text(haystack: str, needle: str) -> bool:
    """Case-insensitive, whitespace-insensitive containment test.

    This is the check that stops a citation from pointing at a passage that
    does not contain the quoted text.
    """
    hay = normalise_whitespace(haystack).casefold()
    pin = normalise_whitespace(needle).casefold()
    if not pin:
        return False
    return pin in hay


def as_str(value: Any) -> Optional[str]:
    """Coerce a model value to a non-empty string, or ``None``."""
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    if isinstance(value, (int, float, bool)):
        return str(value)
    return None


def as_int(value: Any) -> Optional[int]:
    """Coerce a model value to an int, or ``None`` when it is not numeric."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        match = re.search(r"-?\d+", value)
        if match:
            return int(match.group(0))
    return None


def as_float(value: Any) -> Optional[float]:
    """Coerce a model value to a float, or ``None`` when it is not numeric."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace(",", "")
        match = re.search(r"-?\d+(?:\.\d+)?", cleaned)
        if match:
            try:
                return float(match.group(0))
            except ValueError:
                return None
    return None


def as_dict_list(value: Any) -> list[dict]:
    """Coerce a model value into a list of dictionaries.

    Entries that are not dictionaries are dropped rather than coerced, because
    a string in a list of facts is not a fact.
    """
    if not isinstance(value, list):
        return []
    return [entry for entry in value if isinstance(entry, dict)]


def as_str_list(value: Any) -> list[str]:
    """Coerce a model value into a list of non-empty strings."""
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for entry in value:
        text = as_str(entry)
        if text:
            out.append(text)
    return out


def as_int_list(value: Any, *, low: int = 1, high: Optional[int] = None) -> list[int]:
    """Coerce a model value into a list of in-range integers.

    Used for citation indices: an index outside the supplied passage range is
    a hallucination and is dropped.
    """
    if not isinstance(value, list):
        return []
    out: list[int] = []
    for entry in value:
        number = as_int(entry)
        if number is None or number < low:
            continue
        if high is not None and number > high:
            continue
        if number not in out:
            out.append(number)
    return sorted(out)


def clamp(value: Optional[float], low: float = 0.0, high: float = 1.0) -> Optional[float]:
    """Clamp a confidence value into range, preserving ``None``."""
    if value is None:
        return None
    return max(low, min(high, float(value)))


def first_sentence_containing(text: str, needle: str, *, limit: int = 400) -> str:
    """Return the sentence of ``text`` that contains ``needle``.

    Falls back to the normalised whole text when no sentence boundary is
    found. Used to build a mention excerpt from the source passage.
    """
    normalised = normalise_whitespace(text)
    if not normalised:
        return ""
    if not normalise_whitespace(needle):
        return normalised[:limit]

    lower_text = normalised.casefold()
    lower_needle = normalise_whitespace(needle).casefold()
    position = lower_text.find(lower_needle)
    if position == -1:
        return normalised[:limit]

    start = max(normalised.rfind(". ", 0, position), normalised.rfind("\n", 0, position))
    start = 0 if start == -1 else start + 1
    end = normalised.find(". ", position)
    if end == -1:
        end = min(len(normalised), position + limit)
    else:
        end += 1
    return normalised[start:end].strip()[:limit]


def dedupe_preserving_order(items: Iterable[Any]) -> list[Any]:
    """Remove duplicates while keeping first-seen order."""
    seen: set[Any] = set()
    out: list[Any] = []
    for item in items:
        key = item if isinstance(item, (str, int, float, bool, tuple)) else repr(item)
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out
