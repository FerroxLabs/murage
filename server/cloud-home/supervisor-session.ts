import { cloudHomeCopy } from "./copy.ts";
import type { ChildProcess } from "node:child_process";
import { createHomeModelSignIn } from "./model-signin.ts";
import { createSupervisorPort } from "./supervisor-port.ts";
import { serverCredentialProjection } from "./credential-projection.ts";
import type { SealedSecretStore } from "./secrets.ts";

/** One credential owner and broker backoff for the entire supervisor lifetime. */
export function createHomeSupervisorSession(options: {
  store: Pick<SealedSecretStore, "getAll" | "patch" | "close">;
  bootstrapSecret: string;
  modelSignInFactory?: typeof createHomeModelSignIn;
  portFactory?: typeof createSupervisorPort;
  onError?: () => void;
}) {
  let closed = false, generation = 0, ready = false;
  let active: ChildProcess | undefined;
  let detach: (() => void) | undefined;
  const send = (message: object) => { if (!closed && active?.connected) active.send(message); };
  const modelSignIn = (options.modelSignInFactory ?? createHomeModelSignIn)({
    store: options.store,
    publish: entries => { if (ready) send({ type: "murage:model-signin", entries }); },
  });
  const port = (options.portFactory ?? createSupervisorPort)({
    store: options.store, send, modelSignIn, generation: () => generation,
    onModelReady: () => { ready = true; },
  });
  return {
    envelope: () => JSON.stringify({ version: 1, bootstrapSecret: options.bootstrapSecret, credentials: serverCredentialProjection(options.store.getAll()) }),
    attachChild(child: ChildProcess) {
      if (closed) throw new Error(cloudHomeCopy.homeSupervisorSessionClosed);
      detach?.();
      active = child; ready = false;
      const childGeneration = ++generation;
      const onMessage = (message: unknown) => {
        if (closed || active !== child) return;
        void port.handle(message, childGeneration).catch(() => options.onError?.());
      };
      const onDisconnect = () => {
        modelSignIn.disconnect(childGeneration);
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
      void port.configure().catch(() => options.onError?.());
    },
    close() {
      if (closed) return;
      closed = true;
      detach?.(); detach = undefined;
      modelSignIn.dispose();
      port.dispose();
      options.store.close();
    },
  };
}
