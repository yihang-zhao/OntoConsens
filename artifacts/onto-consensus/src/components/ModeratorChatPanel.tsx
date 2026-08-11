import { useEffect, useMemo, useRef, useState } from "react";
import {
  useConfigureModerator,
  useDisableModerator,
  useListModeratorChatMessages,
  getGetModeratorStatusQueryKey,
  getListModeratorChatMessagesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { Sparkles, AlertTriangle, X, Mic, MicOff } from "lucide-react";
import { useModeratorAudio } from "@/hooks/useModeratorAudio";
import { colorForSlot } from "@/lib/memberColors";
import type { ModeratorChatMessage } from "@/hooks/useProjectSocket";

interface ModeratorChatPanelProps {
  projectId: number;
  /** Whether the CURRENT user has turned the moderator on for themselves --
   *  purely per-person, independent of every other member. */
  moderatorActive: boolean;
  /** True once the project creator's account has an OpenAI API key saved --
   *  without one, nobody can turn the moderator on. */
  moderatorConfigured: boolean;
  /** New messages received live over the socket since this page mounted --
   *  appended to (not replacing) the persisted history fetched below. */
  liveMessages: ModeratorChatMessage[];
  onVolume: (level: number) => void;
  moderatorErrorMessage: string | null;
  onDismissError: () => void;
}

// Deduplicate by id: the persisted-history fetch and live socket messages can
// legitimately overlap (e.g. a message arrives over the socket just before
// the history query resolves) -- id is the one stable identity both sides
// agree on.
function mergeMessages(history: ModeratorChatMessage[], live: ModeratorChatMessage[]): ModeratorChatMessage[] {
  const byId = new Map<number, ModeratorChatMessage>();
  for (const m of history) byId.set(m.id, m);
  for (const m of live) byId.set(m.id, m);
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

export function ModeratorChatPanel({
  projectId,
  moderatorActive,
  moderatorConfigured,
  liveMessages,
  onVolume,
  moderatorErrorMessage,
  onDismissError,
}: ModeratorChatPanelProps) {
  const queryClient = useQueryClient();
  const configure = useConfigureModerator();
  const disable = useDisableModerator();

  const { data: history } = useListModeratorChatMessages(projectId, {
    query: { queryKey: getListModeratorChatMessagesQueryKey(projectId) },
  });

  const messages = useMemo(
    () => mergeMessages((history?.messages as ModeratorChatMessage[] | undefined) ?? [], liveMessages),
    [history, liveMessages],
  );

  const invalidateStatus = () =>
    queryClient.invalidateQueries({ queryKey: getGetModeratorStatusQueryKey(projectId) });

  // Turning the moderator on for yourself is the same click that starts
  // capturing your mic. The browser's own permission prompt is the only
  // thing the user sees the first time; if they've already granted it, the
  // mic just opens.
  const { micError } = useModeratorAudio({
    projectId,
    active: moderatorActive,
    onVolume,
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

  // Rejecting the mic is a purely local, ephemeral reminder -- never
  // persisted or broadcast to anyone else. It just tells THIS user the
  // moderator can't hear them until they turn their mic on.
  const [showRejectReminder, setShowRejectReminder] = useState(false);
  const rejectReminderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (rejectReminderTimerRef.current) clearTimeout(rejectReminderTimerRef.current);
    };
  }, []);

  const handleToggleClick = () => {
    if (moderatorActive) {
      disable.mutate({ id: projectId }, { onSuccess: invalidateStatus });
    } else {
      configure.mutate(
        { id: projectId },
        {
          onSuccess: () => {
            invalidateStatus();
            queryClient.invalidateQueries({ queryKey: getListModeratorChatMessagesQueryKey(projectId) });
          },
        },
      );
    }
  };

  const handleRejectClick = () => {
    if (rejectReminderTimerRef.current) clearTimeout(rejectReminderTimerRef.current);
    setShowRejectReminder(true);
    rejectReminderTimerRef.current = setTimeout(() => setShowRejectReminder(false), 5_000);
  };

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <aside className="w-80 shrink-0 h-full flex flex-col border-l bg-card">
      <div className="flex items-center gap-2 h-14 px-4 border-b shrink-0">
        <Sparkles className="w-4 h-4 text-primary" />
        <span className="font-semibold text-sm">AI Moderator</span>
      </div>

      {moderatorErrorMessage && (
        <div className="flex items-start gap-2 bg-destructive/10 border-b border-destructive/30 text-destructive text-xs font-medium px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="flex-1">{moderatorErrorMessage}</span>
          <button onClick={onDismissError} className="opacity-70 hover:opacity-100 shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground text-center mt-6">
            The AI moderator's messages will appear here once the shared workspace is open.
          </p>
        )}
        {messages.map((message) => (
          <ChatMessageBubble key={message.id} message={message} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t shrink-0 p-3 flex flex-col gap-2">
        {showRejectReminder && (
          <p className="text-[11px] font-medium text-muted-foreground bg-muted rounded-lg px-2.5 py-1.5">
            The moderator can't hear you until you enable your microphone.
          </p>
        )}
        {configure.isError && !moderatorActive && (
          <p className="text-[11px] font-medium text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-2.5 py-1.5">
            {(configure.error as any)?.data?.error || "Could not turn on the AI moderator."}
          </p>
        )}
        <div className="flex items-center gap-2 bg-muted/50 border rounded-full pl-3 pr-2.5 py-2">
          {moderatorActive ? (
            <Mic className="w-4 h-4 text-primary" />
          ) : (
            <MicOff className="w-4 h-4 text-muted-foreground" />
          )}
          <span className="flex-1 text-xs font-medium text-muted-foreground">
            {moderatorActive ? "Microphone enabled" : "Microphone disabled"}
          </span>
          {!moderatorActive && (
            <button
              onClick={handleRejectClick}
              className="text-[11px] font-semibold text-muted-foreground hover:text-foreground px-1.5"
            >
              Reject
            </button>
          )}
          <Switch
            checked={moderatorActive}
            onCheckedChange={handleToggleClick}
            disabled={disable.isPending || configure.isPending || (!moderatorActive && !moderatorConfigured)}
          />
        </div>
      </div>
    </aside>
  );
}

function ChatMessageBubble({ message }: { message: ModeratorChatMessage }) {
  if (message.type === "intro" || message.type === "system" || message.type === "intervention") {
    const color = message.userId !== null ? colorForSlot(message.colorSlot ?? 0) : null;
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          {message.type === "intervention" ? (
            <Sparkles className="w-3 h-3 text-primary" />
          ) : (
            <Sparkles className="w-3 h-3 text-muted-foreground" />
          )}
          {message.type === "intervention"
            ? message.matched && message.className && message.propertyName
              ? `${message.className}.${message.propertyName}`
              : "AI moderator"
            : message.userId !== null
              ? message.username ?? "unknown"
              : "AI moderator"}
        </div>
        <div
          className="rounded-xl rounded-tl-sm px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap"
          style={{
            backgroundColor: color ? color.soft : "hsl(var(--muted))",
            color: color ? color.softText : undefined,
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  // transcript
  const color = colorForSlot(message.colorSlot ?? 0);
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-semibold" style={{ color: color.solid }}>
        {message.username ?? "unknown"}
      </div>
      <div className="rounded-xl rounded-tl-sm px-3 py-2 text-xs leading-relaxed bg-muted/60 whitespace-pre-wrap">
        {message.content}
      </div>
    </div>
  );
}
