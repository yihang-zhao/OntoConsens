import { useMemo, useRef, useState, useCallback, useEffect, type PointerEvent as ReactPointerEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
// Every class is capped at 9 distinct property names (a name proposed by
// several members still counts once) — this bounds the ring to at most 9
// evenly spaced slots, which is also why the node's footprint below can be a
// fixed, calculated size instead of depending on how many properties exist.
const MAX_PROPERTIES_PER_CLASS = 9;

/** Distance from the circle's center to the middle of any petal — every
 * petal sits at the same radius; agreement is shown via colored dots inside
 * the petal, not by stacking layers at different distances. */
const PETAL_CENTER_DIST = CIRCLE_RADIUS + GAP_TO_NODE + PETAL_LENGTH / 2;

/** Square footprint big enough to fit the full ring of petals (bounded by
 * MAX_PROPERTIES_PER_CLASS, which only affects label crowding, not radius)
 * plus label overhang margin, without clipping into neighboring nodes. */
function computeNodeSize(): number {
  const reach = CIRCLE_RADIUS + GAP_TO_NODE + PETAL_LENGTH;
  return Math.round((reach + 50) * 2);
}
const NODE_SIZE = computeNodeSize();

/** Center point of a petal placed at `angle` degrees (0 = straight up,
 * clockwise) and `dist` px from a circle centered at (originX, originY). */
function petalCenter(angle: number, originX: number, originY: number, dist: number = PETAL_CENTER_DIST) {
  const rad = (angle * Math.PI) / 180;
  return {
    x: originX + Math.sin(rad) * dist,
    y: originY - Math.cos(rad) * dist,
  };
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

interface ViewTransform {
  x: number;
  y: number;
  zoom: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distanceBetween(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function midpointOf(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }) {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

function layoutClasses(
  classes: OntologyClass[],
  relations: OntologyRelation[],
  nodeSize: number,
): LaidOutClass[] {
  const rowHeight = nodeSize + 50;
  const colGap = 60;
  const childToParent = new Map<number, number>();
  for (const rel of relations) {
    childToParent.set(rel.childId, rel.parentId);
  }

  const depthCache = new Map<number, number>();
  function depthOf(id: number, guard = 0): number {
    if (guard > classes.length) return 0;
    if (depthCache.has(id)) return depthCache.get(id)!;
    const parent = childToParent.get(id);
    const depth = parent === undefined ? 0 : depthOf(parent, guard + 1) + 1;
    depthCache.set(id, depth);
    return depth;
  }

  const byDepth = new Map<number, OntologyClass[]>();
  for (const cls of classes) {
    const depth = depthOf(cls.id);
    const list = byDepth.get(depth) ?? [];
    list.push(cls);
    byDepth.set(depth, list);
  }

  const laidOut: LaidOutClass[] = [];
  const depths = Array.from(byDepth.keys()).sort((a, b) => a - b);
  for (const depth of depths) {
    const row = byDepth.get(depth)!;
    row.forEach((cls, index) => {
      laidOut.push({
        ...cls,
        depth,
        x: index * (nodeSize + colGap),
        y: depth * rowHeight,
      });
    });
  }

  return laidOut;
}

export function GraphCanvas({
  projectId,
  currentUserId,
  cursors,
  sendCursor,
  sharedModeEnabled,
}: GraphCanvasProps) {
  const queryClient = useQueryClient();
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

  const zoomAt = useCallback((screenX: number, screenY: number, factor: number) => {
    setView((prev) => {
      const newZoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const ratio = newZoom / prev.zoom;
      return {
        x: screenX - (screenX - prev.x) * ratio,
        y: screenY - (screenY - prev.y) * ratio,
        zoom: newZoom,
      };
    });
  }, []);

  const panBy = useCallback((dx: number, dy: number) => {
    setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
  }, []);

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
  const height = Math.max(400, (laidOut.at(-1)?.y ?? 0) + nodeSize + 50 + 40);

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
            // Connect at the circle's edge, not the full petal footprint, so
            // arrows plug straight into the badges regardless of how many
            // petals surround them.
            const x1 = parent.x + 40 + nodeSize / 2;
            const y1 = parent.y + 40 + nodeSize / 2 + CIRCLE_RADIUS;
            const x2 = child.x + 40 + nodeSize / 2;
            const y2 = child.y + 40 + nodeSize / 2 - CIRCLE_RADIUS;
            const midY = (y1 + y2) / 2;
            return (
              <path
                key={i}
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                fill="none"
                stroke="hsl(var(--muted-foreground))"
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
          // proposal), so its length is exactly the "distinct properties"
          // count the 9-per-class cap applies to, live in both individual
          // and shared mode.
          const isFull = classProperties.length >= MAX_PROPERTIES_PER_CLASS;
          // The "add property" control is one more slot in the same radial
          // ring, always last, so the petals reflow evenly as properties are
          // added or removed instead of sitting in a separate row. Once the
          // cap is reached there's no slot left for it — the ring is fully
          // divided among the 9 properties instead.
          const slotCount = isFull ? classProperties.length : classProperties.length + 1;
          const angleStep = 360 / slotCount;
          // A fixed offset keeps petals from landing on the cardinal
          // directions (which, for even slot counts, would make them look
          // like plain horizontal/vertical bars instead of tilted petals).
          const angleOffset = 25;

          return (
            <div
              key={cls.id}
              className="absolute"
              style={{ left: cls.x + 40, top: cls.y + 40, width: nodeSize, height: nodeSize }}
            >
              {classProperties.map((property, i) => {
                const angle = angleStep * i - 90 + angleOffset;
                const center = petalCenter(angle, nodeSize / 2, nodeSize / 2);
                const hasMyAgreement = property.agreements.some((a) => a.userId === currentUserId);
                // Every petal has one fixed color "level" per project member
                // (2 levels for a 2-person project, 3 for a full one) — not
                // one level per agreement in arrival order. A level lights
                // up in that specific member's color once they've agreed,
                // and goes neutral again the moment they retract, so the
                // petal's shape and position never change, only its fill.
                const totalLevels = Math.max(1, project.members.length);
                const agreedSlots = new Set(property.agreements.map((a) => a.colorSlot));

                return (
                  <div
                    key={property.id}
                    className="absolute"
                    style={{
                      left: center.x - PETAL_WIDTH / 2,
                      top: center.y - PETAL_LENGTH / 2,
                      width: PETAL_WIDTH,
                      height: PETAL_LENGTH,
                      transform: `rotate(${angle}deg)`,
                      zIndex: 5 + i,
                    }}
                  >
                    <button
                      type="button"
                      title={
                        hasMyAgreement
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
                      className="relative flex h-full w-full flex-col-reverse overflow-hidden border shadow-sm outline-none transition-transform hover:z-30 hover:scale-105 focus:outline-none focus-visible:outline-none"
                      style={{
                        borderColor: "hsl(var(--border))",
                        borderRadius: "16px 16px 4px 4px",
                        borderWidth: 1.5,
                        WebkitTapHighlightColor: "transparent",
                      }}
                    >
                      {/* Base (near the node) to tip: one band per project
                          member's fixed color slot. */}
                      {Array.from({ length: totalLevels }, (_, slot) => slot).map((slot) => (
                        <div
                          key={slot}
                          className="min-h-0 flex-1"
                          style={{
                            background: agreedSlots.has(slot)
                              ? colorForSlot(slot).solid
                              : "hsl(var(--muted) / 0.35)",
                          }}
                        />
                      ))}

                      <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                        <div style={{ transform: `rotate(${-angle}deg)` }}>
                          <span className="line-clamp-2 rounded-md bg-background/85 px-1.5 py-0.5 text-center text-[10px] font-medium leading-tight text-foreground shadow-sm">
                            {property.name}
                          </span>
                        </div>
                      </div>
                    </button>
                  </div>
                );
              })}

              {/* Add-property slot: one more petal in the same ring, dashed
                  and neutral until clicked — omitted once the class has hit
                  the 9-property cap, since every slot is already a real
                  property at that point. */}
              {!isFull && (() => {
                const angle = angleStep * classProperties.length - 90 + angleOffset;
                const center = petalCenter(angle, nodeSize / 2, nodeSize / 2);
                return (
                  <div
                    className="absolute"
                    style={{
                      left: center.x - PETAL_WIDTH / 2,
                      top: center.y - PETAL_LENGTH / 2,
                      width: PETAL_WIDTH,
                      height: PETAL_LENGTH,
                      transform: `rotate(${angle}deg)`,
                      zIndex: 5 + classProperties.length,
                    }}
                  >
                    {isAdding ? (
                      <div className="absolute left-1/2 top-3 -translate-x-1/2">
                       <div style={{ transform: `rotate(${-angle}deg)` }}>
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (draftName.trim()) {
                              createProperty.mutate(
                                { id: projectId, data: { classId: cls.id, name: draftName.trim() } },
                                { onSuccess: invalidateProperties },
                              );
                            }
                            setAddingToClass(null);
                            setDraftName("");
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
                        className="flex h-full w-full items-center justify-center border border-dashed border-emerald-500/50 text-emerald-600 transition-colors hover:border-emerald-500 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
                        style={{ borderRadius: "16px 16px 4px 4px" }}
                      >
                        <span
                          className="text-base font-semibold leading-none"
                          style={{ transform: `rotate(${-angle}deg)`, display: "inline-block" }}
                        >
                          +
                        </span>
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* The class badge sits on top, hiding the inner (pivot) end
                  of every petal so they read as radiating from its edge. */}
              <div
                className="absolute flex items-center justify-center rounded-full border-4 bg-card text-center shadow-md"
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
                <span className="line-clamp-3 px-3 text-sm font-semibold text-card-foreground">
                  {cls.label}
                </span>
                {/* Real-time count toward the 9-property cap — recalculated
                    every render from the same (already mode-scoped) property
                    list used to lay out the ring, so it reflects individual
                    or shared mode automatically and updates the instant
                    someone adds or retracts a property. */}
                <span
                  className="absolute -bottom-2 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold leading-none shadow-sm"
                  style={
                    isFull
                      ? { background: "hsl(var(--destructive) / 0.12)", borderColor: "hsl(var(--destructive))", color: "hsl(var(--destructive))" }
                      : { background: "hsl(var(--card))", borderColor: "hsl(var(--muted-foreground) / 0.4)", color: "hsl(var(--muted-foreground))" }
                  }
                  title={isFull ? "This class has reached the 9-property limit" : `${classProperties.length} of ${MAX_PROPERTIES_PER_CLASS} properties`}
                >
                  {classProperties.length}/{MAX_PROPERTIES_PER_CLASS}
                </span>
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
