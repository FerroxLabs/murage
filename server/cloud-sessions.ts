// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isIP } from "node:net";
import { isP256, validBrowserFactor, verifyBrowserAssertion, type BrowserFactor } from "./cloud-home/b1b-webauthn.ts";
import { doorRefusal, logOwnerFactor, type DoorOutcome } from "./cloud-home/door-log.ts";
import type { DoorTicketClaims } from "./cloud-home/b1b-identity.ts";
export type CloudScope = "owner-desktop" | "owner-phone" | "browser" | "service";
export interface CloudDevice { id: string; account: string; scope: CloudScope; publicKey: string; assertionKey: string; revoked: number;
  /** The LIVE browser factor kind, or false. A door-enrolled browser without a factor row reads false; a remembered-owner
   *  row that has expired, been revoked, or whose keyHash no longer matches this device's assertion key also reads false. */
  factor: false | "passkey" | "remembered-owner"; addedAt?: number; lastSeenAt?: number }
/** The remembered-owner factor's hard lifetime from the last proof-bearing door entry (R4), and the "strictly after the
 *  last revoke" margin that keeps a revoke robust to CP/home clock drift (§4.4, §7.2). */
export const REMEMBERED_OWNER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REVOKE_SKEW_MS = 5_000;
export interface PairingInput { account: string; scope: CloudScope; publicKey: string; assertionKey: string; ttl?: number; browserFactor?: BrowserFactor; recovery?: boolean; recoveryId?: string; homeGeneration?: number | null }
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** An active device's `bind`: the same sha256 hex of the SPKI DER that a door ticket's `bind` carries. A record with no readable key carries none. */
function deviceBind(publicKey: unknown): {bind?: string} {
  if (typeof publicKey !== "string" || !publicKey) return {};
  try { return {bind: hash(createPublicKey(publicKey).export({type:"spki",format:"der"}))}; } catch { return {}; }
}
/** sha256 hex of the SPKI DER of an assertion public key (the keyHash a remembered-owner factor row stores); undefined when unreadable. */
function assertionKeyHash(assertionKey: string): string | undefined {
  try { return hash(createPublicKey(assertionKey).export({type:"spki",format:"der"})); } catch { return undefined; }
}
const token = () => randomBytes(32).toString("base64url");
/** An IPv4 address is one source; IPv6 privacy addresses share their /64. */
export function pairingSourceKey(source: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(source)?.[1];
  if (mapped && isIP(mapped) === 4) return `v4:${mapped}`;
  if (isIP(source) === 4) return `v4:${source}`;
  if (isIP(source) !== 6) return "unknown";
  let address = source.split("%")[0]!.toLowerCase();
  const tail = address.slice(address.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    const bytes = tail.split(".").map(Number);
    address = address.slice(0, address.lastIndexOf(":") + 1) + ((bytes[0]! << 8) | bytes[1]!).toString(16) + ":" + ((bytes[2]! << 8) | bytes[3]!).toString(16);
  }
  const [left, right] = address.split("::");
  const before = left ? left.split(":") : [], after = right ? right.split(":") : [];
  const groups = right === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill("0"), ...after];
  return `v6:${groups.slice(0, 4).map(group => Number.parseInt(group, 16).toString(16).padStart(4, "0")).join(":")}`;
}
function publicKey(value: string, browser = false): void {
  if (typeof value !== "string" || value.length > 4096 || !(createPublicKey(value).asymmetricKeyType === "ed25519" || (browser && isP256(value)))) throw new Error("Invalid device key");
}
/** SQLITE_BUSY or SQLITE_LOCKED: another connection holds the write lock past the busy timeout. */
const busy = (error: unknown): boolean => { const e = error as {errcode?: number; message?: unknown}; return (typeof e?.errcode === "number" && [5, 6].includes(e.errcode & 0xff)) || /database is (?:locked|busy)/i.test(String(e?.message ?? "")); };
export function signed(key: string, message: string, signature: string): boolean {
  try { return typeof signature === "string" && signature.length <= 256 && verify(isP256(key) ? "sha256" : null, Buffer.from(message), isP256(key) ? {key, dsaEncoding:"ieee-p1363"} : key, Buffer.from(signature, "base64url")); } catch { return false; }
}
export const LOCKED_VERIFIES_PER_MINUTE = 300;
/** The cheap checks a locked source's pairing attempt passes before anything is looked up or verified. */
function pairingShape(code: string, account: string, signature: string, assertionSignature: string): boolean {
  return /^[A-Za-z0-9_-]{12}$/.test(code) && account.length > 0 && account.length <= 256 && /^[A-Za-z0-9_-]{1,256}$/.test(signature) && assertionSignature.length > 0 && assertionSignature.length <= 8192;
}
export class CloudSessions {
  readonly environmentId: string;
  readonly db: DatabaseSync;
  readonly now: () => number;
  readonly publicOrigin?: string;
  private readonly invalidationListeners = new Set<(deviceId?: string) => void>();
  onInvalidation(listener: (deviceId?: string) => void): () => void {
    this.invalidationListeners.add(listener); return () => { this.invalidationListeners.delete(listener); };
  }
  constructor(db: DatabaseSync, now: () => number = Date.now, publicOrigin?: string) {
    this.db=db; this.now=now;this.publicOrigin=publicOrigin;
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_devices (id TEXT PRIMARY KEY, account TEXT NOT NULL, scope TEXT NOT NULL, publicKey TEXT NOT NULL, assertionKey TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cloud_codes (hash TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_access (hash TEXT PRIMARY KEY, device TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_challenges (id TEXT PRIMARY KEY, device TEXT NOT NULL, purpose TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_lockout (id INTEGER PRIMARY KEY, failures INTEGER NOT NULL, untilAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_code_limits (hash TEXT PRIMARY KEY, failures INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_browser_factors (device TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_recovery (id TEXT PRIMARY KEY, account TEXT NOT NULL, started INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_door_nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_door (hash TEXT PRIMARY KEY, account TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_source_limits (source TEXT PRIMARY KEY, failures INTEGER NOT NULL, untilAt INTEGER NOT NULL);`);
    // The door no longer writes cloud_door (the table stays so an old home opens); drop whatever an earlier version left in it.
    db.exec("DELETE FROM cloud_door");
    const columns = (db.prepare("PRAGMA table_info(cloud_devices)").all() as unknown as {name:string}[]).map(c => c.name);
    if (!columns.includes("addedAt")) db.exec("ALTER TABLE cloud_devices ADD COLUMN addedAt INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("lastSeenAt")) db.exec("ALTER TABLE cloud_devices ADD COLUMN lastSeenAt INTEGER NOT NULL DEFAULT 0");
    // The remembered-owner factor (CLOUD-DOOR-OWNER-FACTOR-DESIGN-r3 §3.2). Existing rows read as kind='passkey', expiresAt
    // NULL: every passkey browser keeps working. In 1.0.5 the watermark table carries only the home-wide bind '*' (R10).
    const factorColumns = (db.prepare("PRAGMA table_info(cloud_browser_factors)").all() as unknown as {name:string}[]).map(c => c.name);
    if (!factorColumns.includes("kind")) db.exec("ALTER TABLE cloud_browser_factors ADD COLUMN kind TEXT NOT NULL DEFAULT 'passkey'");
    if (!factorColumns.includes("issuedAt")) db.exec("ALTER TABLE cloud_browser_factors ADD COLUMN issuedAt INTEGER NOT NULL DEFAULT 0");
    if (!factorColumns.includes("expiresAt")) db.exec("ALTER TABLE cloud_browser_factors ADD COLUMN expiresAt INTEGER");
    if (!factorColumns.includes("keyHash")) db.exec("ALTER TABLE cloud_browser_factors ADD COLUMN keyHash TEXT");
    if (!factorColumns.includes("stepUpAt")) db.exec("ALTER TABLE cloud_browser_factors ADD COLUMN stepUpAt INTEGER");
    if (!factorColumns.includes("revokedAt")) db.exec("ALTER TABLE cloud_browser_factors ADD COLUMN revokedAt INTEGER");
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_owner_watermarks (bind TEXT PRIMARY KEY, revokedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cloud_browser_factors_live ON cloud_browser_factors (device, expiresAt, revokedAt);`);
    // The control plane reads devices/list before every desktop mint: each of its reads walks an index, never the whole table.
    db.exec(`CREATE INDEX IF NOT EXISTS cloud_devices_scope ON cloud_devices (scope);
      CREATE INDEX IF NOT EXISTS cloud_devices_live ON cloud_devices (revoked, account);
      CREATE INDEX IF NOT EXISTS cloud_recovery_state ON cloud_recovery (state, started);`);
    db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('environment',?)").run(randomUUID());
    this.environmentId = (db.prepare("SELECT value FROM cloud_meta WHERE key='environment'").get() as {value:string}).value;
  }
  owner(): string | undefined { return (this.db.prepare("SELECT value FROM cloud_meta WHERE key='account'").get() as {value:string}|undefined)?.value; }
  activeAccount(): boolean { return !this.db.prepare("SELECT 1 FROM cloud_meta WHERE key='suspended'").get(); }
  device(id: string): CloudDevice | undefined {
    if (!this.activeAccount()) return;
    const now = this.now();
    const row = this.db.prepare(`SELECT cloud_devices.*, f.kind AS factorKind, f.keyHash AS factorKeyHash
      FROM cloud_devices LEFT JOIN cloud_browser_factors f ON f.device=cloud_devices.id AND f.revokedAt IS NULL AND (f.expiresAt IS NULL OR f.expiresAt > ?)
      WHERE id=? AND revoked=0`).get(now, id) as unknown as (Omit<CloudDevice,"factor"> & {factorKind: string|null; factorKeyHash: string|null}) | undefined;
    if (!row || row.account !== this.owner()) return;
    const {factorKind, factorKeyHash, ...device} = row;
    // The LIVE factor only: a remembered-owner row whose keyHash no longer matches the device's assertion key reads false.
    let factor: CloudDevice["factor"] = false;
    if (factorKind === "passkey") factor = "passkey";
    else if (factorKind === "remembered-owner" && factorKeyHash && factorKeyHash === assertionKeyHash(device.assertionKey)) factor = "remembered-owner";
    return {...device, factor};
  }
  mint(input: PairingInput): string {
    if (!input.account || input.account.length > 256 || !["owner-desktop","owner-phone","browser","service"].includes(input.scope)) throw new Error("Invalid pairing request");
    // The door is the only way a browser is enrolled.
    if ((input.scope as string) === "browser") throw new Error("Invalid pairing request");
    publicKey(input.publicKey,input.scope === "browser"); publicKey(input.assertionKey,input.scope === "browser");
    if (input.browserFactor && (input.scope !== "browser" || !isP256(input.assertionKey) || !validBrowserFactor(input.browserFactor,this.publicOrigin ?? ""))) throw new Error("Invalid browser factor");
    if (input.scope === "browser" && isP256(input.assertionKey) && !input.browserFactor) throw new Error("Browser factor required");
    if (input.recovery && !this.recoveryReady(input.recoveryId ?? "",input.account)) throw new Error("Recovery hold required");
    if (createPublicKey(input.publicKey).export({type:"spki",format:"der"}).equals(createPublicKey(input.assertionKey).export({type:"spki",format:"der"}))) throw new Error("A separate confirmation key is required");
    if (!this.activeAccount() || (this.owner() && this.owner() !== input.account)) throw new Error("Account refused");
    const ttl = input.ttl ?? 600;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 600) throw new Error("Invalid pairing lifetime");
    this.db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account',?)").run(input.account);
    const code = randomBytes(9).toString("base64url");
    this.db.prepare("INSERT INTO cloud_codes VALUES (?,?,?)").run(hash(code), JSON.stringify(input), this.now()+ttl*1000);
    return code;
  }
  /** Drops every outstanding pairing code minted under a home generation other than `current`: a legacy code (no generation) once a
   *  pin exists, any code once the pin changes, and a pinned code if the pin is gone (Astra STEPUP-EMAIL-8 #1). */
  dropSupersededCodes(current: number | undefined): void {
    this.db.prepare("DELETE FROM cloud_codes WHERE json_extract(payload,'$.homeGeneration') IS NOT ?").run(current ?? null);
  }
  /** `pin` reads the home's CURRENT independent generation pin (undefined: an unbound home, no pin). A code is redeemed only under the
   *  generation it was minted at; an unreadable pin refuses without deleting anything (no permanent lockout). */
  redeem(code: string, account: string, signature: string, assertionSignature: string, source = "unknown", pin: () => number | undefined = () => undefined): { accessToken: string; deviceId: string; expiresIn: number; scope: CloudScope } {
    let current: number | undefined;
    try { current = pin(); } catch { throw new Error("Pairing refused"); }
    if (current !== undefined && (!Number.isSafeInteger(current) || current < 1)) throw new Error("Pairing refused");
    this.dropSupersededCodes(current);
    const now = this.now(), sourceKey = pairingSourceKey(source), codeHash = hash(code);
    this.db.prepare("DELETE FROM cloud_source_limits WHERE untilAt<=?").run(now);
    this.db.prepare("DELETE FROM cloud_code_limits WHERE hash NOT IN (SELECT hash FROM cloud_codes WHERE expires>?)").run(now);
    const lock = this.db.prepare("SELECT failures,untilAt FROM cloud_source_limits WHERE source=?").get(sourceKey) as {failures:number;untilAt:number}|undefined;
    // A locked source is not refused outright: a code that verifies still pairs, so a neighbour behind the same NAT or /64 can never
    // lock the owner out. Only failures count; a locked source's attempt is shape-checked first and spends the home-wide cap on
    // locked verifications before any signature is checked, and every refusal while locked is the same "locked" answer.
    const sourceLocked = Boolean(lock && lock.failures >= 5);
    const sourceFailure = () => { this.db.prepare("INSERT INTO cloud_source_limits VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET failures=failures+1").run(sourceKey,1,now+600_000); };
    if (sourceLocked && (!pairingShape(code, account, signature, assertionSignature) || !this.lockedVerifyAllowed("pair"))) { sourceFailure(); throw new Error("Pairing locked. Try again later."); }
    const codeLock = this.db.prepare("SELECT failures FROM cloud_code_limits WHERE hash=?").get(codeHash) as {failures:number}|undefined;
    if (codeLock && codeLock.failures >= 5) throw new Error("Pairing locked. Try again later.");
    const row = this.db.prepare("SELECT payload,expires FROM cloud_codes WHERE hash=?").get(codeHash) as {payload:string;expires:number}|undefined;
    const input = row ? JSON.parse(row.payload) as PairingInput : undefined;
    if (!input || input.scope === "browser" || row!.expires <= this.now() || (input.homeGeneration ?? undefined) !== current || account !== input.account || account !== this.owner() || !this.activeAccount() || !signed(input.publicKey, `murage-pair:${this.environmentId}:${code}:${account}`, signature) || !this.pairFactor(input, `murage-pair:${this.environmentId}:${code}:${account}`, assertionSignature)) {
      sourceFailure();
      if (row && row.expires > now) this.db.prepare("INSERT INTO cloud_code_limits VALUES (?,1) ON CONFLICT(hash) DO UPDATE SET failures=failures+1").run(codeHash);
      throw new Error(sourceLocked ? "Pairing locked. Try again later." : "Pairing refused");
    }
    if (input.recovery) {
      if (!this.recoveryReady(input.recoveryId ?? "",account)) throw new Error("Recovery cancelled");
      this.revokeAllDevices();
      this.db.prepare("UPDATE cloud_recovery SET state='completed' WHERE id=?").run(input.recoveryId!);
    }
    this.db.prepare("DELETE FROM cloud_codes WHERE hash=?").run(codeHash);
    this.db.prepare("DELETE FROM cloud_code_limits WHERE hash=?").run(codeHash);
    const id = randomUUID();
    this.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)").run(id,input.account,input.scope,input.publicKey,input.assertionKey,now,now);
    if (input.browserFactor) this.db.prepare("INSERT INTO cloud_browser_factors (device,payload) VALUES (?,?)").run(id,JSON.stringify(input.browserFactor));
    return this.issue(id);
  }
  private pairFactor(input: PairingInput, message: string, signature: string): boolean {
    if (!input.browserFactor) return signed(input.assertionKey,message,signature);
    try { const counter=verifyBrowserAssertion(input.assertionKey,input.browserFactor,message,JSON.parse(signature)); if(counter === undefined) return false; input.browserFactor.counter=counter; return true; } catch { return false; }
  }
  startRecovery(id: string, account: string): number {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(id) || account !== this.owner()) throw new Error("Recovery refused");
    if (this.db.prepare("SELECT 1 FROM cloud_recovery WHERE state IN ('holding','cleaning','ready')").get()) throw new Error("Recovery already pending");
    this.db.prepare("INSERT INTO cloud_recovery VALUES (?,?,?,'holding')").run(id,account,this.now());
    return this.now()+72*60*60*1000;
  }
  /** Spends a completed pair hold: one added device per hold id, ever. False when it was already spent. */
  consumePairHold(holdId: string, account: string): boolean {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(holdId) || account !== this.owner()) return false;
    return this.db.prepare("INSERT OR IGNORE INTO cloud_recovery VALUES (?,?,?,'device_added')").run(`pair-${holdId}`,account,this.now()).changes === 1;
  }
  cancelRecovery(id: string): void {
    this.db.prepare("UPDATE cloud_recovery SET state='cancelled' WHERE id=? AND state IN ('holding','cleaning','ready')").run(id);
    this.db.prepare("DELETE FROM cloud_codes WHERE json_extract(payload,'$.recoveryId')=?").run(id);
  }
  recoveryReady(id: string, account: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM cloud_recovery WHERE id=? AND account=? AND state='ready' AND started<=?").get(id,account,this.now()-72*60*60*1000));
  }
  async prepareRecovery(id: string, account: string, cleanup: () => Promise<void>): Promise<void> {
    const row=this.db.prepare("SELECT state,started FROM cloud_recovery WHERE id=? AND account=?").get(id,account) as {state:string;started:number}|undefined;
    if (!row || !['holding','ready'].includes(row.state) || row.started > this.now()-72*60*60*1000) throw new Error("Recovery hold required");
    if (row.state === "ready") return;
    this.db.prepare("UPDATE cloud_recovery SET state='cleaning' WHERE id=?").run(id);
    try {
      await cleanup();
      const changed=this.db.prepare("UPDATE cloud_recovery SET state='ready' WHERE id=? AND state='cleaning'").run(id);
      if (changed.changes !== 1) throw new Error("Recovery cancelled");
    } catch(error) { this.db.prepare("UPDATE cloud_recovery SET state='holding' WHERE id=? AND state='cleaning'").run(id); throw error; }
  }
  revokeAllDevices(): void {
    this.tx(() => {
      this.db.prepare("UPDATE cloud_devices SET revoked=1").run();
      this.db.exec("DELETE FROM cloud_access; DELETE FROM cloud_challenges; DELETE FROM cloud_codes;");
      this.watermarkAll(this.now());
    });
    for (const listener of this.invalidationListeners) listener();
  }
  resumeAccount(): void { this.db.prepare("DELETE FROM cloud_meta WHERE key='suspended'").run(); }
  issue(id: string) {
    const d = this.device(id); if (!d) throw new Error("Session refused");
    const accessToken = token();
    this.db.prepare("DELETE FROM cloud_access WHERE expires<=?").run(this.now());
    this.db.prepare("INSERT INTO cloud_access VALUES (?,?,?)").run(hash(accessToken),id,this.now()+900_000);
    this.db.prepare("UPDATE cloud_devices SET lastSeenAt=? WHERE id=?").run(this.now(),id);
    return {accessToken,deviceId:id,expiresIn:900,scope:d.scope};
  }
  resolve(accessToken: string): CloudDevice | undefined {
    if (!accessToken || accessToken.length > 128) return;
    return this.resolveHash(hash(accessToken));
  }
  resolveHash(accessHash: string): CloudDevice | undefined {
    if (!/^[a-f0-9]{64}$/.test(accessHash)) return;
    const row = this.db.prepare("SELECT device FROM cloud_access WHERE hash=? AND expires>?").get(accessHash,this.now()) as {device:string}|undefined;
    return row && this.device(row.device);
  }
  /** Why device(id) refuses: "suspended" (the account is paused; the device itself stays), "revoked" (this device was removed),
   *  or undefined (unknown or another account's). Only "revoked" tells a computer to forget its sign-in. */
  refusalReason(id: string): "suspended" | "revoked" | undefined {
    if (!this.activeAccount()) return "suspended";
    const row = this.db.prepare("SELECT revoked, account FROM cloud_devices WHERE id=?").get(id) as {revoked:number; account:string}|undefined;
    return row && row.revoked && row.account === this.owner() ? "revoked" : undefined;
  }
  private refused(message: string, id: string): Error { const reason = this.refusalReason(id); return Object.assign(new Error(message), reason ? {reason} : {}); }
  challenge(id: string, purpose = "refresh"): string {
    if (!this.device(id)) throw this.refused("Session refused", id);
    const value = token();
    this.db.prepare("DELETE FROM cloud_challenges WHERE expires<=?").run(this.now());
    this.db.prepare("INSERT INTO cloud_challenges VALUES (?,?,?,?)").run(value,id,purpose,this.now()+300_000);
    return value;
  }
  consumeAssertion(id: string, challenge: string, purpose: string, at: number, signature: string, factor = true): boolean {
    const d = this.device(id);
    if (!d || !Number.isFinite(at) || at > this.now() || at < this.now()-300_000) return false;
    const row = this.db.prepare("SELECT 1 FROM cloud_challenges WHERE id=? AND device=? AND purpose=? AND expires>?").get(challenge,id,purpose,this.now());
    if (!row) return false;
    const message=`murage:${this.environmentId}:${id}:${purpose}:${challenge}:${at}`;
    const browser=this.db.prepare("SELECT payload, kind FROM cloud_browser_factors WHERE device=? AND revokedAt IS NULL").get(id) as {payload:string; kind:string}|undefined;
    // A browser the door enrolled has no factor row, and a remembered-owner row answers NO factor assertion in 1.0.5 (§5.2,
    // H1): only a passkey factor can answer one, so either absence refuses before any verify.
    if (factor && d.scope === "browser" && (!browser || browser.kind !== "passkey")) return false;
    if (factor && browser && browser.kind === "passkey") {
      try {
        const saved=JSON.parse(browser.payload) as BrowserFactor;
        const counter=verifyBrowserAssertion(d.assertionKey,saved,message,JSON.parse(signature));
        if(counter === undefined) return false;
        this.db.prepare("UPDATE cloud_browser_factors SET payload=? WHERE device=?").run(JSON.stringify({...saved,counter}),id);
      } catch { return false; }
    } else if (!signed(factor ? d.assertionKey : d.publicKey,message,signature)) return false;
    this.db.prepare("DELETE FROM cloud_challenges WHERE id=?").run(challenge); return true;
  }
  refresh(id: string, challenge: string, at: number, signature: string) {
    if (!this.consumeAssertion(id,challenge,"refresh",at,signature,false)) throw this.refused("Refresh refused", id);
    return this.issue(id);
  }
  /** The home-wide revoke watermark: every revoke writes bind '*' (R10), so issuance and renewal are held until an emailed
   *  stepUpAt strictly after it, even for a key the home never saw. device() never reads this; live factors run to TTL. */
  private watermarkAll(now: number): void {
    this.db.prepare("INSERT INTO cloud_owner_watermarks VALUES ('*',?) ON CONFLICT(bind) DO UPDATE SET revokedAt=max(revokedAt,excluded.revokedAt)").run(now);
  }
  /** max(revokedAt WHERE bind=?bind, revokedAt WHERE bind='*', 0). In 1.0.5 only '*' rows exist, so this is the home-wide mark. */
  watermarkFor(bind: string): number {
    const row = this.db.prepare("SELECT MAX(revokedAt) AS m FROM cloud_owner_watermarks WHERE bind IN (?, '*')").get(bind) as {m:number|null}|undefined;
    return row?.m ?? 0;
  }
  /** One BEGIN IMMEDIATE: the revoke write AND the watermark upsert commit together, so no crash leaves a device revoked
   *  with a stale mark (Medium-2). A device revoke (browser only) writes '*'; listeners fire after COMMIT, as today. */
  revoke(id: string): void {
    this.tx(() => {
      const row = this.db.prepare("SELECT scope FROM cloud_devices WHERE id=?").get(id) as {scope:CloudScope}|undefined;
      this.db.prepare("UPDATE cloud_devices SET revoked=1 WHERE id=?").run(id);
      if (row?.scope === "browser") this.watermarkAll(this.now());
    });
    for (const listener of this.invalidationListeners) listener(id);
  }
  /** "Make this browser chat-only": revoke the remembered-owner factor row (the device stays for chat), and write '*'. */
  revokeOwnerFactor(id: string): void {
    this.tx(() => {
      this.db.prepare("UPDATE cloud_browser_factors SET revokedAt=? WHERE device=? AND kind='remembered-owner' AND revokedAt IS NULL").run(this.now(), id);
      this.watermarkAll(this.now());
    });
    for (const listener of this.invalidationListeners) listener(id);
  }
  revokeAccount(): void {
    this.tx(() => {
      this.db.prepare("INSERT OR REPLACE INTO cloud_meta VALUES ('suspended','1')").run();
      this.db.exec("DELETE FROM cloud_codes; DELETE FROM cloud_access; DELETE FROM cloud_challenges;");
      this.watermarkAll(this.now());
    });
    for (const listener of this.invalidationListeners) listener();
  }

  // ── The door (server/cloud-home DESIGN.md "Cloud home door") ─────────────────────────────────────────────────────────────
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  }
  private doorFailures: number[] = [];
  private lockedVerifies = { door: [] as number[], pair: [] as number[] };
  /** The home-wide cap on signature checks for LOCKED sources, per route: 300 a minute. A locked source may still present a credential
   *  that verifies, but a flood from locked sources can never turn that into unbounded verification work. */
  lockedVerifyAllowed(kind: "door" | "pair"): boolean {
    const now = this.now(), live = this.lockedVerifies[kind].filter(at => at > now - 60_000);
    this.lockedVerifies[kind] = live;
    if (live.length >= LOCKED_VERIFIES_PER_MINUTE) return false;
    live.push(now); return true;
  }
  private doorStateHits = new Map<string, number[]>();
  /** The home-wide enrollment budget: at most 30 FAILED ticket or pairing attempts a minute, whoever sends them. Only failures
   *  count, so no unauthenticated read can spend it; a ticket that verifies and a holder of a live door cookie never ask it. */
  doorFailureBudgetOpen(): boolean {
    const now = this.now(); this.doorFailures = this.doorFailures.filter(at => at > now - 60_000);
    return this.doorFailures.length < 30;
  }
  /** door-state keeps its own per-source limit (60 a minute) and never touches the enrollment budget or the lockout counter. */
  doorStateAllowed(source: string): boolean { return this.perSourceAllowed(this.doorStateHits, source, 60); }
  private doorReportHits = new Map<string, number[]>();
  /** The door page's problem reports (logged only) keep their own per-source limit, 10 a minute, apart from door-state's. */
  doorReportAllowed(source: string): boolean { return this.perSourceAllowed(this.doorReportHits, source, 10); }
  private perSourceAllowed(map: Map<string, number[]>, source: string, limit: number): boolean { return this.perKeyAllowed(map, pairingSourceKey(source), limit); }
  private perKeyAllowed(map: Map<string, number[]>, key: string, limit: number): boolean {
    const now = this.now();
    for (const [k, hits] of map) { const live = hits.filter(at => at > now - 60_000); if (live.length) map.set(k, live); else map.delete(k); }
    const hits = map.get(key) ?? [];
    if (hits.length >= limit) return false;
    if (!map.has(key) && map.size >= 10_000) return false;
    hits.push(now); map.set(key, hits); return true;
  }
  /** Five failures lock one source for ten minutes; the door keeps its own keys apart from the pairing code's. */
  doorSourceLocked(source: string): boolean {
    const now = this.now(), key = `door:${pairingSourceKey(source)}`;
    this.db.prepare("DELETE FROM cloud_source_limits WHERE untilAt<=?").run(now);
    const lock = this.db.prepare("SELECT failures FROM cloud_source_limits WHERE source=?").get(key) as {failures:number}|undefined;
    return Boolean(lock && lock.failures >= 5);
  }
  /** `shared` false: a locked source's failure counts toward its own lock only, never the home-wide failure budget. */
  doorSourceFailure(source: string, shared = true): void {
    if (shared) this.doorFailures.push(this.now());
    this.db.prepare("INSERT INTO cloud_source_limits VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET failures=failures+1").run(`door:${pairingSourceKey(source)}`,1,this.now()+600_000);
  }
  /** The one browser or computer enrollment: a verified ticket plus the key it was minted for, in one transaction. A refusal
   *  throws a DoorRefusal and changes nothing, so a refused ticket keeps its nonce for the client that holds the bound key. */
  enterDoor(claims: Pick<DoorTicketClaims,"account"|"nonce"|"expiresAt"|"bind"|"kind"|"pairHold"|"stepUpAt"|"proof">, ticket: string, device: {deviceId?: string|null; publicKey: string; assertionKey: string; proof: string; assertionProof?: string}): {accessToken: string; deviceId: string; expiresIn: number; scope: CloudScope; outcome: DoorOutcome; reason: "first-device"|"known-device"|"device-added"; owner: boolean; ownerUntil?: number} {
    return this.tx(() => {
      const now = this.now(), refused = "Door refused";
      if (!this.activeAccount()) throw doorRefusal("account_suspended", refused);
      const owner = this.owner();
      if (owner && owner !== claims.account) throw doorRefusal("account_mismatch", refused);
      const browser = claims.kind === "browser";
      let publicDer: Buffer;
      try {
        publicKey(device.publicKey,true); publicKey(device.assertionKey,true);
        if (browser && (!isP256(device.publicKey) || !isP256(device.assertionKey))) throw new Error("Invalid device key");
        publicDer = createPublicKey(device.publicKey).export({type:"spki",format:"der"});
        if (publicDer.equals(createPublicKey(device.assertionKey).export({type:"spki",format:"der"}))) throw new Error("Invalid device key");
      } catch { throw doorRefusal("device_key_invalid", refused); }
      if (hash(publicDer) !== claims.bind) throw doorRefusal("device_bind_refused", refused);
      if (!signed(device.publicKey,`murage-door-v2:${ticket}`,device.proof)) throw doorRefusal("device_proof_refused", refused);
      // §4.2: the assertion key is proved once, at enter. A browser body without it is body_malformed; a desktop body may omit
      // it in 1.0.5 (R7) but it is verified when present. Any present proof must be signed by the posted assertion key.
      if (browser && !device.assertionProof) throw doorRefusal("body_malformed", refused);
      if (device.assertionProof && !signed(device.assertionKey,`murage-door-v2-assertion:${ticket}`,device.assertionProof)) throw doorRefusal("assertion_proof_refused", refused);
      const scope: CloudScope = browser ? "browser" : "owner-desktop";
      const known = this.db.prepare("SELECT id,assertionKey FROM cloud_devices WHERE account=? AND publicKey=? AND scope=? AND revoked=0").get(claims.account,device.publicKey,scope) as {id:string;assertionKey:string}|undefined;
      // A known device must post the assertion key already on file (§4.2).
      if (known && known.assertionKey !== device.assertionKey) throw doorRefusal("device_key_invalid", refused);
      let id: string, outcome: DoorOutcome, reason: "first-device"|"known-device"|"device-added";
      if (known) { id = known.id; outcome = "signed_in_known"; reason = "known-device"; }
      else {
        if (browser) {
          if ((this.db.prepare("SELECT COUNT(*) AS n FROM cloud_devices WHERE scope='browser' AND revoked=0").get() as {n:number}).n >= 10) throw doorRefusal("device_limit", refused);
        } else if (this.db.prepare("SELECT 1 FROM cloud_devices WHERE scope IN ('owner-desktop','owner-phone')").get()) {
          // A home that ever had a full-scope device adds another computer only by spending a completed pair hold; the others stay active.
          if (!claims.pairHold) throw doorRefusal("desktop_hold_required", refused);
          if (!this.consumePairHold(claims.pairHold,claims.account)) throw doorRefusal("pair_hold_refused", refused);
        }
        const first = !this.db.prepare("SELECT 1 FROM cloud_devices LIMIT 1").get();
        this.db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account',?)").run(claims.account);
        id = randomUUID();
        this.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)").run(id,claims.account,scope,device.publicKey,device.assertionKey,now,now);
        outcome = first ? "signed_in_first" : "signed_in_added"; reason = first ? "first-device" : "device-added";
      }
      this.db.prepare("DELETE FROM cloud_door_nonces WHERE expires<=?").run(now);
      try { this.db.prepare("INSERT INTO cloud_door_nonces VALUES (?,?)").run(claims.nonce,claims.expiresAt+60_000); } catch { throw doorRefusal("ticket_reused", refused); }
      // §4.4: a browser ticket with CP proof, past the watermark test, issues or renews the remembered-owner factor. Compare
      // stepUpAt, never issuedAt; after any revoke only an emailed code issues; a passkey row is never replaced; no path clears revokedAt.
      if (browser && (claims.proof === "email" || claims.proof === "factor")) {
        const mark = this.watermarkFor(claims.bind);
        const fresh = claims.stepUpAt > mark + REVOKE_SKEW_MS;
        const allowedKind = mark === 0 || claims.proof === "email";
        const existingKind = (this.db.prepare("SELECT kind FROM cloud_browser_factors WHERE device=?").get(id) as {kind:string}|undefined)?.kind;
        if (!fresh) logOwnerFactor("owner_factor_withheld", "stale_proof");
        else if (!allowedKind) logOwnerFactor("owner_factor_withheld", "proof_kind_after_revoke");
        else if (existingKind !== "passkey") {
          const keyHash = assertionKeyHash(device.assertionKey);
          const payload = JSON.stringify({kind:"remembered-owner", keyHash, proof:claims.proof, stepUpAt:claims.stepUpAt, ticketNonce:claims.nonce});
          this.db.prepare("INSERT OR REPLACE INTO cloud_browser_factors (device,payload,kind,issuedAt,expiresAt,keyHash,stepUpAt,revokedAt) VALUES (?,?,?,?,?,?,?,NULL)")
            .run(id, payload, "remembered-owner", now, now + REMEMBERED_OWNER_TTL_MS, keyHash ?? null, claims.stepUpAt);
          logOwnerFactor(existingKind === "remembered-owner" ? "owner_factor_renewed" : "owner_factor_issued");
        }
      }
      const factorRow = this.db.prepare("SELECT kind,expiresAt FROM cloud_browser_factors WHERE device=? AND revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > ?)").get(id, now) as {kind:string; expiresAt:number|null}|undefined;
      const ownerBrowser = Boolean(factorRow && (factorRow.kind === "passkey" || factorRow.kind === "remembered-owner"));
      const ownerUntil = typeof factorRow?.expiresAt === "number" ? factorRow.expiresAt : undefined;
      return {...this.issue(id), outcome, reason, owner: ownerBrowser, ...(ownerUntil !== undefined ? {ownerUntil} : {})};
    });
  }
  /** The unrevoked owner devices, for the home's device list. `keyHash` is the digest a ticket's `bind` carries; `factor`
   *  and `factorExpiresAt` drive the "Chat only" / "Owner until <date>" rows and the "Make chat-only" action (§7.4). */
  listDevices(): {id: string; scope: CloudScope; addedAt: number; lastSeenAt: number; keyHash: string; bind?: string; factor: "passkey"|"remembered-owner"|null; factorExpiresAt?: number}[] {
    const now = this.now();
    const rows = this.db.prepare(`SELECT d.id,d.scope,d.publicKey,d.assertionKey,d.addedAt,d.lastSeenAt, f.kind AS factorKind, f.keyHash AS factorKeyHash, f.expiresAt AS factorExpiresAt
      FROM cloud_devices d LEFT JOIN cloud_browser_factors f ON f.device=d.id AND f.revokedAt IS NULL AND (f.expiresAt IS NULL OR f.expiresAt > ?)
      WHERE d.revoked=0 AND d.account=? AND d.scope!='service' ORDER BY d.addedAt,d.id`).all(now, this.owner() ?? "") as unknown as {id:string;scope:CloudScope;publicKey:string;assertionKey:string;addedAt:number;lastSeenAt:number;factorKind:string|null;factorKeyHash:string|null;factorExpiresAt:number|null}[];
    return rows.map(r => {
      let factor: "passkey"|"remembered-owner"|null = null;
      if (r.factorKind === "passkey") factor = "passkey";
      else if (r.factorKind === "remembered-owner" && r.factorKeyHash && r.factorKeyHash === assertionKeyHash(r.assertionKey)) factor = "remembered-owner";
      return {id:r.id,scope:r.scope,addedAt:r.addedAt,lastSeenAt:r.lastSeenAt,keyHash:hash(createPublicKey(r.publicKey).export({type:"spki",format:"der"})),...deviceBind(r.publicKey),factor,
        ...(factor === "remembered-owner" && typeof r.factorExpiresAt === "number" ? {factorExpiresAt:r.factorExpiresAt} : {})};
    });
  }
  /** True once any full-scope device (desktop or phone) has ever enrolled on this home, revoked ones included: the control plane
   *  reads it from devices/list to answer a desktop Connect that needs a pair hold before it mints. */
  fullScopeEver(): boolean { return Boolean(this.db.prepare("SELECT 1 FROM cloud_devices WHERE scope IN ('owner-desktop','owner-phone') LIMIT 1").get()); }
  /** The pair holds this home has spent (consumePairHold), most recent first, at most 50: the control plane reconciles them so a
   *  spent hold is never offered again. Read from the same rows consumePairHold writes, so it survives restarts. */
  consumedHoldIds(): string[] {
    return (this.db.prepare("SELECT substr(id,6) AS hold FROM cloud_recovery WHERE id LIKE 'pair-%' AND state='device_added' ORDER BY started DESC, rowid DESC LIMIT 50").all() as {hold:string}[]).map(r => r.hold);
  }
  /** Whether this home has ever had a device with this id (revoked or not). */
  knownDevice(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM cloud_devices WHERE id=?").get(id)); }
  private deviceReadHits = new Map<string, number[]>();
  /** A paired device may read its device list 30 times a minute. */
  devicesReadAllowed(deviceId: string): boolean { return this.perKeyAllowed(this.deviceReadHits, deviceId, 30); }
  verifyBootstrap(body: Buffer, signature: string, secret: string): Record<string, unknown> {
    if (!secret || !/^[a-f0-9]{64}$/.test(signature)) throw new Error("Pairing authorization refused");
    const expected = createHmac("sha256",secret).update(body).digest();
    if (!timingSafeEqual(expected,Buffer.from(signature,"hex"))) throw new Error("Pairing authorization refused");
    const input = JSON.parse(body.toString("utf8")) as Record<string,unknown>;
    if (typeof input.timestamp !== "number" || Math.abs(this.now()/1000-input.timestamp)>300 || typeof input.nonce !== "string" || input.nonce.length < 16 || input.nonce.length > 128) throw new Error("Pairing authorization refused");
    try { this.db.prepare("DELETE FROM cloud_nonces WHERE expires<=?").run(this.now()); } catch (error) { if (busy(error)) throw Object.assign(new Error("Home busy"), {status: 503}); throw error; }
    try { this.db.prepare("INSERT INTO cloud_nonces VALUES (?,?)").run(input.nonce,this.now()+600_000); }
    catch (error) {
      // A replayed nonce is a refusal; a database another writer holds is a busy answer the control plane retries, never a refusal.
      if (busy(error)) throw Object.assign(new Error("Home busy"), {status: 503});
      throw new Error("Pairing authorization refused");
    }
    return input;
  }
}
