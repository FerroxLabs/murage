import {
  CloudflareAPI,
  CloudflareAPIError,
  MANAGED_CLOUD_HOME_ORIGIN_URL,
  MANAGED_COMPANION_ORIGIN_URL,
  type CloudflareDNSRecord,
  type CloudflareFetch,
  type CloudflareTunnel,
} from "./cloudflare-api";
import { CLOUD_HOME_DISABLED_CODE, CLOUD_HOME_MISCONFIGURED_CODE, cloudHomeCloudflare, type ControlPlaneConfig } from "./config";
import { errorResponse, HTTPError, json } from "./http";
import { requireInstallation } from "./installations";

type EndpointStatus = "pending" | "provisioning" | "ready" | "deleting" | "deleted" | "error";

interface EndpointRow {
  owner_id: string;
  hostname: string;
  tunnel_name: string;
  tunnel_id: string | null;
  dns_record_id: string | null;
  status: EndpointStatus;
  generation: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  last_reconciled_at: number | null;
  delete_requested_at: number | null;
  last_error_code: string | null;
  cleanup_attempts: number;
  last_cleanup_attempt_at: number | null;
  token_roll_due: number;
  created_at: number;
  updated_at: number;
}

/** The two owners of a managed endpoint share one lifecycle (lease, generation
 *  fencing, rollback, cleanup backoff). Only the table, the owner column, the
 *  rate-limit table, the hostname prefix and the ingress target differ. The
 *  values are constants, never request input, so they are safe in SQL text. */
interface EndpointKind {
  idColumn: "installation_id" | "machine_id";
  originUrl: string;
  prefix: "c" | "h";
  rateTable: "installation_action_rate_limits" | "machine_action_rate_limits";
  table: "installation_endpoints" | "machine_endpoints";
}

const DESKTOP_KIND: EndpointKind = {
  idColumn: "installation_id",
  originUrl: MANAGED_COMPANION_ORIGIN_URL,
  prefix: "c",
  rateTable: "installation_action_rate_limits",
  table: "installation_endpoints",
};

const MACHINE_KIND: EndpointKind = {
  idColumn: "machine_id",
  originUrl: MANAGED_CLOUD_HOME_ORIGIN_URL,
  prefix: "h",
  rateTable: "machine_action_rate_limits",
  table: "machine_endpoints",
};

interface ClaimedEndpoint {
  kind: EndpointKind;
  leaseOwner: string;
  row: EndpointRow;
}

/** The exact credential that authorized a provisioning request.
 *  Provider work can take many awaited calls; the final connector-token
 *  issuance is fenced against this credential still being current. */
interface IssuanceCredential {
  /** A SQL boolean expression that is true only while the credential is
   *  current, with a function giving its bound values at the
   *  moment of the final fence. Desktop and machine kinds differ. */
  sql: string;
  values: (now: number) => unknown[];
}

// Revoked, rotated-away or expired credential, or a revoked installation,
// observed at the final issuance fence. Resources stay retained for adoption
// by the next authorized reconcile or for the revoked-installation sweep.
const CREDENTIAL_INACTIVE = "installation_credential_inactive";

const LEASE_MS = 60_000;
const ENDPOINT_ACTION_WINDOW_MS = 60 * 60 * 1_000;
const ENDPOINT_RECONCILE_LIMIT = 20;
const ENDPOINT_DELETE_LIMIT = 30;
// A cleanup can make at most ten external Cloudflare API calls when it must
// rediscover both provider IDs. Four concurrent candidates stay below the
// Workers Free plan's 50-external-subrequest ceiling and six-connection limit.
const CLEANUP_SWEEP_LIMIT = 4;
const CLEANUP_BACKOFF_1_MS = 5 * 60 * 1_000;
const CLEANUP_BACKOFF_2_MS = 15 * 60 * 1_000;
const CLEANUP_BACKOFF_3_MS = 60 * 60 * 1_000;
const CLEANUP_BACKOFF_4_MS = 6 * 60 * 60 * 1_000;
const CLEANUP_BACKOFF_MAX_MS = 24 * 60 * 60 * 1_000;
const MANUAL_CLEANUP_THRESHOLD_MS = 24 * 60 * 60 * 1_000;

class EndpointOperationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "EndpointOperationError";
  }
}

function errorCode(error: unknown): string {
  if (error instanceof CloudflareAPIError || error instanceof EndpointOperationError) return error.code;
  return "endpoint_internal";
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function endpointJSON(row: EndpointRow) {
  return {
    url: `https://${row.hostname}`,
    hostname: row.hostname,
    status: row.status,
    generation: row.generation,
    updatedAt: row.updated_at,
    lastReconciledAt: row.last_reconciled_at,
    lastErrorCode: row.last_error_code,
  };
}

async function endpointRow(env: Env, kind: EndpointKind, ownerId: string): Promise<EndpointRow | null> {
  return env.DB.prepare(
    `SELECT ${kind.idColumn} AS owner_id, hostname, tunnel_name, tunnel_id, dns_record_id,
            status, generation, lease_owner, lease_expires_at,
            last_reconciled_at, delete_requested_at, last_error_code,
            cleanup_attempts, last_cleanup_attempt_at, token_roll_due, created_at, updated_at
       FROM ${kind.table}
      WHERE ${kind.idColumn} = ?`,
  ).bind(ownerId).first<EndpointRow>();
}

async function ensureEndpointRow(
  env: Env,
  ownerId: string,
  hostSuffix: string,
  kind: EndpointKind = DESKTOP_KIND,
): Promise<EndpointRow> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const opaque = randomHex(16);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO ${kind.table}
        (${kind.idColumn}, hostname, tunnel_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).bind(ownerId, `${kind.prefix}-${opaque}.${hostSuffix}`, `murage-${kind.prefix}-${opaque}`, now, now).run();
    const row = await endpointRow(env, kind, ownerId);
    if (row) return row;
  }
  throw new EndpointOperationError("endpoint_reservation_failed");
}

/** Allocates a machine's immutable endpoint hostname. Returns the INSERT for
 *  the caller to include in the same D1 batch that creates the machine (or its
 *  reservation), so the hostname exists exactly when the machine does. */
export function allocateMachineEndpoint(
  env: Env,
  machineId: string,
  hostSuffix: string,
  now: number,
  guardedByChanges = false,
): { hostname: string; origin: string; statement: D1PreparedStatement } {
  const opaque = randomHex(16);
  const hostname = `${MACHINE_KIND.prefix}-${opaque}.${hostSuffix}`;
  const columns = "(machine_id, hostname, tunnel_name, status, created_at, updated_at)";
  const statement = guardedByChanges
    ? env.DB.prepare(
      `INSERT INTO machine_endpoints ${columns}
       SELECT ?, ?, ?, 'pending', ?, ? WHERE changes() = 1`,
    )
    : env.DB.prepare(`INSERT INTO machine_endpoints ${columns} VALUES (?, ?, ?, 'pending', ?, ?)`);
  return {
    hostname,
    origin: `https://${hostname}`,
    statement: statement.bind(machineId, hostname, `murage-${MACHINE_KIND.prefix}-${opaque}`, now, now),
  };
}

async function enforceEndpointRateLimit(
  env: Env,
  ownerId: string,
  action: "delete_endpoint" | "reconcile_endpoint",
  kind: EndpointKind = DESKTOP_KIND,
): Promise<void> {
  const now = Date.now();
  const cutoff = now - ENDPOINT_ACTION_WINDOW_MS;
  const limit = action === "reconcile_endpoint" ? ENDPOINT_RECONCILE_LIMIT : ENDPOINT_DELETE_LIMIT;
  const result = await env.DB.prepare(
    `INSERT INTO ${kind.rateTable}
      (${kind.idColumn}, action, window_started_at, attempts, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(${kind.idColumn}, action) DO UPDATE SET
       window_started_at = CASE
         WHEN window_started_at <= ? THEN excluded.window_started_at
         ELSE window_started_at
       END,
       attempts = CASE
         WHEN window_started_at <= ? THEN 1
         ELSE attempts + 1
       END,
       updated_at = excluded.updated_at
     WHERE window_started_at <= ? OR attempts < ?`,
  ).bind(ownerId, action, now, now, cutoff, cutoff, cutoff, limit).run();
  if (result.meta.changes === 0) throw new HTTPError(429, "rate_limited");
}

async function claimEndpoint(
  env: Env,
  row: EndpointRow,
  nextStatus: "deleting" | "provisioning",
  kind: EndpointKind = DESKTOP_KIND,
  /** A further SQL condition the row must still meet in the claiming statement itself (no bound values). */
  stillEligible = "",
): Promise<ClaimedEndpoint | null> {
  const now = Date.now();
  const leaseOwner = crypto.randomUUID();
  const deletingGuard = `${nextStatus === "provisioning" ? "AND status != 'deleting'" : ""} ${stillEligible ? `AND (${stillEligible})` : ""}`;
  const result = await env.DB.prepare(
    `UPDATE ${kind.table}
        SET status = ?, generation = generation + 1,
            lease_owner = ?, lease_expires_at = ?, updated_at = ?,
            delete_requested_at = CASE WHEN ? = 'deleting' THEN COALESCE(delete_requested_at, ?) ELSE NULL END,
            cleanup_attempts = CASE WHEN ? = 'deleting' THEN cleanup_attempts + 1 ELSE 0 END,
            last_cleanup_attempt_at = CASE WHEN ? = 'deleting' THEN ? ELSE NULL END,
            last_error_code = NULL
      WHERE ${kind.idColumn} = ?
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ${deletingGuard}`,
  ).bind(
    nextStatus,
    leaseOwner,
    now + LEASE_MS,
    now,
    nextStatus,
    now,
    nextStatus,
    nextStatus,
    now,
    row.owner_id,
    now,
  ).run();
  if (result.meta.changes === 0) return null;
  const claimed = await endpointRow(env, kind, row.owner_id);
  if (!claimed || claimed.lease_owner !== leaseOwner) {
    throw new EndpointOperationError("lease_lost");
  }
  return { kind, leaseOwner, row: claimed };
}

async function updateClaimedResources(
  env: Env,
  claim: ClaimedEndpoint,
  tunnelId: string | null,
  dnsRecordId: string | null,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE ${claim.kind.table}
        SET tunnel_id = ?, dns_record_id = ?, updated_at = ?
      WHERE ${claim.kind.idColumn} = ? AND generation = ? AND lease_owner = ?`,
  ).bind(
    tunnelId,
    dnsRecordId,
    Date.now(),
    claim.row.owner_id,
    claim.row.generation,
    claim.leaseOwner,
  ).run();
  if (result.meta.changes === 0) throw new EndpointOperationError("lease_lost");
  claim.row.tunnel_id = tunnelId;
  claim.row.dns_record_id = dnsRecordId;
}

async function renewClaim(env: Env, claim: ClaimedEndpoint): Promise<void> {
  const now = Date.now();
  const leaseExpiresAt = now + LEASE_MS;
  const result = await env.DB.prepare(
    `UPDATE ${claim.kind.table}
        SET lease_expires_at = ?, updated_at = ?
      WHERE ${claim.kind.idColumn} = ? AND generation = ? AND lease_owner = ?
        AND lease_expires_at > ?`,
  ).bind(
    leaseExpiresAt,
    now,
    claim.row.owner_id,
    claim.row.generation,
    claim.leaseOwner,
    now,
  ).run();
  if (result.meta.changes === 0) throw new EndpointOperationError("lease_lost");
  claim.row.lease_expires_at = leaseExpiresAt;
}

async function withClaimLease<T>(
  env: Env,
  claim: ClaimedEndpoint,
  operation: () => Promise<T>,
): Promise<T> {
  await renewClaim(env, claim);
  return operation();
}

function expectedTunnelTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

function assertTunnelIdentity(
  claim: ClaimedEndpoint,
  tunnelId: string,
  tunnel: { id: string; name: string },
): void {
  if (tunnel.id !== tunnelId || tunnel.name !== claim.row.tunnel_name) {
    throw new EndpointOperationError("tunnel_identity_conflict");
  }
}

function assertDNSIdentity(
  claim: ClaimedEndpoint,
  tunnelId: string,
  dnsRecordId: string,
  record: { content: string; id: string; name: string; proxied: boolean; type: string },
): void {
  if (
    record.id !== dnsRecordId
    || record.name.toLowerCase() !== claim.row.hostname
    || record.type !== "CNAME"
    || record.content.toLowerCase() !== expectedTunnelTarget(tunnelId)
    || !record.proxied
  ) {
    throw new EndpointOperationError("dns_record_identity_conflict");
  }
}

async function finishDeletedClaim(env: Env, claim: ClaimedEndpoint): Promise<EndpointRow> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE ${claim.kind.table}
        SET status = 'deleted', lease_owner = NULL, lease_expires_at = NULL,
            last_reconciled_at = ?, last_error_code = NULL, updated_at = ?
      WHERE ${claim.kind.idColumn} = ? AND generation = ? AND lease_owner = ?`,
  ).bind(now, now, claim.row.owner_id, claim.row.generation, claim.leaseOwner).run();
  if (result.meta.changes === 0) throw new EndpointOperationError("lease_lost");
  const row = await endpointRow(env, claim.kind, claim.row.owner_id);
  if (!row) throw new EndpointOperationError("endpoint_state_missing");
  return row;
}

/** Publish a ready endpoint only while the lease AND the authorizing credential
 *  are both still current. One conditional statement, so a revocation,
 *  rotation or expiry that commits while provider calls are in flight can never
 *  be followed by a ready row whose connector token reaches the caller. */
async function finishReadyClaim(
  env: Env,
  claim: ClaimedEndpoint,
  credential: IssuanceCredential,
): Promise<EndpointRow> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE ${claim.kind.table}
        SET status = 'ready', lease_owner = NULL, lease_expires_at = NULL,
            last_reconciled_at = ?, last_error_code = NULL, token_roll_due = 0, updated_at = ?
      WHERE ${claim.kind.idColumn} = ? AND generation = ? AND lease_owner = ?
        AND ${credential.sql}`,
  ).bind(
    now,
    now,
    claim.row.owner_id,
    claim.row.generation,
    claim.leaseOwner,
    ...credential.values(now),
  ).run();
  if (result.meta.changes === 0) {
    const current = await endpointRow(env, claim.kind, claim.row.owner_id);
    if (current?.generation === claim.row.generation && current.lease_owner === claim.leaseOwner) {
      throw new EndpointOperationError(CREDENTIAL_INACTIVE);
    }
    throw new EndpointOperationError("lease_lost");
  }
  const row = await endpointRow(env, claim.kind, claim.row.owner_id);
  if (!row) throw new EndpointOperationError("endpoint_state_missing");
  return row;
}

async function failClaim(
  env: Env,
  claim: ClaimedEndpoint,
  code: string,
  preserveDeleting: boolean,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ${claim.kind.table}
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = ?, updated_at = ?
      WHERE ${claim.kind.idColumn} = ? AND generation = ? AND lease_owner = ?`,
  ).bind(
    preserveDeleting ? "deleting" : "error",
    code.slice(0, 64),
    Date.now(),
    claim.row.owner_id,
    claim.row.generation,
    claim.leaseOwner,
  ).run();
}

function busyResponse(): Response {
  const response = errorResponse(409, "endpoint_busy");
  const headers = new Headers(response.headers);
  headers.set("retry-after", "2");
  return new Response(response.body, { status: response.status, headers });
}

async function reconcileDNSWriteResult(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  tunnelId: string,
  expectedRecordId: string | null,
): Promise<CloudflareDNSRecord | null> {
  const records = await withClaimLease(
    env,
    claim,
    () => api.listDNSRecords(claim.row.hostname),
  );
  if (records.length > 1) throw new EndpointOperationError("dns_record_conflict");
  const record = records[0];
  if (!record) return null;
  if (expectedRecordId && record.id !== expectedRecordId) {
    throw new EndpointOperationError("dns_record_conflict");
  }
  if (
    record.name.toLowerCase() !== claim.row.hostname
    || record.type !== "CNAME"
    || record.content.toLowerCase() !== expectedTunnelTarget(tunnelId)
    || !record.proxied
  ) {
    throw new EndpointOperationError("dns_record_conflict");
  }
  return record;
}

async function verifiedTunnelForCleanup(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  tunnelId: string,
): Promise<CloudflareTunnel | null> {
  const tunnel = await withClaimLease(env, claim, () => api.getTunnel(tunnelId));
  const named = await withClaimLease(
    env,
    claim,
    () => api.listTunnels(claim.row.tunnel_name),
  );
  if (named.length > 1) throw new EndpointOperationError("tunnel_identity_conflict");
  if (!tunnel) {
    if (named.length !== 0) throw new EndpointOperationError("tunnel_identity_conflict");
    return null;
  }
  assertTunnelIdentity(claim, tunnelId, tunnel);
  if (named.length !== 1 || named[0]?.id !== tunnelId) {
    throw new EndpointOperationError("tunnel_identity_conflict");
  }
  return tunnel;
}

async function verifiedDNSForCleanup(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  tunnelId: string,
  dnsRecordId: string,
): Promise<CloudflareDNSRecord | null> {
  const record = await withClaimLease(env, claim, () => api.getDNSRecord(dnsRecordId));
  const named = await withClaimLease(
    env,
    claim,
    () => api.listDNSRecords(claim.row.hostname),
  );
  if (named.length > 1) throw new EndpointOperationError("dns_record_identity_conflict");
  if (!record) {
    if (named.length !== 0) throw new EndpointOperationError("dns_record_identity_conflict");
    return null;
  }
  assertDNSIdentity(claim, tunnelId, dnsRecordId, record);
  if (named.length !== 1 || named[0]?.id !== dnsRecordId) {
    throw new EndpointOperationError("dns_record_identity_conflict");
  }
  return record;
}

async function rollbackCreatedResources(
  env: Env,
  claim: ClaimedEndpoint,
  api: CloudflareAPI,
  state: {
    createdDNSRecord: boolean;
    createdTunnel: boolean;
    dnsMayReferenceTunnel: boolean;
    dnsRecordId: string | null;
    tunnelId: string | null;
  },
): Promise<{ dnsRecordId: string | null; tunnelId: string | null }> {
  let { dnsRecordId, tunnelId } = state;
  if (!state.createdDNSRecord && !state.createdTunnel) return { dnsRecordId, tunnelId };
  if (tunnelId) await verifiedTunnelForCleanup(env, claim, api, tunnelId);

  if (state.createdDNSRecord && dnsRecordId && tunnelId) {
    const record = await verifiedDNSForCleanup(env, claim, api, tunnelId, dnsRecordId);
    if (record) {
      await renewClaim(env, claim);
      await api.deleteDNSRecord(dnsRecordId);
    }
    dnsRecordId = null;
    await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
  }

  if (
    state.createdTunnel
    && tunnelId
    && (!state.dnsMayReferenceTunnel || (state.createdDNSRecord && !dnsRecordId))
  ) {
    // Re-fetch immediately before the destructive request. The stable name is
    // our provider-side identity fence; a renamed/repurposed tunnel is retained.
    const tunnel = await verifiedTunnelForCleanup(env, claim, api, tunnelId);
    if (tunnel) {
      await renewClaim(env, claim);
      await api.deleteTunnel(tunnelId);
    }
    tunnelId = null;
    await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
  }

  return { dnsRecordId, tunnelId };
}

async function reconcileClaim(
  env: Env,
  config: ControlPlaneConfig,
  claim: ClaimedEndpoint,
  fetcher: CloudflareFetch,
  credential: IssuanceCredential,
): Promise<{ connectorToken: string; row: EndpointRow }> {
  const api = new CloudflareAPI(claim.kind === MACHINE_KIND ? cloudHomeCloudflare(config) : config.cloudflare, fetcher);
  let tunnelId = claim.row.tunnel_id;
  let dnsRecordId = claim.row.dns_record_id;
  let createdTunnel = false;
  let createdDNSRecord = false;
  let dnsMayReferenceTunnel = false;

  try {
    const tunnels = await withClaimLease(
      env,
      claim,
      () => api.listTunnels(claim.row.tunnel_name),
    );
    if (tunnels.length > 1) throw new EndpointOperationError("tunnel_name_conflict");
    if (tunnels.length === 1) {
      if (tunnelId && tunnelId !== tunnels[0]?.id) {
        throw new EndpointOperationError("tunnel_id_conflict");
      }
      tunnelId = tunnels[0]?.id ?? null;
    } else {
      try {
        const tunnel = await withClaimLease(
          env,
          claim,
          () => api.createTunnel(claim.row.tunnel_name),
        );
        tunnelId = tunnel.id;
        createdTunnel = true;
      } catch (createError) {
        // A timeout/network failure can arrive after Cloudflare committed the
        // POST. Reconcile by the stable opaque name instead of creating a
        // duplicate tunnel on the next request.
        let created: CloudflareTunnel[];
        try {
          created = await withClaimLease(
            env,
            claim,
            () => api.listTunnels(claim.row.tunnel_name),
          );
        } catch {
          throw createError;
        }
        if (created.length > 1) throw new EndpointOperationError("tunnel_name_conflict");
        if (created.length === 0) throw createError;
        tunnelId = created[0]?.id ?? null;
      }
    }
    if (!tunnelId) throw new EndpointOperationError("tunnel_missing");
    const activeTunnelId = tunnelId;
    await updateClaimedResources(env, claim, activeTunnelId, dnsRecordId);
    await withClaimLease(
      env,
      claim,
      () => api.configureTunnel(activeTunnelId, claim.row.hostname, claim.kind.originUrl),
    );

    const target = expectedTunnelTarget(activeTunnelId);
    const records = await withClaimLease(
      env,
      claim,
      () => api.listDNSRecords(claim.row.hostname),
    );
    if (records.length > 1) throw new EndpointOperationError("dns_record_conflict");
    const existing = records[0];
    if (existing) {
      if (existing.content.toLowerCase() !== target && existing.id !== dnsRecordId) {
        throw new EndpointOperationError("dns_record_conflict");
      }
      dnsMayReferenceTunnel = existing.content.toLowerCase() === target;
      let record = existing;
      if (!existing.proxied || existing.content.toLowerCase() !== target) {
        dnsMayReferenceTunnel = true;
        try {
          record = await withClaimLease(
            env,
            claim,
            () => api.updateDNSRecord(existing.id, claim.row.hostname, activeTunnelId),
          );
        } catch (writeError) {
          try {
            const reconciled = await reconcileDNSWriteResult(
              env,
              claim,
              api,
              activeTunnelId,
              existing.id,
            );
            if (!reconciled) throw writeError;
            record = reconciled;
          } catch (reconcileError) {
            if (reconcileError instanceof EndpointOperationError) throw reconcileError;
            throw writeError;
          }
        }
      }
      dnsRecordId = record.id;
    } else {
      dnsMayReferenceTunnel = true;
      try {
        const record = await withClaimLease(
          env,
          claim,
          () => api.createDNSRecord(claim.row.hostname, activeTunnelId),
        );
        dnsRecordId = record.id;
        createdDNSRecord = true;
      } catch (writeError) {
        try {
          const reconciled = await reconcileDNSWriteResult(
            env,
            claim,
            api,
            activeTunnelId,
            null,
          );
          if (!reconciled) {
            dnsMayReferenceTunnel = false;
            throw writeError;
          }
          // The write may have committed, but its response did not prove that
          // this request created the record. Adopt and retain it on later
          // failures instead of destructively guessing.
          dnsRecordId = reconciled.id;
        } catch (reconcileError) {
          if (reconcileError instanceof EndpointOperationError) throw reconcileError;
          throw writeError;
        }
      }
    }
    await updateClaimedResources(env, claim, activeTunnelId, dnsRecordId);

    // A credential rotation owes a new tunnel secret: the previously issued
    // connector token must stop working before any token is handed out. The
    // flag is cleared only together with the ready publish below, so a failed
    // roll (or a lost response) is simply repeated on the next claim.
    if (claim.row.token_roll_due) {
      await withClaimLease(env, claim, () => api.rotateTunnelSecret(activeTunnelId));
    }
    const connectorToken = await withClaimLease(
      env,
      claim,
      () => api.getConnectorToken(activeTunnelId),
    );
    const row = await finishReadyClaim(env, claim, credential);
    return { connectorToken, row };
  } catch (error) {
    let operationCode = errorCode(error);

    if (operationCode === CREDENTIAL_INACTIVE) {
      // The token is withheld. Keep the exact provider identities recorded
      // instead of deleting in this request: the next authorized reconcile
      // adopts them by stable name, and a revoked installation's row is picked
      // up by the identity-checked cleanup sweep.
      try {
        await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
        await failClaim(env, claim, operationCode, false);
      } catch {
        // A successor already owns the row and its resources.
      }
      throw new EndpointOperationError(operationCode);
    }

    try {
      const rolledBack = await rollbackCreatedResources(env, claim, api, {
        createdDNSRecord,
        createdTunnel,
        dnsMayReferenceTunnel,
        dnsRecordId,
        tunnelId,
      });
      dnsRecordId = rolledBack.dnsRecordId;
      tunnelId = rolledBack.tunnelId;
    } catch (rollbackError) {
      // A stale request must stop immediately: it no longer owns either the
      // D1 generation or the provider resources that a successor may adopt.
      operationCode = errorCode(rollbackError);
    }
    try {
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
      await failClaim(env, claim, operationCode, false);
    } catch {
      // The original redacted failure is the useful client-facing result.
    }
    throw new EndpointOperationError(operationCode);
  }
}

async function deleteClaim(
  env: Env,
  config: ControlPlaneConfig,
  claim: ClaimedEndpoint,
  fetcher: CloudflareFetch,
): Promise<void> {
  const api = new CloudflareAPI(claim.kind === MACHINE_KIND ? cloudHomeCloudflare(config) : config.cloudflare, fetcher);
  let tunnelId = claim.row.tunnel_id;
  let dnsRecordId = claim.row.dns_record_id;

  try {
    if (!tunnelId) {
      const tunnels = await withClaimLease(
        env,
        claim,
        () => api.listTunnels(claim.row.tunnel_name),
      );
      if (tunnels.length > 1) throw new EndpointOperationError("tunnel_name_conflict");
      tunnelId = tunnels[0]?.id ?? null;
      if (tunnelId) await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
    }
    if (!dnsRecordId) {
      const records = await withClaimLease(
        env,
        claim,
        () => api.listDNSRecords(claim.row.hostname),
      );
      if (records.length > 1) throw new EndpointOperationError("dns_record_conflict");
      const record = records[0];
      if (record) {
        if (
          !tunnelId
          || record.type !== "CNAME"
          || record.content.toLowerCase() !== expectedTunnelTarget(tunnelId)
          || !record.proxied
        ) {
          throw new EndpointOperationError("dns_record_conflict");
        }
        dnsRecordId = record.id;
        await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
      }
    }

    // Validate the complete resource set before the first delete. Persisted
    // provider IDs are only hints: the hostname/CNAME and stable tunnel name
    // must still agree, otherwise cleanup retains metadata for an operator.
    if (tunnelId) await verifiedTunnelForCleanup(env, claim, api, tunnelId);
    const dnsRecord = dnsRecordId && tunnelId
      ? await verifiedDNSForCleanup(env, claim, api, tunnelId, dnsRecordId)
      : null;
    if (dnsRecordId && !tunnelId) {
      throw new EndpointOperationError("dns_record_identity_conflict");
    }

    if (dnsRecordId) {
      if (dnsRecord) {
        await renewClaim(env, claim);
        await api.deleteDNSRecord(dnsRecordId);
      }
      dnsRecordId = null;
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
    }
    if (tunnelId) {
      const tunnel = await verifiedTunnelForCleanup(env, claim, api, tunnelId);
      if (tunnel) {
        await renewClaim(env, claim);
        await api.deleteTunnel(tunnelId);
      }
      tunnelId = null;
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
    }
    await finishDeletedClaim(env, claim);
  } catch (error) {
    const operationCode = errorCode(error);
    try {
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
      await failClaim(env, claim, operationCode, true);
    } catch {
      // Keep the original redacted error code.
    }
    throw new EndpointOperationError(operationCode);
  }
}

export async function getManagedEndpoint(request: Request, env: Env): Promise<Response> {
  const installation = await requireInstallation(request, env);
  const row = await endpointRow(env, DESKTOP_KIND, installation.installation_id);
  if (!row || row.status === "deleted") return json({ endpoint: null });
  return json({ endpoint: endpointJSON(row) });
}

export async function provisionManagedEndpoint(
  request: Request,
  env: Env,
  config: ControlPlaneConfig,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<Response> {
  const installation = await requireInstallation(request, env);
  await enforceEndpointRateLimit(env, installation.installation_id, "reconcile_endpoint");
  const row = await ensureEndpointRow(
    env,
    installation.installation_id,
    config.cloudflare.companionHostSuffix,
  );
  const claim = await claimEndpoint(env, row, "provisioning");
  if (!claim) return busyResponse();

  try {
    const result = await reconcileClaim(env, config, claim, fetcher, {
      // Revoked, rotated-away or expired credential, or a revoked installation.
      sql: `EXISTS (
          SELECT 1
            FROM installation_credentials c
            JOIN installations i ON i.id = c.installation_id
           WHERE c.installation_id = ?
             AND c.lookup_id = ?
             AND c.secret_hash = ?
             AND c.revoked_at IS NULL
             AND c.expires_at > ?
             AND i.revoked_at IS NULL
        )`,
      values: (now) => [
        installation.installation_id,
        installation.lookup_id,
        installation.secret_hash,
        now,
      ],
    });
    return json({ endpoint: endpointJSON(result.row), connectorToken: result.connectorToken });
  } catch (error) {
    if (errorCode(error) === CREDENTIAL_INACTIVE) {
      console.error(JSON.stringify({
        message: "managed endpoint issuance withheld: credential no longer current",
        requestId,
        errorCode: CREDENTIAL_INACTIVE,
      }));
      // Same answer the request would have received had the revocation,
      // rotation or expiry landed before authentication.
      throw new HTTPError(401, "unauthorized");
    }
    console.error(JSON.stringify({
      message: "managed endpoint reconcile failed",
      requestId,
      errorCode: errorCode(error),
    }));
    throw new HTTPError(502, "endpoint_unavailable");
  }
}

export async function deleteManagedEndpoint(
  request: Request,
  env: Env,
  config: ControlPlaneConfig,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<Response> {
  const installation = await requireInstallation(request, env);
  const row = await endpointRow(env, DESKTOP_KIND, installation.installation_id);
  if (!row || row.status === "deleted") {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  await enforceEndpointRateLimit(env, installation.installation_id, "delete_endpoint");
  const claim = await claimEndpoint(env, row, "deleting");
  if (!claim) return busyResponse();

  try {
    await deleteClaim(env, config, claim, fetcher);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error(JSON.stringify({
      message: "managed endpoint cleanup pending",
      requestId,
      errorCode: errorCode(error),
    }));
    throw new HTTPError(503, "endpoint_cleanup_pending");
  }
}

export async function cleanupEndpointForInstallation(
  env: Env,
  config: ControlPlaneConfig,
  installationId: string,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<void> {
  const row = await endpointRow(env, DESKTOP_KIND, installationId);
  if (!row || row.status === "deleted") return;
  const claim = await claimEndpoint(env, row, "deleting");
  if (!claim) return;
  try {
    await deleteClaim(env, config, claim, fetcher);
  } catch (error) {
    console.error(JSON.stringify({
      message: "revoked installation endpoint cleanup pending",
      requestId,
      errorCode: errorCode(error),
    }));
  }
}

export async function sweepManagedEndpointCleanup(
  env: Env,
  config: ControlPlaneConfig,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<number> {
  const now = Date.now();
  const candidates = await env.DB.prepare(
    `SELECT e.installation_id, e.cleanup_attempts, e.delete_requested_at, e.last_error_code
       FROM installation_endpoints e
       LEFT JOIN installations i ON i.id = e.installation_id
      WHERE e.status != 'deleted'
        AND (
          e.status = 'deleting'
          OR i.revoked_at IS NOT NULL
          OR i.id IS NULL
        )
        AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= ?)
        AND (
          e.cleanup_attempts = 0
          OR e.last_cleanup_attempt_at IS NULL
          OR e.last_cleanup_attempt_at <= CASE
            WHEN e.cleanup_attempts = 1 THEN ?
            WHEN e.cleanup_attempts = 2 THEN ?
            WHEN e.cleanup_attempts = 3 THEN ?
            WHEN e.cleanup_attempts = 4 THEN ?
            ELSE ?
          END
        )
      ORDER BY COALESCE(e.delete_requested_at, e.last_cleanup_attempt_at, e.updated_at) ASC,
               e.installation_id ASC
      LIMIT ?`,
  ).bind(
    now,
    now - CLEANUP_BACKOFF_1_MS,
    now - CLEANUP_BACKOFF_2_MS,
    now - CLEANUP_BACKOFF_3_MS,
    now - CLEANUP_BACKOFF_4_MS,
    now - CLEANUP_BACKOFF_MAX_MS,
    CLEANUP_SWEEP_LIMIT,
  ).all<{
    cleanup_attempts: number;
    delete_requested_at: number | null;
    installation_id: string;
    last_error_code: string | null;
  }>();

  const staleCandidates = candidates.results.filter((candidate) => (
    candidate.delete_requested_at !== null
    && candidate.delete_requested_at <= now - MANUAL_CLEANUP_THRESHOLD_MS
  ));
  if (staleCandidates.length > 0) {
    console.error(JSON.stringify({
      message: "managed endpoint cleanup requires operator attention",
      requestId,
      staleCandidateCount: staleCandidates.length,
      maxCleanupAttempts: Math.max(...staleCandidates.map((candidate) => candidate.cleanup_attempts)),
      errorCodes: [...new Set(staleCandidates.map((candidate) => (
        candidate.last_error_code ?? "endpoint_cleanup_pending"
      )))].sort(),
    }));
  }

  await Promise.all(candidates.results.map(async (candidate) => {
    try {
      await cleanupEndpointForInstallation(
        env,
        config,
        candidate.installation_id,
        fetcher,
        requestId,
      );
    } catch {
      console.error(JSON.stringify({
        message: "managed endpoint cleanup candidate failed",
        requestId,
        errorCode: "endpoint_internal",
      }));
    }
  }));
  // Machine endpoints share the same per-run provider-call budget.
  const machines = await sweepMachineEndpointCleanup(
    env,
    config,
    fetcher,
    requestId,
    Math.max(1, CLEANUP_SWEEP_LIMIT - candidates.results.length),
  );
  return candidates.results.length + machines;
}

// ---------------------------------------------------------------------------
// Cloud machine endpoints. Same lifecycle as the desktop endpoints above, keyed
// by cloud_machines.id and authenticated by the machine credential (the route
// and its credential, generation, state and bound-IP checks live in
// machine-endpoints.ts). No account session and no installation credential can
// reach any of this: the connector token only ever leaves in the response to
// the machine's own authenticated request.
// ---------------------------------------------------------------------------

/** The exact machine credential, generation and source IP that authorized the
 *  request, re-checked in the same statement that publishes the ready row, so a
 *  rotation, revoke, fence or teardown that commits while provider calls are in
 *  flight can never be followed by a connector token reaching the caller. */
export function machineIssuanceFence(
  machineId: string,
  generation: number,
  credentialHash: string,
  sourceIp: string,
): IssuanceCredential {
  return {
    sql: `EXISTS (
          SELECT 1
            FROM cloud_machines m
           WHERE m.id = ?
             AND m.generation = ?
             AND m.state = 'active'
             AND m.credential_hash = ?
             AND EXISTS (SELECT 1 FROM json_each(m.bound_ips) WHERE value = ?)
             AND (
               NOT EXISTS (SELECT 1 FROM cloud_homes h WHERE h.id = m.id)
               OR EXISTS (
                 SELECT 1 FROM cloud_homes h
                  WHERE h.id = m.id
                    AND h.generation = m.generation
                    AND h.desired_state IN ('provisioning', 'checking', 'ready', 'payment_problem')
               )
             )
        )`,
    values: () => [machineId, generation, credentialHash, sourceIp],
  };
}

export async function getMachineEndpoint(env: Env, machineId: string): Promise<Response> {
  const row = await endpointRow(env, MACHINE_KIND, machineId);
  if (!row) throw new HTTPError(404, "not_found");
  return json({ endpoint: endpointJSON(row) });
}

export async function provisionMachineEndpoint(
  env: Env,
  config: ControlPlaneConfig,
  fetcher: CloudflareFetch,
  requestId: string,
  machineId: string,
  fence: IssuanceCredential,
): Promise<Response> {
  // Fail closed (503) before any state change when homes have no usable domain.
  cloudHomeCloudflare(config);
  const row = await endpointRow(env, MACHINE_KIND, machineId);
  // Only machines created with managed_endpoint have a row; the hostname was
  // allocated then and is never re-allocated here.
  if (!row) throw new HTTPError(404, "not_found");
  await enforceEndpointRateLimit(env, machineId, "reconcile_endpoint", MACHINE_KIND);
  const claim = await claimEndpoint(env, row, "provisioning", MACHINE_KIND);
  if (!claim) return busyResponse();

  try {
    const result = await reconcileClaim(env, config, claim, fetcher, fence);
    return json({ endpoint: endpointJSON(result.row), connectorToken: result.connectorToken });
  } catch (error) {
    if (errorCode(error) === CREDENTIAL_INACTIVE) {
      console.error(JSON.stringify({
        message: "managed machine endpoint issuance withheld: credential no longer current",
        requestId,
        errorCode: CREDENTIAL_INACTIVE,
      }));
      throw new HTTPError(401, "unauthorized");
    }
    console.error(JSON.stringify({
      message: "managed machine endpoint reconcile failed",
      requestId,
      errorCode: errorCode(error),
    }));
    throw new HTTPError(502, "endpoint_unavailable");
  }
}

async function cleanupEndpointForMachine(
  env: Env,
  config: ControlPlaneConfig,
  machineId: string,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<void> {
  const row = await endpointRow(env, MACHINE_KIND, machineId);
  if (!row || row.status === "deleted") return;
  if (config.cloudHome.state !== "ready") {
    // Cannot reach the homes zone: leave the endpoint untouched, never use the desktop zone.
    console.error(JSON.stringify({
      message: "machine endpoint cleanup pending",
      requestId,
      errorCode: config.cloudHome.state === "disabled" ? CLOUD_HOME_DISABLED_CODE : CLOUD_HOME_MISCONFIGURED_CODE,
    }));
    return;
  }
  // Re-proved in the claim itself: a row the sweep selected may since belong to a home set up again (round 8c: a reopened home's endpoint,
  // back to 'pending' for its new resource generation); that row is never claimed for deletion by a stale selection.
  const claim = await claimEndpoint(env, row, "deleting", MACHINE_KIND, MACHINE_CLEANUP_ELIGIBLE_SQL);
  if (!claim) return;
  try {
    await deleteClaim(env, config, claim, fetcher);
  } catch (error) {
    console.error(JSON.stringify({
      message: "machine endpoint cleanup pending",
      requestId,
      errorCode: errorCode(error),
    }));
  }
}

/** The cleanup sweep's selection rule for one machine_endpoints row (unqualified columns are the row's), shared by the sweep's SELECT and
 *  the cleanup claim, so a row is claimed for deletion only while it still qualifies. */
const MACHINE_CLEANUP_ELIGIBLE_SQL = `status != 'deleted'
  AND (
    (status = 'deleting' AND ${deleteRequestCurrentSql("machine_endpoints.delete_resource_generation", `(SELECT h.resource_generation FROM cloud_homes h
      WHERE h.id = machine_endpoints.machine_id)`)})
    OR EXISTS (SELECT 1 FROM cloud_homes h WHERE h.id = machine_endpoints.machine_id
      AND h.desired_state IN ('stopped', 'suspended', 'deleting', 'deleted', 'failed', 'expired'))
    OR EXISTS (SELECT 1 FROM cloud_machines m WHERE m.id = machine_endpoints.machine_id AND m.state NOT IN ('active', 'pending_binding'))
    OR (NOT EXISTS (SELECT 1 FROM cloud_machines m WHERE m.id = machine_endpoints.machine_id)
      AND NOT EXISTS (SELECT 1 FROM cloud_homes h WHERE h.id = machine_endpoints.machine_id))
  )`;

/** Tunnel and DNS cleanup for machines whose state forbids service: a home
 *  that is stopped, suspended (includes quarantine), deleting, deleted or
 *  failed, a fenced or otherwise non-active machine, or a machine row that no
 *  longer exists. Same bounded exponential backoff as the desktop sweep. */
export async function sweepMachineEndpointCleanup(
  env: Env,
  config: ControlPlaneConfig,
  fetcher: CloudflareFetch,
  requestId: string,
  limit: number,
): Promise<number> {
  const now = Date.now();
  const candidates = await env.DB.prepare(
    `SELECT e.machine_id, e.cleanup_attempts, e.delete_requested_at, e.last_error_code
       FROM machine_endpoints e
       LEFT JOIN cloud_machines m ON m.id = e.machine_id
       LEFT JOIN cloud_homes h ON h.id = e.machine_id
      WHERE e.status != 'deleted'
        AND (
          (e.status = 'deleting' AND ${deleteRequestCurrentSql("e.delete_resource_generation", "h.resource_generation")})
          OR (h.id IS NOT NULL
              AND h.desired_state IN ('stopped', 'suspended', 'deleting', 'deleted', 'failed', 'expired'))
          OR (m.id IS NOT NULL AND m.state NOT IN ('active', 'pending_binding'))
          OR (m.id IS NULL AND h.id IS NULL)
        )
        AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= ?)
        AND (
          e.cleanup_attempts = 0
          OR e.last_cleanup_attempt_at IS NULL
          OR e.last_cleanup_attempt_at <= CASE
            WHEN e.cleanup_attempts = 1 THEN ?
            WHEN e.cleanup_attempts = 2 THEN ?
            WHEN e.cleanup_attempts = 3 THEN ?
            WHEN e.cleanup_attempts = 4 THEN ?
            ELSE ?
          END
        )
      ORDER BY COALESCE(e.delete_requested_at, e.last_cleanup_attempt_at, e.updated_at) ASC,
               e.machine_id ASC
      LIMIT ?`,
  ).bind(
    now,
    now - CLEANUP_BACKOFF_1_MS,
    now - CLEANUP_BACKOFF_2_MS,
    now - CLEANUP_BACKOFF_3_MS,
    now - CLEANUP_BACKOFF_4_MS,
    now - CLEANUP_BACKOFF_MAX_MS,
    limit,
  ).all<{ machine_id: string }>();

  await Promise.all(candidates.results.map(async (candidate) => {
    try {
      await cleanupEndpointForMachine(env, config, candidate.machine_id, fetcher, requestId);
    } catch {
      console.error(JSON.stringify({
        message: "machine endpoint cleanup candidate failed",
        requestId,
        errorCode: "endpoint_internal",
      }));
    }
  }));
  return candidates.results.length;
}

// ---------------------------------------------------------------------------
// Round 8c: a home given up on and set up again by a new payment (b3-control reopenGivenUp).
// A home has ONE endpoint row for its whole life (machine_id is the key; the hostname, allocated at reserve, is the home's public origin
// and never changes; the tunnel name is stable too). So a new resource generation never gets a second row: it reuses the home's row once
// the old generation's tunnel and DNS record are gone. The rule: the reopen waits until the row is RELEASED (absent, never claimed
// 'pending', or 'deleted' with no Cloudflare ids and no lease), and in the same batch that opens the new generation the row goes back to
// 'pending'; the new machine's ordinary claim then creates a new tunnel and a new CNAME under the same name and hostname. The old tunnel
// and record are deleted once, by the one cleanup sweep that owns them (deleteClaim), and the hostname is taken again only after that
// deletion released it: no window in which two tunnels answer for it, and never the old tunnel serving the new generation.
// ---------------------------------------------------------------------------

/** True (SQL) when the home `?`'s endpoint row is NOT released: a reopen must wait for its cleanup. */
export const MACHINE_ENDPOINT_HELD_SQL = `EXISTS (SELECT 1 FROM machine_endpoints e WHERE e.machine_id = ?
  AND (e.status NOT IN ('pending', 'deleted') OR e.tunnel_id IS NOT NULL OR e.dns_record_id IS NOT NULL OR e.lease_owner IS NOT NULL))`;

/** Give-up: a row never claimed ('pending', no Cloudflare ids) has nothing at Cloudflare to delete, so it is marked 'deleted' at once
 *  (the row and its hostname stay: the home keeps its public origin should a new payment set it up again). */
export function releaseUnclaimedMachineEndpoint(db: D1Database, machineId: string, now: number): D1PreparedStatement {
  return db.prepare(`UPDATE machine_endpoints SET status='deleted',delete_requested_at=COALESCE(delete_requested_at,?),updated_at=?
    WHERE machine_id=? AND status='pending' AND tunnel_id IS NULL AND dns_record_id IS NULL AND lease_owner IS NULL`).bind(now, now, machineId);
}

/** Reopen, inside its fenced batch: a released row goes back to 'pending' for the new generation (same hostname and tunnel name, cleanup
 *  bookkeeping reset). A row that is not released is left as it is; the caller's guard (MACHINE_ENDPOINT_HELD_SQL) then aborts the batch. */
export function reopenMachineEndpoint(db: D1Database, machineId: string, now: number): D1PreparedStatement {
  return db.prepare(`UPDATE machine_endpoints SET status='pending',delete_requested_at=NULL,cleanup_attempts=0,last_cleanup_attempt_at=NULL,
      last_error_code=NULL,token_roll_due=0,delete_resource_generation=NULL,updated_at=?
    WHERE machine_id=? AND status='deleted' AND tunnel_id IS NULL AND dns_record_id IS NULL AND lease_owner IS NULL`).bind(now, machineId);
}

/** A row deleted outright by a give-up of an earlier build (it deleted never-claimed rows) is restored for the reopen from the home's
 *  reserved origin, when that origin is a managed cloud-home hostname (h-<32 hex>.<the cloud-home suffix>): same hostname, the tunnel name
 *  it was allocated with. Null for a home that never had a managed endpoint. */
export function restoreMachineEndpoint(db: D1Database, machineId: string, publicOrigin: string, hostSuffix: string | null,
  now: number): D1PreparedStatement | null {
  if (!hostSuffix) return null;
  let host: string;
  try { host = new URL(publicOrigin).hostname; } catch { return null; }
  const match = /^h-([0-9a-f]{32})\.(.+)$/.exec(host);
  if (!match || match[2] !== hostSuffix) return null;
  return db.prepare(`INSERT INTO machine_endpoints (machine_id,hostname,tunnel_name,status,created_at,updated_at)
    VALUES (?,?,?,'pending',?,?) ON CONFLICT DO NOTHING`).bind(machineId, host, `murage-${MACHINE_KIND.prefix}-${match[1]}`, now, now);
}

/** The endpoint row exactly as a reopen observed it: the cleanup it asks for is a compare-and-set on all of it. */
export interface ObservedMachineEndpoint { status: string; generation: number; tunnel_id: string | null; dns_record_id: string | null }

/** A reopen waiting on the old endpoint's cleanup asks for it now: a row still serving or failed is marked 'deleting', and a cleanup
 *  backed off for more than CLEANUP_BACKOFF_1_MS is due again at the next sweep (so a paying customer waits at most one backoff step, and
 *  Cloudflare sees at most one attempt per that interval). A leased row (a cleanup in flight) is left alone.
 *  Astra MAILRETRY-13 P1-2: the request is a compare-and-set on the row as the reopen observed it (status, lease generation, tunnel and DNS
 *  ids) and on the home still being at the resource generation it asks the cleanup for (`resourceGeneration`), which it records on the row
 *  (delete_resource_generation). A stale pass (the old endpoint was deleted since its read, another pass re-opened the home and the new
 *  generation's machine claimed the row: a new lease generation, a new tunnel) writes nothing, so the new generation's endpoint is never
 *  marked for deletion; and the sweep honours a 'deleting' row only while the home is still at the generation the request named. */
export async function expediteMachineEndpointCleanup(env: Env, machineId: string, observed: ObservedMachineEndpoint, resourceGeneration: number,
  now: number): Promise<void> {
  await env.DB.prepare(`UPDATE machine_endpoints SET status='deleting',delete_requested_at=COALESCE(delete_requested_at,?),
      last_cleanup_attempt_at=CASE WHEN last_cleanup_attempt_at<=? THEN NULL ELSE last_cleanup_attempt_at END,
      delete_resource_generation=?,updated_at=?
    WHERE machine_id=? AND (lease_expires_at IS NULL OR lease_expires_at<=?)
      AND (status IN ('provisioning','ready','error','deleting')
        OR (status='pending' AND (tunnel_id IS NOT NULL OR dns_record_id IS NOT NULL)))
      AND status=? AND generation=? AND tunnel_id IS ? AND dns_record_id IS ?
      AND (delete_resource_generation IS NULL OR delete_resource_generation=?)
      AND EXISTS (SELECT 1 FROM cloud_homes h WHERE h.id=machine_endpoints.machine_id AND h.resource_generation=?)`)
    .bind(now, now - CLEANUP_BACKOFF_1_MS, resourceGeneration, now, machineId, now,
      observed.status, observed.generation, observed.tunnel_id, observed.dns_record_id, resourceGeneration, resourceGeneration).run();
}

/** Binds nothing. A deletion request (`requested`: the resource generation it was made for; NULL on every path that names none) is still
 *  current while the home (`current`: its resource generation; NULL when the home row is gone) has not moved past that generation. */
function deleteRequestCurrentSql(requested: string, current: string): string {
  return `(${requested} IS NULL OR ${requested} >= COALESCE(${current}, 0))`;
}
