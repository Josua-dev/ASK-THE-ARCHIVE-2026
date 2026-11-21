"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "ata.theme";

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
  /** The theme actually in effect, after "system" has been resolved. */
  theme: ResolvedTheme;
  /** Switch to an explicit theme, leaving "system" behind. */
  setTheme: (theme: ResolvedTheme) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

/** Read the stored preference. Runs only in the browser. */
function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system"
    ? stored
    : "system";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("light");

  // Adopt the stored preference after mount. The inline script in the root
  // layout has already painted the correct theme, so this only syncs state.
  useEffect(() => {
    setModeState(readStoredMode());
  }, []);

  useEffect(() => {
    const apply = () => {
      const dark = mode === "system" ? systemPrefersDark() : mode === "dark";
      setResolved(dark ? "dark" : "light");
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };

    apply();
    if (mode !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  }, []);

  const toggle = useCallback(() => {
    setMode(resolved === "dark" ? "light" : "dark");
  }, [resolved, setMode]);

  const value = useMemo(
    () => ({
      mode,
      resolved,
      setMode,
      toggle,
      theme: resolved,
      setTheme: (next: ResolvedTheme) => setMode(next),
    }),
    [mode, resolved, setMode, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}

/**
 * Runs before paint to stop the page flashing light before the React tree
 * mounts. Kept in sync with the tokens in globals.css.
 */
export const themeBootstrapScript = `(function(){try{var m=localStorage.getItem('ata.theme')||'system';var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
