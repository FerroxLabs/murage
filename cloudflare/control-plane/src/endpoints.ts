import { CloudflareAPI, CloudflareAPIError, type CloudflareFetch } from "./cloudflare-api";
import type { ControlPlaneConfig } from "./config";
import { errorResponse, HTTPError, json } from "./http";
import { requireInstallation } from "./installations";

type EndpointStatus = "pending" | "provisioning" | "ready" | "deleting" | "deleted" | "error";

interface EndpointRow {
  installation_id: string;
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
  created_at: number;
  updated_at: number;
}

interface ClaimedEndpoint {
  leaseOwner: string;
  row: EndpointRow;
}

const LEASE_MS = 60_000;
const ENDPOINT_ACTION_WINDOW_MS = 60 * 60 * 1_000;
const ENDPOINT_RECONCILE_LIMIT = 20;
const ENDPOINT_DELETE_LIMIT = 30;
const CLEANUP_SWEEP_LIMIT = 8;

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

async function endpointRow(env: Env, installationId: string): Promise<EndpointRow | null> {
  return env.DB.prepare(
    `SELECT installation_id, hostname, tunnel_name, tunnel_id, dns_record_id,
            status, generation, lease_owner, lease_expires_at,
            last_reconciled_at, delete_requested_at, last_error_code,
            created_at, updated_at
       FROM installation_endpoints
      WHERE installation_id = ?`,
  ).bind(installationId).first<EndpointRow>();
}

async function ensureEndpointRow(
  env: Env,
  installationId: string,
  hostSuffix: string,
): Promise<EndpointRow> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const opaque = randomHex(16);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO installation_endpoints
        (installation_id, hostname, tunnel_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).bind(installationId, `c-${opaque}.${hostSuffix}`, `omb-c-${opaque}`, now, now).run();
    const row = await endpointRow(env, installationId);
    if (row) return row;
  }
  throw new EndpointOperationError("endpoint_reservation_failed");
}

async function enforceEndpointRateLimit(
  env: Env,
  installationId: string,
  action: "delete_endpoint" | "reconcile_endpoint",
): Promise<void> {
  const now = Date.now();
  const cutoff = now - ENDPOINT_ACTION_WINDOW_MS;
  const limit = action === "reconcile_endpoint" ? ENDPOINT_RECONCILE_LIMIT : ENDPOINT_DELETE_LIMIT;
  const result = await env.DB.prepare(
    `INSERT INTO installation_action_rate_limits
      (installation_id, action, window_started_at, attempts, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(installation_id, action) DO UPDATE SET
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
  ).bind(installationId, action, now, now, cutoff, cutoff, cutoff, limit).run();
  if (result.meta.changes === 0) throw new HTTPError(429, "rate_limited");
}

async function claimEndpoint(
  env: Env,
  row: EndpointRow,
  nextStatus: "deleting" | "provisioning",
): Promise<ClaimedEndpoint | null> {
  const now = Date.now();
  const leaseOwner = crypto.randomUUID();
  const deletingGuard = nextStatus === "provisioning" ? "AND status != 'deleting'" : "";
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET status = ?, generation = generation + 1,
            lease_owner = ?, lease_expires_at = ?, updated_at = ?,
            delete_requested_at = CASE WHEN ? = 'deleting' THEN COALESCE(delete_requested_at, ?) ELSE NULL END,
            last_error_code = NULL
      WHERE installation_id = ?
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ${deletingGuard}`,
  ).bind(
    nextStatus,
    leaseOwner,
    now + LEASE_MS,
    now,
    nextStatus,
    now,
    row.installation_id,
    now,
  ).run();
  if (result.meta.changes === 0) return null;
  const claimed = await endpointRow(env, row.installation_id);
  if (!claimed || claimed.lease_owner !== leaseOwner) {
    throw new EndpointOperationError("lease_lost");
  }
  return { leaseOwner, row: claimed };
}

async function updateClaimedResources(
  env: Env,
  claim: ClaimedEndpoint,
  tunnelId: string | null,
  dnsRecordId: string | null,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET tunnel_id = ?, dns_record_id = ?, updated_at = ?
      WHERE installation_id = ? AND generation = ? AND lease_owner = ?`,
  ).bind(
    tunnelId,
    dnsRecordId,
    Date.now(),
    claim.row.installation_id,
    claim.row.generation,
    claim.leaseOwner,
  ).run();
  if (result.meta.changes === 0) throw new EndpointOperationError("lease_lost");
  claim.row.tunnel_id = tunnelId;
  claim.row.dns_record_id = dnsRecordId;
}

async function finishClaim(
  env: Env,
  claim: ClaimedEndpoint,
  status: "deleted" | "ready",
): Promise<EndpointRow> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
            last_reconciled_at = ?, last_error_code = NULL, updated_at = ?
      WHERE installation_id = ? AND generation = ? AND lease_owner = ?`,
  ).bind(status, now, now, claim.row.installation_id, claim.row.generation, claim.leaseOwner).run();
  if (result.meta.changes === 0) throw new EndpointOperationError("lease_lost");
  const row = await endpointRow(env, claim.row.installation_id);
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
    `UPDATE installation_endpoints
        SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = ?, updated_at = ?
      WHERE installation_id = ? AND generation = ? AND lease_owner = ?`,
  ).bind(
    preserveDeleting ? "deleting" : "error",
    code.slice(0, 64),
    Date.now(),
    claim.row.installation_id,
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

async function reconcileClaim(
  env: Env,
  config: ControlPlaneConfig,
  claim: ClaimedEndpoint,
  fetcher: CloudflareFetch,
): Promise<{ connectorToken: string; row: EndpointRow }> {
  const api = new CloudflareAPI(config.cloudflare, fetcher);
  let tunnelId = claim.row.tunnel_id;
  let dnsRecordId = claim.row.dns_record_id;
  let createdTunnel = false;
  let createdDNSRecord = false;

  try {
    const tunnels = await api.listTunnels(claim.row.tunnel_name);
    if (tunnels.length > 1) throw new EndpointOperationError("tunnel_name_conflict");
    if (tunnels.length === 1) {
      if (tunnelId && tunnelId !== tunnels[0]?.id) {
        throw new EndpointOperationError("tunnel_id_conflict");
      }
      tunnelId = tunnels[0]?.id ?? null;
    } else {
      const tunnel = await api.createTunnel(claim.row.tunnel_name);
      tunnelId = tunnel.id;
      createdTunnel = true;
    }
    if (!tunnelId) throw new EndpointOperationError("tunnel_missing");
    await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
    await api.configureTunnel(tunnelId, claim.row.hostname);

    const target = `${tunnelId}.cfargotunnel.com`;
    const records = await api.listDNSRecords(claim.row.hostname);
    if (records.length > 1) throw new EndpointOperationError("dns_record_conflict");
    const existing = records[0];
    if (existing) {
      if (existing.content.toLowerCase() !== target && existing.id !== dnsRecordId) {
        throw new EndpointOperationError("dns_record_conflict");
      }
      const record = existing.proxied && existing.content.toLowerCase() === target
        ? existing
        : await api.updateDNSRecord(existing.id, claim.row.hostname, tunnelId);
      dnsRecordId = record.id;
    } else {
      const record = await api.createDNSRecord(claim.row.hostname, tunnelId);
      dnsRecordId = record.id;
      createdDNSRecord = true;
    }
    await updateClaimedResources(env, claim, tunnelId, dnsRecordId);

    const connectorToken = await api.getConnectorToken(tunnelId);
    const row = await finishClaim(env, claim, "ready");
    return { connectorToken, row };
  } catch (error) {
    const operationCode = errorCode(error);

    if (createdDNSRecord && dnsRecordId) {
      try {
        await api.deleteDNSRecord(dnsRecordId);
        dnsRecordId = null;
      } catch {
        // Preserve the record ID below so a later request can finish cleanup.
      }
    }
    if (createdTunnel && tunnelId) {
      try {
        await api.deleteTunnel(tunnelId);
        tunnelId = null;
      } catch {
        // Preserve the tunnel ID below so a later request can reconcile it.
      }
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
  const api = new CloudflareAPI(config.cloudflare, fetcher);
  let tunnelId = claim.row.tunnel_id;
  let dnsRecordId = claim.row.dns_record_id;

  try {
    if (!tunnelId) {
      const tunnels = await api.listTunnels(claim.row.tunnel_name);
      if (tunnels.length > 1) throw new EndpointOperationError("tunnel_name_conflict");
      tunnelId = tunnels[0]?.id ?? null;
      if (tunnelId) await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
    }
    if (!dnsRecordId) {
      const records = await api.listDNSRecords(claim.row.hostname);
      if (records.length > 1) throw new EndpointOperationError("dns_record_conflict");
      const record = records[0];
      if (record) {
        if (!tunnelId || record.content.toLowerCase() !== `${tunnelId}.cfargotunnel.com`) {
          throw new EndpointOperationError("dns_record_conflict");
        }
        dnsRecordId = record.id;
        await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
      }
    }

    if (dnsRecordId) {
      await api.deleteDNSRecord(dnsRecordId);
      dnsRecordId = null;
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
    }
    if (tunnelId) {
      await api.deleteTunnel(tunnelId);
      tunnelId = null;
      await updateClaimedResources(env, claim, tunnelId, dnsRecordId);
    }
    await finishClaim(env, claim, "deleted");
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
  const row = await endpointRow(env, installation.installation_id);
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
    const result = await reconcileClaim(env, config, claim, fetcher);
    return json({ endpoint: endpointJSON(result.row), connectorToken: result.connectorToken });
  } catch (error) {
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
  const row = await endpointRow(env, installation.installation_id);
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
  const row = await endpointRow(env, installationId);
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
  const candidates = await env.DB.prepare(
    `SELECT e.installation_id
       FROM installation_endpoints e
       LEFT JOIN installations i ON i.id = e.installation_id
      WHERE e.status != 'deleted'
        AND (
          e.status = 'deleting'
          OR i.revoked_at IS NOT NULL
          OR i.id IS NULL
        )
        AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= ?)
      ORDER BY e.updated_at ASC, e.installation_id ASC
      LIMIT ?`,
  ).bind(Date.now(), CLEANUP_SWEEP_LIMIT).all<{ installation_id: string }>();

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
  return candidates.results.length;
}
