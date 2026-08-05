import { useCallback, useEffect, useRef, useState } from "react";
import { useCreateWsTicket } from "@workspace/api-client-react";

export interface RemoteCursor {
  userId: number;
  x: number;
  y: number;
  updatedAt: number;
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
  | { type: "member_ready" };

interface UseProjectSocketOptions {
  projectId: number;
  enabled: boolean;
  onProjectChanged?: () => void;
  onPropertiesChanged?: () => void;
}

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
  onProjectChanged,
  onPropertiesChanged,
}: UseProjectSocketOptions) {
  const createTicket = useCreateWsTicket();
  const socketRef = useRef<WebSocket | null>(null);
  const [cursors, setCursors] = useState<Map<number, RemoteCursor>>(new Map());
  const [status, setStatus] = useState<SocketStatus>("reconnecting");
  const [onlineUserIds, setOnlineUserIds] = useState<Set<number>>(new Set());
  const callbacksRef = useRef({ onProjectChanged, onPropertiesChanged });
  callbacksRef.current = { onProjectChanged, onPropertiesChanged };

  useEffect(() => {
    if (!enabled) {
      setCursors(new Map());
      setStatus("reconnecting");
      setOnlineUserIds(new Set());
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

  const sendCursor = useCallback((x: number, y: number) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "cursor", x, y }));
    }
  }, []);

  return { cursors, sendCursor, status, onlineUserIds };
}
