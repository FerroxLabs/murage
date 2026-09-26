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
 * the session; only the owner's Reopen blank page hands it back. `sensitive-
 * page`: the document guard found a protected field, an embedded frame, or a
 * closed shadow root in a page the bot opened; the bot never saw it and may
 * leave it for another address. */
export type BrowserProtection = "owner-input" | "sensitive-page";

import { USER_CHROME_SETUP_MESSAGE } from "./user-chrome.ts";

const DO_NOT_ROUTE_AROUND = "Do not switch to another browser, a browser plugin, or run the browser program yourself.";

export const BROWSER_REFUSALS = {
  browser_protected_owner_input: `Murage's browser is protecting this page because the owner typed or clicked in it, so you cannot read it or act on it. Ask the owner to open your Browser panel and choose Take control, then Reopen blank page, then hand control back. ${DO_NOT_ROUTE_AROUND}`,
  browser_protected_sensitive_page: `Murage's browser is protecting this page because it has a password, one-time-code or payment field, an embedded frame, or content Murage cannot inspect, so you cannot read it or act on it. You can leave it by calling agent_browser_open with a different address; if that page is protected too, ask the owner to open your Browser panel and choose Take control, then Reopen blank page. ${DO_NOT_ROUTE_AROUND}`,
  browser_held: `The owner has taken control of this browser, so it refuses your reads and actions until they hand it back. Wait, or ask the owner in chat. ${DO_NOT_ROUTE_AROUND}`,
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
    ? " Your browser is locked: the owner typed or clicked in its page, so its tools are listed but every read and action is refused until the owner opens your Browser panel, chooses Take control and then Reopen blank page. If you need the browser, tell the owner that; never use another browser, a browser plugin, or run the browser program yourself instead."
    : " Your browser is locked: its page has a password, one-time-code or payment field, an embedded frame, or content Murage cannot inspect, so reads and actions on it are refused. Opening a different address with agent_browser_open clears the lock when that page is not protected; otherwise ask the owner to use Take control and then Reopen blank page in your Browser panel. Never use another browser, a browser plugin, or run the browser program yourself instead.";
}
