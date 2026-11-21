"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Clock,
  Compass,
  FileText,
  History,
  Loader2,
  RotateCcw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type {
  ResearchCitation,
  ResearchListOut,
  ResearchReport,
  ResearchSection,
} from "@/lib/types";
import { cn, formatDate, formatRelative } from "@/lib/utils";
import { PageBody, PageHeader } from "@/components/ui";
import { EmptyState, ErrorState, LoadingPanel } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label, Separator } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** The eight sections a research report always contains, in reading order. */
const SECTION_KEYS = [
  "executive_summary",
  "key_findings",
  "supporting_evidence",
  "relevant_documents",
  "conflicting_information",
  "missing_information",
  "important_observations",
  "source_citations",
] as const;

type SectionKey = (typeof SECTION_KEYS)[number];

const SECTION_TITLES: Record<SectionKey, string> = {
  executive_summary: "Executive summary",
  key_findings: "Key findings",
  supporting_evidence: "Supporting evidence",
  relevant_documents: "Relevant documents",
  conflicting_information: "Conflicting information",
  missing_information: "Missing information",
  important_observations: "Important observations",
  source_citations: "Source citations",
};

/**
 * What an empty section honestly means.
 *
 * The backend drops every claim the model could not tie to a citation, so an
 * empty findings section really does mean "the archive does not support
 * anything here" — it is not a rendering failure. Each key gets the wording
 * that is true for it rather than a generic placeholder.
 */
const EMPTY_COPY: Record<SectionKey, string> = {
  executive_summary:
    "The model returned no summary for this question.",
  key_findings: "Nothing in the archive supports this.",
  supporting_evidence: "Nothing in the archive supports this.",
  relevant_documents:
    "No document in the archive could be tied to this question.",
  conflicting_information:
    "No conflicting information could be cited from the archive.",
  missing_information:
    "The model did not identify any specific gaps in the archive.",
  important_observations: "Nothing in the archive supports this.",
  source_citations: "No sources were cited for this question.",
};

/** The backend prefixes every observation so it cannot read as a fact. */
const OBSERVATION_PREFIX = "Observation (based on the cited material): ";

type TabKey = "report" | "history";

export default function ResearchPage() {
  const toast = useToast();

  const [tab, setTab] = useState<TabKey>("report");
  const [question, setQuestion] = useState("");
  const [instruction, setInstruction] = useState("");

  const [report, setReport] = useState<ResearchReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const [history, setHistory] = useState<ResearchListOut | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setHistory(await api.researchReports(25, 0));
    } catch (err) {
      setHistoryError(
        err instanceof Error
          ? err.message
          : "Could not load your research reports.",
      );
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const generate = useCallback(async () => {
    const q = question.trim();
    if (!q || running) return;
    setRunning(true);
    setRunError(null);
    setOpenError(null);
    try {
      const created = await api.research({
        question: q,
        instruction: instruction.trim() ? instruction.trim() : null,
      });
      setReport(created);
      setTab("report");
      toast.success(
        "Research report ready",
        `${created.citations.length} source${
          created.citations.length === 1 ? "" : "s"
        } cited.`,
      );
      loadHistory();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "The research report could not be generated.";
      setRunError(message);
      toast.error("Research failed", message);
    } finally {
      setRunning(false);
    }
  }, [question, instruction, running, toast, loadHistory]);

  const openReport = useCallback(
    async (id: string) => {
      setOpening(true);
      setOpenError(null);
      setRunError(null);
      try {
        setReport(await api.researchReport(id));
        setTab("report");
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "That research report could not be opened.";
        setOpenError(message);
        toast.error("Could not open the report", message);
      } finally {
        setOpening(false);
      }
    },
    [toast],
  );

  const sections = useMemo<ResearchSection[]>(() => {
    if (!report) return [];
    const known = SECTION_KEYS.map((key) => {
      const found = report.sections.find((section) => section.key === key);
      return (
        found ?? { key, title: SECTION_TITLES[key], body: "", citations: [] }
      );
    });
    // The backend always returns the eight sections above; anything extra it
    // sends is still shown rather than silently dropped.
    const extras = report.sections.filter(
      (section) => !SECTION_KEYS.includes(section.key as SectionKey),
    );
    return [...known, ...extras];
  }, [report]);

  return (
    <PageBody>
      <PageHeader
        eyebrow="Research Mode"
        title="Research the archive"
        description="A structured report assembled from the documents you are permitted to read. Findings are only kept when the model can cite them, so an empty section means the archive has nothing to say — not that the page failed."
        actions={
          report ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setReport(null);
                setRunError(null);
                setOpenError(null);
                setTab("report");
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              New report
            </Button>
          ) : undefined
        }
      />

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as TabKey)}
        className="mt-6"
      >
        <TabsList className="flex-wrap">
          <TabsTrigger value="report">Report</TabsTrigger>
          <TabsTrigger value="history">
            Previous reports
            {history ? ` (${history.total})` : ""}
          </TabsTrigger>
        </TabsList>

        {/* ── The report ─────────────────────────────────────────────── */}
        <TabsContent value="report">
          <section className="panel p-4 shadow-panel sm:p-5">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                generate();
              }}
              className="space-y-3"
            >
              <div>
                <Label htmlFor="research-question">Research question</Label>
                <Textarea
                  id="research-question"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  rows={3}
                  placeholder="What do the leases and facilities contracts say about reinstatement and dilapidations?"
                  className="mt-1.5 text-[14px]"
                />
              </div>

              <div>
                <Label htmlFor="research-instruction">
                  Instruction (optional)
                </Label>
                <Input
                  id="research-instruction"
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="e.g. concentrate on renewal dates and notice periods"
                  className="mt-1.5"
                />
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  An instruction shapes the report but cannot introduce
                  evidence: retrieval stays limited to documents you may read.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-0.5">
                <Button
                  type="submit"
                  variant="accent"
                  disabled={running || !question.trim()}
                >
                  {running ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Generating report
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      Generate report
                    </>
                  )}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  The local model writes the report on this machine. On CPU this
                  can take a while.
                </p>
              </div>
            </form>
          </section>

          <div className="mt-5">
            {running ? (
              <GeneratingPanel />
            ) : runError ? (
              <ErrorState
                title="The report could not be generated"
                message={runError}
                onRetry={generate}
              />
            ) : openError ? (
              <ErrorState
                title="The report could not be opened"
                message={openError}
                onRetry={() => report && openReport(report.id)}
              />
            ) : opening ? (
              <div className="panel p-5 shadow-panel">
                <LoadingPanel label="Opening the report…" rows={4} />
              </div>
            ) : report ? (
              <ReportView report={report} sections={sections} />
            ) : (
              <EmptyState
                icon={<Compass className="h-4 w-4" />}
                title="No research report yet"
                description="Ask a question above. The archive answers in eight sections — a summary, the findings, the evidence behind them, the relevant documents, the conflicts and gaps it found, its observations, and the sources themselves."
              />
            )}
          </div>
        </TabsContent>

        {/* ── Previous reports ───────────────────────────────────────── */}
        <TabsContent value="history">
          <section className="panel p-5 shadow-panel">
            <div className="flex items-center justify-between gap-3">
              <p className="label">Your research reports</p>
              <Button
                variant="ghost"
                size="xs"
                onClick={loadHistory}
                disabled={historyLoading}
              >
                {historyLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                Refresh
              </Button>
            </div>

            <div className="mt-3">
              {historyLoading ? (
                <LoadingPanel label="Loading your reports…" rows={4} />
              ) : historyError ? (
                <ErrorState
                  message={historyError}
                  onRetry={loadHistory}
                />
              ) : !history || history.items.length === 0 ? (
                <EmptyState
                  className="border-0"
                  icon={<History className="h-4 w-4" />}
                  title="No research reports yet"
                  description="Reports you generate are saved here so you can reopen and re-read them later."
                />
              ) : (
                <ul className="space-y-1.5">
                  {history.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => openReport(item.id)}
                        className="group flex w-full items-start gap-3 rounded-md border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-accent/50 hover:bg-accent/[0.03]"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium transition-colors group-hover:text-accent">
                            {item.question}
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {formatRelative(item.created_at)}
                            </span>
                            <span className="font-mono">
                              {item.citation_count} citation
                              {item.citation_count === 1 ? "" : "s"}
                            </span>
                            {item.model && (
                              <span className="truncate font-mono">{item.model}</span>
                            )}
                          </span>
                        </span>
                        <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-accent" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </TabsContent>
      </Tabs>
    </PageBody>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

/** The honest progress state: the model is working, here is what is coming. */
function GeneratingPanel() {
  return (
    <div className="panel p-5 shadow-panel" aria-busy="true">
      <div className="flex items-center gap-2.5">
        <Loader2 className="h-4 w-4 animate-spin text-accent" />
        <p className="text-[13px] font-semibold">Generating the report</p>
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
        The local model is retrieving the passages it is permitted to read and
        writing each section. Claims it cannot cite are dropped rather than
        guessed, so an honest gap is a valid result.
      </p>
      <Separator className="my-4" />
      <ul className="space-y-2" aria-hidden="true">
        {SECTION_KEYS.map((key, index) => (
          <li key={key} className="flex items-center gap-3">
            <span className="w-4 shrink-0 font-mono text-[10px] text-muted-foreground">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="flex-1 truncate text-[12px] text-muted-foreground">
              {SECTION_TITLES[key]}
            </span>
            <span className="skeleton h-2.5 w-16 rounded" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReportView({
  report,
  sections,
}: {
  report: ResearchReport;
  sections: ResearchSection[];
}) {
  const citationCount = report.citations.length;

  return (
    <article className="animate-rise space-y-4">
      <header className="panel p-5 shadow-panel">
        <p className="label">Research question</p>
        <h2 className="mt-1.5 text-[16px] font-semibold leading-snug tracking-tight">
          {report.question}
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <FileText className="h-3 w-3" />
            {citationCount} source{citationCount === 1 ? "" : "s"} cited
          </span>
          {report.model && (
            <span className="font-mono">{report.model}</span>
          )}
          {report.tokens_used != null && (
            <span className="font-mono">{report.tokens_used} tokens</span>
          )}
          {report.created_at && (
            <span title={formatDate(report.created_at)}>
              {formatRelative(report.created_at)}
            </span>
          )}
        </div>
      </header>

      {citationCount === 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/[0.07] px-4 py-3.5">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-warning">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            This report has no evidence behind it
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            No passage in the archive your account can read supports this
            question. The sections below are reported as they came back —
            empty, rather than filled with a plausible guess.
          </p>
        </div>
      )}

      {sections.map((section) => (
        <SectionBlock key={section.key} section={section} report={report} />
      ))}
    </article>
  );
}

function SectionBlock({
  section,
  report,
}: {
  section: ResearchSection;
  report: ResearchReport;
}) {
  const key = section.key as SectionKey;
  const caveat = key === "conflicting_information" || key === "missing_information";
  const observation = key === "important_observations";
  const isSources = key === "source_citations";

  const resolved = resolveSectionCitations(section, report.citations);

  return (
    <section
      className={cn(
        "rounded-lg border px-4 py-4 sm:px-5",
        caveat
          ? "border-warning/40 bg-warning/[0.06]"
          : observation
            ? "border-accent/30 bg-accent/[0.05]"
            : "border-border bg-surface",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          className={cn(
            "text-[13px] font-semibold tracking-tight",
            caveat && "text-warning",
          )}
        >
          {section.title || SECTION_TITLES[key]}
        </h3>
        {caveat && (
          <span className="chip bg-warning/15 text-warning">
            <TriangleAlert className="h-3 w-3" />
            caveat — not a verified finding
          </span>
        )}
        {observation && (
          <span className="chip bg-accent/15 text-accent">observation</span>
        )}
      </div>

      {isSources ? (
        <SourceList citations={report.citations} />
      ) : (
        <>
          <SectionBody section={section} sectionKey={key} />
          {resolved.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="label">Sources</span>
              {resolved.map((citation) => (
                <Link
                  key={`${citation.document_id}-${citation.index}`}
                  href={`/library/${citation.document_id}?page=${citation.page_start}`}
                  className="chip max-w-[240px] bg-accent/12 text-accent transition-colors hover:bg-accent/20"
                  title={`${citation.filename} — page ${citation.page_start}`}
                >
                  <span className="font-mono">[{citation.index}]</span>
                  <span className="truncate">{citation.filename}</span>
                  <span className="font-mono opacity-70">
                    p.{citation.page_start}
                    {citation.page_end !== citation.page_start
                      ? `–${citation.page_end}`
                      : ""}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SectionBody({
  section,
  sectionKey,
}: {
  section: ResearchSection;
  sectionKey: SectionKey;
}) {
  const lines = section.body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return (
      <p className="mt-2 flex items-start gap-2 rounded-md border border-dashed border-border bg-background/60 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
        <FileText className="mt-px h-3.5 w-3.5 shrink-0" />
        {EMPTY_COPY[sectionKey] ?? "Nothing in the archive supports this."}
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {lines.map((line, index) => (
        <p
          key={index}
          className="text-[13px] leading-relaxed text-foreground/90"
        >
          {sectionKey === "important_observations" &&
          line.startsWith(OBSERVATION_PREFIX) ? (
            <>
              <span className="font-semibold text-accent">
                {OBSERVATION_PREFIX}
              </span>
              {line.slice(OBSERVATION_PREFIX.length)}
            </>
          ) : (
            line
          )}
        </p>
      ))}
    </div>
  );
}

/** The report's own source list — each entry opens its document at the page. */
function SourceList({ citations }: { citations: ResearchCitation[] }) {
  if (citations.length === 0) {
    return (
      <p className="mt-2 flex items-start gap-2 rounded-md border border-dashed border-border bg-background/60 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
        <FileText className="mt-px h-3.5 w-3.5 shrink-0" />
        {EMPTY_COPY.source_citations}
      </p>
    );
  }

  return (
    <div className="mt-2.5 space-y-1.5">
      {citations.map((citation) => (
        <Link
          key={`${citation.document_id}-${citation.index}`}
          href={`/library/${citation.document_id}?page=${citation.page_start}`}
          className="group flex gap-2.5 rounded-md border border-border bg-background px-3 py-2.5 transition-colors hover:border-accent/50"
        >
          <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded bg-accent/12 font-mono text-[10px] font-bold text-accent">
            {citation.index}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-3">
              <span className="truncate text-[12px] font-semibold transition-colors group-hover:text-accent">
                {citation.filename}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                p.{citation.page_start}
                {citation.page_end !== citation.page_start
                  ? `–${citation.page_end}`
                  : ""}
              </span>
            </span>
            {citation.excerpt && (
              <span className="mt-0.5 block line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                “{citation.excerpt}”
              </span>
            )}
          </span>
        </Link>
      ))}
    </div>
  );
}

/**
 * Map a section's citation numbers onto the report's citations.
 *
 * A freshly generated report keeps the passage numbers the model was given,
 * while a report re-read later has its numbers remapped to a contiguous run.
 * Matching on the citation's own `index` satisfies both; the positional
 * lookups are a fallback for anything older.
 */
function resolveSectionCitations(
  section: ResearchSection,
  citations: ResearchCitation[],
): ResearchCitation[] {
  const seen = new Set<string>();
  const out: ResearchCitation[] = [];

  for (const number of section.citations ?? []) {
    const citation =
      citations.find((entry) => entry.index === number) ??
      citations[number - 1] ??
      citations[number];
    if (!citation) continue;
    const key = `${citation.document_id}-${citation.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }

  return out;
}
