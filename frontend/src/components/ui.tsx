"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  BarChart3,
  CalendarClock,
  Columns2,
  Compass,
  FolderOpen,
  Gauge,
  KeyRound,
  Layers,
  LogOut,
  Moon,
  Network,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Table2,
  Users,
  MessageSquare,
  Warehouse,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { navForRole, type NavItem } from "@/lib/nav";
import { cn, initials } from "@/lib/utils";
import { CommandPalette } from "@/components/command-palette";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/primitives";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  gauge: Gauge,
  spark: Sparkles,
  compass: Compass,
  chat: MessageSquare,
  folder: FolderOpen,
  stack: Layers,
  columns: Columns2,
  network: Network,
  table: Table2,
  alert: AlertTriangle,
  calendar: CalendarClock,
  chart: BarChart3,
  users: Users,
  key: KeyRound,
  shield: ShieldCheck,
  sliders: Settings2,
  warehouse: Warehouse,
};

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/dashboard" className="flex shrink-0 items-center gap-2.5">
      <span className="relative grid h-8 w-8 place-items-center rounded-lg bg-primary">
        <span className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/15" />
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="hsl(var(--accent))"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 5h7l2 3h7v11H4z" />
          <path d="M8 12h6" />
        </svg>
      </span>
      {!compact && (
        <span className="leading-tight">
          <span className="block text-[13px] font-semibold tracking-tight">
            Ask the Archive
          </span>
          <span className="label block text-[9px]">Document intelligence</span>
        </span>
      )}
    </Link>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = ICONS[item.icon] ?? Gauge;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon
        className={cn(
          "h-[15px] w-[15px] shrink-0",
          active ? "opacity-100" : "opacity-65 group-hover:opacity-100",
        )}
      />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const pathname = usePathname();
  const groups = navForRole(user?.role);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-[248px] shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-16 items-center border-b border-border px-5">
          <Wordmark />
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Primary">
          {groups.map((group, index) => (
            <div key={group.id} className={cn(index > 0 && "mt-5")}>
              <p className="label mb-1.5 px-2.5">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink key={item.href} item={item} active={isActive(item.href)} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-border p-3">
          <button
            onClick={logout}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] font-bold text-accent">
              {initials(user?.display_name)}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[12px] font-semibold">
                {user?.display_name}
              </span>
              <span className="label block text-[9px]">{user?.role}</span>
            </span>
            <LogOut className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-border bg-surface/85 px-4 backdrop-blur-md lg:px-6">
          <div className="lg:hidden">
            <Wordmark compact />
          </div>

          <button
            onClick={() =>
              document.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: "k",
                  metaKey: true,
                  ctrlKey: true,
                }),
              )
            }
            className="group ml-auto flex h-9 w-full max-w-[320px] items-center gap-2.5 rounded-md border border-input bg-background px-3 text-[13px] text-muted-foreground transition-colors hover:border-accent/50 hover:text-foreground"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 text-left">Search the archive…</span>
            <span className="kbd shrink-0">⌘K</span>
          </button>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                aria-label="Account menu"
              >
                <span className="grid h-7 w-7 place-items-center rounded-full bg-accent/15 text-[10px] font-bold text-accent">
                  {initials(user?.display_name)}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                {user?.display_name}
                <span className="mt-0.5 block font-normal normal-case tracking-normal text-muted-foreground">
                  {user?.email}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setTheme(theme === "dark" ? "light" : "dark")}>
                {theme === "dark" ? (
                  <Sun className="h-3.5 w-3.5" />
                ) : (
                  <Moon className="h-3.5 w-3.5" />
                )}
                Toggle theme
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={logout}>
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>

      <CommandPalette />
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="label mb-1.5">{eyebrow}</p>}
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Page body wrapper — consistent gutters and rhythm across every route. */
export function PageBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-[1400px] px-4 py-6 lg:px-8 lg:py-8", className)}>
      {children}
    </div>
  );
}

const DOC_TYPE_TONE: Record<string, string> = {
  lease: "bg-accent/12 text-accent",
  contract: "bg-primary/8 text-foreground/75",
  policy: "bg-success/12 text-success",
  invoice: "bg-warning/14 text-warning",
  nda: "bg-[#6B4E9B]/12 text-[#5A3F86] dark:text-[#A78BD6]",
  report: "bg-muted text-muted-foreground",
  agreement: "bg-accent/12 text-accent",
  survey: "bg-success/12 text-success",
  memorandum: "bg-primary/8 text-foreground/75",
  other: "bg-muted text-muted-foreground",
};

export function DocTypeChip({ type }: { type: string | null }) {
  const key = (type ?? "other").toLowerCase();
  return (
    <span className={`chip ${DOC_TYPE_TONE[key] ?? DOC_TYPE_TONE.other}`}>
      {key.toUpperCase()}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  ready: "bg-success",
  indexed: "bg-success",
  complete: "bg-success",
  completed: "bg-success",
  uploaded: "bg-warning",
  pending: "bg-warning",
  processing: "bg-warning animate-pulse",
  running: "bg-warning animate-pulse",
  queued: "bg-muted-foreground",
  failed: "bg-danger",
  error: "bg-danger",
};

export function StatusDot({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          STATUS_TONE[status?.toLowerCase()] ?? "bg-muted-foreground",
        )}
      />
      <span className="text-[11px] capitalize text-muted-foreground">{status}</span>
    </span>
  );
}

/** Section heading used inside panels. */
export function SectionTitle({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[13px] font-semibold tracking-tight">{children}</h2>
      {action}
    </div>
  );
}

export { Separator };
