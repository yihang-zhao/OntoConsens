import { useEffect, useState } from "react";
import {
  useConfigureModerator,
  useDisableModerator,
  useModeratorMicOptIn,
  getGetModeratorStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Sparkles, Mic, MicOff, AlertTriangle, X, Loader2 } from "lucide-react";
import { useModeratorAudio } from "@/hooks/useModeratorAudio";
import { colorForSlot } from "@/lib/memberColors";
import type { SpeakerVolume } from "@/hooks/useProjectSocket";

interface ModeratorMember {
  userId: number;
  colorSlot: number;
}

interface ModeratorPanelProps {
  projectId: number;
  isOwner: boolean;
  /** The AI moderator only ever appears once the shared consensus space is open. */
  sharedModeEnabled: boolean;
  members: ModeratorMember[];
  speakerVolumes: Map<number, SpeakerVolume>;
  sendVolume: (level: number) => void;
  moderatorEnabled: boolean;
  /** Bumped on every activate/deactivate; resets local mic opt-in state. */
  moderatorSessionKey: number;
  justActivated: boolean;
  onDismissActivation: () => void;
  summaries: { text: string; createdAt: string }[];
  moderatorErrorMessage: string | null;
  onDismissError: () => void;
}

export function ModeratorPanel({
  projectId,
  isOwner,
  sharedModeEnabled,
  members,
  speakerVolumes,
  sendVolume,
  moderatorEnabled,
  moderatorSessionKey,
  justActivated,
  onDismissActivation,
  summaries,
  moderatorErrorMessage,
  onDismissError,
}: ModeratorPanelProps) {
  const queryClient = useQueryClient();
  const [configOpen, setConfigOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-5.6-luna");
  const [micOptedIn, setMicOptedIn] = useState(false);
  const [summariesOpen, setSummariesOpen] = useState(false);

  // Consent never survives a session boundary: every activate or deactivate
  // means any prior "yes" no longer applies, so mic capture must stop and the
  // opt-in affordance must reappear until the user says yes again for the
  // session that's actually live now.
  useEffect(() => {
    setMicOptedIn(false);
  }, [moderatorSessionKey]);

  const configure = useConfigureModerator();
  const disable = useDisableModerator();
  const micOptIn = useModeratorMicOptIn();

  const { micError } = useModeratorAudio({
    projectId,
    active: moderatorEnabled && micOptedIn,
    onVolume: sendVolume,
  });

  if (!sharedModeEnabled) return null;

  const handleToggleClick = () => {
    if (moderatorEnabled) {
      disable.mutate(
        { id: projectId },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetModeratorStatusQueryKey(projectId) });
          },
        },
      );
    } else {
      setApiKey("");
      setConfigOpen(true);
    }
  };

  const handleSave = () => {
    if (!apiKey.trim()) return;
    configure.mutate(
      { id: projectId, data: { apiKey: apiKey.trim(), model: model.trim() || undefined } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetModeratorStatusQueryKey(projectId) });
          setConfigOpen(false);
          setApiKey("");
        },
      },
    );
  };

  const handleOptIn = () => {
    // Capture is gated on `micOptedIn`, so it must not flip true until the
    // server has actually recorded consent for the live session — an
    // optimistic flip here would start the mic even if the request lands
    // just after a deactivate/reconfigure rejects it.
    micOptIn.mutate(
      { id: projectId },
      {
        onSuccess: () => setMicOptedIn(true),
      },
    );
    onDismissActivation();
  };

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

      {/* Mic opt-in affordance: shown as a one-time celebratory toast right
          after activation, but the underlying condition (moderator on, this
          user hasn't opted in) also drives a persistent pill below — so a
          member who reloads or joins after activation can still opt in. */}
      {justActivated && !micOptedIn && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-card border shadow-lg rounded-full pl-4 pr-2 py-2">
          <Sparkles className="w-4 h-4 text-primary shrink-0" />
          <span className="text-sm">The AI moderator was turned on. Share your mic so it can follow along?</span>
          <Button size="sm" className="gap-1.5 rounded-full" onClick={handleOptIn}>
            <Mic className="w-3.5 h-3.5" />
            Enable mic
          </Button>
          <Button size="icon" variant="ghost" className="rounded-full w-7 h-7" onClick={onDismissActivation}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}

      {/* Persistent opt-in pill: visible any time the moderator is on and
          this user hasn't shared their mic yet, independent of the
          transient activation event above (covers reload / late join). */}
      {moderatorEnabled && !micOptedIn && !justActivated && (
        <div className="absolute bottom-4 right-36 z-40">
          <Button
            size="sm"
            variant="secondary"
            className="gap-1.5 rounded-full shadow-md"
            onClick={handleOptIn}
            title="Share your mic with the AI moderator"
          >
            <Mic className="w-3.5 h-3.5" />
            Enable mic
          </Button>
        </div>
      )}

      {micError && micOptedIn && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-destructive/10 border border-destructive/30 text-destructive text-xs font-medium rounded-full px-4 py-1.5">
          <MicOff className="w-3.5 h-3.5" />
          {micError}
        </div>
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

      {/* Summary feed toggle, visible to everyone once the moderator is on */}
      {moderatorEnabled && (
        <div className="absolute bottom-4 right-20 z-40">
          {summariesOpen && (
            <div className="absolute bottom-12 right-0 w-80 max-h-96 overflow-y-auto bg-card border shadow-xl rounded-xl p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-muted-foreground">AI summaries</span>
                <button onClick={() => setSummariesOpen(false)} className="opacity-60 hover:opacity-100">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              {summaries.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No summary yet — one appears after 5 seconds of silence following some discussion.
                </p>
              ) : (
                [...summaries].reverse().map((s, i) => (
                  <div key={i} className="text-xs border-l-2 border-primary/40 pl-2">
                    <div className="text-[10px] text-muted-foreground mb-0.5">
                      {new Date(s.createdAt).toLocaleTimeString()}
                    </div>
                    <p className="whitespace-pre-wrap leading-relaxed">{s.text}</p>
                  </div>
                ))
              )}
            </div>
          )}
          <Button
            size="icon"
            variant="secondary"
            className="rounded-full w-11 h-11 shadow-md relative"
            onClick={() => setSummariesOpen((v) => !v)}
            title="AI moderator summaries"
          >
            <Sparkles className="w-5 h-5" />
            {summaries.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground text-[10px] rounded-full w-4 h-4 flex items-center justify-center">
                {summaries.length}
              </span>
            )}
          </Button>
        </div>
      )}

      {/* Owner-only toggle */}
      {isOwner && (
        <div className="absolute bottom-4 right-4 z-40">
          <Button
            size="icon"
            variant={moderatorEnabled ? "default" : "outline"}
            className="rounded-full w-11 h-11 shadow-md"
            onClick={handleToggleClick}
            disabled={disable.isPending}
            title={moderatorEnabled ? "Turn off AI moderator" : "Turn on AI moderator"}
          >
            {disable.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
          </Button>
        </div>
      )}

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn on the AI moderator</DialogTitle>
            <DialogDescription>
              Paste an OpenAI API key. It's encrypted and used only for this project — members
              who opt in will be prompted to share their mic, and the moderator will post a
              speaker-by-speaker summary after quiet moments in the conversation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">OpenAI API key</label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Summary model</label>
              <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-5.6-luna" />
            </div>
            {configure.isError && (
              <p className="text-xs text-destructive">
                {(configure.error as any)?.data?.error || "Could not save that key."}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfigOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!apiKey.trim() || configure.isPending}>
              {configure.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Turn on"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
