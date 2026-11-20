"""PDF processing with PyMuPDF, plus OCR for scanned pages.

PyMuPDF (fitz) does three jobs for this platform:

1. Reads the text layer of a PDF, page by page.
2. Rasterises a page to PNG, which powers the document preview and the
   Evidence Explorer's "inspect the original page" view.
3. Rasterises a page for OCR when the text layer is missing or too thin —
   the case for a scanned contract.

Tesseract performs the OCR. When the binary is absent the page is marked as
un-OCRable rather than silently producing an empty page, so the interface can
say why the text is missing instead of pretending the document was blank.
"""

import io
from dataclasses import dataclass
from typing import List, Optional

from app.ports.extractor import ExtractionResult


@dataclass
class PageImage:
    page: int
    png: bytes
    width: int
    height: int


class OcrUnavailableError(RuntimeError):
    """Raised when OCR was requested but the Tesseract binary is not present."""


class OcrEngine:
    """Thin wrapper over `pytesseract` with an explicit availability check."""

    def __init__(self, binary_path: str = ""):
        self.binary_path = binary_path or None
        self._available: Optional[bool] = None

    def available(self) -> bool:
        if self._available is None:
            try:
                import pytesseract

                if self.binary_path:
                    pytesseract.pytesseract.tesseract_cmd = self.binary_path
                pytesseract.get_tesseract_version()
                self._available = True
            except Exception:
                self._available = False
        return self._available

    def image_to_text(self, png: bytes) -> str:
        """OCR a PNG into plain text."""
        if not self.available():
            raise OcrUnavailableError(
                "Tesseract is not installed on this host. Install tesseract-ocr "
                "and make sure it is on PATH, or set TESSERACT_CMD to its full path."
            )
        from PIL import Image
        import pytesseract

        image = Image.open(io.BytesIO(png))
        return pytesseract.image_to_string(image)


class PyMuPdfAdapter:
    """Extracts text and page images from a PDF using PyMuPDF."""

    def __init__(
        self,
        ocr: Optional[OcrEngine] = None,
        *,
        render_dpi: int = 144,
        ocr_min_chars_per_page: int = 32,
    ):
        self.ocr = ocr
        self.render_dpi = render_dpi
        self.ocr_min_chars_per_page = ocr_min_chars_per_page

    # ── low level ─────────────────────────────────────────────────────────

    def _open(self, document_bytes: bytes):
        try:
            import fitz  # PyMuPDF
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise RuntimeError(
                "PyMuPDF is not installed. Install it with `pip install pymupdf`."
            ) from exc
        return fitz.open(stream=document_bytes, filetype="pdf")

    def _render_page(self, page, dpi: Optional[int] = None, max_px: Optional[int] = None):
        """Rasterise a page to PNG bytes."""
        import fitz

        zoom = (dpi or self.render_dpi) / 72.0
        matrix = fitz.Matrix(zoom, zoom)
        pixmap = page.get_pixmap(matrix=matrix, alpha=False)
        if max_px and max(pixmap.width, pixmap.height) > max_px:
            scale = max_px / max(pixmap.width, pixmap.height)
            matrix = fitz.Matrix(zoom * scale, zoom * scale)
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
        return pixmap.tobytes("png"), pixmap.width, pixmap.height

    # ── public API ────────────────────────────────────────────────────────

    def extract(self, document_bytes: bytes) -> ExtractionResult:
        """Extract per-page text, running OCR on pages that need it."""
        doc = self._open(document_bytes)
        try:
            pages: List[dict] = []
            for index, page in enumerate(doc, start=1):
                text = (page.get_text("text") or "").strip()
                if len(text) < self.ocr_min_chars_per_page and self.ocr and self.ocr.available():
                    try:
                        png, _w, _h = self._render_page(page, dpi=200)
                        ocr_text = self.ocr.image_to_text(png).strip()
                        if len(ocr_text) > len(text):
                            text = ocr_text
                    except Exception:
                        # OCR failure must not abort the whole document: the
                        # page keeps whatever text layer it had.
                        pass
                pages.append({"page": index, "text": text})
        finally:
            doc.close()

        full_text = "\n\n".join(p["text"] for p in pages if p["text"])
        return ExtractionResult(text=full_text, page_count=len(pages), pages=pages)

    def render_page(
        self,
        document_bytes: bytes,
        page_number: int,
        *,
        dpi: Optional[int] = None,
        max_px: Optional[int] = None,
    ) -> PageImage:
        """Render one page (1-based) to a PNG."""
        doc = self._open(document_bytes)
        try:
            if page_number < 1 or page_number > doc.page_count:
                raise IndexError(f"Page {page_number} is out of range")
            page = doc[page_number - 1]
            png, width, height = self._render_page(page, dpi=dpi, max_px=max_px)
            return PageImage(page=page_number, png=png, width=width, height=height)
        finally:
            doc.close()

    def page_count(self, document_bytes: bytes) -> int:
        doc = self._open(document_bytes)
        try:
            return doc.page_count
        finally:
            doc.close()
