// Owners: composio-429-e owns both ends of this private, generation-bound protocol.
// Bootstrap-only transport bridge. It never fetches or exposes a renderer IPC.
import { randomUUID } from "node:crypto";
export function createComposioAdmissionHost({ authority, send, isCurrent = () => true }) {
  const generation = randomUUID();
  const pending = new Map();
  let closed = false;
  const current = () => !closed && isCurrent();
  const reply = message => { if (current()) send({ ...message, generation }); };
  return Object.freeze({
    transport(url, init) {
      const entry = pending.get(init?.composioAdmission);
      if (!entry || entry.url !== String(url) || !current() || entry.admitted) return Promise.reject(new Error("admission_port_unavailable"));
      entry.admitted = true;
      reply({ type: "murage:connected-apps-admission-permit", requestId: entry.id });
      return entry.response;
    },
    receive(message) {
      if (!message || typeof message !== "object" || !String(message.type).startsWith("murage:connected-apps-admission-")) return false;
      if (!current()) return true;
      if (message.type === "murage:connected-apps-admission-hello") { reply({ type: "murage:connected-apps-admission-generation" }); return true; }
      if (message.generation !== generation || typeof message.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(message.requestId)) return true;
      const id = message.requestId;
      if (message.type === "murage:connected-apps-admission-receipt") {
        const entry = pending.get(id);
        if (!entry?.admitted || entry.received) return true;
        entry.received = true;
        if (Number.isInteger(message.status) && message.status >= 200 && message.status <= 599) {
          const headers = typeof message.retryAfter === "string" && message.retryAfter.length <= 128 ? { "retry-after": message.retryAfter } : {};
          entry.resolve(new Response(null, { status: message.status, headers }));
        } else if (message.delivery === "not-sent") {
          entry.cancelled = true;
          entry.reject(Object.assign(new Error("admission_not_dispatched"), { admissionAttempted: false }));
        } else entry.reject(new TypeError("admission_transport_failed"));
        return true;
      }
      if (message.type !== "murage:connected-apps-admission-request" || pending.has(id) || pending.size >= 200) return true;
      if (message.operation === "recovery-retry") {
        if (Object.keys(message).some(key => !["type", "generation", "requestId", "operation"].includes(key))) return true;
        const entry = { reject() {}, timer: null };
        pending.set(id, entry);
        void authority().request({ operation: "reconnect", force: true, retryRecovery: true }).then(result => {
          reply({ type: "murage:connected-apps-admission-result", requestId: id, outcome: result.outcome, reason: result.reason,
            ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }), ...(result.status === undefined ? {} : { status: result.status }),
            attempted: result.attempted, reconnected: result.reconnected === true });
        }, () => reply({ type: "murage:connected-apps-admission-result", requestId: id,
          outcome: "failed", reason: "credential_recovery_failed", attempted: false, reconnected: false }))
          .finally(() => pending.delete(id));
        return true;
      }
      if (typeof message.url !== "string" || message.url.length > 4096 || !["GET", "POST", "DELETE"].includes(message.method)) return true;
      let resolve, reject;
      const response = new Promise((yes, no) => { resolve = yes; reject = no; });
      // The timeout rejects only this generation's exact reservation.
      const timer = setTimeout(() => { const entry = pending.get(id); if (entry) entry.reject(new TypeError("admission_port_timeout")); }, 330_000);
      timer.unref?.();
      const entry = { id, url: message.url, resolve, reject, response, timer, admitted: false, received: false };
      // A held request never consumes the promise; prevent an unhandled rejection.
      void response.catch(() => {});
      pending.set(id, entry);
      void authority().request({ operation: "broker", url: message.url, tokenFingerprint: message.tokenFingerprint, init: { method: message.method, composioAdmission: id } }).then(result => {
        reply({ type: "murage:connected-apps-admission-result", requestId: id,
          outcome: result.outcome, reason: result.reason, retryAt: result.retryAt, status: result.status, attempted: result.attempted });
      }, () => {
        let status = { outcome: "deferred", reason: entry.cancelled ? "not_dispatched" : "admission_port_unavailable" };
        // An invalid child route can fail before a scope exists. Inspection is
        // advisory timing and must not strand that child's correlated result.
        try { if (!entry.cancelled) status = authority().inspect(entry.url); } catch { /* retain the closed result */ }
        reply({ type: "murage:connected-apps-admission-result", requestId: id,
          ...status, attempted: entry.admitted && !entry.cancelled });
      })
        .finally(() => { clearTimeout(timer); pending.delete(id); });
      return true;
    },
    dispose() { closed = true; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new TypeError("admission_port_disconnected")); } pending.clear(); },
  });
}
