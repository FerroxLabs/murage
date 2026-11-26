// Why a bot's built-in browser is refusing it, in the words the bot is given.
//
// A protected profile is a privacy barrier, not a broken browser. It used to
// refuse everything, tools/list included, with one generic sentence that the
// proxy then swallowed: the engine connected a browser with no tools while the
// prompt still promised one, and bots quietly reached for other browsers. Each
// cause now has its own sentence, the tool refusal and the turn prompt say the
// same thing, and both say what to do instead of what not to do only.

/** Why the profile is protected. `owner-input`: the owner typed or clicked in
 * the page while holding control, so something only the owner knows may be in
 * the session; the bot is moved to a new blank tab and never sees it. `sensitive-
 * page`: the document guard found a protected field, an embedded frame, or a
 * closed shadow root in a page the bot opened; the bot never saw it and may
 * leave it for another address. */
export type BrowserProtection = "owner-input" | "sensitive-page";

import { USER_CHROME_SETUP_MESSAGE } from "./user-chrome.ts";
import { murageTool, murageToolOnThisServer } from "./murage-tool-surface.ts";

const DO_NOT_ROUTE_AROUND = "Do not switch to another browser, a browser plugin, or run the browser program yourself.";
/** "Use my Chrome": the bot's own tab was closed in the owner's Chrome and Murage opened a new one (browser-native-relay.ts). Said to the
 * bot once. The step may have run before the tab closed (a page that closes itself after a submit), and the owner may already have put a
 * page in the new tab, so neither "did not run" nor "blank" is promised. */
export const BROWSER_TAB_REPLACED = `Your browser tab was closed, so Murage opened a new tab for you and the page you were on is gone. Your last step may not have finished. Call ${murageToolOnThisServer("agent_browser_open")} with the address you need, and check the page before you repeat anything that sends or submits. ${DO_NOT_ROUTE_AROUND}`;
/** The same, when no new tab could be opened (the owner's Chrome is closing or not answering). Said in place of the engine's own advice. */
export const BROWSER_TAB_CLOSED = `Your browser tab was closed and Murage could not open a new one just now, so this step did not finish. Try the step once more. If it fails again, tell the owner that their Chrome may be closed. ${DO_NOT_ROUTE_AROUND}`;

export const BROWSER_REFUSALS = {
  browser_protected_owner_input: `Murage's browser is protecting this page because the owner typed or clicked in it, so you cannot read it or act on it. The page stays the owner's: your next browser call opens a new blank tab of your own. ${DO_NOT_ROUTE_AROUND}`,
  browser_protected_sensitive_page: `Murage's browser is protecting this page because it has a password, one-time-code or payment field, an embedded frame, or content Murage cannot inspect, so you cannot read it or act on it. You can leave it by calling ${murageToolOnThisServer("agent_browser_open")} with a different address: it opens in a new blank tab of your own and the protected page is left untouched. ${DO_NOT_ROUTE_AROUND}`,
  // Sean 1.0.20 ruling: the owner is never asked to hand a browser back. A protected page is left as it is and the bot works on in a new blank tab.
  browser_fresh_tab: `That page is protected, so Murage left it untouched and opened a new blank tab for you; this step did not run. Call ${murageToolOnThisServer("agent_browser_open")} with the address you need. ${DO_NOT_ROUTE_AROUND}`,
  browser_protected_tab: `A protected tab in this browser stays the owner's, so listing, switching, opening more or closing tabs, and closing the browser, are off while it is open. Work in the one tab you have: call ${murageToolOnThisServer("agent_browser_open")} with the address you need. ${DO_NOT_ROUTE_AROUND}`,
  browser_held: `The owner has taken control of this browser, so it refuses your reads and actions until they hand it back. Wait, or ask the owner in chat. ${DO_NOT_ROUTE_AROUND}`,
  // The engine stopped (often its idle exit) and could not start again in
  // time. Nothing about the page: the next call starts it again.
  browser_not_running: `Murage's browser is not running right now, so this step did not run. Your next browser call starts it again, so try the same step once more. If it still does not start, ask the owner to open your Browser panel and choose Restart browser. ${DO_NOT_ROUTE_AROUND}`,
  browser_control_changed: "Browser control changed while this action ran, so its result was discarded. Take a fresh snapshot before you continue.",
  browser_not_authorized: "This turn can no longer use the browser.",
  // "Use my Chrome" (server/user-chrome.ts). Remote debugging off or Chrome
  // closed: the designed setup sentence, so the owner learns how to turn it on.
  browser_user_chrome_off: `${USER_CHROME_SETUP_MESSAGE} Tell the owner exactly this. ${DO_NOT_ROUTE_AROUND}`,
  browser_user_chrome_allow: `The owner's Chrome did not let Murage connect: Chrome asks the owner to Allow each new connection, and it was not allowed in time or was denied. Ask the owner to click Allow when Chrome asks, then try again. ${DO_NOT_ROUTE_AROUND}`,
} as const;
export type BrowserRefusalCode = keyof typeof BROWSER_REFUSALS;

export function browserRefusal(code: BrowserRefusalCode): Error & { status: 409; code: BrowserRefusalCode } {
  return Object.assign(new Error(BROWSER_REFUSALS[code]), { status: 409 as const, code });
}
export function protectionRefusal(protection: BrowserProtection) {
  return browserRefusal(protection === "owner-input" ? "browser_protected_owner_input" : "browser_protected_sensitive_page");
}
/** Only refusals Murage wrote for the bot carry one of these codes; anything
 * else (a native error that could quote the page) is never forwarded. */
export function isBrowserRefusal(error: unknown): error is Error & { status: number; code: BrowserRefusalCode } {
  const code = (error as { code?: unknown } | null)?.code;
  return error instanceof Error && typeof code === "string" && Object.hasOwn(BROWSER_REFUSALS, code);
}

/** The turn-start note, appended to the browser prompt while the profile is
 * protected. Stable for as long as the lock lasts, so it caches like the rest
 * of the prefix. */
export function browserLockTurnNote(protection: BrowserProtection): string {
  return protection === "owner-input"
    ? " Your browser is locked: the owner typed or clicked in its page, so that page stays the owner's. Your next browser call opens a new blank tab of your own; never use another browser, a browser plugin, or run the browser program yourself instead."
    : ` Your browser is locked: its page has a password, one-time-code or payment field, an embedded frame, or content Murage cannot inspect, so reads and actions on it are refused. Opening a different address with ${murageTool("agent_browser_open", "browser")} clears the lock: it opens in a new blank tab of your own and the protected page is left untouched. Never use another browser, a browser plugin, or run the browser program yourself instead.`;
}
