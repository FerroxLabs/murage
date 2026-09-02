/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bind-address policy for the headless Murage server.
 *
 * THIS IS THE ONE FILE THAT MATTERS MOST. Wayland's installer defaults
 * `ALLOW_REMOTE=true`, which makes its webserver bind `0.0.0.0`; a plain deploy
 * therefore lands an admin UI on a public IP over cleartext HTTP, and Wayland's
 * own Dockerfile disagrees with its own installer about it. Murage inverts
 * that: there is no flag that produces a wildcard bind, at all. The only two
 * reachable answers are
 *
 *   loopback  127.0.0.1        — the default; `tailscale serve` fronts it
 *   tailnet   100.x / fd7a:…   — this host's OWN tailnet address, direct
 *
 * and the tailnet mode REFUSES TO RESOLVE when no tailnet address exists. A box
 * whose Tailscale enrolment failed does not silently fall back to something
 * reachable; it fails to start, loudly.
 */

import { isTailnetAddress, normalizeIp, tailnetIpv4, isLoopbackAddress } from "./network-trust.mjs";

/** Addresses that mean "every interface, including the public one". */
const WILDCARD = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "*", "0", "::0"]);

export const LOOPBACK = "127.0.0.1";

/** Raised for every refusal so callers can distinguish policy from crashes. */
export class BindRefused extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = "BindRefused";
    this.code = code;
  }
}

/**
 * Is this literal string a wildcard bind? Checked before anything else and
 * never overridable — an operator who wants the public internet in front of
 * Murage has to put a reverse proxy there themselves and own that decision.
 * @param {string | undefined | null} address
 * @returns {boolean}
 */
export function isWildcard(address) {
  if (address === undefined || address === null) return false;
  const value = normalizeIp(address);
  // An empty host is what `server.listen(port)` does with no address: it binds
  // every interface. Treat it as the wildcard it is.
  return value === "" || WILDCARD.has(value);
}

/**
 * Resolve the address the server must bind, or throw `BindRefused`.
 *
 * @param {object} [options]
 * @param {"loopback" | "tailnet" | string} [options.mode] MURAGE_BIND_MODE
 * @param {string} [options.address] MURAGE_BIND_ADDRESS, an explicit override
 * @param {Parameters<typeof tailnetIpv4>[0]} [options.probe] test seam
 * @returns {{ address: string, mode: "loopback" | "tailnet", reason: string }}
 */
export function resolveBindAddress(options = {}) {
  const probe = options.probe;
  const explicit = options.address?.trim();

  if (explicit) {
    if (isWildcard(explicit)) {
      throw new BindRefused(
        `refusing to bind ${explicit}: that is every interface, including the public one. ` +
          `Murage on a cloud box is reached over the tailnet, never over the public internet. ` +
          `Use MURAGE_BIND_MODE=loopback (default) or MURAGE_BIND_MODE=tailnet.`,
        "WILDCARD_REFUSED"
      );
    }
    if (isLoopbackAddress(explicit)) {
      return { address: normalizeIp(explicit), mode: "loopback", reason: "explicit loopback address" };
    }
    if (isTailnetAddress(explicit, probe)) {
      return { address: normalizeIp(explicit), mode: "tailnet", reason: "explicit tailnet address" };
    }
    throw new BindRefused(
      `refusing to bind ${explicit}: it is neither loopback nor one of this host's own ` +
        `tailnet addresses. Anything else exposes Murage outside the tailnet.`,
      "NOT_LOOPBACK_OR_TAILNET"
    );
  }

  const mode = (options.mode ?? "loopback").trim().toLowerCase();

  if (mode === "loopback" || mode === "") {
    return { address: LOOPBACK, mode: "loopback", reason: "loopback default" };
  }

  if (mode === "tailnet") {
    const ip = tailnetIpv4(probe);
    if (!ip) {
      throw new BindRefused(
        `MURAGE_BIND_MODE=tailnet but this host holds no tailnet address. ` +
          `Refusing to start rather than falling back to something reachable. ` +
          `Run \`murage setup\` to join the tailnet, or \`tailscale up\`, then retry.`,
        "NO_TAILNET_ADDRESS"
      );
    }
    return { address: ip, mode: "tailnet", reason: "this host's tailnet address" };
  }

  throw new BindRefused(
    `unknown MURAGE_BIND_MODE=${mode}. Valid: loopback (default), tailnet.`,
    "UNKNOWN_MODE"
  );
}

/**
 * Read the bind policy straight out of an env bag, applying the same refusals.
 * `HOST` and `MURAGE_HOST` are read too: an operator who has been told by some
 * other tutorial to "set HOST=0.0.0.0" gets a refusal with an explanation
 * rather than a public listener.
 * @param {Record<string, string | undefined>} [env]
 * @param {Parameters<typeof tailnetIpv4>[0]} [probe]
 */
export function resolveBindFromEnv(env = process.env, probe = undefined) {
  const legacy = env.MURAGE_BIND_ADDRESS ?? env.MURAGE_HOST ?? env.HOST;
  return resolveBindAddress({ mode: env.MURAGE_BIND_MODE, address: legacy, probe });
}
