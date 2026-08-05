import { useMemo, useRef, useState, useCallback, useEffect, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetProject,
  getGetProjectQueryKey,
  useListProperties,
  getListPropertiesQueryKey,
  useCreateProperty,
  useUpdateProperty,
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

const NODE_WIDTH = 220;
const NODE_HEIGHT = 64;
const ROW_HEIGHT = 220;
const COL_GAP = 40;

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
): LaidOutClass[] {
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
        x: index * (NODE_WIDTH + COL_GAP),
        y: depth * ROW_HEIGHT,
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
  const [editingProperty, setEditingProperty] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

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
  const updateProperty = useUpdateProperty();
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

  const laidOut = useMemo(
    () => layoutClasses(project?.classes ?? [], project?.relations ?? []),
    [project],
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
  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
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
  // at the midpoint between them) — no native touch scrolling is involved.
  const handleTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 1) {
      touchPanRef.current = { lastX: event.touches[0].clientX, lastY: event.touches[0].clientY };
      pinchRef.current = null;
    } else if (event.touches.length === 2) {
      touchPanRef.current = null;
      pinchRef.current = { distance: distanceBetween(event.touches[0], event.touches[1]), zoom: viewRef.current.zoom };
    }
  }, []);

  const handleTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (event.touches.length === 1 && touchPanRef.current) {
        const touch = event.touches[0];
        const dx = touch.clientX - touchPanRef.current.lastX;
        const dy = touch.clientY - touchPanRef.current.lastY;
        touchPanRef.current = { lastX: touch.clientX, lastY: touch.clientY };
        panBy(dx, dy);
      } else if (event.touches.length === 2 && pinchRef.current) {
        const rect = event.currentTarget.getBoundingClientRect();
        const distance = distanceBetween(event.touches[0], event.touches[1]);
        const mid = midpointOf(event.touches[0], event.touches[1]);
        const factor = (distance / pinchRef.current.distance) * (pinchRef.current.zoom / viewRef.current.zoom);
        zoomAt(mid.x - rect.left, mid.y - rect.top, factor);
      }
    },
    [panBy, zoomAt],
  );

  const handleTouchEnd = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 0) {
      touchPanRef.current = null;
      pinchRef.current = null;
    } else if (event.touches.length === 1) {
      pinchRef.current = null;
      touchPanRef.current = { lastX: event.touches[0].clientX, lastY: event.touches[0].clientY };
    }
  }, []);

  useEffect(() => {
    setAddingToClass(null);
    setDraftName("");
  }, [projectId]);

  if (!project) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
        Loading graph…
      </div>
    );
  }

  const width = Math.max(
    800,
    (Math.max(1, ...laidOut.map((c) => c.x + NODE_WIDTH)) || NODE_WIDTH) + 80,
  );
  const height = Math.max(400, (laidOut.at(-1)?.y ?? 0) + ROW_HEIGHT + 40);

  const relations = project.relations;
  const positionById = new Map(laidOut.map((c) => [c.id, c]));

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopPointerPan}
      onPointerLeave={stopPointerPan}
      onPointerCancel={stopPointerPan}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onContextMenu={(e) => e.preventDefault()}
      style={{ touchAction: "none" }}
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
            const x1 = parent.x + 40 + NODE_WIDTH / 2;
            const y1 = parent.y + 40 + NODE_HEIGHT;
            const x2 = child.x + 40 + NODE_WIDTH / 2;
            const y2 = child.y + 40;
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
          return (
            <div
              key={cls.id}
              className="absolute flex flex-col items-center gap-2"
              style={{ left: cls.x + 40, top: cls.y + 40, width: NODE_WIDTH }}
            >
              <div className="flex h-16 w-full items-center justify-center rounded-xl border border-border bg-card px-4 text-center shadow-sm">
                <span className="truncate text-sm font-semibold text-card-foreground">
                  {cls.label}
                </span>
              </div>

              <div className="flex w-full flex-wrap justify-center gap-1.5">
                {classProperties.map((property) => {
                  const isMine = property.proposedByUserId === currentUserId;
                  const myAgreement = property.agreements.some(
                    (a) => a.userId === currentUserId,
                  );
                  const proposerColor = colorForSlot(property.proposedByColorSlot);
                  const canDelete = myAgreement;
                  const isEditing = editingProperty === property.id;

                  return (
                    <div key={property.id} className="group/pill relative">
                      {isEditing ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (editDraft.trim()) {
                              updateProperty.mutate(
                                {
                                  id: projectId,
                                  propertyId: property.id,
                                  data: { name: editDraft.trim() },
                                },
                                { onSuccess: invalidateProperties },
                              );
                            }
                            setEditingProperty(null);
                          }}
                        >
                          <input
                            autoFocus
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            onBlur={(e) => {
                              // Losing focus (click elsewhere, tab away, etc.)
                              // must not silently discard the edit — commit it
                              // just like pressing Enter would, and only
                              // cancel outright if the field was left empty.
                              e.currentTarget.form?.requestSubmit();
                            }}
                            className="h-7 w-28 rounded-full border border-primary bg-background px-3 text-xs outline-none"
                          />
                        </form>
                      ) : (
                        <button
                          type="button"
                          title={
                            property.agreedByAll
                              ? "Fully agreed"
                              : `Proposed by ${property.proposedByUsername}`
                          }
                          onClick={() => {
                            if (isMine) {
                              setEditingProperty(property.id);
                              setEditDraft(property.name);
                              return;
                            }
                            if (!myAgreement) {
                              agreeProperty.mutate(
                                { id: projectId, propertyId: property.id },
                                { onSuccess: invalidateProperties },
                              );
                            }
                          }}
                          className="flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium shadow-sm transition-transform hover:scale-105"
                          style={{
                            borderColor: property.agreedByAll
                              ? "hsl(var(--primary))"
                              : proposerColor.ring,
                            background: property.agreedByAll
                              ? "hsl(var(--primary) / 0.12)"
                              : proposerColor.soft,
                            color: property.agreedByAll
                              ? "hsl(var(--primary))"
                              : proposerColor.softText,
                          }}
                        >
                          <span className="flex -space-x-1">
                            {property.agreements.map((a) => (
                              <span
                                key={a.userId}
                                className="h-2.5 w-2.5 rounded-full border border-background"
                                style={{ background: colorForSlot(a.colorSlot).solid }}
                              />
                            ))}
                          </span>
                          {property.name}
                        </button>
                      )}

                      {canDelete && !isEditing && (
                        <button
                          type="button"
                          aria-label="Remove your contribution"
                          onClick={(e) => {
                            e.stopPropagation();
                            retractProperty.mutate(
                              { id: projectId, propertyId: property.id },
                              { onSuccess: invalidateProperties },
                            );
                          }}
                          className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] leading-none text-destructive-foreground group-hover/pill:flex"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                })}

                {addingToClass === cls.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (draftName.trim()) {
                        createProperty.mutate(
                          {
                            id: projectId,
                            data: { classId: cls.id, name: draftName.trim() },
                          },
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
                        // Same rationale as the edit form: clicking away must
                        // commit a non-empty draft rather than silently drop
                        // it. The submit handler itself no-ops on empty input
                        // and still closes the form.
                        e.currentTarget.form?.requestSubmit();
                      }}
                      className="h-7 w-28 rounded-full border border-primary bg-background px-3 text-xs outline-none"
                    />
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setAddingToClass(cls.id);
                      setDraftName("");
                    }}
                    className="flex h-7 items-center gap-1 rounded-full border border-dashed border-emerald-500/50 px-3 text-xs font-medium text-emerald-600 transition-colors hover:border-emerald-500 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
                  >
                    + property
                  </button>
                )}
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
