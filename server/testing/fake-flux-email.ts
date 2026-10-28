// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test support: a scripted fake of the Flux email API, handed to FluxEmailClient as its fetch. Nothing here reaches a network. Each script
// matches a method and a path pattern and answers once (or always); an unscripted call is recorded and answered 418, so a test can assert
// that nothing it did not expect was called.
export type FakeReply =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | "reset"
  | "timeout"
  | ((request: FakeRequest) => FakeReply | Promise<FakeReply>);

export interface FakeRequest { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: unknown; host: string }
interface Script { method: string; path: RegExp; reply: FakeReply; times: number }

export class FakeFlux {
  readonly requests: FakeRequest[] = [];
  readonly unexpected: FakeRequest[] = [];
  private readonly scripts: Script[] = [];

  /** Answer the next matching call (times = Infinity for always). Earlier scripts match first. */
  on(method: string, path: RegExp, reply: FakeReply, times = 1): this { this.scripts.push({ method, path, reply, times }); return this; }
  always(method: string, path: RegExp, reply: FakeReply): this { return this.on(method, path, reply, Number.POSITIVE_INFINITY); }
  calls(method: string, path: RegExp): FakeRequest[] { return this.requests.filter(request => request.method === method && path.test(request.path)); }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value;
    const request: FakeRequest = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, query: url.searchParams, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined, host: url.host };
    this.requests.push(request);
    const script = this.scripts.find(item => item.times > 0 && item.method === request.method && item.path.test(request.path));
    if (!script) { this.unexpected.push(request); return new Response(JSON.stringify({ error: "unscripted", message: "" }), { status: 418 }); }
    script.times--;
    let reply = script.reply;
    while (typeof reply === "function") reply = await reply(request);
    if (reply === "reset") throw new TypeError("fetch failed: socket hang up");
    if (reply === "timeout") {
      const signal = init?.signal;
      return new Promise<Response>((_, reject) => {
        if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    const body = reply.body === undefined ? null : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(reply.status === 204 ? null : body, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
}

/** A flat contract-3 error body. */
export const fluxError = (status: number, code: string, fields: Record<string, unknown> = {}): FakeReply => ({ status, body: { error: code, message: `${code} happened.`, ...fields } });

/** Flux #519: a key without the email scope (the spend key): 403 email_scope_required naming the scope it lacks. */
export const scopeRequired = (required: string[] = ["email:bot"]): FakeReply => fluxError(403, "email_scope_required", { required });
/** Billing #518: a send on a closing inbox (403 inbox_closing with closing_until, restorable). */
export const inboxClosing = (closingUntil: string): FakeReply => fluxError(403, "inbox_closing", { closing_until: closingUntil, restorable: true });
/** Billing #518: a send while the inbox is in grace (an existing credit code plus inbox_state "grace"). */
export const inGrace = (code = "credit_unresolved"): FakeReply => fluxError(402, code, { inbox_state: "grace" });

/** #3 inbox create is owner-only (Flux #516): the email:owner token gets `reply`; any other key (a bot's email:bot key) gets 403
 * owner_required, the way Flux answers it. */
export const ownerOnly = (ownerToken: string, reply: FakeReply): FakeReply => request =>
  request.headers.authorization === `Bearer ${ownerToken}` ? reply : fluxError(403, "owner_required");
