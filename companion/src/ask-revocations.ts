// A phone's share-and-ask access was switched off or removed: the harness must hear the generation it is
// refused up to (`through`) before the computer says it is off. Same file-backed retry pattern as
// push-revocations.ts, but entries are { deviceId, through } and only the highest through per device is kept.
// The entry is written down before the first send, so a harness that is restarting (or a door that restarts)
// still hears about it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HarnessCall } from "./push-door.ts";

const MAX = 200;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const isDeviceId = (id: unknown): id is string => typeof id === "string" && DEVICE_ID.test(id);
const isThrough = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export interface AskRevocation { deviceId: string; through: number }

export function createAskRevocations(o: {
  file: string;
  /** true = acknowledged (the only answer that removes the entry). "not-offered" = the harness says share and ask is not
   * offered right now: waiters are released so the local action can complete, but the entry stays queued and keeps retrying. */
  send(e: AskRevocation): Promise<boolean | "not-offered">;
  retryMs?: number;
  /** How long one send may take before it counts as a failure. */
  sendTimeoutMs?: number;
}): { add(e: AskRevocation): void; acked(deviceId: string): Promise<void>; pending(): AskRevocation[] } {
  const held = new Map<string, number>();
  // Only a missing file is a first run. Any other read or parse problem leaves the file exactly as it is (it may hold revokes
  // still owed to the harness): `locked` stops every later save from replacing it, and the in-memory queue keeps retrying.
  let locked = false;
  const logOnce = (what: string) => { console.error(`[ask-revocations] ${what}; the queue file is left as it is`); };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(o.file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") { locked = true; logOnce("the queue file could not be read"); }
  }
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      locked = true;
      logOnce("the queue file is not a list");
    } else {
      const bad: unknown[] = [];
      for (const e of raw.slice(-MAX)) {
        if (e && typeof e === "object" && isDeviceId((e as AskRevocation).deviceId) && isThrough((e as AskRevocation).through)) {
          const { deviceId, through } = e as AskRevocation;
          held.set(deviceId, Math.max(held.get(deviceId) ?? 0, through));
        } else bad.push(e);
      }
      // A bad entry is never dropped: it goes to a side file first. If that cannot be written, the queue file stays untouched.
      if (bad.length > 0) {
        try {
          writeFileSync(`${o.file}.bad`, JSON.stringify(bad), { mode: 0o600 });
          logOnce("the queue file had entries that were set aside");
        } catch { locked = true; logOnce("the queue file had unreadable entries"); }
      }
    }
  }

  const waiters = new Map<string, Set<() => void>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  /** Devices already tried in this run; a failure waits for the retry timer, a higher through added meanwhile is tried again now. */
  let tried = new Set<string>();

  const save = () => {
    if (locked) return;
    try {
      mkdirSync(dirname(o.file), { recursive: true, mode: 0o700 });
      const temporary = `${o.file}.tmp`;
      writeFileSync(temporary, JSON.stringify([...held].map(([deviceId, through]) => ({ deviceId, through }))), { mode: 0o600 });
      renameSync(temporary, o.file);
    } catch { /* the in-memory copy still retries */ }
  };
  const settle = (deviceId: string) => {
    const set = waiters.get(deviceId);
    if (!set) return;
    waiters.delete(deviceId);
    for (const resolve of set) resolve();
  };
  const schedule = () => {
    if (timer || held.size === 0) return;
    timer = setTimeout(() => { timer = null; void flush(); }, o.retryMs ?? 10_000);
    timer.unref?.();
  };
  const sendOnce = (e: AskRevocation): Promise<boolean | "not-offered"> => {
    let expire: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean | "not-offered">((resolve) => {
      expire = setTimeout(() => resolve(false), o.sendTimeoutMs ?? 20_000);
      expire.unref?.();
    });
    return Promise.race([Promise.resolve().then(() => o.send(e)).catch(() => false), late]).finally(() => clearTimeout(expire));
  };
  const flush = (): Promise<void> => {
    if (running) return running;
    tried = new Set();
    running = (async () => {
      for (;;) {
        const next = [...held].find(([id]) => !tried.has(id));
        if (!next) break;
        const [deviceId, through] = next;
        tried.add(deviceId);
        const sent = await sendOnce({ deviceId, through });
        if (sent === "not-offered") { settle(deviceId); continue; }
        if (sent !== true) continue;
        // A higher through that arrived while this one was on the wire is still owed: send it now.
        if ((held.get(deviceId) ?? 0) > through) { tried.delete(deviceId); continue; }
        held.delete(deviceId);
        save();
        settle(deviceId);
      }
    })().finally(() => {
      running = null;
      if ([...held.keys()].some((id) => !tried.has(id))) void flush();
      else schedule();
    });
    return running;
  };

  if (held.size > 0) void flush();

  return {
    add(e) {
      if (!isDeviceId(e.deviceId) || !isThrough(e.through)) return;
      held.set(e.deviceId, Math.max(held.get(e.deviceId) ?? 0, e.through));
      // Whatever was tried for this device before is out of date now.
      tried.delete(e.deviceId);
      save();
      void flush();
    },
    acked(deviceId) {
      if (!held.has(deviceId)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const set = waiters.get(deviceId) ?? new Set<() => void>();
        set.add(resolve);
        waiters.set(deviceId, set);
      });
    },
    pending: () => [...held].map(([deviceId, through]) => ({ deviceId, through })),
  };
}

const PROOF = /^[a-f0-9]{64}$/;

/** The send for `createAskRevocations`: POST /api/phones/ask-revoke with the launch proof. Only a 200 carrying `ok: true` is the
 * acknowledgement. On a 404 the harness is asked `GET /api/phones/offered`: a 200 saying `shareAsk: false` answers "not-offered", which
 * lets the local switch-off or removal complete but never removes the entry (that flag is live config and can flip back).
 * Any other 404, an error, a timeout or a throw is "not yet" and the entry stays queued. */
export function askRevokeSender(harness: HarnessCall, launchProof: string | undefined): (e: AskRevocation) => Promise<boolean | "not-offered"> {
  return async ({ deviceId, through }) => {
    if (typeof launchProof !== "string" || !PROOF.test(launchProof)) return false;
    try {
      const answer = await harness({
        method: "POST",
        path: "/api/phones/ask-revoke",
        headers: { accept: "application/json", "content-type": "application/json", "x-murage-companion": "1", "x-murage-companion-token": launchProof },
        body: Buffer.from(JSON.stringify({ deviceId, through })),
      });
      if (answer.status === 404) {
        const offered = await harness({
          method: "GET",
          path: "/api/phones/offered",
          headers: { accept: "application/json", "x-murage-companion": "1", "x-murage-companion-token": launchProof },
          body: null,
        });
        return offered.status === 200 && (offered.body as { shareAsk?: unknown } | null)?.shareAsk === false ? "not-offered" : false;
      }
      return answer.status === 200 && (answer.body as { ok?: unknown } | null)?.ok === true;
    } catch { return false; }
  };
}
