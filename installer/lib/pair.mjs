/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * `murage pair`: open a pairing window on this box's own companion, and hand
 * back what a phone needs: the `/enter#<token>` link for the QR, and the six
 * digits for a phone that types instead.
 *
 * The window is opened through the companion's loopback control page
 * (`companion/src/control.ts`, `POST /pairing`), the same call the desktop app
 * makes over IPC. That page refuses any request whose Origin is not its own
 * page's, so this client uses `node:http` and sends no Origin at all — the
 * case the page already admits for clients that are not browsers. `fetch` is
 * not used for the write: whether it adds an Origin is the runtime's
 * business, and a runtime that sent `Origin: null` would be refused.
 */

import { request } from "node:http";

export const DEFAULT_CONTROL_PORT = 8811;
const TOKEN = /^murage_pair_[A-Za-z0-9_-]{43}$/;
const CODE = /^\d{6}$/;
const DEFAULT_PORT = { http: 80, https: 443 };

/**
 * The control page's port, parsed the way `companion/src/index.ts` `num()`
 * parses it: anything that is not a usable port is the default.
 * @param {Record<string, string | undefined>} env
 */
export function controlPort(env = process.env) {
  const parsed = Number(env.MURAGE_CONTROL_PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_CONTROL_PORT;
}

/**
 * The QR link, by the desktop's rules (`src/lib/companion-pairing.ts`
 * `companionBrowserLink`). Null rather than a link that opens somewhere else:
 * the host comes from another process, and one `@` or `/` in it turns the
 * address a phone opens into a different machine's.
 * @param {{ scheme: string, host: string, port: number } | null | undefined} door
 * @param {string | null | undefined} token
 */
export function pairingLink(door, token) {
  const origin = doorOrigin(door);
  if (!origin || !token || !TOKEN.test(token)) return null;
  return `${origin}/enter#${token}`;
}

/** @param {{ scheme: string, host: string, port: number } | null | undefined} door */
function doorOrigin(door) {
  if (!door || (door.scheme !== "http" && door.scheme !== "https")) return null;
  if (!Number.isInteger(door.port) || door.port < 1 || door.port > 65_535) return null;
  const host = String(door.host ?? "").trim();
  if (!host || /[\s/\\?#@]/.test(host)) return null;
  const dialable = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = door.port === DEFAULT_PORT[door.scheme] ? "" : `:${door.port}`;
  return `${door.scheme}://${dialable}${port}`;
}

/**
 * One request to the control page, JSON back. Bounded in time and size: a
 * squatter on the port must not be able to hang or flood the CLI.
 * @param {number} port @param {string} method @param {string} path @param {number} timeoutMs
 * @returns {Promise<{ status: number, body: any }>}
 */
export function controlRequest(port, method, path, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, timeout: timeoutMs, headers: { accept: "application/json" } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1_000_000) req.destroy(new Error("the control page's answer was too large"));
        else chunks.push(chunk);
      });
      res.on("end", () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Open a pairing window. Replaces any window already open, exactly as the
 * desktop's "Create a new code" does (`devices.ts` `openPairing`).
 * @param {{ port: number, send?: typeof controlRequest }} opts
 */
export async function openPairing({ port, send = controlRequest }) {
  let answer;
  try {
    answer = await send(port, "POST", "/pairing", 5_000);
  } catch {
    return { ok: false, reason: `nothing answered on the companion's control page, 127.0.0.1:${port}. Is \`murage start\` running?` };
  }
  const body = answer.body ?? {};
  if (answer.status !== 201) {
    const said = typeof body.error === "string" ? body.error : `HTTP ${answer.status}`;
    return { ok: false, reason: `the companion did not open a pairing window: ${said}` };
  }
  const { token, code } = body;
  const expiresAt = body.pairing?.expiresAt;
  if (typeof token !== "string" || !TOKEN.test(token) || typeof code !== "string" || !CODE.test(code) || !Number.isSafeInteger(expiresAt)) {
    return { ok: false, reason: "something answered on the companion's control page, but not with a pairing window" };
  }
  const door = body.browser ?? null;
  return { ok: true, token, code, expiresAt, door, link: pairingLink(door, token), origin: doorOrigin(door) };
}

/**
 * Close the window this run opened, and only that one: a newer window opened
 * on the desktop in the meantime is left alone (`expectedToken`).
 * @param {{ port: number, token: string, send?: typeof controlRequest }} opts
 */
export async function closePairing({ port, token, send = controlRequest }) {
  try {
    const answer = await send(port, "DELETE", `/pairing?expectedToken=${encodeURIComponent(token)}`, 5_000);
    return answer.status === 200;
  } catch {
    return false;
  }
}

/** @param {number} expiresAt @param {number} now */
export function expiryText(expiresAt, now = Date.now()) {
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  if (left === 0) return "This code has expired.";
  return `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.`;
}

/** A sleep an abort wakes, so Ctrl-C does not wait out a poll interval.
 * @param {number} ms @param {AbortSignal} [signal] */
const pause = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
});

/**
 * The paired devices the companion offers to replace, least recently seen
 * first, when (and only when) it is at its limit: the control page's
 * `replaceCandidates`, the same list the desktop's pairing screen shows.
 * @param {any} state the control page's `/state`
 * @returns {{ id: string, name: string, lastSeenAt: number }[]}
 */
export function fullFleet(state) {
  const list = Array.isArray(state?.replaceCandidates) ? state.replaceCandidates : [];
  return list.filter((d) => typeof d?.id === "string" && /^[\w-]+$/.test(d.id))
    .map((d) => ({ id: d.id, name: typeof d.name === "string" && d.name ? d.name : "a device", lastSeenAt: Number(d.lastSeenAt) || 0 }));
}

/**
 * Remove one paired device, the way the desktop's "Replace" does: the
 * control page's ordinary revoke. Its sign-ins end at once.
 * @param {{ port: number, id: string, send?: typeof controlRequest }} opts
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function removeDevice({ port, id, send = controlRequest }) {
  if (typeof id !== "string" || !/^[\w-]+$/.test(id)) return { ok: false, reason: "that is not a device id. Run `murage devices` to list them." };
  let answer;
  try {
    answer = await send(port, "DELETE", `/devices/${id}`, 5_000);
  } catch {
    return { ok: false, reason: `nothing answered on the companion's control page, 127.0.0.1:${port}. Is \`murage start\` running?` };
  }
  if (answer.status === 200) return { ok: true };
  if (answer.status === 404) return { ok: false, reason: "no paired device has that id. Run `murage devices` to list them." };
  return { ok: false, reason: "the companion could not remove that device. Nothing was changed; try again." };
}

/**
 * Wait for the window to end, and say how.
 *
 * "Paired" is a device created after this window opened, rather than a count
 * that went up: re-pairing the same install replaces its record (spec §3.3),
 * which leaves the count where it was.
 * @param {{ port: number, token: string, expiresAt: number, openedAt: number, signal?: AbortSignal,
 *   onTick?: (text: string) => void, now?: () => number, sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>,
 *   send?: typeof controlRequest, intervalMs?: number }} opts
 */
export async function watchPairing({ port, token, expiresAt, openedAt, signal, onTick = () => {}, onFull = () => {}, now = Date.now,
  sleep = pause, send = controlRequest, intervalMs = 2_000 }) {
  let misses = 0;
  // A full fleet refuses every new phone ("replace an old one on your
  // computer"), so say so the moment it is seen, not only when the code
  // expires; and keep waiting, because removing a device (`murage devices
  // remove`) lets the same code work. A reinstalled phone takes back its own
  // slot, so a full fleet can still pair it.
  let full = null;
  for (;;) {
    if (signal?.aborted) return { outcome: "cancelled" };
    onTick(expiryText(expiresAt, now()));
    let state = null;
    try {
      state = (await send(port, "GET", "/state", 5_000)).body ?? {};
      misses = 0;
    } catch {
      if (++misses >= 3) return { outcome: "unreachable" };
    }
    if (state) {
      const candidates = fullFleet(state);
      if (candidates.length && !full) onFull(candidates);
      full = candidates.length ? candidates : null;
      if (state.pairing?.token !== token) {
        const devices = Array.isArray(state.devices) ? state.devices : [];
        const fresh = devices.filter((device) => Number(device?.createdAt) >= openedAt)
          .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0];
        if (fresh) return { outcome: "paired", device: typeof fresh.name === "string" && fresh.name ? fresh.name : "a new device" };
        if (state.pairing) return { outcome: "replaced" };
        if (now() >= expiresAt) return full ? { outcome: "full", devices: full } : { outcome: "expired" };
        return { outcome: "closed" };
      }
    }
    if (now() >= expiresAt) return full ? { outcome: "full", devices: full } : { outcome: "expired" };
    await sleep(intervalMs, signal);
  }
}
