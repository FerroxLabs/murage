// SPDX-License-Identifier: AGPL-3.0-or-later
// The plain reason a bot is told when Murage for Chrome refuses or cannot finish a call. These are
// Murage's own sentences, chosen by an internal code; a page's words or an internal message never pass through.
const REASONS: Record<string, [number, string]> = {
  site_denied: [409, "The owner declined this site, or it is set to Never for this bot. Do not try it again unless the owner changes it."],
  site_consent_required: [409, "The owner has not allowed this site yet. Ask them to allow it, then try again."],
  stale_binding: [409, "Browser control changed while this ran (a pause, a stop, a site change or a new page), so its result was discarded. Take a new snapshot before the next step. If control is paused or stopped, ask the owner."],
  binding_inactive: [409, "Browser control is paused, stopped or not connected right now. Ask the owner to resume it in Murage for Chrome."],
  stale_document: [409, "The page changed while you were working. Take a new snapshot, then continue."],
  stale_generation: [409, "Browser control changed while this ran. Take a new snapshot before you continue."],
  action_approval_required: [409, "That step needs the owner's approval and did not get it."],
  invalid_approval: [409, "The owner's approval no longer matches this step, so it was not carried out. Ask again."],
  handover_required: [409, "This site needs the owner to use it directly. Murage will not read or act on it."],
  human_handover: [409, "This site needs the owner to use it directly. Murage will not read or act on it."],
  uncertain: [409, "Browser control paused because the last command may have run without a confirmed answer. Ask the owner to check the page before continuing."],
  command_timeout: [409, "The page did not answer in time. It may be busy or waiting on a dialog. Try again, or ask the owner to look."],
  response_too_large: [409, "The page answer was too large. Try a smaller part of the page."],
  clipboard_denied: [409, "Pasting, copying and select-all are not available in the owner's browser."],
  frame_mask_unavailable: [409, "A screenshot of this page could not be taken without showing another site's frame (a payment or sign-in form, for example). Take a snapshot instead."],
  binding_stopped: [409, "The owner stopped browser control for this task. Do not use the browser here unless the owner starts a new task."],
  download_policy_unavailable: [409, "The owner's browser could not be set to block downloads, so Murage did not act on this page."],
  tab_not_shared: [409, "That tab is not shared with you. Use the tab list tool to see your tabs."],
  tab_owned: [409, "Another bot already owns that tab."],
  binding_busy: [409, "A browser action is already running. Wait for it to finish."],
  browser_profile_busy: [409, "The owner's browser is busy with another bot. Try again in a moment."],
  profile_busy: [409, "The owner's browser is busy with another bot. Try again in a moment."],
  bootstrap_only: [409, "This is a blank tab. Open a page in it first."],
  host_offline: [409, "The owner's browser is not connected right now."],
  incompatible_capabilities: [409, "Update Murage for Chrome in the owner's browser to use it with this version of Murage. Ask the owner to update the extension."],
  update_murage: [409, "Update Murage on this computer to use this version of Murage for Chrome. Ask the owner to update the app."],
  binding_unauthorized: [409, "This turn can no longer use the owner's browser."],
};
/** An argument error is Murage's own text (browser-engine-policy), so it is passed on as written. */
export function extensionRefusal(error: unknown): { status: number; code: string; error: string } | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === -32602 && error instanceof Error && error.message.length < 300) return { status: 400, code: "browser_extension_arguments", error: error.message };
  if (typeof code !== "string") return undefined;
  const reason = REASONS[code];
  return reason ? { status: reason[0], code: `browser_extension_${code}`, error: reason[1] } : undefined;
}
/** What a bot reads when a Murage for Chrome call failed with no specific reason. It never tells the owner to open the side panel as
 * if that were the fix: the panel is usually open and connected, and the likelier causes are a card waiting in Murage or a dropped link. */
export const EXTENSION_CALL_FAILED_TEXT = "Murage for Chrome did not complete that step. Check Murage for a card waiting for the owner. If there is none, ask the owner to look at the Murage for Chrome side panel: it says whether it is connected. Then try again.";
