"""Ollama adapter — local inference over the Ollama HTTP API.

Ollama runs the language model on the machine that hosts the application, so
document content never leaves the deployment. Two endpoints are used:

- `POST /api/chat`         — chat completion, used for answering, research
                              reports, extraction and structured analysis.
- `POST /api/embed`        — embeddings (optional; Sentence Transformers is
                              the default embedder).

The adapter speaks the JSON contract documented by Ollama rather than pulling
in its Python client, which keeps the dependency surface small and the
timeout/streaming behaviour explicit.
"""

import json
from typing import AsyncIterator, Dict, List, Optional

from app.core.http import httpx
from app.ports.llm import DEFAULT_SUMMARISE_INSTRUCTION, NO_ANSWER, LlmPort, LlmResponse
from app.shared.citations import extract_inline_citations


class OllamaUnavailableError(RuntimeError):
    """Raised when the Ollama server cannot be reached or the model is absent."""


class OllamaLlmAdapter(LlmPort):
    """Chat-based LLM backed by a locally hosted Ollama model."""

    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        timeout_sec: int = 300,
        num_ctx: int = 16384,
        keep_alive: str = "5m",
        temperature: float = 0.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout_sec = timeout_sec
        self.num_ctx = num_ctx
        self.keep_alive = keep_alive
        self.temperature = temperature

    # ── transport ─────────────────────────────────────────────────────────

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    async def _post(self, path: str, payload: dict, *, stream: bool = False):
        timeout = httpx.Timeout(self.timeout_sec, read=self.timeout_sec)
        async with httpx.AsyncClient(timeout=timeout) as client:
            request = client.post(
                self._url(path), json=payload, timeout=timeout
            )
            if stream:
                return await request.aread(), request
            response = await request
            if response.status_code >= 400:
                raise OllamaUnavailableError(
                    f"Ollama {path} failed with {response.status_code}: {response.text[:400]}"
                )
            return response

    async def health(self) -> dict:
        """Report whether the server is reachable and which models are pulled."""
        timeout = httpx.Timeout(5.0)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(self._url("/api/tags"), timeout=timeout)
                response.raise_for_status()
                data = response.json()
        except Exception as exc:  # noqa: BLE001 - health must never raise
            return {"available": False, "error": str(exc)[:200], "models": []}

        models = [m.get("name", "") for m in data.get("models", [])]
        return {
            "available": True,
            "models": models,
            "model_present": any(
                m == self.model or m.split(":")[0] == self.model.split(":")[0]
                for m in models
            ),
            "configured_model": self.model,
        }

    # ── LlmPort ───────────────────────────────────────────────────────────

    def _messages(
        self,
        system_prompt: str,
        context: str,
        question: str,
        history: Optional[List[Dict]] = None,
    ) -> List[Dict]:
        messages: List[Dict] = [{"role": "system", "content": system_prompt}]
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

    async def generate(
        self,
        system_prompt: str,
        context: str,
        question: str,
        history: Optional[List[Dict]] = None,
    ) -> LlmResponse:
        payload = {
            "model": self.model,
            "messages": self._messages(system_prompt, context, question, history),
            "stream": False,
            "keep_alive": self.keep_alive,
            "options": {
                "temperature": self.temperature,
                "num_ctx": self.num_ctx,
            },
        }
        try:
            response = await self._post("/api/chat", payload)
            data = response.json()
        except Exception as exc:  # noqa: BLE001
            raise OllamaUnavailableError(str(exc)) from exc

        text = (data.get("message") or {}).get("content", "") or ""
        text = text.strip()

        if not text:
            return LlmResponse(text="", citations=[], found=False, model=self.model)

        citations = _extract_citations(text)
        return LlmResponse(
            text=text,
            citations=citations,
            found=bool(citations) or NO_ANSWER not in text,
            model=self.model,
            usage={
                "prompt_tokens": data.get("prompt_eval_count"),
                "completion_tokens": data.get("eval_count"),
            },
        )

    async def generate_stream(
        self,
        system_prompt: str,
        context: str,
        question: str,
        history: Optional[List[Dict]] = None,
    ) -> AsyncIterator[str]:
        payload = {
            "model": self.model,
            "messages": self._messages(system_prompt, context, question, history),
            "stream": True,
            "keep_alive": self.keep_alive,
            "options": {"temperature": self.temperature, "num_ctx": self.num_ctx},
        }

        timeout = httpx.Timeout(self.timeout_sec, read=self.timeout_sec)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(
                    "POST", self._url("/api/chat"), json=payload, timeout=timeout
                ) as response:
                    if response.status_code >= 400:
                        body = await response.aread()
                        raise OllamaUnavailableError(
                            f"Ollama stream failed with {response.status_code}: "
                            f"{body.decode('utf-8', 'replace')[:400]}"
                        )
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            chunk = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        piece = (chunk.get("message") or {}).get("content", "")
                        if piece:
                            yield piece
                        if chunk.get("done"):
                            break
        except OllamaUnavailableError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise OllamaUnavailableError(str(exc)) from exc

    async def summarise(
        self,
        system_prompt: str,
        context: str,
        instruction: str = DEFAULT_SUMMARISE_INSTRUCTION,
    ) -> LlmResponse:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"{context}\n\n---\n\n{instruction}"},
            ],
            "stream": False,
            "keep_alive": self.keep_alive,
            "options": {"temperature": self.temperature, "num_ctx": self.num_ctx},
        }
        try:
            response = await self._post("/api/chat", payload)
            data = response.json()
        except Exception as exc:  # noqa: BLE001
            raise OllamaUnavailableError(str(exc)) from exc

        text = ((data.get("message") or {}).get("content", "") or "").strip()
        return LlmResponse(text=text, citations=[], found=bool(text), model=self.model)


class OllamaEmbedderAdapter:
    """Embeddings from an Ollama embedding model (e.g. nomic-embed-text)."""

    def __init__(self, base_url: str, model: str, *, timeout_sec: int = 120):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout_sec = timeout_sec

    async def embed(self, texts: List[str]) -> List[List[float]]:
        timeout = httpx.Timeout(self.timeout_sec, read=self.timeout_sec)
        vectors: List[List[float]] = []
        async with httpx.AsyncClient(timeout=timeout) as client:
            for text in texts:
                response = await client.post(
                    f"{self.base_url}/api/embed",
                    json={"model": self.model, "input": text},
                    timeout=timeout,
                )
                if response.status_code >= 400:
                    raise RuntimeError(
                        f"Ollama embed failed with {response.status_code}: {response.text[:200]}"
                    )
                data = response.json()
                vector = data.get("embeddings") or []
                if not vector:
                    raise RuntimeError("Ollama embed returned no vector")
                vectors.append([float(x) for x in vector[0]])
        return vectors

    @property
    def model_id(self) -> str:
        return f"ollama:{self.model}"


def _extract_citations(text: str) -> List[int]:
    """Collect the passage indices the model cited, in ascending order.

    The markers are validated by the caller against the passages that were
    actually supplied, so a marker can only point at a passage the model saw.
    """
    return extract_inline_citations(text)
