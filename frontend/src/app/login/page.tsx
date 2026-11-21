"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/primitives";
import { Wordmark } from "@/components/ui";

const HIGHLIGHTS = [
  "Permission-aware retrieval across every document you may read",
  "Every answer carries citations you can open and verify",
  "Honest abstention when the archive has no answer",
];

export default function LoginPage() {
  const router = useRouter();
  const { login, user, loading } = useAuth();
  const { theme, setTheme } = useTheme();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [loading, user, router]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      router.replace("/dashboard");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not reach the archive service. Is the backend running?",
      );
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Narrative panel — the engineering-practice proposition. */}
      <aside className="grid-field relative hidden flex-col justify-between border-r border-border bg-surface p-10 lg:flex">
        <Wordmark />

        <div className="max-w-md">
          <p className="label mb-3">Organisational knowledge intelligence</p>
          <h1 className="text-[34px] font-semibold leading-[1.12] tracking-tight">
            Your organisation has answers.
            <br />
            <span className="text-accent">Find them.</span>
          </h1>
          <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
            Ask the Archive reads every document your account is permitted to
            read, answers with the evidence attached, and says so plainly when
            the record is silent.
          </p>

          <ul className="mt-8 space-y-3">
            {HIGHLIGHTS.map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                <span className="text-[13px] leading-relaxed text-muted-foreground">
                  {item}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center gap-6 text-[11px] text-muted-foreground">
          <span>Local inference · Ollama</span>
          <span className="h-3 w-px bg-border" />
          <span>Local vectors · pgvector</span>
          <span className="h-3 w-px bg-border" />
          <span>Open-source extraction</span>
        </div>
      </aside>

      {/* Sign-in panel */}
      <main className="flex flex-col bg-background">
        <div className="flex items-center justify-between p-5">
          <div className="lg:hidden">
            <Wordmark />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="ml-auto text-muted-foreground"
          >
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </Button>
        </div>

        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <form onSubmit={onSubmit} className="w-full max-w-[380px]">
            <p className="label mb-2">Sign in</p>
            <h2 className="text-[24px] font-semibold tracking-tight">
              Enter the workspace
            </h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              Use the account issued to you by your archive administrator.
            </p>

            <div className="mt-7 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email address</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@organisation.gov"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={reveal ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="••••••••••••"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setReveal((prev) => !prev)}
                    aria-label={reveal ? "Hide password" : "Show password"}
                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {reveal ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="mt-4 rounded-md border border-danger/30 bg-danger/8 px-3 py-2.5 text-[12px] leading-relaxed text-danger"
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              variant="accent"
              size="lg"
              disabled={busy}
              className="mt-6 w-full"
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>

            <p className="mt-6 text-[11px] leading-relaxed text-muted-foreground">
              Accounts are provisioned by an administrator. All sign-ins and
              document access are recorded in the audit trail.
            </p>
          </form>
        </div>
      </main>
    </div>
  );
}
