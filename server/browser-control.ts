import { isReadOnly } from "./read-only-start.ts";
import { serviceOwnerNoLimits, serviceUnredactedRead, type ServiceAuthority } from "./narrow-denials.ts";
import { WebDocuments } from "./web-documents.ts";
import { routeBrowserRead, nativeReadPort } from "./browser-read-route.ts";
import { createHash } from 'node:crypto';
import { migrateBrowserOwner } from "./browser-owner-api.ts";
// One profile is one control boundary, even when several bots share it.
// Holds survive disconnects and server restarts. No ownership token is accepted
// from model arguments. Callers supply a server-authenticated owner identity.
import { existsSync, readFileSync } from "node:fs";
import { SessionGate, assertGateToken, type GateToken } from './browser-session-gate.ts';
import { judgeDaemonIdentity, validDaemonIdentity, validCloseTarget, closeTargetGone, daemonExeMatches, type DaemonIdentity, type CloseTarget, type DaemonVerdict } from './browser-daemon-identity.ts';
import { writeFileAtomic } from "./atomic.ts";
import type { AgentBrowserSpec } from "./browser-engine.ts";
import { createNativeBrowser, type NativeBrowser, type BrowserFrame } from "./browser-native-relay.ts";
import { browserEngineDown } from "./browser-engine-error.ts";
import { listHeadlessBrowserTools, validateHeadlessBrowserCall } from "./browser-engine-policy.ts";
import { browserRefusal, isBrowserRefusal, protectionRefusal, type BrowserProtection } from "./browser-lock.ts";

export type BrowserStatus = { closing?: boolean; closeFailed?: boolean; generation: number; held: boolean; owner: string | null; connected: boolean; protectedDocument: boolean; protectedReason: BrowserProtection | null; url: string;
  /** The bot's browser engine is not running or not answering. Its own state:
   * never a page lock. Restart browser (restart()) starts it again. */
  notRunning: boolean;
  /** Why the live view is not connected, in the owner's words; absent when it is. */ problem?: string;
  /** "Use my Chrome": the first connection is waiting for the owner's Allow in Chrome. */ waitingForChrome?: boolean;
  /** Moves only when control or the page changes hands (take, release, reclaim, navigate, reopen,
   * restart), never when the live view merely reconnects. Hand-back is checked against this. */ control?: number };
/** Reopen blank page could not start a fresh browser. The page lock stays. */
export const BROWSER_REOPEN_FAILED = "Murage could not restart this browser, so the page stays locked. Wait a moment, then choose Reopen blank page again. If it keeps failing, quit and reopen Murage.";
/** The owner's line while the engine is not running. */
export const BROWSER_NOT_RUNNING = "Murage's browser is not running right now. Choose Restart browser to start it again.";
/** A bot step failed inside the engine, and nothing more is known yet. */
const BROWSER_NOT_ANSWERING = "Murage's browser is not answering.";
// After a failed connect the panel's status reads do not start another one
// for this long, so a browser that cannot start is not relaunched every poll.
const RECONNECT_AFTER_MS = 3000;
/** A tab left to the owner: the page was protected when the bot was moved to a new blank tab. Never attached to, read, typed into or
 * closed for the bot. Released once the browser no longer lists it. No address is kept (it can carry a sign-in token). */
type OwnerTab = { id: string; reason: BrowserProtection };
const OWNER_TAB_TOOLS = new Set(["agent_browser_tab_list", "agent_browser_tab_switch", "agent_browser_tab_close", "agent_browser_close"]);
const MAX_OWNER_TABS = 20;
const validOwnerTabs = (value: unknown): value is OwnerTab[] => Array.isArray(value) && value.length <= MAX_OWNER_TABS && value.every(t => t && typeof t.id === "string" && t.id.length <= 200 && (t.reason === "owner-input" || t.reason === "sensitive-page"));
type Entry = Omit<BrowserStatus, "closing"> & { ownerTabs?: OwnerTab[]; botTab?: string; readDocuments?: WebDocuments; closing?: number; closeRefused?: boolean; closeTarget?: CloseTarget; daemonIdentity?: DaemonIdentity; botId?: string; opEpoch: number; forgetting?: number; deleted?: boolean; controlEpoch?: number; problem?: string; native?: NativeBrowser; spec?: AgentBrowserSpec; pending?: Promise<unknown>; frame?: BrowserFrame & { generation: number }; lastSeq: number; streamId?: string; connecting?: Promise<void>; retryAt?: number };
export type Trailing = { key: string; entry: Entry; op: number; run: () => Promise<BrowserStatus> };
const transitionError = (code: string, status = 409) => Object.assign(new Error(code), { status, code });
const boundedClose = async (native: NativeBrowser) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([native.close(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Browser close acknowledgement timed out'), { code: 'close_timeout' })), 5000); })]); }
  finally { clearTimeout(timer); }
};
/** A daemon proven to be this session's (pid, start time, boot) that did not acknowledge its close is stopped by that exact
 * process number, then must be seen gone within this bound. Never a pattern or a group. */
const STOP_DAEMON_MS = 3000;
/** The owned close refused on purpose (helpers left, another launch or engine): never overridden, the refusal stands. */
const DELIBERATE_REFUSALS = new Set(['orphans_remain', 'tree_lingering', 'launch_mismatch', 'engine_mismatch']);
const failureCode = (error: unknown) => (error as { code?: unknown } | null)?.code;
/** Only a daemon that did not answer (no acknowledgement in time, or seen still running after it was asked) is stopped. */
const deliberate = (error: unknown) => { const code = failureCode(error); return typeof code === 'string' && DELIBERATE_REFUSALS.has(code); };
const unanswered = (error: unknown) => failureCode(error) === 'close_timeout' || failureCode(error) === 'daemon_unresponsive';
const JUDGE_MS = 3000;
const refusal = () => browserRefusal("browser_control_changed");
const attachedSpec = (e: Entry) => Boolean(e.spec?.env.AGENT_BROWSER_CDP);
/** "Use my Chrome": Chrome is asking the owner to Allow. `chromeWaiting` is what
 * Murage's one connection knows: true while Chrome shows its prompt (also when
 * only a bot's step is waiting on it), false once allowed. */
const userChromeAsking = (e: Entry, chromeWaiting: boolean | undefined) => chromeWaiting === true || (!!e.connecting && chromeWaiting !== false);
// Conservative document barrier: never deliver any DOM/text/pixels from a page
// containing a protected input. Human input taints the session until explicit
// owner reopen; returning control alone cannot disclose a transformed secret.
// A page the guard flagged on its own (no human input) is different: the bot
// never received it, and a navigation to a new address discloses nothing of
// it, so the bot may leave it; the guard re-checks every open page after the
// navigation and the lock clears only when none of them is protected.
function protect(e: Entry, reason: BrowserProtection) {
  if (e.protectedReason !== "owner-input") e.protectedReason = reason;
  e.protectedDocument = true;
}


const OWNER_INPUT_WAIT_MS = 10_000;
const BROWSER_STILL_RECONNECTING = "The browser view is still reconnecting. Try again.";
export class UnifiedBrowserController {
  readonly sessionGate: SessionGate;
  private opSeq = 0;
  private readonly personOwner?: string;
  private readonly closingDone = new Map<string, Promise<void>>();
  private readonly teardownDone = new Map<string, Promise<void>>();
  private readonly judgeDaemon: (identity: DaemonIdentity | undefined, command: string) => Promise<DaemonVerdict>;
  private readonly closeSpec?: (target: CloseTarget) => AgentBrowserSpec;
  private readonly stopDaemon: (pid: number, command: string) => void;
  private readonly sessionGone: (target: CloseTarget) => boolean;
  private entries = new Map<string, Entry>();
  private readonly stateFile: string;
  private readonly factory: (spec: AgentBrowserSpec) => NativeBrowser;
  private readonly closeFactory: (spec: AgentBrowserSpec) => NativeBrowser;
  /** "Use my Chrome": is Chrome showing its Allow prompt for this key right now? Unknown (undefined) counts as waiting. */
  private readonly chromeWaiting: (key: string) => boolean | undefined;
  constructor(options: { ownerMigration?: { realm: string; cloudHome: boolean }; stateFile: string; createNative?: (spec: AgentBrowserSpec) => NativeBrowser; chromeWaiting?: (key: string) => boolean | undefined; sessionGate?: SessionGate; judgeDaemon?: (identity: DaemonIdentity | undefined, command: string) => Promise<DaemonVerdict>; closeSpec?: (target: CloseTarget) => AgentBrowserSpec; stopDaemon?: (pid: number, command: string) => void; sessionGone?: (target: CloseTarget) => boolean }) {
    const migration = options.ownerMigration;
    const ownerHash = (kind: string) => createHash('sha256').update(`${migration!.realm}:${kind}`).digest('hex').slice(0, 32);
    this.personOwner = migration ? ownerHash('owner') : undefined;
    this.closeFactory = options.createNative ?? (spec => createNativeBrowser(spec, { closeOnly: true }));
    this.sessionGate = options.sessionGate ?? new SessionGate(); this.judgeDaemon = options.judgeDaemon ?? judgeDaemonIdentity; this.closeSpec = options.closeSpec;
    this.stopDaemon = options.stopDaemon ?? ((pid, command) => { if (daemonExeMatches(pid, command)) process.kill(pid, 'SIGKILL'); }); this.sessionGone = options.sessionGone ?? closeTargetGone;
    this.stateFile = options.stateFile; this.factory = options.createNative ?? createNativeBrowser; this.chromeWaiting = options.chromeWaiting ?? (() => undefined);
    if (existsSync(this.stateFile)) {
      const saved = JSON.parse(readFileSync(this.stateFile, "utf8"));
      if (!Array.isArray(saved) || saved.length > 1000) throw new Error("Invalid browser control state");
      let migrated = false;
      for (const [key, state] of saved) {
        if (typeof key !== "string" || !Number.isSafeInteger(state.generation) || typeof state.held !== "boolean") throw new Error("Invalid browser control state");
        if ((state.closeFailed !== undefined && typeof state.closeFailed !== 'boolean') || (state.closeRefused !== undefined && typeof state.closeRefused !== 'boolean') || (state.ownerTabs !== undefined && !validOwnerTabs(state.ownerTabs)) ||
            (state.daemonIdentity !== undefined && !validDaemonIdentity(state.daemonIdentity)) ||
            (state.closeTarget !== undefined && !validCloseTarget(state.closeTarget))) throw new Error('Invalid browser control state');
        if (options.ownerMigration) {
          const owner = migrateBrowserOwner(state.owner, options.ownerMigration.realm, options.ownerMigration.cloudHome);
          if (owner !== state.owner) { state.owner = owner; migrated = true; }
        }
        // A lock saved before its cause was recorded is treated as the
        // owner's: only the owner's reopen clears it.
        const protectedReason: BrowserProtection | null = state.protectedDocument === true ? (state.protectedReason === "sensitive-page" ? "sensitive-page" : "owner-input") : null;
        this.entries.set(key, { held: state.held, owner: typeof state.owner === "string" ? state.owner : null, closeFailed: state.closeFailed === true, ...(state.closeFailed === true && typeof state.closeRefused === 'boolean' ? { closeRefused: state.closeRefused } : {}), daemonIdentity: state.daemonIdentity, closeTarget: state.closeTarget, opEpoch: ++this.opSeq, ...(state.closeFailed ? { closing: this.opSeq } : {}), protectedDocument: protectedReason !== null, protectedReason, ...(state.ownerTabs?.length ? { ownerTabs: state.ownerTabs, ...(typeof state.botTab === "string" && state.botTab.length <= 200 ? { botTab: state.botTab } : {}) } : {}), generation: state.generation + 1, connected: false, notRunning: false, url: "", lastSeq: -1 });
      }
      if (migrated && !isReadOnly()) this.save();
    }
  }
  private save() {
    writeFileAtomic(this.stateFile, JSON.stringify([...this.entries].map(([key, e]) => [key, { generation: e.generation, held: e.held, owner: e.owner, protectedDocument: e.protectedDocument, protectedReason: e.protectedReason, ...(e.ownerTabs?.length ? { ownerTabs: e.ownerTabs, ...(e.botTab ? { botTab: e.botTab } : {}) } : {}), ...(e.closeFailed ? { closeFailed: true, ...(e.closeRefused !== undefined ? { closeRefused: e.closeRefused } : {}), daemonIdentity: e.daemonIdentity, closeTarget: e.closeTarget } : {}) }])), { mode: 0o600 });
  }
  holdState(key: string) {
    const e = this.entries.get(key);
    return e ? { held: e.held, legacy: e.held && !!this.personOwner && e.owner !== this.personOwner, registered: !!e.spec, closeFailed: e.closeFailed === true, closing: e.closing !== undefined, forgetting: e.forgetting !== undefined } : null;
  }
  blocksCommit(key: string): 'held' | 'window' | null { return this.holdState(key)?.held ? 'held' : null; }
  failedKeyForBot(botId: string): string | null {
    for (const [key, e] of this.entries) if (e.closeFailed && e.closeTarget?.botId === botId) return key;
    return null;
  }
  private mutable(token: GateToken, key: string, allowFailed = false): Entry {
    assertGateToken(token, key);
    const e = this.rawEntry(key);
    if (e.forgetting !== undefined || e.deleted) throw transitionError('revision_changed');
    if (e.closeFailed && !allowFailed) throw transitionError('browser_close_failed');
    if (e.closing !== undefined && !(allowFailed && e.closeFailed)) throw transitionError('browser_closing');
    return e;
  }
  registerLocked(token: GateToken, key: string, spec: AgentBrowserSpec, botId?: string) {
    assertGateToken(token, key);
    const old = this.entries.get(key);
    if (old?.forgetting !== undefined) throw transitionError('forget_in_progress');
    if (old?.closing !== undefined) throw transitionError('browser_closing');
    if (old?.spec && JSON.stringify(old.spec) !== JSON.stringify(spec)) throw new Error('Browser profile binding changed; close it before rebinding');
    if (!old && this.entries.size >= 256) throw new Error('Browser profile capacity reached');
    const previous = old && { ...old };
    const e: Entry = old ?? { opEpoch: 0, generation: 1, held: false, owner: null, connected: false, notRunning: false, protectedDocument: false, protectedReason: null, url: '', lastSeq: -1 };
    e.spec = spec; e.botId ??= botId; e.opEpoch = ++this.opSeq; this.entries.set(key, e);
    try { this.save(); } catch (error) { if (old && previous) { Object.assign(old, previous); old.spec = previous.spec; old.botId = previous.botId; } else this.entries.delete(key); throw error; }
    const registeredOp = e.opEpoch;
    // Publication is part of this same synchronous gated transaction. The
    // undo is usable only by its live token and cannot erase a successor.
    return () => {
      assertGateToken(token, key);
      if (this.entries.get(key) !== e || e.opEpoch !== registeredOp) return;
      if (old && previous) {
        for (const field of Object.keys(e) as (keyof Entry)[]) if (!Object.hasOwn(previous, field)) delete e[field];
        Object.assign(e, previous);
      } else this.entries.delete(key);
      this.save();
    };
  }
  async waitForTeardown(key: string) { await (this.closingDone.get(key) ?? this.teardownDone.get(key)); }
  async register(key: string, spec: AgentBrowserSpec, botId?: string) {
    for (let round = 0; round < 3; round++) {
      if (this.closingDone.has(key) || this.teardownDone.has(key)) await this.waitForTeardown(key);
      const done = await this.sessionGate.run([key], token => {
        const e = this.entries.get(key);
        if (e?.closing !== undefined || e?.forgetting !== undefined) return false;
        this.registerLocked(token, key, spec, botId); return true;
      });
      if (done) return;
    }
    throw transitionError('browser_closing');
  }
  private rawEntry(key: string): Entry { const e = this.entries.get(key); if (!e || e.deleted) throw new Error('Browser profile is unavailable'); return e; }
  private entry(key: string): Entry { const e = this.rawEntry(key); if (!e.spec && !e.closeFailed && e.closing === undefined) throw new Error('Browser profile is unavailable'); return e; }
  status(key: string): BrowserStatus {
    const e = this.rawEntry(key);
    return { generation: e.generation, held: e.held, owner: e.owner, connected: e.connected, protectedDocument: e.protectedDocument, protectedReason: e.protectedReason, url: e.url, notRunning: e.notRunning, control: e.controlEpoch ?? 0, closing: e.closing !== undefined || e.forgetting !== undefined, closeFailed: e.closeFailed === true,
      ...(e.problem && !e.connected ? { problem: e.problem } : {}), ...(attachedSpec(e) && !e.connected && e.closing === undefined && e.forgetting === undefined && userChromeAsking(e, this.chromeWaiting(key)) ? { waitingForChrome: true } : {}) };
  }
  async recoverClosed(key: string): Promise<boolean> {
    const e = this.entries.get(key); if (!e?.closeFailed) return false;
    const op = e.opEpoch;
    // Unattended, the session files clear every failed close but one saved as deliberate (closeRefused true). An entry saved before the reason
    // was kept (1.0.22 and earlier, closeRefused unset, no daemon identity) is cleared by them too: no shipped build wrote a deliberate mark, so
    // waiting for Restart left every upgraded user stuck in browser_closing.
    if (!await this.provenGone(e.daemonIdentity, e.closeTarget, e.closeTarget?.command ?? e.spec?.command ?? '', e.closeRefused === true)) return false;
    return this.sessionGate.run([key], token => {
      assertGateToken(token, key);
      if (this.entries.get(key) !== e || !e.closeFailed || e.opEpoch !== op) return false;
      e.native = undefined; e.closing = undefined; e.closeFailed = false; e.closeRefused = undefined; e.daemonIdentity = undefined; e.closeTarget = undefined;
      e.opEpoch = ++this.opSeq; this.save(); return true;
    });
  }
  /** The verdict, bounded: a check that does not answer is unknown, so no close waits on it forever. */
  private async judge(identity: DaemonIdentity | undefined, command: string): Promise<DaemonVerdict> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.judgeDaemon(identity, command).catch(() => 'unknown' as const), new Promise<DaemonVerdict>(resolve => { timer = setTimeout(() => resolve('unknown'), JUDGE_MS); })]); }
    finally { clearTimeout(timer); }
  }
  /** Nothing of the refused session runs: its recorded daemon is gone, or (no identity was recorded) the session's own files name
   * no live process. */
  private async provenGone(identity: DaemonIdentity | undefined, target: CloseTarget | undefined, command: string, refused = false): Promise<boolean> {
    if (validDaemonIdentity(identity)) return await this.judge(identity, command) === 'gone';
    // Session files cannot see helpers left behind, so a deliberate refusal is never cleared by them.
    if (refused) return false;
    try { return !!target && this.sessionGone(target); } catch { return false; }
  }
  /** A close that failed or did not answer in time. A deliberate refusal stands. A daemon proven to be this session's (identity
   * 'alive', the engine binary at that pid) that did not answer is stopped by its exact pid and must be seen gone within
   * STOP_DAEMON_MS; with no identity, only the session's own files can prove it gone. */
  private async settleFailedClose(identity: DaemonIdentity | undefined, target: CloseTarget | undefined, command: string, failure: unknown, refusedBefore: boolean): Promise<boolean> {
    if (deliberate(failure)) return false;
    if (!validDaemonIdentity(identity)) return this.provenGone(identity, target, command, refusedBefore);
    const verdict = await this.judge(identity, command);
    if (verdict !== 'alive' || !unanswered(failure)) return verdict === 'gone';
    try { this.stopDaemon(identity.pid, command); } catch { /* seen below */ }
    for (const deadline = Date.now() + STOP_DAEMON_MS; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 100)))
      if (await this.judge(identity, command) === 'gone') return true;
    return false;
  }
  async recoverClosedEntries(): Promise<void> {
    for (const [key, e] of this.entries) if (e.closeFailed) await this.recoverClosed(key);
  }
  private plan(key: string, e: Entry, run: (plan: Trailing) => Promise<BrowserStatus>): Trailing {
    e.opEpoch = ++this.opSeq;
    const plan: Trailing = { key, entry: e, op: e.opEpoch, run: () => run(plan) }; return plan;
  }
  private current(plan: Trailing) { return this.entries.get(plan.key) === plan.entry && plan.entry.opEpoch === plan.op && plan.entry.forgetting === undefined && !plan.entry.deleted; }
  private async trailingRefresh(plan: Trailing, wait = false) {
    if (!this.current(plan)) return this.statusOfPlan(plan);
    return this.refresh(plan.key, wait);
  }
  private statusOfPlan(plan: Trailing): BrowserStatus {
    const e = plan.entry;
    return { generation: e.generation, held: e.held, owner: e.owner, connected: false, notRunning: e.notRunning, protectedDocument: e.protectedDocument, protectedReason: e.protectedReason, url: e.url, control: e.controlEpoch ?? 0 };
  }
  async runTransition(key: string, step: (token: GateToken) => Trailing): Promise<BrowserStatus> {
    const plan = await this.sessionGate.run([key], step); return plan.run();
  }
  /** The engine is down: its own state and copy, never a page lock. */
  private notRunning(e: Entry) { this.disposeReads(e); e.notRunning = true; e.problem = BROWSER_NOT_RUNNING; e.connected = false; e.frame = undefined; }
  /** The owner's view, answered at once from what is known. A live view that is
   * not connected reconnects in the background, and its outcome shows on a
   * later read. `wait`: only after a restart, when the engine just answered. */
  async refresh(key: string, wait = false): Promise<BrowserStatus> {
    const e = this.entry(key);
    if (e.closing !== undefined || e.forgetting !== undefined) return this.status(key);
    if (!e.connected && (wait || !e.connecting) && (wait || !e.retryAt || Date.now() >= e.retryAt)) {
      // An attempt a restart or a control change has overtaken reports nothing.
      const generation = e.generation;
      const attempt = this.connect(key).then(() => {
        if (e.connected) { e.problem = undefined; e.notRunning = false; e.retryAt = undefined; }
      }, (error: unknown) => {
        if (e.generation !== generation) return;
        // The owner's Chrome: every new attempt is a new "Allow remote debugging?"
        // prompt, so a failed one waits for the owner's Try again (retry) or the
        // bot's next step, never a timer.
        e.retryAt = attachedSpec(e) ? Number.POSITIVE_INFINITY : Date.now() + RECONNECT_AFTER_MS;
        if (browserEngineDown(error)) this.notRunning(e);
        else e.problem = error instanceof Error && error.message ? error.message : BROWSER_NOT_ANSWERING;
      });
      if (wait) await attempt;
    }
    return this.status(key);
  }
  private native(e: Entry) { this.available(e); return e.native ??= this.factory(e.spec!); }
  private available(e: Entry) { if (e.closing !== undefined || e.forgetting !== undefined || e.deleted) throw transitionError('browser_closing'); }
  async connect(key: string) {
    const e = this.entry(key);
    if (e.connected || e.pending || e.closing !== undefined || e.forgetting !== undefined || e.deleted) return;
    if (e.connecting) return e.connecting;
    const generation = e.generation;
    const attempt = this.native(e).connect((frame) => {
      if (e.generation !== generation || frame.seq <= e.lastSeq) return;
      e.lastSeq = frame.seq; e.frame = { ...frame, generation };
    }, (url) => {
      if (e.generation === generation) e.url = url;
      // Where the owner went while holding control is theirs: saved storage never goes over it.
      if (e.held) e.native?.ownerReached?.(url);
    }, () => {
      if (e.generation !== generation) return;
      e.connected = false; e.frame = undefined; e.generation++; this.save();
    }).then((streamId) => { if (e.generation === generation) { if (e.streamId !== streamId) e.lastSeq = -1; e.streamId = streamId; e.connected = true; e.retryAt = undefined; } });
    // A restart drops this attempt; its end must not clear the next one.
    const tracked: Promise<void> = attempt.finally(() => { if (e.connecting === tracked) e.connecting = undefined; });
    e.connecting = tracked;
    await tracked;
  }
  private disposeReads(e: Entry) { e.readDocuments?.dispose(); e.readDocuments = undefined; }
  private fence(e: Entry) { this.disposeReads(e); e.controlEpoch = (e.controlEpoch ?? 0) + 1; e.generation++; e.frame = undefined; e.connected = false; e.native?.resetStream(); this.save(); }
  takeLocked(token: GateToken, key: string, owner: string): Trailing {
    const e = this.mutable(token, key);
    if (!owner) throw refusal();
    if (e.held && e.owner !== owner) throw new Error('Another owner session holds this browser profile');
    if (!e.held) { e.held = true; e.owner = owner; this.fence(e); }
    return this.plan(key, e, async plan => { await e.pending?.catch(() => {}); return this.trailingRefresh(plan); });
  }
  /** Hands every hold whose owner `stale` names back to the bot, whoever asked: the device that held it was revoked, made chat-only or ran out. */
  releaseHeldWhere(stale: (owner: string) => boolean): number {
    let released = 0;
    for (const e of this.entries.values()) if (e.held && e.owner !== null && stale(e.owner)) { e.held = false; e.owner = null; this.fence(e); released++; }
    return released;
  }
  take(key: string, owner: string) { return this.runTransition(key, token => this.takeLocked(token, key, owner)); }
  reclaimLocked(token: GateToken, key: string, owner: string): Trailing {
    const e = this.mutable(token, key); if (!owner) throw refusal(); e.held = true; e.owner = owner; this.fence(e);
    return this.plan(key, e, async plan => { await e.pending?.catch(() => {}); return this.trailingRefresh(plan); });
  }
  reclaim(key: string, owner: string) { return this.runTransition(key, token => this.reclaimLocked(token, key, owner)); }
  private human(e: Entry, owner: string, generation: number) {
    if (e.closeFailed) throw transitionError('browser_close_failed'); this.available(e);
    if (!e.held || e.owner !== owner || e.generation !== generation || e.pending) throw refusal();
  }
  releaseLocked(token: GateToken, key: string, owner: string, generation?: number, control?: number): Trailing {
    const e = this.mutable(token, key);
    if (control !== undefined) { if (!e.held || e.owner !== owner || e.pending || control !== (e.controlEpoch ?? 0)) throw refusal(); }
    else this.human(e, owner, generation ?? Number.NaN);
    e.held = false; e.owner = null; this.fence(e);
    const status = this.status(key);
    return this.plan(key, e, async plan => { try { await this.trailingRefresh(plan); } catch { /* a successor may have retired this key */ } return status; });
  }
  release(key: string, owner: string, generation?: number, control?: number) { return this.runTransition(key, token => this.releaseLocked(token, key, owner, generation, control)); }
  frame(key: string, generation: number) {
    const e = this.entry(key);
    if (e.generation !== generation) throw Object.assign(new Error("Browser frame generation is stale"), { status: 409 });
    return e.frame ?? null;
  }
  navigateLocked(token: GateToken, key: string, owner: string, generation: number, address: string): Trailing {
    const e = this.mutable(token, key); this.human(e, owner, generation);
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || address.length > 8192) throw new Error('Enter an HTTP or HTTPS address without embedded credentials');
    this.fence(e); const nextGeneration = e.generation;
    const n = this.native(e);
    return this.plan(key, e, async plan => {
      await n.command(['open', url.toString()]);
      await this.sessionGate.run([key], token => {
        assertGateToken(token, key); if (!this.current(plan)) throw refusal();
        this.human(e, owner, nextGeneration); e.url = url.toString(); e.opEpoch = ++this.opSeq;
      });
      return this.refresh(key);
    });
  }
  navigate(key: string, owner: string, generation: number, address: string) { return this.runTransition(key, token => this.navigateLocked(token, key, owner, generation, address)); }
  /** The owner's input. Take control, Return to bot and every bot step drop the
   * live view and reconnect it in the background (refresh), so the owner's first
   * click can arrive before the stream is back (1.0.3 gate B4b: 500 "Browser
   * stream disconnected or busy" right after Take control). Input waits for that
   * reconnect, then checks control again before anything reaches the page. */
  input(key: string, owner: string, generation: number, event: Record<string, unknown>): Promise<void> {
    const e = this.entry(key); this.human(e, owner, generation);
    if (JSON.stringify(event).length > 8192 || !["input_mouse", "input_keyboard", "input_touch"].includes(String(event.type))) throw new Error("Invalid browser input");
    if (event.type === "input_mouse" && (!["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(String(event.eventType)) || ![event.x, event.y].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10000))) throw new Error("Invalid pointer input");
    if (event.type === "input_keyboard" && (!["keyDown", "keyUp", "char"].includes(String(event.eventType)) || ["key", "code", "text"].some(k => event[k] !== undefined && (typeof event[k] !== "string" || (event[k] as string).length > 100)))) throw new Error("Invalid keyboard input");
    if (e.protectedReason !== "owner-input" && (event.type !== "input_mouse" || event.eventType === "mousePressed")) { e.protectedDocument = true; e.protectedReason = "owner-input"; this.save(); }
    if (e.connected) { this.native(e).input(event); return Promise.resolve(); }
    // The wait is bounded: a Take control that lands mid-handshake can leave the
    // pending connect unresolved for good, so the owner gets a retry message, not a hang.
    return (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(BROWSER_STILL_RECONNECTING), { status: 503 })), OWNER_INPUT_WAIT_MS);
      });
      try {
        // An attempt started before the last control change ends without connecting: one more, for this generation.
        await Promise.race([this.connect(key), deadline]);
        this.human(e, owner, generation);
        if (!e.connected) await Promise.race([this.connect(key), deadline]);
        this.human(e, owner, generation); this.native(e).input(event);
      } finally { clearTimeout(timer); }
    })();
  }
  reopenLocked(token: GateToken, key: string, owner: string, generation: number): Trailing {
    const e = this.mutable(token, key); this.human(e, owner, generation);
    return this.startCloseLocked(token, key, e, 'reopen', owner);
  }
  reopen(key: string, owner: string, generation: number) { return this.runTransition(key, token => this.reopenLocked(token, key, owner, generation)); }
  retryLocked(token: GateToken, key: string): Trailing {
    const e = this.mutable(token, key); e.retryAt = undefined; e.problem = undefined;
    return this.plan(key, e, plan => this.trailingRefresh(plan));
  }
  retry(key: string) { return this.runTransition(key, token => this.retryLocked(token, key)); }
  /** "Use my Chrome": the bot's own step reached the owner's Chrome, so the
   * connection is allowed. A live view that failed earlier may reconnect on its
   * next read (no new prompt: it shares the allowed connection) instead of
   * still saying Chrome did not connect. */
  noteChromeConnected(key: string) {
    const e = this.entries.get(key);
    if (!e || e.connected || e.closing !== undefined || e.forgetting !== undefined || !attachedSpec(e)) return;
    e.retryAt = undefined; e.problem = undefined;
  }
  /** Restart browser: the recovery for an engine that is not running. It stops
   * this profile's engine if any of it is left, starts a fresh one and
   * reconnects the live view. A page lock is untouched: the bot's next step
   * checks the page again, so a sensitive page still locks. */
  restartLocked(token: GateToken, key: string, owner: string): Trailing {
    const e = this.mutable(token, key, true);
    if (!owner) throw refusal();
    if (e.held && e.owner !== owner) throw new Error('Another owner session holds this browser profile');
    if (e.pending) throw new Error('This browser profile already has an action in progress');
    return this.startCloseLocked(token, key, e, 'restart', owner);
  }
  restart(key: string, owner: string) { return this.runTransition(key, token => this.restartLocked(token, key, owner)); }
  private startCloseLocked(token: GateToken, key: string, e: Entry, action: 'restart' | 'reopen' | 'forget' | 'shutdown', owner?: string): Trailing {
    assertGateToken(token, key);
    const retry = e.closeFailed === true;
    // Only the owner's Restart or Reopen may clear a refusal of unknown reason from session files. Shutdown and forget can run
    // unattended (a release retried later), like boot: a refusal they retry clears that way only when it was saved as not deliberate.
    const refusedBefore = e.closeRefused === true || ((action === 'shutdown' || action === 'forget') && retry && e.closeRefused !== false);
    // What a failed retry saves: an unattended retry treats a legacy refusal (saved before its reason was kept, closeRefused unset) as refused for
    // its own decision, but it never writes that guess down as deliberate: the owner's next Restart must still be able to clear it.
    const legacyKept = (action === 'shutdown' || action === 'forget') && retry && e.closeRefused === undefined;
    this.fence(e);
    const old = e.native; e.native = undefined; e.lastSeq = -1; e.connecting = undefined;
    const identity = old?.daemonIdentity ?? e.daemonIdentity;
    const target = e.closeTarget ?? (e.spec && e.botId ? { botId: e.botId, command: e.spec.command, socketDir: e.spec.env.AGENT_BROWSER_SOCKET_DIR!, session: e.spec.env.AGENT_BROWSER_SESSION! } : undefined);
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const plan = this.plan(key, e, async plan => {
      let failure: unknown; let n = old;
      try {
        if (action === 'forget') await e.pending?.catch(() => {});
        const verdict = await this.judge(identity, target?.command ?? e.spec?.command ?? '');
        if (verdict !== 'gone') {
          if (!n && retry) {
            if (!target) throw new Error('Browser close target unavailable');
            const spec = this.closeSpec?.(target) ?? { command: target.command, args: [], env: { AGENT_BROWSER_SOCKET_DIR: target.socketDir, AGENT_BROWSER_SESSION: target.session } };
            // Close-only: never installed, never connected, never issues a CLI command.
            n = await this.sessionGate.run([key], token => {
              assertGateToken(token, key);
              if (this.entries.get(key) !== e || e.opEpoch !== plan.op) throw refusal();
              return this.closeFactory(spec);
            });
            if (verdict === 'alive' && identity) n.seedDaemonIdentity?.(identity);
          }
          if (n) await boundedClose(n);
          else if (retry) throw new Error('Browser close acknowledgement unavailable');
        }
      } catch (error) { failure = error; }
      if (failure !== undefined && await this.settleFailedClose(identity, target, target?.command ?? e.spec?.command ?? '', failure, refusedBefore)) {
        console.warn(`[browser] close did not finish; ${validDaemonIdentity(identity) ? 'stopped its own engine process' : 'nothing of it is running any more'}, cleared`);
        failure = undefined;
      }
      let opened: NativeBrowser | undefined;
      try {
        await this.sessionGate.run([key], token => {
          assertGateToken(token, key);
          if (this.entries.get(key) !== e || (action === 'forget' ? e.forgetting !== plan.op : e.closing !== plan.op)) throw refusal();
          if (failure) {
            if (e.native === undefined) e.native = old;
            e.forgetting = undefined; e.closing = plan.op; e.closeFailed = true; e.closeRefused = e.closeRefused === true || deliberate(failure) ? true : legacyKept ? undefined : refusedBefore;
            e.daemonIdentity = identity; e.closeTarget = target && validCloseTarget(target) ? target : undefined;
            e.opEpoch = ++this.opSeq; this.save(); return;
          }
          e.forgetting = undefined; e.closing = undefined; e.closeFailed = false; e.closeRefused = undefined; e.daemonIdentity = undefined; e.closeTarget = undefined;
          e.problem = undefined; e.retryAt = undefined; e.notRunning = false;
          e.opEpoch = ++this.opSeq; plan.op = e.opEpoch;
          if (action === 'forget') {
            if (this.blocksCommit(key)) throw transitionError('held');
            e.deleted = true; this.entries.delete(key); this.save(); return;
          }
          if (action === 'reopen') {
            if (e.native !== undefined || !e.spec) throw transitionError('browser_reopen_failed', 503);
            opened = e.native = this.factory(e.spec);
          }
          this.save();
        });
      } finally {
        if (this.closingDone.get(key) === done) this.closingDone.delete(key);
        if (this.teardownDone.get(key) === done) this.teardownDone.delete(key);
        finish();
      }
      if (failure) throw transitionError('browser_close_failed', 503);
      if (action === 'forget' || action === 'shutdown') return this.statusOfPlan(plan);
      if (opened) {
        try {
          await opened.command(['open', 'about:blank']);
          await this.sessionGate.run([key], token => {
            assertGateToken(token, key);
            if (!this.current(plan) || e.native !== opened || !e.held || e.owner !== owner) throw refusal();
            e.protectedDocument = false; e.protectedReason = null; e.ownerTabs = undefined; e.botTab = undefined; e.url = ''; e.opEpoch = ++this.opSeq; plan.op = e.opEpoch; this.save();
          });
        } catch {
          throw Object.assign(new Error(BROWSER_REOPEN_FAILED), { status: 503 });
        }
      }
      return e.spec ? this.trailingRefresh(plan, true) : this.status(key);
    });
    e.closeFailed = false;
    if (action === 'forget') { e.forgetting = plan.op; this.teardownDone.set(key, done); }
    else { e.closing = plan.op; this.closingDone.set(key, done); }
    return plan;
  }
  /** Sean 1.0.20 ruling: the owner is never asked to hand a browser back. A protected page (sensitive, or the owner's input) is
   * left exactly where it is, and the bot gets a new blank tab of its own: every tab the browser lists now is recorded as the
   * owner's (never looked at again for the bot), one blank tab is opened, and the lock clears only once that tab checks clean.
   * Silent apart from one log line. False when it cannot be done (the owner holds control, a step is running, the browser
   * cannot tell its tabs apart, or the new tab failed): the page stays locked, as before. */
  async freshTab(key: string): Promise<boolean> {
    const e = this.entry(key); this.available(e);
    if (!e.protectedDocument) return true;
    // A move already under way (the turn start and a step at once): its outcome is this caller's too, never a false "locked".
    if (e.pending) { const generation = e.generation; await e.pending.catch(() => {}); return !e.protectedDocument && !e.held && e.generation === generation; }
    if (e.held || e.closeFailed) return false;
    const native = this.native(e);
    if (!native.pages) return false;
    const generation = e.generation; const reason = e.protectedReason ?? "owner-input";
    const run = async () => {
      const listed = await native.pages!();
      const kept = this.ownerTabsStill(e.ownerTabs, listed);
      const known = new Set(kept.map(t => t.id));
      const left = [...kept, ...listed.filter(t => !known.has(t.id)).map(t => ({ id: t.id, reason }))];
      if (left.length > MAX_OWNER_TABS) return false;
      // Murage's own new tab: it neither uses up nor is stopped by a notice the bot is owed for a closed tab.
      await native.request("tools/call", { name: "agent_browser_tab_new", arguments: {} }, { internal: true });
      const skip = new Set(left.map(t => t.id));
      // The bot's tab is the one new tab, pinned by id: exactly one listed tab outside the owner's, or nothing moves.
      const mine = (await native.pages!()).filter(t => !skip.has(t.id));
      if (mine.length !== 1) return false;
      if (await native.protected(false, skip)) return false;
      this.available(e);
      if (e.held || e.generation !== generation) return false;
      e.ownerTabs = left.length ? left : undefined; e.botTab = mine[0].id; e.protectedDocument = false; e.protectedReason = null; this.disposeReads(e); this.save();
      console.log(`[browser] protected page left to the owner; bot moved to a new blank tab (${reason})`);
      return true;
    };
    const pending = run(); e.pending = pending;
    try { return await pending.catch(() => false); } finally { if (e.pending === pending) e.pending = undefined; }
  }
  /** The owner's tabs the browser still lists: a tab the owner closed (or a browser that restarted) releases its record. A page
   * that only changed address is not released: a sign-in form's own redirect lands on the owner's private page with no owner step. */
  private ownerTabsStill(tabs: OwnerTab[] | undefined, listed: { id: string }[]): OwnerTab[] {
    return (tabs ?? []).filter(t => listed.some(p => p.id === t.id));
  }
  async dispatch(key: string, method: string, params: Record<string, unknown> = {}, authorize: () => boolean = () => false, options: { readScope?: string; authority?: ServiceAuthority } = {}): Promise<unknown> {
    const e = this.entry(key); this.available(e); const generation = e.generation;
    const noLimits = () => serviceOwnerNoLimits(options.authority);
    // Listing tools reads nothing from any page, so neither a protected page
    // nor the owner's hold refuses it: the bot keeps its tools and learns the
    // reason from the refusal of the call itself.
    if (method === "tools/list") {
      if (!authorize()) throw browserRefusal("browser_not_authorized");
      const result = await this.native(e).request(method) as { tools?: unknown };
      this.available(e);
      if (!authorize()) throw browserRefusal("browser_not_authorized");
      return { tools: listHeadlessBrowserTools(result.tools) };
    }
    if (method !== "tools/call") throw new Error("Unsupported browser method");
    const call = validateHeadlessBrowserCall(params.name, params.arguments ?? {});
    // Leaving a page the guard flagged by itself. Never a page the owner typed in.
    const leaving = call.name === "agent_browser_open" && typeof call.arguments.url === "string";
    // A protected page: the bot is moved to a new blank tab and the page is left to the owner. Opening an address goes on in that
    // tab; any other step was meant for the protected page, so it does not run and the bot is told it has a tab of its own.
    if (!noLimits() && e.protectedDocument && !e.held && authorize() && await this.freshTab(key)) {
      if (!leaving) throw browserRefusal("browser_fresh_tab");
    }
    if (e.ownerTabs?.length && e.native?.pages) {
      const kept = this.ownerTabsStill(e.ownerTabs, await e.native.pages().catch(() => e.ownerTabs!));
      if (kept.length !== e.ownerTabs.length) { e.ownerTabs = kept.length ? kept : undefined; if (!e.ownerTabs) e.botTab = undefined; this.save(); }
    }
    if (!noLimits() && e.ownerTabs?.length && OWNER_TAB_TOOLS.has(call.name)) throw browserRefusal("browser_protected_tab");
    const allowed = () => {
      this.available(e);
      if (!authorize()) throw browserRefusal("browser_not_authorized");
      if (e.held) throw browserRefusal("browser_held");
      if (e.generation !== generation) throw refusal();
      if (!noLimits() && e.protectedDocument && !(leaving && e.protectedReason === "sensitive-page")) throw protectionRefusal(e.protectedReason ?? "owner-input");
    };
    allowed(); if (e.pending) throw new Error("This browser profile already has an action in progress");
    // The engine went down during this step: nothing was read from the page,
    // so the profile is reported as not running, never as a sensitive page.
    let down = false;
    // While a tab is left to the owner, the bot has exactly ONE tab of its own, before and after every step. The engine acts on
    // its current tab and falls back to another tab by index when that one goes (a page script closing it, a crash), so with two
    // or more bot tabs it could land on the owner's tab while the page check passes on the bot's other one. Zero or two-plus: every
    // listed tab is recorded as the owner's, the bot is moved to a new blank tab, and the step does not run (or its result is withheld).
    let relocate = false;
    const oneBotTab = async (native: NativeBrowser, opening: boolean) => {
      if (noLimits() || !e.ownerTabs?.length) return;
      const owner = new Set(e.ownerTabs.map(t => t.id));
      const mine = native.pages ? (await native.pages()).filter(t => !owner.has(t.id)) : [];
      // The one tab must also be the bot's pinned tab: if the bot's tab closed itself after a page script opened another, the
      // engine may now be on the owner's tab while the one bot tab left is a different one.
      // No pinned tab (a state saved without one) is never taken on trust: the one tab left may be one the owner opened.
      if (mine.length === 1 && e.botTab === mine[0].id) {
        if (opening) throw browserRefusal("browser_protected_tab");
        return;
      }
      // Whatever this step may have read landed on a tab that might be the owner's: it is dropped, never kept for a later read.
      relocate = true; protect(e, "owner-input"); this.disposeReads(e); this.save();
      throw protectionRefusal(e.protectedReason!);
    };
    const run = async () => {
      const native = this.native(e);
      // Native Windows navigation can wait on an attached screencast. Keep
      // the viewer detached for the operation; connect() refuses to race the
      // in-flight action and the next owner status read restores the stream.
      native.resetStream(); e.connected = false; e.frame = undefined;
      // All frame/tab/value reads use this same barrier. No direct MCP mount.
      await oneBotTab(native, call.name === "agent_browser_tab_new");
      const skip = new Set((e.ownerTabs ?? []).map(t => t.id));
      const before = !noLimits() && await native.protected(true, skip);
      if (before && !leaving) { protect(e, "sensitive-page"); this.save(); throw protectionRefusal(e.protectedReason!); }
      allowed();
      // A mediated read makes its own page calls, so it is one step of the bot's tab lifecycle from beginStep to endStep (see
      // NativeBrowser): a tab replaced before it is told in place of the read, and one replaced or lost under it in place of its result.
      const read = async () => {
        const step = await native.beginStep?.(call.name);
        if (step && "notice" in step) return step.notice;
        let outcome: { result: unknown } | { error: unknown };
        // The reader's page calls are Murage's own, inside the bot's one step (see NativeBrowser.request `internal`).
        try { outcome = { result: await routeBrowserRead("unified", call.arguments, nativeReadPort({ request: (readMethod, readParams) => native.request(readMethod, readParams, { internal: true, ...(step ? { stepGen: step.gen } : {}) }) }, allowed,
          e.readDocuments ??= new WebDocuments(undefined, undefined, e.botId), options.readScope ?? (() => { throw Error("Browser read scope is required."); })(), () => serviceUnredactedRead(options.authority))) }; }
        catch (error) { outcome = { error }; }
        const moved = step ? await native.endStep?.(step.gen) : undefined;
        if (moved !== undefined) return moved;
        if ("error" in outcome) throw outcome.error;
        return outcome.result;
      };
      const result = call.name === "agent_browser_read" ? await read() : await native.request(method, call);
      allowed();
      await oneBotTab(native, false);
      const after = !noLimits() && await native.protected(true, skip);
      if (after) { protect(e, "sensitive-page"); this.save(); throw protectionRefusal(e.protectedReason!); }
      allowed();
      if (!noLimits() && e.protectedDocument) { e.protectedDocument = false; e.protectedReason = null; this.save(); }
      e.notRunning = false; e.problem = undefined;
      await this.connect(key); allowed(); return result;
    };
    const pending = run().catch((error: unknown) => {
      if (browserEngineDown(error)) down = true;
      else if (!isBrowserRefusal(error)) e.problem ??= BROWSER_NOT_ANSWERING;
      throw error;
    }).finally(async () => {
      if (down) { this.notRunning(e); return; }
      // Disarming can fail two ways. The engine is down: nothing to disarm and
      // nothing read, so it is not running. Anything else: the page may still
      // hold what the guard armed against, so it stays locked.
      try { await e.native?.protected(false, new Set((e.ownerTabs ?? []).map(t => t.id))); }
      catch (error) { if (browserEngineDown(error)) this.notRunning(e); else { protect(e, "sensitive-page"); this.save(); } }
    }); e.pending = pending;
    try { const result = await pending; allowed(); return result; }
    // The owner's own Chrome keeps its own words (remote debugging off, or Allow), set by the route.
    catch (error) {
      if (down && !e.spec?.env.AGENT_BROWSER_CDP) throw browserRefusal("browser_not_running");
      if (relocate) { if (e.pending === pending) e.pending = undefined; if (!e.held && authorize() && await this.freshTab(key)) throw browserRefusal("browser_fresh_tab"); }
      throw error;
    }
    finally { if (e.pending === pending) e.pending = undefined; }
  }
  async forgetEntry(key: string) {
    for (let round = 0; round < 3; round++) {
      if (this.closingDone.has(key) || this.teardownDone.has(key)) await this.waitForTeardown(key);
      const plan = await this.sessionGate.run([key], token => {
        const e = this.entries.get(key); if (!e) return null;
        if (e.forgetting !== undefined || (e.closing !== undefined && !e.closeFailed)) return undefined;
        if (this.blocksCommit(key)) throw transitionError('held');
        return this.startCloseLocked(token, key, e, 'forget');
      });
      if (plan === null) return;
      if (plan) { await plan.run(); return; }
    }
    throw transitionError('browser_closing');
  }
  forget(key: string) { return this.forgetEntry(key); }
  async close() {
    // Shutdown preserves holds and uncertain teardown. It cannot publish a
    // replacement native while any session is closing.
    await Promise.all([...this.entries.keys()].map(async key => {
      try {
        await this.waitForTeardown(key);
        const plan = await this.sessionGate.run([key], token => {
          const e = this.mutable(token, key, true); return this.startCloseLocked(token, key, e, 'shutdown');
        });
        await plan.run();
      } catch { /* state retains the refusal for the next launch */ }
    }));
  }
}
