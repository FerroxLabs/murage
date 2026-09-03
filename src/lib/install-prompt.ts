// Getting Murage onto a home screen, which is the difference between a link
// someone has to find again and an app they open.
//
// The two platforms could not be less alike and only one of them can be
// automated:
//
//   Android/Chromium fires `beforeinstallprompt` when a site is installable.
//   Capturing it and offering our own button is more reliable than waiting
//   for the browser's own banner, which is heuristic and often never shown.
//
//   iOS/WebKit fires nothing, ever. Apple provides no API to trigger or even
//   detect installability — Add to Home Screen lives in the Share sheet and
//   only a person can press it. Every PWA on iOS has this limitation. So the
//   only honest thing to offer there is a pointer at the Share button.
//
// Everything below is pure so the decision can be tested without a browser;
// `use-install-prompt.ts` is the only part that touches the DOM.

/** Remembered per browser, so a dismissal is not re-asked on every load. */
export const INSTALL_DISMISSED_KEY = "murage-install-dismissed";

export type InstallInvite = "hidden" | "prompt" | "manual";

export interface InstallFacts {
  /** Already running as an installed app. */
  standalone: boolean;
  /** `window.isSecureContext`. */
  secure: boolean;
  /** A captured `beforeinstallprompt`. */
  captured: boolean;
  /** iOS or iPadOS, where installation is manual and unpromptable. */
  ios: boolean;
  /** The person already said no. */
  dismissed: boolean;
}

/** Which invitation, if any, this browser should be shown.
 *
 * `secure` is checked before anything else and it is the check that matters
 * most here. Over plain HTTP no browser will install a site, whatever the
 * manifest says — which is exactly the state the door is in until remote
 * access is turned on. Showing the iOS hint there would be instructions for
 * something that cannot happen, and the person would follow them and get
 * nothing. Silence is the honest answer until the address is HTTPS. */
export function installInvite(facts: InstallFacts): InstallInvite {
  if (facts.standalone || !facts.secure || facts.dismissed) return "hidden";
  if (facts.captured) return "prompt";
  return facts.ios ? "manual" : "hidden";
}

/** iOS and iPadOS, including the iPad that reports itself as a Mac.
 *
 * Since iPadOS 13 a tablet sends a desktop Safari user agent, so the platform
 * check alone misses every iPad. Touch points is what separates it from a real
 * Mac — a trackpad reports 0 and a touchscreen reports several. */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  if (/iphone|ipad|ipod/i.test(userAgent)) return true;
  return /macintosh/i.test(userAgent) && maxTouchPoints > 1;
}
