"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ChevronRight,
  FileText,
  Loader2,
  MessageSquarePlus,
  Quote,
  ShieldQuestion,
  Sparkles,
} from "lucide-react";
import { api, streamAnswer } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { Citation, Passage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/overlays";
import { Separator } from "@/components/ui/primitives";

interface Turn {
  id: string;
  question: string;
  answer: string;
  passages: Passage[];
  citations: Citation[];
  found: boolean | null;
  intent: string;
  model: string;
  streaming: boolean;
  error?: string;
}

const STARTERS = [
  "Which lease agreements expire next year?",
  "Summarise the Kestrel facilities contract.",
  "What are our data retention obligations?",
  "Who are the parties to the Ridgeline supply agreement?",
];

export default function AskPage() {
  const params = useSearchParams();
  const toast = useToast();

  const [question, setQuestion] = useState(params.get("q") ?? "");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const ask = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || busy) return;
      setBusy(true);
      setQuestion("");

      const turn: Turn = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        question: trimmed,
        answer: "",
        passages: [],
        citations: [],
        found: null,
        intent: "",
        model: "",
        streaming: true,
      };
      setTurns((all) => [...all, turn]);

      // Every streaming callback patches the same list the transcript renders
      // from, so the streamed answer lands in the right turn.
      const patch = (updater: (t: Turn) => Turn) =>
        setTurns((all) => all.map((t) => (t.id === turn.id ? updater(t) : t)));

      await streamAnswer(
        trimmed,
        {
          onEvidence: (payload) =>
            patch((cur) => ({
              ...cur,
              intent: payload.intent,
              found: payload.found,
              passages: payload.passages ?? [],
            })),
          onDelta: (text) =>
            patch((cur) => ({ ...cur, answer: cur.answer + text })),
          onCitations: (citations) =>
            patch((cur) => ({ ...cur, citations: citations ?? [] })),
          onDone: (payload) => {
            patch((cur) => ({
              ...cur,
              found: Boolean(payload?.found),
              streaming: false,
            }));
            setBusy(false);
          },
          onError: (message) => {
            patch((cur) => ({ ...cur, error: message, streaming: false }));
            setBusy(false);
            toast.error("The archive could not answer", message);
          },
        },
        conversationId,
      );
      setBusy(false);
    },
    [busy, conversationId, toast],
  );

  function startNewThread() {
    setTurns([]);
    setConversationId(null);
    setQuestion("");
    composer.current?.focus();
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-[1100px] flex-col px-4 py-6 lg:px-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label">Workspace</p>
          <h1 className="mt-1 text-[21px] font-semibold tracking-tight">
            Ask the Archive
          </h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
            Answers are grounded in retrieved passages. Every claim carries the
            passage it came from, and the evidence panel shows the model exactly
            what it was given.
          </p>
        </div>
        {turns.length > 0 && (
          <Button variant="outline" size="sm" onClick={startNewThread}>
            <MessageSquarePlus className="h-3.5 w-3.5" />
            New thread
          </Button>
        )}
      </header>

      {/* Transcript */}
      <div className="flex-1 space-y-7">
        {turns.length === 0 && (
          <div className="panel p-6 shadow-panel">
            <p className="label mb-3">Start with a question</p>
            <div className="space-y-2">
              {STARTERS.map((starter) => (
                <button
                  key={starter}
                  onClick={() => ask(starter)}
                  className="group flex w-full items-center justify-between gap-3 rounded-md border border-border bg-background px-3.5 py-2.5 text-left text-[13px] transition-colors hover:border-accent/50 hover:bg-accent/[0.03]"
                >
                  {starter}
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-accent" />
                </button>
              ))}
            </div>
            <Separator className="my-4" />
            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
              <ShieldQuestion className="mt-px h-3.5 w-3.5 shrink-0" />
              Retrieval is filtered by your document permissions before the model
              is called, so a question may legitimately have no answer for your
              role. When that happens, the archive says so rather than guessing.
            </p>
          </div>
        )}

        {turns.map((turn) => (
          <article key={turn.id} className="animate-rise space-y-3">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
                <span className="text-[10px] font-bold">
                  {(turn.question[0] ?? "?").toUpperCase()}
                </span>
              </span>
              <p className="pt-1 text-[14px] font-medium">{turn.question}</p>
            </div>

            <div className="pl-[34px]">
              {turn.error ? (
                <div className="rounded-lg border border-danger/30 bg-danger/6 px-3.5 py-3 text-[13px] leading-relaxed text-danger">
                  {turn.error}
                </div>
              ) : (
                <>
                  <AnswerBody turn={turn} />
                  {turn.passages.length > 0 && (
                    <EvidencePanel passages={turn.passages} />
                  )}
                  {turn.citations.length > 0 && (
                    <CitationPanel citations={turn.citations} />
                  )}
                </>
              )}
            </div>
          </article>
        ))}
        <div ref={bottom} />
      </div>

      {/* Composer */}
      <div className="sticky bottom-0 mt-6 bg-gradient-to-t from-background via-background to-transparent pb-4 pt-3">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            ask(question);
          }}
          className="panel flex items-end gap-2 p-2 shadow-lift"
        >
          <Textarea
            ref={composer as never}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                ask(question);
              }
            }}
            rows={1}
            placeholder="Ask a question about the archive…"
            aria-label="Your question"
            className="max-h-40 min-h-[44px] flex-1 resize-none border-0 bg-transparent px-3 py-2.5 text-[14px] shadow-none focus:ring-0"
          />
          <Button type="submit" variant="accent" disabled={busy || !question.trim()}>
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Thinking
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Ask
              </>
            )}
          </Button>
        </form>
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          Enter to send · Shift + Enter for a new line
        </p>
      </div>
    </div>
  );
}

function AnswerBody({ turn }: { turn: Turn }) {
  if (!turn.answer) {
    return (
      <div className="space-y-2">
        <div className="skeleton h-3 w-1/3 rounded" />
        <div className="skeleton h-3 w-11/12 rounded" />
        <div className="skeleton h-3 w-2/3 rounded" />
      </div>
    );
  }

  const abstained =
    turn.found === false ||
    /do(?:es)? not (?:appear|contain)|no information|not in the archive|insufficient/i.test(
      turn.answer,
    );

  return (
    <div>
      <div
        className={cn(
          "rounded-lg border px-4 py-3.5 text-[14px] leading-relaxed",
          abstained
            ? "border-warning/40 bg-warning/[0.07]"
            : "border-border bg-surface",
        )}
      >
        {abstained && (
          <p className="label mb-1.5 text-warning">
            Not answered in the archive
          </p>
        )}
        <p className="whitespace-pre-wrap text-foreground/90">{turn.answer}</p>
      </div>

      {(turn.intent || turn.model) && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          {turn.intent && (
            <span className="rounded bg-muted px-1.5 py-0.5">
              intent:{turn.intent}
            </span>
          )}
          {turn.model && (
            <span className="rounded bg-muted px-1.5 py-0.5">
              model:{turn.model}
            </span>
          )}
          {turn.streaming && (
            <span className="flex items-center gap-1 text-accent">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              streaming
            </span>
          )}
        </p>
      )}
    </div>
  );
}

/** The exact passages the model was given — the evidence behind the answer. */
function EvidencePanel({ passages }: { passages: Passage[] }) {
  return (
    <Accordion type="single" collapsible className="mt-2.5">
      <AccordionItem value="evidence" className="border-0">
        <AccordionTrigger className="py-1.5 text-[11px] text-muted-foreground hover:text-accent">
          <span className="flex items-center gap-1.5">
            <FileText className="h-3 w-3" />
            {passages.length} retrieved passage
            {passages.length === 1 ? "" : "s"}
            <span className="font-normal">
              — the only content the model was given
            </span>
          </span>
        </AccordionTrigger>
        <AccordionContent>
          <div className="space-y-1.5">
            {passages.map((passage) => (
              <div
                key={`${passage.document_id}-${passage.index}`}
                className="rounded-md border border-border bg-background px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <Link
                    href={`/library/${passage.document_id}`}
                    className="truncate text-[11px] font-semibold transition-colors hover:text-accent"
                  >
                    [{passage.index}] {passage.filename}
                  </Link>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    p.{passage.page_start}
                    {passage.page_end !== passage.page_start
                      ? `–${passage.page_end}`
                      : ""}
                    {typeof passage.score === "number"
                      ? ` · ${passage.score.toFixed(3)}`
                      : ""}
                  </span>
                </div>
                {passage.quote && (
                  <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                    {passage.quote}
                  </p>
                )}
              </div>
            ))}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

/** The citations attached to the answer — each opens its source document. */
function CitationPanel({ citations }: { citations: Citation[] }) {
  return (
    <div className="mt-3">
      <p className="label mb-1.5 flex items-center gap-1.5">
        <Quote className="h-3 w-3" />
        Citations
      </p>
      <div className="space-y-1.5">
        {citations.map((citation) => (
          <Link
            key={`${citation.document_id}-${citation.index}`}
            href={`/library/${citation.document_id}?page=${citation.page_start}`}
            className="group flex gap-2.5 rounded-md border border-border bg-surface px-3 py-2.5 transition-colors hover:border-accent/50"
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
              {citation.quote && (
                <span className="mt-0.5 block line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                  “{citation.quote}”
                </span>
              )}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
