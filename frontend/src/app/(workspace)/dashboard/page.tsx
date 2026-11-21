"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  FileText,
  Loader2,
  Search,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import type { Analytics, DocumentList, SearchResult } from "@/lib/types";
import {
  DocTypeChip,
  PageBody,
  PageHeader,
  StatusDot,
} from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  LoadingPanel,
  StatCard,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBytes, formatDate } from "@/lib/utils";

const SUGGESTIONS = [
  "Which lease agreements expire next year?",
  "Summarise the Kestrel facilities contract.",
  "What is our data retention period?",
  "Who are the parties to the Harbour Street lease?",
];

interface Health {
  status?: string;
  providers?: Record<string, string>;
  [k: string]: unknown;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const toast = useToast();

  const [docs, setDocs] = useState<DocumentList | null>(null);
  const [stats, setStats] = useState<Analytics | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [documents, analytics, serviceHealth] = await Promise.all([
        api.documents({ limit: 8 }),
        api.analytics(),
        api.health().catch(() => null),
      ]);
      setDocs(documents);
      setStats(analytics);
      setHealth(serviceHealth);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load the workspace.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    setError(null);
    try {
      setHits(await api.search(q, 8));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Search failed.";
      setError(message);
      setHits(null);
      toast.error("Search failed", message);
    } finally {
      setSearching(false);
    }
  }

  const overview = stats?.overview;
  const items = docs?.items ?? [];
  const firstName = user?.display_name?.split(" ")[0] ?? "there";
  const openInsights = stats ? undefined : undefined;

  return (
    <PageBody>
      <PageHeader
        eyebrow="Overview"
        title={`Good to see you, ${firstName}`}
        description="Everything below is scoped to the documents your account is permitted to read. Retrieval filters on that permission boundary before any passage reaches the model."
      />

      {error && (
        <ErrorState
          className="mt-6"
          message={error}
          onRetry={load}
        />
      )}

      {/* Real counts, from the archive itself. */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Documents in scope"
          value={loading ? null : (overview?.documents_total ?? 0)}
          hint={
            loading
              ? "Reading the archive…"
              : `${overview?.documents_indexed ?? 0} indexed and searchable`
          }
        />
        <StatCard
          label="Pages extracted"
          value={loading ? null : (overview?.page_count ?? 0)}
          hint={`${overview?.chunk_count ?? 0} searchable passages`}
        />
        <StatCard
          label="Questions answered"
          value={loading ? null : (overview?.answers_found ?? 0)}
          hint={
            overview
              ? `${overview.abstentions} honest abstentions`
              : "From your conversations"
          }
          tone="accent"
        />
        <StatCard
          label="Archive size"
          value={loading ? null : formatBytes(overview?.storage_bytes ?? 0)}
          hint={`${overview?.citation_count ?? 0} citations recorded`}
        />
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1.35fr_1fr]">
        {/* Ask / search */}
        <section className="panel p-5 shadow-panel">
          <div className="flex items-center justify-between gap-3">
            <p className="label">Search the archive</p>
            <Link
              href="/ask"
              className="flex items-center gap-1 text-[12px] font-medium text-accent transition-colors hover:underline"
            >
              Open the workspace
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>

          <form onSubmit={runSearch} className="mt-3 flex gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Semantic search across permitted documents…"
              aria-label="Search the archive"
              className="flex-1"
            />
            <Button type="submit" disabled={searching || query.trim().length < 2}>
              {searching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              Search
            </Button>
          </form>

          {hits && (
            <div className="mt-4 space-y-2">
              <p className="label">
                {hits.count} result{hits.count === 1 ? "" : "s"} for “{hits.query}”
              </p>
              {hits.hits.map((hit) => (
                <Link
                  key={hit.chunk_id}
                  href={`/library/${hit.document_id}`}
                  className="block rounded-md border border-border bg-background p-3 transition-colors hover:border-accent/50 hover:bg-accent/[0.03]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-[12px] font-semibold">
                      {hit.filename}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      p.{hit.page_start}–{hit.page_end} · {hit.score.toFixed(3)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
                    {hit.excerpt}
                  </p>
                </Link>
              ))}
              {hits.count === 0 && (
                <p className="text-[12px] text-muted-foreground">
                  Nothing in your permitted scope matched that query.
                </p>
              )}
            </div>
          )}

          {!hits && (
            <div className="mt-4 flex flex-wrap gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <Link
                  key={suggestion}
                  href={`/ask?q=${encodeURIComponent(suggestion)}`}
                  className="chip bg-muted text-muted-foreground transition-colors hover:bg-accent/12 hover:text-accent"
                >
                  <Sparkles className="h-3 w-3" />
                  {suggestion}
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Service status + archive composition */}
        <div className="space-y-5">
          <section className="panel p-5 shadow-panel">
            <p className="label">Local stack</p>
            <dl className="mt-3 space-y-2.5">
              {[
                ["Answering model", health?.providers?.llm],
                ["Embeddings", health?.providers?.embedder],
                ["Extraction", health?.providers?.extractor],
                ["Storage", health?.providers?.storage],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-[12px] text-muted-foreground">{label}</dt>
                  <dd className="truncate font-mono text-[11px]">{value ?? "—"}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
              Inference, embeddings, extraction and storage all run on this
              machine. Nothing is sent to a hosted model provider.
            </p>
          </section>

          <section className="panel p-5 shadow-panel">
            <p className="label">Archive composition</p>
            {loading ? (
              <div className="mt-3 space-y-2">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="skeleton h-6 rounded" />
                ))}
              </div>
            ) : stats?.documents_by_type?.length ? (
              <ul className="mt-3 space-y-2">
                {stats.documents_by_type.map((entry) => (
                  <li key={entry.key} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 truncate text-[12px] capitalize">
                      {entry.label}
                    </span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-accent"
                        style={{
                          width: `${Math.min(
                            100,
                            (entry.count /
                              Math.max(
                                1,
                                ...stats.documents_by_type.map((e) => e.count),
                              )) *
                              100,
                          )}%`,
                        }}
                      />
                    </span>
                    <span className="w-7 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                      {entry.count}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[12px] text-muted-foreground">
                No documents are visible to your account yet.
              </p>
            )}
          </section>
        </div>
      </div>

      {/* Recently indexed */}
      <section className="mt-8">
        <div className="flex items-end justify-between">
          <p className="label">Recently indexed</p>
          <Link
            href="/library"
            className="text-[12px] font-medium text-accent transition-colors hover:underline"
          >
            View all →
          </Link>
        </div>

        <div className="mt-2.5 overflow-hidden rounded-lg border border-border bg-surface">
          {loading ? (
            <div className="p-4">
              <LoadingPanel label="Reading the library…" rows={4} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              className="m-4 border-0"
              icon={<FileText className="h-4 w-4" />}
              title="No documents are visible to your account"
              description="Once documents are ingested and your permissions are set, they will appear here."
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Type</th>
                  <th>Expiry</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((doc) => (
                  <tr key={doc.id}>
                    <td>
                      <Link
                        href={`/library/${doc.id}`}
                        className="text-[13px] font-medium transition-colors hover:text-accent"
                      >
                        {doc.title || doc.filename}
                      </Link>
                      <p className="text-[11px] text-muted-foreground">
                        {doc.filename}
                      </p>
                    </td>
                    <td>
                      <DocTypeChip type={doc.doc_type} />
                    </td>
                    <td className="font-mono text-[11px] text-muted-foreground">
                      {doc.expiry_date ? formatDate(doc.expiry_date) : "—"}
                    </td>
                    <td>
                      <StatusDot status={doc.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {openInsights && (
        <p className="mt-6 flex items-center gap-2 text-[12px] text-muted-foreground">
          <TriangleAlert className="h-3.5 w-3.5" />
          {openInsights}
        </p>
      )}
    </PageBody>
  );
}
