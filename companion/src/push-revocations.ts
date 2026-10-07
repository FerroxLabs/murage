// Removing a device must reach the harness, which owns the relay binding.
// The door writes the device id down first, so a harness that is restarting
// still hears about it; the tokens themselves died with the device record.
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

export function createPushRevocations(o: {
  file: string;
  send: (deviceId: string) => Promise<boolean>;
  retryMs?: number;
  /** How long one send may take before it counts as a failure, so a send
   * that never settles cannot hold the queue for the life of the process. */
  sendTimeoutMs?: number;
}) {
  let ids: string[] = [];
  try {
    const raw = JSON.parse(readFileSync(o.file, "utf8"));
    if (Array.isArray(raw)) ids = raw.filter(isDeviceId).slice(-MAX);
  } catch { /* first run, or unreadable: start empty */ }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  /** The id whose send is on the wire, and whether it was added again
   * meanwhile. A re-add then is a new removal (an enrolment that landed
   * after the harness took the old one), so that send's 200 must not
   * clear it: it gets one more attempt instead (H7 Minor 1). */
  let inFlight: string | null = null;
  let addedDuringSend = false;
  const save = () => {
    try {
      mkdirSync(dirname(o.file), { recursive: true, mode: 0o700 });
      const temporary = `${o.file}.tmp`;
      writeFileSync(temporary, JSON.stringify(ids), { mode: 0o600 });
      renameSync(temporary, o.file);
    } catch { /* the in-memory copy still retries */ }
  };
  const schedule = () => {
    if (timer || !ids.length) return;
    timer = setTimeout(() => { timer = null; void flush(); }, o.retryMs ?? 30_000);
    timer.unref?.();
  };
  const sendOnce = (id: string): Promise<boolean> => {
    let expire: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => {
      expire = setTimeout(() => resolve(false), o.sendTimeoutMs ?? 20_000);
      expire.unref?.();
    });
    return Promise.race([Promise.resolve().then(() => o.send(id)).catch(() => false), late])
      .finally(() => clearTimeout(expire));
  };
  const flush = (): Promise<void> => {
    if (running) return running;
    // Every id gets one attempt per run, including ones added while it
    // runs; failures wait for the retry timer.
    const tried = new Set<string>();
    running = (async () => {
      for (;;) {
        const id = ids.find((x) => !tried.has(x));
        if (id === undefined) break;
        tried.add(id);
        inFlight = id;
        addedDuringSend = false;
        const sent = await sendOnce(id);
        inFlight = null;
        if (addedDuringSend) {
          // Still queued either way; after a 200 it is tried again now.
          if (sent) tried.delete(id);
          continue;
        }
        if (sent) { ids = ids.filter((x) => x !== id); save(); }
      }
    })().finally(() => {
      running = null;
      if (ids.some((x) => !tried.has(x))) void flush();
      else schedule();
    });
    return running;
  };
  return {
    add(deviceId: string) {
      if (!isDeviceId(deviceId)) return;
      if (deviceId === inFlight) addedDuringSend = true;
      if (!ids.includes(deviceId)) ids = [...ids, deviceId].slice(-MAX);
      save();
      void flush();
    },
    flush,
    pending: () => [...ids],
  };
}

/** The send for `createPushRevocations`: tell the harness to drop this
 * device's relay binding. Headers built from nothing, and nothing sent
 * without the launch proof — the harness would refuse it anyway. */
export function revokeDeviceSender(harness: HarnessCall, companionToken: string | undefined): (deviceId: string) => Promise<boolean> {
  return async (deviceId) => {
    if (typeof companionToken !== "string" || !PROOF.test(companionToken)) return false;
    const answer = await harness({
      method: "POST",
      path: "/api/mobile/push/revoke-device",
      headers: { accept: "application/json", "x-murage-companion": "1", "x-murage-companion-token": companionToken, "x-murage-push-device": deviceId },
      body: null,
    });
    return answer.status === 200;
  };
}

/** Spec §3.5: every device the registry removes — revoked, signed out,
 * replaced by a re-pair — goes on the queue. Returns the unsubscribe. */
export function watchDeviceRemovals(
  devices: { onDeviceRemoved(listener: (deviceId: string) => void): () => void },
  queue: { add(deviceId: string): void },
): () => void {
  return devices.onDeviceRemoved((deviceId) => queue.add(deviceId));
}
