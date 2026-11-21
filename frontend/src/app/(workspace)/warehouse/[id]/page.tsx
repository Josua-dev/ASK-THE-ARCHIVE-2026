"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, MapPin, Package } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { ArchiveDocument, WarehouseLayout, CheckoutInfo } from "@/lib/types";
import { PageBody, PageHeader } from "@/components/ui";
import { EmptyState, ErrorState, LoadingPanel } from "@/components/states";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";
import { WarehouseLocator } from "@/components/warehouse/warehouse-locator";
import { LocationBreadcrumb } from "@/components/warehouse/warehouse-map";

export default function WarehouseDocumentPage() {
  const { id } = useParams<{ id: string }>();

  const [doc, setDoc] = useState<ArchiveDocument | null>(null);
  const [layout, setLayout] = useState<WarehouseLayout | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{
    zone: string;
    rack: string;
    shelf: string;
    box: string;
    occupants: {
      documentId: string;
      filename: string;
      title: string | null;
      position: number;
      totalInBox: number;
      checkout: CheckoutInfo | null;
    }[];
  } | null>(null);
  const { theme } = useTheme();

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setLayoutError(null);
    try {
      setDoc(await api.document(id));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not load this document.",
      );
      setLoading(false);
      return;
    }
    try {
      setLayout(await api.warehouseLayout());
    } catch (err) {
      setLayoutError(
        err instanceof ApiError
          ? err.message
          : "Could not load the warehouse layout.",
      );
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const located = Boolean(doc?.zone && doc?.rack && doc?.shelf && doc?.box);
  const locationPath = doc?.zone && doc?.rack && doc?.shelf && doc?.box
    ? `Zone ${doc.zone} / Rack ${doc.rack} / Shelf ${doc.shelf} / Box ${doc.box}`
    : null;

  return (
    <PageBody>
      <Link
        href="/warehouse"
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-accent"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to the warehouse
      </Link>

      {error && (
        <ErrorState
          className="mt-4"
          title="This document could not be opened"
          message={error}
          onRetry={load}
        />
      )}

      <div className="mt-4">
        <PageHeader
          eyebrow="Warehouse"
          title={doc?.title || doc?.filename || "Document"}
          description={doc?.filename && doc?.title ? doc.filename : undefined}
        />
      </div>

      {loading ? (
        <div className="mt-4">
          <LoadingPanel label="Locating the document…" rows={3} />
        </div>
      ) : located ? (
        <>
          <section className="panel mt-5 p-4 shadow-panel">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className="label flex items-center gap-1.5">
                <MapPin className="h-3 w-3" />
                Location path
              </p>
              <LocationBreadcrumb
                zone={doc?.zone ?? null}
                rack={doc?.rack ?? null}
                shelf={doc?.shelf ?? null}
                box={doc?.box ?? null}
              />
            </div>

            {layoutError ? (
              <ErrorState message={layoutError} onRetry={load} />
            ) : layout ? (
              <WarehouseLocator
                location={{
                  zone: doc?.zone ?? null,
                  rack: doc?.rack ?? null,
                  shelf: doc?.shelf ?? null,
                  box: doc?.box ?? null,
                }}
                occupied={layout.slots}
                dark={theme === "dark"}
                documentId={id}
                onBoxClick={({ zone, rack, shelf, box, occupants }) =>
                  setPicked({ zone, rack, shelf, box, occupants })
                }
              />
            ) : (
              <LoadingPanel label="Loading the archive floor…" rows={1} />
            )}

            {picked && (
              <div className="mt-3 rounded-lg border border-border bg-surface-muted/60 p-3">
                <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
                  Selected box
                </p>
                <p className="mt-1 text-[13px] font-medium">
                  Zone {picked.zone} / Rack {picked.rack} / Shelf {picked.shelf} / Box {picked.box}
                  {picked.occupants.length > 1 && (
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      ({picked.occupants.length} documents)
                    </span>
                  )}
                </p>
                <div className="mt-2 space-y-1.5">
                  {picked.occupants.map((o) => (
                    <div key={o.documentId} className="flex items-center gap-2 text-[12px]">
                      <span className="font-mono text-muted-foreground">
                        {o.position} of {o.totalInBox}
                      </span>
                      <span className="font-medium">{o.title || o.filename || "Untitled"}</span>
                      {o.checkout && (
                        <span className="text-amber-600 dark:text-amber-400">
                          Checked out by {o.checkout.by} · due {o.checkout.dueAt}
                        </span>
                      )}
                      <Button asChild variant="ghost" size="xs">
                        <Link href={`/library/${o.documentId}`}>
                          <MapPin className="h-3 w-3" />
                          Open
                        </Link>
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </>
      ) : (
        <EmptyState
          className="mt-5"
          icon={<Package className="h-4 w-4" />}
          title="This document has no assigned location"
          description="Nothing in the archive has been assigned to it yet. Give it a zone, rack, shelf and box and it will appear on the warehouse floor."
          action={
            <Button asChild variant="accent" size="sm">
              <Link href={`/library/${id}#location`}>
                <MapPin className="h-3.5 w-3.5" />
                Assign a location
              </Link>
            </Button>
          }
        />
      )}
    </PageBody>
  );
}