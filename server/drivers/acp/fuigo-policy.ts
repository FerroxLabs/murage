/**
 * FUIGO-SCOPE (1.0.17): Murage's launch permission policy for Fuigo.
 *
 * Fuigo's default mode runs some calls with no `session/request_permission` at all: read_file, grep, glob,
 * list_dir and a list of shell commands it treats as read-only (cat, head, touch, mkdir ...). So a bot could read
 * a key file at Ask with no card (HANDOFF-109-FUIGO-HARDSTOP.md). Fuigo 1.0.36+ takes a per-launch policy
 * (`FUIGO_POLICY_PATH` + `FUIGO_POLICY_SHA256`, and the same pair in `_meta` on every session/new and
 * session/load). An `ask` in that policy reaches the client in every mode, always-approve included, is never
 * answered by a remembered grant, and answering it remembers nothing (Fuigo 1.0.38
 * docs/user-guide/22-permissions-and-safety.md section 4). So every shell, read, edit and search call comes to
 * Murage, which answers it by the bot's level and its own guards (the sensitive-path guard cards a key read at
 * every level).
 *
 * The owner's own FUIGO_HOME stays in use: Fuigo keeps enforcing the owner's own denies and folder-trust grants
 * itself, and Murage writes nothing there. The policy only adds asks.
 *
 * The file is Murage's, under DATA_DIR, rewritten before every launch. Its integrity rests on the hash, not the
 * path: Fuigo refuses to start (exit 78) when the bytes differ from FUIGO_POLICY_SHA256, opens the file without
 * following a link, and pins the bytes for the life of the process. A changed file therefore only ever refuses
 * a turn; it never loosens one.
 */
import { comparable } from "../../data-roots.ts";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../../atomic.ts";
import { DATA_DIR, deleteEnvNames } from "../../config.ts";

export const FUIGO_POLICY_PATH_ENV = "FUIGO_POLICY_PATH";
export const FUIGO_POLICY_SHA256_ENV = "FUIGO_POLICY_SHA256";
export const FUIGO_POLICY_ENV = [FUIGO_POLICY_PATH_ENV, FUIGO_POLICY_SHA256_ENV] as const;
/** Fuigo 1.0.38 permission/launch_policy.rs META_PATH / META_SHA256, and the session ack. */
export const FUIGO_POLICY_META_PATH = "fuigo/permissionPolicyPath";
export const FUIGO_POLICY_META_SHA256 = "fuigo/permissionPolicySha256";
export const FUIGO_POLICY_ACK = "fuigo/permissionPolicy";

/** Rule names from Fuigo's own table (rules.rs tool_name_to_filter): Bash = every shell call; Read = read_file and
 *  list_dir; Edit = edits and writes; Grep = grep and glob; MCPTool = every MCP tool call, so an owner `allow` for an
 *  MCP server (a filesystem server reading a key) still comes to Murage. Murage's own stamped mounts are answered by
 *  the bot's level there. Bare names, so each catches every call of its class. */
export const FUIGO_POLICY_ASK = ["Bash", "Read", "Edit", "Grep", "MCPTool"] as const;
export const FUIGO_POLICY_TEXT = `[permission]\nask = [${FUIGO_POLICY_ASK.map((rule) => JSON.stringify(rule)).join(", ")}]\n`;
export const FUIGO_POLICY_SHA256 = createHash("sha256").update(FUIGO_POLICY_TEXT, "utf8").digest("hex");

export interface FuigoPolicy { path: string; sha256: string }

/** A turn the policy could not cover. Recovery paths (a fresh session after a failed load, a fresh process after a
 *  failed pooled reuse) rethrow it: a fallback would only fail the same way, or open a session with no policy. */
export class FuigoPolicyError extends Error {
  readonly rootMoved: boolean;
  constructor(message: string, rootMoved = false) { super(message); this.name = "FuigoPolicyError"; this.rootMoved = rootMoved; }
}

/** Where the policy lives for this data root (the hash in the name: a new policy is a new file, never a pinned one changed). */
export function fuigoPolicyPath(dataDir: string = DATA_DIR): string {
  return join(dataDir, "native", "fuigo-policy", `launch-${FUIGO_POLICY_SHA256.slice(0, 16)}.toml`);
}

/** Write the policy file (atomically, every launch) and hand back its path and hash. A folder that is a link or
 *  not a folder refuses the turn: never a start without the policy. */
export function ensureFuigoPolicy(dataDir: string = DATA_DIR): FuigoPolicy {
  const path = fuigoPolicyPath(dataDir);
  const dir = join(dataDir, "native", "fuigo-policy");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new FuigoPolicyError(fuigoPolicyRefusal("the approval settings folder is not a plain folder"));
  writeFileAtomic(path, FUIGO_POLICY_TEXT, { mode: 0o600 });
  return { path, sha256: FUIGO_POLICY_SHA256 };
}

/** Put the policy on the child env, dropping every other spelling first (Windows names fold case). */
export function applyFuigoPolicyEnv(env: Record<string, string | undefined>, policy: FuigoPolicy, platform: NodeJS.Platform = process.platform): void {
  deleteEnvNames(env, FUIGO_POLICY_ENV, platform);
  env[FUIGO_POLICY_PATH_ENV] = policy.path;
  env[FUIGO_POLICY_SHA256_ENV] = policy.sha256;
}

/** The owner's captured shell map the engine is handed: the policy names there are exactly the child's (none when
 *  the child has none), in every spelling. */
export function pinFuigoPolicyEnv(map: Record<string, string | undefined>, child: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): void {
  deleteEnvNames(map, FUIGO_POLICY_ENV, platform);
  for (const name of FUIGO_POLICY_ENV) {
    const value = child[name];
    if (typeof value === "string") map[name] = value;
  }
}

/** The policy the child env carries, or null. */
export function fuigoPolicyFromEnv(env: Readonly<Record<string, string | undefined>>): FuigoPolicy | null {
  const path = env[FUIGO_POLICY_PATH_ENV];
  const sha256 = env[FUIGO_POLICY_SHA256_ENV];
  return path && sha256 ? { path, sha256 } : null;
}

/** `_meta` for every session/new and session/load (Fuigo keeps no stored fallback). */
export function fuigoPolicyMeta(policy: FuigoPolicy): Record<string, string> {
  return { [FUIGO_POLICY_META_PATH]: policy.path, [FUIGO_POLICY_META_SHA256]: policy.sha256 };
}

/** One plain line under ERROR_MESSAGE_MAX (160): the chat row is cut there, and the advice to update Fuigo is what an owner with an
 *  older engine needs, so it must be the part that survives. */
export function fuigoPolicyRefusal(why: string): string {
  return `Fuigo did not start this turn (${why}). Nothing ran. Try again, or update Fuigo from Settings.`;
}

/** The session answer must acknowledge the same policy. An engine that ignores it (older than 1.0.36, or another
 *  build on PATH) would run reads and shell commands unasked, so the turn stops before the prompt. */
export function checkFuigoPolicyAck(result: unknown, policy: FuigoPolicy): void {
  const meta = (result as { _meta?: unknown } | null | undefined)?._meta;
  const ack = meta && typeof meta === "object" ? (meta as Record<string, unknown>)[FUIGO_POLICY_ACK] : undefined;
  const sha256 = ack && typeof ack === "object" ? (ack as { sha256?: unknown }).sha256 : undefined;
  if (sha256 === policy.sha256) return;
  throw new FuigoPolicyError(sha256 === undefined
    ? fuigoPolicyRefusal("Fuigo did not confirm your approval settings")
    : fuigoPolicyRefusal("Fuigo reported a different policy"));
}

const POLICY_ERROR_WORDS: Record<string, string> = {
  hash_mismatch: "the policy file changed before Fuigo read it",
  hash_missing: "the policy hash was missing",
  symlink: "the policy file was replaced by a link",
  not_found: "the policy file was missing",
  not_regular_file: "the policy file was not a plain file",
  unreadable: "the policy file could not be read",
  session_policy_missing: "the conversation was opened without the policy",
  leader_conflict: "a shared Fuigo process was asked for",
  route_refused: "a shared Fuigo process was asked for",
};

/** A conversation opened under other settings cannot take the current ones: retrying or updating Fuigo does not help,
 *  a new conversation does. Under 160 characters, the cap an error line keeps, so the guidance is not cut off. */
export const FUIGO_SESSION_POLICY_CONFLICT_LINE = "Fuigo did not start this turn: this conversation has older approval settings. Nothing ran. Start a new conversation to use your current approval settings.";

function policyErrorWords(code: string): string {
  if (code === "session_policy_conflict") return FUIGO_SESSION_POLICY_CONFLICT_LINE;
  return fuigoPolicyRefusal(POLICY_ERROR_WORDS[code] ?? `policy check "${code.replace(/[^a-z_]/g, "").slice(0, 40)}"`);
}

/** The policy failure an error carries, or undefined: Murage's own check, or Fuigo's session error whose `data` is a
 *  `policy_error` record (session/new or session/load opened with a missing, changed or different policy). */
export function fuigoPolicyFailure(error: unknown): FuigoPolicyError | undefined {
  if (error instanceof FuigoPolicyError) return error;
  const data = (error as { data?: unknown } | null | undefined)?.data;
  const code = data && typeof data === "object" ? (data as { policy_error?: unknown }).policy_error : undefined;
  return typeof code === "string" ? new FuigoPolicyError(policyErrorWords(code)) : undefined;
}

/** Readable words for Fuigo's policy refusal: the exit-78 stderr line, or a session error's `data`. Undefined when
 *  the text holds no `policy_error` record. */
export function fuigoPolicyErrorText(text: string): string | undefined {
  for (const line of text.split(/\r\n|\n|\r/).reverse()) {
    const start = line.indexOf("{\"policy_error\"");
    if (start < 0) continue;
    let code: unknown;
    try { code = (JSON.parse(line.slice(start)) as { policy_error?: unknown }).policy_error; } catch { continue; }
    if (typeof code !== "string") continue;
    return policyErrorWords(code);
  }
  return undefined;
}

/** Site 26 provenance occupies one task/provider slot, alongside its resume cursor. */
export interface FuigoResumePolicy { root: string; sha256: string }
/** Supplied by the data-root lifecycle, never inferred from an engine error or a path's shape. */
export interface FuigoRootRelocation { previous: string; copied: boolean }

/** Classify the original 1.0.40 JSON-RPC envelope before policyFailure removes its details.
 * Someone with marker-write access can change the marker hash without changing this sentence. In that case
 * recovery opens a fresh session under the current verified policy and carries the authorized transcript;
 * it never resumes under the edited binding. A future bound hash in the conflict closes only this moved-session
 * classifier ambiguity. Eligible copies still unconditionally open fresh sessions without loading the original. */
export function fuigoPolicyRootMoved(
  error: unknown, record: FuigoResumePolicy | undefined, relocation: FuigoRootRelocation | undefined,
  current: string = DATA_DIR,
): boolean {
  if (!record || !relocation || comparable(record.root) !== comparable(relocation.previous) || comparable(record.root) === comparable(current)) return false;
  if (record.sha256 !== FUIGO_POLICY_SHA256) return false;
  const raw = error as { code?: unknown; data?: { policy_error?: unknown; path?: unknown; message?: unknown } } | null;
  return raw?.code === -32602 && raw.data?.policy_error === "session_policy_conflict"
    && raw.data.path === fuigoPolicyPath(current)
    && raw.data.message === `this session is governed by ${fuigoPolicyPath(record.root)} with a different policy`;
}

/** U2/M1: classify a copied cursor before any load can bind or repair the shared original. */
export function fuigoCopyPreflight(
  record: FuigoResumePolicy | undefined, relocation: FuigoRootRelocation | undefined, current: string = DATA_DIR,
): "load" | "fresh" | "refuse" {
  if (!relocation?.copied) return "load";
  if (!record) return "fresh";
  if (comparable(record.root) === comparable(current)) return "load";
  if (comparable(record.root) === comparable(relocation.previous) && record.sha256 === FUIGO_POLICY_SHA256) return "fresh";
  return "refuse";
}

/** Only the root entry is inspected. ENOENT alone proves a move; even an unreadable entry is a copy. */
export const fuigoRelocationSeams = { lstat: lstatSync };
export function fuigoRootRelocation(record: FuigoResumePolicy | undefined, previous: readonly string[], current = DATA_DIR): FuigoRootRelocation | undefined {
  // A legacy cursor has no provenance. One recorded previous root is unambiguous; multiple roots need a ruling.
  const root = record?.root ?? (previous.length === 1 ? previous[0] : undefined);
  if (!root || comparable(root) === comparable(current) || !previous.some(p => comparable(p) === comparable(root))) return undefined;
  let copied = true;
  try { fuigoRelocationSeams.lstat(root); }
  catch (error) { copied = (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  return { previous: root, copied };
}

export interface FuigoResumeContext {
  policy?: FuigoResumePolicy;
  relocation?: FuigoRootRelocation;
  pending?: { cursor: string };
  delivered?: (cursor: string) => void;
}
/** Per-turn state only. Retries may deliver history twice; retaining it is preferable to losing it. */
export class FuigoResumeTurn {
  renewed = false;
  private readonly context: FuigoResumeContext;
  private readonly current: string;
  constructor(context: FuigoResumeContext = {}, current = DATA_DIR) { this.context = context; this.current = current; }
  preflight() { return fuigoCopyPreflight(this.context.policy, this.context.relocation, this.current); }
  wrap(error: unknown, method: "session/load" | "session/new") {
    const failure = fuigoPolicyFailure(error);
    if (!failure) return error;
    return new FuigoPolicyError(failure.message, method === "session/load" && fuigoPolicyRootMoved(error, this.context.policy, this.context.relocation, this.current));
  }
  needsReplay(cursor: string) { return this.renewed || this.context.pending?.cursor === cursor; }
  delivered(cursor: string, reason: unknown) {
    if (reason === "end_turn" && this.needsReplay(cursor)) this.context.delivered?.(cursor);
  }
}
