"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowLeftRight,
  Check,
  ChevronsUpDown,
  Columns2,
  FileText,
  Loader2,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import type {
  ArchiveDocument,
  ComparisonCitation,
  ComparisonFinding,
  ComparisonFindingKind,
  ComparisonListOut,
  DocumentComparison,
  DocumentList,
  Severity,
} from "@/lib/types";
import { cn, formatDate, formatRelative } from "@/lib/utils";
import { PageBody, PageHeader, StatusDot } from "@/components/ui";
import {
  CountPills,
  EmptyState,
  ErrorState,
  LoadingPanel,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/overlays";
import { Separator } from "@/components/ui/primitives";

/* ------------------------------------------------------------------ labels */

const KIND_LABEL: Record<string, string> = {
  added: "Added in B",
  removed: "Removed from A",
  modified: "Modified clause",
  changed_date: "Changed date",
  changed_value: "Changed value",
  different_obligation: "Different obligation",
  inconsistency: "Inconsistency",
};

const SEVERITY_TONE: Record<string, string> = {
  info: "bg-muted text-muted-foreground",
  low: "bg-success/12 text-success",
  medium: "bg-warning/12 text-warning",
  high: "bg-danger/12 text-danger",
};

const SEVERITY_RULE: Record<string, string> = {
  info: "bg-muted-foreground",
  low: "bg-success",
  medium: "bg-warning",
  high: "bg-danger",
};

/** Documents must be indexed before the model can read them. */
function isIndexed(status: string): boolean {
  const key = status?.toLowerCase() ?? "";
  return ["ready", "indexed", "complete", "completed"].includes(key);
}

/* ------------------------------------------------------------------- page */

export default function ComparePage() {
  const { user } = useAuth();
  const toast = useToast();

  /* -- new comparison -- */
  const [docA, setDocA] = useState<ArchiveDocument | null>(null);
  const [docB, setDocB] = useState<ArchiveDocument | null>(null);
  const [instruction, setInstruction] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DocumentComparison | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  /* -- previous comparisons -- */
  const [list, setList] = useState<ComparisonListOut | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openLoading, setOpenLoading] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opened, setOpened] = useState<DocumentComparison | null>(null);

  const canCompare = user?.role === "admin" || user?.role === "analyst";

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      setList(await api.comparisons(25, 0));
    } catch (err) {
      setListError(
        err instanceof Error
          ? err.message
          : "Could not load your previous comparisons.",
      );
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  async function runComparison() {
    if (!docA || !docB || running) return;
    const focus = instruction.trim();
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      const comparison = await api.compare({
        document_a_id: docA.id,
        document_b_id: docB.id,
        instruction: focus ? focus : null,
      });
      setResult(comparison);
      if (comparison.status === "failed") {
        const message =
          comparison.error ?? "The comparison could not be completed.";
        setRunError(message);
        toast.error("The comparison failed", message);
      } else {
        toast.success(
          "Comparison complete",
          `${comparison.findings.length} verified finding${
            comparison.findings.length === 1 ? "" : "s"
          }.`,
        );
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "The comparison could not be run.";
      setRunError(message);
      toast.error("The comparison failed", message);
    } finally {
      setRunning(false);
    }
  }

  async function openComparison(id: string) {
    setOpenId(id);
    setOpenLoading(true);
    setOpenError(null);
    setOpened(null);
    try {
      setOpened(await api.comparison(id));
    } catch (err) {
      setOpenError(
        err instanceof Error
          ? err.message
          : "Could not open that comparison.",
      );
    } finally {
      setOpenLoading(false);
    }
  }

  const readyToRun = Boolean(docA && docB && docA.id !== docB.id && !running);

  return (
    <PageBody>
      <PageHeader
        eyebrow="Knowledge"
        title="Document Comparison"
        description="Two documents are read side by side and the differences between them are reported. Every reported difference must cite a passage that the backend then re-checks against the source PDF — anything it cannot confirm is discarded, so a finding here always comes with readable proof."
      />

      <Tabs defaultValue="new" className="mt-6">
        <TabsList>
          <TabsTrigger value="new">
            <Sparkles className="h-3.5 w-3.5" />
            New comparison
          </TabsTrigger>
          <TabsTrigger value="previous">
            <Columns2 className="h-3.5 w-3.5" />
            Previous
          </TabsTrigger>
        </TabsList>

        {/* ------------------------------------------------------- new ---- */}
        <TabsContent value="new">
          {!canCompare ? (
            <div className="panel p-6 shadow-panel">
              <EmptyState
                className="border-0"
                icon={<ShieldAlert className="h-4 w-4" />}
                title="Your role cannot run comparisons"
                description="Document Comparison requires the analyst or admin role on the backend. You are signed in as a viewer, so the archive will not run a comparison on your behalf. Comparisons you are permitted to read are still listed under Previous."
              />
            </div>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
              {/* Form */}
              <section className="panel p-5 shadow-panel lg:sticky lg:top-20 lg:self-start">
                <p className="label">Comparison setup</p>

                <div className="mt-3 space-y-3.5">
                  <DocumentPicker
                    id="compare-doc-a"
                    label="Document A"
                    selected={docA}
                    onSelect={setDocA}
                    disabledId={docB?.id ?? null}
                    disabled={running}
                  />
                  <DocumentPicker
                    id="compare-doc-b"
                    label="Document B"
                    selected={docB}
                    onSelect={setDocB}
                    disabledId={docA?.id ?? null}
                    disabled={running}
                  />

                  {docA && docB && (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={running}
                      onClick={() => {
                        setDocA(docB);
                        setDocB(docA);
                      }}
                    >
                      <ArrowLeftRight className="h-3 w-3" />
                      Swap A and B
                    </Button>
                  )}

                  <div>
                    <label
                      htmlFor="compare-instruction"
                      className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
                    >
                      Focus instruction (optional)
                    </label>
                    <Textarea
                      id="compare-instruction"
                      value={instruction}
                      disabled={running}
                      onChange={(event) => setInstruction(event.target.value)}
                      rows={3}
                      placeholder="Focus on termination clauses and notice periods…"
                    />
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      Leave this blank to compare clauses, dates, values,
                      obligations and inconsistencies across the whole document.
                    </p>
                  </div>
                </div>

                <Separator className="my-4" />

                <Button
                  variant="accent"
                  className="w-full"
                  disabled={!readyToRun}
                  onClick={runComparison}
                >
                  {running ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Comparing…
                    </>
                  ) : (
                    <>
                      <Columns2 className="h-4 w-4" />
                      Run comparison
                    </>
                  )}
                </Button>

                {!docA || !docB ? (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Choose two different documents to compare.
                  </p>
                ) : docA.id === docB.id ? (
                  <p className="mt-2 text-[11px] text-warning">
                    The backend refuses to compare a document with itself.
                  </p>
                ) : null}

                {running && (
                  <div
                    className="mt-4 rounded-md border border-accent/30 bg-accent/[0.06] px-3.5 py-3"
                    role="status"
                    aria-live="polite"
                  >
                    <p className="flex items-center gap-1.5 text-[12px] font-medium text-accent">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Reading both documents
                    </p>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                      The model runs locally on CPU, so a comparison takes a
                      while. The backend then re-checks every citation against
                      the source PDFs before showing it.
                    </p>
                  </div>
                )}
              </section>

              {/* Results */}
              <section className="min-w-0">
                {runError && (
                  <ErrorState
                    className="mb-4"
                    title="The comparison did not complete"
                    message={runError}
                    onRetry={readyToRun ? runComparison : undefined}
                  />
                )}

                {!result && !runError && !running && (
                  <div className="panel p-6 shadow-panel">
                    <EmptyState
                      className="border-0"
                      icon={<Columns2 className="h-4 w-4" />}
                      title="No comparison running yet"
                      description="Pick two documents on the left, optionally narrow the comparison with a focus instruction, then run it. The differences come back with the passage that proves each one."
                    />
                  </div>
                )}

                {result && (
                  <FindingsPanel comparison={result} />
                )}
              </section>
            </div>
          )}
        </TabsContent>

        {/* -------------------------------------------------- previous ---- */}
        <TabsContent value="previous">
          {openId ? (
            <div className="space-y-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpenId(null);
                  setOpened(null);
                  setOpenError(null);
                }}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                All comparisons
              </Button>

              {openLoading && (
                <div className="panel p-5 shadow-panel">
                  <LoadingPanel label="Opening the comparison…" rows={4} />
                </div>
              )}

              {openError && (
                <ErrorState
                  message={openError}
                  onRetry={() => openComparison(openId)}
                />
              )}

              {opened && <FindingsPanel comparison={opened} />}
            </div>
          ) : (
            <section className="panel overflow-hidden shadow-panel">
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <p className="label">Previous comparisons</p>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={loadList}
                  disabled={listLoading}
                >
                  {listLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Columns2 className="h-3 w-3" />
                  )}
                  Refresh
                </Button>
              </div>

              {listError ? (
                <div className="p-4">
                  <ErrorState message={listError} onRetry={loadList} />
                </div>
              ) : listLoading ? (
                <div className="p-4">
                  <LoadingPanel label="Loading comparisons…" rows={4} />
                </div>
              ) : (list?.items.length ?? 0) === 0 ? (
                <EmptyState
                  className="m-4 border-0"
                  icon={<Columns2 className="h-4 w-4" />}
                  title="No comparisons yet"
                  description="Comparisons are saved as they run, so you can reopen one later and read the verified findings again."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {list?.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => openComparison(item.id)}
                        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent/12 text-accent">
                          <Columns2 className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="truncate text-[13px] font-semibold">
                              {item.filename_a ?? "Unknown document"}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              vs
                            </span>
                            <span className="truncate text-[13px] font-semibold">
                              {item.filename_b ?? "Unknown document"}
                            </span>
                          </span>
                          {item.summary && (
                            <span className="mt-0.5 block line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                              {item.summary}
                            </span>
                          )}
                          <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                            <StatusDot status={item.status} />
                            <span className="font-mono">
                              {item.finding_count} finding
                              {item.finding_count === 1 ? "" : "s"}
                            </span>
                            <span title={formatDate(item.created_at)}>
                              {formatRelative(item.created_at)}
                            </span>
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </TabsContent>
      </Tabs>
    </PageBody>
  );
}

/* ------------------------------------------------------------- findings */

function FindingsPanel({ comparison }: { comparison: DocumentComparison }) {
  const findings = comparison.findings;
  const failed = comparison.status === "failed";
  const pending = !failed && comparison.status !== "completed";

  const severityCounts = useMemo(() => {
    const counts: Record<Severity, number> = {
      info: 0,
      low: 0,
      medium: 0,
      high: 0,
    };
    for (const finding of findings) {
      const key = finding.severity ?? "info";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [findings]);

  return (
    <div className="space-y-4">
      <div className="panel p-5 shadow-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="label">Result</p>
            <p className="mt-1.5 text-[14px] font-semibold leading-snug tracking-tight">
              {comparison.filename_a ?? "Document A"} vs{" "}
              {comparison.filename_b ?? "Document B"}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
              <StatusDot status={comparison.status} />
              {comparison.model && (
                <span className="font-mono">model:{comparison.model}</span>
              )}
              {comparison.completed_at && (
                <span title={formatDate(comparison.completed_at)}>
                  {formatRelative(comparison.completed_at)}
                </span>
              )}
            </p>
          </div>
          {findings.length > 0 && (
            <CountPills
              items={[
                { label: "high", value: severityCounts.high, tone: "text-danger" },
                { label: "medium", value: severityCounts.medium, tone: "text-warning" },
                { label: "low", value: severityCounts.low, tone: "text-success" },
                { label: "info", value: severityCounts.info },
              ]}
            />
          )}
        </div>

        {comparison.summary && !failed && (
          <p className="mt-3 border-t border-border pt-3 text-[13px] leading-relaxed text-foreground/85">
            {comparison.summary}
          </p>
        )}
      </div>

      {failed && (
        <ErrorState
          title="The comparison failed"
          message={
            comparison.error ??
            "The backend recorded a failure for this comparison without a reason."
          }
        />
      )}

      {pending && (
        <div className="panel p-5 shadow-panel">
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            This comparison is still {comparison.status}.
          </p>
        </div>
      )}

      {!failed && !pending && findings.length === 0 && (
        <div className="panel p-6 shadow-panel">
          <EmptyState
            className="border-0"
            icon={<ShieldCheck className="h-4 w-4" />}
            title="No differences the backend could verify"
            description="The comparison completed, but every difference the model reported was discarded because its citation could not be confirmed against the source PDFs. That is not proof the two documents are identical — only that no difference survived verification."
          />
        </div>
      )}

      {!failed && !pending && findings.length > 0 && (
        <div className="panel p-4 shadow-panel sm:p-5">
          <div className="grid gap-2 md:grid-cols-2">
            <p className="label truncate">
              A · {comparison.filename_a ?? "Document A"}
            </p>
            <p className="label truncate">
              B · {comparison.filename_b ?? "Document B"}
            </p>
          </div>

          <ol className="mt-3 space-y-3">
            {findings.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                filenameA={comparison.filename_a}
                filenameB={comparison.filename_b}
              />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function FindingCard({
  finding,
  filenameA,
  filenameB,
}: {
  finding: ComparisonFinding;
  filenameA: string | null;
  filenameB: string | null;
}) {
  const severity = finding.severity ?? "info";
  const kind = (finding.kind ?? "modified") as ComparisonFindingKind;

  return (
    <li className="rounded-lg border border-border bg-background p-3.5 sm:p-4">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-1 h-8 w-[3px] shrink-0 rounded-full",
            SEVERITY_RULE[severity] ?? SEVERITY_RULE.info,
          )}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">
              {KIND_LABEL[kind] ?? kind.replace(/_/g, " ")}
            </Badge>
            <span
              className={cn(
                "chip",
                SEVERITY_TONE[severity] ?? SEVERITY_TONE.info,
              )}
            >
              {severity}
            </span>
            {finding.category && (
              <span className="chip bg-muted text-muted-foreground">
                {finding.category}
              </span>
            )}
          </div>

          <h3 className="mt-2 text-[14px] font-semibold leading-snug tracking-tight">
            {finding.title}
          </h3>

          {finding.detail && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
              {finding.detail}
            </p>
          )}

          <div className="mt-3 grid gap-2.5 md:grid-cols-2">
            <CitationSide
              citation={finding.citation_a}
              side="A"
              fallbackFilename={filenameA}
            />
            <CitationSide
              citation={finding.citation_b}
              side="B"
              fallbackFilename={filenameB}
            />
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * One side of a finding.
 *
 * A one-sided finding — a clause that exists in only one document — has a
 * null citation on the other side. That absence is information, so it is
 * stated rather than left blank.
 */
function CitationSide({
  citation,
  side,
  fallbackFilename,
}: {
  citation: ComparisonCitation | null;
  side: "A" | "B";
  fallbackFilename: string | null;
}) {
  if (!citation) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2.5">
        <p className="label">Not present in document {side}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          This side carries no verified citation: the difference exists only on
          the other side, or this side’s evidence could not be confirmed
          against the source PDF.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <span className="mt-px grid h-4 w-4 shrink-0 place-items-center rounded bg-accent/12 font-mono text-[9px] font-bold text-accent">
          {side}
        </span>
        <Link
          href={`/library/${citation.document_id}`}
          className="min-w-0 flex-1 truncate text-[11px] font-semibold transition-colors hover:text-accent"
        >
          {citation.filename || fallbackFilename || "Document"}
        </Link>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {citation.page !== null && citation.page !== undefined
            ? `p.${citation.page}`
            : "page unknown"}
        </span>
      </div>
      {citation.excerpt ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          “{citation.excerpt}”
        </p>
      ) : (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          No excerpt was recorded for this citation.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------- doc picker */

function DocumentPicker({
  id,
  label,
  selected,
  onSelect,
  disabledId,
  disabled,
}: {
  id: string;
  label: string;
  selected: ArchiveDocument | null;
  onSelect: (doc: ArchiveDocument | null) => void;
  disabledId?: string | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [docs, setDocs] = useState<DocumentList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .documents({ search: debounced || undefined, limit: 20 })
      .then((response) => {
        if (!cancelled) setDocs(response);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not search the document library.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debounced]);

  const items = docs?.items ?? [];

  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
      >
        {label}
      </label>

      <Popover open={open} onOpenChange={setOpen}>
        <div className="relative">
          <PopoverTrigger asChild>
            <button
              id={id}
              type="button"
              disabled={disabled}
              className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-surface px-3 py-1 text-left text-[13px] shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  !selected && "text-muted-foreground",
                )}
              >
                {selected
                  ? selected.title || selected.filename
                  : "Search for a document…"}
              </span>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          </PopoverTrigger>

          {selected && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSelect(null)}
              aria-label={`Clear ${label}`}
              className="absolute right-7 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <PopoverContent
          align="start"
          className="w-[340px] max-w-[calc(100vw-2rem)] p-0"
        >
          <div className="border-b border-border p-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by filename or title…"
                aria-label={`Search documents for ${label}`}
                className="h-8 pl-8 text-[12px]"
                autoFocus
              />
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto p-1.5">
            {loading ? (
              <div className="space-y-1.5 p-1">
                {[0, 1, 2].map((index) => (
                  <div
                    key={index}
                    className="skeleton h-9 rounded"
                    style={{ opacity: 1 - index * 0.2 }}
                  />
                ))}
              </div>
            ) : error ? (
              <p className="px-2 py-3 text-[11px] leading-relaxed text-danger">
                {error}
              </p>
            ) : items.length === 0 ? (
              <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
                No documents match that search.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {items.map((doc) => {
                  const isOtherSide = doc.id === disabledId;
                  const selectable = !isOtherSide && isIndexed(doc.status);
                  return (
                    <li key={doc.id}>
                      <button
                        type="button"
                        disabled={!selectable}
                        onClick={() => {
                          onSelect(doc);
                          setOpen(false);
                          setQuery("");
                        }}
                        className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-55"
                      >
                        <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-medium">
                            {doc.title || doc.filename}
                          </span>
                          <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                            <StatusDot status={doc.status} />
                            {isOtherSide ? (
                              <span>already the other side</span>
                            ) : !isIndexed(doc.status) ? (
                              <span>not indexed yet</span>
                            ) : null}
                          </span>
                        </span>
                        {selected?.id === doc.id && (
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {docs && docs.total > items.length && (
            <p className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
              Showing {items.length} of {docs.total} documents you can read.
              Narrow the search to find the rest.
            </p>
          )}
        </PopoverContent>
      </Popover>

      {selected && !isIndexed(selected.status) && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-warning">
          <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
          This document is not indexed yet, so the backend will refuse to
          compare it.
        </p>
      )}
    </div>
  );
}
