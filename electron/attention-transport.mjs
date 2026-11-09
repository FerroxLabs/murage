// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 section 5.2 #2 (S4a): the transports an action token captures at mint time. attention-actions.mjs never calls the
// server itself; it calls the transport it was minted with, so a profile switch, an old server run or a swapped Cloud window can never
// receive the answer. Both factories take injected effects (fetch, the live-identity probe) and tests use fakes.
//
// A transport is { current() -> identity string, readCard(entry, guard), post(body, guard) }. `guard()` throws to stop a send; the transport
// calls it immediately before EVERY network send (Cloud: fetchHome's beforeSend, which also covers the 401 refresh retry and the step-up retry).

const cardPath = entry => `/api/desktop/attention/card?threadId=${encodeURIComponent(entry.threadId)}&messageId=${encodeURIComponent(entry.messageId)}`;
const respondPath = entry => `/api/threads/${encodeURIComponent(entry.threadId)}/respond`;
const MAX_BODY = 64 * 1024;

async function readJson(response) {
  try {
    const text = await response.text();
    if (text.length > MAX_BODY) return null;
    return JSON.parse(text);
  } catch { return null; }
}

/** The card as attention-actions wants it: a 200 is an open card, a 404 is settled, anything else is a failed read (refused, never guessed). */
async function cardFrom(response) {
  if (response.status === 404) return { open: false };
  if (response.status !== 200) throw new Error(`card read ${response.status}`);
  const record = await readJson(response);
  if (!record || typeof record !== "object") throw new Error("card read unreadable");
  return { ...record, open: true };
}

async function resultFrom(response) {
  if (response.status >= 200 && response.status < 300) return { ok: true };
  const body = await readJson(response);
  return { ok: false, status: response.status, ...(typeof body?.code === "string" ? { code: body.code } : {}) };
}

/**
 * Local: { origin: "http://127.0.0.1:<port>", secret, fetchImpl, identity() }. `identity()` is the live snapshot string
 * (port | server epoch | data owner); the entry captured the same string at mint time. The secret never leaves this closure.
 */
export function createLocalTransport({ origin, secret, fetchImpl = fetch, identity }) {
  const headers = extra => ({ "x-murage-surface": "desktop", "x-murage-surface-secret": secret, ...extra });
  return {
    current: identity,
    async readCard(entry, guard) {
      guard();
      return cardFrom(await fetchImpl(origin + cardPath(entry), { headers: headers({}), signal: AbortSignal.timeout(5000), redirect: "error" }));
    },
    async post(body, guard, entry) {
      guard();
      return resultFrom(await fetchImpl(origin + respondPath(entry), { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify(body), signal: AbortSignal.timeout(8000), redirect: "error" }));
    },
  };
}

/**
 * Cloud: { client, homeId, windowId() }. `client.fetch(homeId, path, { beforeSend })` is cloud-home-client's fetchHome. The identity is
 * `${homeId}|${session generation}|${window id}`: a session established, replaced, refreshed or disconnected, or a swapped window, changes it.
 */
export function createCloudTransport({ client, homeId, windowId }) {
  const identity = () => `${homeId}|${client.sessionGeneration(homeId)}|${windowId()}`;
  return {
    current: identity,
    async readCard(entry, guard) {
      return cardFrom(await client.fetch(homeId, cardPath(entry), { beforeSend: guard }));
    },
    async post(body, guard, entry) {
      return resultFrom(await client.fetch(homeId, respondPath(entry), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), beforeSend: guard }));
    },
  };
}
