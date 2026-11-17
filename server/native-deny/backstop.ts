// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";
import { canonicalJson, canonicalPath, pathAliases, sha256, type DenySpec } from "./compile.ts";
import { ALWAYS_ASK_NO_LIMITS, GATE_MESSAGE_BYTES, newHookToken, parseApplyPatch, placeEditPaths, protectedPathClass, readNativeCode, readNativeCommand, readNativeShell, type AlwaysAskHit } from "./upstream.ts";

export const NATIVE_DENY_DEADLINE_MS = 10_000;
export interface ShellBinding { path: string; mode: "command" | "pwsh" }
export interface NativeDenyRequest {
  v: 2; token: string; generation: number; callId: string; engine: string;
  tool: { name: string; mountId?: string }; args: unknown; argsSha256: string;
  shell: ShellBinding; cwd: string; envSha256: string; policyHash: string; denySpecHash: string;
}
export type NativeDenyReply = { allow: true; callId: string; operationSha256?: string } | { allow: false; callId: string; reason: string; operationSha256?: string };
/** This binds a reply to validated operation DATA, not to an OS principal. A
 * same-UID process can steal the token or replace a seam; containment is D7. */
export function operationSha256(request: NativeDenyRequest): string {
  return sha256(canonicalJson({ v: request.v, generation: request.generation, callId: request.callId, engine: request.engine, tool: request.tool, argsSha256: request.argsSha256, cwd: request.cwd, shell: request.shell, envSha256: request.envSha256, policyHash: request.policyHash, denySpecHash: request.denySpecHash }));
}
export type NativeToolKind = "shell" | "stdin" | "code" | "patch" | "read" | "write";
export interface SessionInput {
  /** Server-derived per-engine tool identity table from the upstream adapter.
   * Never accept this table from the hook request. Unknown identities deny. */
  tools: Readonly<Record<string, NativeToolKind>>;
  turnId: string; engine: string; generation: number; policyHash: string; spec: DenySpec;
  cwd: string; home: string; shell: ShellBinding; envSha256: string;
  integrityFiles?: readonly string[];
  /** Integration must terminate the exact turn process group and mark the stored
   * conversation today here. No process/driver is started by work-ahead code. */
  onTamper: () => void;
  log?: (line: string) => void;
}
interface Pin { path: string; hash: string; dev: number; ino: number }
export interface NativeDenySession extends SessionInput {
  token: string; denySpecHash: string; retired: boolean; conversationProfile: "native-skip" | "today";
  seen: Set<string>; pins: Pin[];
}
export function createNativeDenySession(input: SessionInput): NativeDenySession {
  const { hash, ...data } = input.spec;
  if (typeof input.onTamper !== "function" || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.engine) || !input.tools || !Object.keys(input.tools).length || Object.values(input.tools).some(kind => !["shell", "stdin", "code", "patch", "read", "write"].includes(kind)) || input.spec.version !== 2 || hash !== sha256(canonicalJson(data)) || !input.turnId || !input.engine || !Number.isSafeInteger(input.generation) || input.generation < 0 || !input.cwd || !input.home || !input.shell.path || !["command", "pwsh"].includes(input.shell.mode) || !/^[a-f0-9]{64}$/.test(input.policyHash) || !/^[a-f0-9]{64}$/.test(input.envSha256)) throw Error("native-deny invalid session");
  // Own immutable snapshots of launch facts; mutating the caller's objects cannot
  // silently broaden a live session's deny set or shell binding.
  const copy = JSON.parse(canonicalJson({ ...data, hash })) as DenySpec;
  const pins = (input.integrityFiles ?? []).map(path => {
    const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > GATE_MESSAGE_BYTES) throw Error("native-deny invalid integrity file");
    return { path, hash: sha256(readFileSync(path)), dev: stat.dev, ino: stat.ino };
  });
  return { ...input, tools: { ...input.tools }, shell: { ...input.shell }, spec: copy, token: newHookToken(), denySpecHash: hash, retired: false, conversationProfile: "native-skip", seen: new Set(), pins };
}
export function retireNativeDenySession(session: NativeDenySession): void {
  if (session.retired) return;
  session.retired = true; session.generation++; session.conversationProfile = "today";
}
/** Rehash on every check, including turn end. This deliberately uses no mtime-only
 * shortcut: same-size/mtime rewrites must still be detected. */
export function verifyNativeDenyIntegrity(session: NativeDenySession): boolean {
  if (session.retired) return false;
  try {
    const { hash, ...data } = session.spec;
    if (hash !== session.denySpecHash || sha256(canonicalJson(data)) !== hash) throw Error("policy changed");
    for (const pin of session.pins) {
      const stat = lstatSync(pin.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== pin.dev || stat.ino !== pin.ino || stat.size > GATE_MESSAGE_BYTES || sha256(readFileSync(pin.path)) !== pin.hash) throw Error("pin changed");
    }
    return true;
  } catch {
    retireNativeDenySession(session);
    try { session.onTamper?.(); } catch { /* retirement already prevents any allow */ }
    return false;
  }
}
export function makeNativeDenyRequest(session: NativeDenySession, name: string, args: unknown): NativeDenyRequest {
  return { v: 2, token: session.token, generation: session.generation, callId: randomUUID(), engine: session.engine, tool: { name }, args, argsSha256: sha256(canonicalJson(args)), shell: { ...session.shell }, cwd: session.cwd, envSha256: session.envSha256, policyHash: session.policyHash, denySpecHash: session.denySpecHash };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const deny = (callId: string, reason: string): NativeDenyReply => ({ allow: false, callId, reason });
function equalSecret(a: unknown, b: string): boolean { return typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function matches(path: string, root: string): boolean { return path === root || path.startsWith(root.endsWith("/") ? root : root + "/"); }
function placed(session: NativeDenySession, raw: string): string[] {
  const expanded = raw === "~" ? session.home : raw.startsWith("~/") ? session.home + raw.slice(1) : raw;
  // Keep raw components until symlinks have been expanded. resolve/join would
  // erase alias/.. before the filesystem can supply the alias target's parent.
  const rawPath = isAbsolute(expanded) || win32.isAbsolute(expanded) ? expanded : `${session.cwd}/${expanded}`;
  const p = canonicalPath(rawPath);
  if (p.status !== "ok") throw Error("unexpressible-path");
  return pathAliases(rawPath);
}
function pathReason(session: NativeDenySession, raw: string, write: boolean): string | undefined {
  for (const target of placed(session, raw)) {
    for (const self of session.spec.selfPaths) if (placed(session, self).some(p => matches(target, p))) return "self-path";
    for (const refusal of session.spec.refusals) if (refusal.kind === "path" && placed(session, refusal.value).some(p => matches(target, p))) return "refused-path";
    if (write && protectedPathClass(target)) return "protected-path";
  }
}
/** Best-effort text naming check supplements the upstream shell reader for the
 * per-turn self/refusal paths it does not know. It never executes shell input. */
function textReason(session: NativeDenySession, text: string): string | undefined {
  const expanded = text.replace(/\$\{HOME\}|\$HOME\b/g, session.home);
  const basenames = [...session.spec.selfPaths, ...session.spec.refusals.filter(r => r.kind === "path").map(r => r.value), ...session.pins.map(p => p.path)].map(p => p.split(/[\\/]/).at(-1));
  const names = (expanded.match(/[^\s'";|&<>()]+/g) ?? []).filter(word => /[\\/]/.test(word) || basenames.includes(word));
  for (const raw of names) { const reason = pathReason(session, raw, false); if (reason) return reason; }
  for (const row of [...session.spec.selfPaths, ...session.spec.refusals.filter(r => r.kind === "path").map(r => r.value)]) if (text.includes(row)) return "protected-name";
}
function complete(args: unknown): args is Record<string, unknown> {
  if (!object(args)) return false;
  return !Object.hasOwn(args, "truncated") && !Object.hasOwn(args, "inputMissing") && !Object.hasOwn(args, "toolInputMissing") && !Object.hasOwn(args, "_truncated");
}
export interface BackstopDependencies {
  /** Testing seam for liveness, throws and timeouts. Production uses the upstream reader. */
  read?: (text: string, cwd: string, home: string, pwsh: boolean) => AlwaysAskHit | null | Promise<AlwaysAskHit | null>;
}
async function evaluate(session: NativeDenySession, request: NativeDenyRequest, deps: BackstopDependencies): Promise<NativeDenyReply> {
  const id = request.callId, name = request.tool.name, args = request.args;
  if (!complete(args)) return deny(id, "incomplete-args");
  if (args.env !== undefined || [args.cwd, args.workdir].some(cwd => cwd !== undefined && cwd !== session.cwd) || args.shell !== undefined && args.shell !== session.shell.path) return deny(id, "operation-context");
  if (session.spec.refusals.some(r => r.kind === "tool" && r.value === name)) return deny(id, "refused-tool");
  // MCP remains mediated. No generic mount-name bypass is permitted here; the
  // caller must keep its existing enforcing L0 / non-Murage MCP route.
  if (request.tool.mountId !== undefined || /^mcp__/i.test(name)) return deny(id, "mcp-mediation-required");
  const kind = Object.hasOwn(session.tools, name) ? session.tools[name] : undefined;
  let command: string | undefined;
  if (kind === "shell") {
    if (["cmd", "command"].filter(key => Object.hasOwn(args, key)).length !== 1) return deny(id, "ambiguous-command");
    const text = args.cmd ?? args.command;
    if (typeof text !== "string" || !text.length) return deny(id, "missing-command");
    command = text;
  } else if (kind === "stdin") {
    if (typeof args.chars !== "string" || !Number.isSafeInteger(args.session_id)) return deny(id, "missing-stdin");
    // A live process may not be a shell. Nonempty stdin is never assumed safe.
    return args.chars === "" ? { allow: true, callId: id } : deny(id, "stdin-unproven");
  } else if (kind === "code") {
    if (typeof args.code !== "string") return deny(id, "missing-code");
    // S0's code kind is the upstream execute_code identity (Python). Reject a
    // conflicting declaration instead of selecting a reader from untrusted data.
    if (args.language !== undefined && args.language !== "python") return deny(id, "code-language");
    const code = readNativeCode(args.code);
    if (code.incomplete) return deny(id, "truncated");
    const reason = textReason(session, args.code); if (reason) return deny(id, reason);
    return code.verdict === "card" && code.cls !== "plainWipe" ? deny(id, code.cls) : { allow: true, callId: id };
  } else if (kind === "patch") {
    if (["patch", "input"].filter(key => Object.hasOwn(args, key)).length !== 1) return deny(id, "ambiguous-patch");
    const patch = parseApplyPatch(args.patch ?? args.input);
    if (!patch) return deny(id, "unparseable-patch");
    const paths = [...patch.destinations, ...patch.removed];
    const placedPaths = placeEditPaths(paths, session.cwd, session.cwd, session.home, patch.added);
    if (placedPaths.hold) return deny(id, "unplaced-patch");
    for (const p of [...paths, ...placedPaths.real]) { const reason = pathReason(session, p, true); if (reason) return deny(id, reason); }
    return { allow: true, callId: id };
  } else if (kind === "read" || kind === "write") {
    if (["path", "file_path", "paths"].filter(key => Object.hasOwn(args, key)).length !== 1) return deny(id, "ambiguous-path");
    const path = args.path ?? args.file_path ?? args.paths;
    const paths = typeof path === "string" ? [path] : Array.isArray(path) && path.length && path.every(p => typeof p === "string") ? path as string[] : null;
    if (!paths) return deny(id, "missing-path");
    const write = kind === "write";
    const actual = placeEditPaths(paths, session.cwd, session.cwd, session.home);
    if (actual.hold) return deny(id, "unplaced-path");
    for (const p of [...paths, ...actual.real]) { const reason = pathReason(session, p, write); if (reason) return deny(id, reason); }
    return { allow: true, callId: id };
  } else return deny(id, "unknown-tool");
  const source = readNativeShell(command);
  if (source.incomplete) return deny(id, "truncated");
  const reason = textReason(session, command); if (reason) return deny(id, reason);
  const found = await (deps.read ?? readNativeCommand)(command, session.cwd, session.home, session.shell.mode === "pwsh");
  return found && (found.classification === "deny" || found.mandatory || found.rule === "protected-path" || ALWAYS_ASK_NO_LIMITS[found.rule] === "wipe" || found.namedCatastrophe)
    ? deny(id, found.rule) : source.verdict === "card" && source.cls !== "plainWipe" ? deny(id, source.cls) : { allow: true, callId: id };
}
/** Only allow after complete binding, a live generation, integrity, and a whole
 * read. Never calls the approval/card/outside-content machinery. */
async function decideBound(session: NativeDenySession, value: unknown, deps: BackstopDependencies = {}): Promise<NativeDenyReply> {
  const id = object(value) && typeof value.callId === "string" ? value.callId : "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (Buffer.byteLength(canonicalJson(value)) > GATE_MESSAGE_BYTES) return deny(id, "oversize");
    if (!object(value) || !complete(value) || value.v !== 2 || !equalSecret(value.token, session.token) || value.generation !== session.generation || value.engine !== session.engine || value.policyHash !== session.policyHash || value.denySpecHash !== session.denySpecHash || value.cwd !== session.cwd || value.envSha256 !== session.envSha256 || canonicalJson(value.shell) !== canonicalJson(session.shell) || !id || id.length > 200 || !object(value.tool) || typeof value.tool.name !== "string" || !value.tool.name || !Object.hasOwn(value, "args") || value.argsSha256 !== sha256(canonicalJson(value.args))) return deny(id, "binding");
    if (!verifyNativeDenyIntegrity(session)) return deny(id, "retired-or-tamper");
    if (session.seen.has(id)) return deny(id, "replay");
    session.seen.add(id);
    const generation = session.generation;
    const started = performance.now();
    const result = await Promise.race([
      evaluate(session, value as unknown as NativeDenyRequest, deps),
      new Promise<NativeDenyReply>(resolve => { timer = setTimeout(() => resolve(deny(id, "deadline")), NATIVE_DENY_DEADLINE_MS); }),
    ]);
    if (performance.now() - started >= NATIVE_DENY_DEADLINE_MS) return deny(id, "deadline");
    if (session.retired || session.generation !== generation || !verifyNativeDenyIntegrity(session)) return deny(id, "retired-or-tamper");
    return { ...result, operationSha256: operationSha256(value as unknown as NativeDenyRequest) };
  } catch { return deny(id, "backstop-failure"); }
  finally { if (timer) clearTimeout(timer); }
}

/** The only log format emitted here contains no arguments, command text, tokens
 * or pathnames. The engine/class/rule fields have closed or sanitized values. */
export async function decideNoLimitsNative(session: NativeDenySession, value: unknown, deps: BackstopDependencies = {}): Promise<NativeDenyReply> {
  const start = performance.now();
  const result = await decideBound(session, value, deps);
  const name = object(value) && object(value.tool) && typeof value.tool.name === "string" ? value.tool.name : "";
  const kind = Object.hasOwn(session.tools, name) ? session.tools[name] : "unknown";
  const rule = result.allow ? "-" : result.reason.replace(/[^a-zA-Z0-9_-]/g, "_");
  try { (session.log ?? console.info)(`native-deny engine=${session.engine} class=${kind} verdict=${result.allow ? "allow" : "deny"} rule=${rule} ms=${Math.ceil(performance.now() - start)}`); }
  catch { return deny(result.callId, "logging-failure"); }
  return result;
}
