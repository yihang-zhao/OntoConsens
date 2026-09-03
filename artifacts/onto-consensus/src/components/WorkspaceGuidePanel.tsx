import { Check } from "lucide-react";

interface GuideStep {
  title: string;
  description: string;
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

const STEPS: GuideStep[] = [
  {
    title: "Propose your properties",
    description:
      "In your individual workspace, add the properties you think each class should have. Nobody else can see these yet.",
  },
  {
    title: "Wait for everyone to be ready",
    description: "Once you're happy with your proposals, mark yourself ready in the top bar.",
  },
  {
    title: "Reach agreement together",
    description:
      "The shared workspace shows everyone's proposals stacked on each class. Talk it through and agree or retract each one.",
  },
  {
    title: "Export the ontology",
    description: "Once every property has full agreement, export unlocks at the bottom of the page.",
  },
];

/** Which of the four steps above is the member's current focus, given where
 *  the project and this member currently stand. Used to render the step
 *  list as done / current / upcoming. */
function currentStepIndex(isReady: boolean, allReady: boolean, workspaceFullyAgreed: boolean): number {
  if (workspaceFullyAgreed) return 3;
  if (allReady) return 2;
  if (isReady) return 1;
  return 0;
}

/**
 * Persistent left-hand panel that tells the current member what to do next
 * to finish their task on this page -- distinct from the canvas (what the
 * workspace currently looks like) and the discussion panel (what's being
 * said). Purely derived from state already tracked on the project page; it
 * has no state or requests of its own.
 */
export function WorkspaceGuidePanel({
  isReady,
  allReady,
  workspaceFullyAgreed,
  membersStillNeeded,
  className,
}: WorkspaceGuidePanelProps) {
  const current = currentStepIndex(isReady, allReady, workspaceFullyAgreed);

  return (
    <aside
      className={`w-full lg:w-64 shrink-0 h-full flex-col border rounded-2xl shadow-sm bg-card overflow-hidden ${className ?? "hidden lg:flex"}`}
    >
      <div className="flex items-center justify-center h-14 px-4 border-b shrink-0">
        <span className="font-semibold text-sm">Guide</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {isReady && !allReady && (
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-4">
            {membersStillNeeded > 0
              ? `Waiting on ${membersStillNeeded} more member${membersStillNeeded === 1 ? "" : "s"} to join and mark ready.`
              : "Waiting on other members to mark ready."}
          </p>
        )}

        <ol className="space-y-4">
          {STEPS.map((step, i) => {
            const isDone = i < current;
            const isCurrent = i === current;
            return (
              <li key={step.title} className="flex gap-3">
                <div
                  className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center mt-0.5 text-[11px] font-semibold ${
                    isDone
                      ? "bg-green-600 text-white"
                      : isCurrent
                        ? "bg-foreground text-background"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {isDone ? <Check className="w-3 h-3" /> : i + 1}
                </div>
                <div>
                  <p
                    className={`text-sm font-medium leading-tight ${
                      isCurrent ? "text-foreground" : isDone ? "text-muted-foreground" : "text-muted-foreground/70"
                    }`}
                  >
                    {step.title}
                  </p>
                  {isCurrent && <p className="text-xs text-muted-foreground mt-1 leading-snug">{step.description}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </aside>
  );
}
