import { Check, ArrowDown } from "lucide-react";

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
  className?: string;
}

const STEPS: GuideStep[] = [
  {
    title: "Propose your properties",
    description:
      "In your individual workspace, add the properties you think each class should have. Nobody else can see these yet. Once you're happy with your proposals, mark yourself ready in the top right bar.",
  },
  {
    title: "Wait for everyone to be ready",
    description: "When everyone is ready, the shared workspace will open and you'll see everyone's proposals together.",
  },
  {
    title: "Reach agreement together",
    description:
      "Open the microphone at the bottom right, and discuss with your group members to reach agreement on all properties that haven't been agreed yet. Once agreement has been made on all properties, the export button will be enabled.",
  },
  {
    title: "Export",
    description:
      "Click the export button at the bottom center of the page, where the current workspace along with the discussion history will be downloaded into 2 independent JSON files that can be reused for later OE tasks.",
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
 * Persistent left-hand panel that reminds the current member what their
 * current task is and what comes next -- a straight top-to-bottom list of
 * the four steps to finish the workflow, connected by down arrows. Distinct
 * from the canvas (what the workspace currently looks like) and the
 * discussion panel (what's being said). Purely derived from state already
 * tracked on the project page.
 */
export function WorkspaceGuidePanel({
  isReady,
  allReady,
  workspaceFullyAgreed,
  className,
}: WorkspaceGuidePanelProps) {
  const current = currentStepIndex(isReady, allReady, workspaceFullyAgreed);

  return (
    <aside
      className={`w-full lg:w-72 shrink-0 h-full flex-col border rounded-2xl shadow-sm bg-card overflow-hidden ${className ?? "hidden lg:flex"}`}
    >
      <div className="flex items-center justify-center h-14 px-4 border-b shrink-0">
        <span className="font-semibold text-sm">Tutorial</span>
      </div>

      <div className="flex-1 min-h-0 flex flex-col px-4 py-4">
        {STEPS.map((step, i) => {
          const isDone = i < current;
          const isCurrent = i === current;
          const isNext = i === current + 1;
          return (
            <div key={step.title} className="flex-1 min-h-0 flex flex-col justify-center">
              <div className="px-3">
                <div className="flex items-center gap-2 mb-1">
                  <div
                    className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-semibold ${
                      isDone
                        ? "bg-green-600 text-white"
                        : isCurrent
                          ? "bg-foreground text-background"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isDone ? <Check className="w-3 h-3" /> : i + 1}
                  </div>
                  <p
                    className={`text-sm font-semibold leading-tight ${
                      isCurrent
                        ? "text-foreground"
                        : isDone
                          ? "text-muted-foreground"
                          : isNext
                            ? "text-foreground/80"
                            : "text-muted-foreground/60"
                    }`}
                  >
                    {step.title}
                  </p>
                </div>
                <p
                  className={`text-xs leading-snug pl-7 ${
                    isCurrent || isNext ? "text-muted-foreground" : "text-muted-foreground/50"
                  }`}
                >
                  {step.description}
                </p>
              </div>

              {i < STEPS.length - 1 && (
                <div className="flex justify-center py-1.5">
                  <ArrowDown className={`w-4 h-4 ${isDone ? "text-green-600" : "text-muted-foreground/40"}`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
