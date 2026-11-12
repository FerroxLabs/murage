import { cloudHomeCopy } from "./copy.ts";
import type { ChildProcess } from "node:child_process";
import { createHomeModelSignIn } from "./model-signin.ts";
import { createSupervisorPort } from "./supervisor-port.ts";
import { serverCredentialProjection } from "./credential-projection.ts";
import { completeFluxSubkey, peekFluxSubkey } from "./flux-subkey-delivery.ts";
import type { SealedSecretStore } from "./secrets.ts";
import { emailBootFields } from "./email-keystore.ts";
import { createFluxDeviceCodeClient } from "./flux-device-code-client.ts";
import { EMAIL_SIGNIN_AVAILABILITY, EMAIL_SIGNIN_TTL_MS } from "./email-signin-availability.ts";
import { stubFluxDeviceCodeClient } from "./email-owner-signin.ts";

/** One credential owner and broker backoff for the entire supervisor lifetime. */
export function createHomeSupervisorSession(options: {
  store: Pick<SealedSecretStore, "getAll" | "patch" | "close"> & Partial<Pick<SealedSecretStore, "readBack" | "patchDurable">>;
  bootstrapSecret: string;
  modelSignInFactory?: typeof createHomeModelSignIn;
  portFactory?: typeof createSupervisorPort;
  /** The cloudBotEmail flag (default off): adds the keystore boot fields and lets the port accept the email save. */
  emailStore?: boolean;
  /** The existing Flux routing base, changed by the image build for staging. No origin means no network client. */
  fluxBaseUrl?: string;
  fetch?: typeof fetch;
  onError?: () => void;
  /** Directory the root poller hands renewed Flux sub-keys through (see flux-subkey-delivery.ts). */
  fluxSubkeyDir?: string;
  /** The uid that owns the hand-off (the root poller). Production: 0. Tests that make the files as themselves pass their own uid. */
  fluxPollerUid?: number;
}) {
  let closed = false, generation = 0, ready = false;
  let active: ChildProcess | undefined;
  let detach: (() => void) | undefined;
  const send = (message: object) => { if (!closed && active?.connected) active.send(message); };
  const modelSignIn = (options.modelSignInFactory ?? createHomeModelSignIn)({
    store: options.store,
    publish: entries => { if (ready) send({ type: "murage:model-signin", entries }); },
  });
  const emailDeviceCode = options.fluxBaseUrl ? createFluxDeviceCodeClient({ baseUrl: options.fluxBaseUrl, fetch: options.fetch ?? globalThis.fetch }) : stubFluxDeviceCodeClient;
  const port = (options.portFactory ?? createSupervisorPort)({
    store: options.store, send, modelSignIn, generation: () => generation, emailStore: options.emailStore, emailDeviceCode,
    onModelReady: () => { ready = true; },
  });
  let emailTimer: ReturnType<typeof setTimeout> | undefined;
  let emailChecking = false;
  const checkEmail = async () => {
    if (closed || options.emailStore !== true || emailChecking) return;
    emailChecking = true;
    if (emailTimer) clearTimeout(emailTimer);
    // Expire the old report before the network read; a timeout is unavailable throughout.
    send({ type: EMAIL_SIGNIN_AVAILABILITY, available: false, ttlMs: 0 });
    try {
      const status = await emailDeviceCode.availability?.();
      if (closed) return;
      if (status?.available) port.fluxCallSucceeded();
      // Cache hits use a monotonic fractional clock. Round down so the report never outlives the cached capability.
      const ttlMs = status?.available === true ? Math.floor(Math.min(EMAIL_SIGNIN_TTL_MS, status.retryAfterMs)) : 0;
      send({ type: EMAIL_SIGNIN_AVAILABILITY, available: ttlMs > 0, ttlMs });
      if (status) {
        emailTimer = setTimeout(() => { void checkEmail(); }, Math.max(1, Math.ceil(status.retryAfterMs))); emailTimer.unref();
      }
    } finally { emailChecking = false; }
  };
  // Read the hand-off, seal the key, and only THEN write the receipt and remove the hand-off. A failed
  // seal leaves the hand-off in place, so the next cycle retries; the poller acks only on the receipt.
  let applying = false;
  const applyHandoff = async () => {
    if (applying || closed || !options.fluxSubkeyDir) return;
    const delivery = peekFluxSubkey(options.fluxSubkeyDir, options.fluxPollerUid ?? 0);
    if (!delivery) return;
    applying = true;
    try { await port.applyFluxSubkey(delivery.key, delivery.generation, delivery.writtenAtMs); completeFluxSubkey(delivery, options.fluxSubkeyDir, options.fluxPollerUid ?? 0); }
    catch { options.onError?.(); }
    finally { applying = false; }
  };
  const subkeyTimer = options.fluxSubkeyDir ? setInterval(() => { void applyHandoff(); }, 30_000) : undefined;
  subkeyTimer?.unref();
  return {
    envelope: () => JSON.stringify({ version: 1, bootstrapSecret: options.bootstrapSecret, credentials: serverCredentialProjection(options.store.getAll()), ...(options.emailStore === true && options.store.patchDurable ? emailBootFields(options.store as Pick<SealedSecretStore, "getAll" | "patchDurable">, true) : {}) }),
    attachChild(child: ChildProcess) {
      if (closed) throw new Error(cloudHomeCopy.homeSupervisorSessionClosed);
      detach?.();
      active = child; ready = false;
      const childGeneration = ++generation;
      const onMessage = (message: unknown) => {
        if (closed || active !== child) return;
        // Replay after the server installs its listener. The client cache preserves the capability backoff.
        if ((message as { type?: unknown } | null)?.type === "murage:cloud-model-signin-ready") void checkEmail().catch(() => options.onError?.());
        void port.handle(message, childGeneration).catch(() => options.onError?.());
      };
      const onDisconnect = () => {
        modelSignIn.disconnect(childGeneration);
        port.disconnect?.(childGeneration);
        child.removeListener("message", onMessage);
        child.removeListener("disconnect", onDisconnect);
        child.removeListener("exit", onDisconnect);
        if (active === child) { active = undefined; ready = false; }
      };
      detach = onDisconnect;
      child.on("message", onMessage);
      child.once("disconnect", onDisconnect);
      child.once("exit", onDisconnect);
      // The server announces READY after installing its private gateway listener.
      // The port then calls manager.attach(), replaying the current sealed entries.
      void checkEmail().catch(() => options.onError?.());
      void port.configure().catch(() => options.onError?.());
    },
    close() {
      if (closed) return;
      closed = true;
      if (subkeyTimer) clearInterval(subkeyTimer);
      if (emailTimer) clearTimeout(emailTimer);
      detach?.(); detach = undefined;
      modelSignIn.dispose();
      port.dispose();
      options.store.close();
    },
  };
}
