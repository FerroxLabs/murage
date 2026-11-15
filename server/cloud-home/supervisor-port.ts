import { OWNER_REVOKES_MAX, ownerRevokesPatch, pendingOwnerRevokes, queueOwnerRevoke } from "./email-owner-revokes.ts";
import { wipeHomeEngineSignIns } from "./b1b-recovery.ts";
import { cloudHomeCopy } from "./copy.ts";
import { randomUUID } from "node:crypto";
import { ensureFluxComposioBrokerToken, fluxKeyFingerprint, revokeFluxComposioBrokerToken } from "../../electron/flux-composio-token.mjs";
import { fluxComposioBrokerUrl, fluxComposioAccess } from "../../electron/managed-composio.mjs";
import type { SealedSecretStore } from "./secrets.ts";
import { isHomeFluxKey } from "./flux-home-gate.ts";
import { cloudCredentialPatch, fluxCredentialViolation } from "./credentials.ts";
import { requestFluxKeyRecheck } from "../flux-key-health.ts";
import { updateServerCredentials } from "./server-secrets.ts";
import { cleanupCloudBrowser } from "./browser-process.ts";
import { FLUX_KEY_GENERATION_KEY, FLUX_KEY_OWNER_SAVED_AT_KEY, connectedAppsCredentials, connectedAppsPatch, isGenericCredentialPatch, PENDING_REVOKE_MAX, pendingRevokes, pendingRevokesPatch, serverCredentialProjection } from "./credential-projection.ts";
import { createCloudModelSignInClient, cloudModelCancel, cloudModelRequest } from "./model-signin-wire.ts";
import type { createHomeModelSignIn } from "./model-signin.ts";
import { applyOwnerDelta, confirmDurableWithoutOwner, parseEmailSecretsSave, readRecord, saveEmailSecrets, wipeEmailRecord, type EmailSecretsSanitizer, type KeyStore, type OwnerDelta } from "./email-keystore.ts";
import { OWNER_BACKOFF_MS, revokeWithBackoff, runOwnerSignIn, stubFluxDeviceCodeClient, type FluxDeviceCodeClient } from "./email-owner-signin.ts";
import type { FluxCredential } from "../email/flux-email-client.ts";

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
  store: Pick<SealedSecretStore, "getAll" | "patch"> & Partial<Pick<SealedSecretStore, "readBack" | "patchDurable">>;
  send: Sender;
  /** The cloudBotEmail flag (default off). Off: the email save and owner sign-in are refused like any unknown desktop message. */
  emailStore?: boolean;
  emailSanitize?: EmailSecretsSanitizer;
  /** Owner sign-in wire. Defaults to the labelled STUB (no network). */
  emailDeviceCode?: FluxDeviceCodeClient;
  emailSleep?: (ms: number) => Promise<void>;
  /** Waits for owner reconcile retries and owner key revoke retries (defaults to `emailSleep`, then a real timer). */
  emailBackoffSleep?: (ms: number) => Promise<void>;
  /** Backoff steps for those waits (the last repeats). */
  emailBackoffMs?: readonly number[];
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
  /** Sign-in attempts are numbered; the recovery wipe, a new attempt and dispose cancel the old ones (CLOUD-EMAIL-KEYSTORE-1019 r2 section 7). */
  let signInAttempt = 0;
  /** The owner session the live email sign-in is bound to (r2 section 7); a session end for it, a child disconnect, a wipe or dispose bump the attempt. */
  let signInActor: { environmentId: string; deviceId: string } | null = null;
  /** Last written rev per server epoch, for the stale-revision refusal. */
  const lastRevs = new Map<number, number>();
  const keyStore = (): KeyStore | null => options.emailStore === true && options.store.readBack && options.store.patchDurable ? options.store as KeyStore : null;
  let disposed = false;
  // ---- the owner lane (CLOUD-EMAIL-KEYSTORE-1019 r4 A, r5 A and B) ----
  // There is ONE write chain for the sealed record (`chain`, which already carries server saves, the recovery wipe and credential writes). Every owner
  // write is a transaction on it and a delta: the lane never keeps a whole record. `pendingOwner` is the delta while a write is not confirmed.
  interface PendingOwner { delta: OwnerDelta; prev: FluxCredential | null; notify: () => void }
  let pendingOwner: PendingOwner | null = null;
  const rawDeviceClient = options.emailDeviceCode ?? stubFluxDeviceCodeClient;
  const ownerDeviceClient: FluxDeviceCodeClient = {
    availability: rawDeviceClient.availability ? async () => { const result = await rawDeviceClient.availability!(); if (result.available) drainOwnerRevokes(); return result; } : undefined,
    start: async () => { const result = await rawDeviceClient.start(); if (!("state" in result)) drainOwnerRevokes(); return result; },
    poll: async code => { const result = await rawDeviceClient.poll(code); if (result.state === "ok") drainOwnerRevokes(); return result; },
    revoke: async token => { const result = await rawDeviceClient.revoke(token); if (result !== "retry") drainOwnerRevokes(); return result; },
  };
  const deviceClient = (): FluxDeviceCodeClient => ownerDeviceClient;
  const backoffSleep = (ms: number) => (options.emailBackoffSleep ?? options.emailSleep ?? ((wait: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, wait); t.unref?.(); })))(ms);
  const ownerRevoking = new Set<string>();
  /** Each worker owns one sealed entry. Store changes always join the shared write chain. */
  const drainOwnerRevokes = () => {
    if (disposed || pendingOwner || !options.store.readBack || !options.store.patchDurable) return;
    let tokens: string[];
    try { if (!pendingOwnerRevokes(options.store.getAll()).length) return; tokens = pendingOwnerRevokes(options.store.readBack()); } catch { return; }
    for (const token of tokens) {
      if (ownerRevoking.has(token)) continue;
      ownerRevoking.add(token);
      void (async () => {
        try {
          // A process restart can follow an unconfirmed directory sync. Confirm the current owner and its queue together before revoking.
          const proof = chain.then(() => {
            if (disposed || pendingOwner) return false;
            const records = options.store.getAll(), pending = pendingOwnerRevokes(records), current = readRecord(records, options.emailSanitize);
            if (!current || !pending.includes(token) || current.owner?.token === token) return false;
            if (!options.store.patchDurable!(ownerRevokesPatch(pending)).durable) return false;
            const again = options.store.readBack!(), confirmed = readRecord(again, options.emailSanitize);
            return !!confirmed && confirmed.storeId === current.storeId && confirmed.gen === current.gen && confirmed.ownerRev === current.ownerRev
              && confirmed.owner?.keyId === current.owner?.keyId && confirmed.owner?.token !== token && pendingOwnerRevokes(again).includes(token);
          });
          chain = proof.then(() => {}, () => {});
          if (!(await proof)) return;
          const outcome = await revokeWithBackoff(deviceClient(), token, { sleep: backoffSleep, delaysMs: options.emailBackoffMs ?? OWNER_BACKOFF_MS, stop: () => disposed });
          if (disposed || outcome === "stopped") return;
          const write = chain.then(() => {
            if (disposed) return;
            const kept = pendingOwnerRevokes(options.store.getAll()).filter(t => t !== token);
            if (!options.store.patchDurable!(ownerRevokesPatch(kept)).durable) throw new Error(cloudHomeCopy.cloudCredentialWriteFailed);
            if (pendingOwnerRevokes(options.store.readBack!()).includes(token)) throw new Error(cloudHomeCopy.cloudCredentialWriteFailed);
          });
          chain = write.catch(() => {});
          await write;
        } catch { /* The sealed entry stays for the next drain. */ }
        finally { ownerRevoking.delete(token); }
      })();
    }
  };
  /** Replaced keys are already sealed. A never-stored candidate is revoked at once; a retry becomes sealed work. */
  const revokeOwnerKeys = (...tokens: Array<string | undefined>) => {
    for (const token of new Set(tokens.filter((t): t is string => typeof t === "string" && t.length > 0))) {
      if (pendingOwnerRevokes(options.store.getAll()).includes(token)) { drainOwnerRevokes(); continue; }
      void (async () => {
        let result: "revoked" | "gone" | "retry" = "retry";
        try { result = await deviceClient().revoke(token); } catch { /* Queue a transient refusal. */ }
        if (disposed || result !== "retry") return;
        const write = chain.then(() => {
          if (disposed || !options.store.patchDurable) return;
          if (!options.store.patchDurable(queueOwnerRevoke(options.store.getAll(), token)).durable) return;
          drainOwnerRevokes();
        });
        chain = write.catch(() => {});
        await write.catch(() => {});
      })();
    }
  };
  /** The delta is confirmed on disk by a reread: tell the server, finish the waiting attempt, then revoke the replaced key (revoke rule 2). */
  const settleOwner = (p: PendingOwner) => {
    if (pendingOwner === p) pendingOwner = null;
    options.send({ type: "murage:cloud-email-owner", gen: p.delta.gen, ownerRev: p.delta.ownerRev, owner: p.delta.owner });
    options.send({ type: "murage:cloud-email-owner-status", owner: "settled" });
    p.notify();
    if (p.prev && p.prev.keyId !== p.delta.owner?.keyId) revokeOwnerKeys(p.prev.token);
  };
  const scheduleReconcile = (p: PendingOwner, attempt: number) => {
    const delays = options.emailBackoffMs?.length ? options.emailBackoffMs : OWNER_BACKOFF_MS;
    void (async () => {
      await backoffSleep(delays[Math.min(attempt, delays.length - 1)]!);
      if (disposed || pendingOwner !== p) return;
      // Each retry is one transaction on the chain: the latest record, only the owner slot changed.
      const run = chain.then((): "done" | "retry" => {
        if (disposed || pendingOwner !== p) return "done";
        const keys = keyStore();
        if (!keys) return "retry";
        try {
          const outcome = applyOwnerDelta(keys, p.delta, options.emailSanitize);
          if (outcome.kind === "ok") { settleOwner(p); return "done"; }
          // Another generation (a wipe ran): the delta is dropped, but the key is revoked only after a durable reread proves it is not stored (r4 revoke rule 2).
          // A wipe that renamed but failed its directory sync is not that proof: the sync is redone here first.
          if (!confirmDurableWithoutOwner(keys, p.delta.owner?.keyId, options.emailSanitize)) return "retry";
          pendingOwner = null; revokeOwnerKeys(p.delta.owner?.token); return "done";
        } catch { return "retry"; }
      });
      chain = run.then(() => {}, () => {});
      if ((await run.catch(() => "retry" as const)) === "retry" && !disposed && pendingOwner === p) scheduleReconcile(p, attempt + 1);
    })().catch(() => {});
  };
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
    if (credentials.fluxComposioBrokerToken) { drainPendingRevoke(); drainOwnerRevokes(); }
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
          ++signInAttempt; signInActor = null;
          {
            // Not gated by the flag: a home turned OFF after it held keys still erases them.
            const keys = options.store.readBack && options.store.patchDurable ? options.store as KeyStore : null;
            const stored = keys ? readRecord(keys.getAll(), options.emailSanitize)?.owner : undefined, held = pendingOwner;
            if (keys) wipeEmailRecord(keys, options.emailStore === true, options.emailSanitize);
            else if (options.store.getAll().botEmailSecrets) throw new Error(cloudHomeCopy.cloudCredentialWriteFailed);
            // The durable empty write decides (r4 revoke rule 2): only now are the owner key, a replaced key and a candidate that was still being saved revoked.
            pendingOwner = null;
            revokeOwnerKeys(stored?.token, held?.prev?.token, held?.delta.owner?.token);
          }
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
          const credentials = serverCredentialProjection(options.store.patch(keyChanged ? { ...patch as Record<string, string>, ...connectedAppsPatch({}), ...marker, [FLUX_KEY_GENERATION_KEY]: "", [FLUX_KEY_OWNER_SAVED_AT_KEY]: String(Date.now()) } : patch as Record<string, string>));
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
      case "murage:email-secrets-save": {
        const keys = keyStore();
        if (!keys) return refuse(message, cloudHomeCopy.thisDesktopOperationIsUnavailableOnThisCloudHome);
        const parsed = parseEmailSecretsSave(message, options.emailSanitize);
        const note = (reason: string) => options.send({ type: "murage:email-secrets-refused", rev: message.rev, epoch: message.epoch, reason });
        // Any failure sends no ack and says nothing about the content: a reason code only.
        if (!parsed.ok) return note(parsed.reason);
        // Every chain write carries the pending owner delta (r5 A), and a durable write whose reread shows it settles it (r5 B).
        const holding = pendingOwner;
        const result = saveEmailSecrets(keys, parsed.save, { lastRevs, sanitize: options.emailSanitize, pendingOwner: holding?.delta ?? null });
        if (result.ok) { options.send({ type: "murage:email-secrets-saved", ...result.ack }); if (result.settledOwner && holding && pendingOwner === holding) settleOwner(holding); } else note(result.reason);
        return;
      }
      case "murage:email-owner-signin-start": {
        const keys = keyStore();
        // r2 section 7: the start is bound to the owner session (actor) and to the email generation the server booted with.
        const actor = messageRecord(message.actor), ident = (v: unknown): v is string => typeof v === "string" && /^[\w.:-]{1,200}$/.test(v);
        if (!keys || typeof message.requestId !== "string" || Object.keys(message).some(k => !["type", "requestId", "actor", "gen"].includes(k))
          || !actor || Object.keys(actor).some(k => !["environmentId", "deviceId"].includes(k)) || !ident(actor.environmentId) || !ident(actor.deviceId) || !Number.isSafeInteger(message.gen))
          return refuse(message, cloudHomeCopy.thisDesktopOperationIsUnavailableOnThisCloudHome);
        if (readRecord(keys.getAll(), options.emailSanitize)?.gen !== message.gen) { options.send({ type: "murage:email-owner-signin-result", requestId: message.requestId, state: "unavailable" }); return; }
        // r4 B: while a write is not confirmed no new sign-in starts.
        if (pendingOwner || pendingOwnerRevokes(keys.getAll()).length >= OWNER_REVOKES_MAX) { options.send({ type: "murage:email-owner-signin-result", requestId: message.requestId, state: "owner_busy" }); return; }
        const requestId = message.requestId, attempt = ++signInAttempt;
        signInActor = { environmentId: actor.environmentId as string, deviceId: actor.deviceId as string };
        const startGen = readRecord(keys.getAll(), options.emailSanitize)?.gen;
        const live = () => !disposed && attempt === signInAttempt && generation === (options.generation?.() ?? generation);
        const result = (state: string, extra: object = {}) => { if (live()) options.send({ type: "murage:email-owner-signin-result", requestId, state, ...extra }); };
        // The poll loop never holds the write chain; only the sealed write of the token does.
        void runOwnerSignIn(deviceClient(), {
          code: info => result("code", info),
          discard: owner => revokeOwnerKeys(owner.token),
          token: owner => {
            const write = chain.then((): boolean | "saving" => {
              // The attempt must still be current, the generation unchanged (a recovery wipe bumps it), the flag still on, and no other write pending.
              // Refused before anything was written: the key never reached the file, so it is revoked (r4 revoke rule 1).
              const current = readRecord(keys.getAll(), options.emailSanitize);
              if (!live() || startGen === undefined || options.emailStore !== true || pendingOwner || !current || current.gen !== startGen) { revokeOwnerKeys(owner.token); return false; }
              const delta: OwnerDelta = { gen: startGen, ownerRev: current.ownerRev + 1, owner };
              const p: PendingOwner = { delta, prev: current.owner ?? null, notify: () => result("done") };
              try {
                if (applyOwnerDelta(keys, delta, options.emailSanitize).kind === "dropped") { revokeOwnerKeys(owner.token); return false; }
              } catch {
                // A write was attempted and is not confirmed: nothing is revoked and the server is told nothing; the delta is retried (r4 B).
                pendingOwner = p;
                options.send({ type: "murage:cloud-email-owner-status", owner: "saving" });
                scheduleReconcile(p, 0);
                return "saving";
              }
              settleOwner({ ...p, notify: () => {} });
              return true;
            }).catch(() => false);
            chain = write.then(() => {}, () => {});
            return write;
          },
        }, { sleep: options.emailSleep, isCancelled: () => !live() })
          .then(outcome => result(outcome)).catch(() => result("unavailable"));
        return;
      }
      case "murage:email-owner-session-end": {
        // The owner session that started the sign-in ended (or every session did): a token that arrives later installs nothing and revokes nothing but itself.
        const deviceId = typeof message.deviceId === "string" ? message.deviceId : null;
        if (deviceId === null || signInActor?.deviceId === deviceId) { ++signInAttempt; signInActor = null; }
        return;
      }
      case "murage:email-owner-unlink": {
        // r4 C: unlink is bound to the owner it started for. U is captured here; every later step re-checks it.
        const keys = keyStore();
        if (!keys || typeof message.requestId !== "string" || Object.keys(message).some(k => !["type", "requestId"].includes(k))) return refuse(message, cloudHomeCopy.thisDesktopOperationIsUnavailableOnThisCloudHome);
        const requestId = message.requestId;
        const answer = (state: string) => { if (!disposed && generation === (options.generation?.() ?? generation)) options.send({ type: "murage:email-owner-unlink-result", requestId, state }); };
        if (pendingOwner) return answer("owner_busy");
        const start = readRecord(keys.getAll(), options.emailSanitize);
        if (!start?.owner) return answer("none");
        const U = { gen: start.gen, ownerRev: start.ownerRev, keyId: start.owner.keyId, token: start.owner.token };
        const stillU = () => { const c = readRecord(keys.getAll(), options.emailSanitize); return !!c && c.gen === U.gen && c.owner?.keyId === U.keyId; };
        void (async () => {
          const delays = options.emailBackoffMs?.length ? options.emailBackoffMs : OWNER_BACKOFF_MS;
          // The retry loop runs off the chain; each pass first checks the stored owner is still U (else: replaced, no Flux call, no write).
          for (let attempt = 0; ; attempt++) {
            if (disposed) return;
            if (!stillU()) return answer("replaced");
            let result: "revoked" | "gone" | "retry" = "retry";
            try { result = await deviceClient().revoke(U.token); } catch { /* network: retry */ }
            if (result !== "retry") break;
            if (attempt === 0) answer("disconnecting");
            await backoffSleep(delays[Math.min(attempt, delays.length - 1)]!);
          }
          // The conditional clear is one transaction on the store chain.
          const run = chain.then((): void => {
            if (disposed) return;
            const c = readRecord(keys.getAll(), options.emailSanitize);
            if (!c || pendingOwner || c.gen !== U.gen || c.ownerRev !== U.ownerRev || c.owner?.keyId !== U.keyId) return answer("replaced");
            const delta: OwnerDelta = { gen: U.gen, ownerRev: c.ownerRev + 1, owner: null };
            // U is already revoked at Flux, so a reconcile after an uncertain write has nothing to revoke (prev = null).
            const p: PendingOwner = { delta, prev: null, notify: () => answer("unlinked") };
            try { if (applyOwnerDelta(keys, delta, options.emailSanitize).kind === "dropped") return answer("replaced"); }
            catch { pendingOwner = p; options.send({ type: "murage:cloud-email-owner-status", owner: "saving" }); scheduleReconcile(p, 0); return answer("saving"); }
            settleOwner({ ...p, notify: () => {} }); answer("unlinked");
          });
          chain = run.then(() => {}, () => {});
          await run.catch(() => {});
        })().catch(() => {});
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
    configure(): Promise<void> { drainOwnerRevokes(); drainPendingRevoke(); const next = chain.then(() => remint(false)); chain = next.catch(() => {}); return next; },
    fluxCallSucceeded: drainOwnerRevokes,
    remintConnectedApps: () => remint(true),
    /** A renewed Flux sub-key from the root poller's private hand-off. Home keys only. Resolves only once the key is sealed
     *  in the store (the receipt that lets the poller ack depends on that); throws otherwise so the hand-off is kept and retried.
     *  The connected-apps broker refresh afterwards is best-effort: it has its own retry and must not hold back the ack. */
    applyFluxSubkey: async (key: string, generation?: number, handoffAtMs?: number): Promise<"applied" | "stale"> => {
      if (disposed || !isHomeFluxKey(key)) throw new Error(cloudHomeCopy.fluxSubkeyNotApplied);
      // A hand-off must never replace a newer key: a lower key generation than the sealed one, or a hand-off written before the
      // owner last saved a different key, is stale. The caller still writes the receipt so the poller can clear it; nothing is installed.
      const sealed = options.store.getAll();
      const sealedGeneration = Number(sealed[FLUX_KEY_GENERATION_KEY] || 0), savedAt = Number(sealed[FLUX_KEY_OWNER_SAVED_AT_KEY] || 0);
      if (sealed.fluxApiKey !== key && generation !== undefined && ((sealedGeneration > 0 && generation < sealedGeneration) || (savedAt > 0 && handoffAtMs !== undefined && handoffAtMs <= savedAt))) return "stale";
      const credentials = serverCredentialProjection(options.store.patch({ fluxApiKey: key, ...(generation !== undefined ? { [FLUX_KEY_GENERATION_KEY]: String(generation) } : {}) }));
      options.send({ type: "murage:cloud-credentials", credentials });
      await remint(false).catch(() => {});
      return "applied";
    },
    requestClose: () => options.send({ type: "murage:close" }),
    /** A child disconnect cancels the email sign-in: a late token installs and revokes nothing (r2 section 7: cancel on child disconnect). */
    disconnect: (_childGeneration?: number) => { ++signInAttempt; signInActor = null; },
    dispose: () => { disposed = true; ++signInAttempt; pendingOwner = null; },
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
      // A key the supervisor pushed (a hand-off, not the answer to our own write): ask Flux about it afresh, so a refusal from before it arrived (the account hold) is not held against it.
      if (message.type === "murage:cloud-credentials" && !item && typeof (message.credentials as Record<string, unknown> | undefined)?.fluxApiKey === "string") requestFluxKeyRecheck();
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
  const violation = fluxCredentialViolation(config);
  if (violation) throw new Error(violation);
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
