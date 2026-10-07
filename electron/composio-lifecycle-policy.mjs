// When the connected-apps lifecycle runs, and what a rejected token means.
//
// Pure decisions, so they are tested without Electron. `main.mjs` supplies the
// clock, the credential store and the mint.
import { brokerTokenFingerprint, FLUX_BROKER_TOKEN } from "./flux-composio-token.mjs";

export const LIFECYCLE_INTERVAL_MS = 10 * 60_000;
export const LIFECYCLE_RATE_LIMIT_BACKOFF_MS = 60 * 60_000;
/** After a failed mint (offline, a timeout, the service restarting): soon,
 * backing off, and never longer than the ordinary timer. */
export const TRANSIENT_BACKOFF_MS = Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000]);

/** Milliseconds until the next lifecycle pass. */
export function lifecycleDelay({ transientFailures = 0, rateLimited = false } = {}) {
  if (rateLimited) return LIFECYCLE_RATE_LIMIT_BACKOFF_MS;
  if (transientFailures <= 0) return LIFECYCLE_INTERVAL_MS;
  return TRANSIENT_BACKOFF_MS[Math.min(transientFailures, TRANSIENT_BACKOFF_MS.length) - 1];
}

/** The tick's question. Offline never runs (it would only fail again); the
 * moment the network returns it runs at once, whatever backoff is pending. */
export function shouldRunLifecycleNow({ now, nextAt, online, wasOnline }) {
  if (!online) return false;
  if (!wasOnline) return true;
  return now >= nextAt;
}

/** Known names Flux may use when another device's mint pushed this one's token
 * out of the account's cap. A fast path only: ANY 401 that is not one of these
 * still recovers (one forced re-mint), and the loop guard below decides when to
 * say "another device took over". */
export const EVICTION_CODES = new Set(["broker_token_evicted", "token_evicted", "token_superseded", "token_cap_exceeded"]);
/** The credential-document error that means "another device took over". */
export const TOKEN_TAKEN_OVER = "token_taken_over";
/** The token our own automatic re-mint produced, rejected again this soon,
 * means somebody else is minting on the same account: stop, do not trade
 * evictions. */
export const AUTO_REMINT_LOOP_WINDOW_MS = 10 * 60_000;

/**
 * The decision for a rejected broker token.
 *
 *  - ignored: this install holds no token, the rejected one is not the one held
 *    (already replaced), or it was already reported as taken over.
 *  - taken-over: a known eviction code, or the token our own automatic re-mint
 *    produced is rejected inside the loop window.
 *  - backoff: the last re-mint failed a moment ago; the mint is not hammered.
 *  - failed: the re-mint left the token unchanged (503, timeout, offline). This
 *    never arms the guard, so it is never mistaken for a takeover.
 *  - reminted: one forced re-mint produced a new token, which arms the guard.
 */
export function createTokenRejectionHandler({ getCredentials, markTakenOver, remint, now = Date.now }) {
  /** The fingerprint of a token WE minted automatically, and when. */
  let armed = null;
  let lastFailedAt = 0;
  let running = null;

  const heldToken = () => {
    const token = (getCredentials() ?? {}).fluxComposioBrokerToken;
    return typeof token === "string" && FLUX_BROKER_TOKEN.test(token) ? token : null;
  };

  async function mint(fingerprintArg) {
    const before = heldToken();
    await remint(fingerprintArg);
    const after = heldToken();
    if (after && after !== before) {
      armed = { fingerprint: brokerTokenFingerprint(after), at: now() };
      lastFailedAt = 0;
      return true;
    }
    lastFailedAt = now();
    return false;
  }

  async function decide({ tokenFingerprint, code }) {
    const credentials = getCredentials() ?? {};
    const token = heldToken();
    if (!token) return "ignored";
    const fingerprint = brokerTokenFingerprint(token);
    if (tokenFingerprint && fingerprint !== tokenFingerprint) return "ignored";
    if (credentials.fluxComposioTokenError === TOKEN_TAKEN_OVER) return "ignored";
    const looping = armed !== null && armed.fingerprint === fingerprint && now() - armed.at < AUTO_REMINT_LOOP_WINDOW_MS;
    if ((code && EVICTION_CODES.has(code)) || looping) {
      await markTakenOver();
      return "taken-over";
    }
    if (lastFailedAt !== 0 && now() - lastFailedAt < TRANSIENT_BACKOFF_MS[0]) return "backoff";
    return (await mint(tokenFingerprint)) ? "reminted" : "failed";
  }

  return {
    /** Rejections that arrive together are one decision. */
    onRejected(rejection = {}) {
      if (running) return running;
      running = decide(rejection).finally(() => { running = null; });
      return running;
    },
    /** The person asked to reconnect: mint now. The new token arms the guard
     * like any other, so a device that pushes straight back is not answered
     * with another automatic mint. */
    async reconnect() {
      await mint(undefined);
    },
  };
}

/**
 * One lifecycle pass at a time, and a forced or claiming request is never lost.
 * An ordinary request shares a pass that is running; a forced one (a rejected
 * token) or a claim runs AFTER it, because the running pass was decided with
 * the old facts (a valid token) and would mint nothing.
 */
export function createLifecycleQueue(runPass) {
  let running = null;
  function run(options = {}) {
    if (running) {
      if (!options.claim && !options.force) return running;
      return running.catch(() => {}).then(() => run(options));
    }
    const pass = Promise.resolve(runPass(options)).finally(() => { if (running === pass) running = null; });
    running = pass;
    return pass;
  }
  return run;
}

/**
 * The retry clock. A five-second tick runs a due pass, runs at once when the
 * network returns, and never while offline; a wake from sleep runs one pass
 * three seconds later unless the service asked us to back off for an hour.
 * `afterPass` is how a pass reports how it went.
 */
export function createLifecycleScheduler({
  net,
  powerMonitor,
  run,
  isShuttingDown = () => false,
  now = Date.now,
  tickMs = 5_000,
  wakeDelayMs = 3_000,
}) {
  let nextAt = 0;
  let rateLimitedUntil = 0;
  let transientFailures = 0;
  let wasOnline = true;
  let timer = null;
  let wakeTimer = null;

  /** Set while a forced re-mint has not yet produced a token: every scheduled
   * retry is itself forced, so recovery never waits for the next 401. */
  let retryForce = null;
  const go = () => {
    const options = retryForce === null ? {} : { force: true, ...(retryForce ? { rejectedTokenFingerprint: retryForce } : {}) };
    void Promise.resolve(run(options)).catch(() => {});
  };
  const onResume = () => {
    if (isShuttingDown()) return;
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      if (isShuttingDown() || now() < rateLimitedUntil) return;
      go();
    }, wakeDelayMs);
    wakeTimer.unref?.();
  };

  return {
    start() {
      if (timer) return;
      nextAt = now() + lifecycleDelay();
      timer = setInterval(() => {
        if (isShuttingDown()) return;
        const online = net.isOnline();
        const was = wasOnline;
        wasOnline = online;
        if (!shouldRunLifecycleNow({ now: now(), nextAt, online, wasOnline: was })) return;
        go();
      }, tickMs);
      timer.unref?.();
      powerMonitor.on("resume", onResume);
    },
    stop() {
      clearInterval(timer);
      timer = null;
      clearTimeout(wakeTimer);
      wakeTimer = null;
      powerMonitor.removeListener("resume", onResume);
    },
    /** A pass finished: when is the next one due. */
    afterPass({ rateLimited = false, transient = false, retryForce: retry } = {}) {
      retryForce = typeof retry === "string" ? retry : null;
      transientFailures = transient ? transientFailures + 1 : 0;
      const delay = lifecycleDelay({ rateLimited, transientFailures });
      nextAt = now() + delay;
      rateLimitedUntil = rateLimited ? now() + delay : 0;
    },
  };
}
