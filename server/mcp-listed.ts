// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The direct readiness signal from Murage's own MCP servers. The engine starts
// each server Murage hands it (agents, memory, connected apps), and the server
// is Murage's own process: once it has written its answer to the engine's
// `tools/list`, the engine holds that server's tools. The driver hands each such
// mount a marker path; the server writes it right after that answer is flushed,
// and the driver releases the turn's MCP wait when every marker of the turn is
// there. No engine notification is needed, and nothing is inferred from silence.
//
// Standalone and dependency-free on purpose: the proxies are bundled and
// spawned as their own node processes.
import { writeFileSync } from "node:fs";

/** The marker path a Murage MCP server writes once it has answered `tools/list`. */
export const MCP_LISTED_FILE_ENV = "MURAGE_MCP_LISTED_FILE";

/** Write the marker (when the mount was given one) once everything already on
 * stdout, the `tools/list` answer included, has been handed to the engine. */
export function markMcpListedAfterFlush(env: Record<string, string | undefined> = process.env): void {
  const path = env[MCP_LISTED_FILE_ENV];
  if (!path) return;
  process.stdout.write("", () => {
    try { writeFileSync(path, String(Date.now()), { mode: 0o600 }); } catch { /* the driver falls back to its bound */ }
  });
}
