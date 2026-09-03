import type { ReactElement } from "react";
import { Plus, ArrowRight, Check, X, MousePointer2, Download, CheckCircle2 } from "lucide-react";

interface GuideStep {
  title: string;
  description: string;
  illustration: () => ReactElement;
}

interface WorkspaceGuidePanelProps {
  /** Has the current member marked themselves ready yet. */
  isReady: boolean;
  /** Has the whole project reached full membership with everyone ready. */
  allReady: boolean;
  /** Every property in the shared workspace has full agreement. */
  workspaceFullyAgreed: boolean;
  /** How many more members still need to join/ready up before the shared
   *  space opens -- only meaningful once this member is ready themselves. */
  membersStillNeeded: number;
  className?: string;
}

/** Miniature, decorative re-creations of the real UI each step refers to --
 *  not screenshots, but built from the same shapes (cards, chips, avatars,
 *  buttons) so a member recognizes them the moment they look at the actual
 *  page. Each fills the illustration area of the guide panel. */

function ProposePropertiesIllustration() {
  return (
    <div className="w-full h-full flex items-center justify-center px-2">
      <div className="w-full max-w-[220px] rounded-xl border-2 border-dashed border-primary/40 bg-primary/5 p-3">
        <p className="text-xs font-semibold mb-2">Animal</p>
        <div className="flex flex-col gap-1.5 mb-2">
          <span className="text-[11px] rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground px-2 py-1 w-fit">
            hasLegs
          </span>
          <span className="text-[11px] rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground px-2 py-1 w-fit">
            canFly
          </span>
        </div>
        <div className="flex items-center gap-1 text-[11px] font-medium text-primary animate-pulse w-fit">
          <Plus className="w-3 h-3" />
          Add property
        </div>
      </div>
    </div>
  );
}

function MarkReadyIllustration() {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-4 px-2">
      <div className="flex items-center gap-1.5">
        <div className="w-8 h-8 rounded-full border-2 border-green-500 ring-2 ring-green-500/20 bg-muted flex items-center justify-center text-[10px] font-semibold">
          YOU
        </div>
        <div className="w-8 h-8 rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center">
          <span className="text-[9px] text-muted-foreground/50">--</span>
        </div>
        <div className="w-8 h-8 rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center">
          <span className="text-[9px] text-muted-foreground/50">--</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium border rounded-md px-2.5 py-1.5">Mark as Ready</span>
        <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="text-[11px] font-medium rounded-md px-2.5 py-1.5 bg-green-600 text-white flex items-center gap-1">
          <Check className="w-3 h-3" />
          Ready
        </span>
      </div>
    </div>
  );
}

function ReachAgreementIllustration() {
  return (
    <div className="w-full h-full flex items-center justify-center px-2 relative">
      <div className="w-full max-w-[220px] rounded-xl border-2 bg-card shadow-sm p-3">
        <p className="text-xs font-semibold mb-2">Animal</p>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 rounded-full pl-2 pr-1 py-1 border" style={{ borderColor: "hsl(var(--member-0))" }}>
            <span className="text-[11px] font-medium" style={{ color: "hsl(var(--member-0))" }}>
              hasLegs
            </span>
            <div className="flex items-center gap-0.5">
              <span className="w-4 h-4 rounded-full bg-green-600 flex items-center justify-center">
                <Check className="w-2.5 h-2.5 text-white" />
              </span>
              <span className="w-4 h-4 rounded-full bg-muted flex items-center justify-center">
                <X className="w-2.5 h-2.5 text-muted-foreground" />
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-full pl-2 pr-1 py-1 border" style={{ borderColor: "hsl(var(--member-1))" }}>
            <span className="text-[11px] font-medium" style={{ color: "hsl(var(--member-1))" }}>
              canFly
            </span>
            <div className="flex items-center gap-0.5">
              <span className="w-4 h-4 rounded-full bg-muted flex items-center justify-center">
                <Check className="w-2.5 h-2.5 text-muted-foreground" />
              </span>
              <span className="w-4 h-4 rounded-full bg-muted flex items-center justify-center">
                <X className="w-2.5 h-2.5 text-muted-foreground" />
              </span>
            </div>
          </div>
        </div>
      </div>
      <MousePointer2
        className="w-3.5 h-3.5 absolute top-4 right-8 rotate-12"
        style={{ color: "hsl(var(--member-0))" }}
        fill="hsl(var(--member-0))"
      />
      <MousePointer2
        className="w-3.5 h-3.5 absolute bottom-6 left-10 -rotate-12"
        style={{ color: "hsl(var(--member-1))" }}
        fill="hsl(var(--member-1))"
      />
    </div>
  );
}

function ExportIllustration() {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-4 px-2">
      <div className="flex flex-col gap-1.5 w-full max-w-[200px]">
        {["hasLegs", "canFly", "hasFur"].map((name) => (
          <div key={name} className="flex items-center gap-2 text-[11px]">
            <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
            <span className="text-muted-foreground">{name}</span>
            <span className="ml-auto text-muted-foreground/60">agreed</span>
          </div>
        ))}
      </div>
      <span className="flex items-center gap-2 text-[11px] font-medium rounded-md px-3 py-2 bg-foreground text-background shadow-md">
        <Download className="w-3.5 h-3.5" />
        Export
      </span>
    </div>
  );
}

const STEPS: GuideStep[] = [
  {
    title: "Propose your properties",
    description:
      "In your individual workspace, add the properties you think each class should have. Nobody else can see these yet.",
    illustration: ProposePropertiesIllustration,
  },
  {
    title: "Mark yourself ready",
    description: "Once you're happy with your proposals, mark yourself ready in the top bar.",
    illustration: MarkReadyIllustration,
  },
  {
    title: "Reach agreement together",
    description:
      "The shared workspace shows everyone's proposals stacked on each class. Talk it through and agree or retract each one.",
    illustration: ReachAgreementIllustration,
  },
  {
    title: "Export the ontology",
    description: "Once every property has full agreement, export unlocks at the bottom of the page.",
    illustration: ExportIllustration,
  },
];

/** Which of the four steps above is the member's current focus, given where
 *  the project and this member currently stand. */
function currentStepIndex(isReady: boolean, allReady: boolean, workspaceFullyAgreed: boolean): number {
  if (workspaceFullyAgreed) return 3;
  if (allReady) return 2;
  if (isReady) return 1;
  return 0;
}

/**
 * Persistent left-hand panel that shows the current member what to do next
 * to finish their task on this page -- one step at a time, each illustrated
 * with a miniature re-creation of the real UI it refers to, using the full
 * height of the panel. Distinct from the canvas (what the workspace
 * currently looks like) and the discussion panel (what's being said).
 * Purely derived from state already tracked on the project page.
 */
export function WorkspaceGuidePanel({
  isReady,
  allReady,
  workspaceFullyAgreed,
  membersStillNeeded,
  className,
}: WorkspaceGuidePanelProps) {
  const current = currentStepIndex(isReady, allReady, workspaceFullyAgreed);
  const step = STEPS[current];
  const Illustration = step.illustration;

  return (
    <aside
      className={`w-full lg:w-72 xl:w-80 shrink-0 h-full flex-col border rounded-2xl shadow-sm bg-card overflow-hidden ${className ?? "hidden lg:flex"}`}
    >
      <div className="flex items-center justify-center h-14 px-4 border-b shrink-0">
        <span className="font-semibold text-sm">Guide</span>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {/* Step progress -- which of the four steps this is */}
        <div className="flex items-center justify-center gap-1.5 pt-4 shrink-0">
          {STEPS.map((s, i) => (
            <span
              key={s.title}
              className={`h-1.5 rounded-full transition-all ${
                i === current ? "w-6 bg-foreground" : i < current ? "w-1.5 bg-green-600" : "w-1.5 bg-muted"
              }`}
            />
          ))}
        </div>

        {/* Illustration -- fills the bulk of the panel */}
        <div className="flex-1 min-h-0">
          <Illustration />
        </div>

        {/* Title + description + optional waiting note */}
        <div className="px-4 pb-4 pt-2 shrink-0 text-center">
          <p className="text-[11px] font-medium text-muted-foreground mb-1">
            Step {current + 1} of {STEPS.length}
          </p>
          <p className="text-sm font-semibold mb-1">{step.title}</p>
          <p className="text-xs text-muted-foreground leading-snug">{step.description}</p>
          {isReady && !allReady && (
            <p className="text-xs font-medium text-amber-600 dark:text-amber-400 mt-3">
              {membersStillNeeded > 0
                ? `Waiting on ${membersStillNeeded} more member${membersStillNeeded === 1 ? "" : "s"} to join and mark ready.`
                : "Waiting on other members to mark ready."}
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
