import { useMemo, useRef, useState, useCallback, useEffect } from "react";
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

  const { data: project } = useGetProject(projectId, {
    query: { queryKey: getGetProjectQueryKey(projectId) },
  });
  const { data: properties } = useListProperties(projectId, {
    query: { queryKey: getListPropertiesQueryKey(projectId) },
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

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!sharedModeEnabled) return;
      const rect = event.currentTarget.getBoundingClientRect();
      sendCursor(event.clientX - rect.left, event.clientY - rect.top);
    },
    [sendCursor, sharedModeEnabled],
  );

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
      className="relative h-full w-full overflow-auto bg-[radial-gradient(circle_at_1px_1px,theme(colors.border)_1px,transparent_0)] [background-size:24px_24px]"
    >
      <div
        className="relative"
        style={{ width, height, minWidth: "100%", padding: "40px" }}
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
                            onBlur={() => setEditingProperty(null)}
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
                      onBlur={() => setAddingToClass(null)}
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
