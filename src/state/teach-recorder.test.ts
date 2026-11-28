// W4 (TEACH-ENTRY 1.0.23 D5, SITES-H2): who the recorder is for, and the one-shot
// start token, through every real producer of showSkillRecorder: entry clicks,
// the two Back returns (calendarReturn = App closeCalendar, healthReturn), leaving
// the page and the switch-off return.
import { describe, expect, it } from "vitest";
import { calendarReturn, healthReturn } from "@/components/shell/shell-nav";
import { configStatusFromFrame, initialState, reducer, type Action, type AppState } from "./store";

const config = configStatusFromFrame({
  composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 5 }, localVm: { mode: "shared", maxInstances: 2 }, features: { skillRecorder: true },
});
const base: AppState = { ...initialState, config, activeView: "today" };
const run = (state: AppState, ...actions: Action[]): AppState => actions.reduce(reducer, state);
const health = { bots: [], groups: [], needsYouTab: undefined };

// SITES-H2 producers
const headerEntry = (id: string): Action => ({ type: "showSkillRecorder", via: "entry", forBotId: id });
const youMenu: Action = { type: "showSkillRecorder", via: "entry" };
const cardStart = (id: string, task: string): Action => ({ type: "showSkillRecorder", via: "entry", forBotId: id, task, start: true });
const closeCalendarBack = (): Action => calendarReturn("skill-recorder", true, "dax");
const healthBack = (): Action => healthReturn({ view: "skill-recorder" }, health, true);

describe("W4 who the recorder is for (D5)", () => {
  it("(a) an entry with a bot sets it", () => {
    expect(run(base, headerEntry("dax")).skillRecorderFor).toBe("dax");
  });
  it("(b) an entry with no bot while on the page keeps it (F2)", () => {
    expect(run(base, headerEntry("dax"), youMenu).skillRecorderFor).toBe("dax");
  });
  it("(c) an entry with another bot on the page sets that bot", () => {
    expect(run(base, headerEntry("dax"), headerEntry("ember")).skillRecorderFor).toBe("ember");
  });
  it("(d) an entry with no bot from Today clears it", () => {
    const opened = run(base, headerEntry("dax"), { type: "showToday" });
    expect(run(opened, youMenu).skillRecorderFor).toBeUndefined();
  });
  it("(e) recorder -> calendar -> the real closeCalendar return keeps dax", () => {
    const back = run(base, headerEntry("dax"), { type: "showRoutines" }, closeCalendarBack());
    expect(back.activeView).toBe("skill-recorder");
    expect(back.skillRecorderFor).toBe("dax");
  });
  it("(f) recorder -> Health -> the real healthReturn keeps dax", () => {
    const back = run(base, headerEntry("dax"), { type: "showHealth" }, healthBack());
    expect(back.activeView).toBe("skill-recorder");
    expect(back.skillRecorderFor).toBe("dax");
  });
  it("(g) showToday then the You menu clears it", () => {
    expect(run(base, headerEntry("dax"), { type: "showToday" }, youMenu).skillRecorderFor).toBeUndefined();
  });
  it("(h) the task is kept on a return and cleared by an entry without one", () => {
    const opened = run(base, cardStart("dax", "File receipts"));
    expect(run(opened, { type: "showHealth" }, healthBack()).skillRecorderTask).toBe("File receipts");
    expect(run(opened, headerEntry("dax")).skillRecorderTask).toBeUndefined();
  });
});

describe("W4 the one-shot start token (D5 rules a-c)", () => {
  it("only the card Start sets a token", () => {
    expect(run(base, cardStart("dax", "")).skillRecorderStart).toEqual(expect.any(Number));
    expect(run(base, headerEntry("dax")).skillRecorderStart).toBeUndefined();
  });
  it("(i) card Start -> Health -> the real healthReturn: no token", () => {
    const back = run(base, cardStart("dax", ""), { type: "showHealth" }, healthBack());
    expect(back.activeView).toBe("skill-recorder");
    expect(back.skillRecorderStart).toBeUndefined();
  });
  it("(j) card Start -> calendar -> the real closeCalendar: no token", () => {
    const back = run(base, cardStart("dax", ""), { type: "showRoutines" }, closeCalendarBack());
    expect(back.activeView).toBe("skill-recorder");
    expect(back.skillRecorderStart).toBeUndefined();
  });
  it("(k) a later entry without start drops the token", () => {
    expect(run(base, cardStart("dax", ""), youMenu).skillRecorderStart).toBeUndefined();
    expect(run(base, cardStart("dax", ""), headerEntry("dax")).skillRecorderStart).toBeUndefined();
  });
  it("(k) leaving the page drops the token (rule b): Today and the switch-off return", () => {
    const started = run(base, cardStart("dax", ""));
    expect(run(started, { type: "showToday" }).skillRecorderStart).toBeUndefined();
    const off = run(started, { type: "configStatus", config: { ...config, features: { skillRecorder: false } } });
    expect(off.activeView).not.toBe("skill-recorder");
    expect(off.skillRecorderStart).toBeUndefined();
    expect(off.skillRecorderFor).toBe("dax");
  });
  it("(l) a stale consume leaves a newer token; the current one clears it", () => {
    const first = run(base, cardStart("dax", ""));
    const older = first.skillRecorderStart!;
    const second = run(first, cardStart("dax", ""));
    const newer = second.skillRecorderStart!;
    expect(newer).not.toBe(older);
    expect(run(second, { type: "skillRecorderStartConsumed", token: older }).skillRecorderStart).toBe(newer);
    expect(run(second, { type: "skillRecorderStartConsumed", token: newer }).skillRecorderStart).toBeUndefined();
  });
});
