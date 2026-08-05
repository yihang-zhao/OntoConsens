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

export function useProjectSocket({
  projectId,
  enabled,
  onProjectChanged,
  onPropertiesChanged,
}: UseProjectSocketOptions) {
  const createTicket = useCreateWsTicket();
  const socketRef = useRef<WebSocket | null>(null);
  const [cursors, setCursors] = useState<Map<number, RemoteCursor>>(new Map());
  const callbacksRef = useRef({ onProjectChanged, onPropertiesChanged });
  callbacksRef.current = { onProjectChanged, onPropertiesChanged };

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let socket: WebSocket | null = null;

    async function connect() {
      const { ticket } = await createTicket.mutateAsync({ id: projectId });
      if (cancelled) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws?ticket=${ticket}`);
      socketRef.current = socket;

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
          case "property_created":
          case "property_updated":
          case "property_deleted":
          case "agreement_changed":
            callbacksRef.current.onPropertiesChanged?.();
            break;
          case "member_joined":
          case "member_ready":
            callbacksRef.current.onProjectChanged?.();
            break;
        }
      });
    }

    connect();

    return () => {
      cancelled = true;
      socket?.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, enabled]);

  const sendCursor = useCallback((x: number, y: number) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "cursor", x, y }));
    }
  }, []);

  return { cursors, sendCursor };
}
