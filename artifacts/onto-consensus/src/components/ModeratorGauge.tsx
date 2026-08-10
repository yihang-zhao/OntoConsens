import { colorForSlot } from "@/lib/memberColors";
import type { ModeratorSummarySegment } from "@/hooks/useProjectSocket";

interface ModeratorGaugeProps {
  segments: ModeratorSummarySegment[];
}

// A semicircular "speedometer" gauge: one equal-width wedge per project
// member, arranged left-to-right along a 0%-100% agreement-to-retain scale.
// Members who argued to retain sit left of the needle (colored in their own
// member color); everyone else -- argued to remove, stayed silent, or never
// turned the moderator on -- sits right of the needle (remove = their own
// color, silent/off = gray). The needle itself marks the boundary, so its
// position is simply retainCount / totalCount along the arc.
const CX = 200;
const CY = 198;
const OUTER_R = 132;
const INNER_R = 88;
const LABEL_R = 178;
const GRAY_FILL = "hsl(var(--muted-foreground) / 0.3)";

function polarToXY(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

// Builds an SVG path for one annular wedge (a segment of the gauge "donut")
// spanning [startDeg, endDeg] between the inner and outer radius.
function wedgePath(startDeg: number, endDeg: number): string {
  const outerStart = polarToXY(CX, CY, OUTER_R, startDeg);
  const outerEnd = polarToXY(CX, CY, OUTER_R, endDeg);
  const innerStart = polarToXY(CX, CY, INNER_R, endDeg);
  const innerEnd = polarToXY(CX, CY, INNER_R, startDeg);
  const largeArc = Math.abs(startDeg - endDeg) > 180 ? 1 : 0;
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${OUTER_R} ${OUTER_R} 0 ${largeArc} 0 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerStart.x} ${innerStart.y}`,
    `A ${INNER_R} ${INNER_R} 0 ${largeArc} 1 ${innerEnd.x} ${innerEnd.y}`,
    "Z",
  ].join(" ");
}

export function ModeratorGauge({ segments }: ModeratorGaugeProps) {
  if (segments.length === 0) return null;

  const total = segments.length;
  const step = 180 / total;

  // Left side of the needle: everyone who argued to retain, own color.
  // Right side: everyone else (argued to remove -- own color -- or
  // silent/off -- gray), so the needle boundary always equals the fraction
  // who want to retain.
  const retaining = segments.filter((s) => s.stance === "retain");
  const rest = segments.filter((s) => s.stance !== "retain");
  const ordered = [...retaining, ...rest];
  const needleAngle = 180 - (retaining.length / total) * 180;

  return (
    <svg viewBox="0 0 400 215" className="w-full h-auto select-none" aria-label="Retain vs. remove agreement gauge">
      {ordered.map((segment, i) => {
        const startDeg = 180 - i * step;
        const endDeg = 180 - (i + 1) * step;
        const midDeg = (startDeg + endDeg) / 2;
        const fill = segment.stance === "unknown" ? GRAY_FILL : colorForSlot(segment.colorSlot).solid;
        const label = polarToXY(CX, CY, LABEL_R, midDeg);
        // Labels near the two ends of the arc sit close to the horizontal
        // centerline and read best left/right aligned; labels nearer the
        // top of the dome read best centered underneath their point.
        const textAnchor = midDeg > 135 ? "end" : midDeg < 45 ? "start" : "middle";

        return (
          <g key={segment.userId}>
            <path
              d={wedgePath(startDeg, endDeg)}
              fill={fill}
              stroke="hsl(var(--card))"
              strokeWidth={2}
            />
            <foreignObject
              x={label.x - 72}
              y={label.y - 22}
              width={144}
              height={48}
              style={{ overflow: "visible", pointerEvents: "none" }}
            >
              <div
                className="text-[10px] leading-snug text-muted-foreground"
                style={{ textAlign: textAnchor === "middle" ? "center" : textAnchor === "end" ? "right" : "left" }}
              >
                <span className="font-semibold" style={{ color: fill }}>
                  {segment.username}
                </span>
                {segment.opinion && <>: {segment.opinion}</>}
              </div>
            </foreignObject>
          </g>
        );
      })}

      {/* Needle marking the retain/remove boundary */}
      {(() => {
        const tip = polarToXY(CX, CY, OUTER_R + 10, needleAngle);
        return (
          <g>
            <line x1={CX} y1={CY} x2={tip.x} y2={tip.y} stroke="hsl(var(--foreground))" strokeWidth={2.5} strokeLinecap="round" />
            <circle cx={CX} cy={CY} r={6} fill="hsl(var(--foreground))" />
          </g>
        );
      })()}

      {/* Scale endpoints */}
      <text x={4} y={CY + 14} className="fill-muted-foreground text-[10px]">0% retain</text>
      <text x={396} y={CY + 14} textAnchor="end" className="fill-muted-foreground text-[10px]">100% retain</text>
    </svg>
  );
}
