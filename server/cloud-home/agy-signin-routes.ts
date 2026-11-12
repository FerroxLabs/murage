// SPDX-License-Identifier: AGPL-3.0-or-later
// The two server entry points for Antigravity's in-chat sign-in code, kept apart from the message pipeline so a test can
// run them against the real store: the dedicated code route, and the /messages guard that stops a code pasted into the
// ordinary box. Neither stores, logs, forwards or echoes the code: it goes once to the held pty and is dropped.
import { AgySigninHolds, agySigninHolds, SIGNIN_CODE_IN_CHAT_NOTE } from "./agy-signin-code.ts";
import { cloudHomeCopy } from "./copy.ts";

export interface SigninCodeReply { status: number; body: Record<string, unknown> }

/** POST /api/bots/:id/engine-signin/code. `readBody` reads the tiny bound request body; `appendLine` writes one Murage line (never the code). */
export async function acceptSigninCode(input: {
  cloudHome: boolean; scope: string | undefined; botId: string;
  readBody: () => Promise<unknown>; appendLine: (text: string) => void; holds?: AgySigninHolds;
}): Promise<SigninCodeReply> {
  if (!input.cloudHome || input.scope !== "owner-desktop") return { status: 404, body: { error: cloudHomeCopy.noSuchRoute } };
  let code: unknown;
  try { code = ((await input.readBody()) as { code?: unknown } | null)?.code; } catch { return { status: 400, body: { error: cloudHomeCopy.engineLoginUnknownAction } }; }
  const outcome = (input.holds ?? agySigninHolds).submit(input.botId, code);
  code = undefined;
  if (outcome === "none" || outcome === "gone") return { status: 409, body: { error: cloudHomeCopy.antigravityNoSigninWaiting } };
  if (outcome === "bad") return { status: 400, body: { error: cloudHomeCopy.antigravityBadCode } };
  input.appendLine(cloudHomeCopy.antigravitySigninCodeEntered);
  return { status: 200, body: { ok: true } };
}

/** The /messages guard: a line shaped like a code while a sign-in is pending for this bot is neither stored nor sent
 * anywhere; the bot says where it goes. True when it swallowed the message. */
export function swallowPastedCode(input: { cloudHome: boolean; botId: string; text: string; appendLine: (text: string) => void; holds?: AgySigninHolds }): boolean {
  if (!input.cloudHome || !(input.holds ?? agySigninHolds).looksLikeCode(input.botId, input.text)) return false;
  input.appendLine(SIGNIN_CODE_IN_CHAT_NOTE);
  return true;
}
