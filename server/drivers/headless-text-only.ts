// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Text-only reflection turn over a headless CLI (Fuigo, Grok, Claude), per
// P2-AMENDMENT-v5.1.md A.1 to A.3: host-side preflight before any spawn, the
// A.1 argv, spawnCli with the child registered by pid and start time, a 12 KB
// stdout cap, a 120 s first-byte timer, and settlement only after
// awaitCliTreeStopped confirms the tree is gone. The per-run gate and the
// miss map live in memory/pip-transport.ts.
import { oneShots } from "../engine-one-shots.ts";
import { fluxCallHeaders, fuigoConfigOverlay } from "../flux-memory-headers.ts";
import { existsSync, readFileSync, lstatSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { PIP_JOB_REFUSAL, PipJobRefusedError } from "../memory/pip-job.ts";
import { join, posix as posixPath, win32 as win32Path } from "node:path";
import { reportMemoryUsage } from "../memory/extract.ts";
import { augmentedPath } from "../env-path.ts";
import { awaitCliTreeStopped, cliJobRefused, spawnCli } from "../procs.ts";
import { cloudTurnBot } from "../cloud-home/turn-process.ts";
import { registerChild } from "../memory/pip-reaper.ts";
import {
  FIRST_BYTE_MS, MAX_OUTPUT_BYTES, RUN_BOUND_MS, assertSupportedSchema, bindReflectionRoute, buildIsolationReport, buildReflectionEnv, createTempRoot, pinReflectionFuigoConfig,
  gateRun, isReportedOverLimit, listFiles, newFiles, parseHeadlessMessages, preflightRoute, removeTempRoot, runAdmissionFence,
  type AdmissionFenceAnswer, type BootEpoch, type JsonSchema, type MissHistory, type PipEngine, type PreflightOptions, type TempRoot, type TextOnlyTurnInput,
  type TextOnlyTurnResult, type TransportHooks, type Verdict,
} from "../memory/pip-transport.ts";

const SERVER_START = Date.now();
const processEpoch = (): BootEpoch => ({ pid: process.pid, startedAt: SERVER_START });

/** Top-level directories of the temp root that are inventoried on their own. */
const ROOT_SUBDIRS = ["home", "work"] as const;
const noProcessReport = (initLine = false) => ({ mcpServers: [], tools: [], homeNewFiles: [], cwdNewFiles: [], exited: true, initLine });
const settledWithout = (verdict: Verdict): TextOnlyTurnResult => ({ text: "", isolation: noProcessReport(), verdict });
const cancelled = () => Object.assign(new Error("cancelled"), { name: "cancelled" });

export interface HeadlessRunOptions {
  cli: string; args: string[]; cwd: string; env: Record<string, string>;
  temp: TempRoot; tmpBase: string; outputSchema: JsonSchema; signal: AbortSignal;
  /** Which engine answers: decides the result fallback the gate may use (A.1). */
  engine: PipEngine;
  maxOutputBytes?: number; maxOutputTokens?: number; firstByteMs?: number; deadlineAt?: number;
  context: { runId: string; family: string; attempt: number; botId?: string };
  bootEpoch?: BootEpoch; history?: MissHistory; hooks?: TransportHooks; binaryIdentity?: string | null;
  /** The admission fence (TextOnlyTurnInput.transport.fence): called after the intent is written, immediately before the spawn. */
  fence?: () => AdmissionFenceAnswer;
  /** Written to stdin then closed (Claude); otherwise stdin is closed at once. */
  stdinText?: string;
  cleanup?: () => void; allowedHomeNew?: RegExp[]; allowedRootNew?: RegExp[];
  /** After the result line, the child gets this long to exit on its own before the tree is stopped. */
  postResultGraceMs?: number;
}

/**
 * One headless CLI attempt from durable intent to a gated verdict. This function owns every exception after the
 * spawn: it never leaves by throwing while a child may still be alive, and never removes the temp root (credentials
 * included) until the tree is confirmed gone. It rejects (`cancelled`, or the original error) only after confirmed
 * exit; an unconfirmed stop returns uncertain-transport with the root kept for the reaper.
 */
export function runHeadlessCli(o: HeadlessRunOptions): Promise<TextOnlyTurnResult> {
  // A background run of the engine: a deletion of a conversation pauses these (engine-one-shots.ts). The temp root is spent by a stopped
  // run, so a stopped one reaches its caller as a cancellation and the caller's own queue starts it again.
  return oneShots.run(o.engine, o.signal, (signal) => runHeadlessCliNow({ ...o, signal }));
}
async function runHeadlessCliNow(o: HeadlessRunOptions): Promise<TextOnlyTurnResult> {
  const job = process.platform === "win32" ? { name: `Local\\murage-pip-${randomUUID()}` } : undefined;
  const max = o.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const now = Date.now();
  const deadlineAt = o.deadlineAt ?? now + RUN_BOUND_MS;
  let finished = false;
  const finish = (exited: boolean) => {
    if (!exited || finished) return;
    finished = true;
    try { o.cleanup?.(); } catch { /* binding cleanup is best effort */ }
    removeTempRoot(o.tmpBase, o.temp.root);
  };

  // Before any process exists: a throw here is safe to settle by removing the root.
  let beforeHome: string[], beforeCwd: string[], beforeRoot: string[];
  try {
    assertSupportedSchema(o.outputSchema);
    if (o.signal.aborted) throw cancelled();
    beforeHome = listFiles(o.temp.home); beforeCwd = listFiles(o.temp.work); beforeRoot = listFiles(o.temp.root, ROOT_SUBDIRS);
    await o.hooks?.onIntent?.({
      runId: o.context.runId, family: o.context.family, attempt: o.context.attempt, tempRoot: o.temp.root,
      ...(job ? { jobName: job.name } : {}), binaryIdentity: o.binaryIdentity ?? null, bootEpoch: o.bootEpoch ?? processEpoch(), intentAt: now, deadlineAt,
    });
    // The intent write is awaited: cancellation can arrive during it, and the abort listener does not exist yet.
    if (o.signal.aborted) throw cancelled();
    // the last await before the spawn: a read that moved meanwhile throws here, the root is removed and no process ever exists
    runAdmissionFence(o.fence);
  } catch (error) { finish(true); throw error; }

  let child: ReturnType<typeof spawnCli>;
  // The bot this reflection runs for: the launcher refuses a Cloud run that names none.
  const env: Record<string, string | undefined> = { ...o.env };
  cloudTurnBot(env, o.context?.botId);
  try { child = spawnCli(o.cli, o.args, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"] }, job); }
  catch (error) {
    finish(true);
    // No job, no CLI: the run is refused for isolation, exactly as a failed assignment is (jobRefusal below).
    if (error instanceof PipJobRefusedError) return settledWithout({ state: "refused", reason: "isolation", detail: "job-assignment-failed", counted: false });
    throw error;
  }

  let exitCode: number | null = null;
  const closed = new Promise<void>((done) => { child.once("close", (code) => { exitCode = code; done(); }); child.once("error", () => done()); });
  let spawnError: Error | null = null;
  child.once("error", (e) => { spawnError = e; });
  const chunks: Buffer[] = [];
  let reportedUsage: TextOnlyTurnResult["usage"];
  let bytes = 0, overBytes = false, aborted = false, timedOut = false, deadlineHit = false, resultTimer: NodeJS.Timeout | undefined;
  // Stopping is awaited, never fire-and-forget: a failed stop wakes the wait below with "stop-failed".
  let stopFailed: () => void = () => {};
  const stopFailedSignal = new Promise<"stop-failed">((done) => { stopFailed = () => done("stop-failed"); });
  let stopRequest: Promise<boolean> | null = null;
  const stop = (): Promise<boolean> => (stopRequest ??= awaitCliTreeStopped(child).then((ok) => { if (!ok) stopFailed(); return ok; }, () => { stopFailed(); return false; }));
  const firstByte = setTimeout(() => { timedOut = true; void stop(); }, o.firstByteMs ?? FIRST_BYTE_MS);
  const deadline = setTimeout(() => { deadlineHit = true; void stop(); }, Math.max(0, deadlineAt - Date.now()));
  const onAbort = () => { aborted = true; void stop(); };
  o.signal.addEventListener("abort", onAbort, { once: true });
  const clearAll = () => { clearTimeout(firstByte); clearTimeout(deadline); if (resultTimer) clearTimeout(resultTimer); o.signal.removeEventListener("abort", onAbort); };
  child.stderr.on("data", () => {});
  child.stdout.on("data", (chunk: Buffer) => {
    clearTimeout(firstByte);
    if (overBytes) return;
    bytes += chunk.length;
    if (bytes > max) { overBytes = true; chunks.length = 0; void stop(); return; }
    chunks.push(chunk);
    reportedUsage = parseHeadlessMessages(Buffer.concat(chunks)).result?.usage ?? reportedUsage;
    if (!resultTimer && chunk.includes('"result"')) resultTimer = setTimeout(() => { void stop(); }, o.postResultGraceMs ?? 10_000);
  });
  const accountUsage = () => {
    const reported = reportedUsage ?? parseHeadlessMessages(Buffer.concat(chunks)).result?.usage;
    const value = { inputTokens: reported?.inputTokens, outputTokens: reported?.outputTokens ?? Math.ceil(bytes / 3.5) };
    // the ledger takes only what the CLI reported; an unreported side keeps its reservation (an engine run is never counted unmetered). A CLI that
    // wrote nothing at all never produced a reply: it is left to the caller's finish (reservation kept, not unmetered)
    if (reported || bytes > 0) reportMemoryUsage({ prompt_tokens: reported?.inputTokens, completion_tokens: reported?.outputTokens, replyBytes: bytes, engineRun: true });
    o.hooks?.onUsage?.(value);
    return value;
  };
  const uncertain = (reason: string): TextOnlyTurnResult => ({ text: "", usage: accountUsage(), isolation: { ...noProcessReport(), exited: false }, verdict: { state: "uncertain-transport", reason } });
  const notConfirmed = () => aborted ? "abort-exit-not-confirmed" : deadlineHit ? "deadline-exit-not-confirmed" : overBytes ? "overflow-exit-not-confirmed" : timedOut ? "first-byte-exit-not-confirmed" : "exit-not-confirmed";

  const jobRefusal = (exited: boolean): TextOnlyTurnResult | null => {
    if (!job || (exitCode !== PIP_JOB_REFUSAL && !cliJobRefused(child)) || !exited) return null;
    finish(true);
    return settledWithout({ state: "refused", reason: "isolation", detail: "job-assignment-failed", counted: false });
  };
  try {
    const registered = await registerChild(child.pid);
    if (!registered) {
      void stop();
      const first = await Promise.race([closed.then(() => "closed" as const), stopFailedSignal]);
      clearAll();
      if (first === "stop-failed") return uncertain(spawnError ? "spawn-failed-exit-not-confirmed" : "register-failed-exit-not-confirmed");
      const exited = await stop();
      const refusal = jobRefusal(exited);
      if (refusal) return refusal;
      finish(exited);
      return { text: "", usage: accountUsage(), isolation: { ...noProcessReport(), exited }, verdict: { state: "uncertain-transport", reason: spawnError ? "spawn-failed" : "register-failed" } };
    }
    await o.hooks?.onChild?.(registered);
    try { child.stdin.end(o.stdinText ?? ""); } catch { /* a dead child is handled by close */ }

    const first = await Promise.race([closed.then(() => "closed" as const), stopFailedSignal]);
    clearAll();
    if (first === "stop-failed") return uncertain(notConfirmed());
    const exited = await awaitCliTreeStopped(child);
    const refusal = jobRefusal(exited);
    if (refusal) return refusal;
    if (aborted || deadlineHit) {
      if (!exited) return uncertain(aborted ? "abort-exit-not-confirmed" : "deadline-exit-not-confirmed");
      finish(true);
      accountUsage();
      throw cancelled();
    }
    const parsed = parseHeadlessMessages(Buffer.concat(chunks));
    let homeNewFiles: string[], cwdNewFiles: string[], rootNewFiles: string[];
    try {
      homeNewFiles = newFiles(beforeHome, listFiles(o.temp.home)); cwdNewFiles = newFiles(beforeCwd, listFiles(o.temp.work));
      rootNewFiles = newFiles(beforeRoot, listFiles(o.temp.root, ROOT_SUBDIRS));
    } catch {
      // An unreadable tree is uncertainty, never an empty inventory.
      finish(exited);
      return { text: "", usage: accountUsage(), isolation: { ...noProcessReport(), exited }, verdict: { state: "uncertain-transport", reason: "inventory-unreadable" } };
    }
    const observation = { parsed, homeNewFiles, cwdNewFiles, rootNewFiles, exited, outputSchema: o.outputSchema, history: o.history, overBytes, allowedHomeNew: o.allowedHomeNew, allowedRootNew: o.allowedRootNew, engine: o.engine, structuredTool: o.engine === "claude" };
    const isolation = buildIsolationReport(observation);
    // A first byte that never arrived is a start-up delay, not a bad answer.
    let verdict: Verdict = timedOut && bytes === 0 && exited
      ? { state: "refused", reason: "transient", detail: "no-first-byte", counted: false }
      : gateRun(observation);
    try {
      if (o.engine === "claude" || existsSync(o.temp.debugFile)) {
        if (lstatSync(o.temp.debugFile).size > 1_048_576) throw new Error("debug-limit");
        const debug = readFileSync(o.temp.debugFile, "utf8");
        if (/\bhook\b[^\n]*(?:execut|running|spawn)|(?:execut|running|spawn)[^\n]*\bhook\b/i.test(debug)) verdict = { state: "unsupported", reason: "managed-config", detail: "hook-execution" };
      }
    } catch { verdict = { state: "refused", reason: "isolation", detail: "debug-inspection-failed", counted: true }; }
    finish(exited);
    const usage = parsed.result?.usage ?? reportedUsage;
    const reported = { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens ?? Math.ceil(bytes / 3.5) };
    // settled here, at the transport, before any caller frees its slot: the ledger takes only what the CLI reported, and an unreported
    // side keeps its reservation, never counted unmetered (the bytes/3.5 figure above is the run's trace, never the charge)
    reportMemoryUsage({ prompt_tokens: usage?.inputTokens, completion_tokens: usage?.outputTokens, replyBytes: bytes, engineRun: true });
    const text = verdict.state === "validated" ? JSON.stringify(verdict.structured) : "";
    return {
      text, verdict, isolation,
      // Billed whether or not the output was admitted: the content is discarded, the spend is not (A.3).
      ...(reported ? { usage: reported } : {}),
      ...(o.maxOutputTokens !== undefined && isReportedOverLimit(usage?.outputTokens, o.maxOutputTokens) ? { reportedOverLimit: true } : {}),
    };
  } catch (error) {
    // Any exception after the spawn (a rejecting hook, a parser fault) goes through the same confirmation path.
    clearAll();
    const ok = await awaitCliTreeStopped(child).catch(() => false);
    if (ok) { accountUsage(); finish(true); throw error; }
    return uncertain("post-spawn-error-exit-not-confirmed");
  }
}

// ----------------------------------------------------------- Fuigo, Grok ----

export interface HeadlessEngineConfig {
  engine: "fuigo" | "grok";
  /** Resolved binary; tests pass process.execPath with cliPrefixArgs = [stub, ...]. */
  cli: string; cliPrefixArgs?: string[];
  tmpBase: string; pathValue?: string;
  fluxKey?: string; parentGrokHome?: string;
  preflight?: PreflightOptions; binaryIdentity?: string | null;
  firstByteMs?: number; postResultGraceMs?: number; allowedHomeNew?: RegExp[];
}

/** The A.1 argv. Fuigo and Grok are identical (the Grok binary is the same source under the grok brand). */
export function headlessArgv(temp: TempRoot, model: string, schema: JsonSchema): string[] {
  return [
    "--cwd", temp.work, "--no-leader", "-m", model, "--permission-mode", "dontAsk", "--max-turns", "1",
    "--tools", "mcp__murage__none", "--disallowed-tools", "search_tool,use_tool,Agent",
    "--disable-web-search", "--no-memory", "--no-auto-update", "--verbatim",
    "--output-format", "streaming-messages-json", "--json-schema", JSON.stringify(schema),
    "--prompt-file", temp.promptFile, "--debug-file", temp.debugFile,
  ];
}

export async function headlessTextOnlyTurn(input: TextOnlyTurnInput, cfg: HeadlessEngineConfig): Promise<TextOnlyTurnResult> {
  assertSupportedSchema(input.outputSchema);
  // One parent home for the whole route: preflight inspects the same directory the auth copy reads.
  const parentGrokHome = cfg.parentGrokHome ?? cfg.preflight?.grokHome;
  // Step 1a: path checks, no process. A refusal here has spawned nothing.
  const pre = preflightRoute(cfg.engine, { ...cfg.preflight, ...(parentGrokHome ? { grokHome: parentGrokHome } : {}) });
  if (!pre.ok) return settledWithout(pre.verdict);
  if (input.signal.aborted) throw cancelled();
  const temp = createTempRoot(cfg.tmpBase, input.context.runId, input.context.attempt, `${input.system}\n\n${input.text}`);
  // Everything up to the run holds no process: a failure here removes the root. After this block runHeadlessCli owns it.
  let cleanup = () => {}, model: string, env: Record<string, string>;
  try {
    const bound = bindReflectionRoute({
      driver: cfg.engine === "fuigo" ? "fuigoAgent" : "grokAgent", temp, model: input.model, runId: input.context.runId,
      providerRoute: input.providerRoute, fluxKey: cfg.fluxKey, parentGrokHome,
    });
    if (!bound.ok) { removeTempRoot(cfg.tmpBase, temp.root); return settledWithout(bound.verdict); }
    cleanup = bound.cleanup;
    model = bound.model;
    env = buildReflectionEnv(cfg.engine, cfg.pathValue ?? augmentedPath(), temp.home, temp.root, bound.env);
    if (cfg.engine === "fuigo") pinReflectionFuigoConfig(temp.home);
    // Flux Memory: a reflection is background work, so a Flux-routed child carries off/off
    // (PROPOSAL-v2 5.4, same overlay the engine's turns use).
    if (input.providerRoute ? input.providerRoute.preset === "flux" : cfg.engine === "fuigo" && Boolean(cfg.fluxKey)) {
      const overlay = fuigoConfigOverlay(fluxCallHeaders("pip-reflection"));
      if (cfg.engine === "fuigo") env.FUIGO_CONFIG = overlay; else env.GROK_CONFIG = overlay;
    }
  } catch (error) { removeTempRoot(cfg.tmpBase, temp.root); throw error; }
  return runHeadlessCli({
    cli: cfg.cli, args: [...(cfg.cliPrefixArgs ?? []), ...headlessArgv(temp, model, input.outputSchema)], cwd: temp.work, env,
    temp, tmpBase: cfg.tmpBase, outputSchema: input.outputSchema, signal: input.signal, engine: cfg.engine,
    maxOutputBytes: input.maxOutputBytes, maxOutputTokens: input.maxOutputTokens, firstByteMs: cfg.firstByteMs,
    deadlineAt: input.transport?.deadlineAt, context: input.context, bootEpoch: input.transport?.bootEpoch,
    history: input.transport?.history, hooks: input.transport?.hooks, fence: input.transport?.fence, binaryIdentity: cfg.binaryIdentity,
    cleanup, allowedHomeNew: cfg.allowedHomeNew, postResultGraceMs: cfg.postResultGraceMs,
  });
}

// ----------------------------------------------------------------- Claude ----

/** Variables a reflection Claude child may see; everything else is dropped. */
export const CLAUDE_ENV_KEEP = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_FORCE_WINDOWS_CREDMAN"] as const;

/** Claude keeps a few caches in its config dir; the live check pins the real set. */
export const CLAUDE_ALLOWED_HOME_NEW = [
  // Claude's own global config and its backups; instruction and settings files (CLAUDE.md, settings*.json, .mcp.json,
  // commands/, agents/) are deliberately NOT admitted: any of them appearing is an isolation miss.
  /^\.claude\.json(\.[A-Za-z0-9._-]+)?$/,
  /^(statsig|todos|shell-snapshots|projects|sessions|logs|cache)\//,
];

/** `loginNamespace` (a native-login run only; null for a routed one) is set as CLAUDE_SECURESTORAGE_CONFIG_DIR directly, outside the keep
 *  loop that drops empty strings: `""` is a real answer (the owner's default Keychain item or Credential Manager name). */
export function claudeAllowlistEnv(full: NodeJS.ProcessEnv, temp: TempRoot, maxOutputTokens: number, loginNamespace: string | null = null): Record<string, string> {
  const env: Record<string, string> = {
    PATH: full.PATH ?? augmentedPath(), HOME: temp.root, CLAUDE_CONFIG_DIR: temp.home,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens), DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
  };
  for (const key of CLAUDE_ENV_KEEP) if (typeof full[key] === "string" && full[key]) env[key] = full[key] as string;
  if (loginNamespace !== null) env.CLAUDE_SECURESTORAGE_CONFIG_DIR = loginNamespace;
  return env;
}

// The owner's Claude login, found where it lives instead of copied (CLAUDE-SCOPE.md Part B). The CLI's credential folder is cL():
// a DEFINED CLAUDE_SECURESTORAGE_CONFIG_DIR wins (`""` = the default store), else CLAUDE_CONFIG_DIR, else ~/.claude; a non-empty value
// is hashed verbatim (NFC) for the Keychain / Credential Manager name and used verbatim as the plaintext folder. The child's HOME is
// the temp root, so a default-store owner on a plaintext file gets the absolute folder; `""` only where the store ignores HOME.

/** What the platform probes found for the owner (resolveClaudeLoginProbes). */
export interface ClaudeLoginProbes {
  /** macOS, default store, plaintext file present: whether the default Keychain item exists (false: only the file holds the login). */
  keychainItem?: boolean;
  /** Windows: the owner's CLI uses Credential Manager (ownerCredmanFlag). */
  credman?: boolean;
}

/** True when the owner's env names the CLI's default store: SECURESTORAGE `""`, or neither SECURESTORAGE nor CLAUDE_CONFIG_DIR set. */
function claudeDefaultStore(full: NodeJS.ProcessEnv): boolean {
  const secure = full.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (typeof secure === "string") return secure === "";
  return !full.CLAUDE_CONFIG_DIR;
}

/** The owner's own `~/.claude`, from the OWNER's env (`full`), never the child's. */
function ownerDefaultClaudeDir(full: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return platform === "win32" ? win32Path.join(full.USERPROFILE || homedir(), ".claude") : posixPath.join(full.HOME || homedir(), ".claude");
}

/** The CLAUDE_SECURESTORAGE_CONFIG_DIR a text-only child gets so it reads the owner's login in place (B.1 step 2). */
export function claudeLoginNamespace(full: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, probes: ClaudeLoginProbes = {}): string {
  const secure = full.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (typeof secure === "string" && secure) return secure;
  if (secure === undefined && full.CLAUDE_CONFIG_DIR) return full.CLAUDE_CONFIG_DIR;
  if (platform === "darwin") return probes.keychainItem === false ? ownerDefaultClaudeDir(full, platform) : "";
  if (platform === "win32") return probes.credman === true ? "" : ownerDefaultClaudeDir(full, platform);
  return ownerDefaultClaudeDir(full, platform);
}

/** `security` exit code for an attributes-only lookup; null when it errored or timed out (the caller treats both as "item exists"). */
export type KeychainLookup = (args: string[]) => Promise<number | null>;
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_PROBE_MS = 2_000;
const securityLookup: KeychainLookup = (args) => new Promise((done) => {
  // stdout is discarded: without -w or -g nothing secret is printed, and nothing printed is kept
  execFile("security", args, { timeout: KEYCHAIN_PROBE_MS, encoding: "utf8", windowsHide: true }, (error) => {
    if (!error) return done(0);
    const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
    done(typeof code === "number" ? code : null);
  });
});
/** Per (user, file mtime) for the process lifetime; cleared by forgetClaudeLoginProbes after a text-only run that did not validate. */
const keychainMemo = new Map<string, boolean>();
export function forgetClaudeLoginProbes(): void { keychainMemo.clear(); }

/** macOS default store, owner's plaintext file present (existence only, never read): does the default Keychain item exist? Exit 0 yes,
 *  44 no, anything else (an error, a timeout) yes: the default store. undefined when there is nothing to ask. */
export async function claudeKeychainItemPresent(full: NodeJS.ProcessEnv, lookup: KeychainLookup = securityLookup): Promise<boolean | undefined> {
  let mtime: number;
  try {
    const stat = statSync(join(ownerDefaultClaudeDir(full, "darwin"), ".credentials.json"), { throwIfNoEntry: false });
    if (!stat) return undefined;
    mtime = stat.mtimeMs;
  } catch { return undefined; }
  let user: string;
  try { user = full.USER || userInfo().username; } catch { return undefined; }
  const key = `${user}\0${mtime}`;
  const memo = keychainMemo.get(key);
  if (memo !== undefined) return memo;
  const code = await lookup(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", user]).catch(() => null);
  const present = code !== 44;
  keychainMemo.set(key, present);
  return present;
}

const CLAUDE_GLOBAL_CONFIG = ".claude.json";
const CREDMAN_SEED = '{"cachedGrowthBookFeatures":{"tengu_windows_credman":true}}';

/** Windows: the owner CLI's own Credential Manager switch (its M4o): CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1, else the cached GrowthBook flag
 *  from `<Le()>/.config.json`, else `<CLAUDE_CONFIG_DIR || home>/.claude.json`, of the OWNER's dirs. An empty or missing file falls through;
 *  an unreadable or non-JSON one is false (plaintext). Only the boolean leaves: the parsed object is dropped, nothing is logged or
 *  written. This is the one place Murage parses an owner `.claude.json`. */
export function ownerCredmanFlag(full: NodeJS.ProcessEnv): boolean {
  if (full.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN === "1") return true;
  const home = full.USERPROFILE || homedir();
  const configDir = full.CLAUDE_CONFIG_DIR || join(home, ".claude");
  for (const file of [join(configDir, ".config.json"), join(full.CLAUDE_CONFIG_DIR || home, CLAUDE_GLOBAL_CONFIG)]) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return false;
    }
    if (!text.trim()) continue;
    try { return (JSON.parse(text) as { cachedGrowthBookFeatures?: { tengu_windows_credman?: unknown } } | null)?.cachedGrowthBookFeatures?.tengu_windows_credman === true; }
    catch { return false; }
  }
  return false;
}

/** The probes for one native-login text-only run: macOS asks the Keychain only in the default-store case; Windows reads the owner's flag. */
export async function resolveClaudeLoginProbes(full: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, lookup?: KeychainLookup): Promise<ClaudeLoginProbes> {
  if (platform === "darwin") return claudeDefaultStore(full) ? { keychainItem: await claudeKeychainItemPresent(full, lookup) } : {};
  if (platform === "win32") return { credman: ownerCredmanFlag(full) };
  return {};
}

/** The unique per-attempt settings file. Its path rides in argv so the registration-gap sweep can find a Claude child. */
export const claudeSettingsPath = (temp: TempRoot): string => join(temp.root, "settings.json");

export function claudeTextOnlyArgv(model: string, system: string, schema: JsonSchema, settingsFile: string, debugFile: string): string[] {
  return [
    "-p", "--model", model, "--system-prompt", system, "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(schema), "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--no-session-persistence", "--settings", settingsFile, "--debug-file", debugFile,
  ];
}

export interface ClaudeTextOnlyConfig {
  cli: string; cliPrefixArgs?: string[]; tmpBase: string;
  /** The full environment claudeEnvironment() produced; reduced to the allowlist here. */
  env: NodeJS.ProcessEnv;
  /** Tests: the platform whose login rule applies, and the macOS Keychain lookup. */
  platform?: NodeJS.Platform; keychainLookup?: KeychainLookup;
  preflight?: PreflightOptions; binaryIdentity?: string | null;
  firstByteMs?: number; postResultGraceMs?: number; allowedHomeNew?: RegExp[];
}

export async function claudeTextOnlyTurn(input: TextOnlyTurnInput, cfg: ClaudeTextOnlyConfig): Promise<TextOnlyTurnResult> {
  assertSupportedSchema(input.outputSchema);
  const pre = preflightRoute("claude", cfg.preflight);
  if (!pre.ok) return settledWithout(pre.verdict);
  if (input.signal.aborted) throw cancelled();
  // A routed turn runs the route's model, exactly as an ordinary Claude turn does (the env selects the same one).
  const model = input.providerRoute?.model || input.model;
  // A native login is read where it lives (never copied); a routed run gets no namespace, no seed and no flag read.
  const platform = cfg.platform ?? process.platform;
  const probes = input.providerRoute ? null : await resolveClaudeLoginProbes(cfg.env, platform, cfg.keychainLookup);
  if (input.signal.aborted) throw cancelled();
  const temp = createTempRoot(cfg.tmpBase, input.context.runId, input.context.attempt, "");
  const settings = claudeSettingsPath(temp);
  try {
    writeFileSync(settings, '{"disableAllHooks":true}', { mode: 0o600 });
    // the CLI picks Credential Manager from its config dir's own cache: the owner's choice is mirrored into the fresh temp home
    if (probes?.credman) writeFileSync(join(temp.home, CLAUDE_GLOBAL_CONFIG), CREDMAN_SEED, { flag: "wx", mode: 0o600 });
  } catch (error) { removeTempRoot(cfg.tmpBase, temp.root); throw error; }
  const loginNamespace = probes ? claudeLoginNamespace(cfg.env, platform, probes) : null;
  return runHeadlessCli({
    cli: cfg.cli, args: [...(cfg.cliPrefixArgs ?? []), ...claudeTextOnlyArgv(model, input.system, input.outputSchema, settings, temp.debugFile)], cwd: temp.work,
    env: claudeAllowlistEnv(cfg.env, temp, input.maxOutputTokens, loginNamespace), temp, tmpBase: cfg.tmpBase, engine: "claude",
    outputSchema: input.outputSchema, signal: input.signal, maxOutputBytes: input.maxOutputBytes, maxOutputTokens: input.maxOutputTokens,
    firstByteMs: cfg.firstByteMs, deadlineAt: input.transport?.deadlineAt, context: input.context, bootEpoch: input.transport?.bootEpoch,
    history: input.transport?.history, hooks: input.transport?.hooks, fence: input.transport?.fence, binaryIdentity: cfg.binaryIdentity,
    stdinText: input.text, allowedHomeNew: cfg.allowedHomeNew ?? CLAUDE_ALLOWED_HOME_NEW, postResultGraceMs: cfg.postResultGraceMs,
  }).then((result) => {
    // a run that did not validate may be a sign-in that moved: the Keychain answer is asked again next time
    if (result.verdict.state !== "validated") forgetClaudeLoginProbes();
    return result;
  }, (error: unknown) => { forgetClaudeLoginProbes(); throw error; });
}
