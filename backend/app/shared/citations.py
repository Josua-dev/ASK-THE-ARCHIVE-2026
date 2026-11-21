"""Inline passage-citation markers in model output.

A model cites the passage it used by writing that passage's number in square
brackets. The canonical form is ``[1]``, but a model drifts from it in
predictable ways: told to "use [n] markers", a 7B instruct model writes
``[n1]``; told it may cite several passages, some write ``[1,2]``.

Every variant resolves to the same thing here — the index of a passage. What
this module deliberately does *not* do is decide whether a passage actually
supports a claim. The caller checks each index against the passages it
supplied, so a marker can only ever point at a passage the model was shown.
A citation cannot be invented here, because the index space is the caller's,
not the model's.

One parser for every call site. When the format drifts again, it drifts in
one place.
"""

import re
from typing import Optional

# [1] · [n1] · [N 1] · [1,2] · [1, 2]
#
# The optional "n" prefix is the observed drift: a model told to write "[n]"
# markers treats the "n" as part of the marker and writes "[n1]". A bracket
# that is not a citation marker — "[note 1]", "[see]" — does not match,
# because the content must be digits and nothing else.
_MARKER = re.compile(
    r"\[\s*(?:n\s*)?(\d{1,6}(?:\s*,\s*\d{1,6})*)\s*\]",
    re.IGNORECASE,
)

# The default ceiling on a passage index. A retrieval returns a handful of
# passages, so a three-digit "index" is a stray bracketed number rather than
# a citation. Callers that know how many passages they retrieved pass that
# count as `max_index`, which raises the ceiling when the archive is large
# enough to need it.
DEFAULT_MAX_INDEX = 99


def extract_inline_citations(
    text: str, *, max_index: Optional[int] = None
) -> list[int]:
    """Return the passage indices cited inline in `text`.

    Ascending and de-duplicated. An empty list means the model cited nothing,
    which the caller must treat as "no evidence" rather than "passage 1".

    `max_index` bounds the result to the passages the caller actually
    retrieved. It defaults to 99 so that a stray bracketed number is not
    mistaken for a citation; callers holding the retrieved set should pass
    its size.
    """
    if not text:
        return []
    limit = DEFAULT_MAX_INDEX if max_index is None else max_index
    found: set[int] = set()
    for match in _MARKER.finditer(text):
        for part in match.group(1).split(","):
            part = part.strip()
            if not part:
                continue
            index = int(part)
            if 1 <= index <= limit:
                found.add(index)
    return sorted(found)
