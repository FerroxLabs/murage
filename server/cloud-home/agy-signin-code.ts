// SPDX-License-Identifier: AGPL-3.0-or-later
// The in-chat Antigravity sign-in's code hand-off. Google shows the customer a one-time code after they allow
// access; agy's sign-in waits for it on a pty the home holds (the launcher's `login` mode, same relay as
// engine-login.ts). The code NEVER enters the message pipeline: it travels only through submit() below, from the
// dedicated route, to the held pty, once, and is then overwritten. Nothing here logs, stores or echoes it.
import { cloudHomeCopy } from "./copy.ts";

/** How long a pending sign-in waits for its code. */
export const SIGNIN_HOLD_TTL_MS = 10 * 60_000;
/** Shape of Google's authorization code ("4/0A..." with URL-safe characters). Narrow on purpose: it is also how
 * the /messages guard decides a pasted line is a code, and only while a sign-in is pending for that bot. */
export const SIGNIN_CODE_SHAPE = /^[A-Za-z0-9._~/+-]{20,512}$/;
export type SigninSubmit = "ok" | "none" | "bad" | "gone";

export class AgySigninHolds {
  private holds = new Map<string, { write: (data: Buffer) => boolean; expires: number }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  /** A sign-in is waiting for this bot's code. `write` sends bytes to its pty and says whether they landed. */
  hold(botId: string, write: (data: Buffer) => boolean): void {
    this.holds.set(botId, { write, expires: this.now() + SIGNIN_HOLD_TTL_MS });
  }
  has(botId: string): boolean {
    const hold = this.holds.get(botId);
    if (!hold) return false;
    if (hold.expires <= this.now()) { this.holds.delete(botId); return false; }
    return true;
  }
  drop(botId: string): void { this.holds.delete(botId); }
  /** Only while a sign-in is pending for this bot, and only for a line shaped like a code. */
  looksLikeCode(botId: string, text: string): boolean {
    return this.has(botId) && SIGNIN_CODE_SHAPE.test(text.trim());
  }
  /** Write the code to the held pty once and forget it. The hold is consumed whatever happens. */
  submit(botId: string, code: unknown): SigninSubmit {
    if (!this.has(botId)) return "none";
    const hold = this.holds.get(botId)!;
    if (typeof code !== "string" || !SIGNIN_CODE_SHAPE.test(code.trim())) return "bad";
    this.holds.delete(botId);
    const bytes = Buffer.from(`${code.trim()}\r`, "utf8");
    try { return hold.write(bytes) ? "ok" : "gone"; } finally { bytes.fill(0); }
  }
}
export const agySigninHolds = new AgySigninHolds();

/** The plain line the bot answers with when a code is pasted into the ordinary chat box. */
export const SIGNIN_CODE_IN_CHAT_NOTE = cloudHomeCopy.antigravityCodeBelongsInBox;
