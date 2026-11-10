// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// S3R: main owns notification surfaces. This table retains only renderer payloads.
import { notificationBridge } from "./cloud-workspace";

export interface AttentionOffer {
  session: string;
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
export interface AttentionDisplay {
  title: string;
  body: string;
  botId: string;
  threadId: string;
  privatePreview: boolean;
  silent: boolean;
  icon?: string;
}
export type AttentionMessage =
  | { type: "show"; session: string; ref: string; gen: number; previews: boolean }
  | { type: "close"; session: string; ref: string; gen: number }
  | { type: "previews"; session: string; previews: boolean };
export type AttentionOfferReply = { ok: true; decision: string; retired: string[] } | { ok: false };
export type AttentionPresentReply =
  | { ok: true; kept: boolean; retired: string[] }
  | { ok: false; stale: true; retired: string[] }
  | { ok: false; stale?: false };
type Control = { kind: "attention.settled"; threadId: string; requestId: string } | { kind: "attention.config" };
export interface AttentionBridge {
  hello(payload: { session: string }): Promise<{ ok: true; ledgerMax: number; retired: string[] } | { ok: false }>;
  offer(payload: AttentionOffer | (Control & { session: string })): Promise<AttentionOfferReply>;
  visible(payload: { session: string; threadId: string | null; focused: boolean }): Promise<unknown>;
  present(payload: AttentionDisplay & { session: string; ref: string; gen: number }): Promise<AttentionPresentReply>;
  gone(payload: { session: string; ref: string; gen: number }): Promise<{ ok: boolean; retired?: string[] }>;
  freed(payload: { session: string; refs: string[] }): void | Promise<unknown>;
  onShow(callback: (message: AttentionMessage) => void): () => void;
}
export function attentionBridge(): AttentionBridge | undefined {
  return notificationBridge()?.attention;
}

type Frame = { kind: string } & Record<string, unknown>;
type Display = (frame: Frame) => AttentionDisplay | void | (() => void);
type Payload = { frame: Frame; display: Display; phase: "unoffered" | "offering" | "admitted" };
const OFFER_CREDIT = 32;
const UNOFFERED_LIMIT = 64;
const payloads = new Map<string, Payload>();
// These sets contain identities only. A rejected offer retains one credit, including between retries.
const unresolved = new Set<string>();
const acknowledgements = new Set<string>();
let credit = 0;
let counter = 0;
let nonce: string | undefined;
let listeningTo: AttentionBridge | null = null;
let stopListening: (() => void) | null = null;
let helloPending: Promise<boolean> | null = null;
let ready = false;
let lastVisible = "";
let ackScheduled = false;
let lifecycle = 0;
let displayDepth = 0;
// Main assigns each SENT generation synchronously before its push. The IPC channel is ordered,
// so a watermark also suppresses repeats after payload deletion without an unbounded history.
let answeredThrough = 0;

/** The existing store callback reaches showNotification, which returns fields while this is true. */
export function collectingAttentionDisplay(): boolean { return displayDepth > 0; }

function session(): string {
  if (nonce === undefined) {
    const words = crypto.getRandomValues(new Uint32Array(4));
    let value = 0n;
    for (const word of words) value = (value << 32n) | BigInt(word);
    nonce = value.toString(36).padStart(25, "0");
  }
  return nonce;
}

const GENERIC_BODY: Record<string, string> = {
  done: "A task has finished.",
  "turn-failed": "A task needs review after a failure.",
  "routine-failed": "A task needs review after a failure.",
  "memories-waiting": "Memories are waiting for you.",
};
const ID_FIELDS = ["botId", "threadId", "messageId", "requestId", "requestTurnId", "deliveryId"] as const;
/** Only routing fields survive a previews-off instruction. */
export function genericFrame(frame: Frame): Frame {
  const out: Frame = { kind: frame.kind, botName: "", title: "Murage", body: GENERIC_BODY[frame.kind] ?? "Your attention is needed.", privatePreview: true };
  for (const field of ID_FIELDS) if (typeof frame[field] === "string") out[field] = frame[field];
  if (typeof frame.durationMs === "number") out.durationMs = frame.durationMs;
  return out;
}

/** The offer carries identity only; display words cross exclusively in present. */
export function routingPayload(frame: Record<string, unknown>, ref: string): Omit<AttentionOffer, "session"> {
  const payload: Omit<AttentionOffer, "session"> = { kind: String(frame.kind), ref };
  for (const field of ID_FIELDS) {
    const value = frame[field];
    if (typeof value === "string" && value) payload[field] = value;
  }
  if (typeof frame.durationMs === "number" && Number.isFinite(frame.durationMs) && frame.durationMs >= 0) payload.durationMs = frame.durationMs;
  return payload;
}

function acknowledge(ref: string): void {
  acknowledgements.add(ref);
  if (ackScheduled) return;
  ackScheduled = true;
  const life = lifecycle;
  queueMicrotask(() => {
    if (life !== lifecycle) return;
    ackScheduled = false;
    const refs = [...acknowledgements];
    acknowledgements.clear();
    if (!refs.length || !listeningTo) return;
    try { void Promise.resolve(listeningTo.freed({ session: session(), refs })).catch(() => {}); }
    catch { /* A later reply replays unacknowledged refs. */ }
  });
}

function drop(ref: string): void {
  payloads.delete(ref);
  if (unresolved.delete(ref)) credit -= 1;
  acknowledge(ref); // Unknown closes and replayed refs also acknowledge main's ledger.
}

function replay(answer: unknown): void {
  if (!answer || typeof answer !== "object" || !("retired" in answer) || !Array.isArray(answer.retired)) return;
  for (const ref of answer.retired) if (typeof ref === "string") drop(ref);
}

function succeeded(answer: unknown): void {
  replay(answer);
  if (!ready || !listeningTo) return;
  const retry = [...unresolved];
  unresolved.clear();
  for (const ref of retry) sendOffer(ref, listeningTo, false);
  drain();
}

/** All fulfilled invokes replay retired refs and wake unresolved offers, including refused invokes. */
function invoke(call: () => Promise<unknown>, then?: (answer: unknown) => void, rejected?: () => void): void {
  const life = lifecycle;
  try {
    void Promise.resolve(call()).then((answer) => {
      if (life !== lifecycle) return;
      then?.(answer);
      succeeded(answer);
    }, () => { if (life === lifecycle) rejected?.(); });
  } catch { if (life === lifecycle) rejected?.(); }
}

function handle(message: AttentionMessage, bridge: AttentionBridge): void {
  if (bridge !== listeningTo || message.session !== nonce) return;
  if (message.type === "close") { drop(message.ref); drain(); return; }
  if (message.type === "previews") {
    if (!message.previews) for (const payload of payloads.values()) payload.frame = genericFrame(payload.frame);
    return;
  }
  if (message.gen <= answeredThrough) return;
  answeredThrough = message.gen;
  const payload = payloads.get(message.ref);
  const identity = { session: session(), ref: message.ref, gen: message.gen };
  if (!payload) { invoke(() => bridge.gone(identity)); return; }
  let words: ReturnType<Display>;
  try {
    displayDepth += 1;
    words = payload.display(message.previews ? payload.frame : genericFrame(payload.frame));
  } catch { invoke(() => bridge.gone(identity)); return; }
  finally { displayDepth -= 1; }
  if (!words || typeof words !== "object") { invoke(() => bridge.gone(identity)); return; }
  // Enforce the wire bounds even for a display callback other than showNotification.
  const privatePreview = !message.previews || payload.frame.privatePreview === true || words.privatePreview;
  const fields: AttentionDisplay = {
    title: words.title.slice(0, 256), body: words.body.slice(0, 1024),
    botId: words.botId, threadId: words.threadId, privatePreview, silent: words.silent,
  };
  if (!privatePreview && typeof words.icon === "string" && words.icon.length <= 65536 && /^data:image\/png;base64,[a-z0-9+/]*={0,2}$/i.test(words.icon)) fields.icon = words.icon;
  invoke(() => bridge.present({ ...fields, ...identity }), (answer) => {
    if (!answer || typeof answer !== "object" || !("ok" in answer) || answer.ok !== true || !("kept" in answer) || answer.kept !== true) drop(message.ref);
  }); // Rejection retains the payload and never retries present.
}

function connect(bridge: AttentionBridge): Promise<boolean> {
  // Mint before subscribing; a subscription can synchronously deliver a push.
  const ownSession = session();
  if (listeningTo !== bridge) {
    let stop: () => void;
    try { stop = bridge.onShow((message) => handle(message, bridge)); }
    catch { return Promise.resolve(false); }
    try { stopListening?.(); } catch { /* The former listener may already be detached. */ }
    stopListening = stop;
    listeningTo = bridge;
    ready = false;
    helloPending = null;
    lastVisible = "";
  }
  if (ready) return Promise.resolve(true);
  if (helloPending) return helloPending;
  const life = lifecycle;
  // Invoke hello immediately after the listener was committed, before any offers.
  let result: ReturnType<AttentionBridge["hello"]>;
  try { result = bridge.hello({ session: ownSession }); }
  catch { return Promise.resolve(false); }
  const pending = Promise.resolve(result).then((answer) => {
    if (life !== lifecycle || listeningTo !== bridge) return false;
    ready = answer?.ok === true;
    succeeded(answer);
    return ready;
  }, () => false).finally(() => { if (helloPending === pending) helloPending = null; });
  helloPending = pending;
  return pending;
}

function sendOffer(ref: string, bridge: AttentionBridge, retryImmediately: boolean): void {
  const payload = payloads.get(ref);
  if (!payload) { credit -= 1; drain(); return; }
  const offer = { ...routingPayload(payload.frame, ref), session: session() };
  invoke(() => bridge.offer(offer), (answer) => {
    credit -= 1;
    const current = payloads.get(ref);
    if (!answer || typeof answer !== "object" || !("ok" in answer) || answer.ok !== true) drop(ref);
    else if (current) current.phase = "admitted";
  }, () => {
    if (!payloads.has(ref)) { credit -= 1; drain(); }
    else if (retryImmediately) sendOffer(ref, bridge, false);
    else unresolved.add(ref);
  });
}

function drain(): void {
  if (!ready || !listeningTo) return;
  for (const [ref, payload] of payloads) {
    if (credit >= OFFER_CREDIT) break;
    if (payload.phase !== "unoffered") continue;
    payload.phase = "offering";
    credit += 1;
    sendOffer(ref, listeningTo, true);
  }
}

/** With a bridge the callback supplies fields. Only the no-bridge path displays locally. */
export function routeNotification(frame: Frame, display: Display, bridge: AttentionBridge | undefined = attentionBridge()): void {
  if (!bridge) { display(frame); return; }
  const ref = `n${(++counter).toString(36)}`;
  payloads.set(ref, { frame, display, phase: "unoffered" });
  void connect(bridge);
  drain();
  const waiting = [...payloads].filter(([, payload]) => payload.phase === "unoffered");
  if (waiting.length > UNOFFERED_LIMIT) {
    payloads.delete(waiting[0]![0]);
    console.warn("Notification queue is full; dropped the oldest unoffered frame.");
  }
}

/** Visibility is a control invoke, so it also replays retirements and resumes unresolved offers. */
export function reportAttentionVisible(threadId: string | null, focused: boolean, bridge: AttentionBridge | undefined = attentionBridge()): void {
  if (!bridge) return;
  const connected = connect(bridge);
  const key = `${threadId ?? ""}|${focused}`;
  if (key === lastVisible) return;
  lastVisible = key;
  const life = lifecycle;
  void connected.then((ok) => {
    if (life !== lifecycle || bridge !== listeningTo) return;
    if (!ok) { lastVisible = ""; return; }
    invoke(() => bridge.visible({ session: session(), threadId, focused }), undefined, () => { if (lastVisible === key) lastVisible = ""; });
  });
}

function control(payload: Control, bridge: AttentionBridge): void {
  const life = lifecycle;
  void connect(bridge).then((ok) => {
    if (ok && life === lifecycle && bridge === listeningTo) invoke(() => bridge.offer({ ...payload, session: session() }));
  });
}
export function forwardAttentionSettled(frame: { threadId?: unknown; requestId?: unknown }, bridge: AttentionBridge | undefined = attentionBridge()): void {
  if (bridge && typeof frame.threadId === "string" && typeof frame.requestId === "string") control({ kind: "attention.settled", threadId: frame.threadId, requestId: frame.requestId }, bridge);
}
export function forwardAttentionConfig(bridge: AttentionBridge | undefined = attentionBridge()): void {
  if (bridge) control({ kind: "attention.config" }, bridge);
}

/** Tests only. Clearing a listener never changes this document's nonce or reuses a ref. */
export function resetAttentionOffer(): void {
  lifecycle += 1;
  payloads.clear(); unresolved.clear(); acknowledgements.clear();
  credit = 0; ackScheduled = false; ready = false; helloPending = null; answeredThrough = 0;
  stopListening?.(); stopListening = null; listeningTo = null; lastVisible = "";
}
