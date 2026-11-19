// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: wg-wiring owns driver env; wg-callback owns callback API; wg-int owns integration and S1 credit.
import { accessSync, constants, existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, win32 } from 'node:path';
import { systemPathPort, canonicalPath } from '../wipe/roots.ts';
import { registeredWipeProjects } from '../wipe/registry.ts';
import { mountedRoots } from '../wipe/mounts.ts';
import { parse } from '../wipe/invocation.ts';
import { effectsOf } from '../wipe/programs.ts';
import { known } from '../wipe/types.ts';
import type { OwnerOperation } from '../no-limits-inspection.ts';
import { pathToFileURL } from 'node:url';
import type { RuntimeEvent, RuntimeEventListener, SendTurnInput } from '../contracts.ts';
import { newEventId, newId } from '../contracts.ts';
import { degradedWipeContext, wipeContextFor } from '../wipe/context.ts';
import type { WipeContext } from '../wipe/types.ts';
import { envGeneration, wipeGuardEnvironment, wipeGuardRuntimeDirectory, wipeGuardShimDirectory } from '../env-path.ts';
import { installWipeGuardShim, wipeGuardPrivateDirectory } from './murage-exec.ts';
import { gitBashPath } from '../tool-discovery.ts';

// Structural seam while G2 builds in its separate worktree. The shipped server
// is a standalone bundle; no missing-module import is hidden from the packager.
export interface ExecGuardCard { command: string; cardCommand: string; cwd: string; targets: readonly string[] }
export interface ExecGuardOperation { tool: string; argv: readonly string[]; cwd: string; targets: readonly string[] }
interface Guard { file: string; end(): Promise<void>; approveOnce?(operation: ExecGuardOperation): boolean }
export interface GuardStartOptions {
  directory: string; threadId: string; roots: readonly string[];
  client: readonly [string, string]; realTools: Readonly<Record<string, string>>;
  context: () => WipeContext; signal: AbortSignal; isLive: () => boolean; isEnabled?: () => boolean;
  askWipe: (request: ExecGuardCard, signal: AbortSignal) => Promise<'allow' | 'deny'>;
}
export type GuardStart = (options: GuardStartOptions) => Promise<Guard>;
async function startCallback(options: GuardStartOptions): Promise<Guard> {
  const base = join(wipeGuardRuntimeDirectory(), 'server');
  const url = pathToFileURL(existsSync(base + '.ts') ? base + '.ts' : base + '.js').href;
  const { startWipeGuardTurn } = await import(/* @vite-ignore */ url) as typeof import('../wipe-guard/server.ts');
  return startWipeGuardTurn(options);
}

/** Resolve originals BEFORE adding the shim, including installed mkfs variants.
 * No command is run and no real tool is ever looked up through the shim. */
export function wipeGuardRealTools(path: string, platform: NodeJS.Platform = process.platform, shim = wipeGuardShimDirectory()): Record<string, string> {
  const tools: Record<string, string> = {};
  const wanted = /^(?:rm|rmdir|mv|dd|shred|wipefs|mkfs(?:\.[a-zA-Z0-9_-]+)?|diskutil)(?:\.exe)?$/;
  const physical = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const self = physical(shim);
  for (const dir of path.split(platform === 'win32' ? ';' : ':')) {
    if (!isAbsolute(dir) || physical(dir) === self
      || existsSync(join(dir, 'guard-lib.sh')) && existsSync(join(dir, 'guard.sh'))) continue;
    let names: string[]; try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!wanted.test(name)) continue;
      const tool = name.replace(/\.exe$/, '');
      if (tools[tool]) continue;
      const file = join(dir, name);
      try {
        accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
        // A symlink to our own wrapper is never an original tool.
        if (dirname(physical(file)) === self) continue;
        tools[tool] = platform === 'win32' ? file.replaceAll('\\', '/') : file;
      } catch { /* another PATH directory may have the executable */ }
    }
  }
  return tools;
}

export function ownerNoLimitsWipeTurn(turn: SendTurnInput): boolean {
  // The live server reader authenticates owner eligibility, including routines.
  // Audience is a separate negative fence, never a source of permission.
  return !turn.prewarm && !turn.draftOnly && turn.warmIdentity?.audience === 'owner'
    && (turn.permissionNow?.() ?? turn).noLimits === true;
}

/** Native spellings belong in the guard file; the Git Bash shim normalizes
 * these together with its expanded operands. No PowerShell profile is used. */
export function wipeGuardRootPaths(ctx: WipeContext, extra: readonly string[] = [], platform: NodeJS.Platform = process.platform): string[] {
  const system = platform === 'win32'
    ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(drive => `${drive}:/`).concat([
      ctx.env?.SystemRoot ?? ctx.env?.SYSTEMROOT ?? 'C:/Windows',
      ctx.env?.ProgramFiles ?? 'C:/Program Files', ctx.env?.['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)',
      ctx.env?.ProgramData ?? 'C:/ProgramData',
    ])
    : ['/', '/home', '/Users', '/etc', '/usr', '/var', '/bin', '/sbin', '/boot', '/lib', '/lib32', '/libx32', '/lib64', '/libexec', '/opt', '/System', '/Library', '/Applications', '/Volumes', '/mnt', '/media', '/root'];
  const path = platform === 'win32' ? win32 : posix;
  const candidates = [...system, ctx.home, ctx.project, ctx.workFolder, ctx.dataDir,
    ctx.home ? path.dirname(ctx.home) : undefined, ctx.dataDir ? path.dirname(ctx.dataDir) : undefined, ...registeredWipeProjects.snapshot(), ...mountedRoots.snapshot(), ...extra];
  const roots = candidates.filter((p): p is string => !!p).map(p => {
    // Use the same bounded path port as the classifier. Missing roots retain a
    // lexical absolute form; readable symlinks MUST publish the physical root.
    // A root that cannot be probed (an empty card reader or optical drive reports
    // UNKNOWN on Windows, a timeout, a link loop) is kept in its lexical form like a
    // missing one: still protected, never a reason to refuse the whole turn.
    const physical = ctx.pathPort ?? (platform === process.platform ? systemPathPort : undefined);
    let real: string | null | undefined;
    try { real = physical?.realpath(p); } catch { real = undefined; }
    return path.resolve(real ?? p).replaceAll('\\', '/');
  });
  return [...new Set(roots)];
}

export interface ExecWipeCardPort {
  provider: string;
  emit(event: RuntimeEvent): void;
  register(id: string, finish: (behavior: string, source?: 'user' | 'timeout' | 'system') => Promise<boolean>): void;
  remove(id: string): void;
  confirm(id: string): void;
  canAllow(id: string, input: Record<string, string>): boolean;
}

/** Existing request ingress, card and answer receipts, with an in-process
 * continuation instead of a provider wire. The callback still rechecks argv. */
export function askExecWipe(port: ExecWipeCardPort, threadId: string, turnId: string,
  isLive: () => boolean, request: ExecGuardCard, signal: AbortSignal): Promise<'allow' | 'deny'> {
  return new Promise(resolve => {
    if (signal.aborted || !isLive()) { resolve('deny'); return; }
    const requestId = newId();
    const base = () => ({ eventId: newEventId(), provider: port.provider, createdAt: new Date().toISOString(), threadId, turnId });
    const input = { command: request.cardCommand, cwd: request.cwd };
    let done = false;
    const finish = async (behavior: string, source: 'user' | 'timeout' | 'system' = 'user'): Promise<boolean> => {
      if (done) return false;
      const allow = behavior === 'allow' && source === 'user' && !signal.aborted && isLive();
      if (allow && !port.canAllow(requestId, input)) return false;
      done = true; signal.removeEventListener('abort', abort); port.remove(requestId);
      port.confirm(requestId);
      resolve(allow ? 'allow' : 'deny');
      port.emit({ ...base(), type: 'request.resolved', requestId, behavior: allow ? 'allow' : 'deny', source });
      return true;
    };
    const abort = () => { void finish('deny', 'system'); };
    signal.addEventListener('abort', abort, { once: true });
    port.register(requestId, finish);
    port.emit({ ...base(), type: 'request.opened', requestId, requestType: 'permission',
      executionCwd: request.cwd, tool: 'Bash', summary: request.command,
      toolCall: { name: 'Bash', input } });
  });
}

export interface TurnGuardEnvOptions {
  turn: SendTurnInput; turnId: string; env: NodeJS.ProcessEnv;
  signal: AbortSignal; isLive: () => boolean;
  subscribe(listener: RuntimeEventListener): () => void;
  askWipe?: GuardStartOptions['askWipe'];
  /** Windows without Git Bash has no exec shim, even when another POSIX tool exists. */
  posixShell?: boolean;
  start?: GuardStart;
  roots?: readonly string[];
  installShim?: (tools: Readonly<Record<string, string>>) => string;
}
const liveGuards = new Map<string, { end(): Promise<void>; approveOnce(operation: ExecGuardOperation): boolean; execCards: number }>();
const guardKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);
const reportCleanupFailure = () => { console.error('[wipe-guard] turn cleanup failed'); };

/** Trusted S1 owner-answer consumer, never fed from request.resolved or argv.
 * The S1 producer must call before releasing the exact concrete operation. */
export function approveExecWipeOnce(threadId: string, turnId: string, operation: ExecGuardOperation): boolean {
  return liveGuards.get(guardKey(threadId, turnId))?.approveOnce(operation) === true;
}

/** Retire synchronously, then await cleanup before publishing the terminal.
 * Retained Stop cleanup is awaited here too; errors remain visible. */
export function deliverWipeGuardTerminal(event: RuntimeEvent, deliver: (event: RuntimeEvent) => void): boolean {
  if (event.type !== 'turn.completed' || !event.turnId) return false;
  const key = guardKey(event.threadId, event.turnId), active = liveGuards.get(key);
  if (!active) return false;
  liveGuards.delete(key);
  void active.end().then(() => deliver(event), () => {
    reportCleanupFailure();
    deliver({ ...event, ok: false, stopReason: 'wipe-guard-cleanup-failed' });
  });
  return true;
}

/** One turn, one file/token. This only changes PATH and MURAGE_WIPE_GUARD.
 * Event retirement revokes synchronously; callback end drains its own resources. */
export async function wipeGuardTurnEnvironment(o: TurnGuardEnvOptions): Promise<NodeJS.ProcessEnv> {
  const env = wipeGuardEnvironment(o.env);
  let commandEnv = env;
  const key = guardKey(o.turn.threadId, o.turnId);
  // A retry/replacement of the same logical turn retires its old endpoint
  // before issuing another file/token, including a replacement at a lower level.
  await liveGuards.get(key)?.end();
  liveGuards.delete(key);
  if (!ownerNoLimitsWipeTurn(o.turn) || o.signal.aborted || !o.isLive()) return env;
  if (process.platform === 'win32' && !(o.posixShell ?? !!await gitBashPath(env as Record<string, string>, envGeneration()))) return env;
  const controller = new AbortController();
  let ending: Promise<void> | undefined, guard: Guard | undefined, retired = false;
  let off = () => {};
  const live = () => !retired && !controller.signal.aborted && !o.signal.aborted && o.isLive()
    && !o.turn.prewarm && !o.turn.draftOnly && o.turn.warmIdentity?.audience === 'owner';
  const enabled = () => ownerNoLimitsWipeTurn(o.turn);
  const end = () => {
    retired = true; controller.abort(); off(); o.signal.removeEventListener('abort', abort);
    return ending ??= guard?.end() ?? Promise.resolve();
  };
  const active = { end, execCards: 0, approveOnce: (operation: ExecGuardOperation) => live() && enabled() && guard?.approveOnce?.(operation) === true };
  const abort = () => { void end().catch(reportCleanupFailure); };
  o.signal.addEventListener('abort', abort, { once: true });
  off = o.subscribe(event => {
    if (event.type === 'turn.completed' && event.threadId === o.turn.threadId && event.turnId === o.turnId) {
      if (liveGuards.get(key) === active) liveGuards.delete(key);
      void end().catch(reportCleanupFailure);
    }
  });
  const context = () => ({ ...degradedWipeContext(wipeContextFor(o.turn.threadId, o.turn.warmIdentity?.botId, { cwd: o.turn.cwd, project: o.turn.cwd }), o.turn.warmIdentity?.botId), env: commandEnv });
  const ctx = context();
  // Current context plus filesystem/OS roots. A producer snapshot may supply
  // the full registered-project/mount set without traversing history here.
  try {
    const roots = o.roots ?? wipeGuardRootPaths(ctx, o.turn.addDirs);
    const realTools = wipeGuardRealTools(env.PATH ?? '');
    const shim = (o.installShim ?? installWipeGuardShim)(realTools);
    const nativePath = (path: string) => process.platform === 'win32' ? path.replaceAll('\\', '/') : path;
    guard = await (o.start ?? startCallback)({ directory: wipeGuardPrivateDirectory(), threadId: o.turn.threadId,
      roots, client: [nativePath(process.execPath), nativePath(join(wipeGuardRuntimeDirectory(), 'client.mjs'))],
      realTools, context, signal: controller.signal, isLive: live, isEnabled: enabled,
      askWipe: async (request, signal) => {
        active.execCards++;
        try { return await (o.askWipe ?? (async () => 'deny'))(request, signal); }
        finally { active.execCards--; }
      } });
    if (!live() || !enabled()) { ending = undefined; await end(); return env; }
    liveGuards.set(key, active);
    commandEnv = wipeGuardEnvironment(env, guard.file, process.platform, shim);
    return commandEnv;
  } catch (error) { await end(); throw plainGuardFailure(error); }
}

/** A guard that cannot start refuses the turn (No limits never runs unguarded),
 * but the owner reads a plain line, never a raw probe code. */
export const GUARD_START_FAILED_LINE = "Murage couldn't start this reply. Send it again.";
function plainGuardFailure(error: unknown): unknown {
  return error instanceof Error && /^wipe-[a-z-]+$/.test(error.message) ? Object.assign(new Error(GUARD_START_FAILED_LINE, { cause: error }), { code: error.message }) : error;
}

/** Trusted owner-card bridge. Only one entirely literal simple rm is concrete;
 * expansion, wrappers and compound commands earn a fresh exec card. */
export function approveTextExecWipeOnce(threadId: string, turnId: string, operation: OwnerOperation): boolean {
  if ((liveGuards.get(guardKey(threadId, turnId))?.execCards ?? 0) > 0) return false;
  if (operation.kind !== 'exec' || operation.dialect !== 'sh' || !operation.cwd || operation.cwdInvalid) return false;
  try {
    const script = parse(operation.text, 'sh'), node = script.nodes[0];
    if (script.incompleteTail || script.nodes.length !== 1 || node?.k !== 'cmd' || node.cond || node.join === '&'
      || node.c.assigns.length || node.c.redirects.length || node.c.words.some(word => word.parts.some(part => part.k !== 'lit'))) return false;
    const words = node.c.words.map(word => word.parts.map(part => part.k === 'lit' ? part.s : '').join(''));
    if (words.shift() !== 'rm') return false;
    const invocation = { program: 'rm', argv: words.map(known), rawArgv: [], redirects: [], cwd: known(operation.cwd), dialect: 'sh' as const };
    const effects = effectsOf(invocation), targets: string[] = [];
    if (!effects.length) return false;
    for (const effect of effects) {
      if (effect.k !== 'delete' || effect.target.k !== 'known') return false;
      const paths = process.platform === 'win32' ? win32 : posix;
      const target = canonicalPath(paths.isAbsolute(effect.target.s) ? effect.target.s : paths.resolve(canonicalPath(operation.cwd), effect.target.s));
      // Alias ambiguity gets its own exec card; no text-side object guess.
      const physical = systemPathPort.realpath(target);
      if (!physical || canonicalPath(physical) !== target) return false;
      targets.push(target);
    }
    return approveExecWipeOnce(threadId, turnId, { tool: 'rm', argv: words, cwd: operation.cwd, targets });
  } catch { return false; }
}
