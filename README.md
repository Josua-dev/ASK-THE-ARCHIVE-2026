# Ask the Archive

**Your organisation has answers. Find them.**

An AI-powered organisational knowledge intelligence platform. Ask natural-language
questions about the documents your organisation holds and get answers that are
grounded in the actual text, carry real citations, and respect the permissions
attached to every document.

Everything runs locally. No hosted model provider, no managed vector database, no
object storage bucket. The inference model, the embedding model, OCR, document
extraction and the database all run on your own machine.

---

## What it actually does

| Module | What happens when you use it |
| --- | --- |
| **Ask the Archive** | A question is turned into a retrieval query, permission-filtered in SQL *before* the vector search runs, and the surviving passages are the only thing the model ever sees. The answer streams back with an evidence panel showing the exact passages used, and a citation list that opens the source document at the cited page. |
| **Research Mode** | A long-form report with eight fixed sections — executive summary, key findings, supporting evidence, relevant documents, conflicting information, missing information, important observations, source citations. Conflicting and missing information are surfaced explicitly rather than smoothed over. |
| **Document Library** | Upload a PDF, DOCX, XLSX, CSV, RTF, HTML or image. It is extracted (PyMuPDF, with Tesseract OCR for scans), chunked, embedded, classified, and given an expiry date. Only documents your account may read are ever listed. |
| **Document Profiles** | The extracted intelligence profile of a document: parties, organisations, important dates, monetary values, obligations, key clauses and contract references — each with the page it came from. |
| **Document Comparison** | Compare two documents and get verified findings — added, removed, modified, changed dates, changed values, different obligations, inconsistencies — each with a citation from *both* sides, or an explicit statement of which side could not be confirmed. |
| **Extraction Studio** | Describe a table in plain English and get it back, one column per field, with a quote behind every single cell. A value that cannot be verified renders as "— not verified" rather than an empty cell. |
| **Knowledge Graph** | A graph built from the extracted entities and relationships in the documents themselves — not generated. Search dims non-matches instead of removing them, and every node traces back to the passages it came from. |
| **Archive Insights** | Automated scans surface expiring leases, missing obligations, overdue renewals and conflicting dates — each with the document evidence behind it, and an acknowledge / resolve workflow. |
| **Important Dates** | Every date the archive knows about, in one chronological view, each linking to the document and page it came from. |
| **Analytics** | Real counts from the database: documents, pages, chunks, entities, questions asked, answers found, abstentions and their rate, citations, searches, comparisons, research reports, extraction runs, graph size. |
| **Conversations** | Every thread, with ownership and sharing. A conversation can be shared as *read* or *contribute*; a read-only share can read the transcript but cannot add to it. |
| **Smart Collections** | Derived views over the real archive — by type, by status, recently indexed, expiring soon, needs attention — with semantic search scoped to the collection. |
| **Security Centre / Users / Permissions / Audit** | Per-document grants (`view` / `download` / `manage`) to users or roles, enforced in SQL at retrieval time. Every authentication, permission change, download and answer attempt is recorded with the actor, resource and outcome. |

---

## The permission boundary

This is the part that matters, so it is worth being precise about.

1. **Filtering happens in SQL, before the vector search.** A `permitted` CTE restricts
   the candidate chunk set to documents the caller may read. The similarity search
   runs *inside* that set. An unauthorised chunk cannot be selected because it is
   not a candidate.
2. **A second check runs after retrieval.** `filter_by_permission` re-applies the
   ACL to whatever the vector search returned, so a bug in the first layer still
   cannot leak a passage.
3. **The prompt only ever contains filtered passages.** Unauthorised text never
   reaches the model's context window — it is not filtered from the answer, it is
   never given to the model at all.
4. **Admins bypass the ACL join**, by design, and the behaviour is auditable.
5. **Direct document access is checked too.** A viewer who knows a document ID
   gets `403`, not the document.

The consequence is visible in the product: the same question asked by three people
with three different roles returns three different answers, because each person can
only be shown what they are allowed to read.

---

## Honest answers

The archive is built to say "I don't know" rather than to guess.

- When retrieval returns nothing above the relevance threshold, the answer is
  flagged `found: false` and the UI marks it *"Not answered in the archive."*
- When the backend drops a claim it cannot attach a citation to, the claim is
  dropped — the report says so in the *missing information* section.
- A comparison that finds no verifiable difference says exactly that, and adds
  that this is not proof the documents are identical.
- A cell in an extraction that could not be cast to its declared type renders as
  *"— not verified"*, not as a blank and not as a guess.
- The dashboard counts abstentions and reports the abstention rate. It is a
  quality signal, not a failure to hide.

---

## Running it

### With Docker Compose (the whole stack)

```bash
docker compose up --build
```

This starts PostgreSQL with pgvector, Ollama, pulls the answering model, runs the
migrations, seeds the archive on first boot, and serves the app at
**http://localhost:3000**. Sign in with one of the seeded accounts listed
under [Seeding the archive](#seeding-the-archive).

The first build downloads the embedding model into the image and pulls
`qwen2.5:7b-instruct` into the Ollama volume, so the first run takes a while.
Later runs are fast — the seed step is skipped once the archive already holds
documents and users.

### Without Docker

<details>
<summary>Backend</summary>

```bash
cd backend
uv venv && uv pip install --python .venv/Scripts/python.exe -r <(uv pip compile pyproject.toml)
alembic upgrade head
.venv/Scripts/python.exe -m uvicorn app.main:app --port 8000
```

You also need: PostgreSQL 16+ with pgvector, Ollama running with
`qwen2.5:7b-instruct` pulled, and Tesseract on the path (or `TESSERACT_CMD` set).
</details>

<details>
<summary>Frontend</summary>

```bash
cd frontend
npm install
npm run dev
```

</details>

---

## Seeding the archive

```bash
cd backend
.venv/Scripts/python.exe -m scripts.seed
```

This generates eleven genuine PDFs (leases, contracts, policies, an NDA, a survey,
an MOU and an invoice), ingests them through the real pipeline — extraction,
chunking, embedding, classification, expiry-date extraction — and applies a
permission matrix:

| Account | Sees |
| --- | --- |
| `admin@archivedemo.example.com` | everything, including the NDA |
| `analyst@archivedemo.example.com` | the leases, contracts, MOU, invoice and survey |
| `viewer@archivedemo.example.com` | the two policies, the survey and the Harbour Street and Meridian Park leases |

All three use the password `Archive!2026`.

The compose stack runs this itself on first boot. To run it by hand:

```bash
docker compose exec backend python -m scripts.seed
```

`--if-empty` skips the reset when the archive is already populated, which is
what the container startup command uses.

---

## Verifying it

```bash
cd backend
.venv/Scripts/python.exe -m scripts.validate_demo
```

This drives the real ASGI app as all three seeded users and asserts the behaviours
that matter: that expiring leases are found and non-expiring ones are excluded,
that a summary is generated by a real model, that a citation opens the real page
it points at, that the analyst and the viewer get *different* answers to the same
question, that the admin-only NDA is reachable and citable by the admin but
refused outright to the analyst and the viewer, and that the archive abstains on
a question it genuinely cannot answer.

### Through the proxy

The browser never reaches the backend directly — every request goes through the
Next.js rewrite proxy, and that proxy has failure modes the backend tests cannot
see. Two checks cover the path the browser actually uses:

```bash
cd backend
.venv/Scripts/python.exe -m scripts.validate_proxy          # answers, citations, permissions
.venv/Scripts/python.exe -m scripts.validate_stream          # the streaming answer
```

`validate_proxy.py` asks each role a question their permissions allow, and asks
the analyst a question they do not have access to, checking that no document
they may not read is ever cited. `validate_stream.py` records the arrival time of
every server-sent event, which is how a buffered stream is caught: if the frames
all land at the same instant, the proxy is buffering and the answer appears all
at once instead of writing itself in.

Both take an optional base URL, so they can be pointed at a running Docker
stack:

```bash
.venv/Scripts/python.exe -m scripts.validate_proxy http://localhost:3000
```

### No screen may call an endpoint that does not exist

A screen wired to an endpoint the backend does not serve is a decorative
screen: it renders, it looks plausible, and it shows nothing.

```bash
.venv/Scripts/python.exe -m scripts.check_frontend_api
```

This walks the frontend's API client, extracts every path it requests, and
matches each one against the backend's real route table. It currently accounts
for 36 calls across 38 backend routes. `backend/tests/test_frontend_api.py`
guards it — including the matcher's rules in both directions, so a frontend
path that genuinely has no backend route cannot slip through as covered.

---

## Two things the proxy will silently break

Both of these fail in a way that looks like the product being broken rather
than the plumbing being broken, so they are worth knowing about.

**The 30-second abort.** Next's rewrite proxy aborts a request after 30 seconds
by default and returns its own `500` — the backend never sees the request at
all, so there is nothing in its logs to explain it. A real answer over a local
7B model on CPU takes around a minute, so every question through the proxy
failed. The fix is `experimental.proxyTimeout` in `frontend/next.config.js`,
nested under `experimental` because a top-level key is silently ignored.
`frontend/tests/proxy-timeout.test.mjs` guards it.

**Compression swallows the stream.** Next runs every response through its
compression middleware, and `text/event-stream` is a compressible content type,
so the server-sent events were gzipped — and gzip cannot emit anything until it
has seen the whole body. The answer still arrived, but all at once, after a long
silence. The SSE response therefore carries `Cache-Control: no-transform`, which
tells the middleware to leave the body alone.
`backend/tests/test_streaming.py` guards it.

---

## Explaining a retrieval

When a document does not appear in an answer, it helps to know which of three
things happened: the embedder ranked it low, the top-k cut dropped it, or the
permission filter refused it.

```bash
.venv/Scripts/python.exe -m scripts.explain_retrieval "what are the security obligations?" viewer
```

This runs the real permission-scoped search and prints the permitted passages,
the full corpus ranking beside them, and exactly which documents the ACL
refused for that role.

---

## Architecture

```
browser
  │
  ▼  /api/v1/* (rewritten by Next.js)
Next.js 14 (App Router, TypeScript, Tailwind, shadcn-style primitives)
  │
  ▼  /api/v1/*
FastAPI ──► PostgreSQL 16 + pgvector        (documents, chunks, ACLs, graph, audit)
  │
  ├──────► Ollama            (qwen2.5:7b-instruct — answering, classification,
  │                          profiles, comparison, extraction, research, insights)
  ├──────► SentenceTransformers  (BAAI/bge-m3, 1024-dim, local, in-process)
  ├──────► PyMuPDF + Tesseract     (extraction and OCR)
  └──────► local filesystem        (stored originals)
```

The backend is organised as ports and adapters. Every external capability sits
behind an interface in `backend/app/ports/`:

| Port | Local adapter | What it does |
| --- | --- | --- |
| `LlmPort` | `ollama` | Chat completion for every generation task |
| `EmbedderPort` | `sentence-transformers` | 1024-dim BGE-M3 embeddings |
| `ExtractorPort` | `pymupdf` | PDF/DOCX/XLSX/CSV/RTF/HTML text extraction, with Tesseract OCR |
| `StoragePort` | `local` | Stored originals on disk |
| `JobRunnerPort` | in-process | Background ingestion work |

Swapping an implementation is a configuration change, not a code change.

### Why it is built this way

- **Hexagonal ports and adapters** — the business rules (permission filtering,
  chunking, citation assembly) do not know or care that Ollama is the model.
- **The permission filter is a query, not a post-filter.** This is the only design
  that actually guarantees unauthorised text never enters the context window.
- **Citations are assembled from retrieved chunks, not generated.** The model
  cannot invent a citation because it never writes one.
- **Token-driven theming.** Every surface uses CSS-variable tokens, so dark mode
  works without a single conditional class in the components.

---

## Technology

| Layer | Choice |
| --- | --- |
| Frontend | Next.js 14 (App Router), TypeScript, Tailwind CSS, Radix UI, Framer Motion, React Flow, Recharts, cmdk |
| Backend | FastAPI, Python 3.12+, SQLAlchemy 2 (async), Pydantic v2, Alembic |
| Database | PostgreSQL 16 + pgvector (HNSW cosine index, `vector(1024)`) |
| Inference | Ollama — `qwen2.5:7b-instruct` |
| Embeddings | Sentence Transformers — `BAAI/bge-m3`, 1024-dim |
| OCR | Tesseract 5 |
| Extraction | PyMuPDF, python-docx, openpyxl, striprtf, html2text |
| Auth | Argon2id + HS256 JWT (30-minute access, 7-day rotating refresh), HMAC-signed document links |

---

## Layout

```
backend/
  app/
    core/            configuration, security, logging
    db/              session, models, migrations
    modules/         one package per feature (auth, documents, chat, retrieval,
                     profiles, compare, research, graph, extraction, insights,
                     analytics, conversations, conversation_share, summaries)
    ports/           the interfaces the adapters implement
    adapters/        local implementations of those interfaces
    prompts/         prompt templates, versioned
  scripts/
    seed_corpus.py     generates the eleven real PDFs
    seed.py            ingests them and applies the permission matrix
    validate_demo.py   end-to-end validation of the five behaviours
    validate_proxy.py  the same, through the frontend's rewrite proxy
    validate_stream.py checks that server-sent events are not buffered
    check_frontend_api.py  every frontend call has a real backend route
    explain_retrieval.py  shows what a role can and cannot retrieve, and why
    inspect_evidence.py   shows the passages each recorded answer was given
  tests/               permissions, citations, chunking, streaming, API coverage

frontend/
  src/
    app/             App Router pages, one directory per module
    components/      ui primitives, states, shell, command palette
    lib/             api client, auth, theme, navigation, types
    styles/          design tokens
  tests/             the proxy timeout guard
```

---

## Configuration

The backend reads `.env` (see `backend/.env` for a working local configuration).

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://archive:archive@127.0.0.1:5432/archive` | |
| `LLM_IMPL` | `ollama` | `ollama` or `anthropic` |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | |
| `EMBEDDER_IMPL` | `sentence-transformers` | |
| `EMBEDDING_MODEL_NAME` | `BAAI/bge-m3` | 1024-dim |
| `EXTRACTOR_IMPL` | `pymupdf` | |
| `OCR_IMPL` | `tesseract` | |
| `STORAGE_IMPL` | `local` | |
| `MIN_SCORE` | `0.30` | retrieval relevance floor |
| `TOP_K` | `6` | passages retrieved per question |
| `JWT_SECRET` | dev value | **change this for any deployment** |

The frontend talks only to our own backend through the Next.js rewrite proxy. It
never holds a database URL, a model endpoint or any other secret — those live
server-side only.

---

## API

38 routes under `/api/v1`, covering authentication, documents and their
permissions, previews and signed downloads, summaries, profiles, search, chat
(non-streaming and SSE), conversations and sharing, comparison, research, the
knowledge graph, extraction, insights, analytics, and administration.

Run the backend and open `/docs` for the interactive reference.

---

## Known limits

- Extraction runs on the CPU, so the first answer to a complex question can take
  tens of seconds. This is a local-inference cost, not a latency bug.
- The seeded corpus is eleven documents. It is enough to demonstrate every
  behaviour — including the permission boundary — but it is not a benchmark.
- Comparison and extraction complete synchronously, so their requests occupy a
  worker for the duration of the model call.
