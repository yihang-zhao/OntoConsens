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
import type { LiveCaption, ModeratorChatMessage, SpeakerVolume } from "@/hooks/useProjectSocket";

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
  /** Live per-member mic volume, broadcast by everyone with their mic on --
   *  used to show a "so-and-so is speaking" indicator the instant someone
   *  starts talking, well before their transcript can possibly be
   *  transcribed and posted. */
  speakerVolumes: Map<number, SpeakerVolume>;
  /** Live, word-by-word speech-to-text as each member talks -- a real-time
   *  caption (Teams-style), not the final persisted transcript. Only
   *  populated for members whose browser supports the Web Speech API. */
  liveCaptions: Map<number, LiveCaption>;
  sendCaption: (text: string) => void;
  clearLiveCaption: (userId: number) => void;
  members: { userId: number; username: string; colorSlot: number }[];
  moderatorErrorMessage: string | null;
  onDismissError: () => void;
}

// Someone counts as "currently speaking" while their reported volume is
// above ambient noise and was updated recently -- stale entries are pruned
// by the socket hook itself, so a simple level check is enough here.
const SPEAKING_LEVEL_THRESHOLD = 0.12;

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
  speakerVolumes,
  liveCaptions,
  sendCaption,
  clearLiveCaption,
  members,
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
    onCaption: sendCaption,
  });

  // The instant a real transcript message lands, drop its speaker's interim
  // caption -- otherwise the live caption bubble can sit there stale for up
  // to its own TTL, right next to (or above) the final message it was
  // standing in for.
  const lastMessageIdRef = useRef<number | null>(null);
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.id === lastMessageIdRef.current) return;
    lastMessageIdRef.current = last.id;
    if (last.type === "transcript" && last.userId !== null) {
      clearLiveCaption(last.userId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

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

  // Reveal messages one at a time with a short "typing..." pause in front of
  // each one, so the AI moderator's own messages feel like they're actually
  // being typed out rather than dumped onto the screen all at once. Messages
  // from real members (transcript/system) don't need this -- they already
  // happened live -- so only "intro" and "intervention" messages get the
  // pause; everything else reveals immediately.
  const [revealedIds, setRevealedIds] = useState<Set<number>>(new Set());
  const [typingMessageId, setTypingMessageId] = useState<number | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    };
  }, []);
  useEffect(() => {
    if (revealTimerRef.current) return; // a reveal is already in flight
    const next = messages.find((m) => !revealedIds.has(m.id) && m.id !== typingMessageId);
    if (!next) return;
    const delay = next.type === "intro" || next.type === "intervention" ? 1100 : 0;
    setTypingMessageId(next.id);
    revealTimerRef.current = setTimeout(() => {
      setRevealedIds((prev) => new Set(prev).add(next.id));
      setTypingMessageId(null);
      revealTimerRef.current = null;
    }, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, revealedIds]);
  const visibleMessages = messages.filter((m) => revealedIds.has(m.id));
  const isTyping = typingMessageId !== null;

  // Live "X is speaking" bubbles -- one per member who is either above the
  // ambient volume threshold or has an in-flight live caption (captions can
  // arrive a beat after volume crosses the threshold, and should keep the
  // bubble alive through brief pauses mid-sentence). This is what makes the
  // panel feel instant: real transcription can lag a couple of seconds
  // behind actual speech, but the "someone is talking" signal -- and, where
  // supported, their actual words -- show up immediately.
  const speakingMembers = members.filter(
    (m) => (speakerVolumes.get(m.userId)?.level ?? 0) >= SPEAKING_LEVEL_THRESHOLD || liveCaptions.has(m.userId),
  );

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visibleMessages.length, isTyping, speakingMembers.length]);

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
        {visibleMessages.length === 0 && !isTyping && (
          <p className="text-xs text-muted-foreground text-center mt-6">
            The AI moderator's messages will appear here once the shared workspace is open.
          </p>
        )}
        {visibleMessages.map((message) => (
          <ChatMessageBubble key={message.id} message={message} />
        ))}
        {isTyping && <TypingIndicatorBubble />}
        {speakingMembers.map((m) => (
          <SpeakingIndicatorBubble
            key={m.userId}
            username={m.username}
            colorSlot={m.colorSlot}
            caption={liveCaptions.get(m.userId)?.text ?? ""}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t shrink-0 p-3 flex flex-col gap-2">
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
          <span className="flex-1 text-xs font-medium text-muted-foreground">Microphone</span>
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

function TypingIndicatorBubble() {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        <Sparkles className="w-3 h-3 text-muted-foreground" />
        AI moderator
      </div>
      <div className="rounded-xl rounded-tl-sm px-3 py-2.5 bg-muted w-fit flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.3s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.15s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce" />
      </div>
    </div>
  );
}

function SpeakingBars({ color }: { color: string }) {
  return (
    <span className="flex items-end gap-0.5 h-3 shrink-0">
      <span
        className="w-1 rounded-full animate-[speaking-bar_0.9s_ease-in-out_infinite]"
        style={{ backgroundColor: color, height: "40%", animationDelay: "0s" }}
      />
      <span
        className="w-1 rounded-full animate-[speaking-bar_0.9s_ease-in-out_infinite]"
        style={{ backgroundColor: color, height: "100%", animationDelay: "0.15s" }}
      />
      <span
        className="w-1 rounded-full animate-[speaking-bar_0.9s_ease-in-out_infinite]"
        style={{ backgroundColor: color, height: "60%", animationDelay: "0.3s" }}
      />
    </span>
  );
}

// The live, real-time caption bubble -- a Teams-style "closed caption" of
// what a member is saying as they say it, sourced from the browser's own
// speech recognizer (see useModeratorAudio's onCaption). Where the browser
// doesn't support live speech recognition, this falls back to just the
// animated "speaking..." bars so there's still an immediate signal that
// someone is talking, even without their words.
function SpeakingIndicatorBubble({
  username,
  colorSlot,
  caption,
}: {
  username: string;
  colorSlot: number;
  caption: string;
}) {
  const color = colorForSlot(colorSlot);
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-semibold" style={{ color: color.solid }}>
        {username}
      </div>
      <div
        className="rounded-xl rounded-tl-sm px-3 py-2.5 w-fit max-w-full flex items-center gap-2"
        style={{ backgroundColor: color.soft }}
      >
        <SpeakingBars color={color.solid} />
        {caption ? (
          <span className="text-xs leading-relaxed" style={{ color: color.softText }}>
            {caption}
          </span>
        ) : (
          <span className="text-[11px] font-medium" style={{ color: color.softText }}>
            speaking...
          </span>
        )}
      </div>
    </div>
  );
}

function ChatMessageBubble({ message }: { message: ModeratorChatMessage }) {
  // Intro / mic on-off announcements / stalled-discussion interventions are
  // all things the AI moderator itself is saying -- same title, icon, and
  // color regardless of which member the announcement is about.
  if (message.type === "intro" || message.type === "system" || message.type === "intervention") {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <Sparkles className="w-3 h-3 text-primary" />
          {message.type === "intervention" && message.matched && message.className && message.propertyName
            ? `${message.className}.${message.propertyName}`
            : "AI moderator"}
        </div>
        <div className="rounded-xl rounded-tl-sm px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap bg-primary/10 text-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  // transcript -- styled entirely in the speaker's own workspace color, so
  // it's immediately clear who said what without re-reading the name.
  const color = colorForSlot(message.colorSlot ?? 0);
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-semibold" style={{ color: color.solid }}>
        {message.username ?? "unknown"}
      </div>
      <div
        className="rounded-xl rounded-tl-sm px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap"
        style={{ backgroundColor: color.soft, color: color.softText }}
      >
        {message.content}
      </div>
    </div>
  );
}
