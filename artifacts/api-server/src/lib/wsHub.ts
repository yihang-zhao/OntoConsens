import type { IncomingMessage } from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

interface Ticket {
  userId: number;
  projectId: number;
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();
const TICKET_TTL_MS = 30_000;

export function issueTicket(userId: number, projectId: number): string {
  const ticket = crypto.randomBytes(24).toString("hex");
  tickets.set(ticket, { userId, projectId, expiresAt: Date.now() + TICKET_TTL_MS });
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
  projectId: number;
}

const clients = new Map<WebSocket, ClientInfo>();

export type ServerEvent =
  | { type: "cursor"; userId: number; x: number; y: number }
  | { type: "property_created" }
  | { type: "property_updated" }
  | { type: "property_deleted" }
  | { type: "agreement_changed" }
  | { type: "member_joined" }
  | { type: "member_ready" };

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

export function setupWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? "", "http://localhost");
    const ticket = consumeTicket(url.searchParams.get("ticket"));

    if (!ticket) {
      socket.close(4001, "Invalid or expired ticket");
      return;
    }

    clients.set(socket, { userId: ticket.userId, projectId: ticket.projectId });

    socket.on("message", (raw) => {
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
      clients.delete(socket);
    });
  });

  return wss;
}
