"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import {
  ArrowRight,
  CornerDownLeft,
  FileText,
  LogOut,
  Moon,
  Search,
  Sun,
} from "lucide-react";
import { useTheme } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import { navForRole } from "@/lib/nav";
import { cn } from "@/lib/utils";

interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: React.ReactNode;
  run: () => void;
}

/**
 * Command palette (⌘K / Ctrl+K).
 *
 * Navigation is role-aware, so the palette only offers pages the signed-in
 * user can actually open.
 */
export function CommandPalette() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const go = React.useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const actions = React.useMemo<PaletteAction[]>(() => {
    const pages = navForRole(user?.role).flatMap((group) =>
      group.items.map((item) => ({
        id: item.href,
        label: item.label,
        hint: group.label,
        group: "Navigate",
        icon: <FileText className="h-3.5 w-3.5" />,
        run: () => go(item.href),
      })),
    );

    return [
      ...pages,
      {
        id: "theme",
        label: theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
        group: "Preferences",
        icon: theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />,
        run: () => {
          setTheme(theme === "dark" ? "light" : "dark");
          setOpen(false);
        },
      },
      {
        id: "signout",
        label: "Sign out",
        group: "Account",
        icon: <LogOut className="h-3.5 w-3.5" />,
        run: () => {
          setOpen(false);
          logout();
          router.push("/login");
        },
      },
    ];
  }, [user?.role, theme, go, setTheme, logout, router]);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      shouldFilter
      className={cn(
        "fixed left-1/2 top-[12vh] z-[90] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2",
        "overflow-hidden rounded-xl border border-border bg-surface text-foreground shadow-2xl",
        "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1",
        "[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.07em] [&_[cmdk-group-heading]]:text-muted-foreground",
        "[&_[cmdk-input-wrapper]]:border-b [&_[cmdk-input-wrapper]]:border-border",
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-border px-3.5">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Command.Input
          autoFocus
          placeholder="Search pages and actions…"
          className="h-11 w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
        />
      </div>
      <Command.List className="max-h-[320px] overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-6 text-center text-[12px] text-muted-foreground">
          No matching command.
        </Command.Empty>
        {actions.map((action) => (
          <Command.Item
            key={action.id}
            value={`${action.group} ${action.label}`}
            onSelect={action.run}
            className={cn(
              "flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px]",
              "data-[selected=true]:bg-muted data-[selected=true]:text-foreground",
            )}
          >
            <span className="text-muted-foreground">{action.icon}</span>
            <span className="min-w-0 flex-1 truncate">{action.label}</span>
            {action.hint && (
              <span className="text-[10px] uppercase tracking-[0.07em] text-muted-foreground">
                {action.hint}
              </span>
            )}
            <CornerDownLeft className="h-3 w-3 text-muted-foreground/50" />
          </Command.Item>
        ))}
      </Command.List>
      <div className="flex items-center justify-between border-t border-border px-3.5 py-2 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <ArrowRight className="h-3 w-3" />
          Jump to any page
        </span>
        <span className="kbd">Esc</span>
      </div>
    </Command.Dialog>
  );
}
