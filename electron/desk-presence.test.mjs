// "At the desk" for the desktop app (E1, 2026-09-29): Murage is running, the
// screen is unlocked, and the keyboard or mouse was used in the last 120 s,
// whether or not the Murage window is visible. A terminal covering Murage
// used to read as "away" and buzzed both phones at Sean's desk.
import { describe, expect, it, vi } from "vitest";

import { Presence } from "../server/mobile-presence.ts";
import {
  DESK_BEAT_MS,
  DESK_IDLE_SECONDS,
  DESK_POLL_MS,
  deskState,
  startDeskPresence,
} from "./desk-presence.mjs";

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(initial = "active", report = async () => undefined) {
  let idle = initial;
  const timers = new Map();
  const power = [];
  const lines = [];
  const post = vi.fn(report);
  const idleState = vi.fn(() => idle);
  const stop = startDeskPresence({
    clientId: "desk-12345678",
    post,
    idleState,
    onPower: (listener) => {
      power.push(listener);
      return () => power.splice(power.indexOf(listener), 1);
    },
    every: (fn, ms) => {
      timers.set(ms, fn);
      return () => timers.delete(ms);
    },
    log: (line) => lines.push(line),
  });
  return {
    post, idleState, lines, stop, timers,
    setIdle: (value) => { idle = value; },
    beat: () => timers.get(DESK_BEAT_MS)(),
    poll: () => timers.get(DESK_POLL_MS)(),
    power: (event) => { for (const listener of [...power]) listener(event); },
    last: () => post.mock.lastCall?.[0],
  };
}

describe("the desk rule", () => {
  it("is present only while active, unlocked and awake", () => {
    expect(deskState({ idle: "active", locked: false, asleep: false })).toBe("active");
    expect(deskState({ idle: "idle", locked: false, asleep: false })).toBe("idle");
    expect(deskState({ idle: "locked", locked: false, asleep: false })).toBe("locked");
    expect(deskState({ idle: "active", locked: true, asleep: false })).toBe("locked");
    expect(deskState({ idle: "active", locked: false, asleep: true })).toBe("asleep");
    // An idle time the system cannot read errs toward buzzing the phone.
    expect(deskState({ idle: "unknown", locked: false, asleep: false })).toBe("unknown");
  });

  it("asks the system about the last 120 s of input", () => {
    const t = harness();
    expect(t.idleState).toHaveBeenCalledWith(DESK_IDLE_SECONDS);
    expect(DESK_IDLE_SECONDS).toBe(120);
  });
});

describe("desk presence reporting", () => {
  it("reports present at start while the Mac is in use, and beats every 30 s with a rising seq", async () => {
    const t = harness();
    expect(t.last()).toEqual({ clientId: "desk-12345678", visible: true, seq: 1 });
    await settled();
    t.beat();
    expect(t.last()).toEqual({ clientId: "desk-12345678", visible: true, seq: 2 });
    await settled();
    t.beat();
    expect(t.last()).toEqual({ clientId: "desk-12345678", visible: true, seq: 3 });
    expect(DESK_BEAT_MS).toBe(30_000);
  });

  it("reports absent as soon as a poll finds 120 s without input, and does not beat while idle", async () => {
    const t = harness();
    await settled();
    t.setIdle("idle");
    t.poll();
    expect(t.last()).toEqual({ clientId: "desk-12345678", visible: false, seq: 2 });
    await settled();
    t.beat();
    t.poll();
    expect(t.post).toHaveBeenCalledTimes(2);
    expect(DESK_POLL_MS).toBeLessThanOrEqual(5_000);
  });

  it("a poll that finds nothing changed sends nothing between beats", async () => {
    const t = harness();
    await settled();
    t.poll();
    t.poll();
    expect(t.post).toHaveBeenCalledTimes(1);
  });

  it("reports absent at once on lock, and present again on unlock with input", async () => {
    const t = harness();
    await settled();
    t.power("lock-screen");
    expect(t.last()).toMatchObject({ visible: false, seq: 2 });
    await settled();
    // Still locked: the system's own idle answer may lag, the event does not.
    t.poll();
    t.beat();
    expect(t.post).toHaveBeenCalledTimes(2);
    t.power("unlock-screen");
    expect(t.last()).toMatchObject({ visible: true, seq: 3 });
  });

  it("an unlock without recent input stays absent", async () => {
    const t = harness();
    await settled();
    t.power("lock-screen");
    await settled();
    t.setIdle("idle");
    t.power("unlock-screen");
    expect(t.post).toHaveBeenCalledTimes(2);
    t.setIdle("active");
    t.poll();
    expect(t.last()).toMatchObject({ visible: true, seq: 3 });
  });

  it("the system's own locked answer counts as locked", async () => {
    const t = harness();
    await settled();
    t.setIdle("locked");
    t.poll();
    expect(t.last()).toMatchObject({ visible: false });
  });

  it("reports absent at once when the Mac sleeps, and re-reads on wake", async () => {
    const t = harness();
    await settled();
    t.power("suspend");
    expect(t.last()).toMatchObject({ visible: false, seq: 2 });
    await settled();
    t.poll();
    expect(t.post).toHaveBeenCalledTimes(2);
    t.power("resume");
    expect(t.last()).toMatchObject({ visible: true, seq: 3 });
  });

  it("keeps one report in flight and sends only the newest state behind it", async () => {
    let release;
    const t = harness();
    t.post.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await settled();
    t.beat(); // seq 2, held open
    t.power("lock-screen");
    t.power("unlock-screen");
    t.power("lock-screen");
    expect(t.post).toHaveBeenCalledTimes(2);
    release();
    await settled();
    await settled();
    expect(t.post).toHaveBeenCalledTimes(3);
    expect(t.last()).toMatchObject({ visible: false, seq: 3 });
  });

  it("a failed report does not stop later ones", async () => {
    const t = harness();
    t.post.mockRejectedValueOnce(new Error("offline"));
    await settled();
    t.beat();
    await settled();
    t.beat();
    expect(t.post).toHaveBeenCalledTimes(3);
  });

  it("logs content-free state changes only, never a steady beat", async () => {
    const t = harness();
    await settled();
    t.beat();
    t.poll();
    t.setIdle("idle");
    t.poll();
    expect(t.lines).toEqual([
      "presence source=desk-activity state=active",
      "presence source=desk-activity state=idle",
    ]);
  });

  it("stopping reports absent and stops listening", async () => {
    const t = harness();
    await settled();
    t.stop();
    expect(t.last()).toMatchObject({ visible: false, seq: 2 });
    expect(t.timers.size).toBe(0);
    await settled();
    t.power("unlock-screen");
    expect(t.post).toHaveBeenCalledTimes(2);
  });
});

// The window covered by a terminal reported "hidden" and ended presence four
// seconds before Dax's push buzzed the phones (server.log, 2026-09-29). The
// host keeps each client apart, so a hidden renderer cannot cancel the
// main process's report.
describe("the host's answer with the desk reporting", () => {
  it("an occluded window's hidden report does not end presence while the Mac is in use", async () => {
    let now = 0;
    const presence = new Presence(() => now, () => {});
    const t = harness("active", async (body) => presence.report(body.clientId, body.visible, body.seq));
    presence.report("renderer-abcdefgh", true, 1);
    presence.report("renderer-abcdefgh", false, 2);
    expect(presence.present()).toBe(true);
    now = 80_000;
    await settled();
    t.beat();
    now = 160_000;
    expect(presence.present()).toBe(true);
  });

  it("goes absent when the Mac goes idle, so the phones buzz once Sean has walked away", async () => {
    const presence = new Presence(() => 0, () => {});
    const t = harness("active", async (body) => presence.report(body.clientId, body.visible, body.seq));
    await settled();
    expect(presence.present()).toBe(true);
    t.setIdle("idle");
    t.poll();
    await settled();
    expect(presence.present()).toBe(false);
  });
});
