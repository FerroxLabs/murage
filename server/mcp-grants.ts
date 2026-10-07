// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scoped access for scripts and external agents (scripts/mcp-server.ts, the
// control CLI) on the packaged app (0.1.62 audit C9 and the mcp-access.token
// finding).
//
// The old arrangement kept one standing key in the data folder. Anything that
// could read that folder, including a Full-access bot's file tools and shell,
// held a door to every conversation. A grant replaces it:
//
//   - The owner makes one in Settings (desktop, or the paired phone) for ONE
//     bot, with or without permission to send. The token is shown once.
//   - The harness stores only its SHA-256 and the scope, so the file in the
//     data folder is not a credential: reading it opens nothing.
//   - A grant works on a handful of routes for that one bot: list itself, read
//     its transcript, and (when allowed) send to it or stop it. Every other
//     route answers as an unknown route. It expires after 30 days and the
//     owner can switch it off at any time.
//
// A grant never proves ownership: a send made with one is marked unproven,
// exactly as a message from any other script on this computer.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

export const MCP_GRANTS_FILE = "mcp-grants.json";
export const MCP_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_MCP_GRANTS = 20;
const TOKEN = /^mcpg_[a-f0-9]{64}$/;

interface StoredGrant {
  id: string;
  botId: string;
  send: boolean;
  createdAt: number;
  expiresAt: number;
  /** SHA-256 of the token, hex. The token itself is never stored. */
  hash: string;
}

/** What the owner sees: everything but the hash. */
export type McpGrant = Omit<StoredGrant, "hash">;

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

export class McpGrants {
  private grants: StoredGrant[] = [];
  private readonly file: string;
  private readonly dataDir: string;
  private readonly now: () => number;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.dataDir = dataDir;
    this.now = now;
    this.file = join(dataDir, MCP_GRANTS_FILE);
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { grants?: unknown };
      if (Array.isArray(parsed.grants)) {
        this.grants = parsed.grants.filter((g): g is StoredGrant =>
          !!g && typeof g === "object"
          && typeof (g as StoredGrant).id === "string" && typeof (g as StoredGrant).botId === "string"
          && typeof (g as StoredGrant).send === "boolean" && typeof (g as StoredGrant).expiresAt === "number"
          && typeof (g as StoredGrant).createdAt === "number" && /^[a-f0-9]{64}$/.test((g as StoredGrant).hash));
      }
    } catch { /* none yet */ }
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify({ grants: this.grants }, null, 2), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* best effort on filesystems without modes */ }
    renameSync(tmp, this.file);
  }

  private prune(): void {
    const now = this.now();
    const live = this.grants.filter(g => g.expiresAt > now);
    if (live.length !== this.grants.length) { this.grants = live; this.save(); }
  }

  /** Make a grant. Returns the token once; only its hash is kept. Null when the owner already holds the most grants allowed. */
  mint(input: { botId: string; send: boolean }): { grant: McpGrant; token: string } | null {
    this.prune();
    if (this.grants.length >= MAX_MCP_GRANTS) return null;
    const token = `mcpg_${randomBytes(32).toString("hex")}`;
    const createdAt = this.now();
    const stored: StoredGrant = { id: randomBytes(8).toString("hex"), botId: input.botId, send: input.send, createdAt, expiresAt: createdAt + MCP_GRANT_TTL_MS, hash: sha256(token).toString("hex") };
    this.grants.push(stored);
    this.save();
    const { hash: _hash, ...grant } = stored;
    return { grant, token };
  }

  list(): McpGrant[] {
    this.prune();
    return this.grants.map(({ hash: _hash, ...grant }) => grant);
  }

  revoke(id: string): boolean {
    const before = this.grants.length;
    this.grants = this.grants.filter(g => g.id !== id);
    if (this.grants.length === before) return false;
    this.save();
    return true;
  }

  /** Revoke everything that points at a bot that no longer exists. */
  revokeBot(botId: string): void {
    const before = this.grants.length;
    this.grants = this.grants.filter(g => g.botId !== botId);
    if (this.grants.length !== before) this.save();
  }

  /** The live grant a request's `Authorization: Bearer mcpg_…` names, or null. */
  resolve(headers: IncomingHttpHeaders): McpGrant | null {
    const raw = headers.authorization;
    if (typeof raw !== "string") return null;
    const match = /^Bearer (\S+)$/.exec(raw);
    if (!match || !TOKEN.test(match[1]!)) return null;
    const presented = sha256(match[1]!);
    const now = this.now();
    let found: StoredGrant | null = null;
    for (const grant of this.grants) {
      // every grant is compared, so timing does not say which one matched
      if (timingSafeEqual(presented, Buffer.from(grant.hash, "hex")) && grant.expiresAt > now) found = grant;
    }
    if (!found) return null;
    const { hash: _hash, ...grant } = found;
    return grant;
  }
}

/** The only routes a grant opens, all for its one bot. */
export function mcpGrantAdmits(
  grant: McpGrant,
  method: string,
  path: string,
  botIdForThread: (threadId: string) => string | undefined,
): boolean {
  if (method === "GET" && path === "/api/health") return true;
  if (method === "GET" && path === "/api/bots") return true; // the handler lists only this bot
  const thread = /^\/api\/threads\/([\w-]+)\/messages$/.exec(path);
  if (thread && method === "GET") return botIdForThread(thread[1]!) === grant.botId;
  const bot = /^\/api\/bots\/([\w-]+)\/(messages|interrupt)$/.exec(path);
  if (bot && method === "POST") return bot[1] === grant.botId && grant.send;
  return false;
}
