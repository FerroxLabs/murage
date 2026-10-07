// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one refresher for MCP server sign-ins (MCP-LINK 3.7 step 9). One
// single-flight refresh per server. Proactive five minutes before expiry;
// reactive when the harness reports a rejected token (`murage:mcp-token-rejected`,
// which names the server and carries no credential), at most once per 30 s per
// server so a burst of 401s cannot storm the token endpoint.
//  - The rotated refresh token is saved BEFORE the new access token is pushed:
//    the old one may already be spent.
//  - A save that fails after the server rotated keeps the new bundle in memory
//    (and uses it) until a save succeeds.
//  - `invalid_grant` (or a 401) clears the tokens and keeps the client
//    registration; the harness then hears there is no token (needs sign-in).
//  - `invalid_client` stops the retry timer for that server and drops the client
//    registration and its refresh token (the next sign-in registers a new
//    client); the access token stays until it expires, and the card appears
//    when the server rejects it.
//  - Anything else (network, 5xx) erases nothing and retries in a minute.
import { clientOnly, withoutClient } from "./custody.mjs";
import { postTokenForm } from "./flow.mjs";

const SKEW_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const MIN_TIMER_MS = 30 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const REACTIVE_COOLDOWN_MS = 30 * 1000;

/**
 * @param {object} ctx
 * @param {(name: string) => any} ctx.read  the saved document
 * @param {(name: string, derive: (doc: any) => any) => Promise<any>} ctx.update  serialized save; resolves the kept doc (undefined: unchanged)
 * @param {(name: string, doc?: any) => Promise<unknown>} ctx.push  hand the harness its projection
 */
export function createRefresher(ctx) {
  const now = ctx.now ?? Date.now;
  const setTimer = ctx.setTimeout ?? setTimeout;
  const clearTimer = ctx.clearTimeout ?? clearTimeout;
  const log = ctx.log ?? (() => {});
  const running = new Map();
  const timers = new Map();
  const lastReactive = new Map();
  const unsaved = new Map();
  let disposed = false;

  /** The document to refresh from: an unsaved rotation wins while the saved
   * document still holds the refresh token it replaced. */
  function current(name) {
    const saved = ctx.read(name);
    const held = unsaved.get(name);
    if (held && saved?.oauth?.refreshToken === held.previousRefreshToken) return held.doc;
    unsaved.delete(name);
    return saved;
  }

  function cancelTimer(name) {
    const timer = timers.get(name);
    if (timer) clearTimer(timer);
    timers.delete(name);
  }

  function later(name, delay) {
    cancelTimer(name);
    if (disposed) return;
    const timer = setTimer(() => { timers.delete(name); void refresh(name); }, Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, delay)));
    timer?.unref?.();
    timers.set(name, timer);
  }

  function schedule(name) {
    const oauth = current(name)?.oauth;
    if (!oauth?.refreshToken || typeof oauth.expiresAt !== "number") { cancelTimer(name); return; }
    later(name, oauth.expiresAt - SKEW_MS - now());
  }

  function saveUnsavedLater(name) {
    if (disposed) return;
    const timer = setTimer(async () => {
      const held = unsaved.get(name);
      if (!held) return;
      try {
        await ctx.update(name, (doc) => doc?.oauth?.refreshToken === held.previousRefreshToken ? held.doc : undefined);
        if (unsaved.get(name) === held) unsaved.delete(name);
      } catch { saveUnsavedLater(name); }
    }, RETRY_MS);
    timer?.unref?.();
  }

  /** Resolves true when a fresh access token was pushed. */
  function refresh(name, { reactive = false } = {}) {
    const inFlight = running.get(name);
    if (inFlight) return inFlight;
    if (reactive) {
      if (now() - (lastReactive.get(name) ?? -Infinity) < REACTIVE_COOLDOWN_MS) return Promise.resolve(false);
      lastReactive.set(name, now());
    }
    const work = (async () => {
      const doc = current(name);
      const oauth = doc?.oauth;
      if (!oauth?.accessToken && !oauth?.refreshToken) return false;
      const markDead = async () => {
        unsaved.delete(name);
        cancelTimer(name);
        const kept = await ctx.update(name, (saved) => saved?.oauth?.refreshToken === oauth.refreshToken && saved?.oauth?.accessToken === oauth.accessToken
          ? { ...saved, oauth: clientOnly(saved.oauth), savedAt: now() }
          : undefined);
        if (kept) await ctx.push(name);
        return false;
      };
      if (!oauth.refreshToken) return markDead();
      const result = await postTokenForm({
        tokenEndpoint: oauth.tokenEndpoint, local: oauth.local, request: ctx.request, now,
        form: {
          grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: oauth.clientId,
          ...(oauth.resource ? { resource: oauth.resource } : {}),
          ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
        },
      });
      if (!result.ok) {
        if (result.failure === "dead") return markDead();
        if (result.failure === "client") {
          unsaved.delete(name);
          cancelTimer(name);
          await ctx.update(name, (saved) => saved?.oauth?.refreshToken === oauth.refreshToken && saved?.oauth?.clientId === oauth.clientId
            ? { ...saved, oauth: withoutClient(saved.oauth), savedAt: now() }
            : undefined);
          return false;
        }
        later(name, RETRY_MS);
        return false;
      }
      const tokens = result.tokens;
      const next = {
        ...doc,
        oauth: {
          ...oauth,
          accessToken: tokens.accessToken,
          issuedAt: now(),
          refreshToken: tokens.refreshToken ?? oauth.refreshToken,
          ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
          ...(tokens.scope ? { scope: tokens.scope } : {}),
        },
        savedAt: now(),
      };
      if (tokens.expiresAt === undefined) delete next.oauth.expiresAt;
      // Persist BEFORE push. A sign-out or a new sign-in that landed meanwhile wins.
      let pushed = next;
      try {
        const kept = await ctx.update(name, (saved) => saved?.oauth?.refreshToken === oauth.refreshToken || unsaved.get(name)?.doc === doc ? next : undefined);
        if (!kept) return false;
        unsaved.delete(name);
      } catch {
        const saved = ctx.read(name);
        if (saved?.oauth?.refreshToken !== oauth.refreshToken && unsaved.get(name)?.doc !== doc) return false;
        unsaved.set(name, { doc: next, previousRefreshToken: saved?.oauth?.refreshToken });
        pushed = next;
        saveUnsavedLater(name);
        log(`mcp server ${name}: a refreshed sign-in is held in memory until the credential store takes it`);
      }
      await ctx.push(name, pushed);
      schedule(name);
      return true;
    })().catch(() => { later(name, RETRY_MS); return false; }).finally(() => { running.delete(name); });
    running.set(name, work);
    return work;
  }

  return {
    refresh,
    schedule,
    /** Refresh now when the token is expired or close to it, else schedule. */
    resume(name, at = now()) {
      const oauth = current(name)?.oauth;
      if (!oauth?.refreshToken) return;
      if (typeof oauth.expiresAt === "number" && oauth.expiresAt - SKEW_MS <= at) void refresh(name);
      else schedule(name);
    },
    /** Wait for a refresh in flight (sign out and remove must not race one). */
    settle(name) { return running.get(name)?.catch(() => false) ?? Promise.resolve(false); },
    forget(name) { cancelTimer(name); unsaved.delete(name); lastReactive.delete(name); },
    heldDoc(name) { return unsaved.get(name)?.doc; },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
    },
  };
}
