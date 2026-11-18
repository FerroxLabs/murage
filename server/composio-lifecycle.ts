// Owners: composio-429-e owns this transport adapter and its desktop/cloud authority.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createComposioLifecycle, type ComposioLifecycle, type LifecycleConfiguration, type AdmissionStatus, type LifecycleResult } from "../electron/composio-lifecycle.mjs";
import { readComposioCustody } from "../electron/managed-composio.mjs";
import { createComposioAdmissionStore } from "../electron/composio-admission-store.mjs";
import { accountedFetch, accountedResponse, reserveUpstreamRequest } from "./memory/upstream-reader.ts";
import { authorizeFluxDispatch } from "./flux-start-gate.ts";
import { isFluxHost } from "./flux-usage-tags.ts";
import { fluxFetch } from "./flux-memory-headers.ts";
import { upstreamBackoffRandom } from "./upstream-backoff.ts";
import { brokerTokenFingerprint } from "../electron/flux-composio-token.mjs";
import { DATA_DIR } from "./config.ts";

interface PrivatePort { postMessage(message: object): void }
let port: PrivatePort | null = null;
let generation: string | null = null;
let required = process.env.MURAGE_DESKTOP_PARENT === "1" || process.env.MURAGE_CLOUD_ROLE === "home";
let remoteStatus: AdmissionStatus | undefined;
let config: () => LifecycleConfiguration = () => ({ fluxBrokerUrl: process.env.MURAGE_FLUX_COMPOSIO_BROKER_URL, legacyBrokerUrl: process.env.MURAGE_COMPOSIO_BROKER_URL, prepareLegacy: false });
let custody: { get(): Record<string, unknown>; readDurable?(): Promise<Record<string, unknown>>; save(next: Record<string, unknown>, snapshot: Record<string, unknown>, delta?: import("../electron/composio-lifecycle.mjs").CustodyDelta[]): Promise<boolean | void> } = { get: () => ({}), save: async () => false };
let local: ComposioLifecycle | undefined;
let fixtureRuntime = false;
let fixtureRecords: Parameters<NonNullable<Parameters<typeof createComposioLifecycle>[0]["store"]>["save"]>[0] = [];
interface Pending {
  generation: string;
  url: string;
  permit(): void;
  finish(status: LifecycleResult): void;
  cancel(): void;
  permitted: boolean;
}
const pending = new Map<string, Pending>();
// Route receipts are advisory retry timing only. Every actual attempt still
// asks the owning parent for a fresh permit.
const routeStatus = new Map<string, AdmissionStatus>();
const dispatchObserver = new AsyncLocalStorage<{ beforeDispatch?: () => void }>();

// Called once by the owning runtime's composition, never by a request caller.
export function configureComposioLifecycle(getConfiguration: () => LifecycleConfiguration): void { config = getConfiguration; }
export function configureComposioTokenCustody(value: typeof custody): void { custody = value; }
const saveProtectedCleanup: NonNullable<Parameters<typeof createComposioLifecycle>[0]["savePendingRevocations"]> = async (entries, delta) => {
  const current = custody.get(); if (await custody.save({ ...current, composioPendingRevocations: JSON.stringify(entries) }, current, delta) === false) throw new Error("credential_recovery_failed");
  if (custody.readDurable) return readComposioCustody((await custody.readDurable()).composioPendingRevocations);
};
export function localComposioAuthority(bootstrap?: { fetchImpl?: typeof fetch; now?: () => number; configuration?: LifecycleConfiguration }): ComposioLifecycle {
  if (required) throw new Error("admission_parent_required");
  return local ??= createComposioLifecycle({
    getConfiguration: () => {
      const current = config();
      return { ...bootstrap?.configuration, ...current, prepareLegacy: false,
        fluxBrokerUrl: current.fluxBrokerUrl || bootstrap?.configuration?.fluxBrokerUrl,
        legacyBrokerUrl: current.legacyBrokerUrl || bootstrap?.configuration?.legacyBrokerUrl };
    }, getCredentials: () => custody.get(),
    requireDurableCustody: true, readDurableCredentials: async () => { if (!custody.readDurable) throw new Error("credential_recovery_failed"); return custody.readDurable(); },
    saveCredentials: (next, snapshot) => custody.save(next, snapshot),
    store: fixtureRuntime ? { load: () => structuredClone(fixtureRecords), save: rows => { fixtureRecords = structuredClone(rows); } } : createComposioAdmissionStore(DATA_DIR), policy: "dev",
    pendingRevocationsVersion: () => custody.get().composioPendingRevocations,
    getPendingRevocations: () => readComposioCustody(custody.get().composioPendingRevocations),
    savePendingCredentialWrite: saveProtectedCleanup,
    savePendingRevocations: saveProtectedCleanup,
    beforeTransport: prepareTransport, onDispatch: commitDispatch, random: operation => operation === "lifecycle" ? Math.random() : upstreamBackoffRandom(),
    now: bootstrap?.now, monotonic: bootstrap?.now ?? (fixtureRuntime ? () => Date.now() : undefined),
    transport: (url, init) => dispatchTransport(url, init, bootstrap?.fetchImpl),
    lifecycleTransport: (url, init) => dispatchTransport(url, init, bootstrap?.fetchImpl),
  });
}
async function prepareTransport(url: string): Promise<void> {
  if (isFluxHost(url) || new URL(url).pathname.endsWith("/v1/tokens")) await authorizeFluxDispatch();
}
function commitDispatch(_url: string, init?: RequestInit): void {
  reserveUpstreamRequest(typeof init?.body === "string" ? Buffer.byteLength(init.body) : 0);
  dispatchObserver.getStore()?.beforeDispatch?.();
}
function dispatchTransport(input: Parameters<typeof fetch>[0], init?: RequestInit, fetchImpl?: typeof fetch): Promise<Response> {
  const url = String(input);
  const send: typeof fetch = fetchImpl ? (target, options) => fetchImpl(target, options).then(response => accountedResponse(response, true)) : accountedFetch;
  // Flux Memory: a broker call is background work, never an owner turn.
  return isFluxHost(url) ? fluxFetch("composio-broker", url, init, send) : send(input, init);
}
export function connectComposioAuthority(value: PrivatePort | null): void {
  disconnectComposioAuthority();
  required = true; port = value;
  port?.postMessage({ type: "murage:connected-apps-admission-hello" });
}
export function disconnectComposioAuthority(): void {
  for (const item of pending.values()) item.cancel();
  pending.clear(); routeStatus.clear(); remoteStatus = undefined; port = null; generation = null;
}
export function receiveComposioAdmission(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  if (!String(m.type).startsWith("murage:connected-apps-admission-")) return false;
  if (m.type === "murage:connected-apps-admission-generation" && typeof m.generation === "string") {
    if (generation !== m.generation) { routeStatus.clear(); remoteStatus = undefined; for (const item of pending.values()) item.cancel(); pending.clear(); }
    generation = m.generation; return true;
  }
  if (m.generation !== generation || typeof m.requestId !== "string") return true;
  const item = pending.get(m.requestId);
  if (!item || item.generation !== generation) return true;
  if (m.type === "murage:connected-apps-admission-permit" && !item.permitted) { item.permitted = true; item.permit(); }
  if (m.type === "murage:connected-apps-admission-result" && ["completed", "held", "deferred", "failed"].includes(String(m.outcome))) {
    const status: AdmissionStatus = { outcome: m.outcome as AdmissionStatus["outcome"], reason: String(m.reason ?? "unavailable"), attempted: m.attempted === true,
      ...(typeof m.retryAt === "number" ? { retryAt: m.retryAt } : {}), ...(typeof m.status === "number" ? { status: m.status } : {}) };
    remoteStatus = status;
    if (routeStatus.size >= 256 && !routeStatus.has(item.url)) routeStatus.delete(routeStatus.keys().next().value!);
    routeStatus.set(item.url, status);
    item.finish({ ...status, ...(typeof m.reconnected === "boolean" ? { reconnected: m.reconnected } : {}) });
  }
  return true;
}
export function applyComposioAdmissionStatus(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const v = value as AdmissionStatus;
  if (["held", "completed", "deferred", "failed"].includes(v.outcome) && typeof v.reason === "string"
    && (v.retryAt === undefined || Number.isFinite(v.retryAt))) remoteStatus = { ...v, attempted: false };
}
export function composioAdmissionStatus(url?: string): AdmissionStatus {
  // Parent projections are owner-visible state, not route admission. A child
  // must ask the authority for each operation's centrally computed scope.
  if (required && url) {
    const receipt = routeStatus.get(url);
    return receipt?.retryAt && receipt.retryAt > Date.now() ? { ...receipt, attempted: false }
      : { outcome: "completed", reason: "authority_required", attempted: false };
  }
  if (required && remoteStatus?.retryAt && remoteStatus.retryAt <= Date.now()) return { outcome: "completed", reason: "ready", attempted: false };
  if (required) return remoteStatus ?? { outcome: "deferred", reason: "admission_port_unavailable", attempted: false };
  return localComposioAuthority().inspect(url);
}
/** Only an explicit owner action resets the protected recovery episode. */
export async function retryComposioRecovery(): Promise<LifecycleResult> {
  if (!required) return localComposioAuthority().request({ operation: "reconnect", force: true, retryRecovery: true });
  if (!port || !generation || pending.size >= 200) return { outcome: "deferred", reason: "admission_port_unavailable", attempted: false, reconnected: false };
  const requestId = randomUUID(), boundGeneration = generation, boundPort = port;
  let finish!: (result: LifecycleResult) => void;
  const result = new Promise<LifecycleResult>(resolve => { finish = resolve; });
  const cancel = () => finish({ outcome: "failed", reason: "credential_recovery_failed", attempted: false, reconnected: false });
  pending.set(requestId, { generation: boundGeneration, url: "recovery", permit() {}, finish, cancel, permitted: false });
  const timer = setTimeout(cancel, 31_000); timer.unref?.();
  try {
    boundPort.postMessage({ type: "murage:connected-apps-admission-request", requestId, generation: boundGeneration, operation: "recovery-retry" });
    return await result;
  } finally { clearTimeout(timer); pending.delete(requestId); }
}

function heldResponse(status: AdmissionStatus): Response {
  return Response.json({ error: "Connected apps are waiting to retry.", ...status }, { status: status.status === 429 ? 429 : 503,
    headers: { "x-connected-apps-admission": "held", ...(status.retryAt ? { "retry-after": String(Math.max(0, Math.ceil((status.retryAt - Date.now()) / 1000))) } : {}) } });
}

/** The sole server broker transport: every retry calls this again. */
export function composioFetch(input: string | URL, init?: RequestInit, beforeDispatch?: () => void): Promise<Response> {
  return dispatchObserver.run({ beforeDispatch }, () => requestServerBroker(input, init));
}
async function requestServerBroker(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "");
  const tokenFingerprint = bearer ? brokerTokenFingerprint(bearer) : undefined;
  if (!required) {
    const result = await localComposioAuthority().request({ operation: "broker", url, init, tokenFingerprint });
    return result.response ?? heldResponse(result);
  }
  if (!port || !generation || pending.size >= 200) return heldResponse({ outcome: "deferred", reason: "admission_port_unavailable", attempted: false });
  await prepareTransport(url);
  if (!port || !generation || pending.size >= 200) return heldResponse({ outcome: "deferred", reason: "admission_capacity", attempted: false });
  const boundPort = port, boundGeneration = generation;
  const requestId = randomUUID();
  let permit!: () => void, finish!: (status: AdmissionStatus) => void;
  let status: AdmissionStatus | undefined;
  const permission = new Promise<void>(resolve => { permit = resolve; });
  const result = new Promise<AdmissionStatus>(resolve => { finish = value => { status = value; resolve(value); permit(); }; });
  const cancel = () => finish({ outcome: "deferred", reason: "admission_port_unavailable", attempted: false });
  pending.set(requestId, { generation: boundGeneration, url, permit, finish, cancel, permitted: false });
  const timer = setTimeout(cancel, 330_000); timer.unref?.();
  try {
    boundPort.postMessage({ type: "murage:connected-apps-admission-request", requestId, generation: boundGeneration, url, tokenFingerprint, method: (init?.method ?? "GET").toUpperCase() });
    await permission;
    if (status || port !== boundPort || generation !== boundGeneration || !pending.get(requestId)?.permitted) return heldResponse(status ?? { outcome: "deferred", reason: "admission_port_unavailable", attempted: false });
    // Recheck request-owned memory budget synchronously after the private-port await.
    try { commitDispatch(url, init); }
    catch (error) {
      boundPort.postMessage({ type: "murage:connected-apps-admission-receipt", requestId, generation: boundGeneration, status: 0, delivery: "not-sent" });
      await result; throw error;
    }
    let response: Response;
    try { response = await dispatchTransport(url, init); }
    catch (error) {
      boundPort.postMessage({ type: "murage:connected-apps-admission-receipt", requestId, generation: boundGeneration, status: 0 });
      await result; throw error;
    }
    boundPort.postMessage({ type: "murage:connected-apps-admission-receipt", requestId, generation: boundGeneration, status: response.status, retryAfter: response.headers.get("retry-after") });
    await result;
    return response;
  } finally { clearTimeout(timer); pending.delete(requestId); }
}

/** Explicit fixture/workspace reset; credential replacement never calls this. */
export function resetComposioLifecycleForTests(): void {
  local?.dispose(); local = undefined; remoteStatus = undefined; fixtureRuntime = true; fixtureRecords = [];
  disconnectComposioAuthority();
  required = process.env.MURAGE_DESKTOP_PARENT === "1" || process.env.MURAGE_CLOUD_ROLE === "home";
}
