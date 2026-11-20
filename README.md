# Ask the Archive

**AI-powered document intelligence platform** for the TDW × AWS Innovation Challenge.

A secure, permission-scoped RAG system that lets authorised users ask natural-language questions about organisational documents and receive accurate answers with citations — under strict per-document access control.

---

## 🎯 Project Overview

| Aspect | Details |
|--------|---------|
| **Challenge** | TDW × AWS Innovation Challenge |
| **Backend** | Python 3.12, FastAPI, SQLAlchemy 2, pgvector |
| **Frontend** | Next.js 15 (App Router), TypeScript, Tailwind v4 |
| **Database** | PostgreSQL 16 + pgvector (Neon/Supabase managed) |
| **Embeddings** | Amazon Titan Text Embeddings V2 (Bedrock) / BGE-M3 local fallback |
| **LLM** | Amazon Bedrock Converse (Claude) / Extractive local fallback |
| **OCR/Extraction** | Amazon Textract / pdfplumber local fallback |
| **Storage** | Amazon S3 (SSE-KMS) / Local filesystem fallback |
| **Auth** | Self-managed JWT (HS256) + Argon2id |

### Core Guiding Principles

1. **Permission boundary before retrieval** — unauthorised text never enters the model prompt, verified at SQL level
2. **Deterministic fallbacks** — every question type has a deterministic path (metadata queries, keyword search, honest abstention)
3. **Honest responses** — when information cannot be found, the system explicitly says so; no invented citations
4. **Technical clarity** — complex engineering concepts presented accessibly

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    NEXT.JS 15 (App Router)                     │
│  /login · /assistant · /library · /documents/[id] · /admin     │
└─────────────────────────────┬───────────────────────────────────┘
                              │ JSON / SSE streaming
                              ▼
                    ┌─────────────────────┐
                    │  FASTAPI · Pydantic │
                    │  app/               │
                    │  ├─ core/           │  config, deps, errors
                    │  ├─ db/             │  session, models, repos
                    │  ├─ modules/        │  auth, documents, chat,
                    │  │                 │  ingestion, retrieval,
                    │  │                 │  summaries, admin, audit
                    │  ├─ ports/          │  protocols + AWS/local adapters
                    │  └─ shared/         │  schemas, utils, prompts
                    └──────────┬──────────┘
                               │ SQLAlchemy 2 + pgvector
                               ▼
                    ┌─────────────────────┐
                    │ PostgreSQL 16 + pgvector │
                    │ users · documents · document_chunks │
                    │ document_permissions · conversations │
                    │ messages · citations · ingestion_jobs │
                    │ document_summaries · audit_logs │
                    └─────────────────────┘
```

**Security boundary**: The `permitted` CTE in retrieval SQL runs *before* any vector search, ensuring only authorised document chunks ever reach the model.

---

## 🚀 Quick Start

### Prerequisites

- Python 3.12+
- Node.js 20+
- PostgreSQL 16 with pgvector (or Neon/Supabase managed instance)
- AWS credentials (optional — local fallbacks available)

### Backend Setup

```bash
cd backend

# Create virtual environment
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# Install dependencies
pip install -e .

# Copy environment template
cp .env.example .env
# Edit .env with your configuration

# Run database migrations
alembic upgrade head

# Seed demo data (optional)
python scripts/seed.py

# Start server (no --reload to avoid multiprocessing issues)
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Copy environment template
cp .env.example .env.local

# Start dev server
npm run dev
```

### Access the Application

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:8000
- **API Docs (Swagger)**: http://localhost:8000/docs

---

## ⚙️ Configuration

All configuration is environment-driven. Copy `.env.example` to `.env` in both `backend/` and `frontend/`.

### Backend Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string (must have `vector` extension) |
| `JWT_SECRET` | ✅ | — | HS256 signing key (≥32 random bytes) |
| `AWS_REGION` | AWS mode | `af-south-1` | Region for all AWS clients |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS mode | — | Sandbox credentials |
| `S3_BUCKET_NAME` | AWS mode | — | S3 bucket for document originals |
| `BEDROCK_MODEL_ID` | AWS mode | `anthropic.claude-3-5-sonnet-20241022-v2:0` | LLM for answer generation |
| `BEDROCK_EMBED_MODEL_ID` | AWS mode | `amazon.titan-embed-text-v2:0` | Embeddings (1024 dims) |
| `STORAGE_IMPL` | — | `s3` | `s3` \| `local` |
| `EXTRACTOR_IMPL` | — | `textract` | `textract` \| `pdfplumber` |
| `EMBEDDER_IMPL` | — | `titan-v2` | `titan-v2` \| `bge-m3` |
| `LLM_IMPL` | — | `bedrock-converse` | `bedrock-converse` \| `extractive` |
| `MIN_SCORE` | — | `0.30` | Cosine similarity abstention threshold |
| `TOP_K` | — | `6` | Retrieval depth |
| `CORS_ORIGINS` | — | `http://localhost:3000` | Frontend origin allow-list |

### Frontend Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_BASE` | — | API base URL (default: `/api/v1` via Next.js rewrites) |

---

## 🔐 Security & Permissions

### Permission Model

- **Admin**: Full access to all documents, user management, audit logs
- **Analyst**: View/download documents granted via role-based permissions
- **Viewer**: View-only access to explicitly granted documents

### ACL Enforcement

1. **SQL-level**: `permitted` CTE filters documents *before* vector search
2. **Application-level**: Post-retrieval re-validation of every chunk
3. **Download/Preview**: Presigned URLs issued only after permission check (60s TTL)

### No Cross-User Leakage

- User A and User B asking the same question receive different answers based on their permissions
- Unauthorised text never enters the model prompt
- Verified by integration tests

---

## 📡 API Reference

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/auth/login` | `{email, password}` → JWT tokens |
| `POST` | `/api/v1/auth/refresh` | Rotate access token |
| `GET` | `/api/v1/auth/me` | Current user info |

### Documents

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/documents` | List user-accessible documents |
| `GET` | `/api/v1/documents/{id}` | Document metadata |
| `GET` | `/api/v1/documents/{id}/preview` | Secure preview (PNG or presigned URL) |
| `GET` | `/api/v1/documents/{id}/download` | Download original (presigned URL) |
| `POST` | `/api/v1/documents/upload` | Upload document (multipart) |
| `POST` | `/api/v1/documents/{id}/summary` | Generate/retrieve summary |

### Chat / RAG

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/chats` | Create conversation |
| `GET` | `/api/v1/chats` | List conversations |
| `GET` | `/api/v1/chats/{id}` | Get conversation + messages |
| `POST` | `/api/v1/chats/{id}/messages` | Send message → **SSE stream** |

### Search

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/search?q=...` | Hybrid search (vector + keyword + metadata) |

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/admin/users` | List all users |
| `POST` | `/api/v1/admin/users` | Create user |
| `POST` | `/api/v1/admin/permissions` | Grant/revoke permissions |
| `GET` | `/api/v1/admin/audit` | Audit logs |

---

## 💬 Chat SSE Streaming

`POST /api/v1/chats/{id}/messages` returns `text/event-stream`:

```json
{"type": "token", "delta": "The "}
{"type": "citation_start", "index": 3}
{"type": "token", "delta": "lease"}
{"type": "citation_end", "index": 3}
{"type": "token", "delta": " expires "}
{"type": "finish", "message_id": "...", "found": true}
```

Frontend accumulates tokens, renders citation chips, and populates the evidence panel on `finish`.

---

## 🧪 Demo Scenarios (Judging Requirements)

The platform must pass 5 live demos:

| # | Test | Implementation |
|---|------|----------------|
| 1 | **Lease expiry query** — "which lease agreements expire next year?" | Deterministic SQL on `expiry_date` + RAG citations |
| 2 | **Contract summary** — select contract, request summary | Map-reduce summarisation with page citations |
| 3 | **Citation click** → open original document | Secure presigned URL + permission re-check |
| 4 | **Two users, same question, different answers** | ACL-scoped retrieval prevents leakage |
| 5 | **Honest "not in archive"** | Score threshold + structured output guard |

---

## 🔧 Development

### Project Structure

```
ask-the-archive/
├── backend/
│   ├── app/
│   │   ├── core/           # config, deps, errors, logging
│   │   ├── db/             # models, session, repositories
│   │   ├── modules/        # feature modules (auth, chat, etc.)
│   │   ├── ports/          # protocols + AWS/local adapters
│   │   └── shared/         # schemas, utils, prompts
│   ├── alembic/            # DB migrations
│   ├── scripts/            # seed, validate_demo
│   └── pyproject.toml
├── frontend/
│   ├── src/
│   │   ├── app/            # Next.js App Router pages
│   │   ├── components/     # React components
│   │   ├── lib/            # API client, SSE, auth
│   │   └── styles/         # Tailwind + design tokens
│   └── package.json
├── docs/
│   └── superpowers/specs/  # Design specification
└── README.md
```

### Running Tests

```bash
# Backend tests
cd backend
pytest -v

# Frontend tests
cd frontend
npm test
```

### Code Quality

```bash
# Backend
cd backend
ruff check .
mypy .

# Frontend
cd frontend
npm run lint
```

---

## 📦 Deployment

### Backend (FastAPI)

- **Container**: `Dockerfile` builds on `python:3.12-slim`
- **Process**: `uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4`
- **No --reload** in production (multiprocessing issues with port binding)

### Frontend (Next.js)

- **Build**: `npm run build` → `.next/` output
- **Start**: `npm start` (production server on :3000)
- **Static export**: Available for CDN deployment

### Database

- **Managed**: Neon / Supabase (pgvector enabled)
- **Migrations**: `alembic upgrade head` on deploy
- **Connection pooling**: PgBouncer recommended

### AWS Services (Production)

| Service | Purpose |
|---------|---------|
| S3 + SSE-KMS | Document storage |
| Textract | OCR / structured extraction |
| Bedrock (Converse) | LLM generation |
| Bedrock (Titan V2) | Embeddings |
| IAM | Least-privilege roles per service |

---

## 🎨 Design System

| Token | Light | Dark |
|-------|-------|------|
| Charcoal | `#171A1D` | `#F5F5F0` |
| Concrete | `#F3F1EC` | `#1A1A1A` |
| Steel Grey | `#8A9095` | `#474A51` |
| Warm Copper | `#B9784B` | `#D4A853` |
| AWS Orange | `#FF9900` | `#FFB347` |

Fonts: **Inter** (UI), **JetBrains Mono** (code)

---

## 📚 Documentation

- **Design Specification**: `docs/superpowers/specs/2026-11-19-ask-the-archive-design.md` (840 lines)
- **API Schema**: `http://localhost:8000/openapi.json` (Swagger UI at `/docs`)
- **Architecture**: See [Architecture](#architecture) above

---

## 🛡️ Security Notes

- **Never commit `.env`** — contains AWS keys, DB passwords, JWT secrets
- **All AWS calls in backend** — frontend never sees credentials
- **Presigned URLs** — 60s TTL, permission-checked at generation
- **Argon2id** — password hashing (not bcrypt)
- **HS256 JWT** — short-lived access (30min) + rotating refresh (7d)

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with tests
4. Run linting and tests
5. Submit PR with description

---

## 📄 License

MIT License — see `LICENSE` file for details.

---

## 🙏 Acknowledgements

- **TDW × AWS Innovation Challenge** — for the challenge brief
- **AWS** — Bedrock, Textract, S3, Titan Embeddings
- **Open Source** — FastAPI, Next.js, pgvector, BGE-M3, pdfplumber, Argon2

---

*Generated with [Claude Code](https://claude.com/claude-code)*