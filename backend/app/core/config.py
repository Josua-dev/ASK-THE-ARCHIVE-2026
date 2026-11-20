"""Application configuration — read from environment, nothing hardcoded.

Every provider is local-first. The stack ships with no cloud dependencies:
PostgreSQL + pgvector for storage, Ollama for inference, Sentence Transformers
for embeddings, Tesseract for OCR, and the local filesystem for document
blobs. A hosted Claude endpoint is supported as an optional alternative to
Ollama, selected with a single environment variable.
"""

from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ── Database ──────────────────────────────────────────────────────────
    database_url: str
    database_url_pooled: str | None = None

    # ── Auth ──────────────────────────────────────────────────────────────
    jwt_secret: str
    jwt_access_ttl_min: int = 30
    jwt_refresh_ttl_days: int = 7
    # Signed, single-purpose token that authorises a document download or a
    # page preview without exposing the session token in a URL.
    signed_link_ttl_sec: int = 120

    # ── Storage (local filesystem) ─────────────────────────────────────────
    storage_impl: str = "local"
    storage_root: str = "uploads"
    # Public base path the browser uses to fetch a stored object.
    storage_public_base: str = "/api/v1/documents/raw"

    # ── Document extraction ───────────────────────────────────────────────
    # "pymupdf" (default) — PyMuPDF text layer + page rasterisation.
    # "pdfplumber" — legacy fallback.
    extractor_impl: str = "pymupdf"
    # "tesseract" — OCR scanned pages and images.
    # "none" — skip OCR entirely.
    ocr_impl: str = "tesseract"
    # Explicit path to the tesseract binary, e.g. "C:/Program Files/Tesseract-OCR/tesseract.exe".
    # Leave empty to rely on PATH.
    tesseract_cmd: str = ""
    # Minimum characters on a page before OCR is considered necessary.
    ocr_min_chars_per_page: int = 32
    # Resolution used when rasterising a page for OCR or preview.
    render_dpi: int = 144
    # Longest edge, in pixels, of a rendered preview page.
    preview_max_px: int = 1600

    # ── Embeddings (Sentence Transformers) ────────────────────────────────
    # "sentence-transformers" (default) — local ONNX/PyTorch model.
    # "hash" — deterministic offline fallback, no model download.
    # "ollama" — Ollama's embedding models.
    embedder_impl: str = "sentence-transformers"
    embedding_model_name: str = "BAAI/bge-m3"
    # Must match the vector width of the document_chunks.embedding column.
    embedding_dimensions: int = 1024
    embedding_device: str = "cpu"
    embedding_batch_size: int = 16
    # Set to 1 to forbid the model download and use the local cache only.
    embedding_offline: bool = False

    # ── LLM ───────────────────────────────────────────────────────────────
    # "ollama" (default) — local inference, nothing leaves the machine.
    # "anthropic" — Claude Sonnet 5.5 via the Anthropic API.
    # "extractive" — deterministic, model-free answering.
    llm_impl: str = "ollama"

    # Ollama
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "qwen2.5:7b-instruct"
    ollama_embed_model: str = "nomic-embed-text"
    ollama_timeout_sec: int = 300
    ollama_num_ctx: int = 16384
    ollama_keep_alive: str = "5m"
    # Seconds to wait for the model to become ready before giving up.
    ollama_probe_timeout_sec: int = 5

    # Anthropic (Claude) — optional hosted alternative to Ollama.
    # Not used unless LLM_IMPL=anthropic; the key is read from the
    # environment (ANTHROPIC_API_KEY) and never logged.
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5-5"
    anthropic_max_tokens: int = 8192
    anthropic_effort: str = "high"
    anthropic_timeout_sec: int = 300

    # ── RAG / retrieval tuning ────────────────────────────────────────────
    min_score: float = 0.30
    top_k: int = 6
    max_upload_mb: int = 50
    # Target size of an indexed chunk, in characters.
    chunk_target_chars: int = 1200
    chunk_overlap_chars: int = 160
    # Hard ceiling on the characters handed to the model for one question.
    max_context_chars: int = 24000

    allowed_mime_types: str = (
        "application/pdf,"
        "image/png,image/jpeg,image/tiff,image/bmp,"
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document,"
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,"
        "text/csv,text/comma-separated-values,"
        "text/plain,text/markdown,"
        "application/rtf,"
        "text/html"
    )

    # ── CORS ──────────────────────────────────────────────────────────────
    cors_origins: str = "http://localhost:3000"

    # ── Seed data ─────────────────────────────────────────────────────────
    seed_admin_email: str = "admin@askthearchive.local"
    seed_admin_password: str = "ArchiveAdmin!2026"
    seed_demo_password: str = "ArchiveDemo!2026"

    @property
    def async_database_url(self) -> str:
        """asyncpg-compatible URL derived from the libpq-style DATABASE_URL.

        Managed Postgres hands out `postgresql://…?sslmode=require`. asyncpg
        needs the `+asyncpg` driver and rejects those query args, so the
        scheme is swapped and TLS is expressed as `ssl=require`.
        """
        from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

        parts = urlsplit(self.database_url)
        scheme = "postgresql+asyncpg"
        query = dict(parse_qsl(parts.query))
        wants_tls = query.pop("sslmode", None) in {"require", "verify-ca", "verify-full"}
        query.pop("channel_binding", None)
        if wants_tls or "ssl" in query:
            query["ssl"] = query.get("ssl", "require")
        return urlunsplit((scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))

    @property
    def cors_origins_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def allowed_mime_types_list(self) -> List[str]:
        return [m.strip() for m in self.allowed_mime_types.split(",") if m.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
