// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one-tap fixes on the Health page (designs/HEALTH-DOCTOR.md section 6). Each does one thing the app can already
// do elsewhere and answers with one plain line for role="status". None of them retries by itself.
import { t } from "@/lib/i18n";
import { botRole, type RoleBot } from "@/lib/bot-role";
import { prefillBotChat } from "@/lib/compose-link";
import { runNowError, type BackupScheduleBridge } from "@/components/backups-section-ui";
import { refreshEngineHealth } from "@/components/today/use-engine-health";
import type { HealthFold } from "../../shared/health-levels";
import type { HealthIssue, HealthSummaryResponse } from "../../shared/sentinel-view";

type Api = (path: string, init?: RequestInit, busyTries?: number) => Promise<unknown>;

/** Turns that are running right now: a bot, one of its tasks, or a room. Switching an engine on reloads the engines
 * and ends every running answer, so it waits for these. */
export function answersRunning(state: { bots: ReadonlyArray<{ busy?: boolean; tasks?: ReadonlyArray<{ busy?: boolean }> }>; groups: ReadonlyArray<{ busy?: boolean; working?: boolean }> }): boolean {
  return state.bots.some((bot) => bot.busy || (bot.tasks ?? []).some((task) => task.busy)) || state.groups.some((group) => group.busy || group.working);
}

/** Switch on: the same PATCH Settings, Engines sends. Never while answers are running, never twice by itself. */
export async function switchEngineOn(engineId: string, running: boolean, call: Api, refresh: () => Promise<unknown> = refreshEngineHealth): Promise<string> {
  if (running) return t("ux.l2b.health.do.busy");
  try {
    // whenIdle: the server refuses (409) while any answer is running, checked in the same step that starts the change.
    await call(`/api/instances/${encodeURIComponent(engineId)}?whenIdle=1`, { method: "PATCH", body: JSON.stringify({ enabled: true }) }, 1);
  } catch (cause) {
    return (cause as { status?: number })?.status === 409 ? t("ux.l2b.health.do.busy") : t("ux.l2b.health.do.switchOnFailed");
  }
  await refresh().catch(() => {});
  return t("ux.l2b.health.do.switchedOn");
}

/** Check again: Flux Router is asked once, fresh, and the page reads the new answer. */
export async function recheckFlux(call: Api, refresh: () => Promise<boolean> = refreshEngineHealth): Promise<string> {
  try {
    await call("/api/engine-health/recheck", { method: "POST", body: "{}" }, 1);
  } catch {
    return t("ux.l2b.health.do.checkFailed");
  }
  // "Checked" only once the new answer is in.
  return (await refresh().catch(() => false)) ? t("ux.l2b.health.do.checked") : t("ux.l2b.health.do.checkFailed");
}

/** Back up now: the same desktop call the Backups page makes, with its own sentences for what stops it. */
export async function backUpNow(bridge: BackupScheduleBridge | undefined): Promise<string> {
  if (!bridge?.runNow) return t("ux.l2b.health.do.backupHere");
  try {
    const status = await bridge.status();
    await bridge.runNow(status.revision);
    return t("ux.l2b.health.do.backupStarted");
  } catch (cause) {
    return runNowError(cause);
  }
}

interface AskBot extends RoleBot { id: string; threadId: string; hidden?: boolean }

/** Ask your bot: the Chief of Staff, else the first bot; its chat with the question in the composer, not sent. */
export function askBotTarget<B extends AskBot>(bots: readonly B[]): B | undefined {
  const visible = bots.filter((bot) => !bot.hidden);
  return visible.find((bot) => botRole(bot) === "chief") ?? visible[0];
}

export function askYourBot<B extends AskBot>(question: string, bots: readonly B[], select: (botId: string) => void, prefill: typeof prefillBotChat = prefillBotChat): boolean {
  const bot = askBotTarget(bots);
  if (!bot) return false;
  select(bot.id);
  prefill({ botId: bot.id, threadId: bot.threadId }, question);
  return true;
}

// ---- The action ledger (designs/ALLCLEAR-V3-1023.md) ---------------------------------------------------------------
// One module-level ledger, so a Check again or Switch on that is still running survives the owner leaving Health and
// coming back. The page reads it with useSyncExternalStore and shows no all-clear while anything is pending.

/** What the page last accepted, kept so a remount during an action shows the findings at once. */
export interface HealthSnapshot { epoch: number; summary: HealthSummaryResponse; folds: HealthFold<HealthIssue>[]; engineKey: string }
interface LedgerLine { line: string; atExit: number }
export interface LedgerView {
  /** Moves on every begin, end and late completion: a read is accepted only under the epoch it started in. */
  epoch: number;
  pending: number;
  pendingKeys: ReadonlySet<string>;
  results: ReadonlyMap<string, LedgerLine>;
  /** READINGs that have exited, any outcome (the result-line expiry rule). */
  exitSeq: number;
  lastSnapshot: HealthSnapshot | null;
}

/** An action that has not ended this long after it began no longer holds the page back; the next read shows the truth. */
export const HEALTH_ACTION_WATCHDOG_MS = 30_000;

const ledger = { epoch: 0, exitSeq: 0, token: 0, pending: new Map<number, string>(), results: new Map<string, LedgerLine>(), lastSnapshot: null as HealthSnapshot | null };
const ledgerListeners = new Set<() => void>();
const buildView = (): LedgerView => ({ epoch: ledger.epoch, pending: ledger.pending.size, pendingKeys: new Set(ledger.pending.values()), results: new Map(ledger.results), exitSeq: ledger.exitSeq, lastSnapshot: ledger.lastSnapshot });
let view: LedgerView = buildView();
function notify() { view = buildView(); for (const listener of [...ledgerListeners]) listener(); }

export const subscribeHealthLedger = (listener: () => void) => { ledgerListeners.add(listener); return () => { ledgerListeners.delete(listener); }; };
export const readHealthLedger = (): LedgerView => view;

export function beginHealthAction(key: string): number {
  ledger.token += 1;
  ledger.epoch += 1;
  ledger.results.delete(key);
  ledger.pending.set(ledger.token, key);
  notify();
  return ledger.token;
}

/** Idempotent; the line is stored in the same write as the end. False when the token had already ended (watchdog). */
export function endHealthAction(token: number, line?: string): boolean {
  const key = ledger.pending.get(token);
  if (key === undefined) return false;
  ledger.pending.delete(token);
  ledger.epoch += 1;
  if (line) ledger.results.set(key, { line, atExit: ledger.exitSeq });
  notify();
  return true;
}

/** An action that finished after its watchdog: its real line is stored and the epoch moves, so one more read follows. */
function lateHealthAction(key: string, line?: string) {
  if (line) ledger.results.set(key, { line, atExit: ledger.exitSeq });
  ledger.epoch += 1;
  notify();
}

/** Runs a Check again / Switch on under the ledger. A throw shows no line (as at base); the watchdog ends it with none. */
export async function withHealthAction(key: string, run: () => Promise<string>): Promise<string | undefined> {
  const token = beginHealthAction(key);
  const watchdog = setTimeout(() => { endHealthAction(token); }, HEALTH_ACTION_WATCHDOG_MS);
  let line: string | undefined;
  try { line = await run(); } catch { line = undefined; } finally {
    clearTimeout(watchdog);
    if (!endHealthAction(token, line)) lateHealthAction(key, line);
  }
  return line;
}

/** A READING exited (any outcome). `accepted` is stored for a remount during the next action. */
export function healthReadExited(accepted?: HealthSnapshot) {
  ledger.exitSeq += 1;
  if (accepted) ledger.lastSnapshot = accepted;
  notify();
}

/** Drops result lines (page unmount for every key not pending; an independent accepted read for older lines). */
export function clearHealthResults(drop: (key: string, line: LedgerLine) => boolean) {
  let changed = false;
  for (const [key, entry] of [...ledger.results]) if (drop(key, entry)) { ledger.results.delete(key); changed = true; }
  if (changed) notify();
}

/** Tests only. */
export function resetHealthActionsForTests() {
  Object.assign(ledger, { epoch: 0, exitSeq: 0, token: 0, lastSnapshot: null });
  ledger.pending.clear(); ledger.results.clear(); ledgerListeners.clear();
  view = buildView();
}
