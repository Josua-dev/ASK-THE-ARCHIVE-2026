"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  BarChart3,
  FileText,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
} from "lucide-react";
import { api } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import type { Analytics } from "@/lib/types";
import { EMPTY_ARRAY, formatBytes, formatDate } from "@/lib/utils";
import { PageBody, PageHeader } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  LoadingPanel,
  StatCard,
} from "@/components/states";
import { Button } from "@/components/ui/button";

interface ChartTheme {
  foreground: string;
  mutedForeground: string;
  border: string;
  accent: string;
  surface: string;
}

/** Resolve a CSS custom property to a colour Recharts can use directly. */
function hsl(triplet: string, alpha?: number) {
  const [h, s, l] = triplet.trim().split(/\s+/);
  if (!h || !s || !l) return "currentColor";
  return alpha === undefined
    ? `hsl(${h}, ${s}, ${l})`
    : `hsla(${h}, ${s}, ${l}, ${alpha})`;
}

/**
 * Recharts paints with literal colours, so the theme has to be read back out
 * of the stylesheet. The tokens are bare HSL channels, which turn straight
 * into a valid colour.
 */
const FALLBACK_THEME: ChartTheme = {
  foreground: "210, 12%, 10%",
  mutedForeground: "207, 5%, 56%",
  border: "210, 12%, 10%",
  accent: "24, 44%, 51%",
  surface: "0, 0%, 100%",
};

function useChartTheme(): ChartTheme {
  const { resolved } = useTheme();
  const [theme, setTheme] = useState<ChartTheme>(FALLBACK_THEME);

  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;
    setTheme({
      foreground: read("--foreground", FALLBACK_THEME.foreground),
      mutedForeground: read(
        "--muted-foreground",
        FALLBACK_THEME.mutedForeground,
      ),
      border: read("--border", FALLBACK_THEME.border),
      accent: read("--accent", FALLBACK_THEME.accent),
      surface: read("--surface", FALLBACK_THEME.surface),
    });
  }, [resolved]);

  return theme;
}

export default function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const theme = useChartTheme();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.analytics());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load archive analytics.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const overview = data?.overview;
  // EMPTY_ARRAY rather than a fresh `[]`, so the memos below actually memoize.
  const timeline = data?.timeline ?? EMPTY_ARRAY;
  const byType = data?.documents_by_type ?? EMPTY_ARRAY;
  const byStatus = data?.documents_by_status ?? EMPTY_ARRAY;
  const topCited = data?.top_cited ?? EMPTY_ARRAY;
  const topEntities = data?.top_entities ?? EMPTY_ARRAY;

  const answered = overview?.answers_found ?? 0;
  const abstained = overview?.abstentions ?? 0;
  const answeredTotal = answered + abstained;
  const abstentionRate =
    overview && answeredTotal > 0
      ? `${((overview.abstention_rate ?? 0) * 100).toFixed(1)}%`
      : null;
  const profileConfidence =
    overview?.average_profile_confidence !== null &&
    overview?.average_profile_confidence !== undefined
      ? `${(overview.average_profile_confidence * 100).toFixed(1)}%`
      : null;

  const axisTick = { fill: hsl(theme.mutedForeground), fontSize: 10 };
  const axisLine = { stroke: hsl(theme.border, 0.22) };
  const tooltipStyle = {
    background: hsl(theme.surface),
    border: `1px solid ${hsl(theme.border, 0.25)}`,
    borderRadius: 8,
    fontSize: 12,
    padding: "6px 10px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.10)",
  };

  const timelineData = useMemo(
    () =>
      timeline.map((point) => ({
        period: point.period,
        documents: point.documents,
        questions: point.questions,
      })),
    [timeline],
  );

  const typeData = useMemo(
    () => byType.map((item) => ({ label: item.label, count: item.count })),
    [byType],
  );

  const statusData = useMemo(
    () => byStatus.map((item) => ({ label: item.label, count: item.count })),
    [byStatus],
  );

  return (
    <PageBody>
      <PageHeader
        eyebrow="Intelligence"
        title="Analytics"
        description="What the archive contains and how it has been used. Every figure is read from the live archive — the archive-wide counts from the document records, the usage counts from your own conversations."
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        }
      />

      {error && (
        <ErrorState className="mt-6" message={error} onRetry={load} />
      )}

      {/* Archive composition */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Documents"
          value={loading ? null : (overview?.documents_total ?? 0)}
          hint={
            loading
              ? "Reading the archive…"
              : `${overview?.documents_indexed ?? 0} indexed · ${
                  overview?.documents_pending ?? 0
                } pending · ${overview?.documents_failed ?? 0} failed`
          }
        />
        <StatCard
          label="Pages extracted"
          value={loading ? null : (overview?.page_count ?? 0)}
          hint={`${overview?.chunk_count ?? 0} searchable passages`}
        />
        <StatCard
          label="Archive size"
          value={loading ? null : formatBytes(overview?.storage_bytes ?? 0)}
          hint="Sum of the stored document files"
        />
        <StatCard
          label="Entities"
          value={loading ? null : (overview?.entity_count ?? 0)}
          hint={`${overview?.entity_mention_count ?? 0} mentions recorded`}
          tone="accent"
        />
      </div>

      {/* Usage */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Questions asked"
          value={loading ? null : (overview?.questions_asked ?? 0)}
          hint={`${overview?.conversations ?? 0} conversations`}
        />
        <StatCard
          label="Answers found"
          value={loading ? null : answered}
          hint={`${abstained} honest abstentions`}
          tone="success"
        />
        <StatCard
          label="Abstention rate"
          value={loading ? null : (abstentionRate ?? "—")}
          hint={
            loading
              ? "Reading the conversation log…"
              : answeredTotal > 0
                ? `${answered} answered · ${abstained} abstained`
                : "No answered or abstained questions yet"
          }
          tone={abstentionRate === null ? "default" : "warning"}
        />
        <StatCard
          label="Citations"
          value={loading ? null : (overview?.citation_count ?? 0)}
          hint={`${overview?.searches ?? 0} searches · ${
            overview?.comparisons ?? 0
          } comparisons`}
        />
      </div>

      {/* Timeline */}
      <section className="mt-6 panel p-4 shadow-panel sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="label flex items-center gap-1.5">
            <BarChart3 className="h-3 w-3" />
            Archive activity by month
          </p>
          <p className="text-[11px] text-muted-foreground">
            {timeline.length
              ? `${timeline.length} months reported`
              : "No monthly history"}
          </p>
        </div>

        {loading ? (
          <div className="mt-3">
            <LoadingPanel label="Reading the monthly history…" rows={3} />
          </div>
        ) : timeline.length === 0 ? (
          <EmptyState
            className="mt-3 border-0"
            icon={<Activity className="h-4 w-4" />}
            title="No monthly history yet"
            description="The timeline is built from document creation and question timestamps. It fills in as the archive is used."
          />
        ) : (
          <div className="mt-3 h-[280px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={timelineData}
                margin={{ top: 8, right: 8, bottom: 0, left: -18 }}
              >
                <CartesianGrid
                  stroke={hsl(theme.border, 0.12)}
                  vertical={false}
                />
                <XAxis
                  dataKey="period"
                  tick={axisTick}
                  axisLine={axisLine}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={axisTick}
                  axisLine={axisLine}
                  tickLine={false}
                  allowDecimals={false}
                  width={46}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: hsl(theme.foreground), fontSize: 12 }}
                  itemStyle={{ color: hsl(theme.mutedForeground), fontSize: 12 }}
                  cursor={{ fill: hsl(theme.border, 0.08) }}
                />
                <Bar
                  dataKey="documents"
                  name="Documents"
                  fill={hsl(theme.accent)}
                  radius={[3, 3, 0, 0]}
                  maxBarSize={26}
                />
                <Bar
                  dataKey="questions"
                  name="Questions"
                  fill={hsl(theme.mutedForeground, 0.65)}
                  radius={[3, 3, 0, 0]}
                  maxBarSize={26}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* Breakdowns */}
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <BreakdownChart
          title="Documents by type"
          icon={<FileText className="h-3 w-3" />}
          data={typeData}
          loading={loading}
          emptyDescription="No documents are visible to your account yet."
          theme={theme}
          axisTick={axisTick}
          axisLine={axisLine}
          tooltipStyle={tooltipStyle}
        />
        <BreakdownChart
          title="Documents by status"
          icon={<Activity className="h-3 w-3" />}
          data={statusData}
          loading={loading}
          emptyDescription="No documents have been ingested yet."
          theme={theme}
          axisTick={axisTick}
          axisLine={axisLine}
          tooltipStyle={tooltipStyle}
        />
      </div>

      {/* Tables */}
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section className="panel p-4 shadow-panel">
          <p className="label">Most cited documents</p>
          {loading ? (
            <div className="mt-3">
              <LoadingPanel label="Reading the citation log…" rows={4} />
            </div>
          ) : topCited.length === 0 ? (
            <EmptyState
              className="mt-3 border-0 px-2 py-10"
              icon={<FileText className="h-4 w-4" />}
              title="Nothing has been cited yet"
              description="Citations appear as soon as answers cite a passage in one of your documents."
            />
          ) : (
            <div className="mt-2.5 overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Citations</th>
                    <th>Mentions</th>
                  </tr>
                </thead>
                <tbody>
                  {topCited.map((doc) => (
                    <tr key={doc.document_id}>
                      <td>
                        <Link
                          href={`/library/${doc.document_id}`}
                          className="text-[13px] font-medium transition-colors hover:text-accent"
                        >
                          {doc.filename ?? `Document ${doc.document_id.slice(0, 8)}`}
                        </Link>
                      </td>
                      <td className="font-mono text-[12px]">{doc.citations}</td>
                      <td className="font-mono text-[12px] text-muted-foreground">
                        {doc.mentions}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel p-4 shadow-panel">
          <p className="label">Most mentioned entities</p>
          {loading ? (
            <div className="mt-3">
              <LoadingPanel label="Reading the entity index…" rows={4} />
            </div>
          ) : topEntities.length === 0 ? (
            <EmptyState
              className="mt-3 border-0 px-2 py-10"
              icon={<Search className="h-4 w-4" />}
              title="No entities extracted yet"
              description="Entities appear once the extraction pass has read the documents in your scope."
            />
          ) : (
            <div className="mt-2.5 overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Entity</th>
                    <th>Mentions</th>
                  </tr>
                </thead>
                <tbody>
                  {topEntities.map((entity) => (
                    <tr key={entity.key}>
                      <td className="text-[13px] font-medium">
                        {entity.label || entity.key}
                      </td>
                      <td className="font-mono text-[12px]">{entity.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* Every remaining figure */}
      <section className="mt-5 panel p-4 shadow-panel sm:p-5">
        <p className="label flex items-center gap-1.5">
          <MessageSquare className="h-3 w-3" />
          Complete figures
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Every number the analytics endpoint returns, including the ones
          without a headline of their own.
          {overview?.generated_at
            ? ` Generated ${formatDate(overview.generated_at)}.`
            : ""}
        </p>

        {loading ? (
          <div className="mt-3">
            <LoadingPanel label="Reading the full report…" rows={3} />
          </div>
        ) : (
          <dl className="mt-3 grid gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ["Document profiles", overview?.profile_count ?? 0],
              [
                "Average profile confidence",
                profileConfidence ?? "—",
              ],
              ["Entity mentions", overview?.entity_mention_count ?? 0],
              ["Searches", overview?.searches ?? 0],
              ["Comparisons", overview?.comparisons ?? 0],
              ["Research reports", overview?.research_reports ?? 0],
              ["Extraction runs", overview?.extraction_runs ?? 0],
              ["Extraction rows", overview?.extraction_rows ?? 0],
              ["Graph nodes", overview?.graph_nodes ?? 0],
              ["Graph edges", overview?.graph_edges ?? 0],
              ["Searchable passages", overview?.chunk_count ?? 0],
              ["Pages extracted", overview?.page_count ?? 0],
            ].map(([label, value]) => (
              <div
                key={label as string}
                className="flex items-baseline justify-between gap-3 border-b border-border/70 pb-2"
              >
                <dt className="text-[12px] text-muted-foreground">{label}</dt>
                <dd className="font-mono text-[12px] font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
        )}

        {profileConfidence === null && !loading && (
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Average profile confidence reads as “—” because no document profile
            has recorded a confidence score yet. That is missing data, not a
            score of zero.
          </p>
        )}
      </section>
    </PageBody>
  );
}

function BreakdownChart({
  title,
  icon,
  data,
  loading,
  emptyDescription,
  theme,
  axisTick,
  axisLine,
  tooltipStyle,
}: {
  title: string;
  icon: React.ReactNode;
  data: { label: string; count: number }[];
  loading: boolean;
  emptyDescription: string;
  theme: ChartTheme;
  axisTick: { fill: string; fontSize: number };
  axisLine: { stroke: string };
  tooltipStyle: React.CSSProperties;
}) {
  return (
    <section className="panel p-4 shadow-panel">
      <p className="label flex items-center gap-1.5">
        {icon}
        {title}
      </p>
      {loading ? (
        <div className="mt-3">
          <LoadingPanel label="Reading the breakdown…" rows={3} />
        </div>
      ) : data.length === 0 ? (
        <EmptyState
          className="mt-3 border-0 px-2 py-10"
          icon={<BarChart3 className="h-4 w-4" />}
          title="Nothing to break down"
          description={emptyDescription}
        />
      ) : (
        <div className="mt-3 h-[260px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 4, right: 16, bottom: 0, left: 8 }}
            >
              <CartesianGrid
                stroke={hsl(theme.border, 0.12)}
                horizontal={false}
              />
              <XAxis
                type="number"
                tick={axisTick}
                axisLine={axisLine}
                tickLine={false}
                allowDecimals={false}
              />
              <YAxis
                type="category"
                dataKey="label"
                tick={axisTick}
                axisLine={axisLine}
                tickLine={false}
                width={104}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: hsl(theme.foreground), fontSize: 12 }}
                itemStyle={{ color: hsl(theme.mutedForeground), fontSize: 12 }}
                cursor={{ fill: hsl(theme.border, 0.08) }}
              />
              <Bar
                dataKey="count"
                name="Documents"
                fill={hsl(theme.accent)}
                radius={[0, 3, 3, 0]}
                maxBarSize={22}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
