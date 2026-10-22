// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mount names, the facts a driver states about the mounts and the environment
// it handed an engine, and the grant-key encoding
// (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md Rules 27..29, 54, 59, 74).

import { CONNECTED_APPS_SERVER, LEGACY_CONNECTED_APPS_SERVER } from "./connected-app-names.ts";
import type { SshSource } from "./arg-vocabulary.ts";

// ---------------------------------------------------------------------------
// Rules 27..29: names.

/** Rule 27, the REFUSAL form: NFKC, lowercase, every run of characters
 * outside `[a-z0-9]` to one `_`, leading and trailing `_` removed. Coarser
 * than every engine's own coarsening. Used only to refuse a name (Rule 28);
 * identity is never compared this way (Rule 30). */
export function nf(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Pi's own server form: the server part of `sanitizeToolName`
 * (server/drivers/pi-mcp-extension.ts), lowercase with every run outside
 * `[a-z0-9_]` to `_`, leading and trailing `_` removed. Rule 28h runs the
 * same checks under this form. */
export function piForm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Rule 29: the union of every driver's built-in mount names, under `nf`,
 * the legacy connector name and the ACP memory mount included. Every
 * driver's built-in check reads this set (server/custom-mcp-mounts.ts). */
export const RESERVED_MOUNTS: ReadonlySet<string> = new Set(
  ["muragebox", "computer", "agents", "browser", "phone", "dweb", CONNECTED_APPS_SERVER, "murage_phone", LEGACY_CONNECTED_APPS_SERVER, "murage-memory"].map(nf),
);

/** Whether a name collides with a reserved mount under `nf`: equal, or one a
 * `_`-prefix of the other (the Pi joiner). */
function collides(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}_`) || b.startsWith(`${a}_`);
}

/**
 * Rule 28: why the registry refuses a custom mount name, or null. Any of:
 * a. it holds `__` (the MCP joiner);
 * b. `nf(name)` equals a reserved name's `nf`;
 * c. `nf(name)` starts with a reserved name's `nf` and `_` (Pi joiner);
 * d. a reserved name's `nf` starts with `nf(name)` and `_`;
 * e. `nf(name)` equals, is a `_`-prefix of, or is `_`-prefixed by another
 *    stored mount's `nf`;
 * f. it ends in `_murage` or `_murage` and digits (Codex's alias space);
 * g. `nf(name)` is empty;
 * h. the same checks b..e and g under Pi's own form.
 * `others` is every OTHER stored mount's name.
 */
export function mountNameRefusal(name: string, others: readonly string[] = []): string | null {
  if (name.includes("__")) return "A name cannot contain a double underscore.";
  if (/_murage\d*$/.test(name)) return "A name cannot end in _murage; Codex uses that ending itself.";
  for (const form of [nf, piForm]) {
    const own = form(name);
    if (!own) return "That name has no letters or numbers an engine can use.";
    for (const reserved of RESERVED_MOUNTS) {
      const r = form(reserved);
      if (own === r) return "That name is reserved by Murage.";
      if (own.startsWith(`${r}_`)) return "That name begins with a name Murage uses.";
      if (r.startsWith(`${own}_`)) return "That name is the start of a name Murage uses.";
    }
    for (const other of others) {
      const o = form(other);
      if (o && collides(own, o)) return `That name cannot be told apart from your server “${other}” on every engine.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 54: F4, the mounts an engine actually loads for this turn.

export type MountProvenance = "own" | "custom" | "external";

/** One MCP server this engine loads for this turn, written by the driver
 * that mounted or enumerated it. `mountId` is `own:<builtin>`,
 * `custom:<registry name>` or `external:<engineKind>:<configDigest>:<engineName>`.
 * Identity is EXACT `engineName` equality (Rule 30). */
export interface McpMountRecord {
  engineName: string;
  mountId: string;
  provenance: MountProvenance;
}

/** Whether a record is well formed: provenance matches its `mountId`, and the
 * engine name holds no `__` (Rule 11: such a mount is refused). */
export function isMountRecord(value: unknown): value is McpMountRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const { engineName, mountId, provenance } = record;
  if (typeof engineName !== "string" || !engineName || engineName.includes("__")) return false;
  if (typeof mountId !== "string" || typeof provenance !== "string") return false;
  if (provenance === "own") return /^own:[a-z]+$/.test(mountId);
  if (provenance === "custom") return mountId.startsWith("custom:") && mountId.length > "custom:".length;
  if (provenance === "external") return /^external:[^:]+:[0-9a-f]{16}:.+$/.test(mountId);
  return false;
}

/** `own` is read from the RESOLVED record (Rule 31). */
/** Rule 77a (AMEND-13): an own-connector action or lookup key binds to this
 * mount only: the own connector's id with own provenance, never a name. */
export const isOwnConnector = (record: McpMountRecord): boolean => record.mountId === "own:connector" && record.provenance === "own";

// ---------------------------------------------------------------------------
// Rule 59: the grant-key encoding.

/** Percent-encode the set `% : / _` and whitespace, so a component holding
 * any of them cannot be confused with the joiners. Encoding stores an
 * identity Rule 11 already proved and never repairs one. */
export function encodeKeyPart(part: string): string {
  return part.replace(/[%:/_\s]/g, (ch) => {
    const code = ch.codePointAt(0)!;
    return Array.from(new TextEncoder().encode(String.fromCodePoint(code)), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  });
}

/** The inverse of `encodeKeyPart`, or null for a component it could not have
 * written (a raw joiner, a bad escape). */
export function decodeKeyPart(part: string): string | null {
  if (/[:/_\s]/.test(part)) return null;
  if (/%(?![0-9A-F]{2})/.test(part)) return null;
  try {
    const decoded = decodeURIComponent(part);
    return encodeKeyPart(decoded) === part ? decoded : null;
  } catch {
    return null;
  }
}

export const ACP_TOOL_V2_PREFIX = "acp-tool:v2:";

/** `acp-tool:v2:<mountId-enc>/<tool-enc>` (Rules 32, 59). */
export function acpToolKey(mountId: string, tool: string): string {
  return `${ACP_TOOL_V2_PREFIX}${encodeKeyPart(mountId)}/${encodeKeyPart(tool)}`;
}

/** The mount and tool a v2 key names, or null when the text is not one: any
 * number of `/` but one, or a side that does not decode. */
export function parseAcpToolKey(key: string): { mountId: string; tool: string } | null {
  if (!key.startsWith(ACP_TOOL_V2_PREFIX)) return null;
  const body = key.slice(ACP_TOOL_V2_PREFIX.length);
  const parts = body.split("/");
  if (parts.length !== 2) return null;
  const mountId = decodeKeyPart(parts[0]!);
  const tool = decodeKeyPart(parts[1]!);
  if (!mountId || !tool) return null;
  return { mountId, tool };
}

// ---------------------------------------------------------------------------
// Rule 74: F12, the environment a driver handed an engine process.

/** Where `env` came from: the owner's interactive login capture of this
 * engine session; the last validated capture, kept; or Murage's own process
 * environment with the owner told. */
export type EnvCapture = "session" | "kept" | "fallback";

/** F12: the EXACT map handed to the engine process (pins written last), the
 * names Murage removed from it (trusted absence), the directory the
 * command's process starts in, the pinned non-login shell form, and where the
 * map came from. `env` and `absent` share no name. */
export interface ExecEnv {
  env: Readonly<Record<string, string>>;
  absent: readonly string[];
  cwd: string;
  shell: readonly string[];
  capture: EnvCapture;
  /** U20 (Rule 74d): the consistency check failed, so `env` and `absent` are empty and nothing resolves from them;
   *  `cause` says why, for the card. */
  unread?: { code: "U20"; cause: string };
  /** What THIS engine's hand did with the owner's ssh setting (Rule 74c delta 5): the per-repository core.sshCommand row
   *  reads the requesting engine's own source, never another session's. */
  ssh?: { source: SshSource; kept: boolean };
  /** WIN-NOBASH-DESIGN-r2 3.5, informational only (no verdict reads it): the command runs on the CLI's own PowerShell tool
   *  with the CLI's environment (powershell-inherit), so `env` is the hand plus what that CLI version adds (`adds`), and
   *  `unenforceable` names the absence pins an empty settings value cannot clear. */
  provenance?: ExecEnvProvenance;
  /** Section 11 D1, informational: the names a managed settings file's `env` sets that redefine a pinned or turn-owned
   *  name (managed settings outrank Murage's overlay: org policy, said, not fought). */
  managedEnv?: readonly string[];
}

export interface ExecEnvProvenance {
  kind: "inherited";
  cli: string;
  adds: readonly string[];
  unenforceable: readonly string[];
  /** Section 14: the CLI login/routing names the owner's user or managed settings set, kept with the owner's value and so
   *  visible to commands (owner routing). Names only. */
  ownerRouting?: readonly string[];
}

/** Astra #9: the value-free view of an F12 record that may leave the server (a card's F12 panel, the thread's event log):
 *  names, the shell form and where the map came from, never a value. */
export interface ExecEnvInfo {
  names: readonly string[];
  absent: readonly string[];
  shell: readonly string[];
  capture: EnvCapture;
  unread?: "U20";
  provenance?: ExecEnvProvenance;
  managedEnv?: readonly string[];
}

/** The value-free projection of an F12 record (raw values stay server-side). */
export function envInfoOf(record: ExecEnv): ExecEnvInfo {
  return {
    names: Object.keys(record.env).sort(),
    absent: [...record.absent],
    shell: [...record.shell],
    capture: record.capture,
    ...(record.unread ? { unread: "U20" as const } : {}),
    ...(record.provenance ? { provenance: { ...record.provenance, adds: [...record.provenance.adds], unenforceable: [...record.provenance.unenforceable], ...(record.provenance.ownerRouting ? { ownerRouting: [...record.provenance.ownerRouting] } : {}) } } : {}),
    ...(record.managedEnv ? { managedEnv: [...record.managedEnv] } : {}),
  };
}

const stringList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string");

/** Whether an F12 record is well formed; a malformed one is not trusted. */
export function isExecEnv(value: unknown): value is ExecEnv {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const env = record.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return false;
  if (!Object.values(env).every((v) => typeof v === "string")) return false;
  if (!Array.isArray(record.absent) || !record.absent.every((name) => typeof name === "string")) return false;
  if (record.absent.some((name) => Object.hasOwn(env, name as string))) return false;
  if (typeof record.cwd !== "string" || !record.cwd) return false;
  if (!Array.isArray(record.shell) || !record.shell.length || !record.shell.every((part) => typeof part === "string")) return false;
  if (record.unread !== undefined) {
    const unread = record.unread as Record<string, unknown> | null;
    if (!unread || typeof unread !== "object" || unread.code !== "U20" || typeof unread.cause !== "string" || !unread.cause) return false;
  }
  if (record.ssh !== undefined) {
    const ssh = record.ssh as Record<string, unknown> | null;
    const source = ssh && typeof ssh === "object" ? ssh.source as Record<string, unknown> | null : null;
    if (!ssh || typeof ssh.kept !== "boolean" || !source || typeof source !== "object") return false;
    if (source.setting !== "none" && !(["GIT_SSH_COMMAND", "GIT_SSH", "core.sshCommand"].includes(source.setting as string) && typeof source.value === "string")) return false;
  }
  if (record.provenance !== undefined) {
    const provenance = record.provenance as Record<string, unknown> | null;
    if (!provenance || typeof provenance !== "object" || provenance.kind !== "inherited" || typeof provenance.cli !== "string") return false;
    if (!stringList(provenance.adds) || !stringList(provenance.unenforceable)) return false;
    if (provenance.ownerRouting !== undefined && !stringList(provenance.ownerRouting)) return false;
  }
  if (record.managedEnv !== undefined && !stringList(record.managedEnv)) return false;
  return record.capture === "session" || record.capture === "kept" || record.capture === "fallback";
}
