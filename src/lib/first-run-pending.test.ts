import { describe, expect, it } from "vitest";

import { FIRST_RUN_COPY, FIRST_RUN_JOB_ASK, hireButtonLabel, settingUpMoreLine, setUpJobsLabel } from "./first-run-copy";
import { QUEUE_SETTLE_MS, canStartNext, forgetSendId, inTableOrder, mutatePending, nextToStart, pendingNow, resetPendingForTests, sanitizeJobs, sendIdFor, setPendingLocal, startPendingJob, withoutJob } from "./first-run-pending";
import { FIRST_RUN_JOB_IDS } from "./first-run-jobs";

describe("D16c every job has an ask", () => {
  it("is non-empty for every id, and never uses a dash", () => {
    for (const id of FIRST_RUN_JOB_IDS) {
      expect(FIRST_RUN_JOB_ASK[id].trim().length).toBeGreaterThan(0);
      expect(FIRST_RUN_JOB_ASK[id]).not.toMatch(/—/);
    }
    expect(FIRST_RUN_COPY.chat.jobs.asks).toBe(FIRST_RUN_JOB_ASK);
  });
});

describe("D13 and D14 ticks", () => {
  it("orders ticks by the table, and Set up these n reads from the count", () => {
    expect(inTableOrder(["notes", "brief", "day"])).toEqual(["brief", "day", "notes"]);
    expect(setUpJobsLabel(3)).toBe("Set up these 3");
    expect(setUpJobsLabel(0)).toBe("Tick at least one");
    expect(settingUpMoreLine(["A", "B"])).toBe("Setting up 2 more: A, B");
  });
});

describe("D16 the auto-run queue", () => {
  const request = async (_path: string, init?: { body?: string }) => ({ pending: JSON.parse(init!.body!).pending });
  it("sends the ask first and dequeues only after acceptance", async () => {
    setPendingLocal(["day", "notes"]);
    const order: string[] = [];
    const rest = await startPendingJob("day", {
      send: async (text) => { order.push(`send:${text}`); },
      request: async (path, init) => { order.push("write"); return request(path, init); },
    });
    expect(order).toEqual(["send:Organise my day for me.", "write"]);
    expect(rest).toEqual(["notes"]);
  });
  it("a refused send keeps the job in the queue", async () => {
    let wrote = false;
    setPendingLocal(["day"]);
    await expect(startPendingJob("day", { send: async () => { throw new Error("refused"); }, request: async () => { wrote = true; return {}; } })).rejects.toThrow();
    expect(wrote).toBe(false);
    expect(pendingNow()).toEqual(["day"]);
  });
  it("a failed job does not block the others, and Stop removes exactly one", () => {
    expect(nextToStart(["day", "notes"], new Set(["day"]))).toBe("notes");
    expect(nextToStart(["day"], new Set(["day"]))).toBeNull();
    expect(withoutJob(["day", "notes", "research"], "notes")).toEqual(["day", "research"]);
  });
  it("one at a time: nothing starts while busy, sending, before the first job finished, or just after a send", () => {
    const base = { firstJobFinished: true, chiefBusy: false, sending: false, acceptedAt: 0, sawBusySince: false, now: 100_000 };
    expect(canStartNext(base)).toBe(true);
    expect(canStartNext({ ...base, firstJobFinished: false })).toBe(false);
    expect(canStartNext({ ...base, chiefBusy: true })).toBe(false);
    expect(canStartNext({ ...base, sending: true })).toBe(false);
    expect(canStartNext({ ...base, acceptedAt: 99_000 })).toBe(false);
    expect(canStartNext({ ...base, acceptedAt: 99_000, sawBusySince: true })).toBe(true);
    expect(canStartNext({ ...base, acceptedAt: 100_000 - QUEUE_SETTLE_MS - 1 })).toBe(true);
  });
  it("an accepted job and a Stop on another never write each other's stale list back", async () => {
    setPendingLocal(["day", "notes"]);
    const order: string[] = [];
    const slow = async (_path: string, init?: { body?: string }) => {
      order.push(init!.body!);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { pending: JSON.parse(init!.body!).pending };
    };
    await Promise.all([
      startPendingJob("day", { send: async () => {}, request: slow }),
      mutatePending(slow, (queue) => withoutJob(queue, "notes")),
    ]);
    expect(pendingNow()).toEqual([]);
  });
  it("an accepted send whose removal keeps failing is never offered again this session, and records acceptance first", async () => {
    setPendingLocal(["day", "notes"]);
    let accepted = 0;
    await startPendingJob("day", {
      send: async () => {},
      request: async () => { throw new Error("offline"); },
      onAccepted: () => { accepted += 1; },
      retryDelayMs: 1,
    });
    expect(accepted).toBe(1);
    expect(pendingNow()).toEqual(["notes"]);
  });
  it("sanitizes what the server sends", () => {
    expect(sanitizeJobs(["day", "x", "day", 3])).toEqual(["day"]);
    expect(sanitizeJobs("day")).toEqual([]);
  });
});

describe("D10 hire button wording", () => {
  const fits = ["a", "b", "c"];
  const all = ["a", "b", "c", "d"];
  const names = { a: "Alpha", b: "Beta", c: "Gamma", d: "Delta" };
  it("words the primary from the ticks", () => {
    expect(hireButtonLabel([], fits, all, names)).toBe("Pick at least one");
    expect(hireButtonLabel(["a"], fits, all, names)).toBe("Hire Alpha");
    expect(hireButtonLabel(["a", "d"], fits, all, names)).toBe("Hire these 2");
    expect(hireButtonLabel(["a", "b", "c"], fits, all, names)).toBe("Hire all 3");
    expect(hireButtonLabel(["a", "b", "c", "d"], fits, all, names)).toBe("Hire everyone (4)");
  });
});

describe("D16 r3: accepted jobs and send ids", () => {
  it("keeps one send id per job until it is forgotten, and passes it to every send", async () => {
    resetPendingForTests();
    const first = sendIdFor("day");
    expect(sendIdFor("day")).toBe(first);
    expect(sendIdFor("notes")).not.toBe(first);
    forgetSendId("day");
    expect(sendIdFor("day")).not.toBe(first);
    resetPendingForTests();
    setPendingLocal(["day"]);
    const seen: string[] = [];
    const sendId = sendIdFor("day");
    await startPendingJob("day", { send: async (_text, id) => { seen.push(id); }, request: async () => ({ pending: [] }) });
    expect(seen).toEqual([sendId]);
    resetPendingForTests();
  });
  it("an accepted job whose removal keeps failing is not put back by a later Stop answer and is never started again", async () => {
    resetPendingForTests();
    setPendingLocal(["day", "notes"]);
    await startPendingJob("day", { send: async () => {}, request: async () => { throw new Error("offline"); }, retryDelayMs: 1 });
    expect(pendingNow()).toEqual(["notes"]);
    // the answer of a Stop on another job that was written before the acceptance still lists the accepted job
    const after = await mutatePending(async () => ({ pending: ["day", "notes"] }), (queue) => [...queue]);
    expect(after).toEqual(["notes"]);
    expect(nextToStart(["day", "notes"], new Set())).toBe("notes");
    // once the server's own list no longer holds it, it is forgotten and may be queued afresh
    setPendingLocal(["notes"]);
    setPendingLocal(["day", "notes"]);
    expect(pendingNow()).toEqual(["day", "notes"]);
    resetPendingForTests();
  });
});
