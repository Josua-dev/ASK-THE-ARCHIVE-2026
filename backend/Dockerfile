# ── Ask the Archive — backend ────────────────────────────────────────────────
#
# The backend is a FastAPI application that talks to a local PostgreSQL (with
# pgvector), a local Ollama for inference, and a local Sentence Transformers
# model for embeddings. Nothing in this image reaches a hosted model provider.
#
# The image is deliberately heavy: sentence-transformers pulls in torch, and
# Tesseract needs its language data baked in so OCR works without a network.

FROM python:3.12-slim-bookworm AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # Keep HF caches inside the image layer so the model is available offline.
    HF_HOME=/opt/models/hf \
    SENTENCE_TRANSFORMERS_HOME=/opt/models/sentence-transformers \
    # tesseract ships its English data in a separate package on Debian.
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata

WORKDIR /app

# ── System dependencies ─────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        gnupg \
        libpq-dev \
        tesseract-ocr \
        tesseract-ocr-eng \
        libgl1 \
        libglib2.0-0 \
        # LibreOffice-free DOCX handling: python-docx covers what we need.
        unzip \
    && rm -rf /var/lib/apt/lists/*

# ── Python dependencies ─────────────────────────────────────────────────────
COPY pyproject.toml uv.lock ./

# Torch first, and from the CPU-only index. The default PyPI wheel for Linux
# x86_64 is the CUDA build, which drags in several gigabytes of NVIDIA
# runtime libraries that this image never uses — the embedder runs on CPU.
# Installing from the CPU index keeps the image a fraction of the size.
RUN pip install --upgrade pip \
    && pip install --index-url https://download.pytorch.org/whl/cpu "torch>=2.2.0"

RUN pip install \
        "fastapi>=0.115.0" \
        "uvicorn[standard]>=0.30.0" \
        "pydantic>=2.9.0" \
        "pydantic-settings>=2.5.0" \
        "sqlalchemy[asyncio]>=2.0.30" \
        "greenlet>=3.1.0" \
        "asyncpg>=0.30.0" \
        "pgvector>=0.3.0" \
        "argon2-cffi>=23.1.0" \
        "PyJWT>=2.9.0" \
        "fpdf2>=2.7.0" \
        "pymupdf>=1.24.0" \
        "pdfplumber>=0.11.0" \
        "pypdf>=4.3.0" \
        "python-multipart>=0.0.12" \
        "sentence-transformers>=3.0.0" \
        "python-docx>=1.1.0" \
        "pytesseract>=0.3.10" \
        "striprtf>=0.0.26" \
        "html2text>=2024.2.26" \
        "openpyxl>=3.1.5" \
        "httpx>=0.27.0" \
        "alembic>=1.13.0"

# ── Application source ──────────────────────────────────────────────────────
COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
COPY scripts ./scripts

# Pre-fetch the embedding model so the first request is not a download. The
# model is baked into the image; the container starts with no network need.
RUN python -c "\
from sentence_transformers import SentenceTransformer; \
m = SentenceTransformer('BAAI/bge-m3', device='cpu'); \
print('embedding model ready:', m.get_sentence_embedding_dimension())"

# The stored originals live on a mounted volume, not in the image.
RUN mkdir -p /app/uploads

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=10 \
    CMD curl -fsS http://127.0.0.1:8000/api/v1/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
