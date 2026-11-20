"""HTTP client import shim.

The project supports both the `httpx` distribution and its 2.x `httpx2`
rename without every call site caring which one is installed. The two expose
the same `AsyncClient` surface used here.
"""

try:  # pragma: no cover - depends on the installed distribution
    import httpx
except ModuleNotFoundError:  # pragma: no cover
    import httpx2 as httpx  # type: ignore[no-redef]

__all__ = ["httpx"]
