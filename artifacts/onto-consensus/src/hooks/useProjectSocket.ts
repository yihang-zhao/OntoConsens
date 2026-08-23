import { useCallback, useEffect, useRef, useState } from "react";
import { useCreateWsTicket } from "@workspace/api-client-react";

export interface RemoteCursor {
  userId: number;
  x: number;
  y: number;
  updatedAt: number;
}

export interface SpeakerVolume {
  userId: number;
  level: number;
  updatedAt: number;
}

// One point raised for/against a property, plus everyone who made it --
// mirrors ModeratorInterventionEntry in the OpenAPI schema.
export interface ModeratorInterventionEntry {
  text: string;
  by: string[];
}

// One entry in the persistent moderator chat log -- mirrors
// SerializedChatMessage on the server (see moderatorEngine.ts) and the
// ModeratorChatMessage OpenAPI schema, so a live-broadcast message and one
// fetched from GET /projects/:id/moderator/messages render identically.
export interface ModeratorChatMessage {
  id: number;
  type: "intro" | "system" | "transcript" | "intervention";
  userId: number | null;
  username: string | null;
  colorSlot: number | null;
  content: string;
  matched: boolean | null;
  className: string | null;
  propertyName: string | null;
  classId: number | null;
  propertyId: number | null;
  examples: ModeratorInterventionEntry[] | null;
  counterexamples: ModeratorInterventionEntry[] | null;
  createdAt: string;
}

type ServerEvent =
  | { type: "cursor"; userId: number; x: number; y: number }
  | { type: "cursor_left"; userId: number }
  | { type: "presence"; userIds: number[] }
  | { type: "property_created" }
  | { type: "property_updated" }
  | { type: "property_deleted" }
  | { type: "agreement_changed" }
  | { type: "member_joined" }
  | { type: "member_ready" }
  | { type: "project_deleted" }
  | { type: "speaker_volume"; userId: number; level: number }
  | { type: "live_caption"; userId: number; text: string }
  | { type: "moderator_chat_message"; message: ModeratorChatMessage }
  | { type: "moderator_error"; message: string };

export interface LiveCaption {
  userId: number;
  text: string;
  updatedAt: number;
}

interface UseProjectSocketOptions {
  projectId: number;
  enabled: boolean;
  // This member's own selected display language (BCP-47, e.g. "es-ES") --
  // sent to the server as a "set_language" message so LIVE
  // "moderator_chat_message" intervention broadcasts arrive already
  // translated for them (see wsHub.ts/moderatorEngine.ts). Purely
  // per-connection state on the server; changing it takes effect
  // immediately without a reconnect.
  lang: string;
  onProjectChanged?: () => void;
  onPropertiesChanged?: () => void;
  onProjectDeleted?: () => void;
  onModeratorChatMessage?: (message: ModeratorChatMessage) => void;
  onModeratorError?: (message: string) => void;
}

// Speaker volume readings older than this are dropped even if no new
// message arrives to trigger a re-render — e.g. someone's tab crashed
// mid-sentence and no further "speaking stopped" signal ever comes in.
const SPEAKER_VOLUME_TTL_MS = 1_200;
const SPEAKER_VOLUME_PRUNE_INTERVAL_MS = 500;

// A live caption is cleared this long after its last update -- but only as
// a last-resort cleanup for a truly abandoned utterance (e.g. a tab crashed
// mid-sentence and no finalize/clear ever arrives). It must stay well above
// SILENCE_FINALIZE_MS (2s): once that fires, the box's last update stops
// advancing while the finalized text makes its full round trip to the
// server and back as a permanent message -- if this TTL were close to that
// 2s window, a slow round trip could prune the box (making it vanish) just
// before the real message arrives (making it reappear), a visible
// disappear-then-reappear flash. The gap here needs to comfortably outlast
// that whole round trip, not just the silence window that triggers it.
const LIVE_CAPTION_TTL_MS = 12_000;
const LIVE_CAPTION_PRUNE_INTERVAL_MS = 500;

// Cursors older than this are considered stale and pruned even if no new
// socket message ever arrives to trigger a re-render.
const CURSOR_TTL_MS = 8_000;
const CURSOR_PRUNE_INTERVAL_MS = 2_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 10_000;
// After this many failed reconnect attempts in a row, surface "disconnected"
// instead of "reconnecting" — a couple of quick retries look like a blip, but
// a long streak of failures means the user should know sync has actually
// stopped, not just briefly stuttered.
const DISCONNECTED_AFTER_ATTEMPTS = 3;

export type SocketStatus = "connected" | "reconnecting" | "disconnected";

export function useProjectSocket({
  projectId,
  enabled,
  lang,
  onProjectChanged,
  onPropertiesChanged,
  onProjectDeleted,
  onModeratorChatMessage,
  onModeratorError,
}: UseProjectSocketOptions) {
  const createTicket = useCreateWsTicket();
  const socketRef = useRef<WebSocket | null>(null);
  // Always read from a ref (not the `lang` closure variable) inside the
  // connect effect below, so a language change mid-session doesn't need to
  // tear down and reopen the whole socket -- it's just a new message sent
  // over the existing connection.
  const langRef = useRef(lang);
  langRef.current = lang;
  const [cursors, setCursors] = useState<Map<number, RemoteCursor>>(new Map());
  const [status, setStatus] = useState<SocketStatus>("reconnecting");
  const [onlineUserIds, setOnlineUserIds] = useState<Set<number>>(new Set());
  const [speakerVolumes, setSpeakerVolumes] = useState<Map<number, SpeakerVolume>>(new Map());
  const [liveCaptions, setLiveCaptions] = useState<Map<number, LiveCaption>>(new Map());
  const callbacksRef = useRef({
    onProjectChanged,
    onPropertiesChanged,
    onProjectDeleted,
    onModeratorChatMessage,
    onModeratorError,
  });
  callbacksRef.current = {
    onProjectChanged,
    onPropertiesChanged,
    onProjectDeleted,
    onModeratorChatMessage,
    onModeratorError,
  };

  useEffect(() => {
    if (!enabled) {
      setCursors(new Map());
      setStatus("reconnecting");
      setOnlineUserIds(new Set());
      setSpeakerVolumes(new Map());
      setLiveCaptions(new Map());
      return;
    }

    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;

    function scheduleReconnect() {
      if (stopped) return;
      setStatus(reconnectAttempt >= DISCONNECTED_AFTER_ATTEMPTS ? "disconnected" : "reconnecting");
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
        RECONNECT_MAX_DELAY_MS,
      );
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    }

    async function connect() {
      if (stopped) return;
      let ticket: string;
      try {
        ticket = (await createTicket.mutateAsync({ id: projectId })).ticket;
      } catch {
        // Fetching a ticket failed (e.g. transient network issue) — keep
        // retrying with backoff instead of leaving the user permanently
        // disconnected until they refresh the page.
        scheduleReconnect();
        return;
      }
      if (stopped) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws?ticket=${ticket}`);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (stopped) return;
        reconnectAttempt = 0;
        setStatus("connected");
        // Announce this member's currently-selected display language right
        // away, so any live intervention broadcast from this point on
        // arrives already translated for them -- a fresh connection
        // otherwise defaults to English server-side.
        socket?.send(JSON.stringify({ type: "set_language", lang: langRef.current }));
        // Reconnecting after a drop means we may have missed events while
        // offline (a new member joined, someone marked ready, a property
        // changed) — catch up immediately rather than waiting for the next
        // live event, since a missed broadcast would otherwise go unnoticed
        // until something else happens to trigger a refetch.
        callbacksRef.current.onProjectChanged?.();
        callbacksRef.current.onPropertiesChanged?.();
      });

      socket.addEventListener("message", (event) => {
        let data: ServerEvent;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        switch (data.type) {
          case "cursor":
            setCursors((prev) => {
              const next = new Map(prev);
              next.set(data.userId, { userId: data.userId, x: data.x, y: data.y, updatedAt: Date.now() });
              return next;
            });
            break;
          case "cursor_left":
            setCursors((prev) => {
              if (!prev.has(data.userId)) return prev;
              const next = new Map(prev);
              next.delete(data.userId);
              return next;
            });
            break;
          case "presence":
            setOnlineUserIds(new Set(data.userIds));
            break;
          case "property_created":
          case "property_updated":
          case "property_deleted":
          case "agreement_changed":
            callbacksRef.current.onPropertiesChanged?.();
            break;
          case "member_joined":
          case "member_ready":
            // Membership/readiness changes can flip who is allowed to see
            // which properties (the shared space only opens once everyone is
            // ready), so both queries need to refresh together — refreshing
            // only the project would leave the properties list stale until
            // some unrelated property edit happened to trigger it.
            callbacksRef.current.onProjectChanged?.();
            callbacksRef.current.onPropertiesChanged?.();
            break;
          case "project_deleted":
            callbacksRef.current.onProjectDeleted?.();
            break;
          case "speaker_volume":
            setSpeakerVolumes((prev) => {
              const next = new Map(prev);
              next.set(data.userId, { userId: data.userId, level: data.level, updatedAt: Date.now() });
              return next;
            });
            break;
          case "live_caption":
            setLiveCaptions((prev) => {
              const next = new Map(prev);
              next.set(data.userId, { userId: data.userId, text: data.text, updatedAt: Date.now() });
              return next;
            });
            break;
          case "moderator_chat_message":
            callbacksRef.current.onModeratorChatMessage?.(data.message);
            break;
          case "moderator_error":
            callbacksRef.current.onModeratorError?.(data.message);
            break;
        }
      });

      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (!stopped) scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        socket?.close();
      });
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, enabled]);

  // A cursor's owner may have gone idle, closed their tab without a clean
  // close event reaching us yet, or lost connectivity — prune anything stale
  // on a timer so it disappears on its own instead of only when some other
  // cursor message happens to trigger a re-render.
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      setCursors((prev) => {
        const cutoff = Date.now() - CURSOR_TTL_MS;
        let changed = false;
        const next = new Map(prev);
        for (const [userId, cursor] of prev) {
          if (cursor.updatedAt < cutoff) {
            next.delete(userId);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, CURSOR_PRUNE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  // Mirrors the cursor-pruning effect above: a speaker's tab can vanish
  // mid-word (crash, lost connectivity) with no final "stopped speaking"
  // message ever arriving, so the pulsing border needs its own timeout
  // rather than waiting on the next volume update to clear it.
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      setSpeakerVolumes((prev) => {
        const cutoff = Date.now() - SPEAKER_VOLUME_TTL_MS;
        let changed = false;
        const next = new Map(prev);
        for (const [userId, volume] of prev) {
          if (volume.updatedAt < cutoff) {
            next.delete(userId);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, SPEAKER_VOLUME_PRUNE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  // A live caption with no update in a while means the speaker either
  // finished their sentence and the recognizer went quiet, or their tab
  // disappeared mid-word -- either way it should fade rather than linger
  // forever waiting for an utterance that may never resume.
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      setLiveCaptions((prev) => {
        const cutoff = Date.now() - LIVE_CAPTION_TTL_MS;
        let changed = false;
        const next = new Map(prev);
        for (const [userId, caption] of prev) {
          if (caption.updatedAt < cutoff) {
            next.delete(userId);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, LIVE_CAPTION_PRUNE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  // Re-announces the language whenever it changes while already connected
  // (e.g. the member switches the dropdown mid-session) -- langRef alone
  // only covers the initial "open" announcement or a later reconnect.
  useEffect(() => {
    if (!enabled) return;
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "set_language", lang }));
    }
  }, [lang, enabled]);

  const sendCursor = useCallback((x: number, y: number) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "cursor", x, y }));
    }
  }, []);

  const sendVolume = useCallback((level: number) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "volume", level }));
    }
  }, []);

  const sendCaption = useCallback((text: string) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "caption", text }));
    }
  }, []);

  // Clears this user's own live caption immediately once their real,
  // persisted transcript message shows up in the chat -- otherwise the
  // interim caption bubble can briefly linger under/above the final message
  // until its own TTL expires.
  const clearLiveCaption = useCallback((userId: number) => {
    setLiveCaptions((prev) => {
      if (!prev.has(userId)) return prev;
      const next = new Map(prev);
      next.delete(userId);
      return next;
    });
  }, []);

  return {
    cursors,
    sendCursor,
    status,
    onlineUserIds,
    speakerVolumes,
    sendVolume,
    liveCaptions,
    sendCaption,
    clearLiveCaption,
  };
}
