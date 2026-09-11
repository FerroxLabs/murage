// Persisted user-added local model servers and cached tool-test results
// (0.1.52 LM1, spec A1/A3/T1).
//
// Trust boundary. `decodeInjectId` (drivers/local-inject.ts) is what stops an
// arbitrary base URL being written into a CLI's config. A user-added server
// extends that allowlist, so every entry is RE-VALIDATED ON EVERY READ with
// the same rule the add route enforces (http only for loopback / RFC1918 /
// tailnet, https otherwise, no credentials in the URL). A hand-edited file
// that breaks the rule does not reach any engine writer: the entry is dropped.
//
// Custody. The optional API key is kept in this 0600 file, like the other
// file-fallback credentials in config.json, and is never echoed back over
// HTTP (`hasKey` only). It is only ever sent to the server's own origin.
//
// The store is inert until `configureLocalServerStore(dataDir)` runs at boot,
// so tests and library imports never read a real ~/.murage.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  isLocalServerKind,
  isLocalToolTestResult,
  isValidLocalServerKey,
  isValidLocalServerName,
  LOCAL_SERVERS_MAX,
  normalizeLocalServerAddress,
  USER_LOCAL_SERVER_ID,
  type LocalServerKind,
  type LocalToolTestResult,
} from "../shared/local-models.ts";
import { writeFileAtomic } from "./atomic.ts";

export interface StoredLocalServer {
  id: string;
  name: string;
  kind: LocalServerKind;
  /** Canonical `…/v1` base (normalizeLocalServerAddress().apiBase). */
  apiBase: string;
  apiKey?: string;
  createdAt: number;
  updatedAt: number;
}

const SERVERS_FILE = "local-servers.json";
const TESTS_FILE = "local-model-tests.json";
/** Bound the persisted test cache so a long-lived install cannot grow it without limit. */
const MAX_CACHED_TESTS = 256;

let storeDir: string | null = null;
let serversCache: { key: string; servers: StoredLocalServer[] } | null = null;
let testsCache: { key: string; tests: Map<string, LocalToolTestResult> } | null = null;

/** Point the store at the data dir (index.ts, at boot). `null` disables it. */
export function configureLocalServerStore(dataDir: string | null): void {
  storeDir = dataDir ? join(dataDir, "local-models") : null;
  serversCache = null;
  testsCache = null;
}

export function localServerStoreConfigured(): boolean {
  return storeDir !== null;
}

function fileKey(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return null;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** One entry off disk, or null when it no longer passes the add-time rules. */
function validStoredServer(value: unknown): StoredLocalServer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !USER_LOCAL_SERVER_ID.test(row.id)) return null;
  if (!isValidLocalServerName(row.name) || !isLocalServerKind(row.kind)) return null;
  const address = normalizeLocalServerAddress(row.apiBase);
  // The stored base must already be canonical: a rewritten value is a sign the
  // file was edited by hand, and the canonical form is what engines receive.
  if (!address.ok || address.apiBase !== row.apiBase) return null;
  if (row.apiKey !== undefined && !isValidLocalServerKey(row.apiKey)) return null;
  const createdAt = typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : 0;
  const updatedAt = typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : createdAt;
  return {
    id: row.id,
    name: row.name.trim(),
    kind: row.kind,
    apiBase: address.apiBase,
    ...(typeof row.apiKey === "string" ? { apiKey: row.apiKey } : {}),
    createdAt,
    updatedAt,
  };
}

/** Every valid user-added server. Invalid or duplicate entries are skipped. */
export function readLocalServers(): StoredLocalServer[] {
  if (!storeDir) return [];
  const path = join(storeDir, SERVERS_FILE);
  const key = fileKey(path);
  if (!key) return [];
  if (serversCache?.key === key) return serversCache.servers;
  const parsed = readJson(path);
  const rows = parsed && typeof parsed === "object" && Array.isArray((parsed as { servers?: unknown }).servers)
    ? (parsed as { servers: unknown[] }).servers
    : [];
  const seen = new Set<string>();
  const servers: StoredLocalServer[] = [];
  for (const row of rows.slice(0, LOCAL_SERVERS_MAX)) {
    const server = validStoredServer(row);
    if (!server || seen.has(server.id)) continue;
    seen.add(server.id);
    servers.push(server);
  }
  serversCache = { key, servers };
  return servers;
}

export function userLocalServer(id: string): StoredLocalServer | undefined {
  if (!USER_LOCAL_SERVER_ID.test(id)) return undefined;
  return readLocalServers().find((server) => server.id === id);
}

export function writeLocalServers(servers: readonly StoredLocalServer[]): void {
  if (!storeDir) throw Object.assign(new Error("Local model settings are not available"), { code: "store-unavailable" });
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const path = join(storeDir, SERVERS_FILE);
  writeFileAtomic(path, `${JSON.stringify({ version: 1, servers }, null, 2)}\n`, { mode: 0o600 });
  serversCache = null;
}

export function newLocalServerId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `srv_${randomBytes(6).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

// ── tool-test cache ───────────────────────────────────────────────────────

function testKey(serverId: string, apiBase: string, model: string): string {
  return `${serverId}|${apiBase}|${model}`;
}

function readTests(): Map<string, LocalToolTestResult> {
  if (!storeDir) return new Map();
  const path = join(storeDir, TESTS_FILE);
  const key = fileKey(path);
  if (!key) return new Map();
  if (testsCache?.key === key) return testsCache.tests;
  const parsed = readJson(path);
  const rows = parsed && typeof parsed === "object" && Array.isArray((parsed as { tests?: unknown }).tests)
    ? (parsed as { tests: unknown[] }).tests
    : [];
  const tests = new Map<string, LocalToolTestResult>();
  for (const row of rows) {
    if (!isLocalToolTestResult(row)) continue;
    tests.set(testKey(row.serverId, row.apiBase, row.model), row);
  }
  testsCache = { key, tests };
  return tests;
}

function writeTests(tests: Map<string, LocalToolTestResult>): void {
  if (!storeDir) return;
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const rows = [...tests.values()].sort((a, b) => b.testedAt - a.testedAt).slice(0, MAX_CACHED_TESTS);
  writeFileAtomic(join(storeDir, TESTS_FILE), `${JSON.stringify({ version: 1, tests: rows }, null, 2)}\n`, { mode: 0o600 });
  testsCache = null;
}

/** The last test for this server+address+model. A changed address misses. */
export function cachedLocalToolTest(serverId: string, apiBase: string, model: string): LocalToolTestResult | undefined {
  return readTests().get(testKey(serverId, apiBase, model));
}

export function saveLocalToolTest(result: LocalToolTestResult): void {
  if (!storeDir) return;
  const tests = new Map(readTests());
  tests.set(testKey(result.serverId, result.apiBase, result.model), result);
  writeTests(tests);
}

export function forgetLocalToolTests(serverId: string): void {
  if (!storeDir) return;
  const tests = new Map(readTests());
  let changed = false;
  for (const [key, row] of tests) {
    if (row.serverId !== serverId) continue;
    tests.delete(key);
    changed = true;
  }
  if (changed) writeTests(tests);
}
