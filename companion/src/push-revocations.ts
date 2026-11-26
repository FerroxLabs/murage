// Removing a device must reach the harness, which owns the relay binding.
// The door writes the device id down first, so a harness that is restarting
// still hears about it; the tokens themselves died with the device record.
//
// Settings v10 P1: the queue is keyed by (device, removal generation) and keeps what the harness answered. The harness's 200 means "queued
// there", not "the relay deleted it", so an entry reads `confirmed` only when the harness says so, and `status` is readable after the device
// row is gone and after a restart. A second producer for the same removal is a no-op; a re-add after the removal settled is a new generation.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HarnessCall } from "./push-door.ts";

const MAX = 200;
/** What the harness accepts in `x-murage-push-device` (H8). Registry ids
 * are UUIDs; anything else in the file is corruption, and a string with a
 * control character in it would make every send throw, forever. */
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROOF = /^[a-f0-9]{64}$/;
const isDeviceId = (id: unknown): id is string => typeof id === "string" && DEVICE_ID.test(id);

export type PushStep = "not-sent" | "harness-queued" | "confirmed" | "abandoned" | "nothing";
/** What the harness says about one removal generation. */
export interface HarnessRemoval { state: "queued" | "confirmed" | "abandoned" | "nothing"; removalId: string | null }
interface Entry { id: string; gen: number; step: PushStep; removalId?: string }
/** pending: the notifications step is not finished; removed: confirmed (or the harness held nothing to remove); abandoned: the harness gave up;
 * unknown: this queue never saw the device. */
export interface PushRemovalStatus { state: "pending" | "removed" | "abandoned" | "unknown"; notifications: PushStep | "unknown"; removalId?: string }

const OWED = (e: Entry) => e.step === "not-sent" || e.step === "harness-queued";
const STEPS: readonly string[] = ["not-sent", "harness-queued", "confirmed", "abandoned", "nothing"];
const isEntry = (e: unknown): e is Entry => !!e && typeof e === "object" && isDeviceId((e as Entry).id) && Number.isSafeInteger((e as Entry).gen)
  && (e as Entry).gen >= 0 && STEPS.includes((e as Entry).step) && ((e as Entry).removalId === undefined || typeof (e as Entry).removalId === "string");

/** A generation no earlier removal of this device used, even if the queue file was lost: epoch seconds, then one past the last. */
const nextGeneration = (entries: Entry[], id: string) =>
  Math.max(Math.floor(Date.now() / 1000), ...entries.filter((e) => e.id === id).map((e) => e.gen + 1));

function parse(raw: unknown): Entry[] {
  // The first format was a bare list of ids still owed; each becomes an unsent entry.
  if (Array.isArray(raw)) return raw.filter(isDeviceId).slice(-MAX).map((id, i): Entry => ({ id, gen: Math.floor(Date.now() / 1000) + i, step: "not-sent" }));
  const list = (raw as { entries?: unknown } | null)?.entries;
  return Array.isArray(list) ? list.filter(isEntry).slice(-MAX) : [];
}
function read(file: string): Entry[] {
  try { return parse(JSON.parse(readFileSync(file, "utf8"))); } catch { return []; /* first run, or unreadable: start empty */ }
}
function summarize(entries: Entry[], id: string): PushRemovalStatus {
  const mine = entries.filter((e) => e.id === id);
  if (!mine.length) return { state: "unknown", notifications: "unknown" };
  const owed = mine.find(OWED);
  if (owed) return { state: "pending", notifications: owed.step, ...(owed.removalId ? { removalId: owed.removalId } : {}) };
  // A later generation that only found nothing to remove (a second producer for the same removal) must not hide the one that did the work,
  // and a later confirmed generation settles an earlier abandoned one: the newest generation that held a binding decides.
  const decisive = [...mine].reverse().find((e) => e.step !== "nothing") ?? mine[mine.length - 1];
  return { state: decisive.step === "abandoned" ? "abandoned" : "removed", notifications: decisive.step, ...(decisive.removalId ? { removalId: decisive.removalId } : {}) };
}
/** The recorded state of a device's push removal, read from the queue file alone (no queue running, device row gone). */
export function pushRemovalStatus(file: string, deviceId: string): PushRemovalStatus {
  return summarize(read(file), deviceId);
}

type Send = (deviceId: string, generation: number) => Promise<boolean | HarnessRemoval>;
/** "resend": the harness holds no receipt but the binding is still live, so the same generation is sent again. */
type Check = (deviceId: string, generation: number) => Promise<false | "resend" | HarnessRemoval>;

export function createPushRevocations(o: {
  file: string;
  /** `true` is the legacy answer (done); an answer object keeps the harness's receipt state. `false` is a failure, retried. */
  send: Send;
  /** Asks the harness for the receipt of an entry it already queued. Without it a queued entry is only re-asked by sending again. */
  check?: Check;
  retryMs?: number;
  /** How long one send may take before it counts as a failure, so a send
   * that never settles cannot hold the queue for the life of the process. */
  sendTimeoutMs?: number;
}) {
  let entries: Entry[] = read(o.file);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  /** The entry whose send is on the wire, and whether the device was added again
   * meanwhile. A re-add then is a new removal (an enrolment that landed
   * after the harness took the old one), so that send's answer must not
   * settle it: the new generation gets its own attempt (H7 Minor 1). */
  let inFlight: Entry | null = null;
  let dirty = false;
  const save = (): boolean => {
    try {
      mkdirSync(dirname(o.file), { recursive: true, mode: 0o700 });
      const temporary = `${o.file}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 2, entries }), { mode: 0o600 });
      renameSync(temporary, o.file);
      dirty = false;
      return true;
    } catch { dirty = true; return false; /* the in-memory copy still retries, and the caller is told */ }
  };
  const trim = () => {
    while (entries.length > MAX) {
      const drop = entries.findIndex((e) => !OWED(e));
      entries.splice(drop === -1 ? 0 : drop, 1);
    }
  };
  const schedule = () => {
    if (timer || !(entries.some(OWED) || dirty)) return;
    timer = setTimeout(() => { timer = null; void flush(); }, o.retryMs ?? 30_000);
    timer.unref?.();
  };
  const guarded = <T>(work: () => Promise<T | false>): Promise<T | false> => {
    let expire: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((resolve) => {
      expire = setTimeout(() => resolve(false), o.sendTimeoutMs ?? 20_000);
      expire.unref?.();
    });
    return Promise.race([Promise.resolve().then(work).catch((): false => false), late]).finally(() => clearTimeout(expire));
  };
  const apply = (entry: Entry, answer: boolean | "resend" | HarnessRemoval) => {
    if (answer === false) return;
    if (answer === "resend") { entry.step = "not-sent"; return; }
    if (answer === true) { entry.step = "confirmed"; return; }
    entry.step = answer.state === "queued" ? "harness-queued" : answer.state;
    if (answer.removalId) entry.removalId = answer.removalId;
  };
  const flush = (): Promise<void> => {
    if (running) return running;
    // Every entry gets one attempt per run, including ones added while it
    // runs; failures wait for the retry timer.
    const tried = new Set<Entry>();
    running = (async () => {
      if (dirty) save();
      for (;;) {
        const entry = entries.find((e) => OWED(e) && !tried.has(e));
        if (entry === undefined) break;
        tried.add(entry);
        inFlight = entry;
        const asking = entry.step === "harness-queued" && o.check !== undefined;
        const answer = await guarded<boolean | "resend" | HarnessRemoval>(() => asking ? o.check!(entry.id, entry.gen) : o.send(entry.id, entry.gen));
        inFlight = null;
        if (answer !== false && entries.includes(entry)) { apply(entry, answer); save(); }
      }
    })().finally(() => {
      running = null;
      if (entries.some((e) => OWED(e) && !tried.has(e))) void flush();
      else schedule();
    });
    return running;
  };
  return {
    /** "queued": the removal is on disk and will be told to the harness; "failed": it could not be written down (still retried). */
    add(deviceId: string): "queued" | "failed" {
      if (!isDeviceId(deviceId)) return "failed";
      const owed = entries.find((e) => e.id === deviceId && OWED(e) && e !== inFlight);
      if (!owed) {
        entries.push({ id: deviceId, gen: nextGeneration(entries, deviceId), step: "not-sent" });
        trim();
      }
      const saved = save();
      void flush();
      return saved ? "queued" : "failed";
    },
    flush,
    /** Device ids whose removal is still owed (the notifications step is not finished). */
    pending: () => [...new Set(entries.filter(OWED).map((e) => e.id))],
    status: (deviceId: string): PushRemovalStatus => summarize(entries, deviceId),
  };
}

const ANSWER_STATES = ["queued", "confirmed", "abandoned", "nothing"];
const asRemoval = (body: unknown): HarnessRemoval | false => {
  const b = body as { removalId?: unknown; state?: unknown } | null;
  if (!b || typeof b.state !== "string" || !ANSWER_STATES.includes(b.state)) return false;
  if (b.removalId !== null && b.removalId !== undefined && typeof b.removalId !== "string") return false;
  return { state: b.state as HarnessRemoval["state"], removalId: typeof b.removalId === "string" ? b.removalId : null };
};

/** The send for `createPushRevocations`: tell the harness to drop this
 * device's relay binding. Headers built from nothing, and nothing sent
 * without the launch proof — the harness would refuse it anyway. With a
 * generation it returns the harness's receipt; without one (an older caller) it returns whether the harness answered 200. */
export function revokeDeviceSender(harness: HarnessCall, companionToken: string | undefined): {
  (deviceId: string): Promise<boolean>;
  (deviceId: string, generation: number): Promise<false | HarnessRemoval>;
} {
  return (async (deviceId: string, generation?: number) => {
    if (typeof companionToken !== "string" || !PROOF.test(companionToken)) return false;
    const withGeneration = generation !== undefined;
    const answer = await harness({
      method: "POST",
      path: "/api/mobile/push/revoke-device",
      headers: { accept: "application/json", ...(withGeneration ? { "content-type": "application/json" } : {}), "x-murage-companion": "1", "x-murage-companion-token": companionToken, "x-murage-push-device": deviceId },
      body: withGeneration ? Buffer.from(JSON.stringify({ generation })) : null,
    });
    if (answer.status !== 200) return false;
    if (!withGeneration) return true;
    // An older harness answers a plain 200 with no state: what it always meant is kept, so the entry settles instead of being re-sent forever.
    if ((answer.body as { ok?: unknown } | null)?.ok === true && (answer.body as { state?: unknown }).state === undefined) return { state: "confirmed", removalId: null };
    return asRemoval(answer.body);
  }) as never;
}

/** Check again: read the harness's receipt for one removal generation. Changes nothing. */
export function removalCheckSender(harness: HarnessCall, companionToken: string | undefined): (deviceId: string, generation: number) => Promise<false | "resend" | HarnessRemoval> {
  return async (deviceId, generation) => {
    if (typeof companionToken !== "string" || !PROOF.test(companionToken)) return false;
    const answer = await harness({
      method: "GET",
      path: `/api/mobile/push/removal/${deviceId}/${generation}`,
      headers: { accept: "application/json", "x-murage-companion": "1", "x-murage-companion-token": companionToken, "x-murage-push-device": deviceId },
      body: null,
    });
    if (answer.status === 409 && (answer.body as { code?: unknown } | null)?.code === "binding_live") return "resend";
    return answer.status === 200 ? asRemoval(answer.body) : false;
  };
}

/** Spec §3.5: every device the registry removes — revoked, signed out,
 * replaced by a re-pair — goes on the queue. Returns the unsubscribe. */
export function watchDeviceRemovals(
  devices: { onDeviceRemoved(listener: (deviceId: string) => void): () => void },
  queue: { add(deviceId: string): unknown },
): () => void {
  return devices.onDeviceRemoved((deviceId) => queue.add(deviceId));
}
