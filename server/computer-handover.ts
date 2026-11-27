// SPDX-License-Identifier: AGPL-3.0-or-later

import { readBrowserFailure } from "../shared/browser-choice-eligibility.ts";

/** Browser to computer handover (1.0.22, MAIN R1/R2): when the browser routes cannot serve a turn and the bot's computer
 * mount is granted, the bot is told, as plain text every engine hears the same, to continue on the computer with one labelled
 * status line. The trigger list is closed. Nothing here mounts anything or changes a setting: every click still goes through
 * the computer's own approval, and with no computer mount (local control off, no destination) the text is empty, so the
 * existing "local control is not enabled" notice stays the only word. */
export type HandoverTrigger = "setup_required" | "not_connected" | "unavailable";

const TRIGGER_LABELS: Record<HandoverTrigger, string> = {
  setup_required: "the browser extension is not set up",
  not_connected: "the browser extension is not connected",
  unavailable: "the browser is not available this turn",
};

/** The handover happens only on "this computer" (local control on); the cloud box, VPS and VM have no local-computer card. */
export function handoverComputerGranted(kind: string | null): boolean {
  return kind === "local";
}

/** The real admission codes (shared/browser-choice-eligibility.ts) that mean the browser route cannot serve the turn.
 * Everything else (paused, handed off, allow not given, stopped, reserved, still checking, an uncoded reason) waits for the
 * owner or the check and never hands over. A retired mount (F1) and mid-turn failures join through the prompt text below. */
const TRIGGER_BY_CODE: Record<string, HandoverTrigger> = {
  browser_extension_setup_required: "setup_required",
  browser_extension_not_ready: "not_connected",
  host_offline: "not_connected",
  chrome_closed: "not_connected",
  debugging_off: "not_connected",
  builtin_missing: "unavailable",
  builtin_check_failed: "unavailable",
  builtin_restart: "unavailable",
  browser_sandbox_enable: "unavailable",
  browser_release_failed: "unavailable",
};

export function handoverTriggerForUnavailable(code: string | undefined): HandoverTrigger | undefined {
  return code !== undefined && Object.hasOwn(TRIGGER_BY_CODE, code) ? TRIGGER_BY_CODE[code] : undefined;
}

/** The one status line the bot says before it carries on, labelled so the owner sees why the route changed. */
export function handoverStatusLine(trigger: HandoverTrigger): string {
  return `Switching to the computer: ${TRIGGER_LABELS[trigger]}, so I'll use the screen instead.`;
}

const HOW = "Read the window's accessibility tree first and take a screenshot second. Every action on the computer still asks the owner first. Never solve a captcha or type a password yourself: stop and ask the owner to do that step on the screen.";

/** No browser tools are mounted this turn (extension not ready, mount refused or retired, tab already gone). */
export function computerHandoverUnmounted(trigger: HandoverTrigger | undefined, computerGranted: boolean): string {
  if (!computerGranted || !trigger) return "";
  return ` BROWSER TO COMPUTER: the browser route cannot serve this turn. Say exactly one line, "${handoverStatusLine(trigger)}", then continue the task with the computer tools. ${HOW} This replaces any earlier instruction to wait for the browser or to request a browser connection: do not end your turn to wait. Do not say you browsed.`;
}

/** Browser tools are mounted and so is the computer: what to do if the browser fails during the turn. */
export function computerHandoverMounted(computerGranted: boolean): string {
  if (!computerGranted) return "";
  return ` BROWSER TO COMPUTER: if a browser tool reports browser_extension_setup_required, the extension is not connected, tab_gone twice, or the site blocks automation (a captcha page, a bot check or a 403), do not retry the browser. Say exactly one line, "Switching to the computer: <what failed>, so I'll use the screen instead.", and continue with the computer tools. ${HOW}`;
}

/** The browser layer's handover addendum for one turn. */
export function computerHandoverLayer(input: { browserMounted: boolean; trigger?: HandoverTrigger; computerGranted: boolean }): string {
  return input.browserMounted ? computerHandoverMounted(input.computerGranted) : computerHandoverUnmounted(input.trigger, input.computerGranted);
}

/** The mount site's whole handover step for one turn: the admission reason the browser mint refused with (if any), whether
 * browser tools are mounted, and the bot's computer kind in; the prompt addendum out. index.ts appends exactly this. */
export function handoverLayerForTurn(input: { unavailable?: string; browserMounted: boolean; computerKind: string | null }): string {
  const trigger = input.unavailable === undefined ? undefined : handoverTriggerForUnavailable(readBrowserFailure(input.unavailable)?.code);
  return computerHandoverLayer({ browserMounted: input.browserMounted, trigger, computerGranted: handoverComputerGranted(input.computerKind) });
}
