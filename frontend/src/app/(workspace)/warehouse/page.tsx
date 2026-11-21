"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { MapPin, Package } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { WarehouseLayout } from "@/lib/types";
import { PageBody, PageHeader } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  LoadingPanel,
  StatCard,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { WarehouseMap } from "@/components/warehouse/warehouse-map";

export default function WarehousePage() {
  const [layout, setLayout] = useState<WarehouseLayout | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLayout(await api.warehouseLayout());
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not load the warehouse layout.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const slots = layout?.slots ?? [];
  const capacity =
    (layout?.zones.length ?? 0) *
    (layout?.racks.length ?? 0) *
    (layout?.shelves.length ?? 0) *
    (layout?.boxes.length ?? 0);

  return (
    <PageBody>
      <PageHeader
        eyebrow="Knowledge"
        title="Warehouse"
        description="Every document that has been filed has a physical slot. This map shows the archive floor — zones, racks, shelves and boxes — and lists the documents you are permitted to read."
      />

      {error && <ErrorState className="mt-5" message={error} onRetry={load} />}

      {loading ? (
        <div className="mt-5">
          <LoadingPanel label="Opening the warehouse…" rows={3} />
        </div>
      ) : layout ? (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label="Zones" value={layout.zones.length} />
            <StatCard label="Racks" value={layout.racks.length} />
            <StatCard label="Shelves" value={layout.shelves.length} />
            <StatCard label="Boxes" value={layout.boxes.length} />
            <StatCard
              label="Slots in use"
              value={slots.length}
              hint={capacity ? `of ${capacity} available` : undefined}
              tone="accent"
            />
          </div>

          <section className="panel mt-5 p-4 shadow-panel">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[13px] font-semibold tracking-tight">
                Archive floor
              </h2>
              <p className="text-[11px] text-muted-foreground">
                Select a zone to open its racks.
              </p>
            </div>
            <WarehouseMap layout={layout} />
          </section>

          <section className="panel mt-5 shadow-panel">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="text-[13px] font-semibold tracking-tight">
                Located documents
              </h2>
              <p className="text-[11px] text-muted-foreground">
                {slots.length} document{slots.length === 1 ? "" : "s"} visible to
                you
              </p>
            </div>

            {slots.length ? (
              <ul className="divide-y divide-border">
                {slots.map((slot) => (
                  <li
                    key={`${slot.document_id}-${slot.zone}${slot.rack}${slot.shelf}${slot.box}`}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/library/${slot.document_id}`}
                        className="block truncate text-[13px] font-medium transition-colors hover:text-accent"
                      >
                        {slot.title || slot.filename}
                      </Link>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {slot.filename}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
                        <MapPin className="h-3 w-3" />
                        {slot.zone} - {slot.rack} - {slot.shelf} - {slot.box}
                      </span>
                      <Button asChild variant="ghost" size="xs">
                        <Link href={`/warehouse/${slot.document_id}`}>
                          <MapPin className="h-3 w-3" />
                          Locate
                        </Link>
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                className="m-4 border-0"
                icon={<Package className="h-4 w-4" />}
                title="No documents are filed yet"
                description="Nothing you can read has been given a location. Open a document in the library and assign it a slot to see it here."
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link href="/library">Open the document library</Link>
                  </Button>
                }
              />
            )}
          </section>
        </>
      ) : null}
    </PageBody>
  );
}
