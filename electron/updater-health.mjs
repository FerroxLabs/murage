// What a failed update check says about itself, and when a person should be told.
// Background checks fail quietly by design (offline laptops are normal), so the only
// way a stuck feed becomes visible is a streak of failures that outlasts a day.
export const STALE_CHECK_AFTER_MS = 24 * 60 * 60 * 1000;

const SAFE_TOKEN = /^[A-Za-z0-9_:.-]{1,64}$/;

/** One log-safe line naming why a check failed: the error code and HTTP status when
 * there is one. Never the message, which can carry URLs, headers or tokens. */
export function describeCheckFailure(error, stage = "provider") {
  const parts = [`stage=${stage}`];
  const code = error?.code;
  if (typeof code === "string" && SAFE_TOKEN.test(code)) parts.push(`code=${code}`);
  const status = error?.statusCode ?? error?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) parts.push(`status=${status}`);
  const net = typeof error?.message === "string" ? /^net::([A-Z_]{3,40})/.exec(error.message) : null;
  if (net) parts.push(`net=${net[1]}`);
  if (parts.length === 1) parts.push(`name=${SAFE_TOKEN.test(error?.name ?? "") ? error.name : "Error"}`);
  return `Update check failed (${parts.join(" ")})`;
}

export function isNoPublishedVersions(error) {
  return error?.code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS";
}

/** Tracks one streak of failed checks. `onStale(sinceIso)` fires once per streak, after
 * the threshold; `onRecovered()` fires when a check works again after it fired. */
export function createCheckHealth({ now = Date.now, thresholdMs = STALE_CHECK_AFTER_MS, onStale = () => {}, onRecovered = () => {} } = {}) {
  let firstFailureAt = null;
  let raised = false;
  return {
    failed() {
      const at = now();
      if (firstFailureAt === null) firstFailureAt = at;
      if (!raised && at - firstFailureAt >= thresholdMs) {
        raised = true;
        onStale(new Date(firstFailureAt).toISOString());
      }
    },
    succeeded() {
      const wasRaised = raised;
      firstFailureAt = null;
      raised = false;
      if (wasRaised) onRecovered();
    },
  };
}
