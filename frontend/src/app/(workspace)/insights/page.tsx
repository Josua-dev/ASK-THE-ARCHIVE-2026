"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  CircleSlash,
  FileText,
  Loader2,
  Quote,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import type { ArchiveInsight, InsightListOut } from "@/lib/types";
import { cn, EMPTY_ARRAY, formatDate } from "@/lib/utils";
import { PageBody, PageHeader } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  LoadingPanel,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The kinds the backend can detect. The counts record always carries every
 * one of them (zeroed when nothing was found), so the summary strip is driven
 * by the API rather than by this list.
 */
const CANONICAL_KINDS = [
  "expiring_soon",
  "missing_metadata",
  "potential_duplicate",
  "conflicting_date",
  "inconsistent_value",
  "missing_contract_info",
  "obligation_due",
  "needs_review",
];

const STATUSES = ["open", "acknowledged", "resolved", "dismissed"] as const;

/** A stable empty count map, so the memos that depend on it do not re-run. */
const EMPTY_COUNTS: Record<string, number> = Object.freeze({});

const SEVERITY_VARIANT: Record<
  string,
  "default" | "accent" | "success" | "warning" | "danger"
> = {
  info: "default",
  low: "default",
  medium: "warning",
  high: "danger",
};

const STATUS_TONE: Record<string, string> = {
  open: "bg-warning/12 text-warning",
  acknowledged: "bg-accent/12 text-accent",
  resolved: "bg-success/12 text-success",
  dismissed: "bg-muted text-muted-foreground",
};

function humanise(token: string) {
  return token.replace(/_/g, " ");
}

export default function InsightsPage() {
  const { user } = useAuth();
  const toast = useToast();

  // The backend guards the scan and the status update with `require_staff`,
  // which admits analysts and admins. A viewer reads but never writes.
  const canManage = user?.role === "admin" || user?.role === "analyst";

  const [data, setData] = useState<InsightListOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.insights({ limit: 500 }));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not load archive insights.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = data?.counts ?? EMPTY_COUNTS;
  // EMPTY_ARRAY rather than a fresh `[]`, so the memos below actually memoize.
  const items = data?.items ?? EMPTY_ARRAY;

  // Every kind the backend knows about, plus anything unexpected that turns up
  // in the payload, so a new detection kind is never hidden.
  const kinds = useMemo(() => {
    const seen = new Set<string>(CANONICAL_KINDS);
    Object.keys(counts).forEach((kind) => seen.add(kind));
    items.forEach((item) => seen.add(item.kind));
    return Array.from(seen);
  }, [counts, items]);

  const visible = useMemo(
    () =>
      items.filter((item) => {
        if (statusFilter !== "all" && item.status !== statusFilter) return false;
        if (kindFilter !== "all" && item.kind !== kindFilter) return false;
        return true;
      }),
    [items, statusFilter, kindFilter],
  );

  const totalDetected = useMemo(
    () => kinds.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0),
    [kinds, counts],
  );

  async function rescan() {
    setScanning(true);
    try {
      const next = await api.scanInsights();
      setData(next);
      toast.success(
        "Archive rescanned",
        `${next.total} insight${next.total === 1 ? "" : "s"} in your scope.`,
      );
    } catch (err) {
      toast.error(
        "Rescan failed",
        err instanceof Error ? err.message : "The archive could not be rescanned.",
      );
    } finally {
      setScanning(false);
    }
  }

  async function changeStatus(insight: ArchiveInsight, status: string) {
    if (!insight.id) return;
    setPendingId(insight.id);
    try {
      const updated = await api.updateInsight(insight.id, status);
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((item) =>
                item.id === updated.id ? updated : item,
              ),
            }
          : prev,
      );
      toast.success(
        `Insight ${status}`,
        updated.title || "The insight status was updated.",
      );
    } catch (err) {
      toast.error(
        "Could not update the insight",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setPendingId(null);
    }
  }

  return (
    <PageBody>
      <PageHeader
        eyebrow="Intelligence"
        title="Archive Insights"
        description="Deterministic checks across the archive — expiry dates, checksums, filenames, extracted profiles and contract references. Every count below comes from the detection pass; nothing here is estimated."
        actions={
          canManage ? (
            <Button variant="outline" size="sm" onClick={rescan} disabled={scanning}>
              {scanning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {scanning ? "Scanning" : "Rescan archive"}
            </Button>
          ) : null
        }
      />

      {error && (
        <ErrorState className="mt-6" message={error} onRetry={load} />
      )}

      {/* Real counts, keyed by kind, straight from the API. */}
      <section className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="label">Detected insights by kind</p>
          <p className="text-[11px] text-muted-foreground">
            {loading
              ? "Reading detection results…"
              : `${totalDetected} detected across ${data?.total ?? 0} returned`}
          </p>
        </div>

        {loading ? (
          <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="skeleton h-[62px] rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {kinds.map((kind) => {
              const count = counts[kind] ?? 0;
              const active = kindFilter === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setKindFilter(active ? "all" : kind)}
                  className={cn(
                    "panel px-3.5 py-3 text-left transition-colors hover:border-accent/50",
                    active && "border-accent/60 bg-accent/5",
                    count === 0 && !active && "opacity-60",
                  )}
                >
                  <span className="label block truncate capitalize">
                    {humanise(kind)}
                  </span>
                  <span className="mt-1 block font-mono text-[22px] font-semibold leading-none">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Filters */}
      <section className="mt-6 flex flex-wrap items-end gap-3">
        <div className="w-[190px]">
          <label
            htmlFor="insight-status"
            className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
          >
            Status
          </label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger id="insight-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((status) => (
                <SelectItem key={status} value={status} className="capitalize">
                  {status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-[220px]">
          <label
            htmlFor="insight-kind"
            className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
          >
            Kind
          </label>
          <Select value={kindFilter} onValueChange={setKindFilter}>
            <SelectTrigger id="insight-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              {kinds.map((kind) => (
                <SelectItem key={kind} value={kind} className="capitalize">
                  {humanise(kind)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!canManage && (
          <p className="flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
            You can read every insight in your scope. Rescanning the archive and
            changing an insight status need the analyst role.
          </p>
        )}
      </section>

      {/* The insights themselves */}
      <section className="mt-4">
        {loading ? (
          <div className="panel p-4 shadow-panel">
            <LoadingPanel label="Reading the detection results…" rows={4} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            className="panel border-dashed"
            icon={<ShieldAlert className="h-4 w-4" />}
            title="No insights detected yet"
            description={
              canManage
                ? "Run a rescan to check the archive for expiring documents, missing metadata, duplicates and conflicting values."
                : "Nothing has been detected in the documents you can read. An analyst or administrator can rescan the archive."
            }
            action={
              canManage ? (
                <Button variant="outline" size="sm" onClick={rescan} disabled={scanning}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  Rescan archive
                </Button>
              ) : null
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            className="panel border-dashed"
            icon={<ShieldAlert className="h-4 w-4" />}
            title="No insight matches this filter"
            description="Clear the status or kind filter to see every detected insight again."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStatusFilter("all");
                  setKindFilter("all");
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {visible.map((insight) => (
              <InsightCard
                key={insight.id ?? `${insight.kind}-${insight.title}`}
                insight={insight}
                canManage={canManage}
                busy={pendingId === insight.id}
                onChangeStatus={changeStatus}
              />
            ))}
          </div>
        )}
      </section>
    </PageBody>
  );
}

function InsightCard({
  insight,
  canManage,
  busy,
  onChangeStatus,
}: {
  insight: ArchiveInsight;
  canManage: boolean;
  busy: boolean;
  onChangeStatus: (insight: ArchiveInsight, status: string) => void;
}) {
  // Evidence carries the filename for each affected document; fall back to a
  // short identifier when the backend did not record one.
  const nameByDocument = new Map<string, string>();
  insight.evidence.forEach((entry) => {
    if (entry.filename && !nameByDocument.has(entry.document_id)) {
      nameByDocument.set(entry.document_id, entry.filename);
    }
  });

  const settled = insight.status === "resolved" || insight.status === "dismissed";

  return (
    <article className="panel p-4 shadow-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={SEVERITY_VARIANT[insight.severity] ?? "default"}>
              {insight.severity}
            </Badge>
            <span className="chip bg-muted text-muted-foreground capitalize">
              {humanise(insight.kind)}
            </span>
            <span className={cn("chip", STATUS_TONE[insight.status])}>
              {insight.status}
            </span>
          </div>

          <h2 className="mt-2 text-[14px] font-semibold leading-snug tracking-tight">
            {insight.title}
          </h2>
          {insight.detail && (
            <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-muted-foreground">
              {insight.detail}
            </p>
          )}
        </div>

        <div className="shrink-0 text-right">
          <p className="font-mono text-[10px] text-muted-foreground">
            {insight.detected_at ? formatDate(insight.detected_at) : "—"}
          </p>
          {insight.acknowledged_at && (
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {insight.status} {formatDate(insight.acknowledged_at)}
            </p>
          )}
        </div>
      </div>

      {insight.document_ids.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="label mr-1">Documents</span>
          {insight.document_ids.map((id) => (
            <Link
              key={id}
              href={`/library/${id}`}
              className="chip bg-muted text-muted-foreground transition-colors hover:bg-accent/12 hover:text-accent"
            >
              <FileText className="h-3 w-3" />
              {nameByDocument.get(id) ?? `Document ${id.slice(0, 8)}`}
            </Link>
          ))}
        </div>
      )}

      {insight.evidence.length > 0 && (
        <div className="mt-3">
          <p className="label mb-1.5 flex items-center gap-1.5">
            <Quote className="h-3 w-3" />
            Evidence
          </p>
          <ul className="space-y-1.5">
            {insight.evidence.map((entry, index) => (
              <li key={`${entry.document_id}-${index}`}>
                <Link
                  href={`/library/${entry.document_id}${
                    entry.page ? `?page=${entry.page}` : ""
                  }`}
                  className="group block rounded-md border border-border bg-background px-3 py-2 transition-colors hover:border-accent/50"
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="truncate text-[11px] font-semibold transition-colors group-hover:text-accent">
                      {entry.filename ?? `Document ${entry.document_id.slice(0, 8)}`}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {entry.page ? `p.${entry.page}` : ""}
                    </span>
                  </span>
                  {entry.excerpt && (
                    <span className="mt-1 block line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      “{entry.excerpt}”
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canManage && insight.id && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {busy ? (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Updating…
            </span>
          ) : (
            <>
              {!settled && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onChangeStatus(insight, "acknowledged")}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  Acknowledge
                </Button>
              )}
              {!settled && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onChangeStatus(insight, "resolved")}
                >
                  <CheckCircle2 className="h-3 w-3 text-success" />
                  Resolve
                </Button>
              )}
              {insight.status !== "dismissed" && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onChangeStatus(insight, "dismissed")}
                >
                  <CircleSlash className="h-3 w-3" />
                  Dismiss
                </Button>
              )}
              {settled && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onChangeStatus(insight, "open")}
                >
                  <RefreshCw className="h-3 w-3" />
                  Reopen
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}
