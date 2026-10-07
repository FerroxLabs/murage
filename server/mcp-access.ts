// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The credential the standalone MCP server and the control CLI present to the
// harness (0.1.62 audit C5).
//
// The harness answers its conversation routes (the fleet, transcripts, search,
// the live stream) only to a caller that proved who it is: the desktop, the
// companion (a bot's own capability is never proof here). The standalone MCP server (an external
// agent such as Claude Desktop connecting over stdio) is none of those, and it
// is on the same computer as everything else, so "it came from loopback" cannot
// be the proof. It gets its own: a random key kept in the owner's data folder
// in a file only the owner can read. A caller that can read that file is
// already the owner's account; a bot shell that is not allowed to read the data
// folder cannot.
//
// The key is not an owner proof. It admits conversation routes only, the same
// as the companion's door header; approving a card or changing a setting still
// needs the desktop or the paired phone.
import { timingSafeEqual, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

export const MCP_ACCESS_FILE = "mcp-access.token";
const KEY = /^[a-f0-9]{64}$/;

/** The key in this data folder, creating it (0600) on first use. */
export function readOrCreateMcpAccessKey(dataDir: string): string | null {
  const file = join(dataDir, MCP_ACCESS_FILE);
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, "utf8").trim();
      if (KEY.test(existing)) return existing;
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const created = randomBytes(32).toString("hex");
    writeFileSync(file, `${created}\n`, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort on filesystems without modes */ }
    return created;
  } catch {
    // No key means no standalone MCP access, never an open door.
    return null;
  }
}

/** Remove a standing key left by an earlier version. The packaged app keeps
 * none: scripts use a scoped grant instead (mcp-grants.ts). */
export function removeMcpAccessKey(dataDir: string): void {
  try { rmSync(join(dataDir, MCP_ACCESS_FILE), { force: true }); } catch { /* nothing to remove */ }
}

/** The key if the file is there; never creates. For the MCP server and the CLI. */
export function readMcpAccessKey(dataDir: string): string | undefined {
  try {
    const value = readFileSync(join(dataDir, MCP_ACCESS_FILE), "utf8").trim();
    return KEY.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A request carries the key as `Authorization: Bearer <key>`. */
export function createMcpAccessCheck(key: string | null): (headers: IncomingHttpHeaders) => boolean {
  const expected = key && KEY.test(key) ? Buffer.from(key, "hex") : null;
  return (headers) => {
    const raw = headers.authorization;
    if (!expected || typeof raw !== "string") return false;
    const match = /^Bearer ([a-f0-9]{64})$/.exec(raw);
    return match ? timingSafeEqual(expected, Buffer.from(match[1]!, "hex")) : false;
  };
}
