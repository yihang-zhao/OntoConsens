import { useEffect, useMemo, useRef, useState } from "react";
import {
  useConfigureModerator,
  useDisableModerator,
  useListModeratorChatMessages,
  useSubmitModeratorTranscript,
  getGetModeratorStatusQueryKey,
  getListModeratorChatMessagesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sparkles, AlertTriangle, X, Mic, MicOff, Languages, ArrowDown } from "lucide-react";
import { useModeratorAudio } from "@/hooks/useModeratorAudio";
import { colorForSlot } from "@/lib/memberColors";
import type { LiveCaption, ModeratorChatMessage, SpeakerVolume } from "@/hooks/useProjectSocket";

// Languages the live transcript can recognize -- each member picks their own
// independently of everyone else's, since the mic and recognizer are
// per-browser. BCP-47 tags are passed straight to the Web Speech API.
const RECOGNITION_LANGUAGES: { value: string; label: string }[] = [
  { value: "en-US", label: "English" },
  { value: "zh-CN", label: "中文" },
  { value: "es-ES", label: "Español" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "hi-IN", label: "हिन्दी" },
  { value: "pt-BR", label: "Português" },
  { value: "ru-RU", label: "Русский" },
];
const RECOGNITION_LANG_STORAGE_KEY = "onto-consensus-moderator-lang";
// One flag per project, per browser -- flips to "seen" the first time this
// member's panel finishes loading history for that project. Lets the intro
// bullets (which are already sitting in "history" by the time the panel
// mounts, since they're posted synchronously when the shared space opens)
// still play through the one-message-at-a-time typing effect on that very
// first load, instead of being dumped onto the screen all at once the way
// ordinary history replay works.
const introSeenStorageKey = (projectId: number) => `onto-consensus-moderator-intro-seen-${projectId}`;

// Defaults to whichever of the supported languages best matches the
// browser's own language setting, falling back to English -- most users
// never need to touch the picker at all.
function defaultRecognitionLang(): string {
  const stored = localStorage.getItem(RECOGNITION_LANG_STORAGE_KEY);
  if (stored && RECOGNITION_LANGUAGES.some((l) => l.value === stored)) return stored;
  const browserLang = (navigator.language || "en-US").toLowerCase();
  const match = RECOGNITION_LANGUAGES.find((l) => l.value.toLowerCase() === browserLang);
  if (match) return match.value;
  const prefixMatch = RECOGNITION_LANGUAGES.find((l) => l.value.toLowerCase().split("-")[0] === browserLang.split("-")[0]);
  return prefixMatch?.value ?? "en-US";
}

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
  const submitTranscript = useSubmitModeratorTranscript();

  const { data: history } = useListModeratorChatMessages(projectId, {
    query: { queryKey: getListModeratorChatMessagesQueryKey(projectId) },
  });

  const messages = useMemo(
    () => mergeMessages((history?.messages as ModeratorChatMessage[] | undefined) ?? [], liveMessages),
    [history, liveMessages],
  );

  const invalidateStatus = () =>
    queryClient.invalidateQueries({ queryKey: getGetModeratorStatusQueryKey(projectId) });

  // Which language THIS member's mic is recognized in -- purely a local,
  // per-browser choice (each member can speak a different language), so it
  // lives in localStorage rather than anywhere shared/synced.
  const [recognitionLang, setRecognitionLang] = useState(defaultRecognitionLang);
  const handleLangChange = (value: string) => {
    setRecognitionLang(value);
    localStorage.setItem(RECOGNITION_LANG_STORAGE_KEY, value);
  };

  // Turning the moderator on for yourself is the same click that starts
  // capturing your mic. The browser's own permission prompt is the only
  // thing the user sees the first time; if they've already granted it, the
  // mic just opens.
  const { micError, speechSupported, flush } = useModeratorAudio({
    projectId,
    active: moderatorActive,
    lang: recognitionLang,
    onVolume,
    // Live, word-by-word text as it's recognized -- this IS the transcript
    // now, broadcast to everyone (including the speaker) so one growing
    // message box is visible in real time while they keep talking. Nothing
    // else touches this bubble's content.
    onCaption: sendCaption,
    // Fires once per utterance, 2 seconds after the last recognized word (or
    // immediately if the mic is turned off mid-utterance) -- this is the
    // only point where a permanent chat message gets created, so continuous
    // talking never fragments into several boxes.
    onFinalize: (text) => {
      // Deliberately NOT clearing the caption here. Clearing it immediately
      // sends an empty caption over the socket and waits on its own
      // round trip to come back before the box disappears -- an entirely
      // separate race against the submitTranscript round trip below, and
      // whichever one lands first, there's a real gap between the box
      // vanishing and the permanent message appearing (or, the other way
      // around, a moment where both are visible at once). Either way it
      // reads as a flash/flicker even though the two round trips carry the
      // exact same text. Leaving the box showing its already-finalized text
      // makes the swap invisible: the effect below clears it in the exact
      // same tick the real message lands, never before and never after.
      submitTranscript.mutate({ id: projectId, data: { text } });
    },
  });

  // The instant a real transcript message lands, drop its speaker's interim
  // caption -- this is the ONLY place the interim box for a finalized
  // utterance gets cleared, so it can never disappear before, or linger
  // after, the permanent message it's standing in for actually shows up.
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
      // Pull out whatever's mid-utterance (if anything) and wait for its
      // submission to settle BEFORE deactivating this member server-side.
      // Deactivating first (the old order) would often win the race: the
      // disable request reaches the server, flips this member inactive,
      // and only *then* does turning the mic off trigger the audio hook's
      // own flush -- whose transcript submission the server now rejects as
      // coming from an inactive participant, silently dropping whatever
      // was said right before the mic closed. Sequencing it this way (via
      // onSettled, so a failed submission still lets disable proceed)
      // guarantees the transcript is fully accepted or rejected before the
      // deactivation request is even sent.
      const pendingText = flush();
      const proceedToDisable = () => disable.mutate({ id: projectId }, { onSuccess: invalidateStatus });
      if (pendingText) {
        submitTranscript.mutate({ id: projectId, data: { text: pendingText } }, { onSettled: proceedToDisable });
      } else {
        proceedToDisable();
      }
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
  //
  // This ONLY applies to messages that arrive live while the panel is open.
  // Reopening the shared space and re-fetching history that already
  // happened should never replay that history through the typing animation
  // one bubble at a time -- it should all just be there already, scrolled
  // straight to the bottom, the moment history loads.
  const [revealedIds, setRevealedIds] = useState<Set<number>>(new Set());
  const [typingMessageId, setTypingMessageId] = useState<number | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyLoadedRef = useRef(false);
  const [historyReady, setHistoryReady] = useState(false);
  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    };
  }, []);
  // The moment the persisted history first arrives, mark everything in it
  // (plus anything already queued from the live socket by that point) as
  // already revealed -- instantly, no per-message delay -- so a reopened
  // shared space shows its whole backlog at once.
  useEffect(() => {
    if (historyLoadedRef.current || !history) return;
    historyLoadedRef.current = true;
    const introAlreadySeen = localStorage.getItem(introSeenStorageKey(projectId)) === "1";
    setRevealedIds((prev) => {
      const next = new Set(prev);
      for (const m of messages) {
        // The very first time this member's browser ever loads this
        // project's history, leave "intro" messages out of the instant
        // bulk-reveal -- the per-message effect below will then pick them
        // up one at a time through the normal typing-pause path, exactly
        // as if the moderator were live-typing them right now. Every
        // subsequent load (or any message type besides "intro") reveals
        // instantly as before.
        if (!introAlreadySeen && m.type === "intro") continue;
        next.add(m.id);
      }
      return next;
    });
    if (!introAlreadySeen) localStorage.setItem(introSeenStorageKey(projectId), "1");
    setHistoryReady(true);
  }, [history, messages, projectId]);
  useEffect(() => {
    if (!historyLoadedRef.current) return; // wait for the instant initial reveal above
    if (revealTimerRef.current) return; // a reveal is already in flight
    const next = messages.find((m) => !revealedIds.has(m.id) && m.id !== typingMessageId);
    if (!next) return;
    // Transcript/system messages reveal in the very same render, with no
    // timer at all -- they already just sat there fully visible as a live
    // caption bubble a moment ago (or, for system messages, never needed a
    // typing pause to begin with). Routing them through even a 0ms
    // setTimeout meant one extra paint where the just-arrived message was
    // hidden and the bouncing-dots "typing" placeholder showed in its place
    // for a single frame -- a jarring flash right as a box finalizes, with
    // no location change to justify it. Only the moderator's own "intro"
    // and "intervention" messages -- which are genuinely new, not something
    // the group already watched happen live -- get the typing-pause effect.
    if (next.type === "intro" || next.type === "intervention") {
      setTypingMessageId(next.id);
      revealTimerRef.current = setTimeout(() => {
        setRevealedIds((prev) => new Set(prev).add(next.id));
        setTypingMessageId(null);
        revealTimerRef.current = null;
      }, 1100);
    } else {
      setRevealedIds((prev) => new Set(prev).add(next.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, revealedIds]);
  const visibleMessages = messages.filter((m) => revealedIds.has(m.id));
  const isTyping = typingMessageId !== null;

  // One in-progress bubble per member who currently has actual recognized
  // text coming in -- nothing else. No separate "someone is speaking"
  // indicator, animation, or volume-based trigger; the bubble exists purely
  // to hold the live transcript text as it's captured.
  const speakingMembers = members.filter((m) => !!liveCaptions.get(m.userId)?.text);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Whether the user is currently parked near the bottom of the panel. Kept
  // as a ref (not just state) so the content-driven scroll effect below can
  // read the latest value without re-running every time it changes --  it
  // should only fire on new content, never merely because the user scrolled.
  const isNearBottomRef = useRef(true);
  const [showNewMessagePill, setShowNewMessagePill] = useState(false);
  const NEAR_BOTTOM_THRESHOLD_PX = 80;
  const handlePanelScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < NEAR_BOTTOM_THRESHOLD_PX;
    isNearBottomRef.current = nearBottom;
    if (nearBottom) setShowNewMessagePill(false);
  };
  const scrollToBottom = (behavior: ScrollBehavior) => {
    messagesEndRef.current?.scrollIntoView({ behavior });
    isNearBottomRef.current = true;
    setShowNewMessagePill(false);
  };
  // The initial backlog jumps straight to the bottom instantly -- it's not
  // new activity, so an animated scroll through everything that already
  // happened would feel like a slow replay instead of just reopening the
  // panel where it left off. Only messages/activity from here on scroll in
  // smoothly.
  useEffect(() => {
    if (!historyReady) return;
    scrollToBottom("auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyReady]);
  // Live caption text itself -- not just a box appearing/disappearing --
  // has to be a scroll trigger too. Without it, a box that grows past one
  // line while someone keeps talking silently overflows the bottom of the
  // panel (the scroll position never moves while it's just this box getting
  // taller), and then the eventual finalize-triggered scroll has to jump
  // several lines at once, which reads as a sudden change of location. Once
  // this keeps the box's growth followed smoothly line by line, finalizing
  // it into a permanent message doesn't change the panel's total height and
  // this same effect is a no-op then -- no extra jump at the end.
  //
  // But only while the user is already parked near the bottom -- someone
  // scrolled up to reread earlier messages should never get yanked back
  // down by new content; they instead get a "new messages" pill they can
  // tap once they're ready to catch up.
  const liveCaptionsKey = speakingMembers.map((m) => `${m.userId}:${liveCaptions.get(m.userId)?.text ?? ""}`).join("|");
  useEffect(() => {
    if (!historyReady) return;
    if (isNearBottomRef.current) {
      scrollToBottom("smooth");
    } else {
      setShowNewMessagePill(true);
    }
  }, [historyReady, visibleMessages.length, isTyping, speakingMembers.length, liveCaptionsKey]);

  return (
    <aside className="w-[28vw] min-w-[22rem] shrink-0 h-full flex flex-col border rounded-2xl shadow-sm bg-card overflow-hidden">
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

      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollContainerRef}
          onScroll={handlePanelScroll}
          className="h-full overflow-y-auto px-3 py-3 flex flex-col gap-3"
        >
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
            <LiveTranscriptBubble
              key={m.userId}
              username={m.username}
              colorSlot={m.colorSlot}
              caption={liveCaptions.get(m.userId)?.text ?? ""}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>
        {showNewMessagePill && (
          <button
            onClick={() => scrollToBottom("smooth")}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 bg-primary text-primary-foreground text-xs font-medium pl-3 pr-3.5 py-1.5 rounded-full shadow-md hover:opacity-90 transition-opacity"
          >
            <ArrowDown className="w-3.5 h-3.5" />
            New messages
          </button>
        )}
      </div>

      <div className="border-t shrink-0 p-3 flex flex-col gap-2">
        {moderatorActive && !speechSupported && (
          <p className="text-[11px] font-medium text-muted-foreground bg-muted/50 border rounded-lg px-2.5 py-1.5">
            Live transcription needs Chrome or Edge -- your mic is on, but your speech can't be turned into text in
            this browser.
          </p>
        )}
        {configure.isError && !moderatorActive && (
          <p className="text-[11px] font-medium text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-2.5 py-1.5">
            {(configure.error as any)?.data?.error || "Could not turn on the AI moderator."}
          </p>
        )}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 bg-muted/50 border rounded-full pl-3 pr-2.5 py-2 flex-1 min-w-0">
            {moderatorActive ? (
              <Mic className="w-4 h-4 text-primary shrink-0" />
            ) : (
              <MicOff className="w-4 h-4 text-muted-foreground shrink-0" />
            )}
            <span className="flex-1 text-xs font-medium text-muted-foreground truncate">Microphone</span>
            <Switch
              checked={moderatorActive}
              onCheckedChange={handleToggleClick}
              disabled={disable.isPending || configure.isPending || (!moderatorActive && !moderatorConfigured)}
            />
          </div>
          {speechSupported && (
            <Select value={recognitionLang} onValueChange={handleLangChange}>
              <SelectTrigger className="h-9 w-1/3 shrink-0 rounded-full bg-muted/50 border text-xs pl-3">
                <Languages className="w-3.5 h-3.5 text-muted-foreground mr-1.5 shrink-0" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECOGNITION_LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value} className="text-xs">
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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

// The in-progress message box for whoever is currently talking -- styled
// identically to a real, persisted ChatMessageBubble (same colors, same
// shape) so the transition from "still talking" to "said it" is seamless,
// with a blinking cursor as the one visual cue that it's still live. This
// growing text IS what becomes the permanent transcript message once
// silence finalizes it (see useModeratorAudio's onFinalize) -- it is never
// replaced by a separately-transcribed version. It only exists once there
// is actual recognized text to show -- no separate "someone is speaking"
// indicator or animation of any kind.
function LiveTranscriptBubble({
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
      {/* Same container classes/box model as ChatMessageBubble's transcript
          case below -- no w-fit, no flex row -- so finalizing this into a
          real message swaps text content only, with the box never resizing
          or re-laying-out at the transition point. The blinking cursor is
          just one more inline character at the end of the text, not a
          layout-affecting flex child. */}
      <div
        className="rounded-xl rounded-tl-sm px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap"
        style={{ backgroundColor: color.soft, color: color.softText }}
      >
        {caption}
        <span
          className="inline-block w-[2px] h-3 ml-0.5 align-middle animate-pulse"
          style={{ backgroundColor: color.softText }}
        />
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
          AI moderator
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
