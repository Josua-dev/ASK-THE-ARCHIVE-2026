"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Filter,
  Loader2,
  Search,
  ShieldAlert,
  ScrollText,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import type { AuditEntry, User } from "@/lib/types";
import { formatDate, formatRelative } from "@/lib/utils";
import { PageBody, PageHeader } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  LoadingPanel,
  StatCard,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Render an audit metadata value without losing its shape. */
function metaValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default function AdminAuditPage() {
  const { user } = useAuth();
  const toast = useToast();

  const isAdmin = user?.role === "admin";

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [accounts, setAccounts] = useState<User[]>([]);
  const [knownActions, setKnownActions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exactAction, setExactAction] = useState("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(
    async (action: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const [audit, users] = await Promise.all([
          api.adminAudit(200, action),
          api.adminUsers().catch(() => null),
        ]);
        setEntries(audit);
        if (users) setAccounts(users.items);
        setKnownActions((previous) => {
          const merged = new Set(previous);
          audit.forEach((entry) => merged.add(entry.action));
          return Array.from(merged).sort();
        });
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Could not read the audit trail.",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    load(exactAction === "all" ? null : exactAction);
  }, [isAdmin, exactAction, load]);

  const accountById = useMemo(() => {
    const map = new Map<string, User>();
    accounts.forEach((account) => map.set(account.id, account));
    return map;
  }, [accounts]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return entries;
    return entries.filter((entry) => entry.action.toLowerCase().includes(term));
  }, [entries, query]);

  const actorCount = useMemo(() => {
    const ids = new Set(entries.map((entry) => entry.actor_user_id ?? ""));
    return ids.size;
  }, [entries]);

  const withMeta = useMemo(
    () => entries.filter((entry) => entry.meta && Object.keys(entry.meta).length > 0)
      .length,
    [entries],
  );

  if (!isAdmin) {
    return (
      <PageBody>
        <PageHeader
          eyebrow="Administration"
          title="Audit Centre"
          description="The record of security-relevant events across the archive."
        />
        <EmptyState
          className="mt-6 panel border-dashed"
          icon={<ShieldAlert className="h-4 w-4" />}
          title="Administrator access required"
          description="The audit trail records authentication, retrieval and administrative changes. It is reserved for administrators."
        />
      </PageBody>
    );
  }

  return (
    <PageBody>
      <PageHeader
        eyebrow="Administration"
        title="Audit Centre"
        description="Every security-relevant event the backend has recorded, newest first. Actions are shown as the machine-readable tokens the backend writes, so they can be matched exactly against the logs."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              load(exactAction === "all" ? null : exactAction)
            }
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ScrollText className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        }
      />

      {error && (
        <ErrorState
          className="mt-6"
          message={error}
          onRetry={() => load(exactAction === "all" ? null : exactAction)}
        />
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Entries loaded"
          value={loading ? null : entries.length}
          hint="Most recent first"
        />
        <StatCard
          label="Distinct actions"
          value={loading ? null : knownActions.length}
          hint="Machine-readable tokens"
          tone="accent"
        />
        <StatCard
          label="Distinct actors"
          value={loading ? null : actorCount}
          hint="Accounts and system events"
        />
        <StatCard
          label="With metadata"
          value={loading ? null : withMeta}
          hint="Entries carrying extra context"
        />
      </div>

      {/* Filters */}
      <section className="mt-6 flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <label
            htmlFor="audit-search"
            className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
          >
            Filter by action
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="audit-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="document.view, insights.scan…"
              className="pl-8 font-mono"
            />
          </div>
        </div>

        <div className="w-[220px]">
          <label
            htmlFor="audit-action"
            className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
          >
            Exact action
          </label>
          <Select value={exactAction} onValueChange={setExactAction}>
            <SelectTrigger id="audit-action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {knownActions.map((action) => (
                <SelectItem key={action} value={action} className="font-mono">
                  {action}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>

      {knownActions.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Filter className="h-3 w-3 text-muted-foreground" />
          {knownActions.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => setQuery(action)}
              className="chip bg-muted font-mono text-muted-foreground transition-colors hover:bg-accent/12 hover:text-accent"
            >
              {action}
            </button>
          ))}
        </div>
      )}

      <section className="mt-4 overflow-hidden rounded-lg border border-border bg-surface">
        {loading ? (
          <div className="p-4">
            <LoadingPanel label="Reading the audit trail…" rows={6} />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            className="m-4 border-0"
            icon={<ScrollText className="h-4 w-4" />}
            title={
              exactAction === "all"
                ? "Nothing has been recorded yet"
                : `No entries for ${exactAction}`
            }
            description={
              exactAction === "all"
                ? "Authentication, retrieval and administrative changes are written here as they happen."
                : "Choose a different action, or clear the exact-action filter to see the whole trail."
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            className="m-4 border-0"
            icon={<Search className="h-4 w-4" />}
            title="No entry matches that filter"
            description="Clear the text filter to see every loaded entry again."
            action={
              <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                Clear filter
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>IP</th>
                  <th className="text-right">Details</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((entry) => {
                  const actor = entry.actor_user_id
                    ? accountById.get(entry.actor_user_id)
                    : undefined;
                  const hasMeta =
                    entry.meta && Object.keys(entry.meta).length > 0;
                  const isOpen = expanded === entry.id;

                  return (
                    <Fragment key={entry.id}>
                      <tr>
                        <td className="whitespace-nowrap">
                          <p className="text-[12px]">
                            {formatRelative(entry.created_at)}
                          </p>
                          <p className="font-mono text-[10px] text-muted-foreground">
                            {formatDate(entry.created_at, {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </p>
                        </td>
                        <td>
                          <p className="text-[12px] font-medium">
                            {actor?.display_name ??
                              (entry.actor_user_id
                                ? `Account ${entry.actor_user_id.slice(0, 8)}`
                                : "System")}
                          </p>
                          {actor?.email && (
                            <p className="text-[11px] text-muted-foreground">
                              {actor.email}
                            </p>
                          )}
                        </td>
                        <td>
                          <span className="chip bg-muted font-mono text-muted-foreground">
                            {entry.action}
                          </span>
                        </td>
                        <td className="text-[12px] text-muted-foreground">
                          {entry.resource_type ? (
                            <>
                              <span className="text-foreground">
                                {entry.resource_type}
                              </span>
                              {entry.resource_id && (
                                <span className="ml-1 font-mono text-[11px]">
                                  {entry.resource_id.slice(0, 8)}
                                </span>
                              )}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="font-mono text-[11px] text-muted-foreground">
                          {entry.ip ?? "—"}
                        </td>
                        <td>
                          <div className="flex justify-end">
                            {hasMeta ? (
                              <Button
                                size="xs"
                                variant="ghost"
                                aria-expanded={isOpen}
                                onClick={() => setExpanded(isOpen ? null : entry.id)}
                              >
                                {isOpen ? (
                                  <ChevronDown className="h-3 w-3" />
                                ) : (
                                  <ChevronRight className="h-3 w-3" />
                                )}
                                {isOpen ? "Hide" : "Show"}
                              </Button>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">
                                —
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>

                      {hasMeta && isOpen && (
                        <tr className="bg-muted/30">
                          <td colSpan={6} className="px-4 py-3">
                            <p className="label mb-1.5">Metadata</p>
                            <dl className="space-y-1">
                              {Object.entries(entry.meta ?? {}).map(
                                ([key, value]) => (
                                  <div
                                    key={key}
                                    className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px]"
                                  >
                                    <dt className="font-mono text-[11px] text-muted-foreground">
                                      {key}
                                    </dt>
                                    <dd className="min-w-0 break-words">
                                      {metaValue(value)}
                                    </dd>
                                  </div>
                                ),
                              )}
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {visible.length > 0 && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Showing {visible.length} of {entries.length} loaded entr
          {entries.length === 1 ? "y" : "ies"}.
        </p>
      )}
    </PageBody>
  );
}
