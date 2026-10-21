// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F12, the environment an engine process is HANDED
// (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md Rule 74). Built in one
// order and no other: (1) the owner's toolchain environment, captured the way
// the owner's terminal gets it (server/env-path.ts captureOwnerEnv), with
// PATH followed by the install directories it does not already name; (2) the
// engine's own documented strips; (3) the pins of ENV_PINS written LAST, every
// value pin set (the ssh transport resolved by resolvePins, its only caller)
// and every absence pin deleted and recorded as trusted absence.
// The finished map is passed as the explicit `env` of the spawn; no engine
// inherits Murage's own environment by omission.

import { createHash } from "node:crypto";
import { delimiter } from "node:path";
import { ABSENT_PINS, ENV_PINS, resolvePins, valuePins, type PinRun, type SshResolution } from "../shared/arg-vocabulary.ts";
import type { PromptFacts } from "../shared/prompt-capable.ts";
import { CHECK_BYTES, CHECK_MS } from "../shared/scan-limits.ts";
import type { EnvCapture, ExecEnv } from "../shared/mount-identity.ts";
import { captureOwnerEnv, envGeneration, installPathTail, invalidateEnvCapture, onEnvInvalidate, type OwnerEnv } from "./env-path.ts";
import { execCli } from "./procs.ts";
import { askTouchesStartup, ownerStartupOf, rememberHand } from "./startup-files.ts";

export interface HandedEnv {
  env: Record<string, string>;
  absent: string[];
  capture: EnvCapture;
  /** The owner's HOME, ZDOTDIR, BASH_ENV, ENV, PSQLRC and CLAUDE_ENV_FILE as captured, BEFORE the pins replaced or
   *  removed them: where the owner's startup files are (server/startup-files.ts, Rule 74d). */
  ownerStartup: Readonly<Record<string, string>>;
  /** The one resolved pin map of this hand (Rule 74c, delta 2): every value pin with the value written into `env`, the ssh
   *  transport pins resolved. Codex's shell policy, Claude's wrapper file and T106 read it; nothing recomputes it. */
  pins: ReadonlyMap<string, string>;
  /** What the hand did with the owner's ssh setting (delta 5): the per-repository row reads `source` and `kept`. */
  ssh?: SshResolution;
}

/** Bounded auxiliary runs through the shared launcher. */
const execPinRun: PinRun = (file, args, opts) =>
  new Promise((resolve) => {
    execCli(file, args, { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: stdout ?? "", stderr: stderr ?? "" }));
  });

let lastSsh: SshResolution | undefined;

/** What the prompt-capable git rows read for ONE ask (Rule 68f): the folder the command runs in, and from the requesting
 *  engine's own F12 record the HOME it was handed and what its hand did with the owner's ssh setting. Never another
 *  session's hand: a record without a usable HOME (none, or U20) gives no facts, and only the git rows hold. */
export function promptFactsOf(execEnv: ExecEnv | undefined, cwd: string | undefined): PromptFacts | undefined {
  const home = execEnv && !execEnv.unread ? execEnv.env.HOME : undefined;
  if (!cwd || !home) return undefined;
  return { cwd, home, ...(execEnv?.ssh ? { ssh: { source: execEnv.ssh.source, kept: execEnv.ssh.kept } } : {}) };
}

/** The requesting engine's handed pin map (Rule 74c), read from its F12 record: every value or resolved pin with the value
 *  its env carries. A pin the check removed is missing, so a command setting it is U19. With no usable record the fixed
 *  value pins of this platform stand in. */
export function handedPinsOf(execEnv: ExecEnv | undefined, platform: NodeJS.Platform = process.platform): ReadonlyMap<string, string> {
  if (!execEnv || execEnv.unread) return valuePins(platform);
  const pins = new Map<string, string>();
  for (const pin of ENV_PINS) {
    if ("absent" in pin) continue;
    const value = execEnv.env[pin.name];
    if (value !== undefined) pins.set(pin.name, value);
  }
  return pins;
}

/** The Engines panel's ssh lines from the latest hand (delta 5): an owner setting engines do not use, or no OpenSSH found. */
export function sshPinNotes(): string[] {
  return [...(lastSsh?.notes ?? [])];
}

/** (1)..(3) over an owner map. `strip` is the engine's documented strip
 * (Codex removes names holding KEY, SECRET or TOKEN before its shell sees
 * them); `extra` is the driver's own names (its loopback URLs, its per-turn
 * file paths), applied before the pins so no driver name can undo a pin.
 * `cwd` is the session folder `git config --get core.sshCommand` runs in;
 * `run` replaces the launcher in tests. */
export async function handEnv(
  owner: OwnerEnv,
  options: {
    platform?: NodeJS.Platform;
    strip?: (env: Record<string, string>) => Record<string, string>;
    extra?: Record<string, string>;
    cwd?: string;
    run?: PinRun;
    /** Cloud home: PATH stays the Cloud turn PATH (no install-directory tail). */
    keepPath?: boolean;
  } = {},
): Promise<HandedEnv> {
  const platform = options.platform ?? process.platform;
  const ownerStartup = ownerStartupOf(owner.env);
  let env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(owner.env)) env[name] = value;
  const tail = options.keepPath ? [] : installPathTail(env.PATH ?? "");
  if (tail.length) env.PATH = [env.PATH, ...tail].filter(Boolean).join(delimiter);
  if (options.strip) env = { ...options.strip(env) };
  for (const [name, value] of Object.entries(options.extra ?? {})) env[name] = value;
  // the probes run with the handed env as it stands with the fixed pins; the source is read from the PRE-pin owner map
  const probeEnv: Record<string, string> = { ...env };
  for (const [name, value] of valuePins(platform)) probeEnv[name] = value;
  for (const name of ABSENT_PINS) delete probeEnv[name];
  const { pins, ssh } = await resolvePins(owner.env, platform, { run: options.run ?? execPinRun, cwd: options.cwd ?? owner.env.HOME, env: probeEnv });
  for (const [name, value] of pins) env[name] = value;
  for (const name of ABSENT_PINS) delete env[name];
  const handed: HandedEnv = { env: { ...env }, absent: [...ABSENT_PINS], capture: owner.capture, ownerStartup, pins, ssh };
  lastSsh = ssh;
  rememberHand(handed);
  return handed;
}

/** Cloud home: no probe runs from the server (the launcher runs only manifest engines), so the ssh
 *  transport pins are the plain `'ssh' '-o' 'BatchMode=yes'` form, the same value the launcher pins. */
const cloudNoRun: PinRun = async () => ({ ok: false, stdout: "", stderr: "" });

/** The owner map captured for this session (awaited before the first spawn)
 * and handed with the pins. On a Cloud home (MURAGE_CLOUD_ROLE=home) the base
 * is the driver's cloudTurnEnvironment map instead, never the server account's
 * captured environment: the pins are written on top of it, and its turn
 * markers (MURAGE_CLOUD_TURN_*) ride through to the launcher. A Cloud home
 * hand without that map is refused. */
export async function handedEngineEnv(options: Parameters<typeof handEnv>[1] = {}, cloudBase?: Readonly<NodeJS.ProcessEnv>): Promise<HandedEnv> {
  if (process.env.MURAGE_CLOUD_ROLE === "home") {
    if (!cloudBase) throw new Error("A Cloud home engine is handed only its Cloud turn environment");
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(cloudBase)) if (typeof value === "string") env[name] = value;
    return handEnv({ env, capture: "session" }, { ...options, run: options.run ?? cloudNoRun, keepPath: true });
  }
  return handEnv(await captureOwnerEnv(), options);
}

const PER_PROCESS = new Set(["_", "SHLVL", "OLDPWD", "PWD"]);

export type CheckResult =
  | { ok: true; env: Record<string, string>; absent: string[]; cwdKnown: boolean; unknown: string[] }
  | { ok: false; why: string };

/** Rule 74d's comparison, given what the pinned form printed. Names whose
 * printed value differs, that are missing, or that are new (past the
 * per-process names) are removed from `env`; a name of `absent` the print
 * holds is removed from `absent`. The check only ever removes. */
export function compareCheck(handed: HandedEnv, cwd: string, printed: string): CheckResult {
  const at = printed.lastIndexOf("\0\0");
  if (at < 0) return { ok: false, why: "the check's output could not be read" };
  const block = printed.slice(0, at + 1);
  let dir = printed.slice(at + 2);
  if (dir.endsWith("\n")) dir = dir.slice(0, dir.endsWith("\r\n") ? -2 : -1);
  const map: Record<string, string> = {};
  for (const pair of block.slice(0, -1).split("\0")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) return { ok: false, why: "the check's output could not be read" };
    map[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const env = { ...handed.env };
  const unknown: string[] = [];
  for (const name of new Set([...Object.keys(handed.env), ...Object.keys(map)])) {
    if (PER_PROCESS.has(name)) continue;
    if (handed.env[name] !== map[name]) {
      if (name in env) delete env[name];
      unknown.push(name);
    }
  }
  const absent = handed.absent.filter((name) => {
    if (name in map) { unknown.push(name); return false; }
    return true;
  });
  // a name the print holds that the hand never had and that is not an absence pin is new: Unknown
  return { ok: true, env, absent, cwdKnown: dir === cwd, unknown: [...new Set(unknown)] };
}

const checks = new Map<string, Promise<CheckResult>>();
// an invalidation (env-path.ts invalidateEnvCapture) drops every cached check
onEnvInvalidate(() => checks.clear());

/** Rule 74d: run the pinned form once per (generation, engine session, shell,
 * cwd, digest of env), with `env` as its environment, in `cwd`, stdin closed,
 * the one script `env -0; printf '\0'; pwd`, bounded by CHECK_MS and
 * CHECK_BYTES. Murage's own process, not a tool call. A failure is U20:
 * nothing resolves from `env` or `absent` for the turn. */
function checkExecEnv(at: number, session: string, shell: readonly string[], handed: HandedEnv, cwd: string): Promise<CheckResult> {
  const digest = createHash("sha256").update(JSON.stringify([shell, cwd, Object.entries(handed.env).sort(), handed.absent])).digest("hex");
  const key = `${at}\u0000${session}\u0000${digest}`;
  const known = checks.get(key);
  if (known) return known;
  const run = new Promise<CheckResult>((resolve) => {
    const [program, ...args] = shell;
    if (!program) return resolve({ ok: false, why: "no shell form" });
    // A Cloud home's launcher builds the engine's environment itself (pinned names win, others dropped) and runs only
    // manifest engines, so the server cannot run the pinned form there: the record is U20, never the hand read as checked.
    if (process.env.MURAGE_CLOUD_ROLE === "home") return resolve({ ok: false, why: "a Cloud home's launcher sets the engine's environment" });
    // Through the shared launcher (Rule 74c): the engine's shell form runs with no controlling terminal.
    execCli(program, [...args, "env -0; printf '\\0'; pwd"], { env: handed.env, cwd, timeout: CHECK_MS, maxBuffer: CHECK_BYTES }, (error, stdout) => {
      if (error) return resolve({ ok: false, why: (error as { killed?: boolean }).killed ? "the check took too long" : "the check did not finish" });
      resolve(compareCheck(handed, cwd, stdout));
    });
  });
  checks.set(key, run);
  return run;
}

/** The F12 record from a check (none: the handed map as handed). */
function execEnvOf(handed: HandedEnv, cwd: string, shell: readonly string[], check?: CheckResult): ExecEnv {
  // this hand's own ssh resolution travels with its record, so a verdict never reads another session's
  const ssh = handed.ssh ? { ssh: { source: handed.ssh.source, kept: handed.ssh.kept } } : {};
  if (check && !check.ok) return { env: {}, absent: [], cwd, shell, capture: handed.capture, unread: { code: "U20", cause: check.why }, ...ssh };
  return { env: check?.ok ? check.env : handed.env, absent: check?.ok ? check.absent : handed.absent, cwd, shell, capture: handed.capture, ...ssh };
}

/** Re-runs a check may take when the generation moves under it, before the ask is U20. */
const CHECK_RERUNS = 3;
const CHANGED_WHILE_CHECKED = "the environment changed while it was being checked";

/** The F12 record a driver reports on a command ask, computed when the card opens (Rule 74d): the check of the current
 *  generation, read again once it answers; a check the generation moved under is never reported, it runs again (at most
 *  three times, then U20 "the environment changed while it was being checked"). */
export async function execEnvNow(session: string, shell: readonly string[], handed: HandedEnv, cwd: string): Promise<ExecEnv> {
  for (let run = 0; run <= CHECK_RERUNS; run++) {
    const at = envGeneration();
    let check: CheckResult;
    try {
      check = await checkExecEnv(at, session, shell, handed, cwd);
    } catch {
      check = { ok: false, why: "the check did not finish" };
    }
    if (envGeneration() === at) return execEnvOf(handed, cwd, shell, check);
  }
  return execEnvOf(handed, cwd, shell, { ok: false, why: CHANGED_WHILE_CHECKED });
}

/** The F12 record of an ask that runs no command: the handed map, unchecked. A Claude PowerShell command on the inherit path
 *  (WIN-NOBASH-DESIGN-r2 3.5) opens with this too, carrying `provenance`: informational, read by no verdict, so its prompts
 *  are those of a Bash command whose check passed with nothing removed (never U20). */
export function execEnvHanded(handed: HandedEnv, cwd: string, shell: readonly string[], info: Pick<ExecEnv, "provenance" | "managedEnv"> = {}): ExecEnv {
  return { ...execEnvOf(handed, cwd, shell), ...(info.provenance ? { provenance: info.provenance } : {}), ...(info.managedEnv?.length ? { managedEnv: info.managedEnv } : {}) };
}

/** The names a driver's own sanitizing decides for a turn (its routing, credential and account names) belong to the turn,
 * never to the owner's shell. A driver's `strip` removes them from the CAPTURED map, which can hold names Murage's own
 * process never had (a Finder launch: ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN exported only in the shell), and
 * these are the turn's own values of those names, written back as the driver's names (Astra 1.0.3 pre-audit). */
export function ownedTurnNames(turnEnv: Readonly<Record<string, string | undefined>>, strip: (map: Record<string, string | undefined>) => void): Record<string, string> {
  const owned: Record<string, string> = {};
  for (const [name, value] of Object.entries(turnEnv)) {
    if (typeof value !== "string" || name === "PATH") continue;
    const probe: Record<string, string | undefined> = { [name]: value };
    strip(probe);
    if (probe[name] === undefined) owned[name] = value;
  }
  return owned;
}

// ---- Rule 74a: an approved write to a startup file -------------------------------------------------------------------------
// The owner edited their shell startup (a Rule 74d file by resolved identity, or cmd's AutoRun; server/startup-files.ts):
// invalidateEnvCapture moves the generation, so the next spawn re-captures the environment and every cached command check is
// dropped. A RUNNING engine keeps the map it was handed, and F12 reports that map.

const startupAsks = new Map<string, number>();
const STARTUP_ASKS_MAX = 256;

/** Read every runtime event: a permission ask that touches a startup file is remembered, and when it is answered allow the
 *  environment is re-captured before the next spawn. Returns true when this event asked for the re-capture. */
export function noteStartupFileEvent(event: { type?: unknown; threadId?: unknown; requestId?: unknown; behavior?: unknown; requestType?: unknown }): boolean {
  if (typeof event.threadId !== "string" || typeof event.requestId !== "string") return false;
  const key = `${event.threadId}:${event.requestId}`;
  if (event.type === "request.opened") {
    if (event.requestType !== "permission" || !askTouchesStartup(event as Record<string, unknown>)) return false;
    startupAsks.set(key, Date.now());
    while (startupAsks.size > STARTUP_ASKS_MAX) startupAsks.delete(startupAsks.keys().next().value!);
    return false;
  }
  if (event.type !== "request.resolved" || !startupAsks.delete(key) || event.behavior !== "allow") return false;
  invalidateEnvCapture("an approved write to a shell startup file");
  return true;
}
