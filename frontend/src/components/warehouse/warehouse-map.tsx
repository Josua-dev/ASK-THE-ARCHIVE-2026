"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { MapPin, Package, RotateCcw, ZoomIn } from "lucide-react";
import type { WarehouseLayout } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * The warehouse, drawn in CSS 3D.
 *
 * There is no three.js here and there is no new dependency: the floor is a
 * wrapper with `rotateX` plus `rotateZ` and `transform-style: preserve-3d`,
 * every raised block is a `translateZ` with a directional shadow, and the
 * camera is a framer-motion transform on the wrapper itself.
 *
 * The vocabulary is never hardcoded — zones, racks, shelves and boxes all
 * come from GET /warehouse/layout, so the map cannot drift from the archive.
 * The layout is progressively disclosed: one tile per zone, then the racks of
 * an expanded zone, then the shelves of a rack, then the boxes of a shelf.
 * All 288 slots are never on screen at once.
 */

export interface WarehouseTarget {
  zone: string | null;
  rack: string | null;
  shelf: string | null;
  box: string | null;
}

/** The isometric projection: a floor tipped towards the viewer, then turned. */
const FLOOR_ROTATE_X = 58;
const FLOOR_ROTATE_Z = 45;

const RAD = Math.PI / 180;
const COS_X = Math.cos(FLOOR_ROTATE_X * RAD);
const SIN_X = Math.sin(FLOOR_ROTATE_X * RAD);
const COS_Z = Math.cos(FLOOR_ROTATE_Z * RAD);
const SIN_Z = Math.sin(FLOOR_ROTATE_Z * RAD);

/**
 * Floor geometry, in pixels, measured before the projection.
 *
 * The four levels nest: a zone holds racks, a rack holds shelves, a shelf
 * holds boxes. Each level is sized so its children fit with a margin.
 */
const ZONE_W = 236;
const ZONE_H = 200;
const ZONE_GAP = 28;

const RACK_W = 104;
const RACK_H = 88;
const RACK_X = 112;
const RACK_Y = 96;

const SHELF_W = 30;
const SHELF_H = 34;
const SHELF_STEP = 34;
const SHELF_TOP = 18;

const BOX_W = 8;
const BOX_H = 8;
const BOX_GAP_X = 10;
const BOX_GAP_Y = 11;

/** How high each level stands off the floor. */
const RACK_Z = 30;
const BOX_Z = 16;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

/**
 * Where a floor point lands on screen once the projection is applied.
 *
 * The wrapper rotates about its centre, so the offset is measured from the
 * centre of the floor and then carried through the same rotation the floor
 * uses. The camera translates by the negative of this to frame the point.
 */
function project(dx: number, dy: number) {
  const rzX = dx * COS_Z - dy * SIN_Z;
  const rzY = dx * SIN_Z + dy * COS_Z;
  return { x: rzX, y: rzY * COS_X };
}

/** The short path a badge shows: "A - R3 - 2 - B4". */
export function locationPath(parts: {
  zone: string | null;
  rack: string | null;
  shelf: string | null;
  box: string | null;
}): string | null {
  if (!parts.zone || !parts.rack || !parts.shelf || !parts.box) return null;
  return `${parts.zone} - ${parts.rack} - ${parts.shelf} - ${parts.box}`;
}

export function WarehouseMap({
  layout,
  target = null,
  className,
}: {
  layout: WarehouseLayout;
  target?: WarehouseTarget | null;
  className?: string;
}) {
  // Which levels are open. The target's own path is opened automatically, so
  // the reader lands on the box rather than on a list of zone tiles.
  const [openZone, setOpenZone] = useState<string | null>(null);
  const [openRack, setOpenRack] = useState<string | null>(null);
  const [openShelf, setOpenShelf] = useState<string | null>(null);
  const [view, setView] = useState<"overview" | "zone" | "box">("overview");

  // The target is compared by value, not by identity — a parent that builds a
  // fresh object on every render must not reopen the path behind the reader.
  const targetZone = target?.zone ?? null;
  const targetRack = target?.rack ?? null;
  const targetShelf = target?.shelf ?? null;
  const targetBox = target?.box ?? null;

  // Open the path to the target whenever the target changes.
  useEffect(() => {
    if (!targetZone) return;
    setOpenZone(targetZone);
    setOpenRack(targetRack);
    setOpenShelf(targetShelf);
    setView("box");
  }, [targetZone, targetRack, targetShelf, targetBox]);

  const occupied = useMemo(() => {
    const map = new Map<
      string,
      { documentId: string; filename: string; title: string | null }
    >();
    for (const slot of layout.slots) {
      map.set(`${slot.zone}|${slot.rack}|${slot.shelf}|${slot.box}`, {
        documentId: slot.document_id,
        filename: slot.filename,
        title: slot.title,
      });
    }
    return map;
  }, [layout.slots]);

  const zoneCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const slot of layout.slots) {
      counts.set(slot.zone, (counts.get(slot.zone) ?? 0) + 1);
    }
    return counts;
  }, [layout.slots]);

  const openZoneTile = useCallback((zone: string) => {
    // Clicking the open zone folds it back to the overview.
    if (openZone === zone) {
      setOpenZone(null);
      setOpenRack(null);
      setOpenShelf(null);
      setView("overview");
      return;
    }
    setOpenZone(zone);
    setOpenRack(null);
    setOpenShelf(null);
    setView("zone");
  }, [openZone]);

  const showOverview = () => {
    setView("overview");
    setOpenZone(null);
    setOpenRack(null);
    setOpenShelf(null);
  };

  const showTarget = () => {
    if (!targetZone) return;
    setOpenZone(targetZone);
    setOpenRack(targetRack);
    setOpenShelf(targetShelf);
    setView("box");
  };

  return (
    <div className={cn("relative", className)}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          variant={view === "overview" ? "subtle" : "outline"}
          size="sm"
          onClick={showOverview}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Overview
        </Button>
        <Button
          variant={view === "box" ? "subtle" : "outline"}
          size="sm"
          onClick={showTarget}
          disabled={!targetZone}
        >
          <ZoomIn className="h-3.5 w-3.5" />
          Zoom to box
        </Button>
        <WarehouseLegend />
      </div>

      <WarehouseScene
        layout={layout}
        openZone={openZone}
        openZoneTile={openZoneTile}
        openRack={openRack}
        setOpenRack={setOpenRack}
        openShelf={openShelf}
        setOpenShelf={setOpenShelf}
        view={view}
        target={target}
        occupied={occupied}
        zoneCounts={zoneCounts}
      />
    </div>
  );
}

/**
 * The floor itself.
 *
 * The wrapper carries the isometric projection and the camera. The camera is
 * a single transform on that wrapper: it starts wide and settles on a
 * framing of the target, so the view visibly flies to the box.
 */
function WarehouseScene({
  layout,
  openZone,
  openZoneTile,
  openRack,
  setOpenRack,
  openShelf,
  setOpenShelf,
  view,
  target,
  occupied,
  zoneCounts,
}: {
  layout: WarehouseLayout;
  openZone: string | null;
  openZoneTile: (zone: string) => void;
  openRack: string | null;
  setOpenRack: (rack: string | null) => void;
  openShelf: string | null;
  setOpenShelf: (shelf: string | null) => void;
  view: "overview" | "zone" | "box";
  target: WarehouseTarget | null;
  occupied: Map<
    string,
    { documentId: string; filename: string; title: string | null }
  >;
  zoneCounts: Map<string, number>;
}) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // The scene is measured so the camera can be framed in pixels rather than
  // in guessed percentages, and so it can shrink to fit a phone.
  useEffect(() => {
    const node = sceneRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setWidth(rect.width);
    });
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  const columns = 2;
  const floorWidth = columns * (ZONE_W + ZONE_GAP) - ZONE_GAP;
  const floorHeight =
    Math.ceil(layout.zones.length / columns) * (ZONE_H + ZONE_GAP) - ZONE_GAP;

  // Fit the whole warehouse to the panel, then move in on the target.
  const fit = width ? clamp(width / (floorWidth + 48), 0.52, 1) : 1;

  /** Where the camera is pointing, in floor coordinates. */
  const focus = useMemo(() => {
    if (view === "box" && target?.zone && target.rack && target.shelf && target.box) {
      const zoneIndex = layout.zones.indexOf(target.zone);
      const rackIndex = layout.racks.indexOf(target.rack);
      const shelfIndex = layout.shelves.indexOf(target.shelf);
      const boxIndex = layout.boxes.indexOf(target.box);
      if (zoneIndex < 0 || rackIndex < 0 || shelfIndex < 0 || boxIndex < 0) {
        return null;
      }
      return {
        x:
          (zoneIndex % columns) * (ZONE_W + ZONE_GAP) +
          (rackIndex % 2) * RACK_X +
          shelfIndex * SHELF_STEP +
          (boxIndex % 3) * BOX_GAP_X +
          BOX_W / 2,
        y:
          Math.floor(zoneIndex / columns) * (ZONE_H + ZONE_GAP) +
          Math.floor(rackIndex / 2) * RACK_Y +
          SHELF_TOP +
          8 +
          Math.floor(boxIndex / 3) * BOX_GAP_Y +
          BOX_H / 2,
        z: RACK_Z + (shelfIndex + 1) * 16 + BOX_Z + 12,
        zoom: 1.5,
      };
    }
    if (view === "zone" && openZone) {
      const zoneIndex = layout.zones.indexOf(openZone);
      if (zoneIndex < 0) return null;
      return {
        x: (zoneIndex % columns) * (ZONE_W + ZONE_GAP) + ZONE_W / 2,
        y: Math.floor(zoneIndex / columns) * (ZONE_H + ZONE_GAP) + ZONE_H / 2,
        z: 0,
        zoom: 1.28,
      };
    }
    return null;
  }, [view, target, openZone, layout, columns]);

  // The camera transform. The floor is rotated about its own centre, so the
  // offset to the focus point is carried through the same rotation.
  const scale = fit * (focus?.zoom ?? 1);
  const camera = useMemo(() => {
    if (!focus) return { x: 0, y: 0 };
    const point = project(
      focus.x - floorWidth / 2,
      focus.y - floorHeight / 2,
    );
    return { x: -point.x * scale, y: -point.y * scale };
  }, [focus, floorWidth, floorHeight, scale]);

  return (
    <div
      ref={sceneRef}
      className="warehouse-scene relative overflow-hidden rounded-lg border border-border bg-surface"
      style={{ height: "clamp(320px, 46vw, 460px)" }}
    >
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ perspective: 1400 }}
      >
        <motion.div
          className="relative"
          style={{
            width: floorWidth,
            height: floorHeight,
            transformStyle: "preserve-3d",
          }}
          initial={{
            scale: fit * 0.88,
            rotateX: FLOOR_ROTATE_X + 5,
            rotateZ: FLOOR_ROTATE_Z,
            x: 0,
            y: 0,
          }}
          animate={{
            scale,
            rotateX: FLOOR_ROTATE_X,
            rotateZ: FLOOR_ROTATE_Z,
            x: camera.x,
            y: camera.y,
          }}
          transition={{ type: "spring", stiffness: 48, damping: 16, mass: 1 }}
        >
          {/* The floor plate the zones stand on. */}
          <div
            className="absolute rounded-[14px] border border-border bg-surface-muted/40"
            style={{
              left: -ZONE_GAP,
              top: -ZONE_GAP,
              width: floorWidth + ZONE_GAP * 2,
              height: floorHeight + ZONE_GAP * 2,
              transform: "translateZ(-10px)",
            }}
          />

          {layout.zones.map((zone, zoneIndex) => {
            const zoneExpanded = openZone === zone;
            return (
              <div
                key={zone}
                className="absolute"
                style={{
                  left: (zoneIndex % columns) * (ZONE_W + ZONE_GAP),
                  top: Math.floor(zoneIndex / columns) * (ZONE_H + ZONE_GAP),
                  width: ZONE_W,
                  height: ZONE_H,
                  transformStyle: "preserve-3d",
                }}
              >
                {/* A zone: the outermost grouping of the warehouse. */}
                <button
                  type="button"
                  onClick={() => openZoneTile(zone)}
                  aria-expanded={zoneExpanded}
                  className={cn(
                    "absolute inset-0 rounded-[10px] border text-left transition-colors",
                    zoneExpanded
                      ? "border-accent/60 bg-accent/[0.07]"
                      : "border-border bg-surface hover:border-accent/40",
                  )}
                >
                  <FloorLabel className="left-2 top-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Zone {zone}
                  </FloorLabel>
                  <FloorLabel className="right-2 top-1.5 font-mono text-[10px] text-muted-foreground">
                    {zoneCounts.get(zone) ?? 0}
                  </FloorLabel>
                </button>

                {/* Only the open zone is expanded. The other zones stay as
                    tiles, so the map never holds all 288 slots at once. */}
                {zoneExpanded &&
                  layout.racks.map((rack, rackIndex) => {
                    const rackExpanded = openRack === rack;
                    return (
                      <div
                        key={rack}
                        className="absolute"
                        style={{
                          left: (rackIndex % 2) * RACK_X,
                          top: Math.floor(rackIndex / 2) * RACK_Y,
                          width: RACK_W,
                          height: RACK_H,
                          transformStyle: "preserve-3d",
                        }}
                      >
                        {/* A rack: the second grouping, raised off the floor. */}
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpenRack(rackExpanded ? null : rack);
                            if (!rackExpanded) setOpenShelf(null);
                          }}
                          aria-expanded={rackExpanded}
                          aria-label={`Rack ${rack}`}
                          className={cn(
                            "absolute inset-0 rounded-[6px] border text-left",
                            rackExpanded
                              ? "border-accent/50 bg-foreground/[0.08]"
                              : "border-foreground/20 bg-foreground/[0.06]",
                            "cursor-pointer",
                          )}
                          style={{
                            transform: `translateZ(${RACK_Z}px)`,
                            boxShadow:
                              "5px 7px 0 0 hsl(var(--foreground) / 0.07), 0 0 0 1px hsl(var(--foreground) / 0.05)",
                          }}
                        >
                          <FloorLabel className="left-1.5 top-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                            {rack}
                          </FloorLabel>
                        </button>

                        {/* Only the open rack shows its shelves. */}
                        {rackExpanded &&
                          layout.shelves.map((shelf, shelfIndex) => {
                            const shelfExpanded = openShelf === shelf;
                            const shelfZ = RACK_Z + (shelfIndex + 1) * 16;
                            return (
                              <div
                                key={shelf}
                                className="absolute"
                                style={{
                                  left: shelfIndex * SHELF_STEP,
                                  top: SHELF_TOP,
                                  width: SHELF_W,
                                  height: SHELF_H,
                                  transformStyle: "preserve-3d",
                                }}
                              >
                                {/* A shelf: the third grouping, on top of the rack. */}
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setOpenShelf(shelfExpanded ? null : shelf);
                                  }}
                                  aria-expanded={shelfExpanded}
                                  aria-label={`Shelf ${shelf}`}
                                  className={cn(
                                    "absolute inset-0 rounded-[3px] border",
                                    shelfExpanded
                                      ? "border-accent/50 bg-surface"
                                      : "border-foreground/20 bg-surface",
                                    "cursor-pointer",
                                  )}
                                  style={{
                                    transform: `translateZ(${shelfZ}px)`,
                                    boxShadow:
                                      "3px 4px 0 0 hsl(var(--foreground) / 0.06)",
                                  }}
                                >
                                  <FloorLabel className="left-1 top-0.5 text-[8px] font-medium text-muted-foreground">
                                    {shelf}
                                  </FloorLabel>
                                </button>

                                {/* Only the open shelf shows its boxes. */}
                                {shelfExpanded &&
                                  layout.boxes.map((box, boxIndex) => {
                                    const key = `${zone}|${rack}|${shelf}|${box}`;
                                    const occupant = occupied.get(key);
                                    const isBoxTarget = Boolean(
                                      target &&
                                        target.zone === zone &&
                                        target.rack === rack &&
                                        target.shelf === shelf &&
                                        target.box === box,
                                    );

                                    return (
                                      <BoxBlock
                                        key={key}
                                        box={box}
                                        boxIndex={boxIndex}
                                        shelfZ={shelfZ}
                                        documentId={occupant?.documentId ?? null}
                                        filename={occupant?.filename ?? null}
                                        title={occupant?.title ?? null}
                                        isTarget={isBoxTarget}
                                      />
                                    );
                                  })}
                              </div>
                            );
                          })}
                      </div>
                    );
                  })}
              </div>
            );
          })}

          {/* The marker floats above the target box and moves with it. */}
          {focus?.z && target?.box && (
            <MapPinMarker
              x={focus.x}
              y={focus.y}
              z={focus.z}
              label={`Box ${target.box}`}
            />
          )}
        </motion.div>
      </div>

      {view !== "overview" && target?.zone && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded-md border border-border bg-surface/90 px-2.5 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm">
          Viewing Zone {target.zone}
        </div>
      )}
    </div>
  );
}

/**
 * A label that lies flat on the floor but stays readable.
 *
 * The floor is rotated, so a plain label would be squashed into the
 * projection. Cancelling the floor's rotation turns it back towards the
 * reader without lifting it off the surface.
 */
function FloorLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn("absolute whitespace-nowrap", className)}
      style={{
        transform: `rotateZ(${-FLOOR_ROTATE_Z}deg) rotateX(${-FLOOR_ROTATE_X}deg)`,
        transformOrigin: "left top",
      }}
    >
      {children}
    </span>
  );
}

/** One slot. Occupied slots open the document that sits in them. */
function BoxBlock({
  box,
  boxIndex,
  shelfZ,
  documentId,
  filename,
  title,
  isTarget,
}: {
  box: string;
  boxIndex: number;
  shelfZ: number;
  documentId: string | null;
  filename: string | null;
  title: string | null;
  isTarget: boolean;
}) {
  const style = {
    left: (boxIndex % 3) * BOX_GAP_X,
    top: 8 + Math.floor(boxIndex / 3) * BOX_GAP_Y,
    width: BOX_W,
    height: BOX_H,
  };

  const className = cn(
    "absolute rounded-[2px] border",
    isTarget
      ? "border-accent bg-accent"
      : documentId
        ? "border-foreground/25 bg-foreground/25"
        : "border-foreground/10 bg-transparent",
  );

  if (!documentId) {
    return <div className={className} style={style} aria-hidden="true" />;
  }

  const description = title || filename || `Document in box ${box}`;

  return (
    <motion.div
      className={cn(className, "cursor-pointer")}
      style={{
        ...style,
        transform: `translateZ(${shelfZ + BOX_Z + (isTarget ? 12 : 0)}px)`,
      }}
      whileHover={{ scale: 1.35 }}
      transition={{ type: "spring", stiffness: 420, damping: 20 }}
    >
      {isTarget && (
        <motion.span
          className="absolute -inset-1 rounded-[3px] bg-accent"
          animate={{ opacity: [0.2, 0.7, 0.2], scale: [0.9, 1.5, 0.9] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      <Link
        href={`/library/${documentId}`}
        className="absolute inset-0"
        title={description}
        aria-label={`Open ${description}`}
      />
    </motion.div>
  );
}

/**
 * The pin above the target box.
 *
 * It drops in on a spring and slides to a new position when the target
 * changes, so the reader sees where the box moved to.
 */
function MapPinMarker({
  x,
  y,
  z,
  label,
}: {
  x: number;
  y: number;
  z: number;
  label: string;
}) {
  return (
    <motion.div
      className="pointer-events-none absolute left-0 top-0"
      style={{ transformStyle: "preserve-3d" }}
      initial={{ x, y, opacity: 0 }}
      animate={{ x, y, opacity: 1 }}
      transition={{ type: "spring", stiffness: 180, damping: 18 }}
    >
      <motion.div
        initial={{ z: z + 46, opacity: 0 }}
        animate={{ z, opacity: 1 }}
        transition={{ type: "spring", stiffness: 160, damping: 14 }}
      >
        <div className="absolute" style={{ transform: "translate(-50%, -100%)" }}>
          <motion.div
            className="flex flex-col items-center"
            animate={{ y: [0, -5, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
          >
            <MapPin className="h-5 w-5 text-accent drop-shadow-[0_2px_4px_rgba(0,0,0,0.35)]" />
            <span className="mt-0.5 whitespace-nowrap rounded border border-accent/40 bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-accent">
              {label}
            </span>
          </motion.div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** The colour key. Kept next to the scene so the two cannot drift apart. */
function WarehouseLegend() {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-[2px] bg-accent" />
        This document
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-[2px] bg-foreground/25" />
        Occupied
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-[2px] border border-foreground/20" />
        Empty
      </span>
    </div>
  );
}

/** The path breadcrumb: Zone A → Rack R3 → Shelf 2 → Box B4. */
export function LocationBreadcrumb({
  zone,
  rack,
  shelf,
  box,
}: {
  zone: string | null;
  rack: string | null;
  shelf: string | null;
  box: string | null;
}) {
  const parts = [
    zone ? { label: `Zone ${zone}` } : null,
    rack ? { label: `Rack ${rack}` } : null,
    shelf ? { label: `Shelf ${shelf}` } : null,
    box ? { label: `Box ${box}` } : null,
  ].filter((part): part is { label: string } => part !== null);

  if (!parts.length) {
    return (
      <p className="text-[12px] text-muted-foreground">
        This document has no assigned location.
      </p>
    );
  }

  return (
    <nav aria-label="Location path" className="flex flex-wrap items-center gap-1.5">
      {parts.map((part, index) => (
        <span key={part.label} className="flex items-center gap-1.5">
          {index > 0 && (
            <span aria-hidden="true" className="text-muted-foreground/50">
              →
            </span>
          )}
          <span
            className={cn(
              "font-mono text-[12px]",
              index === parts.length - 1
                ? "font-semibold text-accent"
                : "text-muted-foreground",
            )}
          >
            {part.label}
          </span>
        </span>
      ))}
    </nav>
  );
}

/** The glyph shown for a document that has no slot yet. */
export function PackageGlyph({ className }: { className?: string }) {
  return <Package className={cn("h-4 w-4", className)} />;
}
