# Group A: sessions, device records, remote sign-out (spec §3.3)

Source read for this section (line numbers are the current `mobile/v1` tree):

- `companion/src/devices.ts`: `BrowserSession` 18-36, `DeviceRecord` 38-53, `PublicDevice` 61, `MAX_DEVICES` 187, session constants 190-267, `sessionExpired` 317-319, `normalizeDevice` 340-368, constructor 394-396, `list` 489-492, `redeem` 587-720 (cap check 673-675, record creation 680-700), `openSession` 816-848, `resolveSession` 859-894, `renewSession` 896-955, `closeSession` 957-984, `revoke` 986-1009.
- `companion/src/browser.ts`: `BrowserDeviceStore` 55-86, `BrowserDoorOptions` 88-107, `enterPage` script 746-830, `renewalScript` 922-950, `injectRenewal` 965-970, renew route 1185-1215, `POST /session` 1217-1270, `DELETE /session` 1271-1285.
- `companion/src/control.ts`: import 18, `companionState` 208-251, route table 330-398, page `render` 473-532.
- `companion/src/index.ts`: registry 353, `onSessionEnded` wiring 403, browser door options 428-438.
- `companion/src/state.ts`: `DATA_DIR` 23, `ensureDataDir` 36-47, `writeFileAtomic` 59-88 (creates files 0600).
- `companion/src/door-identity.ts`: only secret material in the companion is `MURAGE_DOOR_NONCE`, which is headless-only (`takeDoorIdentity` returns null on desktop). There is no usable server secret, so Task A1 adds one.
- Desktop pairing UI: `src/components/CompanionSection.tsx` `QrLogin` 260-323; `src/components/PhoneSetupFlow.tsx` `CompanionState` 69-107, `CompanionBridge.revoke` 227, `PhoneSetupController.act` 381, polling at 1 s while a pairing is open 909-918, pairing screen 1551-1626. Electron passes `/state` through verbatim (`electron/companion.mjs:523-528`), so new state fields need no Electron change.
- Remote settings: `src/components/SettingsModal.tsx` hides the whole Phone section off the desktop (`companion` is `desktopOnly: true`, line 69; `sectionsForSurface` 93-98). The remote card in `CompanionSection.tsx:335-345` is therefore never rendered. The remote sign-out button goes in the General section (786-808), gated on `desktop === false` from `useDesktopSurface()` (`src/lib/use-surface.ts`).

**HARD RULE for every executor of these tasks:** never more than ONE cargo build on the Mac, and none is needed here. These tasks are TypeScript only. Run the vitest commands below one at a time.

---

### Task A1: Companion session secret

**Files:**
- Create: `companion/src/session-secret.ts`
- Test: `companion/test/session-secret.test.ts`

**Interfaces:**
- Consumes: `DATA_DIR`, `ensureDataDir`, `writeFileAtomic` from `companion/src/state.ts`
- Produces: `export const SESSION_SECRET_FILE: string`; `export function loadSessionSecret(): Buffer` (32 bytes; throws when the file exists but cannot be read)

- [ ] **Step 1: Write the failing test**
```ts
// The key renewal successors are derived from (see `successorValue` in
// devices.ts). Three properties: it survives a restart, nobody else on the
// machine can read it, and an unreadable file is never quietly replaced,
// because replacing it would orphan every successor already handed out.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { loadSessionSecret, SESSION_SECRET_FILE } from "../src/session-secret.ts";
import { DATA_DIR } from "../src/state.ts";

describe("the session secret", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("is created once, owner-only, and read back unchanged", () => {
    const first = loadSessionSecret();
    expect(first).toHaveLength(32);
    expect(statSync(SESSION_SECRET_FILE).mode & 0o777).toBe(0o600);
    expect(loadSessionSecret().equals(first)).toBe(true);
    expect(readFileSync(SESSION_SECRET_FILE, "utf8").trim()).toBe(first.toString("hex"));
  });

  it("replaces a damaged file rather than deriving from garbage", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SESSION_SECRET_FILE, "not hex at all");
    const secret = loadSessionSecret();
    expect(secret).toHaveLength(32);
    expect(readFileSync(SESSION_SECRET_FILE, "utf8").trim()).toBe(secret.toString("hex"));
  });

  it("refuses, and leaves the path alone, when the file exists but cannot be read", () => {
    mkdirSync(SESSION_SECRET_FILE, { recursive: true });
    expect(() => loadSessionSecret()).toThrow();
    expect(statSync(SESSION_SECRET_FILE).isDirectory()).toBe(true);
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/session-secret.test.ts`
Expected: FAIL with "Failed to load url ../src/session-secret.ts" (module does not exist)
- [ ] **Step 3: Write minimal implementation**

Create `companion/src/session-secret.ts`:
```ts
// The one secret the companion keeps: the key renewal successors are derived
// from.
//
// Derived rather than random is what makes renewal idempotent. A phone that
// asks to renew and loses the response asks again, and must get the SAME
// successor back, or two responses arriving out of order leave it holding a
// value the server has already replaced. Storing the successor in the clear
// would do that too, and would put a live credential in devices.json. So
// devices.json holds the successor's hash, and this file holds the key that
// lets the server compute the plaintext again on demand.
//
// Its own file, not a field in devices.json: a devices.json restored from a
// backup must not carry the key its successors were derived under.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureDataDir, writeFileAtomic } from "./state.ts";

export const SESSION_SECRET_FILE = join(DATA_DIR, "session-secret");

const HEX64 = /^[a-f0-9]{64}$/;

/** Read the secret, creating it on first use.
 *
 * A MISSING or malformed file gets a fresh secret, written 0600 through the
 * same atomic write devices.json uses. A successor derived under the old key
 * can still be committed (its hash is in devices.json); it just cannot be
 * re-sent, and `renewSession` derives a new one instead.
 *
 * Any other read failure throws, and nothing is written. That file might be
 * perfectly good and merely unreadable for a moment, and overwriting it would
 * turn a transient fault into a permanent one. The caller fails closed. */
export function loadSessionSecret(): Buffer {
  try {
    const text = readFileSync(SESSION_SECRET_FILE, "utf8").trim();
    if (HEX64.test(text)) return Buffer.from(text, "hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const secret = randomBytes(32);
  ensureDataDir();
  writeFileAtomic(SESSION_SECRET_FILE, `${secret.toString("hex")}\n`);
  return secret;
}
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/session-secret.test.ts`
Expected: PASS (3 tests)
- [ ] **Step 5: Commit**
```
git add companion/src/session-secret.ts companion/test/session-secret.test.ts
git commit -m "feat(companion): a persisted, owner-only secret for deriving session successors"
```

---

### Task A2: Session and device record format, with migration

**Files:**
- Modify: `companion/src/devices.ts:12-16` (imports), `:18-61` (types), `:187-267` (constants), `:317-368` (helpers, `normalizeDevice`), `:488-492` (`list`), `:816-848` (`openSession`)
- Test: `companion/test/devices.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `export interface PendingSuccessor { hash: string; generation: number; issuedAt: number }`
  - `BrowserSession` gains `id: string`, `committedAt: number`, `pending?: PendingSuccessor`
  - `DeviceRecord` gains `installId?: string`, `sessionGeneration: number`
  - `PublicDevice = Omit<DeviceRecord, "tokenHash" | "sessions" | "installId" | "sessionGeneration">`
  - `export const SESSION_RENEWAL_DUE_MS = 86_400_000`, `export const PENDING_TTL_MS = 604_800_000`
  - module-private `publicDevice(device)`, `pendingExpired(pending, now)`, `renewedExpiry(session, now)`; `export function cleanInstallId(raw: unknown): string | undefined`

- [ ] **Step 1: Write the failing test**

Append to `companion/test/devices.test.ts`:
```ts
describe("session records written before derived renewal", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const file = () => join(DATA_DIR, "devices.json");

  it("loads an old session, gives it an id and a commit time, and keeps its cookie working", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const { value } = registry.openSession(device.id, "Safari on iPhone")!;

    // Exactly what an older build wrote: no id, no commit time, no successor,
    // and no generation on the device.
    const stored = JSON.parse(readFileSync(file(), "utf8"));
    const old = stored.devices[0].sessions[0];
    delete old.id;
    delete old.committedAt;
    delete old.pending;
    delete stored.devices[0].sessionGeneration;
    writeFileSync(file(), JSON.stringify(stored));

    const resolved = new DeviceRegistry().resolveSession(value)!;
    expect(resolved.device.id).toBe(device.id);
    expect(resolved.session.id).toMatch(/^[0-9a-f-]{36}$/);
    // Treated as committed when it was created, so an old session is due for
    // renewal straight away rather than a day after the upgrade.
    expect(resolved.session.committedAt).toBe(old.createdAt);
    expect(resolved.session.pending).toBeUndefined();
  });

  it("drops a malformed successor, and never lets the generation run backwards", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const first = registry.openSession(device.id, "Safari on iPhone")!;
    const second = registry.openSession(device.id, "Chrome on iPhone")!;

    const stored = JSON.parse(readFileSync(file(), "utf8"));
    stored.devices[0].sessionGeneration = 2;
    stored.devices[0].sessions[0].pending = { hash: "ab", generation: "7", issuedAt: Date.now() };
    stored.devices[0].sessions[1].pending = { hash: "cd".repeat(32), generation: 9, issuedAt: Date.now() };
    writeFileSync(file(), JSON.stringify(stored));

    const reloaded = new DeviceRegistry();
    expect(reloaded.resolveSession(first.value)!.session.pending).toBeUndefined();
    expect(reloaded.resolveSession(second.value)!.session.pending?.generation).toBe(9);
    // SAFETY: private field, read only. The next successor must be 10, not 3.
    const devices = (reloaded as unknown as { devices: Array<{ sessionGeneration: number }> }).devices;
    expect(devices[0].sessionGeneration).toBe(9);
  });

  it("keeps generations and session rows off the page", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    registry.openSession(device.id, "Safari on iPhone");
    const [listed] = registry.list();
    expect(listed).not.toHaveProperty("sessionGeneration");
    expect(listed).not.toHaveProperty("sessions");
    expect(listed).not.toHaveProperty("installId");
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/devices.test.ts -t "session records written before derived renewal"`
Expected: FAIL with `expected undefined to match /^[0-9a-f-]{36}$/` (no session id) and `expected { … } not to have property "sessionGeneration"` is vacuous, so the first two tests are the failing ones.
- [ ] **Step 3: Write minimal implementation**

In `companion/src/devices.ts`, replace lines 18-36 (`BrowserSession`) with:
```ts
/** A successor credential that has been handed out and not yet used.
 *
 * Only its hash is stored, and the plaintext is never needed again from
 * disk: it is DERIVED (`successorValue`) from the server secret, the session
 * and `generation`, so a retry of a renewal whose response was lost gets the
 * identical value back without anything usable sitting in devices.json. */
export interface PendingSuccessor {
  hash: string;
  /** The device generation it was derived at. Never reused. */
  generation: number;
  /** When it was first handed out. Refused `PENDING_TTL_MS` after this. */
  issuedAt: number;
}

/** One browser signed in against a paired device.
 *
 * A browser session is a second credential *form* for an existing device, not
 * a second identity. That is the whole reason it is stored inside the device
 * record rather than beside it: there is no second store to keep consistent,
 * so `revoke()` already kills every browser signed in on that device, and
 * `connectedDeviceTracker` already terminates their live streams. */
export interface BrowserSession {
  /** Stable across renewals and restarts, and part of what a successor is
   * derived from, so no two sessions can ever derive the same value. Not the
   * stream id `sessionId()` hands out, which is process-local and never
   * written down. */
  id: string;
  /** sha256 of the cookie value currently in use — same write-only rule as
   * `tokenHash`. */
  hash: string;
  /** "Safari on iPhone", clamped the same way a device name is. */
  label: string;
  createdAt: number;
  lastSeenAt: number;
  /** The absolute cap. Set at sign-in and moved forward when a successor is
   * committed, never past `createdAt + SESSION_MAX_LIFETIME_MS`. Use alone
   * does not move it. */
  expiresAt: number;
  /** When `hash` last became current: at sign-in, then at each commit.
   * Renewal is due `SESSION_RENEWAL_DUE_MS` after this. */
  committedAt: number;
  /** At most one successor, handed out by `renewSession` and not yet
   * presented. `hash` stays valid until it is. */
  pending?: PendingSuccessor;
}
```
Replace lines 38-61 (`DeviceRecord` through `PublicDevice`) with:
```ts
/** One paired phone, as it is written to disk. */
export interface DeviceRecord {
  id: string;
  name: string;
  /** sha256 of the bearer token — never the token itself */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  /** Full interactive access to a bot's cloud desktop. Deliberately off on
   * every new and migrated device until the computer owner enables it. */
  cloudDesktopAccess: boolean;
  /** The app install that paired this record, when it said. Pairing again
   * with the same id replaces this record instead of taking a new slot. Not a
   * secret: it proves nothing, and pairing still needs the pairing code. */
  installId?: string;
  /** The last successor generation derived for any session on this device.
   * Only ever incremented, and written down before a successor derived from
   * it is sent, so no two successors share one — not across sessions and not
   * across a restart. */
  sessionGeneration: number;
  /** Browsers signed in against this device. Hashes only. Absent on a device
   * that has never opened one, which is what every record predating the
   * browser door looks like. */
  sessions?: BrowserSession[];
}

/** What the UI is allowed to see: a device without its secrets.
 *
 * `sessions` goes too. Session hashes are not credentials — you cannot sign
 * in with a digest — but they are the only thing standing between a leaked
 * devices.json and an offline guess at a cookie value, and the control page
 * has no use for them. Same rule as `tokenHash`, for the same reason. The
 * install id and the generation are bookkeeping the page has no use for
 * either. */
export type PublicDevice = Omit<DeviceRecord, "tokenHash" | "sessions" | "installId" | "sessionGeneration">;
```
After line 267 (`SESSION_MAX_LIFETIME_MS`), add:
```ts
/** How long after a credential became current before `renewSession` derives
 * a successor for it.
 *
 * Measured from the last COMMIT, not from sign-in and not from the last
 * renewal request: the client asks on every load and every unlock, and only a
 * day after the value it holds became current does it get a new one. */
export const SESSION_RENEWAL_DUE_MS = 24 * 60 * 60 * 1000;

/** How long a successor that was handed out but never presented is still
 * accepted. After this it is refused, the current credential it would have
 * replaced carries on, and the next renewal derives a fresh one. */
export const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
```
After `sessionExpired` (after line 319), add:
```ts
/** Whether an unused successor has aged out. */
function pendingExpired(pending: PendingSuccessor, now: number): boolean {
  return now - pending.issuedAt > PENDING_TTL_MS;
}

/** The cap a session gets when a credential becomes current at `now`.
 * Monotonic without a guard: the previous cap was set the same way at an
 * earlier `now`, and the ceiling term never moves. */
function renewedExpiry(session: BrowserSession, now: number): number {
  return Math.min(now + SESSION_ABSOLUTE_MS, session.createdAt + SESSION_MAX_LIFETIME_MS);
}

const INSTALL_ID = /^[A-Za-z0-9._-]{16,128}$/;

/** An install id we are willing to key a record on, or nothing. Same shape
 * rule as a pairing request id: long enough not to collide by accident, and
 * nothing that needs escaping anywhere it is written. */
export function cleanInstallId(raw: unknown): string | undefined {
  return typeof raw === "string" && INSTALL_ID.test(raw) ? raw : undefined;
}

/** A device as the page may see it. One place, so a new private field cannot
 * leak through one of the three call sites that used to strip by hand. */
function publicDevice(device: DeviceRecord): PublicDevice {
  const { tokenHash, sessions, installId, sessionGeneration, ...rest } = device;
  return rest;
}
```
Replace `normalizeDevice` (lines 340-368) with:
```ts
function normalizeDevice(record: Partial<DeviceRecord> & { id: string; tokenHash: string }): DeviceRecord {
  const createdAt = timestamp(record.createdAt, Date.now());
  const device: DeviceRecord = {
    id: record.id,
    tokenHash: record.tokenHash,
    name: cleanDeviceName(record.name),
    createdAt,
    lastSeenAt: timestamp(record.lastSeenAt, createdAt),
    cloudDesktopAccess: record.cloudDesktopAccess === true,
    sessionGeneration:
      Number.isSafeInteger(record.sessionGeneration) && (record.sessionGeneration as number) > 0
        ? (record.sessionGeneration as number)
        : 0,
  };
  const installId = cleanInstallId(record.installId);
  if (installId) device.installId = installId;
  // A session without a hash cannot authenticate and cannot be signed out;
  // it is a row that would sit in the file forever doing nothing. Drop it
  // rather than complete it, which is the opposite call from the device
  // fields above and for the opposite reason: those decorate a working
  // credential, this one *is* the credential.
  const sessions = Array.isArray(record.sessions) ? record.sessions : [];
  const kept = sessions
    .filter((s): s is BrowserSession => typeof (s as BrowserSession)?.hash === "string")
    .map((s) => {
      const sessionCreatedAt = timestamp(s.createdAt, createdAt);
      const session: BrowserSession = {
        // A session written before ids existed gets one here. It reaches the
        // file with the first successor derived from it, which is the only
        // moment the id has to be the same after a restart.
        id: typeof s.id === "string" && s.id ? s.id : randomUUID(),
        hash: s.hash,
        label: cleanDeviceName(s.label),
        createdAt: sessionCreatedAt,
        lastSeenAt: timestamp(s.lastSeenAt, sessionCreatedAt),
        expiresAt: timestamp(s.expiresAt, 0),
        // Committed when created, for a row that predates commits: an old
        // session is due for renewal at once rather than a day after upgrade.
        committedAt: timestamp(s.committedAt, sessionCreatedAt),
      };
      const pending = s.pending as Partial<PendingSuccessor> | undefined;
      if (
        pending &&
        typeof pending.hash === "string" &&
        Number.isSafeInteger(pending.generation) &&
        (pending.generation as number) > 0 &&
        typeof pending.issuedAt === "number" &&
        Number.isFinite(pending.issuedAt)
      ) {
        session.pending = { hash: pending.hash, generation: pending.generation as number, issuedAt: pending.issuedAt };
      }
      return session;
    })
    .slice(0, MAX_SESSIONS_PER_DEVICE);
  if (kept.length) device.sessions = kept;
  // A hand-edited or partly restored file can hold a successor from a later
  // generation than the device says. Never derive at or below one that
  // already exists.
  for (const session of kept) {
    if (session.pending) device.sessionGeneration = Math.max(device.sessionGeneration, session.pending.generation);
  }
  return device;
}
```
Replace `list` (lines 488-492) with:
```ts
  /** Every paired device, without the hash — this is what the page renders. */
  list(): PublicDevice[] {
    this.recover();
    return this.devices.map(publicDevice);
  }
```
In `redeem`, lines 681-688 (the new `DeviceRecord` literal) add `sessionGeneration: 0,` after `cloudDesktopAccess: false,`, and replace line 701 `const { tokenHash, sessions, ...pub } = device;` + line 702 with:
```ts
    const result = { device: publicDevice(device), token };
```
In `openSession`, replace lines 821-827 (the `session` literal) with:
```ts
    const session: BrowserSession = {
      id: randomUUID(),
      hash: sha256(value),
      label: cleanDeviceName(label),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_ABSOLUTE_MS,
      committedAt: now,
    };
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/devices.test.ts`
Expected: PASS (all existing tests plus the 3 new ones)
- [ ] **Step 5: Commit**
```
git add companion/src/devices.ts companion/test/devices.test.ts
git commit -m "feat(companion): session ids, commit times and successor slots in devices.json, migrated in place"
```

---

### Task A3: Derived, idempotent, commit-on-first-use renewal in the registry

**Files:**
- Modify: `companion/src/devices.ts:12-16` (imports), `:373-396` (fields), `:859-955` (`resolveSession`, `renewSession`), `:959-984` (`closeSession`)
- Modify (existing tests whose premise changed): `companion/test/browser-renew.test.ts:42-198`, `companion/test/browser-session-streams.test.ts:226`
- Test: `companion/test/browser-renew.test.ts`

**Interfaces:**
- Consumes: `loadSessionSecret` (A1); `PendingSuccessor`, `pendingExpired`, `renewedExpiry`, `SESSION_RENEWAL_DUE_MS`, `PENDING_TTL_MS` (A2)
- Produces:
  - `export interface SessionRenewal { value: string; session: BrowserSession; expiresAt: number }`
  - `export function successorValue(secret: Buffer, session: Pick<BrowserSession, "id" | "createdAt" | "hash">, generation: number): string`
  - `DeviceRegistry.renewSession(value, now?): SessionRenewal | null` with the rules: current + live pending gives the same pending again; current, no pending, due gives a new pending; pending gives a commit and returns that same value; otherwise null.
  - `resolveSession` accepts a live pending and commits it; `closeSession` accepts either hash.

- [ ] **Step 1: Write the failing test**

In `companion/test/browser-renew.test.ts`, change the imports at lines 17 and 22 and 32-38 to:
```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
```
```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
```
```ts
import {
  DeviceRegistry,
  PENDING_TTL_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_MAX_LIFETIME_MS,
  successorValue,
} from "../src/devices.ts";
import { SESSION_SECRET_FILE } from "../src/session-secret.ts";
import { DATA_DIR } from "../src/state.ts";
```
After `storedSessions` (line 50) add:
```ts
/** What a browser does with a renewal: take the successor, then present it
 * on its next request, which commits it. */
const rotate = (registry: DeviceRegistry, value: string) => {
  const renewed = registry.renewSession(value);
  if (renewed) registry.resolveSession(renewed.value);
  return renewed;
};

/** Far enough on that renewal is due again. */
const dayLater = () => vi.setSystemTime(Date.now() + DAY + 60_000);

afterEach(() => {
  vi.useRealTimers();
});
```
Update the existing registry tests, whose premise ("every renewal rotates at once and kills the old value") the spec replaces:
- Line 65: insert `dayLater();` on the line before `const renewed = registry.renewSession(opened.value)!;`. The assertions at 72-73 stay: `resolveSession(renewed.value)` commits, then the old value is null.
- Line 92: replace with
```ts
    for (let i = 0; i < 5; i += 1) {
      dayLater();
      value = rotate(registry, value)!.value;
    }
```
- Line 114: `const renewed = registry.renewSession(value);` becomes `const renewed = rotate(registry, value);`
- Line 140: `const renewed = registry.renewSession(value);` becomes `const renewed = rotate(registry, value);`
- Line 190: insert `dayLater();` before `expect(registry.renewSession(opened.value)).toBeNull();` (otherwise the test passes vacuously because renewal is not due).

In `companion/test/browser-session-streams.test.ts` line 226, change `registry.renewSession(value, Date.now() + 1000)!` to `registry.renewSession(value, Date.now() + 24 * 60 * 60 * 1000 + 1000)!`. The rest of that test holds: `resolveSession(renewed.value)` commits the same record object, so its session id and deadline carry over, and afterwards the old value resolves to null.

Insert this new block after the closing `});` of `describe("renewing a browser session, in the registry", …)` (line 198):
```ts
// ─────────────────────────────────────────────────────────────────────────
// Recoverable renewal. A phone suspended mid-response, or a network that
// drops, loses the renewal reply. What it still holds must keep working, and
// asking again must hand it the same successor, never a second one.
// ─────────────────────────────────────────────────────────────────────────
describe("renewal is derived, idempotent and committed on first use", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const signedIn = () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const opened = registry.openSession(device.id, "Murage on iPhone")!;
    return { registry, device, value: opened.value };
  };

  const pendingGeneration = (): number =>
    (storedSessions()[0].pending as { generation: number } | undefined)?.generation ?? 0;

  it("is not due until a day after the credential became current", () => {
    const { registry, value } = signedIn();
    const start = Date.now();
    expect(registry.renewSession(value)).toBeNull();
    vi.setSystemTime(start + DAY - 60_000);
    expect(registry.renewSession(value)).toBeNull();
    vi.setSystemTime(start + DAY + 60_000);
    expect(registry.renewSession(value)).not.toBeNull();
  });

  it("gives a retry whose response was lost the identical successor", () => {
    const { registry, value } = signedIn();
    dayLater();
    const first = registry.renewSession(value)!;
    const retry = registry.renewSession(value)!;
    expect(retry.value).toBe(first.value);
    expect(retry.value).not.toBe(value);
    // One generation spent, not two, and the plaintext never reaches the file.
    expect(pendingGeneration()).toBe(1);
    expect(readFileSync(join(DATA_DIR, "devices.json"), "utf8")).not.toContain(first.value);
    // Nothing is committed yet, so the value the phone holds still works.
    expect(registry.resolveSession(value)).not.toBeNull();
  });

  it("cannot be confused by responses that arrive out of order", () => {
    const { registry, value } = signedIn();
    dayLater();
    const early = registry.renewSession(value)!;
    const late = registry.renewSession(value)!;
    // Whichever reply lands last in the cookie jar, it is the same value.
    expect(late.value).toBe(early.value);
    expect(registry.resolveSession(late.value)).not.toBeNull();
    // A renewal still in flight with the retired value changes nothing and
    // never un-commits what the phone now holds.
    expect(registry.renewSession(value)).toBeNull();
    expect(registry.resolveSession(early.value)).not.toBeNull();
  });

  it("commits on the first request that presents the successor, and only then retires the old value", () => {
    const { registry, device, value } = signedIn();
    dayLater();
    const { value: next } = registry.renewSession(value)!;
    expect(registry.resolveSession(value)).not.toBeNull();

    const committed = registry.resolveSession(next)!;
    expect(committed.session.pending).toBeUndefined();
    expect(committed.session.committedAt).toBe(Date.now());
    expect(registry.resolveSession(value)).toBeNull();
    // Durable in both directions.
    expect(new DeviceRegistry().resolveSession(value)).toBeNull();
    expect(new DeviceRegistry().resolveSession(next)?.device.id).toBe(device.id);
  });

  it("commits through the renewal route too, and is then not due for another day", () => {
    const { registry, value } = signedIn();
    dayLater();
    const { value: next } = registry.renewSession(value)!;
    const committed = registry.renewSession(next)!;
    expect(committed.value).toBe(next);
    expect(committed.expiresAt).toBe(committed.session.expiresAt);
    expect(registry.resolveSession(value)).toBeNull();
    expect(registry.renewSession(next)).toBeNull();
  });

  it("stops accepting an unused successor after a week, and leaves the current value alone", () => {
    const { registry, value } = signedIn();
    dayLater();
    const stale = registry.renewSession(value)!.value;
    vi.setSystemTime(Date.now() + PENDING_TTL_MS + 60_000);
    expect(registry.resolveSession(stale)).toBeNull();
    expect(registry.resolveSession(value)).not.toBeNull();

    const fresh = registry.renewSession(value)!;
    expect(fresh.value).not.toBe(stale);
    expect(pendingGeneration()).toBe(2);
    expect(registry.resolveSession(stale)).toBeNull();
  });

  it("hands out the same successor after a restart", () => {
    const { registry, value } = signedIn();
    dayLater();
    const before = registry.renewSession(value)!.value;

    const restarted = new DeviceRegistry();
    expect(restarted.renewSession(value)!.value).toBe(before);
    expect(restarted.resolveSession(before)).not.toBeNull();
    expect(new DeviceRegistry().resolveSession(value)).toBeNull();
  });

  it("revoking the device kills the current value and the successor", () => {
    const { registry, device, value } = signedIn();
    dayLater();
    const next = registry.renewSession(value)!.value;
    expect(registry.revoke(device.id)).toBe(true);
    expect(registry.resolveSession(value)).toBeNull();
    expect(registry.resolveSession(next)).toBeNull();
    expect(registry.renewSession(value)).toBeNull();
    const restarted = new DeviceRegistry();
    expect(restarted.resolveSession(value)).toBeNull();
    expect(restarted.resolveSession(next)).toBeNull();
  });

  it("signs a browser out whichever of the two values it presents", () => {
    const { registry, value } = signedIn();
    dayLater();
    const next = registry.renewSession(value)!.value;
    expect(registry.closeSession(next)).toBe(true);
    expect(registry.resolveSession(value)).toBeNull();
    expect(registry.resolveSession(next)).toBeNull();
  });

  it("never reuses a generation, across sessions or across a restart", () => {
    const { registry, device, value } = signedIn();
    const other = registry.openSession(device.id, "Safari on iPad")!.value;
    dayLater();
    registry.renewSession(value);
    registry.renewSession(other);
    const generations = storedSessions().map((s) => (s.pending as { generation: number }).generation);
    expect(generations.sort()).toEqual([1, 2]);

    const restarted = new DeviceRegistry();
    const next = restarted.renewSession(value)!.value;
    restarted.resolveSession(next);
    dayLater();
    restarted.renewSession(next);
    expect(Math.max(...storedSessions().map((s) => (s.pending as { generation: number } | undefined)?.generation ?? 0))).toBe(3);
  });

  it("derives from the session's id and creation time as well as its hash", () => {
    const secret = Buffer.alloc(32, 7);
    const base = { id: "11111111-2222-3333-4444-555555555555", createdAt: 1, hash: "ab".repeat(32) };
    const value = successorValue(secret, base, 1);
    expect(value.startsWith("murage_browser_")).toBe(true);
    expect(successorValue(secret, base, 1)).toBe(value);
    expect(successorValue(secret, { ...base, id: "66666666-7777-8888-9999-000000000000" }, 1)).not.toBe(value);
    expect(successorValue(secret, { ...base, createdAt: 2 }, 1)).not.toBe(value);
    expect(successorValue(secret, base, 2)).not.toBe(value);
    expect(successorValue(Buffer.alloc(32, 8), base, 1)).not.toBe(value);
  });

  it("fails closed, changing nothing, when there is no secret to derive from", () => {
    const { registry, value } = signedIn();
    rmSync(SESSION_SECRET_FILE, { force: true });
    mkdirSync(SESSION_SECRET_FILE);
    try {
      dayLater();
      expect(registry.renewSession(value)).toBeNull();
      expect(storedSessions()[0].pending).toBeUndefined();
      expect(registry.resolveSession(value)).not.toBeNull();
    } finally {
      rmSync(SESSION_SECRET_FILE, { recursive: true, force: true });
    }
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/browser-renew.test.ts -t "renewal is derived, idempotent and committed on first use"`
Expected: FAIL with `SyntaxError: The requested module '../src/devices.ts' does not provide an export named 'successorValue'`
- [ ] **Step 3: Write minimal implementation**

In `companion/src/devices.ts`, change line 12 to:
```ts
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
```
and after line 16 add:
```ts
import { loadSessionSecret } from "./session-secret.ts";
```
After `publicDevice` (added in A2) add:
```ts
/** What a renewal hands the door: the value to set as the cookie, and the cap
 * that value will have once it is current (the cookie's Max-Age). */
export interface SessionRenewal {
  value: string;
  session: BrowserSession;
  expiresAt: number;
}

/** The successor a session's current credential leads to, at one generation.
 *
 * An HMAC, so the server can compute it again for a retry without ever
 * storing it. The input names the session (`id`), when it was opened
 * (`createdAt`) and what it currently holds (`hash`) as well as the
 * generation, so no other session, and no later sign-in on this one, can
 * arrive at the same value. */
export function successorValue(
  secret: Buffer,
  session: Pick<BrowserSession, "id" | "createdAt" | "hash">,
  generation: number,
): string {
  const mac = createHmac("sha256", secret)
    .update(`murage-session-successor/1\n${session.id}\n${session.createdAt}\n${session.hash}\n${generation}`)
    .digest("base64url");
  return `murage_browser_${mac}`;
}
```
In the class fields (after line 392 `private lastLoadAttempt = 0;`) add:
```ts
  /** Loaded on the first renewal that needs it, not at construction: a
   * registry that never renews anything never needs the file. */
  private secret: Buffer | null = null;
```
and after `sessionId()` (after line 755) add:
```ts
  /** The successor secret. Throws when it cannot be read; callers fail closed. */
  private sessionSecret(): Buffer {
    this.secret ??= loadSessionSecret();
    return this.secret;
  }

  /** Which of a session's two values `hash` is, if either. */
  private match(session: BrowserSession, hash: string): "current" | "pending" | null {
    if (sameDigest(session.hash, hash)) return "current";
    if (session.pending && sameDigest(session.pending.hash, hash)) return "pending";
    return null;
  }

  /** Make the successor current. The old value dies here and nowhere else.
   *
   * False, having changed nothing, when it cannot be written down: the
   * successor stays pending on disk, so whoever presented it is still
   * authorised and the next request commits it. */
  private commit(session: BrowserSession, now: number): boolean {
    const pending = session.pending;
    if (!pending) return false;
    const previous = {
      hash: session.hash,
      committedAt: session.committedAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
    };
    session.hash = pending.hash;
    delete session.pending;
    session.committedAt = now;
    session.lastSeenAt = now;
    session.expiresAt = renewedExpiry(session, now);
    try {
      this.persist();
      return true;
    } catch {
      Object.assign(session, previous);
      session.pending = pending;
      return false;
    }
  }

  /** Derive and record a new successor at the next generation.
   *
   * Written down BEFORE it is returned. A successor the file does not know
   * about is one a retry cannot be given again and a restart cannot accept. */
  private derive(device: DeviceRecord, session: BrowserSession, now: number): SessionRenewal | null {
    let secret: Buffer;
    try {
      secret = this.sessionSecret();
    } catch {
      return null;
    }
    const generation = device.sessionGeneration + 1;
    const value = successorValue(secret, session, generation);
    const previous = { generation: device.sessionGeneration, pending: session.pending, lastSeenAt: session.lastSeenAt };
    device.sessionGeneration = generation;
    session.pending = { hash: sha256(value), generation, issuedAt: now };
    session.lastSeenAt = now;
    try {
      this.persist();
    } catch {
      // Rolled back, and that generation is free to be derived again: this
      // value was never sent anywhere, so deriving it again later reuses
      // nothing that ever left the process.
      device.sessionGeneration = previous.generation;
      if (previous.pending) session.pending = previous.pending;
      else delete session.pending;
      session.lastSeenAt = previous.lastSeenAt;
      return null;
    }
    return { value, session, expiresAt: renewedExpiry(session, now) };
  }
```
Replace the body of `resolveSession` (lines 859-894, keep the doc comment at 850-858 and add one sentence to it: "Presenting a live successor commits it (`commit`); presenting one past `PENDING_TTL_MS` is refused and changes nothing.") with:
```ts
  resolveSession(
    value: string | undefined,
    now = Date.now(),
  ): { device: DeviceRecord; session: BrowserSession; sessionId: string } | null {
    if (!value) return null;
    this.recover();
    const hash = sha256(value);
    for (const device of this.devices) {
      for (const session of device.sessions ?? []) {
        const which = this.match(session, hash);
        if (!which) continue;
        if (sessionExpired(session, now)) {
          // Take it out on the way past. An expired row that stays is a row
          // that has to be re-judged on every later request.
          device.sessions = device.sessions?.filter((s) => s !== session);
          try {
            this.persist();
          } catch {
            /* it is already refused; the file can catch up */
          }
          // Expiry is a fact about the clock, not about the file, so its
          // streams end whether or not the write above landed.
          this.sessionsEnded(device.id, [session]);
          return null;
        }
        if (which === "pending") {
          // An unused successor past its week is refused, and nothing else
          // changes: the value it would have replaced is still good.
          if (pendingExpired(session.pending!, now)) return null;
          // Commit on first use. A failed write still serves this request —
          // the successor is on disk as pending, which authorises it — and
          // the next request tries the commit again.
          this.commit(session, now);
        } else if (now - session.lastSeenAt > LAST_SEEN_WRITE_MS) {
          session.lastSeenAt = now;
          try {
            this.persist();
          } catch {
            /* the session is still good; the timestamp can wait */
          }
        }
        return { device, session, sessionId: this.sessionId(session) };
      }
    }
    return null;
  }
```
Replace `renewSession` and its doc comment (lines 896-955) with:
```ts
  /** Renewal, made recoverable.
   *
   * A phone loses renewal responses: the app is suspended mid-reply, the
   * network drops. The old design rotated on every call, so a lost reply left
   * the phone holding a value the server had already killed. Now each session
   * holds its `current` value and at most one `pending` successor, derived
   * rather than random (`successorValue`), and:
   *
   *  - presented `current`, with a live `pending`: the same `pending` again.
   *    Every retry gets an identical value, so replies that arrive out of
   *    order cannot disagree.
   *  - presented `current`, no `pending`, due (`SESSION_RENEWAL_DUE_MS` after
   *    the last commit): a new `pending`, written down first.
   *  - presented `pending`: commit it, and return it so the door can refresh
   *    the cookie's lifetime.
   *  - anything else, including "not due yet": null.
   *
   * `current` stays valid until `pending` is committed. Revocation still wins:
   * both values live inside the device record, so `revoke()` takes both, and
   * `createdAt` is never rewritten, so the ceiling stays a wall.
   *
   * Fails CLOSED, and silently: null means "nothing changed", and the door
   * turns it into a 204, never a sign-out. */
  renewSession(value: string | undefined, now = Date.now()): SessionRenewal | null {
    if (!value) return null;
    const hash = sha256(value);
    for (const device of this.devices) {
      for (const session of device.sessions ?? []) {
        const which = this.match(session, hash);
        if (!which) continue;
        // Not reaped here, deliberately. `resolveSession` owns taking a dead
        // row out; renewal's only job on failure is to change nothing.
        if (sessionExpired(session, now)) return null;
        if (which === "pending") {
          if (pendingExpired(session.pending!, now)) return null;
          return this.commit(session, now) ? { value, session, expiresAt: session.expiresAt } : null;
        }
        const pending = session.pending && !pendingExpired(session.pending, now) ? session.pending : undefined;
        if (pending) {
          let resent: string | null = null;
          try {
            resent = successorValue(this.sessionSecret(), session, pending.generation);
          } catch {
            return null;
          }
          if (sameDigest(sha256(resent), pending.hash)) {
            return { value: resent, session, expiresAt: renewedExpiry(session, now) };
          }
          // The secret changed under it (the file was lost and recreated).
          // That successor can still be committed by its hash if anyone holds
          // it, but it cannot be sent again, so derive the next one.
        } else if (now - session.committedAt < SESSION_RENEWAL_DUE_MS) {
          return null;
        }
        return this.derive(device, session, now);
      }
    }
    return null;
  }
```
In `closeSession` (line 967), replace
```ts
      const kept = previous.filter((s) => !sameDigest(s.hash, hash));
```
with
```ts
      // Either value signs the browser out: a cookie jar holding the
      // successor is the same browser as one still holding `current`.
      const kept = previous.filter((s) => !this.match(s, hash));
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/browser-renew.test.ts -t "in the registry"` then `pnpm vitest run companion/test/browser-renew.test.ts -t "renewal is derived"` then `pnpm vitest run companion/test/browser-session-streams.test.ts` then `pnpm vitest run companion/test/devices.test.ts`
Expected: PASS for all four. (The door tests in `browser-renew.test.ts` are fixed in A4; do not run the whole file yet.)
- [ ] **Step 5: Commit**
```
git add companion/src/devices.ts companion/test/browser-renew.test.ts companion/test/browser-session-streams.test.ts
git commit -m "fix(companion): renewal re-sends one derived successor and commits it on first use"
```

---

### Task A4: Renewal at the door, and the client commits what it receives

**Files:**
- Modify: `companion/src/browser.ts:80-85` (`BrowserDeviceStore.renewSession`), `:922-950` (`renewalScript`), `:1185-1215` (renew route)
- Modify (fake store): `companion/test/browser.test.ts:80-91`
- Test: `companion/test/browser-renew.test.ts`

**Interfaces:**
- Consumes: `SessionRenewal` from A3 (structurally)
- Produces: `BrowserDeviceStore.renewSession(value): { value: string; expiresAt: number } | null`; `POST /session/renew` answers 200 `{ ok, expiresAt }` with `Set-Cookie` for the successor (or the committed value), 204 when nothing is due. The renewal script presents a new cookie with `GET /session` right after a 200, which commits it.

- [ ] **Step 1: Write the failing test**

In `companion/test/browser-renew.test.ts`:
- In `"rotates the cookie and retires the one that was presented"` (line 336), insert `dayLater();` after `const first = await signIn();`.
- In `"keeps the absolute cap it advertises in the cookie"` (line 508), insert `dayLater();` after `const cookie = await signIn();`.

Add inside `describe("the door's renewal route", …)`:
```ts
  it("says nothing while renewal is not due", async () => {
    const cookie = await signIn();
    const answer = await knock("POST", "/session/renew", { ...write(), cookie: `${cookieName("http")}=${cookie}` });
    expect(answer.status).toBe(204);
    expect(answer.headers["set-cookie"]).toBeUndefined();
  });

  it("gives a retried renewal the same cookie, and keeps the old one working until the new one is used", async () => {
    const first = await signIn();
    dayLater();
    const header = { ...write(), cookie: `${cookieName("http")}=${first}` };
    // The first reply is "lost": the browser never stored it and asks again.
    const lost = await knock("POST", "/session/renew", header);
    const retried = await knock("POST", "/session/renew", header);
    expect(retried.status).toBe(200);
    expect(cookieOf(retried)).toBe(cookieOf(lost));

    // Until the new value is presented, the old one is still a sign-in.
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${first}` })).status).toBe(200);
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${cookieOf(retried)}` })).status).toBe(200);
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${first}` })).status).toBe(401);
  });

  it("refreshes the cookie when the successor itself is presented for renewal", async () => {
    const first = await signIn();
    dayLater();
    const next = cookieOf(await knock("POST", "/session/renew", { ...write(), cookie: `${cookieName("http")}=${first}` }));
    const again = await knock("POST", "/session/renew", { ...write(), cookie: `${cookieName("http")}=${next}` });
    expect(again.status).toBe(200);
    expect(cookieOf(again)).toBe(next);
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${first}` })).status).toBe(401);
  });
```
Add inside `describe("the browser actually calls it", …)`:
```ts
  it("presents a new cookie straight away, which is what commits it", async () => {
    const calls: Array<{ url: string; method: unknown }> = [];
    const sandbox = {
      fetch: (url: string, init: Record<string, unknown>) => {
        calls.push({ url, method: init?.method });
        return Promise.resolve(url === "/session/renew" ? { status: 200 } : { status: 200 });
      },
      setInterval: () => 0,
      Date: { now: () => 1_700_000_000_000 },
      document: { visibilityState: "visible", addEventListener: () => {} },
    };
    createContext(sandbox);
    runInContext(renewalScript(), sandbox);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([
      { url: "/session/renew", method: "POST" },
      { url: "/session", method: undefined },
    ]);
  });

  it("asks for nothing more when the door had nothing to renew", async () => {
    const calls: string[] = [];
    const sandbox = {
      fetch: (url: string) => {
        calls.push(url);
        return Promise.resolve({ status: 204 });
      },
      setInterval: () => 0,
      Date: { now: () => 1_700_000_000_000 },
      document: { visibilityState: "visible", addEventListener: () => {} },
    };
    createContext(sandbox);
    runInContext(renewalScript(), sandbox);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["/session/renew"]);
  });
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/browser-renew.test.ts -t "presents a new cookie straight away"`
Expected: FAIL with `expected [ { url: '/session/renew', … } ] to deeply equal [ …, { url: '/session', method: undefined } ]`
- [ ] **Step 3: Write minimal implementation**

In `companion/src/browser.ts`, replace lines 80-85 with:
```ts
  /** Renew a live session (`DeviceRegistry.renewSession`): the successor to
   * set as the cookie, the same successor again on a retry, or the committed
   * value when the successor itself is presented. `expiresAt` is the cap that
   * cookie will carry. `null` for anything else, including "not due yet" —
   * the door turns that into a silent no-op, never a sign-out. */
  renewSession(
    value: string | undefined,
  ): { value: string; expiresAt: number } | null;
```
In `renewalScript()`, replace lines 932-940 (the `try { fetch(...) } catch` block) with:
```ts
    try {
      fetch("/session/renew", { method: "POST", credentials: "same-origin" }).then(
        function (r) {
          // A 200 set a new cookie. Present it once, now, while the page is
          // known to be awake: that commits it on the server, and a committed
          // value can never age out the way an unused successor does.
          if (r && r.status === 200) return fetch("/session", { credentials: "same-origin" });
        }
      ).then(
        function () {},
        function () {}
      );
    } catch (e) {
      // Fail closed and silent: the session we have is still the session we
      // had, and saying so on screen would only alarm somebody who is fine.
    }
```
Add to the doc comment above `renewalScript` (after the paragraph ending "sign somebody out that the server has not."):
```ts
 *
 * A 200 is followed by one `GET /session`, which presents the new cookie and
 * so commits it (see `DeviceRegistry.renewSession`). Without it, a tab that
 * then sat idle would leave its successor uncommitted until it aged out.
```
Replace lines 1206-1214 (inside the renew route) with:
```ts
      const renewed = options.devices.renewSession(cookie);
      if (!renewed) {
        res.writeHead(204, BASE_HEADERS);
        res.end();
        return;
      }
      // The successor's own cap, not the current value's: once it is
      // committed, this is how long it lives.
      const maxAge = Math.floor((renewed.expiresAt - Date.now()) / 1000);
      res.setHeader("set-cookie", sessionCookie(renewed.value, identity, maxAge));
      return sendJson(res, 200, { ok: true, expiresAt: renewed.expiresAt });
```
and replace the route's comment paragraph at 1195-1199 with:
```ts
    // The failure answer is 204 with no body and no `Set-Cookie`: nothing
    // happened, nothing to say. That includes "not due yet", which is most
    // calls: the page asks on every load and unlock, and the registry only
    // derives a successor a day after the last commit. Not 401 — a 401 here
    // would invite a client to conclude it had been signed out, which is
    // precisely the outcome renewal exists to avoid.
```
In `companion/test/browser.test.ts`, replace lines 88-90 with:
```ts
    const renewed = { id: session.id, expiresAt: Date.now() + 90 * 24 * 3600 * 1000 };
    sessions.set(next, renewed);
    return { value: next, session: renewed, expiresAt: renewed.expiresAt };
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/browser-renew.test.ts` then `pnpm vitest run companion/test/browser.test.ts`
Expected: PASS (whole files, including the parse check on the served script: no backslash or backtick was added)
- [ ] **Step 5: Commit**
```
git add companion/src/browser.ts companion/test/browser-renew.test.ts companion/test/browser.test.ts
git commit -m "fix(companion): the renewal route re-sends one successor and the page commits it at once"
```

---

### Task A5: `installId` on pairing replaces that install's old record

**Files:**
- Modify: `companion/src/devices.ts:581-720` (`redeem`)
- Modify: `companion/src/browser.ts:60-64` (`BrowserDeviceStore.redeem`), `:746-829` (`enterPage` script), `:1238-1241` (`POST /session`)
- Modify (store wrapper passes the new argument): `companion/test/browser-code.test.ts:64-67`
- Test: `companion/test/devices.test.ts`, `companion/test/browser-code.test.ts`

**Interfaces:**
- Consumes: `cleanInstallId`, `publicDevice`, `DeviceRecord.installId` (A2)
- Produces:
  - `DeviceRegistry.redeem(credential, name, pairRequestId?, installId?: unknown)`
  - `POST /session` body accepts optional `installId`
  - `/enter` fragment contract for the app (Plan 2 relies on this): `/enter#<credential>&installId=<id>`, where `<id>` matches `/^[A-Za-z0-9._-]{16,128}$/`. A camera scan without the suffix pairs as before.

- [ ] **Step 1: Write the failing test**

Append to `companion/test/devices.test.ts`:
```ts
describe("pairing again from the same app install", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const INSTALL = "ios-install-0123456789abcdef";

  const pairAs = (registry: DeviceRegistry, installId: unknown, name = "iPhone") => {
    const { code } = registry.openPairing();
    const result = registry.redeem(code, name, undefined, installId);
    if ("error" in result) throw new Error(`pairing failed: ${result.error}`);
    return result;
  };

  it("replaces that install's old record, and its sessions with it", () => {
    const registry = new DeviceRegistry();
    const before = pairAs(registry, INSTALL, "iPhone (old)");
    const { value } = registry.openSession(before.device.id, "Murage on iPhone")!;
    const { sessionId } = registry.resolveSession(value)!;
    const ended: string[] = [];
    registry.onSessionEnded((event) => ended.push(event.sessionId));

    const after = pairAs(registry, INSTALL, "iPhone (reinstalled)");
    expect(after.device.id).not.toBe(before.device.id);
    expect(registry.list().map((d) => d.name)).toEqual(["iPhone (reinstalled)"]);
    expect(registry.authenticate(before.token)).toBeNull();
    expect(registry.resolveSession(value)).toBeNull();
    expect(ended).toEqual([sessionId]);
    // And on disk.
    expect(new DeviceRegistry().list().map((d) => d.id)).toEqual([after.device.id]);
  });

  it("does not carry the old record's cloud desktop permission across", () => {
    const registry = new DeviceRegistry();
    const before = pairAs(registry, INSTALL);
    registry.setCloudDesktopAccess(before.device.id, true);
    const after = pairAs(registry, INSTALL);
    expect(after.device.cloudDesktopAccess).toBe(false);
  });

  it("leaves other installs, and pairings with no install id, alone", () => {
    const registry = new DeviceRegistry();
    pairAs(registry, INSTALL, "iPhone");
    pairAs(registry, "android-install-fedcba9876543210", "Pixel");
    pairAs(registry, undefined, "Chrome on Mac");
    pairAs(registry, undefined, "Chrome on Mac");
    pairAs(registry, INSTALL, "iPhone again");
    expect(registry.list().map((d) => d.name).sort()).toEqual(["Chrome on Mac", "Chrome on Mac", "Pixel", "iPhone again"]);
  });

  it("ignores an install id it would not key a record on", () => {
    const registry = new DeviceRegistry();
    pairAs(registry, "short", "one");
    pairAs(registry, "short", "two");
    pairAs(registry, { not: "a string" }, "three");
    expect(registry.count()).toBe(3);
    const stored = JSON.parse(readFileSync(join(DATA_DIR, "devices.json"), "utf8"));
    expect(stored.devices.every((d: { installId?: string }) => d.installId === undefined)).toBe(true);
  });

  it("keeps the old record when the replacement cannot be written", () => {
    const registry = new DeviceRegistry();
    const before = pairAs(registry, INSTALL);
    const target = registry as unknown as { persist?: () => void };
    target.persist = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    const { code } = registry.openPairing();
    expect(registry.redeem(code, "iPhone", undefined, INSTALL)).toMatchObject({ reason: "save-failed" });
    delete target.persist;
    expect(registry.authenticate(before.token)?.id).toBe(before.device.id);
    expect(registry.count()).toBe(1);
  });
});
```
Append to `companion/test/browser-code.test.ts` (also add `import { createContext, runInContext } from "node:vm";` to the imports, and change the store's `redeem` at lines 64-67 to forward the fourth argument: `redeem: (credential, name, pairRequestId, installId) => { asked.push(credential); return registry.redeem(credential, name, pairRequestId, installId); },`):
```ts
// ─────────────────────────────────────────────────────────────────────────
// The app's install id, carried through /enter
// ─────────────────────────────────────────────────────────────────────────
interface StubNode {
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  listeners: Record<string, () => void>;
  addEventListener(type: string, fn: () => void): void;
  focus(): void;
}

/** Run the served `/enter` script against a stub page with `hash` in the
 * address bar. `replies` answer its POSTs in order. */
const runEnter = (html: string, hash: string, replies: Array<{ ok: boolean; body: Record<string, unknown> }>) => {
  const nodes = new Map<string, StubNode>();
  const node = (id: string): StubNode => {
    let found = nodes.get(id);
    if (!found) {
      const listeners: Record<string, () => void> = {};
      found = {
        textContent: "",
        hidden: true,
        disabled: false,
        value: "",
        listeners,
        addEventListener: (type, fn) => {
          listeners[type] = fn;
        },
        focus: () => {},
      };
      nodes.set(id, found);
    }
    return found;
  };
  const posted: Array<Record<string, unknown>> = [];
  const sandbox = {
    location: { hash, replace: () => {} },
    history: { replaceState: () => {} },
    navigator: { userAgent: "Mozilla/5.0 (iPhone) MurageApp/1.0 (ios)" },
    document: { getElementById: node },
    fetch: (_url: string, init: { body: string }) => {
      posted.push(JSON.parse(init.body));
      const reply = replies.shift() ?? { ok: true, body: {} };
      return Promise.resolve({ ok: reply.ok, json: () => Promise.resolve(reply.body) });
    },
    setInterval: () => 0,
    clearInterval: () => {},
  };
  createContext(sandbox);
  runInContext(inlineScripts(html)[0], sandbox);
  return { node, posted };
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("pairing from the app replaces its own old record", () => {
  it("sends the install id from the fragment, and the credential without it", async () => {
    const page = await knock("GET", "/enter", { "sec-fetch-mode": "navigate" });
    const { node, posted } = runEnter(page.body, "#murage_pair_abc&installId=ios-install-0123456789abcdef", []);
    node("go").listeners.click();
    await settle();
    expect(posted).toEqual([{ credential: "murage_pair_abc", installId: "ios-install-0123456789abcdef" }]);
  });

  it("sends exactly what it always sent when there is no install id", async () => {
    const page = await knock("GET", "/enter", { "sec-fetch-mode": "navigate" });
    const { node, posted } = runEnter(page.body, "#murage_pair_abc", []);
    node("go").listeners.click();
    await settle();
    expect(posted).toEqual([{ credential: "murage_pair_abc" }]);
  });

  it("replaces the record at the door, so a reinstall does not take a second slot", async () => {
    const origin = { origin: `http://macbook.tail000000.ts.net:${doorPort}` };
    const install = "ios-install-0123456789abcdef";
    const first = await knock("POST", "/session", origin, JSON.stringify({ credential: registry.openPairing().token, installId: install }));
    expect(first.status).toBe(201);
    const oldCookie = String(first.headers["set-cookie"]?.[0] ?? "").split(";")[0].split("=")[1];

    const second = await knock("POST", "/session", origin, JSON.stringify({ credential: registry.openPairing().token, installId: install }));
    expect(second.status).toBe(201);
    expect(registry.count()).toBe(1);
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${oldCookie}` })).status).toBe(401);
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/devices.test.ts -t "pairing again from the same app install"`
Expected: FAIL with `expected [ 'iPhone (old)', 'iPhone (reinstalled)' ] to deeply equal [ 'iPhone (reinstalled)' ]`
- [ ] **Step 3: Write minimal implementation**

In `companion/src/devices.ts`, change the `redeem` signature (lines 587-591) to:
```ts
  redeem(
    credential: string,
    name: unknown,
    pairRequestId?: unknown,
    installId?: unknown,
  ): { device: PublicDevice; token: string } | { error: string; reason: RedeemFailure } {
```
and extend its doc comment with:
```ts
   *
   * An `installId` (from the phone app, see `cleanInstallId`) that matches a
   * paired record replaces that record: same install, reinstalled, is the
   * same phone. Its sessions end with it. Nothing else about the old record
   * carries over, cloud desktop access included; the owner grants that to a
   * record, not to an install id anyone could claim.
```
Replace lines 673-700 (cap check through the persist/rollback) with:
```ts
    const install = cleanInstallId(installId);
    const replaced = install ? this.devices.find((d) => d.installId === install) : undefined;
    // A reinstall frees its own slot, so a full fleet still takes it back.
    if (this.devices.length - (replaced ? 1 : 0) >= MAX_DEVICES) {
      return { error: "too many paired devices — remove one first", reason: "full" };
    }
    // Consume the window without clearing a possible replay. `closePairing`
    // is the explicit cancel operation and intentionally clears both.
    this.spend("used");

    const token = `murage_${randomBytes(32).toString("base64url")}`;
    const device: DeviceRecord = {
      id: randomUUID(),
      name: cleanDeviceName(name),
      tokenHash: sha256(token),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      cloudDesktopAccess: false,
      sessionGeneration: 0,
    };
    if (install) device.installId = install;
    const previous = this.devices;
    this.devices = [...previous.filter((d) => d !== replaced), device];
    // Unlike the lastSeenAt write below, this one must not be swallowed. A
    // device that lives in memory but not on disk is paired until the next
    // restart and then silently is not — the phone keeps a token that stops
    // working for no reason it can show. Roll the registration back (and the
    // replacement with it) and say so, so the user retries now rather than
    // discovering it days later.
    try {
      this.persist();
    } catch (e) {
      this.devices = previous;
      return { error: `could not save the pairing: ${(e as Error).message}`, reason: "save-failed" };
    }
    if (replaced) {
      this.lastSeenWrites.delete(replaced.id);
      // Only browser sessions can be live here. A record the browser door
      // paired never let its bearer token out of the sidecar (`browser.ts`
      // discards it), so no device-port stream can be holding it.
      this.sessionsEnded(replaced.id, replaced.sessions ?? []);
    }
```
(The existing lines 701-719 — `result`, replay bookkeeping, `return result` — follow unchanged, with line 701-702 already replaced in A2.)

In `companion/src/browser.ts`, change `BrowserDeviceStore.redeem` (lines 60-64) to:
```ts
  redeem(
    credential: string,
    name: unknown,
    pairRequestId?: unknown,
    installId?: unknown,
  ): { device: PublicDevice; token: string } | { error: string; reason?: string };
```
In `POST /session`, replace lines 1238-1241 with:
```ts
            const result = options.devices.redeem(
              normalizeCredential(body.credential),
              browserLabel(String(req.headers["user-agent"] ?? "")),
              undefined,
              // The phone app's install id, when `/enter` was opened by the
              // app. Absent from every camera-app scan and typed code.
              body.installId,
            );
```
In `enterPage`, replace line 751 (`var credential = location.hash.slice(1);`) with:
```ts
  var fragment = location.hash.slice(1);
  // The phone app appends its install id after the credential, so pairing
  // again after a reinstall replaces its own old record instead of taking a
  // new slot. A camera-app scan has no such suffix and pairs as it always
  // did. indexOf, not a regular expression: see the note below about this
  // being a template literal.
  var cut = fragment.indexOf("&installId=");
  var credential = cut < 0 ? fragment : fragment.slice(0, cut);
  var installId = cut < 0 ? "" : fragment.slice(cut + 11);
```
and replace line 815 (`body: JSON.stringify({ credential: credential })`) with:
```ts
      body: JSON.stringify(installId ? { credential: credential, installId: installId } : { credential: credential })
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/devices.test.ts` then `pnpm vitest run companion/test/browser-code.test.ts`
Expected: PASS (both files; the existing "parses every script the door actually serves" test proves the edited `/enter` script still parses)
- [ ] **Step 5: Commit**
```
git add companion/src/devices.ts companion/src/browser.ts companion/test/devices.test.ts companion/test/browser-code.test.ts
git commit -m "feat(companion): pairing with the same app install id replaces that install's old record"
```

---

### Task A6: The 20-device cap refuses with a list, oldest-seen first

**Files:**
- Modify: `companion/src/devices.ts` (`redeem` full branch from A5, new `replaceCandidates`, `resolveSession` last-seen stamp from A3)
- Modify: `companion/src/browser.ts:60-64` (`redeem` result type), `:1242-1257` (401 payload), `enterPage` click handler `:816-825`
- Test: `companion/test/devices.test.ts`, `companion/test/browser-code.test.ts`

**Interfaces:**
- Consumes: `publicDevice` (A2), `redeem` (A5)
- Produces:
  - `DeviceRegistry.replaceCandidates(): PublicDevice[]` (empty below `MAX_DEVICES`; else every device, `lastSeenAt` ascending, then `createdAt`)
  - `redeem` `full` refusal: `{ error, reason: "full", devices: Array<{ name: string; lastSeenAt: number }> }`
  - `POST /session` 401 body always carries `reason`; for `full` also `devices`
  - Device `lastSeenAt` is now stamped by browser-session use (previously only by bearer `authenticate`, so every browser-paired phone sorted by its pairing time)

- [ ] **Step 1: Write the failing test**

Append to `companion/test/devices.test.ts` (add `MAX_DEVICES` to the `../src/devices.ts` import):
```ts
describe("a full fleet", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  /** Twenty devices paired a minute apart; returns their tokens in order. */
  const fill = (registry: DeviceRegistry, start: number): string[] => {
    const tokens: string[] = [];
    for (let i = 0; i < MAX_DEVICES; i += 1) {
      vi.setSystemTime(start + i * 60_000);
      tokens.push(pair(registry, `Phone ${i}`).token);
    }
    return tokens;
  };

  it("refuses the right code with every device, least recently seen first", () => {
    try {
      const start = Date.now();
      const registry = new DeviceRegistry();
      const tokens = fill(registry, start);
      // Phone 0 is the oldest pairing but was used a moment ago.
      vi.setSystemTime(start + 60 * 60_000);
      registry.authenticate(tokens[0]);

      const { code } = registry.openPairing();
      const refused = registry.redeem(code, "New phone");
      expect(refused).toMatchObject({ reason: "full" });
      const listed = (refused as { devices: Array<{ name: string; lastSeenAt: number }> }).devices;
      expect(listed).toHaveLength(MAX_DEVICES);
      expect(listed[0].name).toBe("Phone 1");
      expect(listed.at(-1)?.name).toBe("Phone 0");
      expect(listed[0]).not.toHaveProperty("id");
      // The same order is what the computer offers to replace.
      expect(registry.replaceCandidates().map((d) => d.name)).toEqual(listed.map((d) => d.name));

      // The window survives: replace one on the computer, and the same code works.
      expect(registry.revoke(registry.replaceCandidates()[0].id)).toBe(true);
      expect(registry.redeem(code, "New phone")).toHaveProperty("token");
      expect(registry.replaceCandidates()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a browser-only phone as seen when its session is used", () => {
    try {
      const start = Date.now();
      vi.setSystemTime(start);
      const registry = new DeviceRegistry();
      const { device } = pair(registry, "Browser phone");
      const { value } = registry.openSession(device.id, "Safari on iPhone")!;
      vi.setSystemTime(start + 10 * 60_000);
      registry.resolveSession(value);
      expect(registry.list()[0].lastSeenAt).toBe(start + 10 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
```
Append to `companion/test/browser-code.test.ts` (add `MAX_DEVICES` to the `../src/devices.ts` import):
```ts
describe("pairing into a full fleet", () => {
  const fillFleet = () => {
    for (let i = 0; i < MAX_DEVICES; i += 1) {
      const result = registry.redeem(registry.openPairing().token, `Phone ${i}`);
      if ("error" in result) throw new Error(result.error);
    }
  };

  it("tells the phone why, lists the devices, and does not count it as a guess", async () => {
    fillFleet();
    const token = registry.openPairing().token;
    const refused = await submitCode(token);
    expect(refused.status).toBe(401);
    const body = bodyOf(refused);
    expect(body.reason).toBe("full");
    expect((body.devices as unknown[]).length).toBe(MAX_DEVICES);
    expect(body.retryAfter).toBeUndefined();

    // Replaced on the computer, then the same link again.
    registry.revoke(registry.replaceCandidates()[0].id);
    expect((await submitCode(token)).status).toBe(201);
  });

  it("puts a Try again button on /enter instead of spending the link", async () => {
    const page = await knock("GET", "/enter", { "sec-fetch-mode": "navigate" });
    const { node, posted } = runEnter(page.body, "#murage_pair_abc", [
      { ok: false, body: { error: "too many paired devices — remove one first", reason: "full", devices: [] } },
      { ok: true, body: {} },
    ]);
    node("go").listeners.click();
    await settle();
    expect(node("go").disabled).toBe(false);
    expect(node("go").textContent).toBe("Try again");
    expect(node("t").textContent).toBe("This computer has too many devices");
    node("go").listeners.click();
    await settle();
    expect(posted).toHaveLength(2);
  });
});
```
(`runEnter` and `settle` come from A5; keep this block after that one.)
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/devices.test.ts -t "a full fleet"`
Expected: FAIL with `TypeError: registry.replaceCandidates is not a function`
- [ ] **Step 3: Write minimal implementation**

In `companion/src/devices.ts`, change the `redeem` return type to:
```ts
  ): { device: PublicDevice; token: string } | { error: string; reason: RedeemFailure; devices?: Array<{ name: string; lastSeenAt: number }> } {
```
and replace the `full` return inside the cap check (from A5) with:
```ts
      // Names and when each was last seen, least recent first: enough for the
      // phone to say what is going on. Not ids — replacing one happens on the
      // computer (`replaceCandidates`), never from the phone.
      return {
        error: "this computer already has the most devices it can pair — replace an old one on your computer, then try again",
        reason: "full",
        devices: this.byLastSeen().map(({ name, lastSeenAt }) => ({ name, lastSeenAt })),
      };
```
After `count()` (line 498) add:
```ts
  /** Every device, least recently seen first. */
  private byLastSeen(): PublicDevice[] {
    return this.list().sort((a, b) => a.lastSeenAt - b.lastSeenAt || a.createdAt - b.createdAt);
  }

  /** What the pairing screen offers to replace: every device, least recently
   * seen first, once the fleet is full. Empty below the cap, because below it
   * nothing has to go for a new device to join. There is no automatic
   * pruning: a record that looks browser-only may still hold a working
   * bearer, so the owner chooses. */
  replaceCandidates(): PublicDevice[] {
    this.recover();
    return this.devices.length >= MAX_DEVICES ? this.byLastSeen() : [];
  }
```
In `resolveSession` (A3 version), replace
```ts
        } else if (now - session.lastSeenAt > LAST_SEEN_WRITE_MS) {
          session.lastSeenAt = now;
```
with
```ts
        } else if (now - session.lastSeenAt > LAST_SEEN_WRITE_MS) {
          session.lastSeenAt = now;
          // The device was seen too. Only bearer use stamped it before, so a
          // phone paired through the browser door showed "last seen" as the
          // day it paired, and a replace list sorted by it was wrong.
          device.lastSeenAt = Math.max(device.lastSeenAt, now);
```
and in `commit` (A3), after `session.lastSeenAt = now;` add `device.lastSeenAt = Math.max(device.lastSeenAt, now);` — change `commit`'s signature to `commit(device: DeviceRecord, session: BrowserSession, now: number)`, save `lastSeen: device.lastSeenAt` in `previous` and restore it in the `catch`, and update its two callers (`this.commit(device, session, now)`).

In `companion/src/browser.ts`, change the `redeem` result type (lines 60-65) to:
```ts
  ): { device: PublicDevice; token: string } | { error: string; reason?: string; devices?: Array<{ name: string; lastSeenAt: number }> };
```
Replace line 1247 (`const payload: Record<string, unknown> = { error: result.error };`) with:
```ts
              const payload: Record<string, unknown> = { error: result.error };
              // The stable code, for the page to act on rather than parse
              // prose. `full` also lists the devices, least recently seen
              // first, so the person knows why and what to replace.
              if (result.reason) payload.reason = result.reason;
              if (result.reason === "full" && result.devices) payload.devices = result.devices;
```
In `enterPage`, replace lines 818-819 (`if (r.ok) …` and `say("Could not sign in", …)`) with:
```ts
        if (r.ok) { location.replace("/"); return; }
        if (body.reason === "full") {
          // Right code, full computer. The code is not spent, so once an old
          // device is replaced there, this same button signs in.
          say("This computer has too many devices", "On your computer, Murage lists them under Replace an old device. Replace one, then tap Try again.");
          go.textContent = "Try again";
          go.disabled = false;
          return;
        }
        say("Could not sign in", body.error || "That code is no longer valid.");
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/devices.test.ts` then `pnpm vitest run companion/test/browser-code.test.ts` then `pnpm vitest run companion/test/browser-renew.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
```
git add companion/src/devices.ts companion/src/browser.ts companion/test/devices.test.ts companion/test/browser-code.test.ts
git commit -m "feat(companion): a full fleet refuses pairing with its devices, oldest-seen first"
```

---

### Task A7: The control page offers "Replace an old device"

**Files:**
- Modify: `companion/src/control.ts:18` (import), `:216-250` (`companionState`), `:496-517` (page `render`)
- Test: `companion/test/control-capacity.test.ts` (new file: needs its own registry and data dir, `control.test.ts` shares one registry across tests)

**Interfaces:**
- Consumes: `DeviceRegistry.replaceCandidates()` (A6), `MAX_DEVICES`
- Produces: `/state` gains `maxDevices: number` and `replaceCandidates: PublicDevice[]`; the page shows a replace list while a pairing window is open and the fleet is full, each button calling `DELETE /devices/:id`

- [ ] **Step 1: Write the failing test**
```ts
// The computer's half of a full fleet. A phone told "too many devices" can
// do nothing about it; the pairing screen on the computer has to offer the
// fix, in the order that makes the right choice obvious.
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createControlServer } from "../src/control.ts";
import { DeviceRegistry, MAX_DEVICES } from "../src/devices.ts";
import { DATA_DIR } from "../src/state.ts";

let control: Server;
let port = 0;
let devices: DeviceRegistry;

const ask = async (method: string, path: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
};

beforeAll(async () => {
  control = createControlServer({
    get devices() {
      return devices;
    },
    companionPort: 8810,
    discovery: () => ({ advertising: false, name: "Test computer" }),
  } as Parameters<typeof createControlServer>[0]);
  port = await new Promise<number>((resolve) =>
    control.listen(0, "127.0.0.1", () => resolve((control.address() as { port: number }).port)),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => control.close(() => resolve()));
});

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  devices = new DeviceRegistry();
});

const fill = () => {
  const start = Date.now();
  try {
    for (let i = 0; i < MAX_DEVICES; i += 1) {
      vi.setSystemTime(start + i * 60_000);
      const result = devices.redeem(devices.openPairing().code, `Phone ${i}`);
      if ("error" in result) throw new Error(result.error);
    }
  } finally {
    vi.useRealTimers();
  }
};

describe("replacing an old device from the pairing screen", () => {
  it("reports the cap, and no candidates while there is room", async () => {
    const { body } = await ask("GET", "/state");
    expect(body.maxDevices).toBe(MAX_DEVICES);
    expect(body.replaceCandidates).toEqual([]);
  });

  it("lists every device least recently seen first once full, and replacing one lets the same code in", async () => {
    fill();
    const opened = await ask("POST", "/pairing");
    expect(opened.body.replaceCandidates.map((d: { name: string }) => d.name)).toEqual(
      Array.from({ length: MAX_DEVICES }, (_, i) => `Phone ${i}`),
    );
    expect(opened.body.replaceCandidates[0]).not.toHaveProperty("tokenHash");

    const oldest = opened.body.replaceCandidates[0].id;
    const after = await ask("DELETE", `/devices/${oldest}`);
    expect(after.status).toBe(200);
    expect(after.body.replaceCandidates).toEqual([]);
    expect(devices.redeem(opened.body.code, "New phone")).toHaveProperty("token");
  });

  it("puts the replace list on the page, wired to the same revoke", async () => {
    const page = await ask("GET", "/");
    expect(page.body).toContain("Replace an old device");
    expect(page.body).toContain("data-replace");
    expect(page.body).toContain('"/devices/" + b.dataset.replace, "DELETE"');
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/control-capacity.test.ts`
Expected: FAIL with `expected undefined to be 20` (no `maxDevices` in `/state`)
- [ ] **Step 3: Write minimal implementation**

In `companion/src/control.ts`, change line 18 to:
```ts
import { MAX_DEVICES, PAIRING_TTL_MS, type DeviceRegistry } from "./devices.ts";
```
In `companionState`, after line 238 (`devices: options.devices.list(),`) add:
```ts
    // The pairing screen's answer to a full fleet: the cap, and — only once
    // it is reached — every device least recently seen first, so the one to
    // replace is at the top. Replacing is the ordinary revoke below.
    maxDevices: MAX_DEVICES,
    replaceCandidates: options.devices.replaceCandidates(),
```
In the page's `render`, after the `el("pair").innerHTML = …;` statement (ends line 500) add:
```ts
  if (s.pairing && s.replaceCandidates && s.replaceCandidates.length) {
    el("pair").innerHTML +=
      "<h2>Replace an old device</h2><p class=dim>This computer already has " + s.maxDevices +
      " devices, so a new one cannot join. Remove one you no longer use. The code above keeps working.</p><ul>" +
      s.replaceCandidates.map((d) =>
        "<li><div class='grow'><div class=name>" + esc(d.name) + "</div>" +
        "<div class=dim>Last seen " + ago(d.lastSeenAt) + "</div></div>" +
        "<button data-replace='" + esc(d.id) + "'>Replace</button></li>").join("") + "</ul>";
  }
```
and after the `data-revoke` listener loop (after line 517) add:
```ts
  for (const b of document.querySelectorAll("[data-replace]")) {
    b.addEventListener("click", async () => render(await api("/devices/" + b.dataset.replace, "DELETE")));
  }
```
(No backslashes and no `${`: this script lives inside the page's template literal.)
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/control-capacity.test.ts` then `pnpm vitest run companion/test/control.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
```
git add companion/src/control.ts companion/test/control-capacity.test.ts
git commit -m "feat(companion): the pairing page offers to replace an old device when the fleet is full"
```

---

### Task A8: "Replace an old device" in the desktop app's pairing screens

**Files:**
- Create: `src/components/ReplaceOldDevice.tsx`
- Modify: `src/components/PhoneSetupFlow.tsx:69-75` (`CompanionState`), `:1593-1605` (pairing screen)
- Modify: `src/components/CompanionSection.tsx:1-30` (import), `:274-320` (`QrLogin`)
- Test: `src/components/ReplaceOldDevice.test.ts`

**Interfaces:**
- Consumes: `/state` `maxDevices`, `replaceCandidates` (A7) passed through `electron/companion.mjs:528` unchanged; `CompanionBridge.revoke`, `PhoneSetupController.act`/`busy`
- Produces: `export function ReplaceOldDevice(props: { candidates: PhoneDevice[]; max?: number; busy: boolean; onReplace: (deviceId: string) => void }): JSX.Element | null`; `export function lastSeenLabel(at: number, now?: number): string`

- [ ] **Step 1: Write the failing test**
```ts
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { lastSeenLabel, ReplaceOldDevice } from "./ReplaceOldDevice";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

const device = (id: string, name: string, lastSeenAt: number) => ({
  id,
  name,
  createdAt: lastSeenAt,
  lastSeenAt,
  cloudDesktopAccess: false,
});

describe("Replace an old device", () => {
  it("renders nothing while there is room for another device", () => {
    expect(renderToStaticMarkup(createElement(ReplaceOldDevice, { candidates: [], busy: false, onReplace: vi.fn() }))).toBe("");
  });

  it("lists devices in the order the computer sent, each with its own labelled Replace button", () => {
    const now = Date.now();
    const html = renderToStaticMarkup(
      createElement(ReplaceOldDevice, {
        candidates: [device("a", "Old iPad", now - 40 * 86_400_000), device("b", "Pixel", now - 60_000)],
        max: 20,
        busy: false,
        onReplace: vi.fn(),
      }),
    );
    expect(html).toContain("Replace an old device");
    expect(html).toContain("already has 20 devices");
    expect(html.indexOf("Old iPad")).toBeLessThan(html.indexOf("Pixel"));
    expect(html).toContain('aria-label="Replace Old iPad"');
    expect(html).toContain('type="button"');
  });

  it("says when each was last seen in words", () => {
    const now = 1_700_000_000_000;
    expect(lastSeenLabel(now - 30_000, now)).toBe("just now");
    expect(lastSeenLabel(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(lastSeenLabel(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(lastSeenLabel(now - 40 * 86_400_000, now)).toBe("40 d ago");
  });

  it("is offered on both pairing screens, and replacing is the ordinary revoke", () => {
    for (const source of [read("./CompanionSection.tsx"), read("./PhoneSetupFlow.tsx")]) {
      expect(source).toContain("<ReplaceOldDevice");
      expect(source).toContain("candidates={c.state?.replaceCandidates ?? []}");
      expect(source).toContain("onReplace={(id) => void c.act((companion) => companion.revoke(id))}");
    }
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/components/ReplaceOldDevice.test.ts`
Expected: FAIL with "Failed to resolve import ./ReplaceOldDevice"
- [ ] **Step 3: Write minimal implementation**

Create `src/components/ReplaceOldDevice.tsx`:
```tsx
import type { PhoneDevice } from "./PhoneSetupFlow";

/** "5 min ago", for a device list. */
export function lastSeenLabel(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** The pairing screen's answer to a full fleet.
 *
 * The companion only sends `candidates` once every slot is taken, already
 * sorted least recently seen first (`DeviceRegistry.replaceCandidates`), so
 * this renders them as given and never re-sorts. Replacing is the ordinary
 * revoke. The pairing code on screen survives it, so the phone that was
 * refused taps Try again and is in. */
export function ReplaceOldDevice({
  candidates,
  max,
  busy,
  onReplace,
}: {
  candidates: PhoneDevice[];
  max?: number;
  busy: boolean;
  onReplace: (deviceId: string) => void;
}) {
  if (!candidates.length) return null;
  return (
    <div
      role="group"
      aria-label="Replace an old device"
      className="mt-4 w-full max-w-[390px] rounded-xl border border-hairline/40 px-4 py-3 text-left"
    >
      <div className="text-[13px] font-medium text-ink">Replace an old device</div>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
        This computer already has {max ?? candidates.length} devices, so a new one can't join. Remove one you no
        longer use. The code on screen keeps working.
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {candidates.map((device) => (
          <li key={device.id} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-[12.5px] text-ink">{device.name}</div>
              <div className="text-[11px] text-ink-secondary">Last seen {lastSeenLabel(device.lastSeenAt)}</div>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => onReplace(device.id)}
              aria-label={`Replace ${device.name}`}
              className="min-h-9 shrink-0 rounded-lg px-3 text-[12px] text-danger hover:bg-control disabled:opacity-40"
            >
              Replace
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```
In `src/components/PhoneSetupFlow.tsx`, after line 73 (`devices: PhoneDevice[];`) add:
```ts
  /** The companion's device cap. Optional: an older sidecar does not say. */
  maxDevices?: number;
  /** Every paired device, least recently seen first — sent only once the
   * fleet is full, and rendered as "Replace an old device" while a pairing
   * window is open. Empty or absent means there is room. */
  replaceCandidates?: PhoneDevice[];
```
Add `import { ReplaceOldDevice } from "./ReplaceOldDevice";` next to the other component imports (after line 59), and after the code block that ends at line 1605 insert:
```tsx
      {!c.pairingExpired && c.state?.pairing && (
        <ReplaceOldDevice
          candidates={c.state?.replaceCandidates ?? []}
          max={c.state?.maxDevices}
          busy={c.busy}
          onReplace={(id) => void c.act((companion) => companion.revoke(id))}
        />
      )}
```
In `src/components/CompanionSection.tsx`, add `import { ReplaceOldDevice } from "./ReplaceOldDevice";` after line 30, and in `QrLogin`, directly before the closing `</div>` at line 321 insert:
```tsx
      {pairing && (
        <ReplaceOldDevice
          candidates={c.state?.replaceCandidates ?? []}
          max={c.state?.maxDevices}
          busy={c.busy}
          onReplace={(id) => void c.act((companion) => companion.revoke(id))}
        />
      )}
```
(`ReplaceOldDevice.tsx` imports only the `PhoneDevice` type from `PhoneSetupFlow`, so there is no runtime import cycle.)
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/components/ReplaceOldDevice.test.ts` then `pnpm vitest run src/components/CompanionSection.test.ts` then `pnpm vitest run src/components/PhoneSetupFlow.test.ts` then `pnpm vitest run src/components/RemoteSurface.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
```
git add src/components/ReplaceOldDevice.tsx src/components/ReplaceOldDevice.test.ts src/components/PhoneSetupFlow.tsx src/components/CompanionSection.tsx
git commit -m "feat(phone): the pairing screen offers to replace an old device when the fleet is full"
```

---

### Task A9: Remote "Sign out this device" revokes the calling device

**Files:**
- Modify: `companion/src/devices.ts` (new `signOutDevice`, after `revoke` at 1009)
- Modify: `companion/src/browser.ts:55-86` (`BrowserDeviceStore`), `:88-107` (`BrowserDoorOptions`), before line 1217 (new route)
- Modify: `companion/src/index.ts:428-438` (wire `disconnectDevice`)
- Modify (store doubles gain the method): `companion/test/browser.test.ts:59-92`, `companion/test/browser-code.test.ts:63-73`, `companion/test/browser-renew.test.ts:277-284`, `companion/test/browser-session-streams.test.ts:181-188`, `companion/test/companion-authority.test.ts:38,89`
- Test: `companion/test/devices.test.ts`, `companion/test/browser-code.test.ts`

**Interfaces:**
- Consumes: `resolveSession`, `revoke`
- Produces:
  - `DeviceRegistry.signOutDevice(value: string | undefined): string | null` (the revoked device id; throws when the removal cannot be written)
  - `BrowserDeviceStore.signOutDevice` (same signature)
  - `BrowserDoorOptions.disconnectDevice?: (deviceId: string) => void`
  - `DELETE /session/device`: 200 `{ ok: true }` + cleared cookie; 401 `{ error: "sign in", signIn: "/enter" }` with no live session; 500 when it cannot be written; 404 for other methods. Push binding removal is Plan 3 (it hooks the same revoke).

- [ ] **Step 1: Write the failing test**

Append to `companion/test/devices.test.ts`:
```ts
describe("signing a device out from the device itself", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("revokes the device behind the session, not just the session", () => {
    const registry = new DeviceRegistry();
    const phone = pair(registry, "iPhone");
    const other = pair(registry, "iPad");
    const first = registry.openSession(phone.device.id, "Murage on iPhone")!;
    const second = registry.openSession(phone.device.id, "Safari on iPhone")!;

    expect(registry.signOutDevice(first.value)).toBe(phone.device.id);
    expect(registry.resolveSession(first.value)).toBeNull();
    expect(registry.resolveSession(second.value)).toBeNull();
    expect(registry.authenticate(phone.token)).toBeNull();
    expect(registry.authenticate(other.token)?.id).toBe(other.device.id);
    expect(new DeviceRegistry().list().map((d) => d.id)).toEqual([other.device.id]);
  });

  it("does nothing for a cookie that is not a live session", () => {
    const registry = new DeviceRegistry();
    pair(registry);
    expect(registry.signOutDevice(undefined)).toBeNull();
    expect(registry.signOutDevice("murage_browser_never_issued")).toBeNull();
    expect(registry.count()).toBe(1);
  });
});
```
Append to `companion/test/browser-code.test.ts`. First, add `let disconnected: string[] = [];` next to `let asked` (line 59), reset it in `beforeEach` (`disconnected = [];`), add `signOutDevice: (value) => registry.signOutDevice(value),` to `store`, and pass `disconnectDevice: (deviceId: string) => { disconnected.push(deviceId); },` in `openDoor`'s `createBrowserHandler` options.
```ts
describe("signing this device out, from the device", () => {
  const signedIn = async (): Promise<string> => {
    const answer = await submitCode(registry.openPairing().token);
    expect(answer.status).toBe(201);
    return String(answer.headers["set-cookie"]?.[0] ?? "").split(";")[0].split("=")[1];
  };
  const origin = () => ({ origin: `http://macbook.tail000000.ts.net:${doorPort}` });

  it("removes the whole device, clears the cookie and ends its streams", async () => {
    const cookie = await signedIn();
    const [device] = registry.list();
    const answer = await knock("DELETE", "/session/device", { ...origin(), cookie: `${cookieName("http")}=${cookie}` });
    expect(answer.status).toBe(200);
    expect(String(answer.headers["set-cookie"]?.[0] ?? "")).toContain("Max-Age=0");
    expect(registry.count()).toBe(0);
    expect(disconnected).toEqual([device.id]);
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${cookie}` })).status).toBe(401);
  });

  it("is a write, so nothing cross-site can sign a phone out", async () => {
    const cookie = await signedIn();
    const header = { cookie: `${cookieName("http")}=${cookie}` };
    expect((await knock("DELETE", "/session/device", header)).status).toBe(403);
    expect((await knock("DELETE", "/session/device", { ...header, origin: "http://evil.example" })).status).toBe(403);
    expect((await knock("GET", "/session/device", header)).status).toBe(404);
    expect(registry.count()).toBe(1);
  });

  it("answers a stranger with a sign-in, and revokes nothing", async () => {
    await signedIn();
    const answer = await knock("DELETE", "/session/device", origin());
    expect(answer.status).toBe(401);
    expect(bodyOf(answer)).toEqual({ error: "sign in", signIn: "/enter" });
    expect(registry.count()).toBe(1);
    expect(disconnected).toEqual([]);
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/devices.test.ts -t "signing a device out from the device itself"`
Expected: FAIL with `TypeError: registry.signOutDevice is not a function`
- [ ] **Step 3: Write minimal implementation**

In `companion/src/devices.ts`, after `revoke` (line 1009) add:
```ts
  /** "Sign out this phone", asked by the phone. Revokes the DEVICE the
   * presented session belongs to — every session on it, its bearer and (once
   * push lands) its push binding — because a phone that signs out and leaves
   * its record behind is a record that still counts toward the cap and still
   * shows as paired on the computer.
   *
   * The id of the revoked device, or null when the value is not a live
   * session. Throws, having changed nothing, when the removal cannot be
   * written down, same as `revoke`. */
  signOutDevice(value: string | undefined): string | null {
    const resolved = this.resolveSession(value);
    if (!resolved) return null;
    return this.revoke(resolved.device.id) ? resolved.device.id : null;
  }
```
In `companion/src/browser.ts`, replace the `BrowserDeviceStore` doc comment (lines 55-58) with:
```ts
/** The slice of `DeviceRegistry` this door needs. Structural rather than the
 * class, so a test can state the world in a few lines — and so it is visible
 * at a glance that the door can pair, sign in, sign out, and revoke only the
 * device its own cookie belongs to. It cannot list or enumerate anything. */
```
and after `closeSession(value: string | undefined): boolean;` (line 79) add:
```ts
  /** Revoke the device this session belongs to; its id, or null when the
   * value is not a live session. Throws when it cannot be written down. */
  signOutDevice(value: string | undefined): string | null;
```
In `BrowserDoorOptions`, after `connected?` (line 101) add:
```ts
  /** End every live stream a device owns, bearer ones included. Called after
   * a device signs itself out, the same call the control page makes after a
   * revoke. */
  disconnectDevice?: (deviceId: string) => void;
```
Insert before line 1217 (`if (path === "/session") {`):
```ts
    // ── "Sign out this device", from the device ─────────────────────────
    //
    // Sidecar-owned, like `/session`. DELETE, so the origin gate's rule 4
    // applies: a write must carry our `Origin`, which is the CSRF story for
    // a route that removes a device. It revokes the DEVICE, not the one
    // session — see `DeviceRegistry.signOutDevice`.
    if (path === "/session/device") {
      if (method !== "DELETE") return sendJson(res, 404, { error: `no route: ${method} ${path}` });
      req.resume();
      const cookie = readCookie(req.headers.cookie, cookieName(identity.scheme));
      let deviceId: string | null;
      try {
        deviceId = options.devices.signOutDevice(cookie);
      } catch {
        // The device is still on disk and still in memory. Saying "signed
        // out" would be false, and clearing the cookie would hide the only
        // credential able to retry. No detail: it names paths on the computer.
        return sendJson(res, 500, { error: "could not sign this device out on the computer — try again" });
      }
      if (!deviceId) return sendJson(res, 401, { error: "sign in", signIn: "/enter" });
      // Browser streams already ended with their sessions (`onSessionEnded`);
      // this also ends any bearer stream the device held.
      options.disconnectDevice?.(deviceId);
      res.setHeader("set-cookie", clearedCookie(identity));
      return sendJson(res, 200, { ok: true });
    }

```
In `companion/src/index.ts`, after line 433 (`connected: connectedDevices.open,`) add:
```ts
  // A device that signs itself out loses every stream, bearer ones too —
  // the same call the control page's revoke makes.
  disconnectDevice: connectedDevices.disconnect,
```
Store doubles (type-check only; `tsconfig.server.json` includes `companion`):
- `companion/test/browser.test.ts` after line 79: `signOutDevice: () => null,`
- `companion/test/browser-renew.test.ts` after line 282: `signOutDevice: (value) => registry.signOutDevice(value),`
- `companion/test/browser-session-streams.test.ts` after line 186: `signOutDevice: (value) => registry.signOutDevice(value),`
- `companion/test/companion-authority.test.ts` lines 38 and 89: append `signOutDevice:()=>null,` after `renewSession:()=>null,`
- [ ] **Step 4: Run test to verify it passes**
Run, one at a time: `pnpm vitest run companion/test/devices.test.ts`, `pnpm vitest run companion/test/browser-code.test.ts`, `pnpm vitest run companion/test/browser.test.ts`, `pnpm vitest run companion/test/companion-authority.test.ts`, then `pnpm typecheck`
Expected: PASS, and `tsc` exits 0
- [ ] **Step 5: Commit**
```
git add companion/src/devices.ts companion/src/browser.ts companion/src/index.ts companion/test/devices.test.ts companion/test/browser-code.test.ts companion/test/browser.test.ts companion/test/browser-renew.test.ts companion/test/browser-session-streams.test.ts companion/test/companion-authority.test.ts
git commit -m "feat(companion): a paired device can sign itself out, which revokes the device"
```

---

### Task A10: "Sign out this device" button on remote settings

**Files:**
- Create: `src/lib/remote-sign-out.ts`, `src/components/RemoteSignOut.tsx`
- Modify: `src/components/SettingsModal.tsx:806` (General section)
- Test: `src/lib/remote-sign-out.test.ts`, `src/components/RemoteSignOut.test.ts`

**Interfaces:**
- Consumes: `DELETE /session/device` (A9); `window.murageNative.signOut()` when present (native channel, spec §3.2; Plan 2 implements it)
- Produces: `signOutThisDevice(fetchImpl?): Promise<{ ok: true } | { ok: false; error: string }>`; `afterSignOut(win?): void`; `<RemoteSignOut />`

- [ ] **Step 1: Write the failing test**

`src/lib/remote-sign-out.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";

import { afterSignOut, signOutThisDevice } from "./remote-sign-out";

const reply = (status: number, body: unknown = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("signing this device out", () => {
  it("asks the door to remove this device, as a same-origin DELETE", async () => {
    const fetchImpl = reply(200, { ok: true });
    expect(await signOutThisDevice(fetchImpl as unknown as typeof fetch)).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith("/session/device", { method: "DELETE", credentials: "same-origin" });
  });

  it("treats an already-signed-out device as done", async () => {
    expect(await signOutThisDevice(reply(401, { error: "sign in" }) as unknown as typeof fetch)).toEqual({ ok: true });
  });

  it("says the computer's own sentence when it could not finish", async () => {
    const result = await signOutThisDevice(
      reply(500, { error: "could not sign this device out on the computer — try again" }) as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, error: "could not sign this device out on the computer — try again" });
  });

  it("says the computer is unreachable when the request never lands", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await signOutThisDevice(offline as unknown as typeof fetch);
    expect(result.ok).toBe(false);
  });
});

describe("after signing out", () => {
  it("hands over to the app's re-pair screen when running inside the app", () => {
    const signOut = vi.fn();
    const replace = vi.fn();
    afterSignOut({ murageNative: { signOut }, location: { replace } } as unknown as Window);
    expect(signOut).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });

  it("goes back to the door's sign-in page in a plain browser", () => {
    const replace = vi.fn();
    afterSignOut({ location: { replace } } as unknown as Window);
    expect(replace).toHaveBeenCalledWith("/");
  });
});
```
`src/components/RemoteSignOut.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RemoteSignOut } from "./RemoteSignOut";

const settings = readFileSync(new URL("./SettingsModal.tsx", import.meta.url), "utf8");

describe("the remote sign-out control", () => {
  it("starts as one clearly named button that does nothing until confirmed", () => {
    const html = renderToStaticMarkup(createElement(RemoteSignOut));
    expect(html).toContain("Sign out this device");
    expect(html).toContain('type="button"');
    expect(html).not.toContain("Signing out");
  });

  it("appears only on a confirmed remote surface, in General", () => {
    const general = settings.slice(settings.indexOf('{section === "general" && ('), settings.indexOf('{desktop === true && section === "backups"'));
    expect(general).toContain("{desktop === false && <RemoteSignOut />}");
  });
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/lib/remote-sign-out.test.ts`
Expected: FAIL with "Failed to resolve import ./remote-sign-out"
- [ ] **Step 3: Write minimal implementation**

`src/lib/remote-sign-out.ts`:
```ts
/** "Sign out this device", from the device.
 *
 * Revokes the device on the computer (`DELETE /session/device`, answered by
 * the browser door), not only this browser's session: a phone that signs out
 * should stop counting toward the device cap and stop showing as paired.
 *
 * A 401 is success. It means this device is already not signed in, which is
 * the state the person asked for. */
export type RemoteSignOutResult = { ok: true } | { ok: false; error: string };

export async function signOutThisDevice(fetchImpl: typeof fetch = fetch): Promise<RemoteSignOutResult> {
  let res: Response;
  try {
    res = await fetchImpl("/session/device", { method: "DELETE", credentials: "same-origin" });
  } catch {
    return { ok: false, error: "Couldn't reach your computer. Check the connection and try again." };
  }
  if (res.ok || res.status === 401) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return { ok: false, error: typeof body.error === "string" ? body.error : "Couldn't sign out. Try again." };
}

/** Where a signed-out device goes: the app's own re-pair screen when this
 * page is running inside the Murage app, the door's sign-in page otherwise. */
export function afterSignOut(win: Window = window): void {
  const native = (win as Window & { murageNative?: { signOut?: () => unknown } }).murageNative;
  if (typeof native?.signOut === "function") {
    native.signOut();
    return;
  }
  win.location.replace("/");
}
```
`src/components/RemoteSignOut.tsx`:
```tsx
import { useState } from "react";

import { afterSignOut, signOutThisDevice } from "../lib/remote-sign-out";
import { Card } from "./SettingsPrimitives";

/** The one piece of device management that belongs on the device: removing
 * itself. Everything else about paired devices lives on the computer.
 *
 * Two taps, because the way back is a QR code on a computer that may be at
 * home. */
export function RemoteSignOut() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOut = async () => {
    setBusy(true);
    setError(null);
    const result = await signOutThisDevice();
    if (result.ok) {
      afterSignOut();
      return;
    }
    setBusy(false);
    setError(result.error);
  };

  return (
    <Card
      title="This device"
      subtitle="Signing out removes this device from your computer. To use Murage here again, scan the code in Settings → Phone on the computer."
    >
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void signOut()}
            className="min-h-11 rounded-lg bg-danger px-4 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {busy ? "Signing out…" : "Sign out"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(false)}
            className="min-h-11 rounded-lg px-4 text-[13px] text-ink-secondary hover:bg-control disabled:opacity-40"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="min-h-11 rounded-lg border border-hairline/60 px-4 text-[13px] text-danger hover:bg-control"
        >
          Sign out this device
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}
```
In `src/components/SettingsModal.tsx`, add `import { RemoteSignOut } from "./RemoteSignOut";` next to the other component imports, and after line 806 (`<AnalyticsRow />`) insert:
```tsx
                {/* Confirmed remote only. `undefined` renders the neutral
                  * thing, and the desktop has no session to sign out of: the
                  * route lives on the browser door alone. */}
                {desktop === false && <RemoteSignOut />}
```
- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/lib/remote-sign-out.test.ts` then `pnpm vitest run src/components/RemoteSignOut.test.ts` then `pnpm vitest run src/components/SettingsSurface.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
```
git add src/lib/remote-sign-out.ts src/lib/remote-sign-out.test.ts src/components/RemoteSignOut.tsx src/components/RemoteSignOut.test.ts src/components/SettingsModal.tsx
git commit -m "feat(settings): sign this device out from the device, which removes it from the computer"
```

---

## Notes for the plan author

1. **A 7-day pending expiry can still sign a sleeping phone out (spec §3.3 "An uncommitted pending expires after 7 days").** Once the browser stores the Set-Cookie for a successor, the successor is the only value it holds. If the phone sleeps for more than 7 days before sending any other request, it presents an expired successor, gets 401, and is signed out. That is the failure §3.3 exists to fix. A4 makes the window small: the renewal script sends `GET /session` straight after a 200, which commits the successor. The remaining risk is a reply that is received but whose follow-up request fails, followed by more than 7 days asleep. Safer rule, if Sean agrees: an expired successor is no longer re-sent, but presenting it still commits while the session itself is live, because only the holder of `current` was ever given it. This plan implements the spec as written. The change would be one line in `resolveSession`/`renewSession` (drop the `pendingExpired` refusal on the "pending" branch) plus reversing one assertion in A3's "stops accepting an unused successor after a week" test.
2. **"Restoring a backup cannot revive a retired credential" is only partly true.** Including the session id and `createdAt` in the HMAC stops a new session (a re-pair) from deriving a value an older session used. Restoring an old `devices.json` still brings back whatever `current` that file held. It is also deterministic: from that `current` at generation g+1 it re-derives the successor that was issued before, because the device generation is restored too. The A1 secret is a separate file, so restoring `devices.json` alone does not bring the old key back. Restoring the whole data directory does. That is inherent in any restore, so the spec's wording should be narrowed rather than the code changed.
3. **Renewal cadence.** The client timer (`RENEW_INTERVAL_MS`, 24 h) and the server's "due" rule (`SESSION_RENEWAL_DUE_MS`, 24 h after the last commit) are the same length. A tab left open therefore often rotates every other day: at the 24 h tick the last commit is a few seconds under 24 h old, so the renewal is refused as not due. Load and unlock renewals are not affected. Harmless (the idle window is 60 days), but if daily rotation is wanted, the client timer should be 12 h.
4. **An in-flight request carrying the old value after a commit gets 401.** Two cases: parallel fetches sent before the Set-Cookie landed, or an SSE reconnect racing the commit. The spec says the old value is dropped at commit, so this plan drops it. Recovery relies on the §3.6 401 flow (check `GET /session`, which carries the new cookie and answers 200). The web-plumbing plan must not skip that check on API 401s.
5. **Button label.** The spec says "Sign out this phone". The same web UI serves tablets and laptop browsers through the door, so A10 uses "Sign out this device". Change the literal if Sean wants the spec wording.
6. **The remote card in `CompanionSection.tsx:335-345` is unreachable.** `SettingsModal` filters out the whole Phone section off the desktop (`desktopOnly: true`, line 69). That is why A10 puts the button in General. The dead remote branch can stay, because `RemoteSurface.test.ts:163-178` pins it.
7. **Push binding.** §3.3 says remote sign-out also revokes the push binding. The binding lands in Plan 3. It should hook `DeviceRegistry.revoke` (both the control-page revoke and A9's `signOutDevice` go through it), not the A9 route, so that both paths clear it.

**Review Focus candidates:**
- **A browser-paired phone's "last seen" never moved.** `DeviceRecord.lastSeenAt` was stamped only by bearer `authenticate` (`devices.ts:730-743`), never by cookie use. Every phone paired through `/enter`, which is how every app pairs, therefore showed its pairing date as "last seen", so the cap's "sorted by last seen" order would have been wrong. Fixed in A6. Test: `devices.test.ts` "counts a browser-only phone as seen when its session is used".
- **The same app install pairs again while the fleet is full.** Without the install-id carve-out, a reinstall on a full computer would be refused even though it frees its own slot. Covered by A5's cap check (`this.devices.length - (replaced ? 1 : 0)`). Test: `devices.test.ts` "a full fleet" plus A5's "replaces that install's old record…". For a dedicated assertion, fill to `MAX_DEVICES` with one record carrying `INSTALL`, then `redeem(code, …, INSTALL)` should return a token.
- **The secret file is lost or unreadable between renewals.** A lost secret means an outstanding successor cannot be re-sent, but it can still be committed by its hash, and the next renewal derives a fresh one. An unreadable secret means renewal fails closed and the cookie keeps working. Tests: `session-secret.test.ts` "refuses, and leaves the path alone…" and `browser-renew.test.ts` "fails closed, changing nothing, when there is no secret to derive from".
