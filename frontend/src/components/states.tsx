"use client";

import { AlertCircle, Loader2, Inbox, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** A calm, honest empty state. Never a spinner pretending to be content. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-12 text-center",
        className,
      )}
    >
      <span className="grid h-9 w-9 place-items-center rounded-full bg-muted text-muted-foreground">
        {icon ?? <Inbox className="h-4 w-4" />}
      </span>
      <p className="mt-3 text-[13px] font-semibold">{title}</p>
      {description && (
        <p className="mt-1 max-w-md text-[12px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** An error state that names the failure and offers the way out. */
export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  className,
}: {
  title?: string;
  message?: string | null;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-2 rounded-lg border border-danger/30 bg-danger/6 px-4 py-3.5",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle className="mt-px h-4 w-4 shrink-0 text-danger" />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-danger">{title}</p>
          {message && (
            <p className="mt-0.5 text-[12px] leading-relaxed text-danger/85">
              {message}
            </p>
          )}
        </div>
      </div>
      {onRetry && (
        <Button variant="outline" size="xs" onClick={onRetry} className="ml-6">
          <RefreshCw className="h-3 w-3" />
          Try again
        </Button>
      )}
    </div>
  );
}

/** A skeleton block used while a panel's data is in flight. */
export function LoadingPanel({
  label = "Loading…",
  rows = 3,
  className,
}: {
  label?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-3", className)} aria-busy="true">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {label}
      </div>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="skeleton h-11 rounded-md"
          style={{ opacity: 1 - index * 0.16 }}
        />
      ))}
    </div>
  );
}

/** A single headline figure with an optional supporting line. */
export function StatCard({
  label,
  value,
  hint,
  tone = "default",
  className,
}: {
  label: string;
  value: string | number | null;
  hint?: string;
  tone?: "default" | "accent" | "success" | "warning" | "danger";
  className?: string;
}) {
  const valueTone = {
    default: "text-foreground",
    accent: "text-accent",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  }[tone];

  return (
    <div className={cn("panel p-4 shadow-panel", className)}>
      <p className="label">{label}</p>
      <p
        className={cn(
          "mt-1.5 font-mono text-[22px] font-semibold leading-none tracking-tight",
          valueTone,
        )}
      >
        {value === null || value === undefined ? "—" : value}
      </p>
      {hint && (
        <p className="mt-1.5 truncate text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** A small inline legend/count row used above tables. */
export function CountPills({
  items,
}: {
  items: { label: string; value: number; tone?: string }[];
}) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((item) => (
        <span key={item.label} className="chip bg-muted text-muted-foreground">
          <span className={cn("font-mono", item.tone)}>{item.value}</span>
          {item.label}
        </span>
      ))}
    </div>
  );
}
