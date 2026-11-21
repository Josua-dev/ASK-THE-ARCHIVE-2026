"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Cpu,
  Database,
  Loader2,
  RefreshCw,
  ServerCog,
  Settings2,
  ShieldAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Analytics } from "@/lib/types";
import { formatBytes, formatDate } from "@/lib/utils";
import { PageBody, PageHeader } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  LoadingPanel,
  StatCard,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/primitives";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function humanise(token: string) {
  return token.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/**
 * The health endpoint reports the providers the running instance is actually
 * using. The friendly labels below only rename the keys the backend is known
 * to publish; anything else it returns is rendered under its own name rather
 * than hidden.
 */
const PROVIDER_LABELS: Record<string, string> = {
  llm: "Answering model provider",
  llm_model: "Answering model",
  embedder: "Embeddings provider",
  embedder_model: "Embedding model",
  extractor: "Extraction provider",
  storage: "Storage backend",
};

const TOP_LEVEL_LABELS: Record<string, string> = {
  status: "Service status",
};

function ConfigValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="font-mono text-[12px] text-muted-foreground">—</span>;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <span className="font-mono text-[12px]">{String(value)}</span>;
  }
  return (
    <details className="w-full">
      <summary className="cursor-pointer text-[11px] text-accent transition-colors hover:underline">
        Show raw value
      </summary>
      <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-background p-2.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

export default function AdminSettingsPage() {
  const { user } = useAuth();

  const isAdmin = user?.role === "admin";

  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);

    const [healthResult, analyticsResult] = await Promise.allSettled([
      api.health(),
      api.analytics(),
    ]);

    if (healthResult.status === "fulfilled") {
      setHealth(healthResult.value);
      setHealthError(null);
    } else {
      setHealthError(
        healthResult.reason instanceof Error
          ? healthResult.reason.message
          : "The health endpoint did not answer.",
      );
    }

    if (analyticsResult.status === "fulfilled") {
      setAnalytics(analyticsResult.value);
      setAnalyticsError(null);
    } else {
      setAnalyticsError(
        analyticsResult.reason instanceof Error
          ? analyticsResult.reason.message
          : "The analytics endpoint did not answer.",
      );
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    load();
  }, [isAdmin, load]);

  const providers = useMemo(
    () => (isRecord(health?.providers) ? health.providers : null),
    [health],
  );

  const providerRows = useMemo(() => {
    if (!providers) return [];
    const known = Object.keys(PROVIDER_LABELS).filter((key) => key in providers);
    const extra = Object.keys(providers)
      .filter((key) => !(key in PROVIDER_LABELS))
      .sort();
    return [...known, ...extra].map((key) => ({
      key,
      label: PROVIDER_LABELS[key] ?? humanise(key),
      value: providers[key],
    }));
  }, [providers]);

  const topLevelRows = useMemo(() => {
    if (!health) return [];
    return Object.entries(health)
      .filter(([key]) => key !== "providers")
      .map(([key, value]) => ({
        key,
        label: TOP_LEVEL_LABELS[key] ?? humanise(key),
        value,
      }));
  }, [health]);

  const overview = analytics?.overview;

  if (!isAdmin) {
    return (
      <PageBody>
        <PageHeader
          eyebrow="Administration"
          title="Settings"
          description="The effective configuration of the running system."
        />
        <EmptyState
          className="mt-6 panel border-dashed"
          icon={<ShieldAlert className="h-4 w-4" />}
          title="Administrator access required"
          description="The system configuration is reserved for administrators."
        />
      </PageBody>
    );
  }

  return (
    <PageBody>
      <PageHeader
        eyebrow="Administration"
        title="Settings"
        description="The effective configuration of this running instance, read live from the backend. Nothing on this page can be changed from the workspace."
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

      <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-border bg-surface px-4 py-3">
        <Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          These values are managed by an administrator in the server
          configuration file and take effect when the backend restarts. This
          workspace shows the effective values of the running system — it does
          not write to them.
        </p>
      </div>

      {/* System configuration */}
      <section className="mt-5 panel p-4 shadow-panel sm:p-5">
        <p className="label flex items-center gap-1.5">
          <ServerCog className="h-3 w-3" />
          System configuration
        </p>

        {loading ? (
          <div className="mt-3">
            <LoadingPanel label="Reading the running configuration…" rows={4} />
          </div>
        ) : healthError ? (
          <ErrorState
            className="mt-3"
            title="The health endpoint did not answer"
            message={healthError}
            onRetry={load}
          />
        ) : providerRows.length === 0 && topLevelRows.length === 0 ? (
          <EmptyState
            className="mt-3 border-0 px-2 py-10"
            icon={<ServerCog className="h-4 w-4" />}
            title="No configuration reported"
            description="The backend answered the health check without describing any providers."
          />
        ) : (
          <div className="mt-3 space-y-4">
            {topLevelRows.length > 0 && (
              <div>
                <p className="label mb-1.5">Service</p>
                <dl className="space-y-1">
                  {topLevelRows.map((row) => (
                    <div
                      key={row.key}
                      className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/70 pb-2"
                    >
                      <dt className="text-[12px] text-muted-foreground">
                        {row.label}
                      </dt>
                      <dd className="min-w-0 text-right">
                        <ConfigValue value={row.value} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {providerRows.length > 0 && (
              <div>
                <p className="label mb-1.5">Providers in use</p>
                <dl className="space-y-1">
                  {providerRows.map((row) => (
                    <div
                      key={row.key}
                      className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/70 pb-2"
                    >
                      <dt className="text-[12px] text-muted-foreground">
                        {row.label}
                      </dt>
                      <dd className="min-w-0 text-right">
                        <ConfigValue value={row.value} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Archive overview */}
      <section className="mt-5">
        <p className="label flex items-center gap-1.5">
          <Activity className="h-3 w-3" />
          Archive overview
        </p>

        {loading ? (
          <div className="mt-2.5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="skeleton h-[74px] rounded-lg" />
            ))}
          </div>
        ) : analyticsError ? (
          <ErrorState
            className="mt-2.5"
            title="The archive overview could not be read"
            message={analyticsError}
            onRetry={load}
          />
        ) : (
          <>
            <div className="mt-2.5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Documents"
                value={overview?.documents_total ?? 0}
                hint={`${overview?.documents_indexed ?? 0} indexed · ${
                  overview?.documents_pending ?? 0
                } pending`}
              />
              <StatCard
                label="Storage"
                value={formatBytes(overview?.storage_bytes ?? 0)}
                hint={`${overview?.page_count ?? 0} pages · ${
                  overview?.chunk_count ?? 0
                } passages`}
                tone="accent"
              />
              <StatCard
                label="Entities"
                value={overview?.entity_count ?? 0}
                hint={`${overview?.entity_mention_count ?? 0} mentions`}
              />
              <StatCard
                label="Profiles"
                value={overview?.profile_count ?? 0}
                hint={
                  overview?.average_profile_confidence === null ||
                  overview?.average_profile_confidence === undefined
                    ? "No profile data yet"
                    : `${(overview.average_profile_confidence * 100).toFixed(
                        1,
                      )}% average confidence`
                }
                tone="success"
              />
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Conversations"
                value={overview?.conversations ?? 0}
                hint={`${overview?.questions_asked ?? 0} questions asked`}
              />
              <StatCard
                label="Answers found"
                value={overview?.answers_found ?? 0}
                hint={`${overview?.abstentions ?? 0} abstentions`}
              />
              <StatCard
                label="Citations"
                value={overview?.citation_count ?? 0}
                hint={`${overview?.searches ?? 0} searches`}
              />
              <StatCard
                label="Research reports"
                value={overview?.research_reports ?? 0}
                hint={`${overview?.comparisons ?? 0} comparisons · ${
                  overview?.extraction_runs ?? 0
                } extraction runs`}
              />
            </div>

            <div className="mt-3 panel p-4 shadow-panel">
              <p className="label flex items-center gap-1.5">
                <Database className="h-3 w-3" />
                Runtime detail
              </p>
              <dl className="mt-3 grid gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ["Documents failed", overview?.documents_failed ?? 0],
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

              {overview?.generated_at && (
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Overview generated {formatDate(overview.generated_at)}.
                </p>
              )}
            </div>
          </>
        )}
      </section>

      <Separator className="mt-6" />

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <p className="flex max-w-xl items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
          <Cpu className="mt-px h-3.5 w-3.5 shrink-0" />
          Every figure and provider name above was read from the running
          backend just now. If a value is missing, the backend did not report
          it — this page never substitutes a default.
        </p>
        <Badge variant="outline">Read-only</Badge>
      </div>
    </PageBody>
  );
}
