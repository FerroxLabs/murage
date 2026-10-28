// Spec §3.5 "Relay changes". Pure: the event in, the provider request out.
// The only text is the generic sentence; the phone fetches the real one.
import { CALL_SOUND, GENERIC_TEXT, isExpiringCategory, type PushCategory, type RelayEvent } from "../../../shared/mobile-push";

export { PUSH_CONTRACT_VERSION } from "../../../shared/mobile-push";

export const IOS_CATEGORY: Record<PushCategory, string> = {
  approval: "APPROVAL", "approval-open": "APPROVAL_OPEN", question: "QUESTION", done: "DONE", resolved: "DONE", "device-job": "DEVICE_JOB", call: "CALL", "call-note": "CALL_NOTE",
};

// Contract v2: the call kinds also carry their expiry, so a phone stays
// silent for a ring that arrives after it ended.
const payload = (e: RelayEvent) => ({
  bindingId: e.bindingId, eventRef: e.eventRef, category: e.category, revision: e.revision, workspaceBadge: e.workspaceBadge, collapseKey: e.collapseKey,
  ...(isExpiringCategory(e.category) ? { expiresAt: e.expiresAt } : {}),
});

export function apnsRequest(e: RelayEvent, deviceBadge: number, token: string, topic: string) {
  const resolved = e.category === "resolved";
  const aps: Record<string, unknown> = {
    alert: GENERIC_TEXT[e.category],
    "mutable-content": 1,
    category: IOS_CATEGORY[e.category],
    "thread-id": e.threadGroup,
    badge: deviceBadge,
    "interruption-level": resolved ? "passive" : e.timeSensitive || e.category === "call" ? "time-sensitive" : "active",
  };
  if (!resolved) aps.sound = e.category === "call" ? CALL_SOUND.ios : "default";
  return {
    path: `/3/device/${token}`,
    headers: {
      "apns-topic": topic,
      "apns-push-type": "alert",
      "apns-priority": resolved ? "5" : "10",
      "apns-expiration": String(Math.floor(e.expiresAt / 1000)),
      "apns-collapse-id": e.collapseKey,
    },
    body: { aps, murage: payload(e) },
  };
}

export function fcmMessage(e: RelayEvent, token: string, packageName: string, now: number) {
  // threadGroup rides along on Android only: the app groups by bot itself (spec §4).
  // No android.collapse_key (B5): FCM keeps only four distinct collapse keys
  // per device while it is offline, so a fifth pending request would silently
  // evict one. Every event is delivered; the app replaces and dedupes by the
  // collapseKey and revision carried in data.
  const data = { ...Object.fromEntries(Object.entries(payload(e)).map(([k, v]) => [k, String(v)])), threadGroup: e.threadGroup };
  return {
    message: {
      token,
      data,
      android: { priority: "HIGH", ttl: `${Math.max(1, Math.floor((e.expiresAt - now) / 1000))}s`, restricted_package_name: packageName },
    },
  };
}
