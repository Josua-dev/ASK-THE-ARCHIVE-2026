"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { Package } from "lucide-react";
import type { WarehouseSlot as AppWarehouseSlot, CheckoutInfo } from "@/lib/types";

/**
 * Parses a location path string like "Zone A / Rack R1 / Shelf 3 / Box B2"
 * into { zone, rack, shelf, box } or returns null if unparsable.
 */
export function parseLocationPath(path: string | null): {
  zone: string | null;
  rack: string | null;
  shelf: string | null;
  box: string | null;
} | null {
  if (!path) return null;
  const parts = path.split("/").map((p) => p.trim());
  const zonePart = parts.find((p) => p.startsWith("Zone"));
  const rackPart = parts.find((p) => p.startsWith("Rack"));
  const boxPart = parts.find((p) => p.startsWith("Box"));
  const shelfPart = parts.find((p) => /^\d+$/.test(p));

  if (!zonePart || !rackPart || !boxPart || !shelfPart) return null;

  return {
    zone: zonePart.replace("Zone", "").trim(),
    rack: rackPart.replace("Rack", "").trim(),
    shelf: shelfPart,
    box: boxPart.replace("Box", "").trim(),
  };
}

/** The warehouse vocabulary — must match the backend's single source of truth. */
const ZONES = ["A", "B", "C", "D"] as const;
const RACKS = ["R1", "R2", "R3", "R4"] as const;
const SHELVES = ["1", "2", "3"] as const;
const BOXES = ["B1", "B2", "B3", "B4", "B5", "B6"] as const;

const zoneMap = new Map<string, number>(ZONES.map((z, i) => [z, i]));
const rackMap = new Map<string, number>(RACKS.map((r, i) => [r, i]));
const shelfMap = new Map<string, number>(SHELVES.map((s, i) => [s, i]));
const boxMap = new Map<string, number>(BOXES.map((b, i) => [b, i]));

/** Internal slot type with camelCase documentId for the component. */
interface WarehouseSlot {
  zone: string;
  rack: string;
  shelf: string;
  box: string;
  documentId: string;
  filename: string;
  title: string | null;
  createdAt: string;
  position: number;
  totalInBox: number;
  checkout: CheckoutInfo | null;
}

/** Converts app's WarehouseSlot (document_id snake_case) to component's WarehouseSlot (documentId camelCase). */
function toComponentSlot(s: AppWarehouseSlot): WarehouseSlot {
  return {
    zone: s.zone,
    rack: s.rack,
    shelf: s.shelf,
    box: s.box,
    documentId: s.document_id,
    filename: s.filename,
    title: s.title,
    createdAt: s.created_at,
    position: s.position,
    totalInBox: s.total_in_box,
    checkout: s.checkout,
  };
}

function isOverdue(dueAt: string): boolean {
  return new Date(dueAt + "T23:59:59") < new Date();
}

// -------------------------------------------------------------------------
// Geometry constants (match the existing WarehouseMap CSS-isometric layout)
// -------------------------------------------------------------------------
const zoneW = 236;
const zoneH = 200;
const zoneGap = 28;
const rackW = 104;
const rackH = 88;
const rackX = 112;
const rackY = 96;
const shelfW = 30;
const shelfH = 34;
const shelfStep = 34;
const shelfTop = 18;
const boxW = 8;
const boxH = 8;
const boxGapX = 10;
const boxGapY = 11;
const rackZ = 30;
const boxZ = 16;
const columns = 2;

// -------------------------------------------------------------------------
// Accent color helpers — read the app's HSL token so the pin and target box
// always match the active theme.
// -------------------------------------------------------------------------
function readAccentHsl(): string {
  if (typeof window === "undefined") return "24.5 44% 51%";
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent");
  return raw.trim() || "24.5 44% 51%";
}

/** Parse an "H S% L%" CSS token into a THREE.Color. */
function accentColor(dark: boolean): THREE.Color {
  const hsl = readAccentHsl();
  const m = hsl.match(/(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/);
  if (!m) return new THREE.Color(dark ? 0xd08a5a : 0xb9784b);
  const h = +m[1] / 360;
  const s = +m[2] / 100;
  const l = +m[3] / 100;
  // Dark mode needs a slightly lighter accent for visibility.
  const adjusted = dark ? Math.min(l + 0.07, 0.62) : l;
  return new THREE.Color().setHSL(h, s, adjusted);
}

/** Group slots by their box key (zone|rack|shelf|box). */
function groupByBox(slots: WarehouseSlot[]) {
  const map = new Map<string, WarehouseSlot[]>();
  for (const s of slots) {
    const key = `${s.zone}|${s.rack}|${s.shelf}|${s.box}`;
    map.set(key, (map.get(key) ?? []).concat(s));
  }
  return map;
}

/** Determine the colour for a box given its occupants. */
function boxColor(
  isTarget: boolean,
  hasCheckout: boolean,
  isOverdue: boolean,
  dark: boolean,
) {
  if (isTarget) return accentColor(dark).getHex();
  if (isOverdue) return dark ? 0x5a2d2d : 0xd04437; // red-ish
  if (hasCheckout) return dark ? 0x5a4d2d : 0xc9762e; // amber-ish
  return dark ? 0x33363b : 0xf5f3ef; // occupied or empty
}

function boxLabel(
  isTarget: boolean,
  occupants: WarehouseSlot[],
  hasCheckout: boolean,
  isOverdue: boolean,
  targetSlot: WarehouseSlot | null,
) {
  if (isTarget && targetSlot) {
    const { position, totalInBox } = targetSlot;
    if (totalInBox <= 1) return `Box ${targetSlot.box}`;
    return `Box ${targetSlot.position} of ${totalInBox}`;
  }
  // Non-target: show how many documents in the box
  return occupants.length > 0 ? `Box ${occupants[0].box} (${occupants.length})` : `—`;
}

/**
 * Build the full warehouse scene (zones → racks → shelves → boxes).
 * Pure geometry helper: mutates the given scene and returns the list of
 * clickable box meshes.
 */
function buildWarehouse(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  slots: WarehouseSlot[],
  dark: boolean,
  hasLocation: boolean,
  locZone: string | null,
  locRack: string | null,
  locShelf: string | null,
  locBox: string | null,
  targetZoneIdx: number,
  targetRackIdx: number,
  targetShelfIdx: number,
  targetBoxIdx: number,
  targetDocumentId: string | null,
): THREE.Mesh[] {
  // Clear previous children
  while (scene.children.length > 0) {
    scene.remove(scene.children[0]);
  }

  // Group slots by box so multi-doc boxes render correctly.
  const byBox = groupByBox(slots);

  scene.add(new THREE.AmbientLight(0xffffff, dark ? 0.35 : 0.55));

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
  dirLight.position.set(50, 80, 60);
  scene.add(dirLight);

  const floorWidth = columns * (zoneW + zoneGap) - zoneGap;
  const floorHeight = Math.ceil(ZONES.length / columns) * (zoneH + zoneGap) - zoneGap;

  // Floor plate
  const floorGeo = new THREE.PlaneGeometry(floorWidth + zoneGap * 2, floorHeight + zoneGap * 2);
  const floorMat = new THREE.MeshStandardMaterial({
    color: dark ? 0x1c1e21 : 0xf3f1ec,
    roughness: 0.9,
    metalness: 0.02,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(floorWidth / 2, floorHeight / 2, -6);
  floor.receiveShadow = true;
  scene.add(floor);

  const boxMeshes: THREE.Mesh[] = [];

  // Build each zone
  for (let zi = 0; zi < ZONES.length; zi++) {
    const zone = ZONES[zi];
    const zOff = (zi % columns) * (zoneW + zoneGap);
    const zRow = Math.floor(zi / columns) * (zoneH + zoneGap);

    // Zone base plate
    const zoneGeo = new THREE.BoxGeometry(zoneW, zoneH, 1);
    const zoneMat = new THREE.MeshStandardMaterial({
      color: dark ? 0x2a2d31 : 0xe8e5de,
    });
    const zoneMesh = new THREE.Mesh(zoneGeo, zoneMat);
    zoneMesh.position.set(zOff + zoneW / 2, zRow + zoneH / 2, rackZ - 2);
    scene.add(zoneMesh);

    // Racks inside this zone
    for (let ri = 0; ri < RACKS.length; ri++) {
      const rack = RACKS[ri];
      const rOff = (ri % 2) * rackX;
      const rRow = Math.floor(ri / 2) * rackY;

      const rackGeo = new THREE.BoxGeometry(rackW, rackH, 1);
      const rackMat = new THREE.MeshStandardMaterial({
        color: dark ? 0x3a3d42 : 0xd8d5cd,
      });
      const rackMesh = new THREE.Mesh(rackGeo, rackMat);
      rackMesh.position.set(zOff + rOff + rackW / 2, zRow + rRow + rackH / 2, rackZ);
      scene.add(rackMesh);

      // Shelves inside this rack
      for (let si = 0; si < SHELVES.length; si++) {
        const shelf = SHELVES[si];
        const sOff = si * shelfStep;

        const shelfGeo = new THREE.BoxGeometry(shelfW, shelfH, 1);
        const shelfMat = new THREE.MeshStandardMaterial({
          color: dark ? 0x4a4d52 : 0xc8c5bd,
        });
        const shelfMesh = new THREE.Mesh(shelfGeo, shelfMat);
        shelfMesh.position.set(
          zOff + rOff + shelfW / 2,
          zRow + sOff + shelfTop,
          rackZ + rackZ,
        );
        scene.add(shelfMesh);

        // Boxes inside this shelf
        for (let bi = 0; bi < BOXES.length; bi++) {
          const box = BOXES[bi];
          const bOffX = (bi % 3) * boxGapX;
          const bOffY = Math.floor(bi / 3) * boxGapY;

          const isTarget =
            hasLocation &&
            zone === locZone &&
            rack === locRack &&
            shelf === locShelf &&
            box === locBox;

          const key = `${zone}|${rack}|${shelf}|${box}`;
          const occupants = byBox.get(key) ?? [];

          // Box-level checkout status: any occupant checked out, any overdue.
          let hasCheckout = false;
          let isOverdueBox = false;
          for (const occ of occupants) {
            if (occ.checkout) {
              hasCheckout = true;
              if (isOverdue(occ.checkout.dueAt)) {
                isOverdueBox = true;
              }
            }
          }

          // The target slot within this box (the document being viewed), for the pin label.
          const targetSlot = isTarget && targetDocumentId
            ? occupants.find((o) => o.documentId === targetDocumentId)
            : null;

          const boxGeo = new THREE.BoxGeometry(boxW, boxH, boxW);
          const boxMat = new THREE.MeshStandardMaterial({
            color: boxColor(isTarget, hasCheckout, isOverdueBox, dark),
            roughness: 0.7,
            metalness: 0.1,
          });
          const boxMesh = new THREE.Mesh(boxGeo, boxMat);
          const boxWorldX = zOff + rOff + bOffX + boxW / 2;
          const boxWorldY = zRow + bOffY + shelfTop + boxH / 2;
          const boxWorldZ = rackZ + boxZ + (si + 1) * 16;
          boxMesh.position.set(boxWorldX, boxWorldY, boxWorldZ);
          boxMesh.userData = {
            zone,
            rack,
            shelf,
            box,
            occupants: occupants.map((o) => ({
              documentId: o.documentId,
              filename: o.filename,
              title: o.title,
              position: o.position,
              totalInBox: o.totalInBox,
              checkout: o.checkout,
            })),
          };
          scene.add(boxMesh);
          boxMeshes.push(boxMesh);

          // --- CSS2D Pin above the target box ---
          if (isTarget) {
            const pinZ = boxWorldZ + boxZ + 12;
            const pinDiv = document.createElement("div");
            pinDiv.className =
              "pointer-events-none flex flex-col items-center rounded-md border border-accent/40 bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-accent shadow-lg";
            pinDiv.innerHTML = `
              <svg class="h-4 w-4 text-accent" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7.41 8.59L12 12.17l4.59 4.58L15 10.15l-5.41 2.11L17.86 15l-3.37 4.46L19.79 21l-2.95-6.66L12 14.59 5.41 20.82l-2.81-5.45z"/>
              </svg>
              <span class="mt-0.5 whitespace-nowrap">${boxLabel(
                isTarget,
                occupants,
                hasCheckout,
                isOverdueBox,
                targetSlot ?? null,
              )}</span>
            `;
            const pinObj = new CSS2DObject(pinDiv);
            pinObj.position.set(boxWorldX, boxWorldY, pinZ);
            scene.add(pinObj);
          }
        }
      }
    }

    // CSS2D: Location breadcrumb in the corner
    if (hasLocation) {
      const crumbDiv = document.createElement("div");
      crumbDiv.className =
        "pointer-events-none absolute left-2 top-2 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground";
      crumbDiv.innerHTML = `Zone ${locZone} → Rack ${locRack} → Shelf ${locShelf} → Box ${locBox}`;
      const crumbObj = new CSS2DObject(crumbDiv);
      crumbObj.position.set(-50, 50, 0);
      scene.add(crumbObj);
    }

    // Camera framing for the target box
    if (hasLocation && targetZoneIdx >= 0) {
      const focusX =
        (targetZoneIdx % columns) * (zoneW + zoneGap) +
        (targetRackIdx >= 0 ? targetRackIdx * rackX : 0) +
        (targetShelfIdx >= 0 ? targetShelfIdx * shelfStep : 0) +
        (targetBoxIdx >= 0 ? targetBoxIdx * boxGapX : 0) +
        (BOXES.length / 2) * boxGapX;
      const focusY =
        Math.floor(targetZoneIdx / columns) * (zoneH + zoneGap) +
        shelfTop +
        8 +
        (targetBoxIdx >= 0 ? Math.floor(targetBoxIdx / 3) * boxGapY : 0);
      const focusZ = rackZ + (targetShelfIdx >= 0 ? (targetShelfIdx + 1) * 16 : 0) + boxZ + 12;

      camera.position.set(focusX + 60, focusY + 50, focusZ + 40);
      camera.lookAt(focusX, focusY, focusZ);
    }
  }

  return boxMeshes;
}

/**
 * Renders a 3D Three.js warehouse matching the backend's vocabulary.
 * Keeps the pin and target box in the app's accent color.
 */
export function WarehouseLocator({ location, occupied, dark, documentId, onBoxClick }: WarehouseLocatorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const css2dRef = useRef<CSS2DRenderer | null>(null);
  const boxesRef = useRef<THREE.Mesh[]>([]);
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster());
  const pointerRef = useRef<THREE.Vector2>(new THREE.Vector2());
  const animationFrameRef = useRef<number | null>(null);

  const [instruction, setInstruction] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Derive target location validity
  // -------------------------------------------------------------------------
  const locZone = location?.zone ?? null;
  const locRack = location?.rack ?? null;
  const locShelf = location?.shelf ?? null;
  const locBox = location?.box ?? null;
  const targetZoneIdx = locZone ? zoneMap.get(locZone) ?? -1 : -1;
  const targetRackIdx = locRack ? rackMap.get(locRack) ?? -1 : -1;
  const targetShelfIdx = locShelf ? shelfMap.get(locShelf) ?? -1 : -1;
  const targetBoxIdx = locBox ? boxMap.get(locBox) ?? -1 : -1;

  const hasLocation = Boolean(locZone && locRack && locShelf && locBox);
  const outOfRange =
    !hasLocation ||
    targetZoneIdx < 0 ||
    targetRackIdx < 0 ||
    targetShelfIdx < 0 ||
    targetBoxIdx < 0;

  // Memoize the transformed slots so the rebuild effect doesn't churn.
  const compSlots = useMemo(() => occupied.map(toComponentSlot), [occupied]);

  // -------------------------------------------------------------------------
  // Three.js setup – runs once on mount
  // -------------------------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = dark ? new THREE.Color(0x0d0d0d) : new THREE.Color(0xfaf9f5);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      45,
      mount.clientWidth / mount.clientHeight,
      0.1,
      1000,
    );
    camera.position.set(80, 70, 90);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.3;
    controls.minPolarAngle = Math.PI / 6;
    controls.enableZoom = false;
    controls.enablePan = false;
    controlsRef.current = controls;

    const cssRenderer = new CSS2DRenderer();
    cssRenderer.setSize(mount.clientWidth, mount.clientHeight);
    cssRenderer.domElement.style.position = "absolute";
    cssRenderer.domElement.style.top = "0";
    mount.appendChild(cssRenderer.domElement);
    css2dRef.current = cssRenderer;

    const handleResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      cssRenderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    // Build warehouse geometry once
    boxesRef.current = buildWarehouse(
      scene,
      camera,
      compSlots,
      dark,
      hasLocation,
      locZone,
      locRack,
      locShelf,
      locBox,
      targetZoneIdx,
      targetRackIdx,
      targetShelfIdx,
      targetBoxIdx,
      documentId ?? null,
    );

    // Click handler: raycast to find the clicked box
    const handleClick = (ev: MouseEvent) => {
      const rect = mount.getBoundingClientRect();
      pointerRef.current.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointerRef.current.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(pointerRef.current, camera);
      const hits = raycasterRef.current.intersectObjects(boxesRef.current);
      if (hits.length > 0) {
        const ud = hits[0].object.userData as {
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
        };
        onBoxClick({
          zone: ud.zone,
          rack: ud.rack,
          shelf: ud.shelf,
          box: ud.box,
          occupants: ud.occupants,
        });
      }
    };
    mount.addEventListener("click", handleClick);

    // Animation loop
    let animId: number;
    function animate() {
      animId = requestAnimationFrame(animate);
      controls?.update();
      renderer.render(scene, camera);
      cssRenderer.render(scene, camera);
    }
    animId = requestAnimationFrame(animate);
    animationFrameRef.current = animId;

    // Instruction overlay when no location is assigned
    if (!hasLocation) {
      setInstruction(
        "This document has no assigned location. Assign a zone, rack, shelf and box to see it on the warehouse floor.",
      );
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      mount.removeEventListener("click", handleClick);
      cancelAnimationFrame(animId);
      if (rendererRef.current) rendererRef.current.dispose();
      if (mount && css2dRef.current?.domElement.parentElement === mount) {
        mount.removeChild(css2dRef.current.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // three.js setup runs once

  // -------------------------------------------------------------------------
  // Rebuild geometry whenever location or occupied data changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!sceneRef.current || !cameraRef.current) return;
    if (!hasLocation) return; // nothing to draw without a target location

    boxesRef.current = buildWarehouse(
      sceneRef.current,
      cameraRef.current,
      compSlots,
      dark,
      hasLocation,
      locZone,
      locRack,
      locShelf,
      locBox,
      targetZoneIdx,
      targetRackIdx,
      targetShelfIdx,
      targetBoxIdx,
      documentId ?? null,
    );

    // Out-of-range flag
    if (outOfRange) {
      setInstruction(
        `Location ${locZone}/${locRack}/${locShelf}/${locBox} is out of range for this warehouse.`,
      );
    }
  }, [hasLocation, locZone, locRack, locShelf, locBox, compSlots, outOfRange, dark, targetZoneIdx, targetRackIdx, targetShelfIdx, targetBoxIdx]);

  // -------------------------------------------------------------------------
  // Render: always the same mount node; empty state is an overlay.
  // -------------------------------------------------------------------------
  return (
    <div
      ref={mountRef}
      className="relative min-h-[320px] w-full overflow-hidden rounded-lg border border-border bg-surface"
      style={{ height: "400px" }}
    >
      {!hasLocation && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-muted/40 p-4 text-center">
          <Package className="h-8 w-8 opacity-70" />
          {instruction && (
            <p className="max-w-sm text-[12px] text-muted-foreground">{instruction}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Rendered Three.js scene. */
interface WarehouseLocatorProps {
  /** The document's location; if null/undefined the scene shows empty state. */
  location: { zone: string | null; rack: string | null; shelf: string | null; box: string | null } | null;
  /** The REAL list of occupied slots from the backend; memoized by the caller. Each slot has document_id. */
  occupied: AppWarehouseSlot[];
  /** Whether the app is in dark mode. */
  dark: boolean;
  /** The document whose position is being shown, if the page is about a specific document. */
  documentId?: string;
  /** Called when a user clicks a box — receives { zone, rack, shelf, box, occupants }. */
  onBoxClick: (payload: {
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
  }) => void;
}