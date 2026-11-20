"""Local adapters — the platform's own implementations of every port.

Nothing here reaches a cloud service. Document bytes live on the local
filesystem, text and page images come from PyMuPDF, OCR comes from Tesseract,
embeddings come from Sentence Transformers, and answers come from Ollama.
"""

import asyncio
import re
from pathlib import Path
from typing import Optional

from app.ports.storage import StoragePort
from app.ports.extractor import ExtractorPort, ExtractionResult
from app.ports.embedder import EmbedderPort
from app.ports.llm import NO_ANSWER, LlmPort, LlmResponse


# ───────────────────────────── Storage ─────────────────────────────


class LocalStorageAdapter(StoragePort):
    """Stores document bytes on the local filesystem.

    Object keys are mapped to paths beneath `base_dir`; traversal outside that
    directory is rejected, because the key arrives from a query string.
    """

    def __init__(self, base_dir: str = "uploads"):
        self.base_dir = Path(base_dir).resolve()
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        safe = key.replace("\\", "/").lstrip("/")
        path = (self.base_dir / safe).resolve()
        # A key such as "../../etc/passwd" must not escape the storage root.
        if not str(path).startswith(str(self.base_dir)):
            raise ValueError("Invalid storage key")
        return path

    async def put_object(self, key, body, content_type, metadata=None) -> str:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return key

    async def get_object(self, key) -> bytes:
        return self._path(key).read_bytes()

    async def object_exists(self, key) -> bool:
        try:
            return self._path(key).exists()
        except ValueError:
            return False

    async def delete_object(self, key) -> None:
        try:
            path = self._path(key)
        except ValueError:
            return
        if path.exists():
            path.unlink()


# ───────────────────────────── Extractor ─────────────────────────────


class PyMuPdfExtractorAdapter(ExtractorPort):
    """PDF extraction via PyMuPDF, with Tesseract OCR for scanned pages."""

    def __init__(
        self,
        ocr=None,
        *,
        render_dpi: int = 144,
        ocr_min_chars_per_page: int = 32,
    ):
        self.ocr = ocr
        self.render_dpi = render_dpi
        self.ocr_min_chars_per_page = ocr_min_chars_per_page

    async def extract(self, document_bytes, filename, content_type) -> ExtractionResult:
        from app.ports.pdf import PyMuPdfAdapter

        adapter = PyMuPdfAdapter(
            ocr=self.ocr,
            render_dpi=self.render_dpi,
            ocr_min_chars_per_page=self.ocr_min_chars_per_page,
        )
        # PyMuPDF is CPU-bound; keep the event loop free while it runs.
        return await asyncio.to_thread(adapter.extract, document_bytes)


class PdfPlumberExtractorAdapter(ExtractorPort):
    """Legacy PDF extraction via pdfplumber (kept as a fallback)."""

    async def extract(self, document_bytes, filename, content_type) -> ExtractionResult:
        pages = []
        try:
            import io
            import pdfplumber

            with pdfplumber.open(io.BytesIO(document_bytes)) as pdf:
                for i, page in enumerate(pdf.pages, start=1):
                    pages.append({"page": i, "text": page.extract_text() or ""})
        except Exception:
            import io
            import pypdf

            reader = pypdf.PdfReader(io.BytesIO(document_bytes))
            for i, page in enumerate(reader.pages, start=1):
                pages.append({"page": i, "text": page.extract_text() or ""})

        text = "\n\n".join(p["text"] for p in pages)
        return ExtractionResult(text=text, page_count=len(pages), pages=pages)


class DocxExtractorAdapter(ExtractorPort):
    """Word (.docx) extraction — python-docx."""

    async def extract(self, document_bytes, filename, content_type) -> ExtractionResult:
        import io

        from docx import Document

        doc = Document(io.BytesIO(document_bytes))
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        # Tables read left-to-right, top-to-bottom, cells separated by tabs.
        for table in doc.tables:
            for row in table.rows:
                paragraphs.append("\t".join(c.text for c in row.cells))
        text = "\n\n".join(paragraphs)
        pages = [{"page": 1, "text": text}]
        return ExtractionResult(text=text, page_count=1, pages=pages)


class CsvExtractorAdapter(ExtractorPort):
    """CSV extraction — render each row as a comma-joined line."""

    async def extract(self, document_bytes, filename, content_type) -> ExtractionResult:
        import csv
        import io

        text = document_bytes.decode("utf-8", errors="replace")
        rows = list(csv.reader(io.StringIO(text)))
        lines = [", ".join(cell.strip() for cell in row) for row in rows if row]
        text = "\n".join(lines)
        pages = [{"page": 1, "text": text}]
        return ExtractionResult(text=text, page_count=1, pages=pages)


class TxtExtractorAdapter(ExtractorPort):
    """Plain-text (.txt, .md, .log, ...) extraction."""

    async def extract(self, document_bytes, filename, content_type) -> ExtractionResult:
        text = document_bytes.decode("utf-8", errors="replace")
        pages = [{"page": 1, "text": text}]
        return ExtractionResult(text=text, page_count=1, pages=pages)


class RtfExtractorAdapter(ExtractorPort):
    """Rich Text Format (.rtf) extraction — striprtf."""

    async def extract(self, document_bytes, filename, content_type) -> ExtractionResult:
        from striprtf.striprtf import rtf_to_text

        text = document_bytes.decode("utf-8", errors="replace")
        text = rtf_to_text(text)
        pages = [{"page": 1, "text": text}]
        return ExtractionResult(text=text, page_count=1, pages=pages)


class HtmlExtractorAdapter(ExtractorPort):
    """HTML extraction — html2text converts to readable Markdown-like text."""

    async def extract(self, document_bytes, filename, content_type) -> ExtractionResult:
        import html2text

        text = document_bytes.decode("utf-8", errors="replace")
        converter = html2text.HTML2Text()
        converter.ignore_links = True
        converter.ignore_images = True
        text = converter.handle(text)
        pages = [{"page": 1, "text": text}]
        return ExtractionResult(text=text, page_count=1, pages=pages)


class XlsxExtractorAdapter(ExtractorPort):
    """Excel (.xlsx) extraction — openpyxl reads all sheets as tab-separated rows."""

    async def extract(self, document_bytes, filename, content_type) -> ExtractionResult:
        import io

        from openpyxl import load_workbook

        wb = load_workbook(io.BytesIO(document_bytes), data_only=True, read_only=True)
        all_lines = []
        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            for row in ws.iter_rows(values_only=True):
                cells = [str(c) if c is not None else "" for c in row]
                if any(cells):  # skip completely empty rows
                    all_lines.append("\t".join(cells))
        text = "\n".join(all_lines)
        pages = [{"page": 1, "text": text}]
        return ExtractionResult(text=text, page_count=1, pages=pages)


class ImageExtractorAdapter(ExtractorPort):
    """Image (PNG / JPEG / TIFF / ...) extraction via OCR.

    Requires the tesseract-ocr binary to be installed on the host system
    (Windows: https://github.com/UB-Mannheim/tesseract/wiki,
    Debian/Ubuntu: apt-get install tesseract-ocr).
    """

    def __init__(self, ocr=None):
        self.ocr = ocr

    async def extract(self, document_bytes, filename, content_type) -> ExtractionResult:
        engine = self.ocr
        if engine is None:
            from app.ports.pdf import OcrEngine

            engine = OcrEngine()

        try:
            import io

            from PIL import Image

            image = Image.open(io.BytesIO(document_bytes))
            buffer = io.BytesIO()
            image.convert("RGB").save(buffer, format="PNG")
            text = engine.image_to_text(buffer.getvalue())
        except Exception as exc:  # noqa: BLE001 - report the reason honestly
            text = (
                f"[OCR unavailable: {str(exc)[:200]}. Install tesseract-ocr and "
                "make sure `tesseract` is on PATH.]"
            )
        pages = [{"page": 1, "text": text}]
        return ExtractionResult(text=text, page_count=1, pages=pages)


class MultiFormatExtractorAdapter(ExtractorPort):
    """Dispatches each document to the correct extractor by content type or
    filename extension, so the ingestion pipeline never needs to change when a
    new file type is supported.
    """

    def __init__(
        self,
        ocr=None,
        *,
        render_dpi: int = 144,
        ocr_min_chars_per_page: int = 32,
        preview_max_px: int = 1600,
    ):
        self.ocr = ocr
        self.render_dpi = render_dpi
        self.ocr_min_chars_per_page = ocr_min_chars_per_page
        self.preview_max_px = preview_max_px
        self._registry: dict[tuple[str | None, str | None], ExtractorPort] = {}

    def _pick(self, content_type: str | None, filename: str | None) -> ExtractorPort:
        key = (content_type, filename)
        adapter = self._registry.get(key)
        if adapter is not None:
            return adapter
        adapter = self._build(content_type, filename)
        self._registry[key] = adapter
        return adapter

    def _build(self, content_type: str | None, filename: str | None) -> ExtractorPort:
        if filename:
            name = filename.lower()
            if name.endswith(".pdf"):
                return PyMuPdfExtractorAdapter(
                    self.ocr,
                    render_dpi=self.render_dpi,
                    ocr_min_chars_per_page=self.ocr_min_chars_per_page,
                )
            if name.endswith(".docx"):
                return DocxExtractorAdapter()
            if name.endswith(".csv"):
                return CsvExtractorAdapter()
            if name.endswith((".txt", ".md", ".log")):
                return TxtExtractorAdapter()
            if name.endswith(".rtf"):
                return RtfExtractorAdapter()
            if name.endswith((".html", ".htm")):
                return HtmlExtractorAdapter()
            if name.endswith(".xlsx"):
                return XlsxExtractorAdapter()
            if name.endswith((".png", ".jpg", ".jpeg", ".tiff", ".bmp")):
                return ImageExtractorAdapter(self.ocr)
        if content_type:
            ct = content_type.lower()
            if ct == "application/pdf":
                return PyMuPdfExtractorAdapter(
                    self.ocr,
                    render_dpi=self.render_dpi,
                    ocr_min_chars_per_page=self.ocr_min_chars_per_page,
                )
            if ct == (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ):
                return DocxExtractorAdapter()
            if ct in ("text/csv", "text/comma-separated-values"):
                return CsvExtractorAdapter()
            if ct in ("text/plain", "text/markdown"):
                return TxtExtractorAdapter()
            if ct == "application/rtf":
                return RtfExtractorAdapter()
            if ct == "text/html":
                return HtmlExtractorAdapter()
            if ct in (
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ):
                return XlsxExtractorAdapter()
            if ct in ("image/png", "image/jpeg", "image/tiff", "image/bmp"):
                return ImageExtractorAdapter(self.ocr)
        # Sensible default for anything we can't identify.
        return PyMuPdfExtractorAdapter(
            self.ocr,
            render_dpi=self.render_dpi,
            ocr_min_chars_per_page=self.ocr_min_chars_per_page,
        )

    async def extract(self, document_bytes, filename, content_type) -> ExtractionResult:
        adapter = self._pick(content_type, filename)
        return await adapter.extract(document_bytes, filename, content_type)


# ───────────────────────────── Embedder ─────────────────────────────


class HashEmbedderAdapter(EmbedderPort):
    """Deterministic offline embedder — used only when no
    model is available so the pipeline and tests still run end-to-end.

    This is a real (if shallow) lexical embedder, not random noise: identical
    text always produces an identical vector, and vectors that share tokens
    are measurably closer. It is deliberately the last resort.
    """

    def __init__(self, dimensions: int = 1024):
        self._dimensions = dimensions

    async def embed(self, texts):
        import hashlib
        import math

        out = []
        for text in texts:
            vec = [0.0] * self._dimensions
            words = re.findall(r"[a-z0-9]+", text.lower())
            for w in words:
                h = int(hashlib.sha256(w.encode()).hexdigest(), 16)
                idx = h % self._dimensions
                sign = 1.0 if (h >> 8) & 1 else -1.0
                vec[idx] += sign
            norm = math.sqrt(sum(v * v for v in vec)) or 1.0
            out.append([v / norm for v in vec])
        return out

    @property
    def dimensions(self) -> int:
        return self._dimensions

    @property
    def model_id(self) -> str:
        return f"hash-{self._dimensions}"


class SentenceTransformerEmbedderAdapter(EmbedderPort):
    """Local embeddings from a Sentence Transformers model.

    The default model is BAAI/bge-m3, whose native output width is 1024 —
    the exact width of the `vector(1024)` column and its HNSW cosine index.
    If a different model is configured the vectors are projected onto the
    configured width (truncated or zero-padded, then re-normalised) so the
    database column and the query vector can never disagree.

    The model is loaded once and kept in memory. Loading is slow and the
    encode is CPU-bound, so both run in a worker thread: the event loop must
    stay free to serve other requests while a document is being embedded.
    """

    def __init__(
        self,
        model_name: str = "BAAI/bge-m3",
        dimensions: int = 1024,
        device: str = "cpu",
        batch_size: int = 16,
        offline: bool = False,
    ):
        self.model_name = model_name
        self._dimensions = dimensions
        self.device = device
        self.batch_size = batch_size
        self.offline = offline
        self._model = None
        self._lock = asyncio.Lock()

    def _load_sync(self):
        """Load the model, preferring the local cache over the Hub.

        SentenceTransformer resolves the model name against the Hub on every
        load. On a slow or restricted connection that call blocks for many
        minutes — long enough to stall an entire ingestion run — even when the
        weights are already on disk. So the offline path is tried first and
        the online path is kept only as a fallback for a machine that has
        never downloaded the model.
        """
        from sentence_transformers import SentenceTransformer

        if self.offline:
            import huggingface_hub.constants as hub_constants

            was_offline = hub_constants.HF_HUB_OFFLINE
            hub_constants.HF_HUB_OFFLINE = True
            try:
                return SentenceTransformer(self.model_name, device=self.device)
            finally:
                hub_constants.HF_HUB_OFFLINE = was_offline

        try:
            import huggingface_hub.constants as hub_constants

            was_offline = hub_constants.HF_HUB_OFFLINE
            hub_constants.HF_HUB_OFFLINE = True
            try:
                return SentenceTransformer(self.model_name, device=self.device)
            finally:
                hub_constants.HF_HUB_OFFLINE = was_offline
        except Exception:  # noqa: BLE001 - fall back to a normal load
            return SentenceTransformer(self.model_name, device=self.device)

    async def _load(self):
        async with self._lock:
            if self._model is None:
                self._model = await asyncio.to_thread(self._load_sync)
            return self._model

    def _fit(self, row):
        """Project a native-width vector onto the configured width."""
        if len(row) == self._dimensions:
            return row
        if len(row) > self._dimensions:
            return row[: self._dimensions]
        return list(row) + [0.0] * (self._dimensions - len(row))

    async def embed(self, texts):
        import math

        texts = list(texts)
        if not texts:
            return []
        model = await self._load()
        arr = await asyncio.to_thread(
            model.encode,
            texts,
            batch_size=self.batch_size,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        out = []
        for row in arr:
            fitted = self._fit([float(x) for x in row])
            norm = math.sqrt(sum(v * v for v in fitted)) or 1.0
            out.append([v / norm for v in fitted])
        return out

    @property
    def dimensions(self) -> int:
        return self._dimensions

    @property
    def model_id(self) -> str:
        return self.model_name


class OllamaEmbedderAdapter(EmbedderPort):
    """Embeddings served by the local Ollama daemon.

    Used when `EMBEDDER_IMPL=ollama`. Ollama's embedding models have their own
    native widths (nomic-embed-text is 768), so the vectors are projected onto
    the configured width in the same way as the Sentence Transformers adapter.
    """

    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        model: str = "nomic-embed-text",
        timeout_sec: int = 300,
        dimensions: int = 1024,
    ):
        self.base_url = base_url
        self.model = model
        self.timeout_sec = timeout_sec
        self._dimensions = dimensions

    def _fit(self, row):
        if len(row) == self._dimensions:
            return row
        if len(row) > self._dimensions:
            return row[: self._dimensions]
        return list(row) + [0.0] * (self._dimensions - len(row))

    async def embed(self, texts):
        import math

        from app.core.http import httpx

        texts = list(texts)
        if not texts:
            return []
        async with httpx.AsyncClient(timeout=self.timeout_sec) as client:
            response = await client.post(
                f"{self.base_url.rstrip('/')}/api/embed",
                json={"model": self.model, "input": texts},
            )
            response.raise_for_status()
            payload = response.json()

        vectors = payload.get("embeddings") or []
        out = []
        for row in vectors:
            fitted = self._fit([float(x) for x in row])
            norm = math.sqrt(sum(v * v for v in fitted)) or 1.0
            out.append([v / norm for v in fitted])
        return out

    @property
    def dimensions(self) -> int:
        return self._dimensions

    @property
    def model_id(self) -> str:
        return f"ollama:{self.model}"


# ───────────────────────────── LLM ─────────────────────────────


_STOPWORDS = {
    "the", "a", "an", "of", "which", "what", "is", "are", "was", "were", "in",
    "on", "for", "to", "do", "does", "did", "that", "this", "these", "those",
    "and", "or", "but", "if", "we", "our", "us", "i", "me", "my", "you", "your",
    "be", "been", "being", "have", "has", "had", "will", "would", "shall",
    "can", "could", "may", "might", "must", "please", "tell", "give", "about",
    "there", "their", "them", "they", "from", "with", "under", "over", "all",
    "any", "how", "when", "where", "who", "why", "does", "am", "as", "at", "by",
}


_PASSAGE_HEADER = re.compile(r"^\[(\d+)\]\s+(.+?)\s*\(pages\s+\d+-\d+\)\s*$")

# Words that appear in almost every filename in a domain and therefore carry
# no document-identifying signal: "harbour-street-lease.pdf" and
# "northgate-warehouse-lease.pdf" share the token "lease", so only the
# distinctive part of a name can be used to recognise a document.
_FILENAME_STOP = {
    "pdf", "doc", "docx", "txt", "lease", "leases", "agreement", "agreements",
    "contract", "contracts", "policy", "policies", "nda", "report", "reports",
    "invoice", "invoices", "memorandum", "msa", "addendum", "schedule",
    "appendix", "letter", "the", "and", "of", "for", "form",
}

# Question/sentence vocabulary that should be treated as the same concept.
_SYNONYM_GROUPS = [
    {"annual", "annum", "yearly"},
    {"rent", "rental"},
    {"expiry", "expire", "expires", "expiration", "terminates"},
    {"cost", "costs", "price", "charge"},
    {"obligation", "obligations", "duty", "duties", "requirement", "requirements"},
    {"protection", "protect", "protects", "protecting"},
    {"party", "parties", "counterparty"},
    {"confidential", "confidentiality"},
]

_SYNONYM_CANON = {}
for _group in _SYNONYM_GROUPS:
    _canon = sorted(_group)[0]
    for _word in _group:
        _SYNONYM_CANON[_word] = _canon

# A question about money, and a sentence that states an amount. The two must
# both be present before the amount is treated as relevant — otherwise any
# sentence containing a year ("2027") would look like an answer to a
# "win probability in Q3 2027" question.
_MONEY_QUESTION = re.compile(
    r"\b(rent|price|cost|costs|value|fee|fees|amount|total|charge|payment|sum)\b", re.I
)
_MONEY_IN_TEXT = re.compile(r"(?:£|\$|€)\s?[\d,]+|\b(?:pounds?|pence|dollars?|euros?)\b", re.I)

# A sentence boundary: end punctuation followed by a capital or a quote.
# Requiring the capital keeps "12.5" from being cut in half.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])[\"')\]]?\s+(?=[A-Z0-9])")


def _canonical(word: str) -> str:
    return _SYNONYM_CANON.get(word, word)


def _content_words(text: str) -> set:
    return {
        _canonical(w)
        for w in re.findall(r"[a-z0-9]+", text.lower())
        if w not in _STOPWORDS and len(w) > 2
    }


def _filename_tokens(filename: str) -> set:
    return {
        w
        for w in re.split(r"[^a-z0-9]+", filename.lower())
        if len(w) > 2 and w not in _FILENAME_STOP
    }


def _sentences(text: str) -> list:
    """Split a passage into candidate sentences.

    Two things have to be undone before a sentence can be scored.

    First, each retrieved passage begins with a header line naming the source
    document — "[1] lease.pdf (pages 1-2)". That line is metadata, not
    evidence, and it scores highly on a document-specific question, so it is
    stripped here and handled separately by the caller.

    Second, the extracted text is a PDF layout: each paragraph is hard-wrapped
    across several lines. Scoring the wrapped lines individually makes half a
    sentence look like a different fact from the other half, so the lines of a
    paragraph are rejoined before the passage is split into sentences.
    """
    lines = text.split("\n")
    if lines and _PASSAGE_HEADER.match(lines[0].strip()):
        lines = lines[1:]
    body = "\n".join(lines)

    sentences = []
    for paragraph in body.split("\n\n"):
        joined = " ".join(p.strip() for p in paragraph.split("\n") if p.strip())
        if not joined:
            continue
        for part in _SENTENCE_SPLIT.split(joined):
            part = part.strip()
            # A candidate sentence must end with real sentence punctuation
            # (optionally followed by a closing bracket/quote), and a PDF title
            # block — a dump of multiple "Label: value" pairs — is excluded by
            # its colon count (2+), which distinguishes it from a genuine
            # sentence, which almost never carries more than one colon.
            if len(part) > 40 and re.search(r"[.!?][\"')\]]*$", part) and part.count(":") < 2:
                sentences.append(part)
    return sentences


class ExtractiveLlmAdapter(LlmPort):
    """Sentence-level extractive answering — no model call.

    This is the fallback when the model provider is unavailable, and it is
    deliberately built to be *useful and honest* rather than to imitate a
    model:

    - the answer is composed from sentences that actually occur in the
      retrieved passages, with `[n]` markers pointing at the passage each
      sentence came from;
    - a sentence is only used when it shares meaningful vocabulary with the
      question, and the answer abstains entirely when no sentence does;
    - `model` is reported as `extractive` so the interface can say that the
      answer was not generated by a language model.

    Because it never invents text, TEST 5 (honest abstention) stays
    deterministic even when the model provider is throttled.
    """

    async def generate(self, system_prompt, context, question, history=None) -> LlmResponse:
        question_words = _content_words(question)
        passages = [p for p in context.split("\n\n---\n\n") if p.strip()]

        if not question_words:
            return LlmResponse(
                text=(
                    "I could not find an answer to that in the documents you have "
                    "access to. The archive contains no information that answers "
                    "this question."
                ),
                citations=[],
                found=False,
                model="extractive",
            )

        # Score every sentence of every passage against the question.
        candidates = []
        money_question = bool(_MONEY_QUESTION.search(question))
        for passage_index, passage in enumerate(passages, start=1):
            # The passage header names the document the passage came from.
            # A question that names a document — "the Harbour Street lease" —
            # must be answered from that document and not from a document
            # that merely shares a topic.
            header = _PASSAGE_HEADER.match(passage.split("\n", 1)[0].strip())
            doc_tokens = _filename_tokens(header.group(2)) if header else set()
            doc_bonus = 0.9 if doc_tokens & question_words else 0.0

            for sentence in _sentences(passage):
                sentence_words = _content_words(sentence)
                if not sentence_words:
                    continue
                overlap = question_words & sentence_words
                if not overlap:
                    continue
                # Coverage of the question matters more than raw overlap:
                # a sentence that hits four of five question terms is a
                # better answer than one that repeats a single term.
                coverage = len(overlap) / len(question_words)
                density = len(overlap) / len(sentence_words)
                score = coverage * 2.5 + density * 0.4 + doc_bonus
                # An amount is the answer to a "how much" question, but only
                # when the question asked about money and the sentence states
                # an amount.
                if money_question and _MONEY_IN_TEXT.search(sentence):
                    score += 0.5
                # Earlier passages are the ones retrieval trusted more.
                score += 0.25 / passage_index
                candidates.append((score, passage_index, sentence, overlap))

        if not candidates:
            return LlmResponse(
                text=(
                    "I could not find an answer to that in the documents you have "
                    "access to. The archive contains no information that answers "
                    "this question."
                ),
                citations=[],
                found=False,
                model="extractive",
            )

        candidates.sort(key=lambda c: c[0], reverse=True)
        best_score = candidates[0][0]
        if best_score < 0.55:
            # Too weak to be evidence of an answer. The bar matters: a single
            # incidental word overlap must not be enough to manufacture an
            # answer to a question the archive does not contain.
            return LlmResponse(
                text=(
                    "I could not find an answer to that in the documents you have "
                    "access to. The archive contains no information that answers "
                    "this question."
                ),
                citations=[],
                found=False,
                model="extractive",
            )

        # Keep the strongest sentences, preferring breadth across passages
        # over depth within one — the answer should read as a statement
        # rather than a dump of the single best-matching chunk. Round-robin
        # over the passages so each retrieved document contributes at least
        # one sentence: an answer drawn only from the top passage hides the
        # other documents the question actually touched.
        by_passage: dict = {}
        for score, passage_index, sentence, _ in candidates:
            if score < best_score * 0.3:
                break
            by_passage.setdefault(passage_index, []).append((score, sentence))

        order = sorted(
            by_passage, key=lambda p: by_passage[p][0][0], reverse=True
        )
        chosen = []
        for _ in range(4):
            for passage_index in order:
                items = by_passage.get(passage_index) or []
                if items:
                    chosen.append((passage_index, items.pop(0)[1]))
            if len(chosen) >= 4:
                break

        body = "\n\n".join(f"{s} [{i}]" for i, s in chosen)
        text = (
            "From the documents you have access to:\n\n"
            f"{body}"
        )
        return LlmResponse(
            text=text,
            citations=sorted({i for i, _ in chosen}),
            found=True,
            model="extractive",
        )

    async def generate_stream(self, system_prompt, context, question, history=None):
        response = await self.generate(system_prompt, context, question, history)
        if response.found:
            yield response.text
        else:
            yield NO_ANSWER

    async def summarise(self, system_prompt, context, instruction=None) -> LlmResponse:
        """Extractive summarisation — pick the most informative sentences.

        Unlike `generate`, this does not score sentences against a question
        (there is no question).  Instead it selects sentences that carry the
        most non-stopword content, preserving their original order so the
        summary reads naturally.
        """
        if not context or not context.strip():
            return LlmResponse(text="", citations=[], found=False, model="extractive")

        # Strip passage headers — they are retrieval metadata, not content.
        # The summarisation context uses "[1] pages X-Y" (no filename, no
        # parens), which differs from the Q&A format handled by
        # `_PASSAGE_HEADER`.  Match both here.
        lines = context.split("\n")
        if lines and (
            _PASSAGE_HEADER.match(lines[0].strip())
            or re.match(r"^\[\d+\]\s+pages\s+\d+-\d+\s*$", lines[0].strip())
        ):
            lines = lines[1:]
        body = "\n".join(lines)
        if not body.strip():
            return LlmResponse(text="", citations=[], found=False, model="extractive")

        sentences = _sentences(body)
        if not sentences:
            # If sentence splitting yields nothing (e.g. very short or
            # oddly formatted text), fall back to the first 600 chars.
            text = body.strip()[:600]
            return LlmResponse(text=text, citations=[1], found=True, model="extractive")

        # Score each sentence by content-word density (fraction of words
        # that are not stopwords) × length factor, then pick the top 3–5
        # while preserving original order.
        scored = []
        for i, sent in enumerate(sentences):
            words = re.findall(r"[a-z0-9]+", sent.lower())
            if not words:
                continue
            content = [w for w in words if w not in _STOPWORDS and len(w) > 2]
            density = len(content) / len(words) if words else 0
            # Prefer sentences with more content words, slightly penalise very
            # short sentences (likely fragments) and very long ones (likely
            # run-ons).
            length_factor = min(len(words) / 20.0, 1.2)
            score = density * length_factor
            scored.append((score, i, sent))

        if not scored:
            text = body.strip()[:600]
            return LlmResponse(text=text, citations=[1], found=True, model="extractive")

        # Take top sentences (up to 5), then re-sort by original position.
        top_n = min(5, max(2, len(scored) // 3))
        scored.sort(key=lambda x: x[0], reverse=True)
        chosen = sorted(scored[:top_n], key=lambda x: x[1])

        summary = " ".join(s for _, _, s in chosen)
        return LlmResponse(text=summary, citations=[1], found=True, model="extractive")