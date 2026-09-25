// Is this client a phone? (spec §6 "phone mode")
//
// A phone pays for bytes and battery the desktop does not notice: live screen
// frames every few seconds, every thread's transcript at boot, a computer
// preview polled every 4 s. Those decisions all ask this one question, once
// per page load, so they can never disagree.
//
// A phone is the native shell (its user agent carries `MurageApp/`, spec
// §3.2), or a coarse pointer on a screen whose SHORT side is phone-sized. The
// short side of the screen, not the viewport width: a phone turned sideways
// is 844 px wide and is still a phone, and a desktop window dragged narrow is
// not one. The desktop app's bridge rules out a touch-screen laptop.

export interface PhoneProbe {
  userAgent: string;
  coarsePointer: boolean;
  /** min(screen.width, screen.height), CSS px. */
  shortSide: number;
  /** window.muragebox exists: the Electron preload ran. */
  desktopBridge: boolean;
}

/** Below Tailwind's md: the line NARROW_MEDIA_QUERY (lib/media-query.ts) draws. */
const PHONE_SHORT_SIDE = 768;
const NATIVE_SHELL = /\bMurageApp\//;

export function phoneClientFrom(probe: PhoneProbe): boolean {
  if (probe.desktopBridge) return false;
  if (NATIVE_SHELL.test(probe.userAgent)) return true;
  return probe.coarsePointer && probe.shortSide > 0 && probe.shortSide < PHONE_SHORT_SIDE;
}

let answer: boolean | undefined;

/** Asked once per page load; rotating the phone does not change it. */
export function isPhoneClient(): boolean {
  if (answer !== undefined) return answer;
  const screen = globalThis.screen;
  answer = phoneClientFrom({
    userAgent: globalThis.navigator?.userAgent ?? "",
    coarsePointer: globalThis.matchMedia?.("(pointer: coarse)").matches ?? false,
    shortSide: screen ? Math.min(screen.width, screen.height) : 0,
    desktopBridge: Boolean((globalThis as { muragebox?: unknown }).muragebox),
  });
  return answer;
}

/** A poll interval for a phone: half the rate, same shape (see ComputerPanel). */
export function phonePollMs(desktopMs: number, phone: boolean): number {
  return phone ? desktopMs * 2 : desktopMs;
}
