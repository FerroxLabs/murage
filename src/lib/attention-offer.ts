// NOTIFY-EVERYWHERE-1019 S3: a window offers each notification to the desktop's router instead of showing it, whenever the bridge exists.
// Only routing identity crosses (kind, ids, an opaque ref this module chose): never a title or a body. Main answers with the decision
// and, when the event is to be shown through the notification rungs, sends the SAME ref back; this window then shows it with the
// display code it already has. The same ref later carries a close (the card settled, a surface was withdrawn) and a previews message
// (the owner turned details off: anything still waiting is re-worded with the allowlisted words, never shown with the old text). No
// bridge (a browser tab) or a failed offer: the event is shown at once, exactly as before, so a notification is never lost to the
// router being absent or broken.
import { notificationBridge } from "./cloud-workspace";

export interface AttentionOffer {
  kind: string;
  ref: string;
  botId?: string;
  threadId?: string;
  messageId?: string;
  requestId?: string;
  requestTurnId?: string;
  deliveryId?: string;
  durationMs?: number;
}

export type AttentionMessage = { type: "show" | "close"; ref: string } | { type: "previews"; previews: boolean };

export interface AttentionBridge {
  offer(payload: AttentionOffer | { kind: "attention.settled"; threadId: string; requestId: string } | { kind: "attention.config" }): Promise<{ ok: boolean; decision?: string }>;
  visible(payload: { threadId: string | null; focused: boolean }): Promise<unknown>;
  onShow(callback: (message: AttentionMessage) => void): () => void;
}

export function attentionBridge(): AttentionBridge | undefined {
  return notificationBridge()?.attention;
}

type Frame = { kind: string } & Record<string, unknown>;
type Show = (frame: Frame) => void | (() => void);

const MAX_PENDING = 256;
/** Decisions after which main will never send this ref back: the waiting display is dropped at once. */
const WAITS_FOR_MAIN = new Set(["held", "notify", "plain", "receipt-notify"]);
const pending = new Map<string, { frame: Frame; show: Show }>();
const shown = new Map<string, () => void>();
let counter = 0;
let listeningTo: AttentionBridge | null = null;
let stopListening: (() => void) | null = null;
let lastVisible = "";

const GENERIC_BODY: Record<string, string> = {
  done: "A task has finished.",
  "turn-failed": "A task needs review after a failure.",
  "routine-failed": "A task needs review after a failure.",
  "memories-waiting": "Memories are waiting for you.",
};
/** The same allowlisted words the server uses with details hidden. */
export function genericFrame(frame: Frame): Frame {
  // An allowlist, never a spread: only the kind and routing ids survive, so no field the server adds later can carry old text.
  const out: Frame = { kind: frame.kind, botName: "", title: "Murage", body: GENERIC_BODY[frame.kind] ?? "Your attention is needed.", privatePreview: true };
  for (const field of ["botId", "threadId", "messageId", "requestId", "requestTurnId", "deliveryId"]) if (typeof frame[field] === "string") out[field] = frame[field];
  if (typeof frame.durationMs === "number") out.durationMs = frame.durationMs;
  return out;
}

function fire(ref: string): void {
  const waiting = pending.get(ref);
  if (!waiting) return;
  pending.delete(ref);
  try {
    const closer = waiting.show(waiting.frame);
    if (typeof closer === "function") {
      shown.set(ref, closer);
      while (shown.size > MAX_PENDING) shown.delete(shown.keys().next().value!);
    }
  } catch { /* one failed display never stops the next */ }
}

function drop(ref: string): void {
  pending.delete(ref);
  const closer = shown.get(ref);
  shown.delete(ref);
  try { closer?.(); } catch { /* a banner the OS already closed */ }
}

function handle(message: AttentionMessage): void {
  if (message.type === "show") fire(message.ref);
  else if (message.type === "close") drop(message.ref);
  else if (message.type === "previews" && message.previews === false) {
    // Details were just hidden: nothing still waiting may later appear with the old text.
    for (const waiting of pending.values()) waiting.frame = genericFrame(waiting.frame);
  }
}

const ID_FIELDS = ["botId", "threadId", "messageId", "requestId", "requestTurnId", "deliveryId"] as const;

/** The routing-only payload for one notification frame. Pure; never reads text. */
export function routingPayload(frame: Record<string, unknown>, ref: string): AttentionOffer {
  const payload: AttentionOffer = { kind: String(frame.kind), ref };
  for (const field of ID_FIELDS) {
    const value = frame[field];
    if (typeof value === "string" && value) payload[field] = value;
  }
  if (typeof frame.durationMs === "number" && Number.isFinite(frame.durationMs) && frame.durationMs >= 0) payload.durationMs = frame.durationMs;
  return payload;
}

/** Offer `frame` to the router; `show` is today's display, run when the router says show (or at once with no router). */
export function routeNotification(frame: Frame, show: Show, bridge: AttentionBridge | undefined = attentionBridge()): void {
  if (!bridge) { show(frame); return; }
  if (listeningTo !== bridge) {
    let stop: (() => void) | null;
    try { stop = bridge.onShow(handle); } catch { show(frame); return; } // not committed: the next offer tries the listener again
    stopListening?.();
    stopListening = stop;
    listeningTo = bridge;
  }
  const ref = `n${(++counter).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  pending.set(ref, { frame, show });
  while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
  let offered: Promise<{ ok: boolean; decision?: string }>;
  try { offered = bridge.offer(routingPayload(frame, ref)); } catch { fire(ref); return; }
  void Promise.resolve(offered).then(
    (answer) => {
      if (!answer || answer.ok !== true) { fire(ref); return; } // refused, undelivered or broken: show it ourselves
      if (typeof answer.decision === "string" && !WAITS_FOR_MAIN.has(answer.decision)) pending.delete(ref);
    },
    () => fire(ref),
  );
}

/** Tell the router which conversation is on screen and whether this window has focus; only changes cross. */
export function reportAttentionVisible(threadId: string | null, focused: boolean, bridge: AttentionBridge | undefined = attentionBridge()): void {
  if (!bridge) return;
  const key = `${threadId ?? ""}|${focused}`;
  if (key === lastVisible) return;
  lastVisible = key;
  try { void Promise.resolve(bridge.visible({ threadId, focused })).catch(() => { lastVisible = ""; }); } catch { lastVisible = ""; }
}

/** A card settled (the stream's attention.settled frame): the router folds every surface for it. Idempotent in main. */
export function forwardAttentionSettled(frame: { threadId?: unknown; requestId?: unknown }, bridge: AttentionBridge | undefined = attentionBridge()): void {
  if (!bridge || typeof frame.threadId !== "string" || typeof frame.requestId !== "string") return;
  try { void Promise.resolve(bridge.offer({ kind: "attention.settled", threadId: frame.threadId, requestId: frame.requestId })).catch(() => {}); } catch { /* the router is best effort here */ }
}

/** The configuration changed (the stream's config frame, no content): main re-reads this home's detail setting and acts on a change. */
export function forwardAttentionConfig(bridge: AttentionBridge | undefined = attentionBridge()): void {
  if (!bridge) return;
  try { void Promise.resolve(bridge.offer({ kind: "attention.config" })).catch(() => {}); } catch { /* the router is best effort here */ }
}

/** Tests only. */
export function resetAttentionOffer(): void {
  pending.clear();
  shown.clear();
  stopListening?.();
  stopListening = null;
  listeningTo = null;
  lastVisible = "";
  counter = 0;
}
