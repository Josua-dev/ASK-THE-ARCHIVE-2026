"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Download,
  FileText,
  Loader2,
  MapPin,
  Search,
  Upload,
  X,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useAuth } from "@/lib/auth";
import type { ArchiveDocument, DocumentList } from "@/lib/types";
import {
  DocTypeChip,
  PageBody,
  PageHeader,
  StatusDot,
} from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  LoadingPanel,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { locationPath } from "@/components/warehouse/warehouse-map";
import { cn, EMPTY_ARRAY, formatBytes, formatDate } from "@/lib/utils";

const DOC_TYPES = [
  "lease",
  "contract",
  "policy",
  "invoice",
  "nda",
  "report",
  "agreement",
  "survey",
  "memorandum",
  "other",
];

const STATUSES = ["uploaded", "processing", "ready", "indexed", "failed"];

const ACCEPTED =
  ".pdf,.docx,.xlsx,.csv,.txt,.rtf,.html,.png,.jpg,.jpeg,.tiff,.bmp";

export default function LibraryPage() {
  const { user } = useAuth();
  const toast = useToast();

  const [data, setData] = useState<DocumentList | null>(null);
  const [docType, setDocType] = useState("all");
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [uploading, setUploading] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const PAGE_SIZE = 24;

  // Debounce the text filter so typing does not hammer the backend.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setPage(0);
  }, [docType, status, debounced]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await api.documents({
          doc_type: docType === "all" ? undefined : docType,
          status: status === "all" ? undefined : status,
          search: debounced || undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load the document library.",
      );
    } finally {
      setLoading(false);
    }
  }, [docType, status, debounced, page]);

  useEffect(() => {
    load();
  }, [load]);

  const items = data?.items ?? EMPTY_ARRAY;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  const onUpload = useCallback(
    async (file: File) => {
      setUploading(file.name);
      try {
        const doc = await api.upload(file);
        toast.success(
          "Upload accepted",
          `${doc.filename} is being extracted, classified and indexed.`,
        );
        await watch(doc.id);
        await load();
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : "Upload failed. Check the file type and size.";
        toast.error("Upload failed", message);
      } finally {
        setUploading(null);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [load, toast],
  );

  /** Poll until the document finishes ingesting, so the list refreshes with it. */
  async function watch(id: string) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const doc = await api.document(id);
        if (
          doc.status === "ready" ||
          doc.status === "indexed" ||
          doc.status === "failed"
        ) {
          return;
        }
      } catch {
        return;
      }
    }
  }

  const canUpload = user?.role === "admin" || user?.role === "analyst";

  const filtersActive = useMemo(
    () => docType !== "all" || status !== "all" || Boolean(debounced),
    [docType, status, debounced],
  );

  return (
    <PageBody>
      <PageHeader
        eyebrow="Knowledge"
        title="Document Library"
        description="Only documents your account is permitted to read are listed. Uploads are validated, extracted, classified and indexed before they become searchable."
        actions={
          canUpload ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPTED}
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUpload(file);
                }}
              />
              <Button
                variant="accent"
                onClick={() => fileRef.current?.click()}
                disabled={Boolean(uploading)}
              >
                {uploading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Processing…
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    Upload document
                  </>
                )}
              </Button>
            </>
          ) : null
        }
      />

      {uploading && (
        <div className="mt-5 rounded-md border border-accent/30 bg-accent/[0.06] px-3.5 py-2.5 text-[12px] text-accent">
          <span className="font-medium">{uploading}</span> is being extracted and
          indexed. This page refreshes when it is ready.
        </div>
      )}

      {error && <ErrorState className="mt-5" message={error} onRetry={load} />}

      {/* Controls */}
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <label
            htmlFor="library-search"
            className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
          >
            Search
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="library-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by filename or title…"
              className="pl-8"
            />
          </div>
        </div>

        <div className="w-[170px]">
          <label
            htmlFor="library-type"
            className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
          >
            Type
          </label>
          <Select value={docType} onValueChange={setDocType}>
            <SelectTrigger id="library-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {DOC_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-[160px]">
          <label
            htmlFor="library-status"
            className="mb-1.5 block text-[11px] font-medium text-muted-foreground"
          >
            Status
          </label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="library-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((value) => (
                <SelectItem key={value} value={value} className="capitalize">
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDocType("all");
              setStatus("all");
              setQuery("");
            }}
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </Button>
        )}

        <p className="ml-auto text-[11px] text-muted-foreground">
          {loading ? "Loading…" : `${data?.total ?? 0} document${data?.total === 1 ? "" : "s"}`}
        </p>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="mt-5">
          <LoadingPanel label="Reading the library…" rows={4} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          className="mt-5"
          icon={<FileText className="h-4 w-4" />}
          title={
            filtersActive
              ? "No documents match these filters"
              : "No documents are visible to your account"
          }
          description={
            filtersActive
              ? "Try widening the type or status filter, or clear the search."
              : "Documents appear here once they are ingested and your permissions allow you to read them."
          }
          action={
            filtersActive ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDocType("all");
                  setStatus("all");
                  setQuery("");
                }}
              >
                Clear filters
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((doc) => (
            <DocCard key={doc.id} doc={doc} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </Button>
          <span className="text-[12px] text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </PageBody>
  );
}

function DocCard({ doc }: { doc: ArchiveDocument }) {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);

  const path = locationPath({
    zone: doc.zone,
    rack: doc.rack,
    shelf: doc.shelf,
    box: doc.box,
  });

  async function handleDownload(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDownloading(true);
    try {
      await api.downloadBlob(doc.id, doc.filename);
      toast.success("Download started", doc.filename);
    } catch (err) {
      toast.error(
        "Download failed",
        err instanceof ApiError
          ? err.message
          : "Check your permission for this document.",
      );
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="panel group relative flex flex-col p-4 shadow-panel transition-all hover:-translate-y-0.5 hover:shadow-lift">
      <div className="flex items-start justify-between gap-3">
        <DocTypeChip type={doc.doc_type} />
        <StatusDot status={doc.status} />
      </div>

      <h3 className="mt-3 line-clamp-2 text-[14px] font-semibold leading-snug transition-colors group-hover:text-accent">
        {/* A stretched link, so the whole card opens the document without
            nesting the location badge inside another link. */}
        <Link
          href={`/library/${doc.id}`}
          className="after:absolute after:inset-0 after:content-['']"
        >
          {doc.title || doc.filename}
        </Link>
      </h3>
      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {doc.filename}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3">
        <div>
          <p className="label text-[9px]">Expires</p>
          <p className="mt-0.5 font-mono text-[11px]">
            {doc.expiry_date ? formatDate(doc.expiry_date) : "—"}
          </p>
        </div>
        <div>
          <p className="label text-[9px]">Size</p>
          <p className="mt-0.5 font-mono text-[11px]">
            {formatBytes(doc.byte_size)}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span
          className={cn(
            "relative z-10 inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors",
            "hover:bg-accent/12 hover:text-accent",
          )}
          role="button"
          tabIndex={0}
          onClick={handleDownload}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handleDownload(event as unknown as React.MouseEvent);
            }
          }}
        >
          {downloading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Download className="h-3 w-3" />
          )}
          {downloading ? "Downloading…" : "Download"}
        </span>

        {doc.page_count ? (
          <Badge variant="outline">{doc.page_count} pages</Badge>
        ) : null}
      </div>

      {/* The location badge sits above the stretched link so it stays clickable. */}
      <Link
        href={`/warehouse/${doc.id}`}
        title={path ? `Located at ${path}` : "No location assigned"}
        className={cn(
          "relative z-10 mt-3 inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
          path
            ? "bg-accent/12 text-accent hover:bg-accent/20"
            : "bg-muted text-muted-foreground hover:text-foreground",
        )}
      >
        <MapPin className="h-3 w-3" />
        {path ?? "not located"}
      </Link>
    </div>
  );
}
