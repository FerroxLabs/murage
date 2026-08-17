// Companion devices — the phones allowed to reach this harness over the
// network. Everything here exists because of one fact: the harness has no
// authentication at all, and it is right not to have any on 127.0.0.1. The
// loopback socket IS the credential — the same reason the app can PUT an API
// key without proving anything. The moment a second socket leaves loopback
// that assumption is gone, so a device token becomes the credential instead.
//
// Tokens follow the same write-only rule as the keys in config.json: the
// token is generated once, handed to the phone at pairing, and never stored
// — devices.json keeps only its SHA-256. A stolen devices.json is not a
// stolen fleet.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureDataDir, writeFileAtomic } from "./state.ts";

export interface DeviceRecord {
  id: string;
  name: string;
  /** sha256 of the bearer token — never the token itself */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
}

/** What the UI is allowed to see: a device without its secret. */
export type PublicDevice = Omit<DeviceRecord, "tokenHash">;

/** A pairing window: one short-lived code, deliberately single-use.
 *
 * Six digits is only 1e6 possibilities, which is brute-forceable in seconds
 * against a LAN service — so the code is never the whole defence. It lives
 * for two minutes, dies after a handful of wrong guesses, and only exists at
 * all while the user is looking at the pairing screen. */
export interface PairingWindow {
  code: string;
  expiresAt: number;
  attemptsLeft: number;
}

const DEVICES_FILE = join(DATA_DIR, "devices.json");
export const PAIRING_TTL_MS = 120_000;
export const MAX_PAIRING_ATTEMPTS = 5;
/** Bounds the file, and a fleet of 20 phones is already an odd story. */
export const MAX_DEVICES = 20;
/** lastSeen is a UI nicety, not an audit log — don't write on every request. */
const LAST_SEEN_WRITE_MS = 60_000;

/** Hex digest. Tokens live on disk as one of these and never in the clear. */
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Constant-time compare of two hex digests of the same length. A plain ===
 * on a token hash leaks its prefix through timing; cheap to avoid. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Same treatment for the pairing code, which is compared far more often
 * than it is correct. */
function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Device names come from the phone, so they are untrusted display text:
 * clamp the length and drop control characters before they reach a UI. */
export function cleanDeviceName(raw: unknown): string {
  const name = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 60);
  return name || "Companion";
}

export class DeviceRegistry {
  private devices: DeviceRecord[] = [];
  private window: PairingWindow | null = null;
  private lastSeenWrites = new Map<string, number>();

  constructor() {
    try {
      const parsed = JSON.parse(readFileSync(DEVICES_FILE, "utf8"));
      if (Array.isArray(parsed?.devices)) {
        this.devices = parsed.devices.filter(
          (d: unknown): d is DeviceRecord =>
            typeof (d as DeviceRecord)?.id === "string" && typeof (d as DeviceRecord)?.tokenHash === "string",
        );
      }
    } catch {
      /* first run, or a file we can't read — start with no paired devices */
    }
  }

  /** Write the registry to disk, atomically. Throws — callers decide whether
   * the failure is worth surfacing; see redeem() and authenticate(). */
  private persist() {
    ensureDataDir();
    writeFileAtomic(DEVICES_FILE, JSON.stringify({ devices: this.devices }, null, 2));
  }

  /** Every paired device, minus the token digests. Safe for a UI. */
  list(): PublicDevice[] {
    return this.devices.map(({ tokenHash, ...rest }) => rest);
  }

  /** How many devices are paired, for the MAX_DEVICES ceiling. */
  count(): number {
    return this.devices.length;
  }

  /** The live pairing window, or null. Expiry is evaluated on read so a
   * stale window can never be redeemed by a caller that skipped a tick. */
  pairing(): PairingWindow | null {
    if (this.window && this.window.expiresAt <= Date.now()) this.window = null;
    return this.window;
  }

  /** Open a six-digit window, replacing any window already open. */
  openPairing(): PairingWindow {
    this.window = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      expiresAt: Date.now() + PAIRING_TTL_MS,
      attemptsLeft: MAX_PAIRING_ATTEMPTS,
    };
    return this.window;
  }

  /** Close the pairing window. Idempotent, and always safe to call. */
  closePairing() {
    this.window = null;
  }

  /** Redeem a pairing code for a device token.
   *
   * The token is returned exactly once, here. There is no endpoint that can
   * read it back — a phone that loses it pairs again. */
  redeem(code: string, name: unknown): { device: PublicDevice; token: string } | { error: string } {
    const window = this.pairing();
    if (!window) return { error: "no pairing is in progress — open Companion settings on your computer" };
    if (this.devices.length >= MAX_DEVICES) return { error: "too many paired devices — remove one first" };
    if (!sameCode(window.code, String(code ?? ""))) {
      window.attemptsLeft -= 1;
      // A burned window is the whole point: without this, six digits is a
      // few seconds of guessing.
      if (window.attemptsLeft <= 0) {
        this.closePairing();
        return { error: "too many incorrect codes — start pairing again" };
      }
      return { error: "that code is not right" };
    }
    this.closePairing();

    const token = `omb_${randomBytes(32).toString("base64url")}`;
    const device: DeviceRecord = {
      id: randomUUID(),
      name: cleanDeviceName(name),
      tokenHash: sha256(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.devices.push(device);
    // Unlike the lastSeenAt write, this one must not be swallowed. A device
    // that lives in memory but not on disk is paired until the next restart
    // and then silently is not — the phone keeps a token that stops working
    // for no reason it can show. Roll the registration back and say so, so
    // the user retries now rather than discovering it days later.
    try {
      this.persist();
    } catch (e) {
      this.devices.pop();
      return { error: `could not save the pairing: ${(e as Error).message}` };
    }
    const { tokenHash, ...pub } = device;
    return { device: pub, token };
  }

  /** Resolve a bearer token to its device, or null. */
  authenticate(token: string | undefined): DeviceRecord | null {
    if (!token) return null;
    const hash = sha256(token);
    const device = this.devices.find((d) => sameDigest(d.tokenHash, hash));
    if (!device) return null;
    const now = Date.now();
    if (now - (this.lastSeenWrites.get(device.id) ?? 0) > LAST_SEEN_WRITE_MS) {
      device.lastSeenAt = now;
      this.lastSeenWrites.set(device.id, now);
      // lastSeenAt decorates a row in a settings panel. A full disk or a
      // read-only home is a reason for it to be stale, never a reason for an
      // already-valid token to stop authenticating — which is what letting
      // this throw would mean, on every request, for the one user least able
      // to diagnose it.
      try {
        this.persist();
      } catch {
        /* the token is still good; the timestamp can wait */
      }
    }
    return device;
  }

  /** Forget a device. False when the id matched nothing, so a caller can
   * answer 404 rather than pretending it removed something. */
  revoke(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.lastSeenWrites.delete(id);
    this.persist();
    return true;
  }
}

/**
 * Pull the bearer token out of an Authorization header.
 *
 * The scheme is matched case-insensitively because RFC 7235 §2.1 says it is
 * case-insensitive, and a client that sends `bearer ` is not wrong. This used
 * to require the exact casing, which meant the sidecar had two parsers that
 * disagreed — the proxy's accepted `bearer `, this one did not — and which of
 * them a request met decided whether it authenticated.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() || undefined : undefined;
}
