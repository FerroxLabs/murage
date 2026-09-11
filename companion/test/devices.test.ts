// Companion device registry contract. The three properties that matter:
// a token is never recoverable from disk, pairing credentials are one-time,
// a manual code cannot be ground down by guessing, and revocation works.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../src/state.ts";
import {
  bearerToken,
  cleanDeviceName,
  DeviceRegistry,
  MAX_PAIRING_ATTEMPTS,
  PAIRING_TTL_MS,
  REGISTRY_RETRY_MS,
} from "../src/devices.ts";

const pair = (registry: DeviceRegistry, name = "iPhone") => {
  const { code } = registry.openPairing();
  const result = registry.redeem(code, name);
  if ("error" in result) throw new Error(`pairing failed: ${result.error}`);
  return result;
};

describe("DeviceRegistry", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("issues a token that authenticates, and never stores it", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);

    expect(token.startsWith("murage_")).toBe(true);
    expect(registry.authenticate(token)?.id).toBe(device.id);

    // the file on disk holds a digest, not the credential
    const raw = readFileSync(join(DATA_DIR, "devices.json"), "utf8");
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw).devices[0].tokenHash).toHaveLength(64);

    // and nothing the UI can read exposes it either
    expect(JSON.stringify(registry.list())).not.toContain(token);
    expect(registry.list()[0]).not.toHaveProperty("tokenHash");
  });

  it("closes only the pairing window named by an expected token", () => {
    const registry = new DeviceRegistry();
    const first = registry.openPairing();
    const second = registry.openPairing();

    expect(registry.closePairing(first.token)).toBe(false);
    expect(registry.pairing()?.token).toBe(second.token);
    expect(registry.closePairing(second.token)).toBe(true);
    expect(registry.pairing()).toBeNull();
  });

  it("survives a restart", () => {
    const { token } = pair(new DeviceRegistry());
    expect(new DeviceRegistry().authenticate(token)).not.toBeNull();
  });

  // A record written by an older build, or edited by hand, can be missing
  // everything except the two fields that make it a device at all. Reading it
  // back as-is puts "undefined" and "Last seen NaN" on the pairing page.
  it("completes a record that is missing its labels", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);

    const file = join(DATA_DIR, "devices.json");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    delete stored.devices[0].name;
    delete stored.devices[0].lastSeenAt;
    delete stored.devices[0].createdAt;
    delete stored.devices[0].cloudDesktopAccess;
    writeFileSync(file, JSON.stringify(stored));

    const reloaded = new DeviceRegistry();
    const [listed] = reloaded.list();
    expect(listed.id).toBe(device.id);
    expect(listed.name).toBe("Companion");
    expect(Number.isFinite(listed.lastSeenAt)).toBe(true);
    expect(Number.isFinite(listed.createdAt)).toBe(true);
    expect(listed.cloudDesktopAccess).toBe(false);
    // and the token it was paired with still works
    expect(reloaded.authenticate(token)?.id).toBe(device.id);
  });

  // POSIX only. Windows has no mode bits — `stat` reports a synthesised 0666
  // for anything not marked read-only, and the mode arguments this asserts on
  // are ignored when the file is created. Access there is an ACL question,
  // and the data directory sits under the user's own profile, which is
  // already not readable by other accounts. Skipped rather than loosened: an
  // assertion that passes by measuring nothing is worse than no assertion.
  it.skipIf(process.platform === "win32")(
    "keeps token hashes out of reach of other accounts on the machine",
    () => {
      pair(new DeviceRegistry());
      // 0700 on the directory, 0600 on the file. A hash is an offline target
      // for anyone who can read it, and this process is the only reader.
      expect(statSync(DATA_DIR).mode & 0o777).toBe(0o700);
      expect(statSync(join(DATA_DIR, "devices.json")).mode & 0o777).toBe(0o600);
    },
  );

  it("refuses unknown, empty, and near-miss tokens", () => {
    const registry = new DeviceRegistry();
    const { token } = pair(registry);

    expect(registry.authenticate(undefined)).toBeNull();
    expect(registry.authenticate("")).toBeNull();
    expect(registry.authenticate("murage_nope")).toBeNull();
    expect(registry.authenticate(token.slice(0, -1))).toBeNull();
    expect(registry.authenticate(`${token}x`)).toBeNull();
  });

  it("burns the pairing window after too many wrong codes", () => {
    const registry = new DeviceRegistry();
    const { code } = registry.openPairing();
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 1; i < MAX_PAIRING_ATTEMPTS; i++) {
      expect(registry.redeem(wrong, "iPhone")).toEqual({
        error: "that pairing credential is not right",
        reason: "wrong",
      });
      expect(registry.pairing()).not.toBeNull();
    }
    // the last one closes the window rather than counting down forever
    expect(registry.redeem(wrong, "iPhone")).toMatchObject({ error: expect.stringContaining("start pairing again") });
    expect(registry.pairing()).toBeNull();

    // and the real code is worthless now — and says so as itself, rather than
    // as "no pairing is in progress", which would send the person looking for
    // a fault in the app instead of pressing Refresh on the pairing screen.
    expect(registry.redeem(code, "iPhone")).toEqual({
      error: "that code was cancelled after too many wrong guesses — start pairing again on your computer",
      reason: "burned",
    });
    expect(registry.count()).toBe(0);
  });

  it("spends a code exactly once", () => {
    const registry = new DeviceRegistry();
    const { code } = registry.openPairing();
    expect(registry.redeem(code, "iPhone")).toHaveProperty("token");
    expect(registry.redeem(code, "iPad")).toEqual({
      error: "that code has already signed a device in — open Phone settings on your computer for a new one",
      reason: "used",
    });
    expect(registry.count()).toBe(1);
  });

  it("points an out-of-window pairing attempt to Phone settings", () => {
    expect(new DeviceRegistry().redeem("000000", "iPhone")).toEqual({
      error: "no pairing is in progress — open Phone settings on your computer",
      reason: "no-pairing",
    });
  });

  it("replays one logical redemption without creating an orphan device", () => {
    const registry = new DeviceRegistry();
    const { token: credential } = registry.openPairing();
    const requestId = "4c825d5b-cf40-4db7-aac5-2455f805a8ec";

    const first = registry.redeem(credential, "iPhone", requestId);
    const replay = registry.redeem(credential, "iPhone", requestId);

    expect(first).toHaveProperty("token");
    expect(replay).toEqual(first);
    expect(registry.count()).toBe(1);
    // Possessing only one half of the replay key is not enough.
    expect(registry.redeem(credential, "iPhone", "different-request-id")).toMatchObject({
      reason: "used",
    });
    expect(registry.redeem("murage_pair_wrong", "iPhone", requestId)).toMatchObject({
      error: expect.stringContaining("no pairing"),
    });
  });

  it("forgets a redemption replay when a fresh pairing window opens", () => {
    const registry = new DeviceRegistry();
    const { token: firstCredential } = registry.openPairing();
    const requestId = "4c825d5b-cf40-4db7-aac5-2455f805a8ec";
    expect(registry.redeem(firstCredential, "iPhone", requestId)).toHaveProperty("token");

    registry.openPairing();
    expect(registry.redeem(firstCredential, "iPhone", requestId)).toMatchObject({
      error: expect.stringContaining("not right"),
    });
  });

  it("actively erases a redemption replay at the original window expiry", () => {
    vi.useFakeTimers();
    try {
      const registry = new DeviceRegistry();
      const { token: credential } = registry.openPairing();
      const requestId = "4c825d5b-cf40-4db7-aac5-2455f805a8ec";
      expect(registry.redeem(credential, "iPhone", requestId)).toHaveProperty("token");
      const memory = registry as unknown as {
        replay: unknown;
        replayExpiryTimer: unknown;
      };
      expect(memory.replay).not.toBeNull();
      expect(memory.replayExpiryTimer).not.toBeNull();

      vi.advanceTimersByTime(PAIRING_TTL_MS + 1);
      expect(memory.replay).toBeNull();
      expect(memory.replayExpiryTimer).toBeNull();
      expect(registry.redeem(credential, "iPhone", requestId)).toMatchObject({
        error: expect.stringContaining("no pairing"),
      });
      expect(registry.count()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cloud desktop access off until enabled for that device", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);

    expect(device.cloudDesktopAccess).toBe(false);
    expect(registry.authenticate(token)?.cloudDesktopAccess).toBe(false);
    expect(registry.setCloudDesktopAccess(device.id, true)).toBe(true);
    expect(registry.authenticate(token)?.cloudDesktopAccess).toBe(true);
    expect(new DeviceRegistry().authenticate(token)?.cloudDesktopAccess).toBe(true);
    expect(registry.setCloudDesktopAccess(device.id, false)).toBe(true);
    expect(registry.authenticate(token)?.cloudDesktopAccess).toBe(false);
    expect(registry.setCloudDesktopAccess("missing", true)).toBe(false);
  });

  it("rolls cloud desktop access back when it cannot be saved", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);
    (registry as unknown as { persist: () => void }).persist = () => {
      throw new Error("ENOSPC: no space left on device");
    };

    expect(() => registry.setCloudDesktopAccess(device.id, true)).toThrow("ENOSPC");
    expect(registry.authenticate(token)?.cloudDesktopAccess).toBe(false);
  });

  it("uses a high-entropy QR credential and burns the manual fallback with it", () => {
    const registry = new DeviceRegistry();
    const { code, token } = registry.openPairing();

    expect(token).toMatch(/^murage_pair_[A-Za-z0-9_-]{43}$/);
    expect(registry.redeem(token, "iPhone")).toHaveProperty("token");
    // Both halves of one window: spending the QR token spends the typed code
    // with it, and the typed code is told which of the two things happened.
    expect(registry.redeem(code, "iPad")).toMatchObject({ reason: "used" });
    expect(registry.count()).toBe(1);
  });

  it("refuses an expired window without a timer", () => {
    // Move the clock, not the object. Ageing the window returned by
    // openPairing() only works while that object is the registry's own — the
    // day it hands back a copy, the test would be asserting against something
    // the registry never reads. The contract is "expiry is evaluated on read
    // against the wall clock", so the clock is the thing to control.
    vi.useFakeTimers();
    try {
      const registry = new DeviceRegistry();
      const { code } = registry.openPairing();
      expect(registry.pairing()).not.toBeNull();

      // one tick short of the TTL: still live, so the assertion below is
      // about expiry rather than about pairing being broken outright
      vi.advanceTimersByTime(PAIRING_TTL_MS - 1);
      expect(registry.pairing()).not.toBeNull();

      vi.advanceTimersByTime(2);
      expect(registry.pairing()).toBeNull();
      // Expired, and named as expired. "No pairing is in progress" was true
      // of the registry and useless to the person: they are holding a code
      // that WAS this machine's, and the only thing they need told is that
      // it ran out and a new one is a click away.
      expect(registry.redeem(code, "iPhone")).toMatchObject({
        reason: "expired",
        error: expect.stringContaining("expired"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes one device without touching the others", () => {
    const registry = new DeviceRegistry();
    const phone = pair(registry, "iPhone");
    const tablet = pair(registry, "iPad");
    expect(registry.count()).toBe(2);

    expect(registry.revoke(phone.device.id)).toBe(true);
    expect(registry.revoke(phone.device.id)).toBe(false);
    expect(registry.authenticate(phone.token)).toBeNull();
    expect(registry.authenticate(tablet.token)?.name).toBe("iPad");

    // revocation is durable, not just in-memory
    expect(new DeviceRegistry().authenticate(phone.token)).toBeNull();
  });

  // CP2 (adopted): a corrupt file is no longer a trustworthy empty fleet. No
  // device authenticates from it, exactly as before, and the registry now
  // also says it is unavailable instead of presenting the empty list as true.
  it("treats a corrupt devices.json as unavailable, not as an empty fleet", () => {
    const { token } = pair(new DeviceRegistry());
    writeFileSync(join(DATA_DIR, "devices.json"), "{ not json");
    const registry = new DeviceRegistry();
    expect(registry.count()).toBe(0);
    expect(registry.authenticate(token)).toBeNull();
    expect(registry.registryStatus().available).toBe(false);
  });
});

describe("a paired-device list that cannot be read", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const file = () => join(DATA_DIR, "devices.json");

  it("is a first run, available and empty, only when there is no file at all", () => {
    const registry = new DeviceRegistry();
    expect(registry.registryStatus()).toEqual({ available: true });
    const { token } = pair(registry);
    expect(new DeviceRegistry().authenticate(token)).not.toBeNull();
  });

  it.each([
    ["malformed JSON", "{ not json"],
    ["an empty file", ""],
    ["a top-level array", "[]"],
    ["a top-level null", "null"],
    ["a document with no devices", "{}"],
    ["devices that are not a list", '{"devices":{"id":"x"}}'],
  ])("refuses to pair over %s and leaves its bytes alone", (_label, bytes) => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file(), bytes);
    const registry = new DeviceRegistry();
    expect(registry.registryStatus()).toMatchObject({ available: false, problem: expect.any(String) });

    const { code } = registry.openPairing();
    expect(registry.redeem(code, "iPhone")).toMatchObject({ reason: "unavailable" });
    // Not spent: the person holding the right code can use it once the list
    // is readable again, instead of going back to the computer for another.
    expect(registry.pairing()?.code).toBe(code);
    expect(registry.count()).toBe(0);
    expect(readFileSync(file(), "utf8")).toBe(bytes);
  });

  it("treats a read failure other than a missing file as unavailable", () => {
    // A directory where the file should be: a real read error, on every
    // platform, without pretending to be one.
    mkdirSync(file(), { recursive: true });
    const registry = new DeviceRegistry();
    const status = registry.registryStatus();
    expect(status.available).toBe(false);
    expect(status.available === false && status.problem).toMatch(/could not be read/);
    // The system message names a path; the status does not carry it.
    expect(JSON.stringify(status)).not.toContain(DATA_DIR);

    const { code } = registry.openPairing();
    expect(registry.redeem(code, "iPhone")).toMatchObject({ reason: "unavailable" });
    expect(statSync(file()).isDirectory()).toBe(true);
  });

  it("reloads the original fleet once the file is readable again, and grows from there", () => {
    const phone = pair(new DeviceRegistry(), "iPhone");
    const bytes = readFileSync(file(), "utf8");
    writeFileSync(file(), "{ torn");

    const registry = new DeviceRegistry();
    expect(registry.authenticate(phone.token)).toBeNull();

    writeFileSync(file(), bytes);
    expect(registry.reload()).toBe(true);
    expect(registry.registryStatus()).toEqual({ available: true });
    expect(registry.authenticate(phone.token)?.id).toBe(phone.device.id);

    const tablet = pair(registry, "iPad");
    const reread = new DeviceRegistry();
    expect(reread.count()).toBe(2);
    expect(reread.authenticate(phone.token)?.id).toBe(phone.device.id);
    // still hashes only
    expect(readFileSync(file(), "utf8")).not.toContain(tablet.token);
  });

  it("reads an unavailable file again on its own, no more often than the retry interval", () => {
    const phone = pair(new DeviceRegistry());
    const bytes = readFileSync(file(), "utf8");
    vi.useFakeTimers();
    try {
      writeFileSync(file(), "{ torn");
      const registry = new DeviceRegistry();
      writeFileSync(file(), bytes);

      vi.setSystemTime(Date.now() + REGISTRY_RETRY_MS - 1);
      expect(registry.authenticate(phone.token)).toBeNull();
      vi.setSystemTime(Date.now() + 1);
      expect(registry.authenticate(phone.token)?.id).toBe(phone.device.id);
      expect(registry.registryStatus()).toEqual({ available: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("revocation that cannot be saved", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  /** A full disk for this one registry. Returns the repair. */
  const failWrites = (registry: DeviceRegistry): (() => void) => {
    // SAFETY: `persist` is private; shadowed on this instance only, as in the
    // failing-disk suites above. Deleting the shadow restores the prototype.
    const target = registry as unknown as { persist?: () => void };
    target.persist = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    return () => {
      delete target.persist;
    };
  };

  it("keeps a device paired, in memory and on disk, until its removal is written", () => {
    const registry = new DeviceRegistry();
    const phone = pair(registry, "iPhone");
    const other = pair(registry, "iPad");
    const { value } = registry.openSession(phone.device.id, "Safari on iPhone")!;
    const { sessionId } = registry.resolveSession(value)!;
    const ended: string[] = [];
    registry.onSessionEnded((event) => ended.push(event.sessionId));

    const repair = failWrites(registry);
    expect(() => registry.revoke(phone.device.id)).toThrow(/ENOSPC/);
    expect(registry.authenticate(phone.token)?.id).toBe(phone.device.id);
    expect(registry.list().map((d) => d.id)).toEqual([phone.device.id, other.device.id]);
    expect(registry.sessionDeadline(sessionId)).not.toBeNull();
    expect(ended).toEqual([]);
    expect(new DeviceRegistry().authenticate(phone.token)?.id).toBe(phone.device.id);

    repair();
    expect(registry.revoke(phone.device.id)).toBe(true);
    expect(ended).toEqual([sessionId]);
    expect(registry.authenticate(other.token)?.id).toBe(other.device.id);
    expect(new DeviceRegistry().authenticate(phone.token)).toBeNull();
  });

  it("keeps a browser signed in, in memory and on disk, until its sign-out is written", () => {
    const registry = new DeviceRegistry();
    const phone = pair(registry);
    const { value } = registry.openSession(phone.device.id, "Safari on iPhone")!;
    const { sessionId } = registry.resolveSession(value)!;
    const ended: string[] = [];
    registry.onSessionEnded((event) => ended.push(event.sessionId));

    const repair = failWrites(registry);
    expect(() => registry.closeSession(value)).toThrow(/ENOSPC/);
    expect(registry.resolveSession(value)?.sessionId).toBe(sessionId);
    expect(ended).toEqual([]);
    expect(new DeviceRegistry().resolveSession(value)).not.toBeNull();

    repair();
    expect(registry.closeSession(value)).toBe(true);
    expect(ended).toEqual([sessionId]);
    expect(new DeviceRegistry().resolveSession(value)).toBeNull();
  });
});

describe("authenticate under a failing disk", () => {
  it("still authenticates when the lastSeenAt write throws", () => {
    const registry = new DeviceRegistry();
    const { token, device } = pair(registry);

    // A read-only home or a full disk. The write being attempted here is the
    // "last seen" timestamp, which decorates a row in a settings panel — it
    // must not be able to sign a working phone out, on every request, for
    // the user least equipped to work out why.
    let attempted = 0;
    // SAFETY: `persist` is private, so the type has to be widened to reach
    // it. Assigning on the instance shadows the prototype method for this
    // registry only — the failing disk is simulated where the disk is used,
    // rather than by mocking node:fs for the whole file.
    (registry as unknown as { persist: () => void }).persist = () => {
      attempted++;
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };

    expect(registry.authenticate(token)?.id).toBe(device.id);
    expect(attempted).toBe(1);
    // and again, so a throw cannot poison the path for later calls either
    expect(registry.authenticate(token)?.id).toBe(device.id);
  });
});

describe("a pairing that cannot be saved", () => {
  // Same throwaway state as the suite above — a registry built on a leftover
  // devices.json would start with a device already in it.
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("is not left live in memory", () => {
    const registry = new DeviceRegistry();
    // SAFETY: as above — the private `persist` shadowed on this one instance,
    // which is the only way to make the write fail without a filesystem that
    // really is read-only.
    (registry as unknown as { persist: () => void }).persist = () => {
      throw new Error("EROFS: read-only file system");
    };

    const { code } = registry.openPairing();
    const result = registry.redeem(code, "iPhone");

    // A device kept in memory but never written is paired until the next
    // restart and then silently is not — the phone holds a token that stops
    // working with nothing to explain it. Fail the pairing instead.
    expect("error" in result).toBe(true);
    expect(registry.count()).toBe(0);
    expect(registry.list()).toEqual([]);
  });
});

describe("cleanDeviceName", () => {
  it("clamps, trims, and strips control characters", () => {
    expect(cleanDeviceName("  Milind's iPhone  ")).toBe("Milind's iPhone");
    // an untrusted label must not carry NULs or ANSI escapes into a UI
    expect(cleanDeviceName("bad\u0000name\u001b[31m")).toBe("bad name [31m");
    expect(cleanDeviceName("x".repeat(200))).toHaveLength(60);
  });

  it("falls back rather than allowing an empty label", () => {
    expect(cleanDeviceName("")).toBe("Companion");
    expect(cleanDeviceName(undefined)).toBe("Companion");
    expect(cleanDeviceName("   ")).toBe("Companion");
  });
});

describe("bearerToken", () => {
  it("reads only a well-formed Bearer header", () => {
    expect(bearerToken("Bearer murage_abc")).toBe("murage_abc");
    expect(bearerToken("  Bearer murage_abc  ")).toBe("murage_abc");
    expect(bearerToken("murage_abc")).toBeUndefined();
    expect(bearerToken("Basic murage_abc")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  // RFC 7235 says the scheme is case-insensitive, and a client sending
  // "bearer" is within its rights. This is the only parser in the sidecar,
  // so a phone cannot get a 401 from one half disagreeing with the other —
  // which is exactly what happened while the proxy carried a second, laxer
  // one of its own: the same header authenticated on one path and not the
  // other, depending on which code it happened to meet.
  it("matches the scheme however it is cased", () => {
    expect(bearerToken("bearer murage_abc")).toBe("murage_abc");
    expect(bearerToken("BEARER murage_abc")).toBe("murage_abc");
    expect(bearerToken("BeArEr murage_abc")).toBe("murage_abc");
    // a tab separates scheme from credential just as legally as a space
    expect(bearerToken("BeArEr\tmurage_abc")).toBe("murage_abc");
    // still not a free-for-all: a scheme with nothing after it is not a
    // credential, however much whitespace is standing in for one
    expect(bearerToken("Bearer ")).toBeUndefined();
    expect(bearerToken("Bearer   ")).toBeUndefined();
    expect(bearerToken("Bearermurage_abc")).toBeUndefined();
  });
});

// ── the pairing window's own documentation ────────────────────────────────
//
// Three comments in `devices.ts` said the pairing code lives "for two
// minutes". `PAIRING_TTL_MS` has been ten for a while. Nothing broke, because
// comments do not run — but this is the same rot that put a wrong number in
// front of a real user, and the fix that lasts is not "correct them once", it
// is "make the file unable to hold a second copy of the number".
//
// So the comments now name the constant, and this reads the source back to
// prove they still do. Restate the duration in English anywhere in this file
// and it goes red with the number it should have said.
describe("the pairing TTL is stated once", () => {
  const SOURCE = readFileSync(new URL("../src/devices.ts", import.meta.url), "utf8");

  /** The English number words a duration comment would plausibly use. */
  const WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, sixty: 60,
  };

  it("has no comment restating it as a different number of minutes", () => {
    // From the constant itself, the same way `control.ts` derives the number
    // it shows the user. A literal here would be a third copy of the value
    // and could rot in step with the comments it is meant to catch.
    const minutes = Math.round(PAIRING_TTL_MS / 60_000);

    // Line breaks and comment gutters collapsed FIRST, because a wrapped
    // "two\n * minutes" is still a wrong sentence and a line-by-line scan
    // cannot see it. That is not hypothetical: the first version of this test
    // was line-by-line, and its negative control — putting the original stale
    // comment back — came back green, because prettier had wrapped the phrase
    // between the two words. A guard that the defect walks straight past is
    // worse than no guard, so the text is flattened before it is read.
    const prose = SOURCE.replace(/\n\s*\*?\s?/g, " ");

    const wrong: string[] = [];
    for (const match of prose.matchAll(/\b([a-z]+)[- ]minutes?\b/gi)) {
      const spelled = WORDS[match[1].toLowerCase()];
      if (spelled === undefined || spelled === minutes) continue;
      wrong.push(`"${match[0]}" in: …${prose.slice(Math.max(0, match.index - 90), match.index + 60).trim()}…`);
    }
    expect(wrong, `PAIRING_TTL_MS is ${minutes} minutes, but the file also says:\n${wrong.join("\n")}`).toEqual([]);
  });
});
