import { describe, expect, it } from "vitest";
import { BrowserCheckTurns, runBrowserCheck } from "./browser-check-state.ts";
import { BROWSER_CHECKED_REASON, BROWSER_CHECK_FAILED_REASON, BROWSER_CHECKING_REASON, browserUnavailableActivityName, browserUnavailableKind, browserUnavailableReason } from "../shared/browser-unavailable.ts";
import { hostStoppedActivityName } from "../shared/host-stop.ts";
import { TURN_STOPPED_DESKTOP_ACTION_NOTE, TURN_STOPPED_NOTE } from "./turn-outcome.ts";

const THREAD = "t1";
function rig() {
  const rows = new Map<string, { name: string; ok: boolean }>();
  const turns = new BrowserCheckTurns({ patch: (_t, id, tool) => { rows.set(id, tool); } });
  return { rows, turns, lines: () => [...rows.values()].map(r => r.name) };
}
/** An inner check that shows the checking note, then lets the test decide how it ends. */
function checking(r: ReturnType<typeof rig>, finish: () => Promise<unknown>, id = "note1") {
  return (check: { id?: string }) => {
    check.id = id;
    r.rows.set(id, { name: browserUnavailableActivityName(BROWSER_CHECKING_REASON), ok: true });
    r.turns.begin(THREAD, id);
    return finish() as Promise<null | { unavailable: string }>;
  };
}

describe("browser check state machine (1.0.2)", () => {
  it("host stop during the check, then the check settles: one line, host wording, no 'Stopped by you'", async () => {
    const r = rig();
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    let live = true;
    const run = runBrowserCheck(r.turns, THREAD, () => live, checking(r, async () => { await gate; return null; }));
    live = false;
    expect(r.turns.hostStop(THREAD, "ran out of budget")).toBe(true);
    release();
    expect(await run).toBeNull();
    expect(r.lines()).toEqual([hostStoppedActivityName("ran out of budget")]);
    // the turn's terminal handling adds no second line
    expect(r.turns.terminal(THREAD, { stopped: true, desktopAction: false })).toBe(true);
    expect(r.lines()).toEqual([hostStoppedActivityName("ran out of budget")]);
    expect(r.lines()).not.toContain(TURN_STOPPED_NOTE);
  });

  it("host stop arriving after the person's stop settled keeps one line and names the host", async () => {
    const r = rig();
    await runBrowserCheck(r.turns, THREAD, () => false, checking(r, async () => null));
    expect(r.lines()).toEqual([TURN_STOPPED_NOTE]);
    expect(r.turns.hostStop(THREAD, "limit")).toBe(true);
    expect(r.lines()).toEqual([hostStoppedActivityName("limit")]);
    // a second host stop or a terminal desktop refinement never rewrites it
    r.turns.hostStop(THREAD, "other");
    expect(r.turns.terminal(THREAD, { stopped: true, desktopAction: true })).toBe(true);
    expect(r.lines()).toEqual([hostStoppedActivityName("limit")]);
  });

  it("stop during verification, then verification rejects: the stop stands and no fallback is published", async () => {
    const r = rig();
    let live = true;
    let reject!: (e: Error) => void;
    const verification = new Promise<never>((_, rej) => { reject = rej; });
    // the inner check converts a rejected binding into an unavailable result, as browserIntegrationInner does
    const run = runBrowserCheck(r.turns, THREAD, () => live, checking(r, async () => { try { await verification; } catch (e) { return { unavailable: (e as Error).message }; } return null; }));
    live = false;
    reject(new Error("Chrome binding failed"));
    expect(await run).toBeNull();
    expect(r.lines()).toEqual([TURN_STOPPED_NOTE]);
    expect(r.lines().some(n => browserUnavailableReason(n) === "Chrome binding failed")).toBe(false);
  });

  it("a stopped turn with no checking note also gets no fallback result", async () => {
    const r = rig();
    expect(await runBrowserCheck(r.turns, THREAD, () => false, async () => ({ unavailable: "boom" }))).toBeNull();
  });

  it("a live turn that continues without the browser publishes the fallback once", async () => {
    const r = rig();
    const result = await runBrowserCheck(r.turns, THREAD, () => true, checking(r, async () => ({ unavailable: "the browser did not start in time: timed out" })));
    expect(result).toMatchObject({ unavailable: "the browser did not start in time: timed out", noted: true });
    expect(browserUnavailableKind(browserUnavailableReason(r.rows.get("note1")!.name)!)).toBe("timed-out");
    expect(r.turns.phase(THREAD)).toBe("unavailable-continue");
    // a later stop never rewrites it
    r.turns.hostStop(THREAD, "x");
    expect(r.turns.terminal(THREAD, { stopped: true, desktopAction: false })).toBe(false);
    expect(browserUnavailableKind(browserUnavailableReason(r.rows.get("note1")!.name)!)).toBe("timed-out");
  });

  it("a verified browser settles to the finished note", async () => {
    const r = rig();
    await runBrowserCheck(r.turns, THREAD, () => true, checking(r, async () => ({ profileKey: "k" }) as never));
    expect(r.rows.get("note1")!.name).toBe(browserUnavailableActivityName(BROWSER_CHECKED_REASON));
  });

  it("an error during the check settles to its own 'did not finish, try again' wording, rethrows, and is not the fallback", async () => {
    const r = rig();
    const boom = new Error("turn failed");
    await expect(runBrowserCheck(r.turns, THREAD, () => true, checking(r, async () => { throw boom; }))).rejects.toBe(boom);
    const name = r.rows.get("note1")!.name;
    expect(name).toBe(browserUnavailableActivityName(BROWSER_CHECK_FAILED_REASON));
    expect(browserUnavailableKind(browserUnavailableReason(name)!)).toBe("check-failed");
    expect(r.turns.phase(THREAD)).toBe("failed-retry");
  });

  it("an error after a stop does not rewrite the stop", async () => {
    const r = rig();
    await expect(runBrowserCheck(r.turns, THREAD, () => false, checking(r, async () => { r.turns.hostStop(THREAD, "limit"); throw new Error("late"); }))).rejects.toThrow("late");
    expect(r.lines()).toEqual([hostStoppedActivityName("limit")]);
  });

  it("a stop terminal event arriving while the check still runs carries the stop; the late result rewrites nothing", async () => {
    const r = rig();
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    const run = runBrowserCheck(r.turns, THREAD, () => true, checking(r, async () => { await gate; return { unavailable: "late" }; }));
    expect(r.turns.terminal(THREAD, { stopped: true, desktopAction: true })).toBe(true);
    expect(r.lines()).toEqual([TURN_STOPPED_DESKTOP_ACTION_NOTE]);
    release();
    await run;
    expect(r.lines()).toEqual([TURN_STOPPED_DESKTOP_ACTION_NOTE]);
  });

  it("a failed terminal event during the check settles it to the retry wording", () => {
    const r = rig();
    r.turns.begin(THREAD, "note1");
    expect(r.turns.terminal(THREAD, { stopped: false, desktopAction: false })).toBe(false);
    expect(r.rows.get("note1")!.name).toBe(browserUnavailableActivityName(BROWSER_CHECK_FAILED_REASON));
  });

  it("a desktop action caught by the stop refines the person's stop, once", async () => {
    const r = rig();
    await runBrowserCheck(r.turns, THREAD, () => false, checking(r, async () => null));
    expect(r.turns.terminal(THREAD, { stopped: true, desktopAction: true })).toBe(true);
    expect(r.lines()).toEqual([TURN_STOPPED_DESKTOP_ACTION_NOTE]);
  });

  it("an old cancelled check can never settle a replacement turn's note", async () => {
    const r = rig();
    let live = true;
    let reject!: (e: Error) => void;
    const verification = new Promise<never>((_, rej) => { reject = rej; });
    const old = runBrowserCheck(r.turns, THREAD, () => live, checking(r, async () => { try { await verification; } catch (e) { return { unavailable: (e as Error).message }; } return null; }, "old"));
    // the person stops, then a replacement turn on the same thread starts its own check
    live = false;
    let finishNew!: (v: object) => void;
    const replacement = runBrowserCheck(r.turns, THREAD, () => true, checking(r, () => new Promise(res => { finishNew = res; }), "new"));
    // the old verification rejects only now
    reject(new Error("Chrome binding failed"));
    expect(await old).toBeNull();
    // the old note settled as its own stop; the replacement is untouched and still checking
    expect(r.rows.get("old")!.name).toBe(TURN_STOPPED_NOTE);
    expect(r.rows.get("new")!.name).toBe(browserUnavailableActivityName(BROWSER_CHECKING_REASON));
    expect(r.turns.phase(THREAD)).toBe("checking");
    finishNew({ profileKey: "k" });
    await replacement;
    expect(r.rows.get("new")!.name).toBe(browserUnavailableActivityName(BROWSER_CHECKED_REASON));
    expect(r.rows.get("old")!.name).toBe(TURN_STOPPED_NOTE);
  });

  it("an old check that errors after replacement settles only its own note", async () => {
    const r = rig();
    let fail!: (e: Error) => void;
    const old = runBrowserCheck(r.turns, THREAD, () => true, checking(r, () => new Promise((_, rej) => { fail = rej; }), "old"));
    runBrowserCheck(r.turns, THREAD, () => true, checking(r, () => new Promise(() => {}), "new"));
    fail(new Error("late failure"));
    await expect(old).rejects.toThrow("late failure");
    expect(r.rows.get("old")!.name).toBe(browserUnavailableActivityName(BROWSER_CHECK_FAILED_REASON));
    expect(r.rows.get("new")!.name).toBe(browserUnavailableActivityName(BROWSER_CHECKING_REASON));
    expect(r.turns.phase(THREAD)).toBe("checking");
  });

  it("a transition naming a note the thread never had changes nothing", () => {
    const r = rig();
    r.turns.begin(THREAD, "note1");
    expect(r.turns.failed(THREAD, "other")).toBeUndefined();
    expect(r.turns.verified("t2", "note1")).toBeUndefined();
    expect(r.turns.phase(THREAD)).toBe("checking");
  });
});
