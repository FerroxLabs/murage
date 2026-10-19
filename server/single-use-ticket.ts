// server/single-use-ticket.ts
// A short-lived, single-use capability bound to one principal string. The
// voice websocket (server/voice/stream-route.ts) and the desktop's
// URL-loaded resources (sse-visibility.ts) both redeem one of these instead
// of carrying the per-launch desktop proof in a URL.
import { randomBytes } from "node:crypto";

export interface TicketStore {
  mint(principal: string): string;
  /** Single use: spent whether or not it matches. */
  redeem(ticket: string, principal: string): boolean;
  /** Tickets not yet redeemed or expired (tests). */
  size(): number;
}

export function createTicketStore(opts: { ttlMs?: number; now?: () => number; maxOutstanding?: number } = {}): TicketStore {
  const ttl = opts.ttlMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const cap = opts.maxOutstanding ?? Number.POSITIVE_INFINITY;
  const tickets = new Map<string, { principal: string; expires: number }>();
  return {
    mint(principal: string): string {
      for (const [t, v] of tickets) if (v.expires < now()) tickets.delete(t);
      // Oldest first: Map keeps insertion order.
      while (tickets.size >= cap) tickets.delete(tickets.keys().next().value!);
      const ticket = randomBytes(32).toString("base64url");
      tickets.set(ticket, { principal, expires: now() + ttl });
      return ticket;
    },
    redeem(ticket: string, principal: string): boolean {
      const found = tickets.get(ticket);
      tickets.delete(ticket);
      return Boolean(found && found.expires >= now() && found.principal === principal);
    },
    size: () => tickets.size,
  };
}
