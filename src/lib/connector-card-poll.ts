// The connect card's poll for a sign-in, as a function so it can be tested
// without a DOM. It always ends: connected, failed (the provider ended the
// link), or a final timed-out call once the budget is spent.

/** Five seconds a try, for at least the sign-in link's whole life (ten
 * minutes). The provider does not say how long a link lives. */
export const CONNECTOR_POLL_INTERVAL_MS = 5_000;
export const CONNECTOR_POLL_MAX_TRIES = 120;

export interface ConnectorPollOptions {
  check: () => Promise<{ connected: boolean; failed?: boolean }>;
  /** Called once when the budget is spent without connecting or failing. */
  onTimeout: () => Promise<unknown> | unknown;
  intervalMs?: number;
  maxTries?: number;
}

/** Start polling; returns the function that stops it. */
export function startConnectorPoll(options: ConnectorPollOptions): () => void {
  const intervalMs = options.intervalMs ?? CONNECTOR_POLL_INTERVAL_MS;
  const maxTries = options.maxTries ?? CONNECTOR_POLL_MAX_TRIES;
  let stopped = false;
  let running = false;
  let tries = 0;
  const finish = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    options.check()
      .then((result) => {
        if (stopped) return;
        tries += 1;
        if (result.connected || result.failed) finish();
      })
      .catch(() => {
        if (!stopped) tries += 1;
      })
      .finally(() => {
        running = false;
        if (!stopped && tries >= maxTries) {
          finish();
          void Promise.resolve(options.onTimeout()).catch(() => {});
        }
      });
  }, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** The card's sentence when its wait ends unfinished (the server says the same). */
export const CONNECTOR_TIMED_OUT_SENTENCE = "The sign-in link expired before it was finished. Try again.";

/**
 * The wait is over. The card is shown as timed out FIRST, locally, so it ends
 * even when the network is down; then the server is told, best effort, and may
 * reconcile (the sign-in finished just now, or it has a more exact sentence).
 */
export async function endConnectorWait(input: {
  show: (state: { timedOut: boolean; error: string }) => void;
  notify: () => Promise<{ connected?: boolean; error?: string } | undefined | void>;
}): Promise<void> {
  input.show({ timedOut: true, error: CONNECTOR_TIMED_OUT_SENTENCE });
  try {
    const result = await input.notify();
    if (!result) return;
    if (result.connected) input.show({ timedOut: false, error: "" });
    else if (typeof result.error === "string" && result.error) input.show({ timedOut: true, error: result.error });
  } catch {
    // offline: the card already says what happened
  }
}
