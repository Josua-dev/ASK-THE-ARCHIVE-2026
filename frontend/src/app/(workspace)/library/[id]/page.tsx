"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Download,
  FileText,
  Loader2,
  Lock,
  MapPin,
  Pencil,
  Save,
  Sparkles,
  Trash2,
  UserPlus,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import type {
  ArchiveDocument,
  DocumentProfile,
  Permission,
  ProfileEntry,
  Summary,
  WarehouseLayout,
} from "@/lib/types";
import {
  DocTypeChip,
  PageBody,
  StatusDot,
} from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  LoadingPanel,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/overlays";
import { Separator } from "@/components/ui/primitives";
import { LocationBreadcrumb } from "@/components/warehouse/warehouse-map";
import { formatBytes, formatDate } from "@/lib/utils";

interface PreviewPage {
  chunk_index: number;
  page_start: number;
  page_end: number;
  text: string;
}

interface Preview {
  id: string;
  filename: string;
  doc_type: string | null;
  expiry_date: string | null;
  status: string;
  pages: PreviewPage[];
}

/** One collapsible group of the extracted intelligence profile. */
interface ProfileSection {
  key: string;
  label: string;
  entries: ProfileEntry[];
  render: (entry: ProfileEntry) => string;
}

const ROLES = ["admin", "analyst", "viewer"] as const;
const PERMISSIONS = ["view", "download", "manage"] as const;

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const { user } = useAuth();
  const toast = useToast();

  const focusPage = Number(params.get("page") ?? 0);

  const [doc, setDoc] = useState<ArchiveDocument | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summarising, setSummarising] = useState(false);
  const [profile, setProfile] = useState<DocumentProfile | null>(null);
  const [perms, setPerms] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [busyPermission, setBusyPermission] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setDoc(await api.document(id));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not load this document.",
      );
      setLoading(false);
      return;
    }
    // These are independent, and each may legitimately be absent.
    const [previewResult, summaryResult, profileResult, permsResult] =
      await Promise.allSettled([
        api.preview(id),
        api.summary(id),
        api.profile(id),
        api.permissions(id),
      ]);
    if (previewResult.status === "fulfilled") setPreview(previewResult.value);
    if (summaryResult.status === "fulfilled") setSummary(summaryResult.value);
    if (profileResult.status === "fulfilled") setProfile(profileResult.value);
    if (permsResult.status === "fulfilled") setPerms(permsResult.value);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function doSummary() {
    setSummarising(true);
    try {
      setSummary(await api.createSummary(id));
      toast.success("Summary generated");
    } catch (err) {
      toast.error(
        "Summary failed",
        err instanceof ApiError ? err.message : "The model did not respond.",
      );
    } finally {
      setSummarising(false);
    }
  }

  async function doDownload() {
    setDownloading(true);
    try {
      await api.downloadBlob(id, doc?.filename ?? "document");
      toast.success("Download started", doc?.filename);
    } catch (err) {
      toast.error(
        "Download refused",
        err instanceof ApiError
          ? err.message
          : "You do not have download permission for this document.",
      );
    } finally {
      setDownloading(false);
    }
  }

  const canManage = user?.role === "admin";

  /** Re-read the document so the location panel and the library badge agree. */
  const refreshDocument = useCallback(async () => {
    if (!id) return;
    try {
      setDoc(await api.document(id));
    } catch (err) {
      toast.error(
        "Refresh failed",
        err instanceof ApiError
          ? err.message
          : "Could not refresh this document.",
      );
    }
  }, [id, toast]);

  /** Grant a role access to this document, then re-read the grant list. */
  async function grant(body: {
    grantee_type: "user" | "role";
    grantee_user_id?: string | null;
    grantee_role?: string | null;
    permission: "view" | "download" | "manage";
  }) {
    setBusyPermission(true);
    try {
      await api.addPermission(id, body);
      setPerms(await api.permissions(id));
      toast.success("Access granted");
    } catch (err) {
      toast.error(
        "Grant failed",
        err instanceof ApiError ? err.message : "The permission was refused.",
      );
    } finally {
      setBusyPermission(false);
    }
  }

  /** Revoke one grant, then re-read the grant list. */
  async function revoke(permission: Permission) {
    setBusyPermission(true);
    try {
      await api.removePermission(id, {
        grantee_type: permission.grantee_type,
        grantee_user_id: permission.grantee_user_id,
        grantee_role: permission.grantee_role,
        permission: permission.permission,
      });
      setPerms(await api.permissions(id));
      toast.success("Access revoked");
    } catch (err) {
      toast.error(
        "Revoke failed",
        err instanceof ApiError ? err.message : "The permission was refused.",
      );
    } finally {
      setBusyPermission(false);
    }
  }

  return (
    <PageBody>
      <Link
        href="/library"
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-accent"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to the library
      </Link>

      {error && (
        <ErrorState
          className="mt-4"
          title="This document could not be opened"
          message={error}
          onRetry={load}
        />
      )}

      <div className="mt-4 grid gap-5 lg:grid-cols-[1fr_340px]">
        {/* Document body */}
        <div className="min-w-0">
          <section className="panel p-5 shadow-panel">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <DocTypeChip type={doc?.doc_type ?? null} />
                  {doc && <StatusDot status={doc.status} />}
                </div>
                <h1 className="mt-2 text-[19px] font-semibold leading-snug tracking-tight">
                  {doc?.title || doc?.filename || "Document"}
                </h1>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {doc?.filename}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={doDownload}
                disabled={downloading}
              >
                {downloading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                Download original
              </Button>
            </div>

            <Separator className="my-4" />

            {loading ? (
              <LoadingPanel label="Extracting the document text…" rows={3} />
            ) : preview?.pages.length ? (
              <div className="space-y-4">
                {preview.pages.map((page) => {
                  const focused =
                    focusPage > 0 &&
                    focusPage >= page.page_start &&
                    focusPage <= page.page_end;
                  return (
                    <section
                      key={page.chunk_index}
                      className={
                        focused
                          ? "rounded-lg border border-accent/50 bg-accent/[0.04] px-4 py-3.5"
                          : "rounded-lg border border-border bg-background px-4 py-3.5"
                      }
                    >
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="label">
                          Page {page.page_start}
                          {page.page_end !== page.page_start
                            ? `–${page.page_end}`
                            : ""}
                        </p>
                        {focused && (
                          <Badge variant="accent">cited passage</Badge>
                        )}
                      </div>
                      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/85">
                        {page.text}
                      </p>
                    </section>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                className="border-0"
                icon={<FileText className="h-4 w-4" />}
                title="No extracted text"
                description="This document has no readable text yet. It may still be processing, or it may be a scanned file awaiting OCR."
              />
            )}
          </section>
        </div>

        {/* Side rail */}
        <aside className="space-y-4">
          <section className="panel p-4 shadow-panel">
            <p className="label">Summary</p>
            {summary ? (
              <>
                <SummaryText text={summary.summary} />
                <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                  {summary.model} · {summary.prompt_version}
                </p>
              </>
            ) : (
              <>
                <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                  No summary has been generated for this document yet.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 w-full"
                  disabled={summarising}
                  onClick={doSummary}
                >
                  {summarising ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {summarising ? "Summarising…" : "Generate summary"}
                </Button>
              </>
            )}
          </section>

          <LocationPanel
            doc={doc}
            canEdit={Boolean(
              doc &&
                (user?.role === "admin" || doc.uploaded_by === user?.id),
            )}
            onRefresh={refreshDocument}
          />

          {profile && <ProfilePanel profile={profile} />}

          <section className="panel p-4 shadow-panel">
            <p className="label">Metadata</p>
            <dl className="mt-2 space-y-1.5 text-[12px]">
              <Row k="Expiry date" v={doc?.expiry_date ? formatDate(doc.expiry_date) : "—"} mono />
              <Row k="Pages" v={doc?.page_count ?? "—"} mono />
              <Row k="Size" v={doc ? formatBytes(doc.byte_size) : "—"} mono />
              <Row
                k="Classification"
                v={
                  doc?.classification_confidence != null
                    ? doc.classification_confidence.toFixed(2)
                    : "—"
                }
                mono
              />
              <Row
                k="Indexed"
                v={doc?.indexed_at ? formatDate(doc.indexed_at) : "—"}
                mono
              />
            </dl>
          </section>

          <section className="panel p-4 shadow-panel">
            <p className="label flex items-center gap-1.5">
              <Lock className="h-3 w-3" />
              Who can read this
            </p>
            {perms.length ? (
              <ul className="mt-2 space-y-1.5">
                {perms.map((permission) => (
                  <li
                    key={permission.id}
                    className="flex items-center justify-between gap-2 text-[12px]"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {permission.grantee_type === "role" ? (
                        <Users className="h-3 w-3 shrink-0 text-muted-foreground" />
                      ) : (
                        <UserRound className="h-3 w-3 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">
                        {permission.grantee_type === "role"
                          ? `Role: ${permission.grantee_role}`
                          : `User: ${permission.grantee_user_id?.slice(0, 8) ?? "—"}`}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <Badge variant="outline">{permission.permission}</Badge>
                      {canManage && (
                        <button
                          onClick={() => revoke(permission)}
                          disabled={busyPermission}
                          aria-label="Revoke this permission"
                          title="Revoke"
                          className="rounded p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                {canManage
                  ? "No explicit grants — visible to the uploader and administrators only."
                  : "You have access through a role grant or as the uploader."}
              </p>
            )}

            {canManage ? (
              <PermissionGranter
                onGrant={grant}
                busy={busyPermission}
                existing={perms}
              />
            ) : null}
          </section>
        </aside>
      </div>
    </PageBody>
  );
}

/**
 * Where the document physically sits in the archive.
 *
 * The vocabulary is read from the layout endpoint, never hardcoded, and the
 * editing controls are only offered to someone who can actually manage this
 * document — an administrator, or the person who uploaded it.
 */
function LocationPanel({
  doc,
  canEdit,
  onRefresh,
}: {
  doc: ArchiveDocument | null;
  canEdit: boolean;
  onRefresh: () => Promise<void>;
}) {
  const toast = useToast();

  const [layout, setLayout] = useState<WarehouseLayout | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [loadingLayout, setLoadingLayout] = useState(false);
  const [editing, setEditing] = useState(false);
  const [zone, setZone] = useState("");
  const [rack, setRack] = useState("");
  const [shelf, setShelf] = useState("");
  const [box, setBox] = useState("");
  const [busy, setBusy] = useState(false);

  const loadLayout = useCallback(async (): Promise<WarehouseLayout | null> => {
    setLoadingLayout(true);
    setLayoutError(null);
    try {
      const next = await api.warehouseLayout();
      setLayout(next);
      return next;
    } catch (err) {
      setLayoutError(
        err instanceof ApiError
          ? err.message
          : "Could not load the warehouse vocabulary.",
      );
      return null;
    } finally {
      setLoadingLayout(false);
    }
  }, []);

  /** Open the editor with the document's current slot, or the first free one. */
  async function startEditing() {
    const vocabulary = layout ?? (await loadLayout());
    if (!vocabulary) return;
    setZone(
      doc?.zone && vocabulary.zones.includes(doc.zone)
        ? doc.zone
        : (vocabulary.zones[0] ?? ""),
    );
    setRack(
      doc?.rack && vocabulary.racks.includes(doc.rack)
        ? doc.rack
        : (vocabulary.racks[0] ?? ""),
    );
    setShelf(
      doc?.shelf && vocabulary.shelves.includes(doc.shelf)
        ? doc.shelf
        : (vocabulary.shelves[0] ?? ""),
    );
    setBox(
      doc?.box && vocabulary.boxes.includes(doc.box)
        ? doc.box
        : (vocabulary.boxes[0] ?? ""),
    );
    setEditing(true);
  }

  /** Write the chosen slot. The backend refuses a partial or occupied slot. */
  async function save() {
    if (!doc) return;
    if (!zone || !rack || !shelf || !box) {
      toast.error(
        "Incomplete location",
        "Choose a zone, a rack, a shelf and a box.",
      );
      return;
    }
    setBusy(true);
    try {
      await api.setLocation(doc.id, { zone, rack, shelf, box });
      toast.success(
        "Location saved",
        `Zone ${zone} · Rack ${rack} · Shelf ${shelf} · Box ${box}`,
      );
      setEditing(false);
      await onRefresh();
    } catch (err) {
      toast.error(
        "Location not saved",
        err instanceof ApiError
          ? err.message
          : "The slot could not be assigned.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** Hand the document to the backend, which picks the first free slot. */
  async function autoAssign() {
    if (!doc) return;
    setBusy(true);
    try {
      const location = await api.autoLocation(doc.id);
      toast.success(
        "Location assigned",
        location.label ?? "The document now has a slot in the archive.",
      );
      setEditing(false);
      await onRefresh();
    } catch (err) {
      toast.error(
        "Could not auto-assign",
        err instanceof ApiError
          ? err.message
          : "No slot could be assigned.",
      );
    } finally {
      setBusy(false);
    }
  }

  /** Empty the slot and return the document to the unfiled pile. */
  async function clearLocation() {
    if (!doc) return;
    setBusy(true);
    try {
      await api.setLocation(doc.id, {
        zone: null,
        rack: null,
        shelf: null,
        box: null,
      });
      toast.success("Location cleared");
      setEditing(false);
      await onRefresh();
    } catch (err) {
      toast.error(
        "Location not cleared",
        err instanceof ApiError
          ? err.message
          : "The slot could not be cleared.",
      );
    } finally {
      setBusy(false);
    }
  }

  const located = Boolean(doc?.zone && doc?.rack && doc?.shelf && doc?.box);

  return (
    <section id="location" className="panel p-4 shadow-panel">
      <div className="flex items-center justify-between gap-2">
        <p className="label flex items-center gap-1.5">
          <MapPin className="h-3 w-3" />
          Location
        </p>
        {canEdit && !editing ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={startEditing}
            disabled={loadingLayout}
          >
            {loadingLayout ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Pencil className="h-3 w-3" />
            )}
            {located ? "Edit location" : "Assign location"}
          </Button>
        ) : null}
      </div>

      {located ? (
        <div className="mt-2">
          <LocationBreadcrumb
            zone={doc?.zone ?? null}
            rack={doc?.rack ?? null}
            shelf={doc?.shelf ?? null}
            box={doc?.box ?? null}
          />
          <Link
            href={`/warehouse/${doc?.id}`}
            className="mt-2.5 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent transition-opacity hover:opacity-80"
          >
            <MapPin className="h-3.5 w-3.5" />
            View in warehouse
          </Link>
        </div>
      ) : (
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          Not located — this document has no zone, rack, shelf or box yet.
        </p>
      )}

      {editing ? (
        <div className="mt-3 border-t border-border pt-3">
          {layoutError ? (
            <ErrorState
              message={layoutError}
              onRetry={() => loadLayout()}
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label
                    htmlFor="location-zone"
                    className="mb-1 block text-[10px] font-medium text-muted-foreground"
                  >
                    Zone
                  </label>
                  <Select value={zone} onValueChange={setZone}>
                    <SelectTrigger id="location-zone" className="h-8 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {layout?.zones.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label
                    htmlFor="location-rack"
                    className="mb-1 block text-[10px] font-medium text-muted-foreground"
                  >
                    Rack
                  </label>
                  <Select value={rack} onValueChange={setRack}>
                    <SelectTrigger id="location-rack" className="h-8 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {layout?.racks.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label
                    htmlFor="location-shelf"
                    className="mb-1 block text-[10px] font-medium text-muted-foreground"
                  >
                    Shelf
                  </label>
                  <Select value={shelf} onValueChange={setShelf}>
                    <SelectTrigger id="location-shelf" className="h-8 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {layout?.shelves.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label
                    htmlFor="location-box"
                    className="mb-1 block text-[10px] font-medium text-muted-foreground"
                  >
                    Box
                  </label>
                  <Select value={box} onValueChange={setBox}>
                    <SelectTrigger id="location-box" className="h-8 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {layout?.boxes.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  variant="accent"
                  size="xs"
                  onClick={save}
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  Save location
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={autoAssign}
                  disabled={busy}
                >
                  <Sparkles className="h-3 w-3" />
                  Auto-assign
                </Button>
                {located ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={clearLocation}
                    disabled={busy}
                  >
                    <X className="h-3 w-3" />
                    Clear location
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setEditing(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Grant a role the right to read, download or manage this document.
 *
 * The grant is written server-side and immediately changes what retrieval
 * returns for that role — it is not a label on the page.
 */
function PermissionGranter({
  onGrant,
  busy,
  existing,
}: {
  onGrant: (body: {
    grantee_type: "user" | "role";
    grantee_user_id?: string | null;
    grantee_role?: string | null;
    permission: "view" | "download" | "manage";
  }) => Promise<void>;
  busy: boolean;
  existing: Permission[];
}) {
  const [role, setRole] = useState<string>("analyst");
  const [permission, setPermission] = useState<"view" | "download" | "manage">(
    "view",
  );

  const alreadyGranted = existing.some(
    (entry) =>
      entry.grantee_type === "role" &&
      entry.grantee_role === role &&
      entry.permission === permission,
  );

  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="label mb-2">Grant access</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger className="h-7 w-[104px] text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((value) => (
              <SelectItem key={value} value={value} className="capitalize">
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={permission}
          onValueChange={(value) =>
            setPermission(value as "view" | "download" | "manage")
          }
        >
          <SelectTrigger className="h-7 w-[116px] text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERMISSIONS.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          size="xs"
          variant="accent"
          disabled={busy || alreadyGranted}
          onClick={() =>
            onGrant({
              grantee_type: "role",
              grantee_role: role,
              permission,
            })
          }
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <UserPlus className="h-3 w-3" />
          )}
          {alreadyGranted ? "Granted" : "Grant"}
        </Button>
      </div>
      {alreadyGranted && (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          That role already holds this permission.
        </p>
      )}
    </div>
  );
}

/** The extracted intelligence profile: parties, dates, values, obligations. */
function ProfilePanel({ profile }: { profile: DocumentProfile }) {
  const allSections: ProfileSection[] = [
    {
      key: "parties",
      label: "Parties and organisations",
      entries: [...(profile.parties ?? []), ...(profile.organisations ?? [])],
      render: (entry) =>
        `${entry.name ?? entry.party ?? "—"} · ${entry.role ?? "unspecified role"}`,
    },
    {
      key: "dates",
      label: "Important dates",
      entries: profile.important_dates ?? [],
      render: (entry) => `${entry.name ?? entry.label ?? "—"} · ${entry.date ?? "—"}`,
    },
    {
      key: "values",
      label: "Monetary values",
      entries: profile.monetary_values ?? [],
      render: (entry) =>
        `${entry.name ?? entry.label ?? "—"} · ${entry.amount ?? "—"}${
          entry.currency ? ` ${entry.currency}` : ""
        }`,
    },
    {
      key: "obligations",
      label: "Obligations",
      entries: profile.obligations ?? [],
      render: (entry) =>
        `${entry.name ?? entry.text ?? "—"} · ${entry.due ?? "no due date"}`,
    },
    {
      key: "clauses",
      label: "Important clauses",
      entries: profile.important_clauses ?? [],
      render: (entry) => entry.name ?? entry.text ?? "—",
    },
    {
      key: "references",
      label: "Contract references",
      entries: profile.contract_references ?? [],
      render: (entry) => entry.reference ?? entry.name ?? "—",
    },
  ];
  const sections = allSections.filter((section) => section.entries.length > 0);

  if (!sections.length) return null;

  return (
    <section className="panel p-4 shadow-panel">
      <div className="flex items-center justify-between gap-2">
        <p className="label">Intelligence profile</p>
        {profile.confidence != null && (
          <Badge variant="outline">{profile.confidence.toFixed(2)}</Badge>
        )}
      </div>

      <Accordion type="multiple" className="mt-2">
        {sections.map((section) => (
          <AccordionItem key={section.key} value={section.key} className="border-0">
            <AccordionTrigger className="py-2 text-[12px]">
              {section.label}
              <span className="ml-auto mr-1 font-mono text-[10px] text-muted-foreground">
                {section.entries.length}
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <ul className="space-y-1">
                {section.entries.map((entry, index) => (
                  <li
                    key={index}
                    className="flex items-baseline justify-between gap-2 text-[11px]"
                  >
                    <span className="min-w-0 truncate">{section.render(entry)}</span>
                    {entry.page ? (
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        p.{entry.page}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>

      {profile.keywords?.length ? (
        <>
          <Separator className="my-3" />
          <p className="label mb-1.5">Keywords</p>
          <div className="flex flex-wrap gap-1.5">
            {profile.keywords.map((keyword) => (
              <Badge key={keyword} variant="outline">
                {keyword}
              </Badge>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function Row({
  k,
  v,
  mono,
}: {
  k: string;
  v: string | number;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={mono ? "font-mono text-[11px]" : "text-[12px]"}>{v}</dd>
    </div>
  );
}

function SummaryText({ text }: { text: string }) {
  return (
    <div className="mt-2 space-y-1 text-[12px] leading-relaxed text-foreground/80">
      {text.split("\n").map((line, index) => {
        const bullet = line.match(/^\s*(?:[-•*])\s+(.*)$/);
        if (bullet) {
          return (
            <p key={index} className="flex gap-2">
              <span className="text-accent">•</span>
              <span>{bullet[1]}</span>
            </p>
          );
        }
        return line.trim() ? <p key={index}>{line}</p> : null;
      })}
    </div>
  );
}
