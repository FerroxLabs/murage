import { wipeHomeEngineSignIns } from "./b1b-recovery.ts";
import { cloudHomeCopy } from "./copy.ts";
import { randomUUID } from "node:crypto";
import { ensureFluxComposioBrokerToken, fluxKeyFingerprint, revokeFluxComposioBrokerToken } from "../../electron/flux-composio-token.mjs";
import { fluxComposioBrokerUrl, fluxComposioAccess } from "../../electron/managed-composio.mjs";
import type { SealedSecretStore } from "./secrets.ts";
import { cloudCredentialPatch } from "./credentials.ts";
import { updateServerCredentials } from "./server-secrets.ts";
import { cleanupCloudBrowser } from "./browser-process.ts";
import { connectedAppsCredentials, connectedAppsPatch, isGenericCredentialPatch, PENDING_REVOKE_MAX, pendingRevokes, pendingRevokesPatch, serverCredentialProjection } from "./credential-projection.ts";
import { createCloudModelSignInClient, cloudModelCancel, cloudModelRequest } from "./model-signin-wire.ts";
import type { createHomeModelSignIn } from "./model-signin.ts";

export const CLOUD_PRIVATE_MESSAGE_TYPES = [
  "murage:browser-bot-deleted", "murage:browser-profile-deleted", "murage:browser-control",
  "murage:desktop-secret", "murage:flux-composio-token-rejected",
  "murage:mcp-token-rejected", "murage:mcp-secrets-stale", "murage:mcp-secrets-renamed",
  "murage:model-signin-refresh",
  "murage:cloud-model-signin-request", "murage:cloud-model-signin-cancel-owner", "murage:cloud-model-signin-ready",
] as const;

type Sender = (message: object) => void;
type RecordValue = Record<string, unknown>;
/** Which Flux key, by the same fingerprint the broker token records ("" for none). */
function fluxKeyPrint(key: string | undefined): string { return key?.trim() ? fluxKeyFingerprint(key.trim()) : ""; }
function messageRecord(value: unknown): RecordValue | null { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null; }

export function createSupervisorPort(options: {
  store: Pick<SealedSecretStore, "getAll" | "patch">;
  send: Sender;
  remintConnectedApps?: (credentials: Record<string, string>, options: { force: boolean }) => Promise<Record<string, string>>;
  wipeEngineSignIns?: () => Promise<void>;
  cleanupBrowser?: (bot: string) => Promise<void>;
  now?: () => number;
  modelSignIn?: ReturnType<typeof createHomeModelSignIn>;
  generation?: () => number;
  onModelReady?: () => void;
  /** Test seam: best-effort revoke of the broker token a replaced Flux key minted. */
  revokeBrokerToken?: (fluxBrokerUrl: string, token: string) => Promise<unknown>;
  /** Test seam: waits between mint retries after a failed mint; the last entry repeats. */
  mintRetryDelaysMs?: number[];
}) {
  let chain = Promise.resolve();
  let disposed = false;
  let lastForcedRemint = Number.NEGATIVE_INFINITY;
  const refuse = (message: RecordValue, text: string) => options.send({ type: "murage:cloud-refused", requestId: message.requestId, operation: message.type, error: text });
  const remint = async (force: boolean) => {
    if (disposed) return;
    if (force) {
      const now = (options.now ?? (() => performance.now()))();
      if (now - lastForcedRemint < 10 * 60 * 1_000) return;
      // Reserve the attempt before awaiting the broker, including failures.
      lastForcedRemint = now;
    }
    const previous = connectedAppsCredentials(options.store.getAll());
    const url = fluxComposioBrokerUrl(process.env, { packaged: true });
    const next = options.remintConnectedApps
      ? await options.remintConnectedApps(previous, { force })
      : await ensureFluxComposioBrokerToken({ fluxBrokerUrl: url, credentials: previous, fluxKey: previous.fluxApiKey, force, label: "murage-cloud", log: () => {} });
    if (disposed || options.store.getAll().fluxApiKey !== previous.fluxApiKey) return;
    const credentials = serverCredentialProjection(options.store.patch(connectedAppsPatch(next)));
    options.send({ type: "murage:cloud-credentials", credentials });
    sendManagedComposio(url, credentials);
    if (credentials.fluxComposioBrokerToken) drainPendingRevoke();
  };
  // A mint that failed leaves no token, and nothing else re-mints on its own, so
  // retry on a backoff (off the write chain) until a token is stored.
  let retrying = false;
  const retryMint = () => {
    if (retrying || disposed) return;
    retrying = true;
    const delays = options.mintRetryDelaysMs?.length ? options.mintRetryDelaysMs : [15_000, 30_000, 60_000, 120_000, 300_000];
    void (async () => {
      try {
        for (let attempt = 0; !disposed; attempt++) {
          await new Promise<void>(resolve => { const t = setTimeout(resolve, delays[Math.min(attempt, delays.length - 1)]); t.unref?.(); });
          const now = options.store.getAll();
          if (disposed || !now.fluxApiKey || now.fluxComposioBrokerToken) return;
          const run = chain.then(() => remint(false));
          chain = run.catch(() => {});
          try { await run; } catch { /* retry on the next tick */ }
          if (options.store.getAll().fluxComposioBrokerToken) return;
        }
      } finally { retrying = false; }
    })();
  };
  // Replaced Flux keys' broker tokens are kept sealed (never sent to the server)
  // until Flux confirms each revoke, so a crash or outage cannot lose them.
  let draining = false;
  const revokeToken = (url: string, token: string) =>
    (options.revokeBrokerToken ?? ((fluxBrokerUrl: string, t: string) => revokeFluxComposioBrokerToken({ fluxBrokerUrl, token: t })))(url, token);
  const drainPendingRevoke = () => {
    if (disposed || draining || !pendingRevokes(options.store.getAll()).length) return;
    draining = true;
    void (async () => {
      try {
        for (const token of pendingRevokes(options.store.getAll())) {
          if (disposed) return;
          let ok = false;
          try { ok = Boolean(await revokeToken(fluxComposioBrokerUrl(process.env, { packaged: true }), token)); } catch { /* this entry stays for the next drain */ }
          // Clear only this entry, and only once its own revoke is confirmed.
          if (ok) options.store.patch(pendingRevokesPatch(pendingRevokes(options.store.getAll()).filter(t => t !== token)));
        }
      } catch { /* sealed store unavailable: retried on the next start or successful mint */ }
      finally { draining = false; }
    })();
  };
  const sendManagedComposio = (url: string, credentials: Record<string, string>) =>
    options.send({ type: "murage:managed-composio", fluxAccess: fluxComposioAccess(url, credentials), fluxBrokerUrl: url, accountKind: credentials.fluxComposioAccountKind, access: null, legacyUntil: "" });
  const dispatch = async (input: unknown, generation: number) => {
    if (disposed || generation !== (options.generation?.() ?? generation)) return;
    const message = messageRecord(input);
    if (!message || typeof message.type !== "string") throw new Error(cloudHomeCopy.invalidCloudSupervisorMessage);
    switch (message.type) {
      case "murage:cloud-recovery-wipe": {
        if (typeof message.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(message.requestId) || Object.keys(message).some(k => !["type","requestId"].includes(k)) || !options.modelSignIn) return refuse(message,cloudHomeCopy.invalidCloudSupervisorMessage);
        try {
          options.modelSignIn.invalidateOwner({all:true});
          for (const provider of ["chatgpt","supergrok"] as const) await options.modelSignIn.dispatch({operation:"remove",provider,actor:{environmentId:"home-recovery",deviceId:"home-recovery"}},generation);
          await (options.wipeEngineSignIns ?? wipeHomeEngineSignIns)();
          if (!disposed && generation === (options.generation?.() ?? generation)) options.send({type:"murage:cloud-recovery-result",requestId:message.requestId,ok:true});
        } catch { if (!disposed && generation === (options.generation?.() ?? generation)) options.send({type:"murage:cloud-recovery-result",requestId:message.requestId,ok:false}); }
        return;
      }
      case "murage:cloud-model-signin-ready":
        options.onModelReady?.(); options.modelSignIn?.attach(undefined, generation); return;
      case "murage:cloud-model-signin-request": {
        const parsed = cloudModelRequest.safeParse(message);
        if (!parsed.success || !options.modelSignIn) return refuse(message, cloudHomeCopy.invalidCloudSupervisorMessage);
        const { type: _type, requestId, ...request } = parsed.data;
        try {
          const result = await options.modelSignIn.dispatch(request, generation);
          if (!disposed && generation === (options.generation?.() ?? generation)) options.send({ type: "murage:cloud-model-signin-result", requestId, ok: true, result });
        } catch (error) {
          const candidate = error && typeof error === "object" && "code" in error ? String(error.code) : "unavailable";
          const code = ["unauthorized", "not-found", "rate-limited", "busy", "invalid-request", "cancelled", "timeout", "disabled", "storage", "offline"].includes(candidate) ? candidate : "unavailable";
          if (!disposed && generation === (options.generation?.() ?? generation)) options.send({ type: "murage:cloud-model-signin-result", requestId, ok: false, errorCode: code });
        }
        return;
      }
      case "murage:model-signin-refresh":
        if (message.provider !== "chatgpt" && message.provider !== "supergrok") return refuse(message, cloudHomeCopy.invalidCloudSupervisorMessage);
        await options.modelSignIn?.internalRefresh(message.provider); return;
      case "murage:cloud-credential-write": {
        const patch = messageRecord(message.credentials);
        if (typeof message.requestId !== "string" || !patch || !isGenericCredentialPatch(patch)) return refuse(message, cloudHomeCopy.invalidCloudCredentialWrite);
        // A new Flux key (1.0.4 audit 11-5): the broker token the old key minted
        // belongs to the old account. It is cleared in the same sealed write, so
        // no connected-app call after this one can carry it (a failed re-mint
        // leaves no token: calls fail closed), then re-minted for the new key.
        const before = options.store.getAll();
        const keyChanged = Object.hasOwn(patch, "fluxApiKey") && fluxKeyPrint(patch.fluxApiKey as string) !== fluxKeyPrint(before.fluxApiKey);
        const replacedToken = keyChanged ? before.fluxComposioBrokerToken : undefined;
        // Same key re-saved but the last mint failed: mint again (no token => dead apps).
        const needsMint = !keyChanged && Object.hasOwn(patch, "fluxApiKey") && fluxKeyPrint(patch.fluxApiKey as string) !== "" && !before.fluxComposioBrokerToken;
        // Persist the replaced token as a pending revoke in the same sealed write.
        // The list is bounded: a full list drops its oldest entry, which gets one off-chain revoke attempt below.
        const queued = keyChanged && replacedToken ? [...pendingRevokes(before).filter(t => t !== replacedToken), replacedToken] : null;
        const dropped = queued ? queued.slice(0, Math.max(0, queued.length - PENDING_REVOKE_MAX)) : [];
        const marker: Record<string, string> = queued ? pendingRevokesPatch(queued.slice(dropped.length)) : {};
        let written = false;
        options.send({ type: "murage:provider-bank-fence", held: true });
        try {
          const credentials = serverCredentialProjection(options.store.patch(keyChanged ? { ...patch as Record<string, string>, ...connectedAppsPatch({}), ...marker } : patch as Record<string, string>));
          written = true;
          if (keyChanged) sendManagedComposio(fluxComposioBrokerUrl(process.env, { packaged: true }), credentials);
          options.send({ type: "murage:cloud-credential-result", requestId: message.requestId, credentials });
        } catch { options.send({ type: "murage:cloud-credential-result", requestId: message.requestId, error: cloudHomeCopy.cloudCredentialWriteFailed }); }
        finally { options.send({ type: "murage:provider-bank-fence", held: false }); }
        if (!written || (!keyChanged && !needsMint)) return;
        // A token pushed off the full list is revoked off the chain, once, best effort (never blocks the write).
        for (const token of dropped) void Promise.resolve().then(() => revokeToken(fluxComposioBrokerUrl(process.env, { packaged: true }), token)).catch(() => {});
        // Only the mint holds the write chain; the revoke runs off it (audit M2).
        try { await remint(false); } catch { /* no token stays no token: connected apps fail closed until the retry lands */ }
        if (!disposed && options.store.getAll().fluxApiKey && !options.store.getAll().fluxComposioBrokerToken) retryMint();
        drainPendingRevoke();
        return;
      }
      case "murage:flux-composio-token-rejected":
        try { await remint(true); } catch { refuse(message, cloudHomeCopy.connectedAppsCouldNotReconnectTryAgain); }
        return;
      case "murage:browser-bot-deleted":
        if (typeof message.botId !== "string" || !/^[\w-]+$/.test(message.botId)) {
          options.send({ type: "murage:browser-lifecycle-result", requestId: message.requestId, ok: false });
          return;
        }
        try {
          await (options.cleanupBrowser ?? cleanupCloudBrowser)(message.botId);
          options.send({ type: "murage:browser-lifecycle-result", requestId: message.requestId, ok: true });
        } catch { options.send({ type: "murage:browser-lifecycle-result", requestId: message.requestId, ok: false }); }
        return;
      case "murage:browser-profile-deleted":
        if (!Array.isArray(message.cloudBotIds) || message.cloudBotIds.length > 512 || message.cloudBotIds.some(bot => typeof bot !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(bot)) || new Set(message.cloudBotIds).size !== message.cloudBotIds.length) {
          options.send({ type: "murage:browser-lifecycle-result", requestId: message.requestId, ok: false });
          return refuse(message, cloudHomeCopy.invalidProfileCleanupMapping);
        }
        try {
          for (const bot of message.cloudBotIds) await (options.cleanupBrowser ?? cleanupCloudBrowser)(bot as string);
          options.send({ type: "murage:browser-lifecycle-result", requestId: message.requestId, ok: true });
        } catch { options.send({ type: "murage:browser-lifecycle-result", requestId: message.requestId, ok: false }); }
        return;
      case "murage:browser-control": return refuse(message, cloudHomeCopy.desktopBrowserControlIsUnavailableOnThisCloudHome);
      case "murage:desktop-secret": return refuse(message, cloudHomeCopy.cloudAccessRequiresAPairedSession);
      default: return refuse(message, cloudHomeCopy.thisDesktopOperationIsUnavailableOnThisCloudHome);
    }
  };
  return {
    handle(input: unknown, generation = options.generation?.() ?? 0): Promise<void> {
      const cancel = cloudModelCancel.safeParse(input);
      if (cancel.success) {
        if (!disposed && generation === (options.generation?.() ?? generation)) options.modelSignIn?.invalidateOwner(cancel.data);
        return Promise.resolve();
      }
      // The model owner has its own persistence queue. A slow connected-app
      // broker must not delay READY, cancellation, sign-out or model requests.
      const type = messageRecord(input)?.type;
      if (["murage:cloud-model-signin-ready", "murage:cloud-model-signin-request", "murage:model-signin-refresh"].includes(String(type))) return dispatch(input, generation);
      const next = chain.then(() => dispatch(input, generation)); chain = next.catch(() => {}); return next;
    },
    configure(): Promise<void> { drainPendingRevoke(); const next = chain.then(() => remint(false)); chain = next.catch(() => {}); return next; },
    remintConnectedApps: () => remint(true),
    requestClose: () => options.send({ type: "murage:close" }),
    dispose: () => { disposed = true; },
  };
}

interface UtilityPort { on(event: "message", listener: (event: { data?: object }) => void): void; postMessage(message: object): void }
let port: UtilityPort | null | undefined;
let modelClient: ReturnType<typeof createCloudModelSignInClient> | undefined;
const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

export function cloudSupervisorPort(): UtilityPort | null {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return null;
  if (port !== undefined) return port;
  if (!process.send || !process.connected) throw new Error(cloudHomeCopy.cloudSupervisorConnectionIsRequired);
  const listeners: Array<(event: { data?: object }) => void> = [];
  process.on("message", raw => {
    const message = messageRecord(raw);
    if (!message) return;
    if (message.type === "murage:cloud-recovery-result") {
      const item=typeof message.requestId === "string" ? pending.get(message.requestId) : undefined;
      if(item) { clearTimeout(item.timer);pending.delete(message.requestId as string);if(message.ok === true)item.resolve();else item.reject(new Error(cloudHomeCopy.homeRecoveryCleanupFailed)); }
      return;
    }
    if (message.type === "murage:cloud-model-signin-result") { modelClient?.receive(message); return; }
    if (message.type === "murage:cloud-credentials" || message.type === "murage:cloud-credential-result") {
      const item = typeof message.requestId === "string" ? pending.get(message.requestId) : undefined;
      if (message.credentials && typeof message.credentials === "object") updateServerCredentials(message.credentials as Record<string, string>);
      if (item) { clearTimeout(item.timer); pending.delete(message.requestId as string); if (message.error) item.reject(new Error(cloudHomeCopy.cloudCredentialWriteFailed)); else item.resolve(); }
      return;
    }
    if (message.type === "murage:cloud-refused") { console.warn(String(message.error)); return; }
    for (const listener of listeners) listener({ data: message });
  });
  process.once("disconnect", () => {
    modelClient?.dispose();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(cloudHomeCopy.cloudSupervisorConnectionClosed)); }
    pending.clear();
  });
  port = { on: (_event, listener) => { listeners.push(listener); }, postMessage: message => { if (!process.connected) throw new Error(cloudHomeCopy.cloudSupervisorConnectionClosed); process.send!(message); } };
  return port;
}

export function cloudModelSignInClient(): ReturnType<typeof createCloudModelSignInClient> {
  const channel = cloudSupervisorPort();
  if (!channel) throw new Error(cloudHomeCopy.cloudSupervisorConnectionIsRequired);
  return modelClient ??= createCloudModelSignInClient(message => channel.postMessage(message));
}

export async function persistCloudCredentialPatch(config: unknown): Promise<void> {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return;
  const credentials = cloudCredentialPatch(config);
  if (!Object.keys(credentials).length) return;
  const channel = cloudSupervisorPort();
  if (!channel) throw new Error(cloudHomeCopy.cloudSupervisorConnectionIsRequired);
  const requestId = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(cloudHomeCopy.cloudCredentialWriteTimedOut)); }, 25_000); // a write queued behind a Flux key swap waits for the up-to-15 s broker mint
    pending.set(requestId, { resolve, reject, timer });
    try { channel.postMessage({ type: "murage:cloud-credential-write", requestId, credentials }); }
    catch { clearTimeout(timer); pending.delete(requestId); reject(new Error(cloudHomeCopy.cloudCredentialWriteFailed)); }
  });
}

/** Only resolves after supervisor sealed sign-outs and launcher credential erase. */
export async function requestCloudRecoveryWipe(): Promise<void> {
  const channel=cloudSupervisorPort();
  if(!channel) throw new Error(cloudHomeCopy.cloudSupervisorConnectionIsRequired);
  const requestId=randomUUID();
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(cloudHomeCopy.homeRecoveryCleanupTimedOut));},45_000);
    pending.set(requestId,{resolve,reject,timer});
    try { channel.postMessage({type:"murage:cloud-recovery-wipe",requestId}); }
    catch {clearTimeout(timer);pending.delete(requestId);reject(new Error(cloudHomeCopy.homeRecoveryCleanupUnavailable));}
  });
}
