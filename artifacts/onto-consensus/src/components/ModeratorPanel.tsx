import { useEffect, useState } from "react";
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
import type { SpeakerVolume } from "@/hooks/useProjectSocket";

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
  summaries: { text: string; createdAt: string }[];
  moderatorErrorMessage: string | null;
  onDismissError: () => void;
}

// How long a summary toast stays fully visible before it starts fading, and
// the total lifetime after which it's removed from the DOM. Long enough to
// read a few sentences, short enough that it never feels like something
// waiting to be dismissed.
const SUMMARY_TOAST_VISIBLE_MS = 9_000;
const SUMMARY_TOAST_FADE_MS = 700;

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
  // canvas, fades in and back out on its own, and never demands a click to
  // go away -- so it reads as commentary rather than an interruption.
  const [toastSummary, setToastSummary] = useState<{ text: string; createdAt: string } | null>(null);
  const [toastShown, setToastShown] = useState(false);
  useEffect(() => {
    if (summaries.length === 0) return;
    const latest = summaries[summaries.length - 1]!;
    setToastSummary(latest);
    setToastShown(false);
    const showTimer = setTimeout(() => setToastShown(true), 20);
    const hideTimer = setTimeout(() => setToastShown(false), SUMMARY_TOAST_VISIBLE_MS);
    const clearTimer = setTimeout(() => setToastSummary(null), SUMMARY_TOAST_VISIBLE_MS + SUMMARY_TOAST_FADE_MS);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      clearTimeout(clearTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaries.length]);

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

      {/* Floating AI summary toast, centered over the canvas -- fades in,
          lingers briefly, fades out on its own. Only the card itself
          captures clicks, so it never blocks interaction with the canvas
          underneath. */}
      {toastSummary && (
        <div
          className={`pointer-events-none absolute inset-0 z-50 flex items-center justify-center transition-opacity ease-out ${
            toastShown ? "opacity-100 duration-500" : "opacity-0 duration-700"
          }`}
        >
          <div className="pointer-events-auto max-w-md w-[90%] bg-card/95 backdrop-blur-sm border shadow-xl rounded-2xl p-4 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Sparkles className="w-3.5 h-3.5 text-primary" />
              AI moderator
            </div>
            <p className="text-sm whitespace-pre-wrap leading-relaxed">{toastSummary.text}</p>
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
          <Sparkles className={`w-4 h-4 ${moderatorActive ? "text-primary" : "text-muted-foreground"}`} />
          <span className="text-xs font-medium text-muted-foreground">AI moderator</span>
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
