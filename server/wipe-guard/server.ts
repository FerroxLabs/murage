// SPDX-License-Identifier: AGPL-3.0-or-later
import "../../shared/win-hide-child-process.mjs";
import { withHideInherit } from "../../shared/win-hide-child-process.mjs";
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmdirSync } from 'node:fs';
import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import { createServer, type Socket } from 'node:net';
import { basename, dirname, isAbsolute, join, win32 } from 'node:path';
import { decide, faultVerdict } from '../wipe/decide.ts';
import { effectsOf } from '../wipe/programs.ts';
import { registeredWipeProjects } from '../wipe/registry.ts';
import { BoundedPathPort, canonicalPath, RootClassifier } from '../wipe/roots.ts';
import { known, type Verdict, type WipeContext, type WipeEffect } from '../wipe/types.ts';
import { secureGuardFilePath, writeGuardFile } from './guard-file.ts';

export const GUARD_LIMITS = Object.freeze({ requestBytes: 64 * 1024, strings: 256, stringBytes: 4096,
  roots: 8192, concurrent: 8, requests: 128, approvals: 32, directoryEntries: 8192,
  readMs: 5000, probeMs: 250, operationMs: 500, approvalMs: 10 * 60 * 1000 });
export interface GuardOperation { tool: string; argv: readonly string[]; cwd: string; targets: readonly string[] }
export interface GuardRequest extends GuardOperation { v: 1; kind: 'wipe-exec'; id: string; token: string; threadId: string }
export interface GuardCardRequest extends Omit<GuardRequest, 'token'> {
  verdict: Extract<Verdict, { k: 'card' }>;
  /** Literal argv for the existing permission ingress; never execute this string. */
  command: string;
  /** Same proved effect/target expressed for the existing text wipe-card path.
   * This string is a permission projection and MUST NEVER be executed. */
  cardCommand: string;
}
export interface GuardTurnOptions {
  directory: string;
  threadId: string;
  roots: readonly string[];
  client: readonly [string, string, ...string[]];
  realTools: Readonly<Record<string, string>>;
  context: WipeContext | (() => WipeContext);
  signal?: AbortSignal;
  /** Bound by the driver to this exact live, owner-authorized turn. */
  isLive: () => boolean;
  /** Integration owner supplies the live No limits predicate separately. */
  isEnabled?: () => boolean;
  /** Existing wipe-card adapter: resolve only after the owner's one-shot answer.
   * Abort MUST withdraw/cancel the card. An automatic policy allow is not an owner answer. */
  askWipe: (request: GuardCardRequest, signal: AbortSignal) => Promise<'allow' | 'deny'>;
}
export interface GuardTurn {
  readonly file: string;
  approveOnce(operation: GuardOperation): boolean;
  end(): Promise<void>;
}
const absolute = (value: string) => isAbsolute(value) || win32.isAbsolute(value);
const text = (value: unknown, max: number = GUARD_LIMITS.stringBytes): value is string =>
  typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= max;
const list = (value: unknown): value is string[] => Array.isArray(value) && value.length <= GUARD_LIMITS.strings && value.every(v => text(v));
function operation(value: unknown): value is GuardOperation {
  if (!value || typeof value !== 'object') return false;
  const r = value as GuardOperation;
  return text(r.tool, 64) && /^(?:rm|rmdir|mv|dd|shred|wipefs|mkfs(?:\.[a-zA-Z0-9_-]+)?|diskutil|remove-item|move-item|format-volume|clear-disk|initialize-disk|remove-partition|format|diskpart)$/i.test(r.tool) &&
    list(r.argv) && text(r.cwd) && absolute(r.cwd) && list(r.targets) && r.targets.every(absolute);
}
function request(value: unknown): value is GuardRequest {
  if (!operation(value)) return false;
  const r = value as GuardRequest;
  return r.v === 1 && r.kind === 'wipe-exec' && text(r.id, 128) && r.id.length > 0 && text(r.threadId, 256) && text(r.token, 128);
}
function sameToken(actual: string, expected: string) {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const command = (r: GuardOperation) => [r.tool, ...r.argv].map(quote).join(' ');
const pathOf = (value: string, cwd: string, platform?: NodeJS.Platform) => canonicalPath(absolute(value) ? value : cwd.replace(/[\\/]$/, '') + '/' + value, platform);

// Node/libuv creates Windows pipes with the default descriptor, which grants
// Everyone read access. Replace the named pipe object's DACL before publishing
// its address/token. All instances share the named NPFS object's security.
// https://learn.microsoft.com/windows/win32/ipc/named-pipe-security-and-access-rights
// Failure is fatal to startup; never silently fall back to the broad descriptor.
const WINDOWS_PIPE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
public static class GuardPipeAcl {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, EntryPoint="SetNamedSecurityInfoW")]
  static extern uint SetNamed(string name, int type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, EntryPoint="GetNamedSecurityInfoW")]
  static extern uint GetNamed(string name, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static void Apply(string name) {
    string sid = WindowsIdentity.GetCurrent().User.Value;
    var descriptor = new RawSecurityDescriptor("D:P(A;;FA;;;SY)(A;;FA;;;" + sid + ")");
    byte[] data = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(data, 0);
    var pinned = GCHandle.Alloc(data, GCHandleType.Pinned);
    try {
      bool present, defaulted; IntPtr dacl;
      if (!GetSecurityDescriptorDacl(pinned.AddrOfPinnedObject(), out present, out dacl, out defaulted) || !present)
        throw new InvalidOperationException("guard pipe DACL missing");
      uint result = SetNamed(name, 1, 0x80000004u, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
      if (result != 0) throw new InvalidOperationException("guard pipe DACL restriction failed");
    } finally { pinned.Free(); }
    IntPtr owner, group, acl, sacl, actual;
    if (GetNamed(name, 1, 4, out owner, out group, out acl, out sacl, out actual) != 0)
      throw new InvalidOperationException("guard pipe DACL unreadable");
    try {
      byte[] bytes = new byte[GetSecurityDescriptorLength(actual)]; Marshal.Copy(actual, bytes, 0, bytes.Length);
      var checkedDescriptor = new RawSecurityDescriptor(bytes, 0);
      if (checkedDescriptor.DiscretionaryAcl == null || (checkedDescriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0)
        throw new InvalidOperationException("guard pipe DACL not private");
      bool user = false;
      foreach (GenericAce ace in checkedDescriptor.DiscretionaryAcl) {
        var allow = ace as CommonAce;
        if (allow == null || allow.AceQualifier != AceQualifier.AccessAllowed || allow.IsInherited || allow.IsCallback)
          throw new InvalidOperationException("guard pipe DACL unexpected");
        string granted = allow.SecurityIdentifier.Value;
        if (granted != sid && granted != "S-1-5-18") throw new InvalidOperationException("guard pipe DACL broad");
        if (granted == sid) user = true;
      }
      if (!user) throw new InvalidOperationException("guard pipe owner absent");
    } finally { LocalFree(actual); }
  }
}
'@
[GuardPipeAcl]::Apply($env:MURAGE_WIPE_PIPE)
`;
function secureWindowsGuardPipe(pipe: string): void {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  execFileSync(win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_PIPE_ACL, 'utf16le').toString('base64')],
    withHideInherit({ env: { SystemRoot: root, MURAGE_WIPE_PIPE: pipe }, windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
}

// Internal English diagnostics inventory (startup-only; never sent to a card/client):
// "guard pipe DACL missing": native descriptor has no discretionary ACL.
// "guard pipe DACL restriction failed": native owner-only restriction failed.
// "guard pipe DACL unreadable": restricted descriptor could not be read back.
// "guard pipe DACL not private": descriptor is absent or inherits permissions.
// "guard pipe DACL unexpected": an unrecognized access-control entry appeared.
// "guard pipe DACL broad": a principal other than owner/SYSTEM has access.
// "guard pipe owner absent": no access-control entry grants the current owner.

const OBJECT_PROBE_SOURCE = String.raw`
const {workerData}=require('node:worker_threads'),fs=require('node:fs');
const port=workerData.port;
port.on('message',({method,paths,limit,signal})=>{
 let value,error;
 try {
  if(method==='entries') {
   value=[];const dir=fs.opendirSync(paths[0]);
   try { for(let row=dir.readSync();row;row=dir.readSync()) {
    if(value.length>=limit)throw Error('wipe-guard-directory-capacity');value.push(row.name);
   }} finally {dir.closeSync();}
  } else value=paths.map(path=>{
   const physical=fs.realpathSync.native(path),link=fs.lstatSync(path,{bigint:true}),object=fs.statSync(physical,{bigint:true});
   return [path,physical,String(link.dev),String(link.ino),String(object.dev),String(object.ino)];
  });
 }catch{error='wipe-guard-object-probe-failed';}
 port.postMessage({value,error});const done=new Int32Array(signal);Atomics.store(done,0,1);Atomics.notify(done,0);
});`;

/** Every request-path syscall runs in a worker. A hung worker is quarantined,
 * never reused; all probes in one synchronous inspection share a deadline. */
export class GuardProbes extends BoundedPathPort {
  private objectWorker?: Worker;
  private channel?: MessagePort;
  private broken = false;
  private deadline = 0;
  failed = false;
  private objectSource: string;
  constructor(objectSource = OBJECT_PROBE_SOURCE) { super({ timeoutMs: GUARD_LIMITS.probeMs }); this.objectSource = objectSource; }
  begin() { this.failed = false; this.deadline = performance.now() + GUARD_LIMITS.operationMs; }
  private check() {
    if (this.broken || performance.now() >= this.deadline) { this.failed = true; throw Error('wipe-guard-probe-unavailable'); }
  }
  private bounded<T>(read: () => T): T {
    this.check();
    try { const value = read(); this.check(); return value; }
    catch (error) { this.failed = true; throw error; }
  }
  override realpath(path: string) { return this.bounded(() => super.realpath(path)); }
  override stat(path: string) { return this.bounded(() => super.stat(path)); }
  override lstat(path: string) { return this.bounded(() => super.lstat(path)); }
  override isBlockDevice(path: string) { return this.bounded(() => super.isBlockDevice(path)); }
  override mountId(path: string) { return this.bounded(() => super.mountId(path)); }
  override confirmMount(path: string) { return this.bounded(() => super.confirmMount(path)); }
  private objects(method: string, paths: string[], limit = 0): unknown {
    return this.bounded(() => {
      if (!this.objectWorker) {
        const { port1, port2 } = new MessageChannel(); this.channel = port1;
        this.objectWorker = new Worker(this.objectSource, { eval: true, workerData: { port: port2 }, transferList: [port2] });
        this.objectWorker.on('error', () => { this.broken = true; });
        this.objectWorker.on('exit', () => { this.broken = true; });
        this.objectWorker.unref(); port1.unref();
      }
      const done = new Int32Array(new SharedArrayBuffer(4));
      this.channel!.postMessage({ method, paths, limit, signal: done.buffer });
      const deadline = Math.min(this.deadline, performance.now() + GUARD_LIMITS.probeMs);
      while (!Atomics.load(done, 0)) {
        const left = deadline - performance.now();
        if (left <= 0) {
          this.broken = true; this.channel!.close(); void this.objectWorker.terminate();
          throw Error('wipe-guard-object-probe-timeout');
        }
        Atomics.wait(done, 0, 0, left);
      }
      const reply = receiveMessageOnPort(this.channel!)?.message as { value: unknown; error?: string } | undefined;
      if (!reply || reply.error) throw Error(reply?.error ?? 'wipe-guard-object-probe-unavailable');
      return reply.value;
    });
  }
  entries(path: string, limit: number) { return this.objects('entries', [path], limit) as string[]; }
  identities(paths: string[]) { return this.objects('identities', paths) as string[][]; }
  override async close() {
    this.broken = true; this.channel?.close();
    // A blocked kernel syscall must not hold turn teardown hostage.
    void this.objectWorker?.terminate(); void super.close().catch(() => {});
  }
}

/** Never parse expanded argv as shell text: a literal '$HOME', '*', or ';' is data. */
function inspect(r: GuardOperation, ctx: WipeContext, probes: GuardProbes) {
  const classifier = new RootClassifier({ ...ctx, cwd: r.cwd }, ctx.registry ?? registeredWipeProjects, true);
  const tool = r.tool.toLowerCase();
  const effects: WipeEffect[] = effectsOf({ program: tool, argv: r.argv.map(known), rawArgv: [], redirects: [],
    cwd: known(r.cwd), dialect: tool.includes('-') ? 'pwsh' : 'sh', platform: ctx.platform, home: ctx.home });
  // POSIX rmdir can remove a protected root even when it happens to be empty.
  if (['initialize-disk', 'remove-partition', 'format', 'diskpart'].includes(tool))
    effects.push({ k: 'disk-tool', tool });
  if (tool === 'rmdir') {
    // -p removes every empty ancestor of each operand, up to the first failure.
    // Walk only an empty leaf and sole-child ancestors; targets confer no authority.
    const separator = r.argv.indexOf('--');
    const flags = separator < 0 ? r.argv : r.argv.slice(0, separator);
    const parents = flags.some(arg => arg === '--parents' || /^-[^-]*p/.test(arg));
    let operands = false;
    for (const arg of r.argv) {
      if (!operands && arg === '--') { operands = true; continue; }
      if (operands || !arg.startsWith('-')) {
        let path = pathOf(arg, r.cwd, ctx.platform);
        effects.push({ k: 'delete', target: known(path), recursive: true });
        if (parents && probes.entries(path, GUARD_LIMITS.directoryEntries).length === 0) for (;;) {
          const parent = pathOf(dirname(path), r.cwd, ctx.platform);
          if (parent === path) break;
          const entries = probes.entries(parent, GUARD_LIMITS.directoryEntries);
          if (entries.length !== 1 || entries[0] !== basename(path)) break;
          effects.push({ k: 'delete', target: known(parent), recursive: true }); path = parent;
        }
      }
    }
  }
  const direct = decide(effects, classifier);
  if (direct.k === 'card') return { verdict: direct, effects };
  const grouped = new Map<string, Set<string>>();
  for (const e of effects) {
    const target = e.k === 'delete' && e.recursive ? e.target : e.k === 'move-away' ? e.source : undefined;
    if (target?.k !== 'known') continue;
    const path = pathOf(target.s, r.cwd, ctx.platform), parent = pathOf(dirname(path), r.cwd, ctx.platform);
    if (path === parent) continue;
    let children = grouped.get(parent); if (!children) grouped.set(parent, children = new Set());
    children.add(path);
  }
  // Re-prove the shim's nearly-all claim against actual destructive argv. A
  // caller-supplied targets list can never turn a non-destructive argv into an allow.
  let entries = 0;
  for (const [parent, selected] of grouped) {
    // Removing alias/child traverses a symlink in the parent component, even
    // though rm does not follow a symlink in the final operand itself.
    if (!classifier.classify(known(parent), true)) continue;
    const names = probes.entries(parent, GUARD_LIMITS.directoryEntries - entries);
    entries += names.length;
    const total = names.length;
    const matched = names.filter(name => selected.has(pathOf(join(parent, name), r.cwd, ctx.platform))).length;
    if (total > 0 && matched / total >= 0.9 && (matched >= 2 || matched === total))
      effects.push({ k: 'delete', target: known(parent), recursive: true, follow: true });
  }
  return { verdict: decide(effects, classifier), effects };
}

/** Exact operation + target objects, single use. A retargeted link or replaced
 * root cannot spend an approval minted for the old object. No history access. */
function fingerprint(r: GuardOperation, ctx: WipeContext, probes: GuardProbes): string {
  const objects = [...new Set([...r.targets, ...inspect(r, ctx, probes).effects.flatMap(e => {
    const v = 'target' in e ? e.target : e.k === 'move-away' ? e.source : undefined;
    return v?.k === 'known' ? [pathOf(v.s, r.cwd, ctx.platform)] : [];
  })])].map(path => pathOf(path, r.cwd, ctx.platform)).sort();
  if (probes.failed) throw Error('wipe-guard-probe-failed');
  const identities = probes.identities(objects);
  return createHash('sha256').update(JSON.stringify([r.tool, r.argv, pathOf(r.cwd, r.cwd, ctx.platform), identities])).digest('hex');
}

/** G3 owns start/end calls and supplies its existing wipe-card adapter. */
export async function startWipeGuardTurn(options: GuardTurnOptions): Promise<GuardTurn> {
  // 1.0.20 T1: the check that failed and the count are logged (never a path). The root count is not a reason to refuse a turn: every
  // registered bot/room/task root and mount is published (never truncated, which would weaken the wipe check); the guard file's own byte
  // cap (MAX_GUARD_FILE_BYTES) bounds what is written, and this count only bounds the work before that.
  const invalid = !text(options.threadId, 256) || !options.threadId ? 'thread-id' : options.roots.length > GUARD_LIMITS.roots ? 'root-count'
    : !options.roots.every(p => text(p) && absolute(p)) ? 'root-path' : undefined;
  if (invalid) { console.warn(`[wipe-guard] turn refused: check=${invalid} roots=${options.roots.length}`); throw Error('wipe-guard-invalid-turn'); }
  const directory = mkdtempSync(join(options.directory, 'wg-'));
  const token = randomBytes(32).toString('hex');
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\murage-wipe-' + randomBytes(24).toString('hex') : join(directory, 's.sock');
  const file = join(directory, 'guard.json');
  const abort = new AbortController(), sockets = new Set<Socket>(), seen = new Set<string>(), approvals = new Map<string, number>();
  let ended = false, admissions = 0, active = 0, endPromise: Promise<void> | undefined, removeFile: (() => void) | undefined;
  const probes = new GuardProbes();
  const pruneApprovals = () => { for (const [key, until] of approvals) if (until <= Date.now()) approvals.delete(key); };
  const roots = new Set(options.roots.map(p => canonicalPath(p)));
  const context = (): WipeContext => {
    const current = typeof options.context === 'function' ? options.context() : options.context;
    const registry = current.registry ?? registeredWipeProjects;
    return { ...current, pathPort: current.pathPort ?? probes, registry: { contains: p => roots.has(canonicalPath(p, current.platform)) || registry.contains(p),
      ...(registry.containsIdentity ? { containsIdentity: stat => registry.containsIdentity!(stat) } : {}) } };
  };
  const live = () => { try { return !ended && !options.signal?.aborted && options.isLive(); } catch { return false; } };
  const enabled = () => { try { return options.isEnabled?.() !== false; } catch { return true; } };
  const server = createServer(conn => {
    // Counts idle readers and pending cards too. Completed sockets leave the set.
    if (!live() || active >= GUARD_LIMITS.concurrent || admissions >= GUARD_LIMITS.requests) {
      conn.once('error', () => conn.destroy());
      conn.end('{"id":"","decision":"deny"}\n', () => conn.destroy());
      return;
    }
    admissions++; active++; sockets.add(conn);
    let buffer = '', bytes = 0, dispatched = false, done = false, disconnected = false;
    const cardAbort = new AbortController();
    const finish = (id = '', decision: 'allow' | 'deny' = 'deny') => {
      if (done) return; done = true; active--; clearTimeout(timer); cardAbort.abort();
      abort.signal.removeEventListener('abort', cancel);
      if (disconnected) return;
      conn.end(JSON.stringify({ id, decision }) + '\n');
      // A peer need not close its readable half for turn teardown to finish.
      conn.setTimeout(1000, () => conn.destroy());
    };
    const cancel = () => finish(parsedId);
    let parsedId = '';
    let timer = setTimeout(() => finish(), GUARD_LIMITS.readMs);
    abort.signal.addEventListener('abort', cancel, { once: true });
    conn.setEncoding('utf8');
    conn.once('error', () => { conn.destroy(); });
    conn.once('close', () => {
      disconnected = true; clearTimeout(timer); sockets.delete(conn);
      // The owner can still answer a killed command's card. Stop/end cancels it.
      if (!dispatched) finish(parsedId);
      if (done) abort.signal.removeEventListener('abort', cancel);
    });
    conn.on('data', chunk => {
      if (dispatched || done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > GUARD_LIMITS.requestBytes) return finish();
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      dispatched = true; clearTimeout(timer);
      void (async () => {
        let r: unknown;
        try { r = JSON.parse(buffer.slice(0, end)); } catch { return finish(); }
        buffer = '';
        if (r && typeof r === 'object' && text((r as GuardRequest).id, 128)) parsedId = (r as GuardRequest).id;
        if (!request(r) || !sameToken(r.token, token) || r.threadId !== options.threadId || !live() || seen.has(r.id)) return finish(parsedId);
        seen.add(r.id);
        if (!enabled()) return finish(r.id, live() ? 'allow' : 'deny');
        let verdict: Verdict, stamp: string | undefined;
        try { probes.begin(); verdict = inspect(r, context(), probes).verdict; if (probes.failed) verdict = faultVerdict(); } catch { verdict = faultVerdict(); }
        try { stamp = fingerprint(r, context(), probes); } catch { /* Unreadable targets cannot reuse owner approval. */ }
        pruneApprovals();
        if (stamp && approvals.delete(stamp)) return finish(r.id, live() ? 'allow' : 'deny');
        if (verdict.k === 'run') return finish(r.id, live() ? 'allow' : 'deny');
        if (verdict.rule === 'wipe-check-fault') return finish(r.id);
        const { v, kind, id, threadId, tool, cwd } = r;
        const effect = verdict.effect;
        const target = effect?.k === 'delete' ? effect.target : undefined;
        const cardTarget = target?.k === 'known' ? effect?.k === 'delete' && effect.follow ? target.s.replace(/[\\/]$/, '') + '/.' : target.s : undefined;
        const move = effect?.k === 'move-away' && effect.source.k === 'known' ? effect.source.s : undefined;
        const cardCommand = cardTarget ? ['rm', '-rf', '--', cardTarget].map(quote).join(' ')
          : effect?.k === 'disk-tool' ? 'wipefs --all' : move ? ['mv', '--', move, '/wipe-guard-card-only'].map(quote).join(' ') : command(r);
        const card: GuardCardRequest = Object.freeze({ v, kind, id, threadId, tool, cwd, argv: Object.freeze([...r.argv]), targets: Object.freeze([...r.targets]), verdict, command: command(r), cardCommand });
        let answer: 'allow' | 'deny' = 'deny';
        try { answer = await options.askWipe(card, cardAbort.signal); } catch { /* Missing adapter or failed card delivery denies. */ }
        if (!live() || cardAbort.signal.aborted) return finish(r.id);
        if (!enabled()) return finish(r.id, 'allow');
        // Identity recheck is local to this operation, independent of history.
        if (answer === 'allow' && stamp) try { if ((probes.begin(), fingerprint(r, context(), probes)) !== stamp) answer = 'deny'; } catch { answer = 'deny'; }
        if (answer === 'allow' && stamp && disconnected) {
          pruneApprovals();
          if (approvals.size < GUARD_LIMITS.approvals) approvals.set(stamp, Date.now() + GUARD_LIMITS.approvalMs);
        }
        finish(r.id, answer === 'allow' ? 'allow' : 'deny');
      })().catch(() => finish(parsedId));
    });
  });
  // Also bound connections rejected before they can present a JSON request.
  server.maxConnections = GUARD_LIMITS.concurrent * 2;
  const end = (): Promise<void> => {
    if (endPromise) return endPromise;
    ended = true; void probes.close(); approvals.clear(); seen.clear(); abort.abort();
    options.signal?.removeEventListener('abort', onAbort);
    // abort above sends deny before we bound shutdown for uncooperative peers.
    endPromise = new Promise<void>((resolveEnd, rejectEnd) => {
      const forced = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 100);
      server.close(() => {
        clearTimeout(forced);
        try { removeFile?.(); rmdirSync(directory); resolveEnd(); } catch (error) { rejectEnd(error); }
      });
    });
    return endPromise;
  };
  const onAbort = () => { void end().catch(() => {}); }; // Explicit end() still reports cleanup failure.
  try {
    chmodSync(directory, 0o700);
    secureGuardFilePath(directory);
    if (process.platform !== 'win32' && Buffer.byteLength(socketPath) >= 104) throw Error('wipe-guard-socket-path-too-long');
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      // Never grant *All. Windows' default descriptor still needs restriction
      // before publishing the guard file (it may grant Everyone read access).
      server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => { server.removeListener('error', reject); resolveListen(); });
    });
    server.on('error', onAbort);
    if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
    else secureWindowsGuardPipe(socketPath);
    removeFile = writeGuardFile(file, { v: 1, socket: socketPath, threadId: options.threadId, token,
      roots: [...options.roots], client: options.client, realTools: options.realTools, off: false });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (!live()) await end();
    return Object.freeze({ file, end, approveOnce(r: GuardOperation) {
      pruneApprovals();
      if (!live() || !enabled() || approvals.size >= GUARD_LIMITS.approvals || !operation(r)) return false;
      try { probes.begin(); approvals.set(fingerprint(r, context(), probes), Date.now() + GUARD_LIMITS.approvalMs); return true; } catch { return false; }
    } });
  } catch (error) { await end(); throw error; }
}
