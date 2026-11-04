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
