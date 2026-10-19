// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { cloudHomeCopy } from "./copy.ts";
import { randomUUID } from "node:crypto";
import { createModelSignIn } from "../../electron/model-signin.mjs";
import { createDeviceAcquirer, type DeviceChallenge, type DeviceOptions, type HomeSignInProvider } from "./model-signin-device.ts";
export type { HomeSignInProvider } from "./model-signin-device.ts";
/** Reserved supervisor-owned sealed document. Never publish through generic credentials. */
export const CLOUD_MODEL_SIGNINS_KEY = "cloudModelSignInsV1";
export type HomeSignInActor = { environmentId: string; deviceId: string };
export type HomeSignInRequest = { operation: "status" | "start" | "attempt" | "cancel" | "signOut" | "remove"; provider?: HomeSignInProvider; attemptId?: string; actor: HomeSignInActor };
export type HomeSignInChallenge = DeviceChallenge & { attemptId: string; provider: HomeSignInProvider; state: "waiting" };
export class HomeSignInError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export type HomeModelSignInEntry = { provider: string; connectionId: string; revision: string; state: string; accessToken?: string; accountId?: string; expiresAt?: number; email?: string; plan?: string };
export type HomeModelSignInEntries = HomeModelSignInEntry[];
type Options = DeviceOptions & { store: { getAll(): Record<string, string>; patch(values: Record<string, string>): unknown }; env?: Record<string, string | undefined>; randomId?: () => string; publish(entries: HomeModelSignInEntries): void };
type Attempt = { id: string; provider: HomeSignInProvider; actor: HomeSignInActor; generation: number; state: "waiting" | "connected" | "failed" | "cancelled"; challenge?: HomeSignInChallenge; email?: string; plan?: string; errorCode?: string; resolve(value: HomeSignInChallenge): void; reject(error: Error): void };
const providers: HomeSignInProvider[] = ["chatgpt", "supergrok"];
const validText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);
export function createHomeModelSignIn(options: Options) {
  const now = options.now ?? Date.now, id = options.randomId ?? randomUUID;
  const device = createDeviceAcquirer(options);
  const attempts = new Map<string, Attempt>(), active = new Map<HomeSignInProvider, Attempt>(), starts = new Map<string, number>();
  let disposed = false, generation = 0, publish = options.publish, queue = Promise.resolve();
  const factory = createModelSignIn({
    ...options, fetch: device.fetch, platform: "linux", randomId: id,
    readDocument: () => ({ modelSignIns: options.store.getAll()[CLOUD_MODEL_SIGNINS_KEY] }),
    updateDocument: (derive: (document: Record<string, unknown>) => Record<string, unknown>) => {
      const job = queue.then(() => { if (disposed) throw new HomeSignInError("unavailable"); const next = derive({ modelSignIns: options.store.getAll()[CLOUD_MODEL_SIGNINS_KEY] }); options.store.patch({ [CLOUD_MODEL_SIGNINS_KEY]: String(next.modelSignIns ?? "{}") }); });
      queue = job.catch(() => {}); return job;
    },
    publish: (entries: HomeModelSignInEntries) => { if (!disposed) publish(entries); },
    openExternal: async () => { throw new Error(cloudHomeCopy.homeSignInUnavailable); }, createServer: () => { throw new Error(cloudHomeCopy.homeSignInUnavailable); },
    acquireTokens: (context: Parameters<typeof device.acquire>[0]) => {
      const attempt = active.get(context.provider);
      if (!attempt) return Promise.resolve({ kind: "error" as const, error: cloudHomeCopy.homeSignInCancelled, epoch: context.epoch });
      return device.acquire({ ...context, isCurrent: () => context.isCurrent() && attempt.state === "waiting" && active.get(context.provider) === attempt && !disposed,
        onChallenge: challenge => { if (attempt.state !== "waiting") return; attempt.challenge = { ...challenge, attemptId: attempt.id, provider: attempt.provider, state: "waiting" }; attempt.resolve(attempt.challenge); } });
    },
  });
  const cancel = (attempt: Attempt) => {
    if (attempt.state !== "waiting") return;
    attempt.state = "cancelled"; attempt.reject(new HomeSignInError("cancelled"));
    if (active.get(attempt.provider) === attempt) { active.delete(attempt.provider); factory.cancel(attempt.provider); }
  };
  function publicAttempt(attempt: Attempt) {
    if (attempt.state === "waiting") return attempt.challenge ?? { attemptId: attempt.id, provider: attempt.provider, state: "waiting" };
    return { attemptId: attempt.id, provider: attempt.provider, state: attempt.state, ...(attempt.email ? { email: attempt.email } : {}), ...(attempt.plan ? { plan: attempt.plan } : {}), ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}) };
  }
  return {
    async dispatch(request: HomeSignInRequest, serverGeneration = generation) {
      if (disposed) throw new HomeSignInError("unavailable");
      if (!request || !request.actor || !validText(request.actor.environmentId) || !validText(request.actor.deviceId)) throw new HomeSignInError("unauthorized");
      const { operation, provider, actor } = request;
      if (operation === "status") return { providers: factory.status() };
      if (!provider || !providers.includes(provider)) throw new HomeSignInError("invalid-request");
      if (operation === "start") {
        const key = `${provider}:${actor.environmentId}:${actor.deviceId}`, previous = starts.get(key);
        if (previous !== undefined && now() - previous < 60_000) throw new HomeSignInError("rate-limited");
        if (active.has(provider)) cancel(active.get(provider)!);
        if (active.size >= 2) throw new HomeSignInError("busy");
        starts.set(key, now());
        // Bound retained terminal records and rate metadata; no device secrets are retained here.
        for (const [k, time] of starts) if (now() - time >= 60_000) starts.delete(k);
        if (starts.size > 1024) throw new HomeSignInError("busy");
        for (const [k, a] of attempts) if (attempts.size >= 128 && a.state !== "waiting") attempts.delete(k);
        let resolve!: Attempt["resolve"], reject!: Attempt["reject"];
        const begun = new Promise<HomeSignInChallenge>((yes, no) => { resolve = yes; reject = no; });
        const attempt: Attempt = { id: id(), provider, actor: { ...actor }, generation: serverGeneration, state: "waiting", resolve, reject };
        attempts.set(attempt.id, attempt); active.set(provider, attempt);
        void factory.start(provider).then((result: { ok: boolean; error?: string; email?: string; plan?: string }) => {
          if (attempt.state !== "waiting") return;
          attempt.state = result.ok ? "connected" : "failed";
          if (result.ok) { attempt.email = result.email; attempt.plan = result.plan; }
          else { attempt.errorCode = ["cancelled", "timeout", "disabled", "storage", "unauthorized", "offline"].includes(result.error ?? "") ? result.error : "unavailable"; reject(new HomeSignInError(attempt.errorCode!)); }
          if (active.get(provider) === attempt) active.delete(provider);
        }).catch(() => { if (attempt.state === "waiting") { attempt.state = "failed"; attempt.errorCode = "unavailable"; reject(new HomeSignInError("unavailable")); } if (active.get(provider) === attempt) active.delete(provider); });
        return begun;
      }
      if (operation === "attempt" || operation === "cancel") {
        const attempt = request.attemptId ? attempts.get(request.attemptId) : undefined;
        if (!attempt || attempt.provider !== provider || attempt.actor.deviceId !== actor.deviceId || attempt.actor.environmentId !== actor.environmentId) throw new HomeSignInError("not-found");
        if (operation === "cancel") { cancel(attempt); return null; }
        return publicAttempt(attempt);
      }
      if (operation === "signOut" || operation === "remove") {
        const attempt = active.get(provider); if (attempt) cancel(attempt);
        await factory.signOut(provider); return null;
      }
      throw new HomeSignInError("invalid-request");
    },
    attach(nextPublish?: Options["publish"], nextGeneration = generation + 1) { if (nextPublish) publish = nextPublish; generation = nextGeneration; factory.resume(); },
    disconnect(serverGeneration: number) { for (const a of active.values()) if (a.generation === serverGeneration) cancel(a); },
    invalidateOwner({ deviceId, all }: { deviceId?: string; all: boolean }) { for (const a of active.values()) if (all || a.actor.deviceId === deviceId) cancel(a); },
    internalRefresh(provider: HomeSignInProvider) { return factory.refresh(provider, { reactive: true }); },
    dispose() { disposed = true; for (const a of active.values()) cancel(a); factory.dispose(); device.dispose(); attempts.clear(); starts.clear(); },
  };
}
