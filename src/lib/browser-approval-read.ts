// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reading and saving how a bot asks in the owner's browser (Use my Chrome setup step 3). The step ticks only on a mode the
// server itself stated: its stored mode on read, or its answer to a save. A save the server does not echo is read back before
// anything counts as known, and a read that fails is said as failed, never shown as the default. No imports, so the server
// tests drive it against the real routes.

export type ApprovalModeName = "step" | "task" | "full";
type Request = (path: string, init?: RequestInit) => Promise<unknown>;

export type ApprovalModeRead =
  | { read: "known"; mode: ApprovalModeName; actionCheck?: "flux" | "bot"; checkerAvailable?: boolean; checkerReason?: string; checkerFallback?: boolean }
  | { read: "failed" };

export const approvalModeUrl = (botId: string): string => `/api/bots/${encodeURIComponent(botId)}/browser-extension/mode`;

export function statedMode(value: unknown): ApprovalModeName | null {
  const mode = (value as { mode?: unknown } | null | undefined)?.mode;
  return mode === "step" || mode === "task" || mode === "full" ? mode : null;
}

/** The server's stored mode for this bot. A failed request, or an answer with no mode in it, is "failed". */
export async function readApprovalMode(request: Request, botId: string): Promise<ApprovalModeRead> {
  let result: unknown;
  try { result = await request(approvalModeUrl(botId)); } catch { return { read: "failed" }; }
  const mode = statedMode(result);
  if (!mode) return { read: "failed" };
  const body = result as { actionCheck?: unknown; checkerAvailable?: unknown; checkerReason?: unknown; checkerFallback?: unknown };
  return {
    read: "known",
    mode,
    actionCheck: body.actionCheck === "bot" || body.actionCheck === "flux" ? body.actionCheck : undefined,
    checkerAvailable: body.checkerAvailable === true,
    checkerReason: typeof body.checkerReason === "string" ? body.checkerReason : undefined,
    checkerFallback: body.checkerFallback === true,
  };
}

/** The save may have landed, but the server stated no mode after it (no echo, and the read back failed). The mode is unknown
 *  now: the caller must not keep showing the old one as the bot's. */
export class ModeNotConfirmed extends Error {
  constructor() {
    super("mode not confirmed");
    this.name = "ModeNotConfirmed";
  }
}

/** How a failed save leaves the mode: "unconfirmed" (it may have changed: read it again before showing any) or "refused" (the
 *  server said no, so the stored mode stands). */
export const approvalSaveOutcome = (cause: unknown): "unconfirmed" | "refused" => (cause instanceof ModeNotConfirmed ? "unconfirmed" : "refused");

/** Saves `next` and returns the mode the server holds afterwards: its echo, else a read back. Throws ModeNotConfirmed when
 *  neither states one. Full carries the typed bot name; the server checks it again. */
export async function saveApprovalMode(request: Request, botId: string, next: ApprovalModeName, confirmName?: string): Promise<ApprovalModeName> {
  let answer: unknown;
  try {
    answer = await request(approvalModeUrl(botId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next === "full" ? { mode: next, confirmName } : { mode: next }) });
  } catch (cause) {
    // The server refused it (a 4xx status rides on the error): checked before anything is stored, so the stored mode stands.
    const status = (cause as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) throw cause;
    // No answer came back (the connection dropped), or the server failed (5xx: a store error can come after the record was
    // written): the save may have landed. Only a read back can say.
    const back = await readApprovalMode(request, botId);
    if (back.read === "known" && back.mode === next) return next;
    throw new ModeNotConfirmed();
  }
  const echoed = statedMode(answer);
  if (echoed) return echoed;
  const back = await readApprovalMode(request, botId);
  if (back.read === "known") return back.mode;
  throw new ModeNotConfirmed();
}
