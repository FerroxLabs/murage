export interface GracefulShutdownOptions {
  cleanup: ReadonlyArray<() => void | Promise<void>>;
  exit: (code: number) => void;
  timeoutMs?: number;
}

/** Build one idempotent shutdown callback for process signals. Cleanup jobs
 * run together, but a wedged provider cannot keep the desktop child alive
 * forever. The browser capability clear is one of these jobs, so a normal
 * server stop does not leave a turn bearer usable until its absolute TTL. */
export function createGracefulShutdown({
  cleanup,
  exit,
  timeoutMs = 6_000,
}: GracefulShutdownOptions): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    const settled = Promise.allSettled(cleanup.map((job) => Promise.resolve().then(job)))
      .then(() => undefined);

    void Promise.race([settled, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
      exit(0);
    });
  };
}

/** The desktop's "close by yourself" request (electron/server-child-lifecycle.mjs
 * GRACEFUL_CLOSE_MESSAGE), answered like SIGTERM. Windows has no signal the
 * harness can catch: without this, quitting Murage there hard-terminates the
 * harness and a waiting run never says Murage closed (G12). */
export const APP_CLOSE_REQUEST_TYPE = "murage:close";

export function isAppCloseRequest(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === APP_CLOSE_REQUEST_TYPE;
}
