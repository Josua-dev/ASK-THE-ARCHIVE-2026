"""Provider factory — selects the local adapter for each capability.

Everything the platform needs runs on the machine that hosts it: PostgreSQL +
pgvector for storage, Ollama for inference, Sentence Transformers for
embeddings, PyMuPDF and Tesseract for document processing, and the local
filesystem for document blobs. A hosted Claude endpoint is available as an
alternative to Ollama through `LLM_IMPL=anthropic`.

Each accessor is cached so a model is loaded once per process rather than per
request.
"""

from functools import lru_cache

from app.core.config import settings
from app.ports.embedder import EmbedderPort
from app.ports.extractor import ExtractorPort
from app.ports.jobs import JobRunnerPort
from app.ports.llm import LlmPort
from app.ports.storage import StoragePort


@lru_cache
def get_storage() -> StoragePort:
    from app.ports.local import LocalStorageAdapter

    return LocalStorageAdapter(base_dir=settings.storage_root)


@lru_cache
def get_ocr_engine():
    from app.ports.pdf import OcrEngine

    if settings.ocr_impl != "tesseract":
        return None
    return OcrEngine(binary_path=settings.tesseract_cmd)


@lru_cache
def get_extractor() -> ExtractorPort:
    from app.ports.local import MultiFormatExtractorAdapter

    return MultiFormatExtractorAdapter(
        ocr=get_ocr_engine(),
        render_dpi=settings.render_dpi,
        ocr_min_chars_per_page=settings.ocr_min_chars_per_page,
        preview_max_px=settings.preview_max_px,
    )


@lru_cache
def get_embedder() -> EmbedderPort:
    if settings.embedder_impl == "ollama":
        from app.ports.local import OllamaEmbedderAdapter

        return OllamaEmbedderAdapter(
            base_url=settings.ollama_base_url,
            model=settings.ollama_embed_model,
            timeout_sec=settings.ollama_timeout_sec,
        )
    if settings.embedder_impl == "sentence-transformers":
        from app.ports.local import SentenceTransformerEmbedderAdapter

        return SentenceTransformerEmbedderAdapter(
            model_name=settings.embedding_model_name,
            dimensions=settings.embedding_dimensions,
            device=settings.embedding_device,
            batch_size=settings.embedding_batch_size,
            offline=settings.embedding_offline,
        )
    from app.ports.local import HashEmbedderAdapter

    return HashEmbedderAdapter(dimensions=settings.embedding_dimensions)


@lru_cache
def get_llm() -> LlmPort:
    """The configured LLM, wrapped so a provider outage degrades honestly.

    When the primary provider is unreachable the adapter falls back to the
    extractive engine rather than raising: the answer is then composed from
    sentences that genuinely occur in the retrieved passages, and the response
    records which engine produced it so the interface can say so.
    """
    from app.ports.local import ExtractiveLlmAdapter

    extractive = ExtractiveLlmAdapter()

    if settings.llm_impl == "anthropic":
        from app.ports.anthropic import AnthropicLlmAdapter
        from app.ports.fallback import FallbackLlmAdapter

        return FallbackLlmAdapter(
            AnthropicLlmAdapter(
                model=settings.anthropic_model,
                api_key=settings.anthropic_api_key,
                max_tokens=settings.anthropic_max_tokens,
                effort=settings.anthropic_effort,
                timeout_sec=settings.anthropic_timeout_sec,
            ),
            extractive,
        )

    if settings.llm_impl == "ollama":
        from app.ports.fallback import FallbackLlmAdapter
        from app.ports.ollama import OllamaLlmAdapter

        return FallbackLlmAdapter(
            OllamaLlmAdapter(
                base_url=settings.ollama_base_url,
                model=settings.ollama_model,
                timeout_sec=settings.ollama_timeout_sec,
                num_ctx=settings.ollama_num_ctx,
                keep_alive=settings.ollama_keep_alive,
            ),
            extractive,
        )

    return extractive


@lru_cache
def get_job_runner() -> JobRunnerPort:
    from app.ports.local_jobs import LocalJobRunner

    return LocalJobRunner()
