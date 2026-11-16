// Owners: composio-429-f owns these desktop producers and the lifecycle consumer.
// Intent-only desktop entry points. The authority remains the sole dispatcher.
export function createDesktopComposioProducers(getAuthority) {
  return Object.freeze({
    startup: () => getAuthority().request({ operation: "refresh" }),
    credentialChange: () => getAuthority().request({ operation: "refresh" }),
    claim: () => getAuthority().request({ operation: "claim" }),
    reconnect: () => getAuthority().request({ operation: "reconnect", force: true, retryRecovery: true }),
    rejected: rejectedTokenFingerprint => getAuthority().request({ operation: "reconnect", force: true, rejectedTokenFingerprint }),
    scheduled: () => getAuthority().request({ operation: "refresh" }),
    scheduledForce: options => getAuthority().request({ operation: "reconnect", ...options }),
    online: options => getAuthority().request({ operation: options.force ? "reconnect" : "refresh", ...options }),
    resume: options => getAuthority().request({ operation: options.force ? "reconnect" : "refresh", ...options }),
  });
}
