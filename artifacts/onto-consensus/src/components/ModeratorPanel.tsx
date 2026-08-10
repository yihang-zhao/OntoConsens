import { useEffect, useRef, useState } from "react";
import {
  useConfigureModerator,
  useDisableModerator,
  getGetModeratorStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { Sparkles, AlertTriangle, X } from "lucide-react";
import { useModeratorAudio } from "@/hooks/useModeratorAudio";
import { colorForSlot } from "@/lib/memberColors";
import { ModeratorGauge } from "@/components/ModeratorGauge";
import type { ModeratorSummaryEvent, SpeakerVolume } from "@/hooks/useProjectSocket";

interface ModeratorMember {
  userId: number;
  colorSlot: number;
}

interface ModeratorPanelProps {
  projectId: number;
  /** The AI moderator only ever appears once the shared consensus space is open. */
  sharedModeEnabled: boolean;
  members: ModeratorMember[];
  speakerVolumes: Map<number, SpeakerVolume>;
  sendVolume: (level: number) => void;
  /** Whether the CURRENT user has turned the moderator on for themselves --
   *  purely per-person, independent of every other member. */
  moderatorActive: boolean;
  /** True once the project creator's account has an OpenAI API key saved --
   *  without one, nobody can turn the moderator on. */
  moderatorConfigured: boolean;
  summaries: ModeratorSummaryEvent[];
  moderatorErrorMessage: string | null;
  onDismissError: () => void;
  /** Called once the summary popup actually disappears (whether the user
   *  closed it or it timed out from not being hovered) -- null when that
   *  round never resolved to a real class/property, in which case there's
   *  nothing to highlight. */
  onSummaryDismissed?: (target: { classId: number; propertyId: number } | null) => void;
}

// The summary popup stays up indefinitely while the user is hovering it, and
// disappears either when they explicitly close it, or after this many ms of
// NOT being hovered -- so it reads as something to linger on and read, not a
// timed toast that might vanish mid-sentence.
const SUMMARY_TOAST_HOVER_GRACE_MS = 3_000;
const SUMMARY_TOAST_FADE_MS = 300;

export function ModeratorPanel({
  projectId,
  sharedModeEnabled,
  members,
  speakerVolumes,
  sendVolume,
  moderatorActive,
  moderatorConfigured,
  summaries,
  moderatorErrorMessage,
  onDismissError,
  onSummaryDismissed,
}: ModeratorPanelProps) {
  const queryClient = useQueryClient();
  const configure = useConfigureModerator();
  const disable = useDisableModerator();

  const invalidateStatus = () =>
    queryClient.invalidateQueries({ queryKey: getGetModeratorStatusQueryKey(projectId) });

  // Turning the moderator on for yourself is the same click that starts
  // capturing your mic -- there's no separate consent step in this app. The
  // browser's own permission prompt is the only thing the user sees the
  // first time; if they've already granted it, the mic just opens.
  const { micError } = useModeratorAudio({
    projectId,
    active: moderatorActive,
    onVolume: sendVolume,
  });

  // "If the user at any point closes the mic, the AI moderator is closed as
  // well" -- so losing mic access (denied/revoked permission, device
  // disappearing mid-session) always turns the moderator back off for this
  // user, rather than leaving it in a state that claims to be on but isn't
  // actually capturing anything.
  useEffect(() => {
    if (moderatorActive && micError) {
      disable.mutate({ id: projectId }, { onSuccess: invalidateStatus });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moderatorActive, micError]);

  const handleToggleClick = () => {
    if (moderatorActive) {
      disable.mutate({ id: projectId }, { onSuccess: invalidateStatus });
    } else {
      configure.mutate({ id: projectId }, { onSuccess: invalidateStatus });
    }
  };

  // A fluent, floating summary notification: appears centered over the
  // canvas and stays up as long as the user is reading it. It only goes away
  // when they explicitly close it, or once they've stopped hovering it for
  // SUMMARY_TOAST_HOVER_GRACE_MS -- so it never vanishes out from under
  // someone mid-read, but also never lingers forever once they've moved on.
  const [toastSummary, setToastSummary] = useState<ModeratorSummaryEvent | null>(null);
  const [toastShown, setToastShown] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastSummaryRef = useRef<ModeratorSummaryEvent | null>(null);
  toastSummaryRef.current = toastSummary;

  const cancelHide = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  };

  const dismissToast = () => {
    cancelHide();
    setToastShown(false);
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => {
      const dismissed = toastSummaryRef.current;
      setToastSummary(null);
      onSummaryDismissed?.(
        dismissed?.matched && dismissed.classId !== null && dismissed.propertyId !== null
          ? { classId: dismissed.classId, propertyId: dismissed.propertyId }
          : null,
      );
    }, SUMMARY_TOAST_FADE_MS);
  };

  const scheduleHide = () => {
    cancelHide();
    hideTimerRef.current = setTimeout(dismissToast, SUMMARY_TOAST_HOVER_GRACE_MS);
  };

  useEffect(() => {
    if (summaries.length === 0) return;
    const latest = summaries[summaries.length - 1]!;
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    setToastSummary(latest);
    setToastShown(false);
    const showTimer = setTimeout(() => setToastShown(true), 20);
    // Not hovered yet -- start the auto-hide grace period immediately.
    scheduleHide();
    return () => clearTimeout(showTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaries.length]);

  // Cancel any pending timers on unmount so they never fire against a
  // detached component.
  useEffect(() => {
    return () => {
      cancelHide();
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  if (!sharedModeEnabled) return null;

  // The pulsing border reflects whoever is currently speaking loudest, using
  // their member color — a stand-in "who has the floor" indicator without
  // showing raw audio or a transcript.
  const activeSpeaker = [...speakerVolumes.values()]
    .filter((v) => v.level > 0.04)
    .sort((a, b) => b.level - a.level)[0];
  const speakerColor = activeSpeaker
    ? colorForSlot(members.find((m) => m.userId === activeSpeaker.userId)?.colorSlot ?? 0)
    : null;

  return (
    <>
      {/* Pulsing border overlay while someone opted-in is speaking */}
      {activeSpeaker && speakerColor && (
        <div
          className="pointer-events-none absolute inset-0 z-40 transition-[box-shadow] duration-100 rounded-none"
          style={{
            boxShadow: `inset 0 0 0 ${3 + activeSpeaker.level * 10}px ${speakerColor.solid}`,
            opacity: 0.35 + activeSpeaker.level * 0.5,
          }}
        />
      )}
      {moderatorErrorMessage && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-destructive/10 border border-destructive/30 text-destructive text-xs font-medium rounded-full px-4 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5" />
          {moderatorErrorMessage}
          <button onClick={onDismissError} className="opacity-70 hover:opacity-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {/* Floating AI summary popup, centered over the canvas. It stays open
          while hovered, and otherwise fades out on its own a few seconds
          after the mouse leaves it (or immediately on close). Only the card
          itself captures clicks/hover, so it never blocks interaction with
          the canvas underneath. */}
      {toastSummary && (
        <div
          className={`pointer-events-none absolute inset-0 z-50 flex items-center justify-center transition-opacity ease-out ${
            toastShown ? "opacity-100 duration-300" : "opacity-0 duration-300"
          }`}
        >
          <div
            className="pointer-events-auto relative max-w-lg w-[92%] bg-card/95 backdrop-blur-sm border shadow-xl rounded-2xl pt-9 pb-3 px-3"
            onMouseEnter={cancelHide}
            onMouseLeave={scheduleHide}
          >
            <div className="absolute top-3 left-4 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Sparkles className="w-3.5 h-3.5 text-primary" />
              {toastSummary.matched && toastSummary.className && toastSummary.propertyName
                ? `${toastSummary.className}.${toastSummary.propertyName}`
                : "AI moderator"}
            </div>
            <button
              onClick={dismissToast}
              className="absolute top-2.5 right-2.5 text-muted-foreground/70 hover:text-muted-foreground"
              aria-label="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
            {toastSummary.matched ? (
              <ModeratorGauge segments={toastSummary.segments} />
            ) : (
              <p className="px-2 pb-1 pt-1 text-sm text-muted-foreground">
                Couldn't tell which class or property this was about. Try focusing the discussion on
                properties that are already in this shared workspace.
              </p>
            )}
          </div>
        </div>
      )}
      {/* Single toggle, per-person: turns the moderator (mic + transcript)
          on or off for whoever flips it, with no effect on anyone else. A
          slide switch reads unambiguously as an on/off state rather than a
          momentary action button. */}
      <div className="absolute bottom-4 right-4 z-40 flex flex-col items-end gap-1.5">
        {configure.isError && !moderatorActive && (
          <p className="max-w-56 text-right text-[11px] font-medium text-destructive bg-card border border-destructive/30 rounded-lg px-2 py-1 shadow-sm">
            {(configure.error as any)?.data?.error || "Could not turn on the AI moderator."}
          </p>
        )}
        <div className="flex items-center gap-2 bg-card border shadow-md rounded-full pl-3 pr-2.5 py-2">
          <Sparkles className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">AI Moderator</span>
          <Switch
            checked={moderatorActive}
            onCheckedChange={handleToggleClick}
            disabled={disable.isPending || configure.isPending || (!moderatorActive && !moderatorConfigured)}
          />
        </div>
      </div>
    </>
  );
}
