import type { IncomingMessage } from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

interface Ticket {
  userId: number;
  // Absent for a user-scoped (dashboard) connection, which isn't tied to
  // any single project — see issueUserTicket.
  projectId?: number;
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();
const TICKET_TTL_MS = 30_000;

export function issueTicket(userId: number, projectId: number): string {
  const ticket = crypto.randomBytes(24).toString("hex");
  tickets.set(ticket, { userId, projectId, expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

// Lets a client connect without picking a specific project — used by the
// dashboard so it can learn the instant one of the user's projects is
// deleted by someone else, instead of waiting on the next background poll.
export function issueUserTicket(userId: number): string {
  const ticket = crypto.randomBytes(24).toString("hex");
  tickets.set(ticket, { userId, expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

function consumeTicket(ticket: string | null): Ticket | undefined {
  if (!ticket) return undefined;
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry;
}

interface ClientInfo {
  userId: number;
  // Absent for a dashboard (user-scoped) connection.
  projectId?: number;
  isAlive: boolean;
}

const clients = new Map<WebSocket, ClientInfo>();

export type ServerEvent =
  | { type: "cursor"; userId: number; x: number; y: number }
  | { type: "cursor_left"; userId: number }
  | { type: "presence"; userIds: number[] }
  | { type: "property_created" }
  | { type: "property_updated" }
  | { type: "property_deleted" }
  | { type: "agreement_changed" }
  | { type: "member_joined" }
  | { type: "member_ready" }
  | { type: "project_deleted"; projectId?: number }
  | { type: "member_count_changed"; projectId: number; memberCount: number };

function onlineUserIds(projectId: number): number[] {
  const ids = new Set<number>();
  for (const info of clients.values()) {
    if (info.projectId === projectId) ids.add(info.userId);
  }
  return Array.from(ids);
}

function broadcastPresence(projectId: number) {
  broadcastToProject(projectId, { type: "presence", userIds: onlineUserIds(projectId) });
}

export function broadcastToProject(
  projectId: number,
  event: ServerEvent,
  exclude?: WebSocket,
) {
  const payload = JSON.stringify(event);
  for (const [socket, info] of clients) {
    if (info.projectId === projectId && socket !== exclude && socket.readyState === socket.OPEN) {
      socket.send(payload);
    }
  }
}

// Pushes an event straight to specific users' dashboard connections,
// regardless of which project (if any) they're currently viewing. Used so a
// project's other members see it disappear from their project list the
// instant it's deleted, instead of waiting for the next background poll.
export function broadcastToUsers(userIds: number[], event: ServerEvent) {
  if (userIds.length === 0) return;
  const targets = new Set(userIds);
  const payload = JSON.stringify(event);
  for (const [socket, info] of clients) {
    if (
      info.projectId === undefined &&
      targets.has(info.userId) &&
      socket.readyState === socket.OPEN
    ) {
      socket.send(payload);
    }
  }
}

const HEARTBEAT_INTERVAL_MS = 20_000;

export function setupWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  function leaveProject(socket: WebSocket) {
    const info = clients.get(socket);
    if (!info) return;
    clients.delete(socket);
    if (info.projectId === undefined) return; // dashboard connection, nothing to broadcast
    // Let everyone still in the project know this cursor is gone immediately,
    // instead of leaving a stale cursor on screen until it times out client-side.
    broadcastToProject(info.projectId, { type: "cursor_left", userId: info.userId });
    broadcastPresence(info.projectId);
  }

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? "", "http://localhost");
    const ticket = consumeTicket(url.searchParams.get("ticket"));

    if (!ticket) {
      socket.close(4001, "Invalid or expired ticket");
      return;
    }

    clients.set(socket, { userId: ticket.userId, projectId: ticket.projectId, isAlive: true });
    if (ticket.projectId !== undefined) {
      // Tell everyone (including this new connection) who's currently online,
      // so avatar "in this project now" rings update live with no refresh.
      broadcastPresence(ticket.projectId);
    }

    socket.on("pong", () => {
      const info = clients.get(socket);
      if (info) info.isAlive = true;
    });

    socket.on("message", (raw) => {
      if (ticket.projectId === undefined) return; // dashboard connections don't send anything
      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (
        data &&
        typeof data === "object" &&
        "type" in data &&
        (data as { type: unknown }).type === "cursor" &&
        "x" in data &&
        "y" in data
      ) {
        const { x, y } = data as { x: number; y: number };
        broadcastToProject(
          ticket.projectId,
          { type: "cursor", userId: ticket.userId, x, y },
          socket,
        );
      }
    });

    socket.on("close", () => {
      leaveProject(socket);
    });
    socket.on("error", () => {
      leaveProject(socket);
    });
  });

  // Detect zombie connections (e.g. a laptop that went to sleep, or a network
  // drop that never sent a close frame) so their cursors don't linger forever
  // and so the server's client list stays accurate for broadcasts.
  const heartbeat = setInterval(() => {
    for (const [socket, info] of clients) {
      if (!info.isAlive) {
        socket.terminate();
        leaveProject(socket);
        continue;
      }
      info.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}
