"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  ChevronsUpDown,
  FileText,
  Loader2,
  Plus,
  Quote,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Table2,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import type {
  ArchiveDocument,
  DocumentList,
  ExtractionColumn,
  ExtractionListOut,
  ExtractionRow,
  ExtractionRun,
} from "@/lib/types";
import { cn, formatDate, formatRelative } from "@/lib/utils";
import { PageBody, PageHeader, StatusDot } from "@/components/ui";
import {
  CountPills,
  EmptyState,
  ErrorState,
  LoadingPanel,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/overlays";
import { Separator } from "@/components/ui/primitives";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The backend refuses to read more than this many documents in one pass
 * (MAX_DOCUMENTS in app/modules/extraction/service.py). The cap is enforced
 * here so the user is told why rather than being handed a server error.
 */
const MAX_DOCUMENTS = 12;

const COLUMN_TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "currency", label: "Currency" },
  { value: "boolean", label: "Yes / no" },
] as const;

type ColumnType = (typeof COLUMN_TYPES)[number]["value"];

interface ColumnDraft {
  id: string;
  key: string;
  label: string;
  type: ColumnType;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Documents must be indexed before the model can read them. */
function isIndexed(status: string): boolean {
  const key = status?.toLowerCase() ?? "";
  return ["ready", "indexed", "complete", "completed"].includes(key);
}

function newDraft(): ColumnDraft {
  return {
    id: `col-${Math.random().toString(36).slice(2, 9)}`,
    key: "",
    label: "",
    type: "text",
  };
}

/* ------------------------------------------------------------------- page */

export default function ExtractionPage() {
  const { user } = useAuth();
  const toast = useToast();

  /* -- new extraction -- */
  const [instruction, setInstruction] = useState("");
  const [docs, setDocs] = useState<ArchiveDocument[]>([]);
  const [columns, setColumns] = useState<ColumnDraft[]>([newDraft()]);
  const [maxRows, setMaxRows] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExtractionRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  /* -- previous runs -- */
  const [list, setList] = useState<ExtractionListOut | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openLoading, setOpenLoading] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opened, setOpened] = useState<ExtractionRun | null>(null);

  const canExtract = user?.role === "admin" || user?.role === "analyst";

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      setList(await api.extractions(25, 0));
    } catch (err) {
      setListError(
        err instanceof Error
          ? err.message
          : "Could not load your previous extraction runs.",
      );
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  /* -- validation -- */
  const resolvedColumns = useMemo(
    () =>
      columns
        .map((draft) => {
          // An explicit key is respected as typed (camelCase included);
          // a label alone is slugified into one.
          const key =
            draft.key.trim().replace(/\s+/g, "_") || slugify(draft.label);
          const label = draft.label.trim() || key.replace(/_/g, " ");
          return { key, label, type: draft.type };
        })
        .filter((column) => column.key.length > 0),
    [columns],
  );

  const duplicateKeys = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const column of resolvedColumns) {
      if (seen.has(column.key)) dupes.add(column.key);
      seen.add(column.key);
    }
    return Array.from(dupes);
  }, [resolvedColumns]);

  const parsedMaxRows = useMemo(() => {
    const trimmed = maxRows.trim();
    if (!trimmed) return null;
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < 1 || value > 2000) return null;
    return value;
  }, [maxRows]);

  const maxRowsInvalid = maxRows.trim().length > 0 && parsedMaxRows === null;

  const readyToRun =
    Boolean(instruction.trim()) &&
    duplicateKeys.length === 0 &&
    !maxRowsInvalid &&
    !running;

  async function runExtraction() {
    if (!readyToRun) return;
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      const run = await api.createExtraction({
        instruction: instruction.trim(),
        document_ids: docs.map((doc) => doc.id),
        columns: resolvedColumns.map((column) => ({
          key: column.key,
          label: column.label,
          type: column.type,
        })),
        ...(parsedMaxRows !== null ? { max_rows: parsedMaxRows } : {}),
      });
      setResult(run);
      if (run.status === "failed") {
        const message = run.error ?? "The extraction did not complete.";
        setRunError(message);
        toast.error("The extraction failed", message);
      } else {
        toast.success(
          "Extraction complete",
          `${run.row_count} verified row${run.row_count === 1 ? "" : "s"}.`,
        );
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "The extraction could not be run.";
      setRunError(message);
      toast.error("The extraction failed", message);
    } finally {
      setRunning(false);
    }
  }

  async function openRun(id: string) {
    setOpenId(id);
    setOpenLoading(true);
    setOpenError(null);
    setOpened(null);
    try {
      setOpened(await api.extraction(id));
    } catch (err) {
      setOpenError(
        err instanceof Error ? err.message : "Could not open that extraction run.",
      );
    } finally {
      setOpenLoading(false);
    }
  }

  return (
    <PageBody>
      <PageHeader
        eyebrow="Knowledge"
        title="Extraction Studio"
        description="Describe a record in plain English and the model pulls it out of the documents you choose. Every value comes back with the page it was read from — and any value the backend cannot locate in the source text is dropped rather than guessed."
      />

      <Tabs defaultValue="new" className="mt-6">
        <TabsList>
          <TabsTrigger value="new">
            <Sparkles className="h-3.5 w-3.5" />
            New extraction
          </TabsTrigger>
          <TabsTrigger value="previous">
            <Table2 className="h-3.5 w-3.5" />
            Previous runs
          </TabsTrigger>
        </TabsList>

        {/* ------------------------------------------------------- new ---- */}
        <TabsContent value="new">
          {!canExtract ? (
            <div className="panel p-6 shadow-panel">
              <EmptyState
                className="border-0"
                icon={<ShieldAlert className="h-4 w-4" />}
                title="Your role cannot run extractions"
                description="Extraction Studio requires the analyst or admin role on the backend. You are signed in as a viewer, so the archive will not extract records on your behalf. Runs you are permitted to read are still listed under Previous runs."
              />
            </div>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[400px_1fr]">
              {/* Form */}
              <section className="panel p-5 shadow-panel lg:sticky lg:top-20 lg:self-start">
                <p className="label">Extraction setup</p>

                <div className="mt-3 space-y-4">
                  <div>
                    <label
                      htmlFor="extract-instruction"
                      className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
                    >
                      What should be extracted?
                    </label>
                    <Textarea
                      id="extract-instruction"
                      value={instruction}
                      disabled={running}
                      onChange={(event) => setInstruction(event.target.value)}
                      rows={3}
                      placeholder="Extract every contract with its expiry date and monthly value…"
                    />
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      Plain English works best. The model reads the selected
                      documents and returns one row per record it finds.
                    </p>
                  </div>

                  <DocumentMultiSelect
                    selected={docs}
                    onChange={setDocs}
                    disabled={running}
                    max={MAX_DOCUMENTS}
                  />

                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        Columns
                      </p>
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={running}
                        onClick={() => setColumns((all) => [...all, newDraft()])}
                      >
                        <Plus className="h-3 w-3" />
                        Add column
                      </Button>
                    </div>

                    <div className="mt-2 space-y-2">
                      {columns.map((draft, index) => (
                        <div
                          key={draft.id}
                          className="rounded-md border border-border bg-background p-2.5"
                        >
                          <div className="flex items-center gap-1.5">
                            <Input
                              value={draft.label}
                              disabled={running}
                              onChange={(event) =>
                                setColumns((all) =>
                                  all.map((column) =>
                                    column.id === draft.id
                                      ? { ...column, label: event.target.value }
                                      : column,
                                  ),
                                )
                              }
                              placeholder="Label — e.g. Expiry date"
                              aria-label={`Label for column ${index + 1}`}
                              className="h-8 flex-1 text-[12px]"
                            />
                            <Button
                              variant="ghost"
                              size="iconSm"
                              disabled={running || columns.length === 1}
                              onClick={() =>
                                setColumns((all) =>
                                  all.filter((column) => column.id !== draft.id),
                                )
                              }
                              aria-label={`Remove column ${index + 1}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>

                          <div className="mt-1.5 flex gap-1.5">
                            <Input
                              value={draft.key}
                              disabled={running}
                              onChange={(event) =>
                                setColumns((all) =>
                                  all.map((column) =>
                                    column.id === draft.id
                                      ? { ...column, key: event.target.value }
                                      : column,
                                  ),
                                )
                              }
                              placeholder="Key — e.g. expiry_date"
                              aria-label={`Key for column ${index + 1}`}
                              className="h-8 flex-1 font-mono text-[11px]"
                            />
                            <Select
                              value={draft.type}
                              onValueChange={(value) =>
                                setColumns((all) =>
                                  all.map((column) =>
                                    column.id === draft.id
                                      ? {
                                          ...column,
                                          type: value as ColumnType,
                                        }
                                      : column,
                                  ),
                                )
                              }
                            >
                              <SelectTrigger
                                className="h-8 w-[110px] text-[12px]"
                                aria-label={`Type for column ${index + 1}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {COLUMN_TYPES.map((type) => (
                                  <SelectItem key={type.value} value={type.value}>
                                    {type.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      ))}
                    </div>

                    {duplicateKeys.length > 0 && (
                      <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-danger">
                        <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
                        Duplicate column key
                        {duplicateKeys.length === 1 ? "" : "s"}:{" "}
                        {duplicateKeys.join(", ")}. Each column needs its own key.
                      </p>
                    )}

                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                      Leave every column blank and the model will propose its own
                      set from the documents.
                    </p>
                  </div>

                  <div>
                    <label
                      htmlFor="extract-max-rows"
                      className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
                    >
                      Maximum rows (optional)
                    </label>
                    <Input
                      id="extract-max-rows"
                      type="number"
                      min={1}
                      max={2000}
                      value={maxRows}
                      disabled={running}
                      onChange={(event) => setMaxRows(event.target.value)}
                      placeholder="200"
                      className="font-mono text-[12px]"
                    />
                    {maxRowsInvalid && (
                      <p className="mt-1.5 text-[11px] text-danger">
                        Enter a whole number between 1 and 2000, or leave it
                        blank to use the backend default.
                      </p>
                    )}
                  </div>
                </div>

                <Separator className="my-4" />

                <Button
                  variant="accent"
                  className="w-full"
                  disabled={!readyToRun}
                  onClick={runExtraction}
                >
                  {running ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Extracting…
                    </>
                  ) : (
                    <>
                      <Table2 className="h-4 w-4" />
                      Run extraction
                    </>
                  )}
                </Button>

                {!instruction.trim() && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Describe what you want extracted to enable the run.
                  </p>
                )}

                {running && (
                  <div
                    className="mt-4 rounded-md border border-accent/30 bg-accent/[0.06] px-3.5 py-3"
                    role="status"
                    aria-live="polite"
                  >
                    <p className="flex items-center gap-1.5 text-[12px] font-medium text-accent">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Reading the selected documents
                    </p>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                      The model runs locally on CPU, so a pass takes a while.
                      Each value is then re-checked against the cited page
                      before it is kept.
                    </p>
                  </div>
                )}
              </section>

              {/* Results */}
              <section className="min-w-0">
                {runError && (
                  <ErrorState
                    className="mb-4"
                    title="The extraction did not complete"
                    message={runError}
                    onRetry={readyToRun ? runExtraction : undefined}
                  />
                )}

                {!result && !runError && !running && (
                  <div className="panel p-6 shadow-panel">
                    <EmptyState
                      className="border-0"
                      icon={<Table2 className="h-4 w-4" />}
                      title="No extraction running yet"
                      description="Describe the record you want, choose the documents and the columns, then run the pass. The result comes back as a table where every value sits next to the page it came from."
                    />
                  </div>
                )}

                {result && <ResultPanel run={result} />}
              </section>
            </div>
          )}
        </TabsContent>

        {/* -------------------------------------------------- previous ---- */}
        <TabsContent value="previous">
          {openId ? (
            <div className="space-y-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpenId(null);
                  setOpened(null);
                  setOpenError(null);
                }}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                All runs
              </Button>

              {openLoading && (
                <div className="panel p-5 shadow-panel">
                  <LoadingPanel label="Opening the run…" rows={4} />
                </div>
              )}

              {openError && (
                <ErrorState
                  message={openError}
                  onRetry={() => openRun(openId)}
                />
              )}

              {opened && <ResultPanel run={opened} />}
            </div>
          ) : (
            <section className="panel overflow-hidden shadow-panel">
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <p className="label">Previous runs</p>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={loadList}
                  disabled={listLoading}
                >
                  {listLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Table2 className="h-3 w-3" />
                  )}
                  Refresh
                </Button>
              </div>

              {listError ? (
                <div className="p-4">
                  <ErrorState message={listError} onRetry={loadList} />
                </div>
              ) : listLoading ? (
                <div className="p-4">
                  <LoadingPanel label="Loading runs…" rows={4} />
                </div>
              ) : (list?.items.length ?? 0) === 0 ? (
                <EmptyState
                  className="m-4 border-0"
                  icon={<Table2 className="h-4 w-4" />}
                  title="No extraction runs yet"
                  description="Runs are saved as they complete, so you can reopen one later and read the verified values with their evidence."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {list?.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => openRun(item.id)}
                        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent/12 text-accent">
                          <Table2 className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-semibold leading-snug">
                            {item.instruction}
                          </span>
                          <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                            <StatusDot status={item.status} />
                            <span className="font-mono">
                              {item.row_count} row{item.row_count === 1 ? "" : "s"}
                            </span>
                            {item.model && (
                              <span className="font-mono">model:{item.model}</span>
                            )}
                            <span title={formatDate(item.created_at)}>
                              {formatRelative(item.created_at)}
                            </span>
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </TabsContent>
      </Tabs>
    </PageBody>
  );
}

/* ------------------------------------------------------------- results */

function ResultPanel({ run }: { run: ExtractionRun }) {
  const failed = run.status === "failed";
  const pending = !failed && run.status !== "completed";
  const columns = run.columns;
  const rows = run.rows;

  return (
    <div className="space-y-4">
      <div className="panel p-5 shadow-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="label">Result</p>
            <p className="mt-1.5 text-[14px] font-semibold leading-snug tracking-tight">
              {run.instruction}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
              <StatusDot status={run.status} />
              {run.model && (
                <span className="font-mono">model:{run.model}</span>
              )}
              {run.completed_at && (
                <span title={formatDate(run.completed_at)}>
                  {formatRelative(run.completed_at)}
                </span>
              )}
            </p>
          </div>
          <CountPills
            items={[
              { label: "rows", value: run.row_count },
              { label: "columns", value: columns.length },
            ]}
          />
        </div>
      </div>

      {failed && (
        <ErrorState
          title="The extraction failed"
          message={
            run.error ?? "The backend recorded a failure for this run without a reason."
          }
        />
      )}

      {pending && (
        <div className="panel p-5 shadow-panel">
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            This run is still {run.status}.
          </p>
        </div>
      )}

      {!failed && !pending && columns.length === 0 && (
        <div className="panel p-6 shadow-panel">
          <EmptyState
            className="border-0"
            icon={<ShieldAlert className="h-4 w-4" />}
            title="No columns came back"
            description="The run finished but returned no column definitions, so there is nothing to lay out. Define the columns explicitly and run the extraction again."
          />
        </div>
      )}

      {!failed && !pending && columns.length > 0 && run.row_count === 0 && (
        <div className="panel p-6 shadow-panel">
          <EmptyState
            className="border-0"
            icon={<ShieldCheck className="h-4 w-4" />}
            title="No verifiable values were found"
            description="The run completed and returned no rows. The backend discards any row whose values cannot be confirmed against the cited pages, so this means nothing in the selected documents could be verified — not that the documents are free of the records you asked for."
          />
        </div>
      )}

      {!failed && !pending && columns.length > 0 && rows.length > 0 && (
        <div className="panel overflow-hidden shadow-panel">
          <div className="border-b border-border px-4 py-3">
            <p className="label flex items-center gap-1.5">
              <Quote className="h-3 w-3" />
              Extracted records
            </p>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                {columns.map((column) => (
                  <TableHead key={column.key} className="min-w-[160px]">
                    <span className="block truncate">{column.label}</span>
                    <span className="mt-0.5 block font-mono text-[9px] normal-case tracking-normal text-muted-foreground">
                      {column.key} · {column.type}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {row.row_index + 1}
                  </TableCell>
                  {columns.map((column) => (
                    <ExtractionCell
                      key={`${row.id}-${column.key}`}
                      column={column}
                      row={row}
                    />
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <p className="border-t border-border px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
            “— not verified” means the backend could not confirm a value
            against the source text, so it was dropped rather than guessed. The
            quote button on a cell opens the page the value was read from.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * One cell of the results table.
 *
 * A value is only ever shown together with the evidence behind it. When the
 * cell is empty the reason is stated rather than left blank, and when the
 * value survived the citation is one click away.
 */
function ExtractionCell({
  column,
  row,
}: {
  column: ExtractionColumn;
  row: ExtractionRow;
}) {
  const citations = row.citations.filter(
    (citation) => citation.column === column.key,
  );
  const raw = row.data[column.key];
  const verified = raw !== undefined && raw !== null && raw !== "";

  return (
    <TableCell className="align-top">
      <div className="flex items-start gap-1.5">
        <span
          className={cn(
            "min-w-0 flex-1 text-[13px]",
            verified ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {verified ? formatValue(raw) : "— not verified"}
        </span>

        {citations.length > 0 && (
          <EvidenceButton
            column={column}
            citations={citations}
            rowIndex={row.row_index + 1}
          />
        )}
      </div>
    </TableCell>
  );
}

function formatValue(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return "— not verified";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function EvidenceButton({
  column,
  citations,
  rowIndex,
}: {
  column: ExtractionColumn;
  citations: ExtractionRun["rows"][number]["citations"];
  rowIndex: number;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Show the source for ${column.label}, row ${rowIndex}`}
          className="mt-0.5 shrink-0 rounded-md border border-border bg-muted p-1 text-muted-foreground transition-colors hover:border-accent/50 hover:bg-accent/12 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Quote className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[340px] max-w-[calc(100vw-2rem)] p-3"
      >
        <p className="label">Evidence · {column.label}</p>
        <ul className="mt-2 space-y-2.5">
          {citations.map((citation, index) => (
            <li
              key={`${citation.document_id}-${citation.page ?? index}-${index}`}
              className="rounded-md border border-border bg-background px-2.5 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <Link
                  href={`/library/${citation.document_id}${
                    citation.page !== null && citation.page !== undefined
                      ? `?page=${citation.page}`
                      : ""
                  }`}
                  className="min-w-0 flex-1 truncate text-[11px] font-semibold transition-colors hover:text-accent"
                >
                  {citation.filename || "Document"}
                </Link>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {citation.page !== null && citation.page !== undefined
                    ? `p.${citation.page}`
                    : "page unknown"}
                </span>
              </div>
              {citation.excerpt ? (
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  “{citation.excerpt}”
                </p>
              ) : (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  No excerpt was recorded for this citation.
                </p>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/* ----------------------------------------------------- document picker */

function DocumentMultiSelect({
  selected,
  onChange,
  disabled,
  max,
}: {
  selected: ArchiveDocument[];
  onChange: (docs: ArchiveDocument[]) => void;
  disabled?: boolean;
  max: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [docs, setDocs] = useState<DocumentList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .documents({ search: debounced || undefined, limit: 40 })
      .then((response) => {
        if (!cancelled) setDocs(response);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not search the document library.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debounced]);

  const items = docs?.items ?? [];
  const atCap = selected.length >= max;

  function toggle(doc: ArchiveDocument) {
    const exists = selected.some((item) => item.id === doc.id);
    if (exists) {
      onChange(selected.filter((item) => item.id !== doc.id));
      return;
    }
    if (selected.length >= max) return;
    onChange([...selected, doc]);
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-muted-foreground">
          Documents
        </p>
        <span
          className={cn(
            "chip",
            atCap
              ? "bg-warning/12 text-warning"
              : "bg-muted text-muted-foreground",
          )}
        >
          <span className="font-mono">
            {selected.length} / {max}
          </span>
          selected
        </span>
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id="extract-documents"
            type="button"
            disabled={disabled}
            className="mt-1.5 flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-surface px-3 py-1 text-left text-[13px] shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                selected.length === 0 && "text-muted-foreground",
              )}
            >
              {selected.length === 0
                ? "Search for documents…"
                : `${selected.length} document${selected.length === 1 ? "" : "s"} selected`}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          className="w-[360px] max-w-[calc(100vw-2rem)] p-0"
        >
          <div className="border-b border-border p-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by filename or title…"
                aria-label="Search documents to extract from"
                className="h-8 pl-8 text-[12px]"
                autoFocus
              />
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto p-1.5">
            {loading ? (
              <div className="space-y-1.5 p-1">
                {[0, 1, 2, 3].map((index) => (
                  <div
                    key={index}
                    className="skeleton h-9 rounded"
                    style={{ opacity: 1 - index * 0.16 }}
                  />
                ))}
              </div>
            ) : error ? (
              <p className="px-2 py-3 text-[11px] leading-relaxed text-danger">
                {error}
              </p>
            ) : items.length === 0 ? (
              <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
                No documents match that search.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {items.map((doc) => {
                  const checked = selected.some((item) => item.id === doc.id);
                  const blocked = !checked && atCap;
                  const selectable = !blocked && isIndexed(doc.status);
                  return (
                    <li key={doc.id}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        disabled={!selectable}
                        onClick={() => toggle(doc)}
                        className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-55"
                      >
                        <span
                          className={cn(
                            "mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] border",
                            checked
                              ? "border-accent bg-accent text-accent-foreground"
                              : "border-border",
                          )}
                          aria-hidden="true"
                        >
                          {checked && <Check className="h-2.5 w-2.5" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-medium">
                            {doc.title || doc.filename}
                          </span>
                          <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                            <StatusDot status={doc.status} />
                            {blocked ? (
                              <span>limit of {max} reached</span>
                            ) : !isIndexed(doc.status) ? (
                              <span>not indexed yet</span>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="border-t border-border px-3 py-2">
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              One pass reads at most {max} documents. Select none and the
              backend uses the {max} most recent documents you can read.
            </p>
          </div>
        </PopoverContent>
      </Popover>

      {selected.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {selected.map((doc) => (
            <li key={doc.id}>
              <span className="chip bg-muted text-muted-foreground">
                <FileText className="h-3 w-3" />
                <span className="max-w-[180px] truncate">
                  {doc.title || doc.filename}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    onChange(selected.filter((item) => item.id !== doc.id))
                  }
                  aria-label={`Remove ${doc.filename}`}
                  className="rounded p-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
