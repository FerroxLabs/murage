/** The content-free setup boundary of an ACP turn (core.ts acpSetupBoundary; design r3 D1.2/A2).
 *  Owners: this module and acpSetupBoundary are the setup side; prompt composition in sendTurnFenced (core.ts) is the
 *  consuming side. Both belong to the ACP driver core.
 *
 *  The boundary runs initialize, authenticate, session/new or session/load, the model pin, MCP readiness and the
 *  pre-prompt process baseline. It never writes prompt bytes, and its record carries ids, enums and server labels
 *  only: no prompt text, no transcript, no engine output. */

export type AcpMcpOutcome = "ready" | "own_ready" | "timeout" | "aborted";

export interface AcpSetupRecord {
  /** The native session the prompt goes to. */
  readonly nativeSessionId: string | null;
  /** The turn runs on an adopted pooled process (no initialize on it this turn). */
  readonly reused: boolean;
  /** Setup replaced the prompt turn (a transcript replay after a missing session or a binding change). */
  readonly promptRewritten: boolean;
  /** The model pin succeeded (session.started reports a model only then). */
  readonly modelPinConfirmed: boolean;
  /** Required servers the engine reported failed (labels), or null when none were checked or all were ready. */
  readonly failedServers: string[] | null;
  /** Required servers the engine's list did not name: their readiness is unknown (labels). */
  readonly absentServers: string[];
  /** How the last MCP-ready wait ended, null when none ran. */
  readonly mcpOutcome: AcpMcpOutcome | null;
}

/** Every early end of the boundary: the turn was already settled, stopped or halted inside it. */
export const ACP_SETUP_HALTED: unique symbol = Symbol("acp-setup-halted");

/** Prompt composition asked for the setup to run again (the tool-budget rebuild: the former loop `continue`). */
export const ACP_SETUP_RETRY: unique symbol = Symbol("acp-setup-retry");

const SETUP_RECORD_KEYS = ["nativeSessionId", "reused", "promptRewritten", "modelPinConfirmed", "failedServers", "absentServers", "mcpOutcome"] as const;

/** The record, closed over exactly its allow-listed fields (a caller cannot carry anything else across). */
export function acpSetupRecord(fields: AcpSetupRecord): AcpSetupRecord {
  const record: Record<string, unknown> = {};
  for (const key of SETUP_RECORD_KEYS) record[key] = fields[key];
  return Object.freeze(record) as unknown as AcpSetupRecord;
}
