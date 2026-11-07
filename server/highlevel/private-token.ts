// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner's HighLevel Private Integration token as a connection source (HL-S2, GAP-HIGHLEVEL-109 section 4, the
// first slice; the broker of section 4.3 is for the later Marketplace OAuth slice).
//
//   - The token lives in the existing workspace secret store: credentials.bin on the desktop (WORKSPACE_CREDENTIALS
//     row highlevelPrivateToken), the supervisor store on a Cloud home. This module only reads it through `token()`.
//   - A connection is live only after the owner checks a location with the token (one GET /locations/:id on the fixed
//     provider host) and then confirms that exact check from the desktop. The check is held for ten minutes.
//   - The connection record holds ids, the location name and a fingerprint of the token, never the token. A different
//     token (or none) leaves the record waiting for a new check and confirm: nothing runs on it.
//   - The token is never logged, never returned by a route and never written anywhere but the secret store.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { HighLevelError, redactSecrets, type HighLevelConnectionView, type HighLevelLease, type HighLevelLeaseRequest, type HighLevelLeaseSource } from "./client.ts";
import { endpointFor, HIGHLEVEL_API_ORIGIN } from "./provider-contract.ts";

export const HIGHLEVEL_CHECK_HOLD_MS = 10 * 60_000;
const CHECK_DEADLINE_MS = 15_000;
const CHECK_RESPONSE_MAX = 256 * 1024;
const LEASE_DISCARD_MS = 60_000;
const MAX_HELD_CHECKS = 20;

export const highlevelLocationIdSchema = z.string().regex(/^[A-Za-z0-9]{4,64}$/u);

const connectionRecordSchema = z.object({
  connectionId: z.string().regex(/^hl_[A-Za-z0-9]{4,64}$/u),
  locationId: highlevelLocationIdSchema,
  companyId: z.string().max(180),
  locationName: z.string().max(200).optional(),
  epoch: z.number().int().positive(),
  tokenFingerprint: z.string().regex(/^[0-9a-f]{32}$/u),
  confirmedAt: z.string().max(40),
  // A disconnect keeps the record as a tombstone so the next confirm's epoch is higher than every earlier one: a lease or
  // review from before the disconnect can never match the new connection (Astra r1 H3).
  disconnected: z.literal(true).optional(),
}).strict();
export type HighLevelConnectionRecord = z.infer<typeof connectionRecordSchema>;

/** The redacted view a route may return. */
export interface HighLevelOwnerConnection {
  connectionId: string;
  locationId: string;
  locationName?: string;
  state: HighLevelConnectionView["state"];
  confirmedAt: string;
}

export interface HighLevelHeldCheck {
  opId: string;
  locationId: string;
  locationName?: string;
  expiresAt: number;
}

export function highlevelTokenFingerprint(token: string): string {
  return createHash("sha256").update(`murage-highlevel-pit\0${token}`).digest("hex").slice(0, 32);
}

export const highlevelConnectionIdFor = (locationId: string): string => `hl_${locationId}`;

export function defaultHighLevelConnectionFile(dataDir: string): string {
  return join(dataDir, "highlevel", "connection.json");
}

export interface PrivateTokenSourceOptions {
  /** The saved Private Integration token, read fresh on every use; undefined or "" when none is saved. */
  token: () => string | undefined;
  file: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class PrivateTokenLeaseSource implements HighLevelLeaseSource {
  private readonly checks = new Map<string, HighLevelHeldCheck & { companyId: string; tokenFingerprint: string }>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private readonly options: PrivateTokenSourceOptions;

  // a plain field, not a parameter property: the server runs under Node's type stripping, which refuses those
  constructor(options: PrivateTokenSourceOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private currentToken(): string | undefined {
    const token = this.options.token()?.trim();
    return token ? token : undefined;
  }

  /** The stored record, or undefined when there is none or it cannot be read (read as absent: fail closed). */
  record(): HighLevelConnectionRecord | undefined {
    const stored = this.stored();
    return stored?.disconnected ? undefined : stored;
  }

  /** The stored record including a disconnect tombstone. */
  private stored(): HighLevelConnectionRecord | undefined {
    let raw: string;
    try { raw = readFileSync(this.options.file, "utf8"); } catch { return undefined; }
    try {
      const parsed = connectionRecordSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch { return undefined; }
  }

  private stateOf(record: HighLevelConnectionRecord): HighLevelConnectionView["state"] {
    const token = this.currentToken();
    if (!token || highlevelTokenFingerprint(token) !== record.tokenFingerprint) return "pending_browser_confirmation";
    return "connected";
  }

  async connection(connectionId: string): Promise<HighLevelConnectionView | undefined> {
    const record = this.record();
    if (!record || record.connectionId !== connectionId) return undefined;
    return {
      connectionId: record.connectionId, locationId: record.locationId, companyId: record.companyId,
      ...(record.locationName ? { locationName: record.locationName } : {}),
      epoch: record.epoch, state: this.stateOf(record),
    };
  }

  async lease(request: HighLevelLeaseRequest): Promise<HighLevelLease> {
    const record = this.record();
    if (!record || record.connectionId !== request.connectionId || record.epoch !== request.connectionEpoch) {
      throw new HighLevelError("This HighLevel location is not connected right now.", { status: 409 });
    }
    const token = this.currentToken();
    if (!token || highlevelTokenFingerprint(token) !== record.tokenFingerprint) {
      throw new HighLevelError("The HighLevel token changed. The owner checks and confirms the location again before anything runs.", { status: 409, signedOut: true });
    }
    // A Private Integration token does not rotate here: a rejected token needs the owner, not a retry.
    if (request.reason === "expired") throw new HighLevelError("HighLevel did not accept the saved token. The owner can save a new one and confirm the location again.", { status: 401, signedOut: true });
    return {
      leaseId: randomUUID(), requestId: request.requestId, connectionId: record.connectionId, connectionEpoch: record.epoch,
      locationId: record.locationId, companyId: record.companyId, credentialVersion: record.epoch, accessToken: token,
      discardAt: this.now() + LEASE_DISCARD_MS,
    };
  }

  /** The owner's view: the connection without the token or its fingerprint. */
  ownerView(): HighLevelOwnerConnection | null {
    const record = this.record();
    if (!record) return null;
    return {
      connectionId: record.connectionId, locationId: record.locationId,
      ...(record.locationName ? { locationName: record.locationName } : {}),
      state: this.stateOf(record), confirmedAt: record.confirmedAt,
    };
  }

  tokenSaved(): boolean { return this.currentToken() !== undefined; }

  /** Step 1: read the location with the saved token. Nothing is stored until the owner confirms. */
  async check(locationIdInput: unknown): Promise<HighLevelHeldCheck> {
    const parsed = highlevelLocationIdSchema.safeParse(locationIdInput);
    if (!parsed.success) throw new HighLevelError("Enter the HighLevel location id (letters and numbers, from Settings > Business Profile).", { status: 400 });
    const locationId = parsed.data;
    const token = this.currentToken();
    if (!token) throw new HighLevelError("Save a HighLevel Private Integration token first.", { status: 409 });
    const path = `/locations/${encodeURIComponent(locationId)}`;
    const endpoint = endpointFor("locations.get", "GET", path);
    if (!endpoint) throw new HighLevelError("That location id cannot be checked.", { status: 400 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_DEADLINE_MS);
    let body: unknown;
    try {
      const response = await this.fetchImpl(`${HIGHLEVEL_API_ORIGIN}${path}`, {
        method: "GET", redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, version: endpoint.version, accept: "application/json" },
      });
      const text = await readCapped(response, CHECK_RESPONSE_MAX);
      if (response.status === 401 || response.status === 403) throw new HighLevelError("HighLevel did not accept this token for that location. Check the token's location and its View Locations permission.", { status: 409 });
      if (response.status === 404 || response.status === 400 || response.status === 422) throw new HighLevelError("HighLevel has no location with that id for this token.", { status: 409 });
      if (!response.ok) throw new HighLevelError(`HighLevel answered ${response.status}. Try again in a minute.`, { status: 502 });
      body = JSON.parse(text);
    } catch (error) {
      if (error instanceof HighLevelError) throw error;
      throw new HighLevelError(redactSecrets(`Could not reach HighLevel to check the location: ${error instanceof Error ? error.message : "network error"}`, [token]).slice(0, 300), { status: 502 });
    } finally {
      clearTimeout(timer);
    }
    const location = object(body) && object(body.location) ? body.location : object(body) ? body : {};
    const returnedId = typeof location.id === "string" ? location.id : typeof location._id === "string" ? location._id : undefined;
    if (returnedId !== locationId) throw new HighLevelError("HighLevel answered for a different location. Nothing was saved.", { status: 409 });
    const companyId = typeof location.companyId === "string" ? location.companyId.slice(0, 180) : "";
    const locationName = typeof location.name === "string" ? location.name.slice(0, 200) : undefined;
    this.pruneChecks();
    const opId = randomUUID();
    const held = { opId, locationId, ...(locationName ? { locationName } : {}), expiresAt: this.now() + HIGHLEVEL_CHECK_HOLD_MS, companyId, tokenFingerprint: highlevelTokenFingerprint(token) };
    this.checks.set(opId, held);
    return { opId, locationId, ...(locationName ? { locationName } : {}), expiresAt: held.expiresAt };
  }

  /** Step 2: the owner confirms that exact check. The token must still be the one that was checked. */
  confirm(opId: string): HighLevelOwnerConnection {
    this.pruneChecks();
    const held = this.checks.get(opId);
    if (!held) throw new HighLevelError("That check has expired. Check the location again.", { status: 409 });
    this.checks.delete(opId);
    const token = this.currentToken();
    if (!token || highlevelTokenFingerprint(token) !== held.tokenFingerprint) throw new HighLevelError("The HighLevel token changed after the check. Check the location again.", { status: 409 });
    const previous = this.stored();
    const record: HighLevelConnectionRecord = {
      connectionId: highlevelConnectionIdFor(held.locationId), locationId: held.locationId, companyId: held.companyId,
      ...(held.locationName ? { locationName: held.locationName } : {}),
      epoch: (previous?.epoch ?? 0) + 1, tokenFingerprint: held.tokenFingerprint, confirmedAt: new Date(this.now()).toISOString(),
    };
    writeAtomic(this.options.file, JSON.stringify(record));
    return this.ownerView()!;
  }

  /** Removes the connection record (the token stays saved until the owner clears it). Returns whether one was removed. */
  disconnect(connectionId: string): boolean {
    const record = this.record();
    if (!record || record.connectionId !== connectionId) return false;
    writeAtomic(this.options.file, JSON.stringify({ ...record, disconnected: true }));
    this.checks.clear();
    return true;
  }

  private pruneChecks(): void {
    const now = this.now();
    for (const [id, held] of this.checks) if (held.expiresAt <= now) this.checks.delete(id);
    while (this.checks.size >= MAX_HELD_CHECKS) this.checks.delete(this.checks.keys().next().value!);
  }
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > max) throw new HighLevelError("HighLevel's answer was too large.", { status: 502 });
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new HighLevelError("HighLevel's answer was too large.", { status: 502 }); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, file);
}
