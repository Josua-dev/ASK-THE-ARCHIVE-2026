"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarClock,
  FileText,
  Loader2,
  Quote,
  ShieldAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
  Analytics,
  ArchiveDocument,
  ArchiveInsight,
  DocumentList,
  DocumentProfile,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { PageBody, PageHeader } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  LoadingPanel,
  StatCard,
} from "@/components/states";

/**
 * There is no dedicated dates endpoint. Everything on this page is merged from
 * three real sources: the document record (expiry, created, indexed) and the
 * extracted document profile (important dates and obligations), each of which
 * carries the page and excerpt it was read from.
 */

const PAGE_SIZE = 200;

type Source = "expiry" | "created" | "indexed" | "important_date" | "obligation";

const SOURCE_LABEL: Record<Source, string> = {
  expiry: "Expiry",
  created: "Added",
  indexed: "Indexed",
  important_date: "Profile date",
  obligation: "Obligation",
};

const SOURCE_TONE: Record<Source, string> = {
  expiry: "bg-warning/12 text-warning",
  created: "bg-muted text-muted-foreground",
  indexed: "bg-success/12 text-success",
  important_date: "bg-accent/12 text-accent",
  obligation: "bg-accent/12 text-accent",
};

interface TimelineEntry {
  key: string;
  date: Date;
  source: Source;
  title: string;
  detail: string | null;
  documentId: string;
  documentLabel: string;
  page: number | null;
  excerpt: string | null;
}

interface MonthGroup {
  key: string;
  label: string;
  entries: TimelineEntry[];
}

/** Parse a date the archive gave us, tolerating both dates and timestamps. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // A bare calendar date is read in the reader's own timezone so it never
  // slips a day because of UTC midnight.
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (plain) {
    const parsed = new Date(
      Number(plain[1]),
      Number(plain[2]) - 1,
      Number(plain[3]),
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDay(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatMonth(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
  }).format(date);
}

function documentLabel(doc: ArchiveDocument) {
  return doc.title || doc.filename;
}

export default function DatesPage() {
  const [docs, setDocs] = useState<DocumentList | null>(null);
  const [stats, setStats] = useState<Analytics | null>(null);
  const [insights, setInsights] = useState<ArchiveInsight[]>([]);
  const [profiles, setProfiles] = useState<Map<string, DocumentProfile>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState<Date | null>(null);

  useEffect(() => {
    setToday(new Date());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setProfilesLoading(true);

    let documentList: DocumentList;
    try {
      const [documents, analytics, insightList] = await Promise.all([
        api.documents({ limit: PAGE_SIZE }),
        api.analytics().catch(() => null),
        api.insights({ limit: 500 }).catch(() => null),
      ]);
      documentList = documents;
      setDocs(documents);
      setStats(analytics);
      setInsights(insightList?.items ?? []);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not read the archive dates.",
      );
      setLoading(false);
      setProfilesLoading(false);
      return;
    }

    setLoading(false);

    // Profiles are fetched one document at a time. A document without a
    // profile answers 404; that is expected and must not fail the page.
    try {
      const settled = await Promise.allSettled(
        documentList.items.map((doc) => api.profile(doc.id)),
      );
      const collected = new Map<string, DocumentProfile>();
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") {
          collected.set(documentList.items[index].id, result.value);
        }
      });
      setProfiles(collected);
    } catch {
      /* Individual profile failures are tolerated — the timeline still
         carries every document-level date. */
    } finally {
      setProfilesLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const entries = useMemo<TimelineEntry[]>(() => {
    const out: TimelineEntry[] = [];
    const items = docs?.items ?? [];

    for (const doc of items) {
      const label = documentLabel(doc);

      const expiry = parseDate(doc.expiry_date);
      if (expiry) {
        out.push({
          key: `${doc.id}-expiry`,
          date: expiry,
          source: "expiry",
          title: `${label} expires`,
          detail: doc.expiry_date,
          documentId: doc.id,
          documentLabel: label,
          page: null,
          excerpt: null,
        });
      }

      const created = parseDate(doc.created_at);
      if (created) {
        out.push({
          key: `${doc.id}-created`,
          date: created,
          source: "created",
          title: `${label} added to the archive`,
          detail: null,
          documentId: doc.id,
          documentLabel: label,
          page: null,
          excerpt: null,
        });
      }

      const indexed = parseDate(doc.indexed_at);
      if (indexed) {
        out.push({
          key: `${doc.id}-indexed`,
          date: indexed,
          source: "indexed",
          title: `${label} finished indexing`,
          detail: null,
          documentId: doc.id,
          documentLabel: label,
          page: null,
          excerpt: null,
        });
      }

      const profile = profiles.get(doc.id);
      if (!profile) continue;

      profile.important_dates?.forEach((item, index) => {
        const date = parseDate(item.date);
        if (!date) return;
        out.push({
          key: `${doc.id}-important-${index}`,
          date,
          source: "important_date",
          title: item.label || "Important date",
          detail: item.name || item.role || null,
          documentId: doc.id,
          documentLabel: label,
          page: item.page ?? null,
          excerpt: item.excerpt ?? null,
        });
      });

      profile.obligations?.forEach((item, index) => {
        const date = parseDate(item.due ?? item.date);
        if (!date) return;
        out.push({
          key: `${doc.id}-obligation-${index}`,
          date,
          source: "obligation",
          title: item.text || item.label || "Obligation",
          detail: item.party || null,
          documentId: doc.id,
          documentLabel: label,
          page: item.page ?? null,
          excerpt: item.excerpt ?? null,
        });
      });
    }

    return out.sort((a, b) => {
      const diff = a.date.getTime() - b.date.getTime();
      if (diff !== 0) return diff;
      return a.title.localeCompare(b.title);
    });
  }, [docs, profiles]);

  const groups = useMemo<MonthGroup[]>(() => {
    const byMonth = new Map<string, TimelineEntry[]>();
    for (const entry of entries) {
      const key = `${entry.date.getFullYear()}-${entry.date.getMonth()}`;
      const bucket = byMonth.get(key);
      if (bucket) bucket.push(entry);
      else byMonth.set(key, [entry]);
    }
    return Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, bucket]) => ({
        key,
        label: formatMonth(bucket[0].date),
        entries: bucket,
      }));
  }, [entries]);

  const expiryCount = entries.filter((e) => e.source === "expiry").length;
  const obligationCount = entries.filter((e) => e.source === "obligation").length;

  const dateInsights = useMemo(
    () =>
      insights.filter(
        (insight) =>
          insight.kind === "expiring_soon" || insight.kind === "obligation_due",
      ),
    [insights],
  );

  const archiveTotal = stats?.overview?.documents_total ?? docs?.total ?? null;
  const partialArchive =
    docs !== null && docs.total > docs.items.length;

  const startOfToday = today
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    : null;

  return (
    <PageBody>
      <PageHeader
        eyebrow="Intelligence"
        title="Important Dates"
        description="Every date the archive actually knows about, merged from document expiry, ingest and indexing timestamps, and the dates and obligations extracted from each document profile. Each entry links back to the page it came from."
      />

      {error && (
        <ErrorState className="mt-6" message={error} onRetry={load} />
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Documents in scope"
          value={loading ? null : (archiveTotal ?? 0)}
          hint={
            partialArchive
              ? `Timeline covers the first ${docs?.items.length ?? 0}`
              : "Everything the archive holds"
          }
        />
        <StatCard
          label="Dates on the timeline"
          value={loading ? null : entries.length}
          hint="Merged from documents and profiles"
          tone="accent"
        />
        <StatCard
          label="Expiries tracked"
          value={loading ? null : expiryCount}
          hint="Recorded on the document itself"
          tone="warning"
        />
        <StatCard
          label="Obligations with a date"
          value={loading ? null : obligationCount}
          hint="Extracted from document profiles"
        />
      </div>

      {profilesLoading && (
        <p className="mt-4 flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading document profiles for their dates and obligations…
        </p>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        {/* Timeline */}
        <section className="panel p-4 shadow-panel sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="label flex items-center gap-1.5">
              <CalendarClock className="h-3 w-3" />
              Timeline
            </p>
            {today && (
              <p className="text-[11px] text-muted-foreground">
                Today is {formatDay(today)}
              </p>
            )}
          </div>

          {loading ? (
            <div className="mt-3">
              <LoadingPanel label="Reading the archive dates…" rows={5} />
            </div>
          ) : groups.length === 0 ? (
            <EmptyState
              className="mt-3 border-0"
              icon={<CalendarClock className="h-4 w-4" />}
              title="No dates yet"
              description="Once documents are ingested, their expiry, ingest and indexing dates appear here, along with any dates and obligations extracted from their profiles."
            />
          ) : (
            <ol className="mt-4 space-y-6">
              {groups.map((group) => {
                const isCurrentMonth =
                  today !== null &&
                  group.entries[0]?.date.getFullYear() === today.getFullYear() &&
                  group.entries[0]?.date.getMonth() === today.getMonth();
                // The "today" marker sits between the past and the future
                // inside the current month; when every entry in the month is
                // already behind us it falls at the end of the group.
                let markerAt = -1;
                if (isCurrentMonth && startOfToday !== null) {
                  const firstUpcoming = group.entries.findIndex(
                    (entry) => entry.date.getTime() >= startOfToday,
                  );
                  markerAt =
                    firstUpcoming === -1 ? group.entries.length : firstUpcoming;
                }

                const before =
                  markerAt === -1 ? group.entries : group.entries.slice(0, markerAt);
                const after =
                  markerAt === -1 ? [] : group.entries.slice(markerAt);

                return (
                  <li key={group.key}>
                    <div className="flex items-baseline gap-2.5">
                      <h2 className="text-[13px] font-semibold tracking-tight">
                        {group.label}
                      </h2>
                      <span className="text-[11px] text-muted-foreground">
                        {group.entries.length} entr
                        {group.entries.length === 1 ? "y" : "ies"}
                      </span>
                    </div>

                    <ul className="mt-2 space-y-1.5 border-l border-border pl-4">
                      {before.map((entry) => (
                        <TimelineRow
                          key={entry.key}
                          entry={entry}
                          today={today}
                          startOfToday={startOfToday}
                        />
                      ))}

                      {markerAt !== -1 && (
                        <li className="relative flex items-center gap-2 py-0.5">
                          <span className="absolute -left-[21px] h-2.5 w-2.5 rounded-full border-2 border-accent bg-background" />
                          <span className="label text-accent">Today</span>
                        </li>
                      )}

                      {after.map((entry) => (
                        <TimelineRow
                          key={entry.key}
                          entry={entry}
                          today={today}
                          startOfToday={startOfToday}
                        />
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {/* Side column */}
        <div className="space-y-5">
          <section className="panel p-4 shadow-panel">
            <p className="label">Where these dates come from</p>
            <ul className="mt-2.5 space-y-2">
              {(
                [
                  ["Expiry", "The expiry date stored on the document record."],
                  [
                    "Added",
                    "When the document was uploaded into the archive.",
                  ],
                  [
                    "Indexed",
                    "When extraction and indexing finished for the document.",
                  ],
                  [
                    "Profile date",
                    "A date the model read out of the document text.",
                  ],
                  [
                    "Obligation",
                    "A duty with a due date, read from the document text.",
                  ],
                ] as const
              ).map(([label, description]) => (
                <li key={label} className="text-[11px] leading-relaxed">
                  <span className="font-semibold">{label}</span>
                  <span className="text-muted-foreground"> — {description}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
              Profile dates and obligations carry the page and excerpt they
              were read from, so any date can be traced back to the words that
              produced it.
            </p>
          </section>

          <section className="panel p-4 shadow-panel">
            <p className="label">Expiry and obligation insights</p>
            {loading ? (
              <div className="mt-3 space-y-2">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="skeleton h-12 rounded-md" />
                ))}
              </div>
            ) : dateInsights.length === 0 ? (
              <EmptyState
                className="mt-3 border-0 px-2 py-8"
                icon={<ShieldAlert className="h-4 w-4" />}
                title="No related insights"
                description="The detection pass has not flagged any expiring document or due obligation in your scope."
              />
            ) : (
              <ul className="mt-2.5 space-y-1.5">
                {dateInsights.map((insight) => (
                  <li
                    key={insight.id ?? `${insight.kind}-${insight.title}`}
                    className="rounded-md border border-border bg-background px-3 py-2"
                  >
                    <p className="text-[12px] font-semibold leading-snug">
                      {insight.title}
                    </p>
                    {insight.detail && (
                      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                        {insight.detail}
                      </p>
                    )}
                    {insight.document_ids.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {insight.document_ids.map((id) => (
                          <Link
                            key={id}
                            href={`/library/${id}`}
                            className="chip bg-muted text-muted-foreground transition-colors hover:bg-accent/12 hover:text-accent"
                          >
                            <FileText className="h-3 w-3" />
                            Document {id.slice(0, 8)}
                          </Link>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </PageBody>
  );
}

function TimelineRow({
  entry,
  today,
  startOfToday,
}: {
  entry: TimelineEntry;
  today: Date | null;
  startOfToday: number | null;
}) {
  const past =
    startOfToday !== null ? entry.date.getTime() < startOfToday : false;
  const isToday =
    today !== null &&
    entry.date.getFullYear() === today.getFullYear() &&
    entry.date.getMonth() === today.getMonth() &&
    entry.date.getDate() === today.getDate();

  return (
    <li className="relative">
      <span
        className={cn(
          "absolute -left-[21px] top-3 h-2 w-2 rounded-full border border-border",
          past ? "bg-muted-foreground/45" : "bg-accent",
        )}
      />
      <div
        className={cn(
          "rounded-md border border-border bg-background px-3 py-2.5",
          past && "opacity-75",
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[13px] font-medium leading-snug">{entry.title}</p>
            {entry.detail && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {entry.detail}
              </p>
            )}
          </div>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {formatDay(entry.date)}
          </span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className={cn("chip", SOURCE_TONE[entry.source])}>
            {SOURCE_LABEL[entry.source]}
          </span>
          <Link
            href={`/library/${entry.documentId}${
              entry.page ? `?page=${entry.page}` : ""
            }`}
            className="chip bg-muted text-muted-foreground transition-colors hover:bg-accent/12 hover:text-accent"
          >
            <FileText className="h-3 w-3" />
            {entry.documentLabel}
            {entry.page ? ` · p.${entry.page}` : ""}
          </Link>
          {isToday && <span className="chip bg-accent/12 text-accent">Today</span>}
          {past && !isToday && (
            <span className="chip bg-muted text-muted-foreground">Past</span>
          )}
        </div>

        {entry.excerpt && (
          <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <Quote className="mt-px h-3 w-3 shrink-0" />
            “{entry.excerpt}”
          </p>
        )}
      </div>
    </li>
  );
}
