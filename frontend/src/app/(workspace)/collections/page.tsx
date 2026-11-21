"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  FileText,
  Loader2,
  Search,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import type {
  Analytics,
  ArchiveDocument,
  ArchiveInsight,
  DocumentList,
  SearchResult,
} from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import { DocTypeChip, PageBody, PageHeader, StatusDot } from "@/components/ui";
import { EmptyState, ErrorState, LoadingPanel } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** The archive is browsed in pages of at most 200 documents. */
const PAGE_SIZE = 200;
const RECENT_WINDOW_DAYS = 30;
const EXPIRY_WINDOW_DAYS = 90;

type Selection =
  | { kind: "all" }
  | { kind: "type"; key: string }
  | { kind: "status"; key: string }
  | { kind: "recent" }
  | { kind: "expiring" }
  | { kind: "attention" };

interface CollectionResult {
  docs: ArchiveDocument[];
  /** The authoritative size of the collection, from the archive itself. */
  total: number;
  /** True when the list shown is a subset of `total`. */
  truncated: boolean;
}

function selectionId(selection: Selection): string {
  switch (selection.kind) {
    case "all":
      return "all";
    case "type":
      return `type:${selection.key}`;
    case "status":
      return `status:${selection.key}`;
    case "recent":
      return "recent";
    case "expiring":
      return "expiring";
    case "attention":
      return "attention";
  }
}

export default function CollectionsPage() {
  const { user } = useAuth();
  const toast = useToast();

  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [scope, setScope] = useState<DocumentList | null>(null);
  const [insights, setInsights] = useState<ArchiveInsight[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selection, setSelection] = useState<Selection>({ kind: "all" });
  const [result, setResult] = useState<CollectionResult | null>(null);
  const [resultLoading, setResultLoading] = useState(true);
  const [resultError, setResultError] = useState<string | null>(null);

  const [nameFilter, setNameFilter] = useState("");
  const [query, setQuery] = useState("");
  const [semantic, setSemantic] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [pane, setPane] = useState<"documents" | "matches">("documents");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [analyticsRes, scopeRes, insightRes] = await Promise.all([
        api.analytics(),
        api.documents({ limit: PAGE_SIZE }),
        // Insights are only meaningful for staff; a failure must not take the
        // rest of the page down with it.
        api.insights({ status: "open", limit: 200 }).catch(() => null),
      ]);
      setAnalytics(analyticsRes);
      setScope(scopeRes);
      setInsights(insightRes?.items ?? null);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not read the archive.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* ── Derived views over the archive ─────────────────────────────── */

  const recentDocs = useMemo(() => {
    const now = Date.now();
    const window = RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    return (scope?.items ?? []).filter((doc) => {
      if (!doc.indexed_at) return false;
      const time = new Date(doc.indexed_at).getTime();
      if (Number.isNaN(time)) return false;
      return time <= now && now - time <= window;
    });
  }, [scope]);

  const expiringDocs = useMemo(() => {
    const now = Date.now();
    const soon = now + EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    return (scope?.items ?? []).filter((doc) => {
      if (!doc.expiry_date) return false;
      const time = new Date(doc.expiry_date).getTime();
      if (Number.isNaN(time)) return false;
      return time >= now && time <= soon;
    });
  }, [scope]);

  const attentionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const insight of insights ?? []) {
      for (const id of insight.document_ids ?? []) ids.add(id);
    }
    return Array.from(ids);
  }, [insights]);

  const scopeIsPartial = scope ? scope.total > scope.items.length : false;

  /* ── Load the documents for the selected collection ─────────────── */

  const loadSelection = useCallback(
    async (target: Selection): Promise<CollectionResult> => {
      switch (target.kind) {
        case "all": {
          // The scope page read at load time is the same query, so it is
          // reused instead of asking the archive for it a second time.
          if (scope) {
            return {
              docs: scope.items,
              total: scope.total,
              truncated: scope.items.length < scope.total,
            };
          }
          const res = await api.documents({ limit: PAGE_SIZE });
          return {
            docs: res.items,
            total: res.total,
            truncated: res.items.length < res.total,
          };
        }
        case "type": {
          if (target.key === "unknown") {
            // Documents with no type cannot be selected server-side, so the
            // view is filtered from the page we have already read.
            const res = scope ?? (await api.documents({ limit: PAGE_SIZE }));
            const docs = res.items.filter((doc) => !doc.doc_type);
            const known =
              analytics?.documents_by_type.find(
                (entry) => entry.key === "unknown",
              )?.count ?? docs.length;
            return { docs, total: known, truncated: docs.length < known };
          }
          const res = await api.documents({
            doc_type: target.key,
            limit: PAGE_SIZE,
          });
          return {
            docs: res.items,
            total: res.total,
            truncated: res.items.length < res.total,
          };
        }
        case "status": {
          const res = await api.documents({
            status: target.key,
            limit: PAGE_SIZE,
          });
          return {
            docs: res.items,
            total: res.total,
            truncated: res.items.length < res.total,
          };
        }
        case "recent":
          return { docs: recentDocs, total: recentDocs.length, truncated: false };
        case "expiring":
          return {
            docs: expiringDocs,
            total: expiringDocs.length,
            truncated: false,
          };
        case "attention": {
          const docs = await Promise.all(
            attentionIds.map((id) => api.document(id).catch(() => null)),
          );
          const found = docs.filter(
            (doc): doc is ArchiveDocument => doc !== null,
          );
          return { docs: found, total: found.length, truncated: false };
        }
      }
    },
    [analytics, attentionIds, recentDocs, expiringDocs, scope],
  );

  useEffect(() => {
    // Wait for the archive read to land first: the lifecycle and attention
    // views are derived from it, and fetching before then would ask the
    // archive for the same page twice.
    if (loading) return;
    let cancelled = false;
    setResultLoading(true);
    setResultError(null);
    loadSelection(selection)
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setResult(null);
        setResultError(
          err instanceof Error
            ? err.message
            : "Could not read this collection.",
        );
      })
      .finally(() => {
        if (!cancelled) setResultLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selection, loadSelection, loading]);

  /* ── Semantic search ────────────────────────────────────────────── */

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    await doSearch(query);
  }

  const doSearch = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (q.length < 2) return;
      setSearching(true);
      setSearchError(null);
      try {
        const docType =
          selection.kind === "type" && selection.key !== "unknown"
            ? selection.key
            : null;
        setSemantic(await api.search(q, 20, docType));
        setPane("matches");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Search failed.";
        setSearchError(message);
        setSemantic(null);
        toast.error("Search failed", message);
      } finally {
        setSearching(false);
      }
    },
    [selection, toast],
  );

  /* ── Derived labels and counts ──────────────────────────────────── */

  const collectionTitle = useMemo(() => {
    switch (selection.kind) {
      case "all":
        return "All documents";
      case "type": {
        const entry = analytics?.documents_by_type.find(
          (item) => item.key === selection.key,
        );
        return entry?.label ?? selection.key;
      }
      case "status": {
        const entry = analytics?.documents_by_status.find(
          (item) => item.key === selection.key,
        );
        return entry?.label ?? selection.key;
      }
      case "recent":
        return `Indexed in the last ${RECENT_WINDOW_DAYS} days`;
      case "expiring":
        return `Expiring within ${EXPIRY_WINDOW_DAYS} days`;
      case "attention":
        return "Needs attention";
    }
  }, [selection, analytics]);

  const collectionNote = useMemo(() => {
    switch (selection.kind) {
      case "all":
        return "Every document your account is permitted to read.";
      case "type":
        return "Documents the archive has classified as this type.";
      case "status":
        return "Documents currently in this ingestion state.";
      case "recent":
        return `Indexed in the last ${RECENT_WINDOW_DAYS} days.`;
      case "expiring":
        return `Carrying an expiry date within the next ${EXPIRY_WINDOW_DAYS} days.`;
      case "attention":
        return "Documents named by an open archive insight.";
    }
  }, [selection]);

  const filteredDocs = useMemo(() => {
    const docs = result?.docs ?? [];
    const needle = nameFilter.trim().toLowerCase();
    if (!needle) return docs;
    return docs.filter(
      (doc) =>
        doc.filename.toLowerCase().includes(needle) ||
        (doc.title ?? "").toLowerCase().includes(needle),
    );
  }, [result, nameFilter]);

  const byType = analytics?.documents_by_type ?? [];
  const byStatus = analytics?.documents_by_status ?? [];

  return (
    <PageBody>
      <PageHeader
        eyebrow="Knowledge"
        title="Smart Collections"
        description={`Live views over the archive, derived from what the archive itself reports. Every count below comes from the API — nothing here is estimated. The views reflect the documents a ${user?.role ?? "signed-in"} account can read.`}
      />

      {error && (
        <ErrorState
          className="mt-6"
          title="The archive could not be read"
          message={error}
          onRetry={load}
        />
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* ── Collection list ───────────────────────────────────────── */}
        <aside className="panel flex flex-col overflow-hidden shadow-panel lg:max-h-[calc(100vh-13rem)]">
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-4">
                <LoadingPanel label="Reading the archive…" rows={5} />
              </div>
            ) : (
              <>
                <CollectionGroup label="Archive">
                  <CollectionRow
                    label="All documents"
                    count={analytics?.overview.documents_total ?? null}
                    active={selection.kind === "all"}
                    onSelect={() => setSelection({ kind: "all" })}
                  />
                </CollectionGroup>

                <CollectionGroup label="By document type">
                  {byType.length === 0 ? (
                    <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
                      The archive has not classified any documents yet.
                    </p>
                  ) : (
                    byType.map((entry) => (
                      <CollectionRow
                        key={entry.key}
                        label={entry.label}
                        count={entry.count}
                        active={
                          selection.kind === "type" && selection.key === entry.key
                        }
                        onSelect={() =>
                          setSelection({ kind: "type", key: entry.key })
                        }
                      />
                    ))
                  )}
                </CollectionGroup>

                <CollectionGroup label="By status">
                  {byStatus.length === 0 ? (
                    <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
                      No ingestion states to show.
                    </p>
                  ) : (
                    byStatus.map((entry) => (
                      <CollectionRow
                        key={entry.key}
                        label={entry.label}
                        count={entry.count}
                        active={
                          selection.kind === "status" &&
                          selection.key === entry.key
                        }
                        onSelect={() =>
                          setSelection({ kind: "status", key: entry.key })
                        }
                      />
                    ))
                  )}
                </CollectionGroup>

                <CollectionGroup label="Lifecycle">
                  <CollectionRow
                    label={`Indexed in the last ${RECENT_WINDOW_DAYS} days`}
                    count={loading ? null : recentDocs.length}
                    active={selection.kind === "recent"}
                    onSelect={() => setSelection({ kind: "recent" })}
                    icon={<CalendarClock className="h-3 w-3" />}
                  />
                  <CollectionRow
                    label={`Expiring within ${EXPIRY_WINDOW_DAYS} days`}
                    count={loading ? null : expiringDocs.length}
                    active={selection.kind === "expiring"}
                    onSelect={() => setSelection({ kind: "expiring" })}
                    icon={<AlertTriangle className="h-3 w-3" />}
                  />
                </CollectionGroup>

                <CollectionGroup label="Attention">
                  <CollectionRow
                    label="Needs attention"
                    count={
                      loading ? null : insights === null ? null : attentionIds.length
                    }
                    active={selection.kind === "attention"}
                    onSelect={() => setSelection({ kind: "attention" })}
                    icon={<TriangleAlert className="h-3 w-3" />}
                  />
                </CollectionGroup>

                {scopeIsPartial && (
                  <p className="border-t border-border px-4 py-3 text-[10px] leading-relaxed text-muted-foreground">
                    Lifecycle counts are computed across the {scope?.items.length}{" "}
                    most recent documents in your scope
                    {scope ? `, out of ${scope.total}` : ""}.
                  </p>
                )}
              </>
            )}
          </div>
        </aside>

        {/* ── Documents ─────────────────────────────────────────────── */}
        <section className="panel flex flex-col overflow-hidden shadow-panel lg:max-h-[calc(100vh-13rem)]">
          <header className="border-b border-border px-4 py-3.5 sm:px-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="label">Collection</p>
                <h2 className="mt-1 text-[15px] font-semibold tracking-tight">
                  {collectionTitle}
                </h2>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  {collectionNote}
                </p>
              </div>
              <p className="shrink-0 font-mono text-[12px] text-muted-foreground">
                {resultLoading
                  ? "—"
                  : `${result?.total ?? 0} document${
                      (result?.total ?? 0) === 1 ? "" : "s"
                    }`}
              </p>
            </div>

            <form onSubmit={runSearch} className="mt-3 flex gap-2">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search the archive for passages about…"
                aria-label="Search the archive for passages"
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
          </header>

          <Tabs
            value={pane}
            onValueChange={(value) => setPane(value as "documents" | "matches")}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="px-4 pt-3 sm:px-5">
              <TabsList className="flex-wrap">
                <TabsTrigger value="documents">
                  Documents
                  {result && !resultLoading ? ` (${result.docs.length})` : ""}
                </TabsTrigger>
                <TabsTrigger value="matches">
                  Semantic matches
                  {semantic ? ` (${semantic.count})` : ""}
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="documents" className="mt-0 min-h-0 flex-1">
              <div className="px-4 pt-3 sm:px-5">
                <Label htmlFor="collection-filter">Filter by name</Label>
                <Input
                  id="collection-filter"
                  value={nameFilter}
                  onChange={(event) => setNameFilter(event.target.value)}
                  placeholder="e.g. lease"
                  className="mt-1.5"
                />
                {nameFilter.trim() && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Showing {filteredDocs.length} of {result?.docs.length ?? 0}{" "}
                    loaded document{(result?.docs.length ?? 0) === 1 ? "" : "s"}.
                  </p>
                )}
              </div>

              {resultLoading ? (
                <div className="p-4 sm:p-5">
                  <LoadingPanel label="Loading documents…" rows={5} />
                </div>
              ) : resultError ? (
                <div className="p-4 sm:p-5">
                  <ErrorState
                    message={resultError}
                    onRetry={() => setSelection({ ...selection })}
                  />
                </div>
              ) : filteredDocs.length === 0 ? (
                <div className="p-4 sm:p-5">
                  <EmptyState
                    className="border-0"
                    icon={
                      nameFilter.trim() ? (
                        <Search className="h-4 w-4" />
                      ) : (
                        <FileText className="h-4 w-4" />
                      )
                    }
                    title={
                      nameFilter.trim()
                        ? "No document in this collection matches that name"
                        : "This collection is empty"
                    }
                    description={
                      nameFilter.trim()
                        ? "Clear the filter to see every document in this collection."
                        : "Nothing in the archive falls into this view for your account yet. It will fill as documents are ingested and classified."
                    }
                  />
                </div>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Document</th>
                        <th>Type</th>
                        <th>Expiry</th>
                        <th>Indexed</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredDocs.map((doc) => (
                        <tr key={doc.id}>
                          <td className="max-w-[280px]">
                            <Link
                              href={`/library/${doc.id}`}
                              className="block truncate text-[13px] font-medium transition-colors hover:text-accent"
                            >
                              {doc.title || doc.filename}
                            </Link>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {doc.filename}
                            </p>
                          </td>
                          <td>
                            <DocTypeChip type={doc.doc_type} />
                          </td>
                          <td className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                            {doc.expiry_date ? formatDate(doc.expiry_date) : "—"}
                          </td>
                          <td className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                            {doc.indexed_at ? formatDate(doc.indexed_at) : "—"}
                          </td>
                          <td>
                            <StatusDot status={doc.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {result?.truncated && (
                <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
                  Showing {result.docs.length} of {result.total} documents in
                  this collection.
                </p>
              )}
            </TabsContent>

            <TabsContent value="matches" className="mt-0 min-h-0 flex-1">
              {searching ? (
                <div className="p-4 sm:p-5">
                  <LoadingPanel label="Searching the archive…" rows={4} />
                </div>
              ) : searchError ? (
                <div className="p-4 sm:p-5">
                  <ErrorState message={searchError} onRetry={() => doSearch(query)} />
                </div>
              ) : !semantic ? (
                <div className="p-4 sm:p-5">
                  <EmptyState
                    className="border-0"
                    icon={<Search className="h-4 w-4" />}
                    title="No search run yet"
                    description="Search the archive above for the passages behind these documents. The search covers everything your account can read."
                  />
                </div>
              ) : semantic.hits.length === 0 ? (
                <div className="p-4 sm:p-5">
                  <EmptyState
                    className="border-0"
                    icon={<Search className="h-4 w-4" />}
                    title="No passages matched"
                    description={`Nothing in your permitted scope matched “${semantic.query}”.`}
                  />
                </div>
              ) : (
                <ul className="space-y-2 p-4 sm:p-5">
                  {semantic.hits.map((hit) => (
                    <li key={hit.chunk_id}>
                      <Link
                        href={`/library/${hit.document_id}?page=${hit.page_start}`}
                        className="block rounded-md border border-border bg-background p-3 transition-colors hover:border-accent/50 hover:bg-accent/[0.03]"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate text-[12px] font-semibold">
                            {hit.filename}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                            p.{hit.page_start}–{hit.page_end} ·{" "}
                            {hit.score.toFixed(3)}
                          </span>
                        </div>
                        {hit.doc_type && (
                          <div className="mt-1.5">
                            <DocTypeChip type={hit.doc_type} />
                          </div>
                        )}
                        <p className="mt-1.5 line-clamp-3 text-[12px] leading-relaxed text-muted-foreground">
                          {hit.excerpt}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
          </Tabs>

          {/* The open insights behind the "needs attention" collection. */}
          {selection.kind === "attention" && insights && insights.length > 0 && (
            <div className="border-t border-border px-4 py-3.5 sm:px-5">
              <p className="label">Open insights behind this collection</p>
              <ul className="mt-2 space-y-1.5">
                {insights.map((insight) => (
                  <li
                    key={insight.id ?? `${insight.kind}-${insight.title}`}
                    className="flex items-start gap-2.5 rounded-md border border-border bg-background px-3 py-2"
                  >
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-medium">
                        {insight.title}
                      </span>
                      {insight.detail && (
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                          {insight.detail}
                        </span>
                      )}
                      <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                        {insight.kind} · {insight.severity} ·{" "}
                        {insight.document_ids.length} document
                        {insight.document_ids.length === 1 ? "" : "s"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </PageBody>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

function CollectionGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border last:border-b-0">
      <p className="label px-4 py-2.5">{label}</p>
      {children}
    </div>
  );
}

function CollectionRow({
  label,
  count,
  active,
  onSelect,
  icon,
}: {
  label: string;
  count: number | null;
  active: boolean;
  onSelect: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 px-4 py-2 text-left text-[12px] transition-colors hover:bg-muted/50",
        active && "bg-accent/[0.07] font-medium text-accent",
      )}
    >
      {icon && (
        <span className="shrink-0 text-muted-foreground">{icon}</span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {count === null ? "—" : count}
      </span>
    </button>
  );
}
