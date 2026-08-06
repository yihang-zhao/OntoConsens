import { useMemo, useRef, useState, useCallback, useEffect, type PointerEvent as ReactPointerEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  useGetProject,
  getGetProjectQueryKey,
  useListProperties,
  getListPropertiesQueryKey,
  useCreateProperty,
  useRetractProperty,
  useAgreeProperty,
} from "@workspace/api-client-react";
import type { OntologyClass, OntologyRelation, Property } from "@workspace/api-client-react";
import { colorForSlot } from "@/lib/memberColors";
import type { RemoteCursor } from "@/hooks/useProjectSocket";
import { useToast } from "@/hooks/use-toast";

interface GraphCanvasProps {
  projectId: number;
  currentUserId: number;
  cursors: Map<number, RemoteCursor>;
  sendCursor: (x: number, y: number) => void;
  /** True once every project member has marked ready — the merged consensus
   * space (shared properties + live cursors) only appears then. */
  sharedModeEnabled: boolean;
}

interface LaidOutClass extends OntologyClass {
  depth: number;
  x: number;
  y: number;
}

// Each class renders as a circular badge (class label) surrounded by a ring
// of tilted, petal-like tabs — one per property — radiating outward, similar
// to flower petals / gear teeth. Every petal's *center point* is placed by
// trigonometry at a fixed distance from the badge's center, then the petal
// is rotated in place (plain `rotate()`, default center origin) to face
// outward — this is deliberate: combining `translate()` and `rotate()` in a
// single transform with a custom transform-origin does NOT pivot around the
// translated position (the origin applies to the whole composed matrix, not
// sequentially), so that approach silently flings rotated petals away from
// the circle instead of anchoring them to it. Positioning by trig first and
// rotating in place afterward sidesteps that trap entirely.
const CIRCLE_SIZE = 128;
const CIRCLE_RADIUS = CIRCLE_SIZE / 2;
const PETAL_WIDTH = 56;
const PETAL_LENGTH = 64;
// Clear space between the circle's edge and the nearest petal — the shape
// must never touch the badge.
const GAP_TO_NODE = 14;

/** Distance from the circle's center to the middle of a floating (not yet
 * fully agreed) petal. */
const PETAL_CENTER_DIST = CIRCLE_RADIUS + GAP_TO_NODE + PETAL_LENGTH / 2;
/** Outer edge of the whole petal ring — used to anchor connecting lines and
 * property-name labels outside the ring instead of guessing a fixed offset. */
const RING_OUTER_RADIUS = CIRCLE_RADIUS + GAP_TO_NODE + PETAL_LENGTH;
const LABEL_DIST = RING_OUTER_RADIUS + 14;

// Once every project member has agreed on a property, its petal "docks"
// directly onto the node: it shrinks into a small upright chip that overlaps
// the circle's edge instead of floating, tilted, out in the ring — a clear,
// immediate visual contrast between settled and still-pending properties.
const DOCK_DIST = CIRCLE_RADIUS - 5;
const DOCK_WIDTH = 46;
const DOCK_HEIGHT = 22;

// How far past the label ring a connecting line must stop so it clears the
// property-name badges instead of running underneath them. Comfortably
// beyond LABEL_DIST (which already sits at the petal ring's outer edge) to
// leave a clear visual gap before the line reaches either node.
const LINE_CLEARANCE = LABEL_DIST + 40;

// Mirrors the backend's per-class property limit purely so the "add
// property" control can hide itself once a node is full — this is the one
// place the frontend is allowed to know about the cap; every other rule
// (rejecting a 10th property, the actual count check) still lives
// server-side only.
const MAX_PROPERTIES_PER_CLASS = 9;

/** Square footprint big enough to fit the full ring of petals plus label
 * overhang, without clipping into neighboring nodes. */
function computeNodeSize(): number {
  return Math.round((LABEL_DIST + 60) * 2);
}
const NODE_SIZE = computeNodeSize();

/** Center point of a petal placed at `angle` degrees (0 = straight up,
 * clockwise) and `dist` px from a circle centered at (originX, originY). */
function petalCenter(angle: number, originX: number, originY: number, dist: number) {
  const rad = (angle * Math.PI) / 180;
  return {
    x: originX + Math.sin(rad) * dist,
    y: originY - Math.cos(rad) * dist,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// A label rotated to exactly match its petal's outward angle would read
// upside-down on the lower half of the circle (and sideways near the left
// and right) — this folds any angle into a range that always reads
// left-to-right while still tilting to hint at the petal's direction. This
// only ever affects the TEXT's own tilt, never where its box is anchored —
// the anchor point is computed elsewhere from the raw (unfolded) angle, and
// the three-layer position/recenter/rotate split keeps that anchor fixed no
// matter what this function returns.
function labelRotation(petalAngle: number): number {
  let a = ((petalAngle % 360) + 360) % 360; // 0..360
  if (a > 180) a -= 360; // -180..180
  if (a > 90) a -= 180;
  else if (a < -90) a += 180;
  return clamp(a, -55, 55);
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

interface ViewTransform {
  x: number;
  y: number;
  zoom: number;
}

function distanceBetween(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function midpointOf(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }) {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

// Left-to-right pyramid layout: depth (generation) maps to the horizontal
// axis instead of the vertical one, so the hierarchy narrows toward the root
// on the left and fans out toward its leaves on the right. This is an
// adaptive tidy-tree placement, not a fixed grid — each node's vertical slot
// is derived from how many leaves its subtree contains, so it resolves into
// a clean pyramid for any mix of branching and depth, not just one
// pre-tuned case.
function layoutClasses(
  classes: OntologyClass[],
  relations: OntologyRelation[],
  nodeSize: number,
): LaidOutClass[] {
  const rowHeight = nodeSize + 50;
  const colGap = 160;
  const idSet = new Set(classes.map((c) => c.id));
  const parentOf = new Map<number, number>();
  const childrenOf = new Map<number, number[]>();
  for (const rel of relations) {
    if (!idSet.has(rel.childId) || !idSet.has(rel.parentId)) continue;
    parentOf.set(rel.childId, rel.parentId);
    const list = childrenOf.get(rel.parentId) ?? [];
    list.push(rel.childId);
    childrenOf.set(rel.parentId, list);
  }

  const positions = new Map<number, { x: number; y: number; depth: number }>();
  const visited = new Set<number>();
  let leafCursor = 0;

  // Returns the vertical slot (in leaf units) this node's subtree is
  // centered on, so a parent with several children centers over their span.
  function place(id: number, depth: number): number {
    if (visited.has(id)) return leafCursor;
    visited.add(id);
    const kids = (childrenOf.get(id) ?? []).filter((k) => !visited.has(k));
    let slot: number;
    if (kids.length === 0) {
      slot = leafCursor;
      leafCursor += 1;
    } else {
      const childSlots = kids.map((k) => place(k, depth + 1));
      slot = (Math.min(...childSlots) + Math.max(...childSlots)) / 2;
    }
    positions.set(id, { x: depth * (nodeSize + colGap), y: slot * rowHeight, depth });
    return slot;
  }

  const roots = classes.filter((c) => !parentOf.has(c.id));
  for (const root of roots) place(root.id, 0);
  // Anything unreachable (orphaned by a cycle, defensively) still needs a
  // slot so it isn't silently dropped from the canvas.
  for (const cls of classes) {
    if (!positions.has(cls.id)) {
      positions.set(cls.id, { x: 0, y: leafCursor * rowHeight, depth: 0 });
      leafCursor += 1;
    }
  }

  return classes.map((cls) => ({ ...cls, ...positions.get(cls.id)! }));
}

export function GraphCanvas({
  projectId,
  currentUserId,
  cursors,
  sendCursor,
  sharedModeEnabled,
}: GraphCanvasProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  const [addingToClass, setAddingToClass] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");

  // The board never uses native scrolling — panning and zooming are handled
  // entirely by this transform, driven by explicit gestures (right-click
  // drag, trackpad two-finger slide, touch drag, wheel/pinch to zoom) so the
  // page itself never scrolls or bounces.
  const [view, setView] = useState<ViewTransform>({ x: 40, y: 20, zoom: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;

  const panDragRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const touchPanRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);

  // Every pan/zoom gesture funnels through zoomAt/panBy, so marking
  // "interacting" there (rather than in each individual gesture handler)
  // covers wheel, drag, touch-drag, and pinch alike. While this is true,
  // every motion element below renders with a zero-duration transition
  // instead of its normal spring/ease — the shapes, labels, and fill bands
  // must track the view transform rigidly, with no catch-up animation, and
  // only resume animating once a real state change happens after the user
  // stops touching the canvas.
  const [isViewInteracting, setIsViewInteracting] = useState(false);
  const interactionEndTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const markViewInteracting = useCallback(() => {
    setIsViewInteracting(true);
    if (interactionEndTimer.current) clearTimeout(interactionEndTimer.current);
    interactionEndTimer.current = setTimeout(() => setIsViewInteracting(false), 120);
  }, []);

  useEffect(() => {
    return () => {
      if (interactionEndTimer.current) clearTimeout(interactionEndTimer.current);
    };
  }, []);

  const zoomAt = useCallback((screenX: number, screenY: number, factor: number) => {
    markViewInteracting();
    setView((prev) => {
      const newZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const ratio = newZoom / prev.zoom;
      return {
        x: screenX - (screenX - prev.x) * ratio,
        y: screenY - (screenY - prev.y) * ratio,
        zoom: newZoom,
      };
    });
  }, [markViewInteracting]);

  const panBy = useCallback((dx: number, dy: number) => {
    markViewInteracting();
    setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
  }, [markViewInteracting]);

  const stateTransition = { type: "spring", stiffness: 260, damping: 28 } as const;
  const activeTransition = isViewInteracting ? { duration: 0 } : stateTransition;
  const fillTransition = { duration: isViewInteracting ? 0 : 0.25 };

  // Same safety-net polling as the project page: the socket push should make
  // this a no-op in practice, but it guarantees eventual consistency if a
  // broadcast is ever missed.
  const { data: project } = useGetProject(projectId, {
    query: { queryKey: getGetProjectQueryKey(projectId), refetchInterval: 10_000 },
  });
  const { data: properties } = useListProperties(projectId, {
    query: { queryKey: getListPropertiesQueryKey(projectId), refetchInterval: 10_000 },
  });

  const createProperty = useCreateProperty();
  const retractProperty = useRetractProperty();
  const agreeProperty = useAgreeProperty();

  const invalidateProperties = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListPropertiesQueryKey(projectId) });
  }, [queryClient, projectId]);

  const membersById = useMemo(() => {
    const map = new Map<number, { username: string; colorSlot: number }>();
    for (const m of project?.members ?? []) {
      map.set(m.userId, { username: m.username, colorSlot: m.colorSlot });
    }
    return map;
  }, [project]);

  const nodeSize = NODE_SIZE;

  const laidOut = useMemo(
    () => layoutClasses(project?.classes ?? [], project?.relations ?? [], nodeSize),
    [project, nodeSize],
  );

  const propertiesByClass = useMemo(() => {
    const map = new Map<number, Property[]>();
    for (const property of properties ?? []) {
      const list = map.get(property.classId) ?? [];
      list.push(property);
      map.set(property.classId, list);
    }
    return map;
  }, [properties]);

  // Cursor coordinates are sent in content-local space (i.e. as if zoom=1,
  // pan=0) so every viewer renders them correctly regardless of their own
  // individual pan/zoom state.
  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!sharedModeEnabled) return;
      if (panDragRef.current) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const { x, y, zoom } = viewRef.current;
      const contentX = (event.clientX - rect.left - x) / zoom;
      const contentY = (event.clientY - rect.top - y) / zoom;
      sendCursor(contentX, contentY);
    },
    [sendCursor, sharedModeEnabled],
  );

  // Mouse wheel: notches (an actual scroll wheel) zoom; ctrl/cmd+wheel
  // (trackpad pinch, which browsers synthesize as ctrl+wheel) also zooms.
  // A plain wheel event carrying a horizontal component, or with the small
  // continuous deltas trackpads produce for a two-finger slide, pans instead
  // — there's no perfect way to tell a mouse wheel from a trackpad scroll at
  // the DOM event level, so this mirrors the heuristic other canvas apps use.
  //
  // This is attached as a native (not React synthetic) listener with
  // { passive: false } below — React/the browser treats delegated
  // wheel/touch listeners as passive by default for scroll-performance
  // reasons, which silently makes event.preventDefault() a no-op. Without
  // that, the page behind the canvas (and, on trackpads, the browser's own
  // pinch-zoom/back-forward swipe gesture) would move along with — or
  // instead of — the canvas whenever the pointer is over it.
  const handleWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;

      if (event.ctrlKey || event.metaKey) {
        zoomAt(screenX, screenY, Math.exp(-event.deltaY * 0.01));
        return;
      }
      const looksLikeTrackpad = event.deltaX !== 0 || !Number.isInteger(event.deltaY) || Math.abs(event.deltaY) < 40;
      if (looksLikeTrackpad) {
        panBy(-event.deltaX, -event.deltaY);
      } else {
        zoomAt(screenX, screenY, Math.exp(-event.deltaY * 0.002));
      }
    },
    [panBy, zoomAt],
  );

  // Right mouse button drag pans the board; left button is reserved for
  // interacting with classes/properties, so panning never fights with them.
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 2) return;
    event.preventDefault();
    panDragRef.current = { lastX: event.clientX, lastY: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = panDragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      panDragRef.current = { lastX: event.clientX, lastY: event.clientY };
      panBy(dx, dy);
    },
    [panBy],
  );

  const stopPointerPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (panDragRef.current) {
      panDragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }, []);

  // Touch: a single finger drags to pan; two fingers pinch to zoom (anchored
  // at the midpoint between them) — no native touch scrolling, page bounce,
  // or browser pinch-zoom is involved. Native listener, same passive-default
  // reasoning as the wheel handler above.
  const handleTouchStart = useCallback((event: TouchEvent) => {
    if (event.touches.length === 1) {
      touchPanRef.current = { lastX: event.touches[0]!.clientX, lastY: event.touches[0]!.clientY };
      pinchRef.current = null;
    } else if (event.touches.length === 2) {
      touchPanRef.current = null;
      pinchRef.current = { distance: distanceBetween(event.touches[0]!, event.touches[1]!), zoom: viewRef.current.zoom };
    }
  }, []);

  const handleTouchMove = useCallback(
    (event: TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.touches.length === 1 && touchPanRef.current) {
        const touch = event.touches[0]!;
        const dx = touch.clientX - touchPanRef.current.lastX;
        const dy = touch.clientY - touchPanRef.current.lastY;
        touchPanRef.current = { lastX: touch.clientX, lastY: touch.clientY };
        panBy(dx, dy);
      } else if (event.touches.length === 2 && pinchRef.current) {
        const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
        const distance = distanceBetween(event.touches[0]!, event.touches[1]!);
        const mid = midpointOf(event.touches[0]!, event.touches[1]!);
        const factor = (distance / pinchRef.current.distance) * (pinchRef.current.zoom / viewRef.current.zoom);
        zoomAt(mid.x - rect.left, mid.y - rect.top, factor);
      }
    },
    [panBy, zoomAt],
  );

  const handleTouchEnd = useCallback((event: TouchEvent) => {
    if (event.touches.length === 0) {
      touchPanRef.current = null;
      pinchRef.current = null;
    } else if (event.touches.length === 1) {
      pinchRef.current = null;
      touchPanRef.current = { lastX: event.touches[0]!.clientX, lastY: event.touches[0]!.clientY };
    }
  }, []);

  useEffect(() => {
    setAddingToClass(null);
    setDraftName("");
  }, [projectId]);

  // React (and browsers generally) treat delegated wheel/touchstart/
  // touchmove listeners as passive by default for scroll-performance
  // reasons — calling event.preventDefault() inside a React onWheel/
  // onTouchMove prop silently does nothing under that default. Attaching
  // these natively with { passive: false } is the only reliable way to stop
  // a gesture over the canvas from also scrolling/zooming the page behind
  // it or triggering the browser's own pinch-zoom / swipe-navigation.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    node.addEventListener("wheel", handleWheel, { passive: false });
    node.addEventListener("touchstart", handleTouchStart, { passive: false });
    node.addEventListener("touchmove", handleTouchMove, { passive: false });
    node.addEventListener("touchend", handleTouchEnd, { passive: false });
    node.addEventListener("touchcancel", handleTouchEnd, { passive: false });
    return () => {
      node.removeEventListener("wheel", handleWheel);
      node.removeEventListener("touchstart", handleTouchStart);
      node.removeEventListener("touchmove", handleTouchMove);
      node.removeEventListener("touchend", handleTouchEnd);
      node.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd]);

  if (!project) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
        Loading graph…
      </div>
    );
  }

  const width = Math.max(
    800,
    (Math.max(1, ...laidOut.map((c) => c.x + nodeSize)) || nodeSize) + 80,
  );
  const height = Math.max(400, (Math.max(0, ...laidOut.map((c) => c.y)) || 0) + nodeSize + 80);

  const relations = project.relations;
  const positionById = new Map(laidOut.map((c) => [c.id, c]));

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopPointerPan}
      onPointerLeave={stopPointerPan}
      onPointerCancel={stopPointerPan}
      onContextMenu={(e) => e.preventDefault()}
      // touchAction: "none" + overscrollBehavior: "contain" belt-and-braces
      // the native non-passive listeners above — even if a gesture ever
      // slipped past preventDefault, the browser has nothing left to hand
      // it off to (no native scroll/zoom action, no rubber-band handoff to
      // an ancestor scroller), so the page never moves.
      style={{ touchAction: "none", overscrollBehavior: "contain" }}
      className="relative h-full w-full overflow-hidden bg-[radial-gradient(circle_at_1px_1px,theme(colors.border)_1px,transparent_0)] [background-size:24px_24px]"
    >
      <div
        className="absolute left-0 top-0"
        style={{
          width,
          height,
          padding: "40px",
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          transformOrigin: "0 0",
        }}
      >
        <svg
          className="pointer-events-none absolute left-0 top-0"
          width={width}
          height={height}
        >
          <defs>
            <marker
              id="arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" fill="hsl(var(--muted-foreground))" />
            </marker>
          </defs>
          {relations.map((rel, i) => {
            const child = positionById.get(rel.childId);
            const parent = positionById.get(rel.parentId);
            if (!child || !parent) return null;
            // Straight lines drawn along the true center-to-center axis
            // between the two nodes (not a fixed horizontal offset), then
            // pulled back from each end by LINE_CLEARANCE along that same
            // direction — this generalizes correctly even when a parent and
            // child aren't at the same vertical slot (e.g. a parent
            // centered over several children), stopping just past each
            // node's label ring instead of cutting through the badge or
            // running underneath a property label.
            const centerA = { x: parent.x + 40 + nodeSize / 2, y: parent.y + 40 + nodeSize / 2 };
            const centerB = { x: child.x + 40 + nodeSize / 2, y: child.y + 40 + nodeSize / 2 };
            const dx = centerB.x - centerA.x;
            const dy = centerB.y - centerA.y;
            const dist = Math.hypot(dx, dy) || 1;
            const ux = dx / dist;
            const uy = dy / dist;
            const x1 = centerA.x + ux * LINE_CLEARANCE;
            const y1 = centerA.y + uy * LINE_CLEARANCE;
            const x2 = centerB.x - ux * LINE_CLEARANCE;
            const y2 = centerB.y - uy * LINE_CLEARANCE;
            return (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="hsl(var(--muted-foreground) / 0.7)"
                strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />
            );
          })}
        </svg>

        {laidOut.map((cls) => {
          const classProperties = propertiesByClass.get(cls.id) ?? [];
          const isAdding = addingToClass === cls.id;
          // Same name proposed by different members still counts once — the
          // list here is already deduplicated by name (server merges on
          // proposal). The actual 9-per-class limit is still enforced only
          // by the backend (a rejected 10th property surfaces as a plain
          // error toast) — `atCap` here exists purely to hide the "add"
          // affordance once a node is full, in both private and shared
          // mode, not to pre-empt or duplicate the backend's own check.
          const atCap = classProperties.length >= MAX_PROPERTIES_PER_CLASS;
          const slotCount = classProperties.length + (atCap ? 0 : 1);
          const angleStep = 360 / slotCount;
          // A fixed offset keeps petals from landing on the cardinal
          // directions (which, for even slot counts, would make them look
          // like plain horizontal/vertical bars instead of tilted petals).
          const angleOffset = 25;

          const agreedCount = classProperties.filter((p) => p.agreedByAll).length;
          const consensusFraction = classProperties.length > 0 ? agreedCount / classProperties.length : 0;

          return (
            <div
              key={cls.id}
              className="absolute"
              style={{ left: cls.x + 40, top: cls.y + 40, width: nodeSize, height: nodeSize }}
            >
              {classProperties.map((property, i) => {
                const angle = angleStep * i - 90 + angleOffset;
                const docked = property.agreedByAll;
                const dist = docked ? DOCK_DIST : PETAL_CENTER_DIST;
                const center = petalCenter(angle, nodeSize / 2, nodeSize / 2, dist);
                const w = docked ? DOCK_WIDTH : PETAL_WIDTH;
                const h = docked ? DOCK_HEIGHT : PETAL_LENGTH;
                const rotate = docked ? 0 : angle;
                const hasMyAgreement = property.agreements.some((a) => a.userId === currentUserId);
                // Fills stack from the petal's base (nearest the node) up to
                // its tip, in the order members agreed — a new agreement
                // always appends at the top of the stack, and if one in the
                // middle is retracted, the ones above it settle downward to
                // close the gap. Since the backend already returns
                // `agreements` oldest-first, indexing straight into that
                // array (rather than a fixed per-member slot) gives exactly
                // that "gravity" behavior for free.
                const totalLevels = Math.max(1, project.members.length);
                const emptyLevels = Math.max(0, totalLevels - property.agreements.length);
                // The box's anchor is strictly centrifugal — computed below
                // from the raw `angle`, never from this. Only the text's
                // own tilt inside that box adapts for legibility.
                const labelAngle = labelRotation(angle);
                const labelCenter = petalCenter(angle, nodeSize / 2, nodeSize / 2, LABEL_DIST);

                return (
                  <div key={property.id}>
                  <motion.div
                    initial={false}
                    animate={{ left: center.x - w / 2, top: center.y - h / 2, width: w, height: h, rotate }}
                    transition={activeTransition}
                    className="absolute"
                    style={{ zIndex: docked ? 25 : 5 + i }}
                  >
                    <button
                      type="button"
                      title={
                        docked
                          ? `${property.name} — fully agreed`
                          : hasMyAgreement
                            ? "Click to remove your agreement"
                            : "Click to agree"
                      }
                      onClick={() => {
                        if (hasMyAgreement) {
                          retractProperty.mutate(
                            { id: projectId, propertyId: property.id },
                            { onSuccess: invalidateProperties },
                          );
                        } else {
                          agreeProperty.mutate(
                            { id: projectId, propertyId: property.id },
                            { onSuccess: invalidateProperties },
                          );
                        }
                      }}
                      // outline-none/tap-highlight: a click must only ever
                      // change which levels are filled — it must never leave
                      // a black default browser focus/active outline on the
                      // petal frame.
                      className="relative flex h-full w-full flex-col-reverse overflow-hidden border shadow-sm outline-none transition-[background-color,border-color,border-radius,box-shadow] duration-300 hover:z-30 hover:scale-105 focus:outline-none focus-visible:outline-none"
                      style={
                        docked
                          ? {
                              background: "hsl(var(--primary))",
                              borderColor: "hsl(var(--primary))",
                              borderRadius: "999px",
                              borderWidth: 1.5,
                              WebkitTapHighlightColor: "transparent",
                            }
                          : {
                              borderColor: "hsl(var(--border))",
                              borderRadius: "16px 16px 4px 4px",
                              borderWidth: 1.5,
                              WebkitTapHighlightColor: "transparent",
                            }
                      }
                    >
                      {docked ? (
                        <span className="pointer-events-none m-auto line-clamp-1 px-1.5 text-center text-[9px] font-semibold leading-none text-primary-foreground">
                          {property.name}
                        </span>
                      ) : (
                        <AnimatePresence initial={false}>
                          {property.agreements.map((a) => (
                            <motion.div
                              key={a.userId}
                              // Layout tracking (and its animation) is only
                              // ever needed for a real gravity-fill reorder;
                              // suspending it while the view is being
                              // panned/zoomed stops the ancestor's CSS scale
                              // from being misread as a position change that
                              // needs to animate.
                              layout={!isViewInteracting}
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={fillTransition}
                              className="min-h-0 flex-1"
                              style={{ background: colorForSlot(a.colorSlot).solid }}
                            />
                          ))}
                        </AnimatePresence>
                      )}
                      {!docked &&
                        Array.from({ length: emptyLevels }, (_, idx) => (
                          <div
                            key={`empty-${idx}`}
                            className="min-h-0 flex-1"
                            style={{ background: "hsl(var(--muted) / 0.35)" }}
                          />
                        ))}
                    </button>
                  </motion.div>

                  {/* Rendered as a sibling of the (rotated) petal, not a
                      child of it — nesting it inside would compose the
                      label's own rotation with the petal's, which is the
                      translate+rotate trap: the label needs its own
                      independent position and tilt in the same world-space
                      coordinate frame the petal itself is placed in. */}
                  {!docked && (
                    // Three levels, each doing exactly one job, so rotating
                    // the text can never drag the anchor point off the
                    // outward radial ray:
                    //  1. outer motion.div — pure position, no rotation,
                    //     tracks `labelCenter` (computed from the *raw*
                    //     petal `angle`, never `labelAngle`) — this is the
                    //     centrifugal anchor and it never moves for any
                    //     reason other than the petal's own angle changing.
                    //  2. middle div — a static translate(-50%,-50%) with no
                    //     animation, purely to recenter the box on that
                    //     anchor point.
                    //  3. inner motion.div — rotates the visible text around
                    //     its own (already-centered) center. Rotating a box
                    //     around its own center cannot move that center, so
                    //     no amount of clamping/flipping the legibility
                    //     rotation can ever shift the anchor.
                    <motion.div
                      initial={false}
                      animate={{ left: labelCenter.x, top: labelCenter.y }}
                      transition={activeTransition}
                      className="pointer-events-none absolute"
                      style={{ zIndex: 30 }}
                    >
                      <div style={{ transform: "translate(-50%, -50%)" }}>
                        <motion.div
                          initial={false}
                          animate={{ rotate: labelAngle }}
                          transition={activeTransition}
                        >
                          <span className="line-clamp-2 rounded-md bg-background/90 px-1.5 py-0.5 text-center text-[10px] font-medium leading-tight text-foreground shadow-sm">
                            {property.name}
                          </span>
                        </motion.div>
                      </div>
                    </motion.div>
                  )}
                  </div>
                );
              })}

              {/* Add-property slot: one more petal in the same ring, dashed
                  and neutral until clicked — hidden entirely once the node
                  is at its 9-property cap, in both private and shared mode.
                  The backend still owns the actual limit check; this is
                  just the affordance disappearing so there's nothing to
                  click that could only ever fail. */}
              {!atCap && (() => {
                const angle = angleStep * classProperties.length - 90 + angleOffset;
                const center = petalCenter(angle, nodeSize / 2, nodeSize / 2, PETAL_CENTER_DIST);
                return (
                  <motion.div
                    initial={false}
                    animate={{
                      left: center.x - PETAL_WIDTH / 2,
                      top: center.y - PETAL_LENGTH / 2,
                      width: PETAL_WIDTH,
                      height: PETAL_LENGTH,
                      rotate: angle,
                    }}
                    transition={activeTransition}
                    className="absolute"
                    style={{ zIndex: 5 + classProperties.length }}
                  >
                    {isAdding ? (
                      <div className="absolute left-1/2 top-3 -translate-x-1/2">
                       <div style={{ transform: `rotate(${-angle}deg)` }}>
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const name = draftName.trim();
                            setAddingToClass(null);
                            setDraftName("");
                            if (name) {
                              createProperty.mutate(
                                { id: projectId, data: { classId: cls.id, name } },
                                {
                                  onSuccess: invalidateProperties,
                                  onError: (err: any) => {
                                    toast({
                                      title: "Couldn't add property",
                                      description: err?.error ?? "Something went wrong.",
                                      variant: "destructive",
                                    });
                                  },
                                },
                              );
                            }
                          }}
                        >
                          <input
                            autoFocus
                            value={draftName}
                            placeholder="Property name"
                            onChange={(e) => setDraftName(e.target.value)}
                            onBlur={(e) => {
                              // Same rationale as the edit form: clicking
                              // away must commit a non-empty draft rather
                              // than silently drop it. The submit handler
                              // itself no-ops on empty input and still
                              // closes the form.
                              e.currentTarget.form?.requestSubmit();
                            }}
                            className="h-7 w-24 rounded-full border border-primary bg-background px-2.5 text-center text-[11px] outline-none shadow-md"
                          />
                        </form>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setAddingToClass(cls.id);
                          setDraftName("");
                        }}
                        className="flex h-full w-full items-center justify-center border border-dashed transition-colors hover:bg-muted/60"
                        style={{
                          borderRadius: "16px 16px 4px 4px",
                          borderColor: "hsl(var(--muted-foreground) / 0.5)",
                          color: "hsl(var(--muted-foreground))",
                        }}
                      >
                        <span
                          className="text-base font-semibold leading-none"
                          style={{ transform: `rotate(${-angle}deg)`, display: "inline-block" }}
                        >
                          +
                        </span>
                      </button>
                    )}
                  </motion.div>
                );
              })()}

              {/* The class badge sits on top, hiding the inner (pivot) end
                  of every petal so they read as radiating from its edge. */}
              <div
                className="absolute overflow-hidden rounded-full border-4 bg-card text-center shadow-md"
                style={{
                  width: CIRCLE_SIZE,
                  height: CIRCLE_SIZE,
                  left: "50%",
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                  borderColor: "hsl(var(--muted-foreground) / 0.5)",
                  zIndex: 20,
                }}
              >
                {/* Consensus gauge: a bottom-anchored fill that grows with
                    the share of this class's properties that have reached
                    full agreement, animating smoothly as that changes. */}
                <motion.div
                  className="pointer-events-none absolute inset-x-0 bottom-0"
                  style={{ background: "hsl(var(--primary) / 0.16)" }}
                  animate={{ height: `${consensusFraction * 100}%` }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="line-clamp-3 px-3 text-sm font-semibold text-card-foreground">
                    {cls.label}
                  </span>
                </div>
              </div>
            </div>
          );
        })}

        {sharedModeEnabled &&
          Array.from(cursors.values())
            .filter((c) => Date.now() - c.updatedAt < 8000 && c.userId !== currentUserId)
            .map((cursor) => {
              const member = membersById.get(cursor.userId);
              const color = colorForSlot(member?.colorSlot ?? 0);
              return (
                <div
                  key={cursor.userId}
                  className="pointer-events-none absolute z-50 transition-all duration-150 ease-out"
                  style={{ left: cursor.x, top: cursor.y }}
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <path
                      d="M1 1L7 16L9.5 9.5L16 7L1 1Z"
                      fill={color.solid}
                      stroke="white"
                      strokeWidth="1"
                    />
                  </svg>
                  <span
                    className="ml-3 -mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium text-white shadow"
                    style={{ background: color.solid }}
                  >
                    {member?.username ?? "member"}
                  </span>
                </div>
              );
            })}
      </div>
    </div>
  );
}
