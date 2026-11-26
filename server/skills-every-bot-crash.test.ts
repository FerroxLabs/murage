import { beforeEach, expect, it, vi } from "vitest";
import type { EveryBotMark } from "./skill-every-bot.ts";

const state = vi.hoisted(() => ({
  disk: {} as Record<string, EveryBotMark>,
  enabled: {} as Record<string, boolean>,
  crash: "",
  writes: [] as Record<string, EveryBotMark>[],
}));
vi.mock("./skill-every-bot.ts", () => ({
  readEveryBotMarks: () => structuredClone(state.disk),
  writeEveryBotMarks: (marks: Record<string, EveryBotMark>) => {
    state.disk = structuredClone(marks);
    state.writes.push(structuredClone(marks));
  },
}));
vi.mock("./skill-collection.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./skill-collection.ts")>(),
  getCollectionSkill: () => ({ scan: { verdict: "clean" }, contents: [] }),
}));
vi.mock("./skills.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./skills.ts")>(),
  listSkills: (id: string) => id in state.enabled ? [{ name: "crash-test", source: "collection:crash-test", enabled: state.enabled[id] }] : [],
  installSkill: () => ({}),
  setSkillEnabled: (id: string, _name: string, on: boolean) => {
    state.enabled[id] = on;
    if (state.crash === `${id}:${on}`) throw new Error("injected crash after side effect");
    return {};
  },
}));
import { applyEveryBotMarks, handleSkillsApi } from "./skills-api.ts";

const ref = "collection:crash-test";
const bots = ["first", "second"].map(id => ({ id, name: id, canUseSkills: true }));
const toggle = (on: boolean) => handleSkillsApi({
  method: "PUT", path: `/api/skills/${ref}/every-bot`,
  url: new URL("http://fixture.invalid"), readBody: async () => ({ on }), bots: () => bots,
});
beforeEach(() => { state.disk = {}; state.enabled = {}; state.crash = ""; state.writes = []; });

it("recovers ownership after a crash between enabling and recording completion", async () => {
  state.enabled.independent = true;
  state.crash = "first:true";
  await expect(toggle(true)).rejects.toThrow("injected crash");
  expect(state.disk[ref].pendingTo).toContain("first");
  state.crash = "";
  await toggle(true);
  expect(state.disk[ref].appliedTo).toEqual(["first", "second"]);
  await toggle(false);
  expect(state.enabled).toEqual({ first: false, second: false, independent: true });
});

it("persists each successful apply before beginning the next bot", async () => {
  state.crash = "second:true";
  await expect(toggle(true)).rejects.toThrow("injected crash");
  expect(state.disk[ref].appliedTo).toEqual(["first"]);
  expect(state.disk[ref].pendingTo).toEqual(["second"]);
  state.crash = "";
  await toggle(false);
  expect(state.enabled).toEqual({ first: false, second: false });
});

it("retains remaining OFF work after a crash and suppresses new applications", async () => {
  await toggle(true);
  state.crash = "second:false";
  await expect(toggle(false)).rejects.toThrow("injected crash");
  expect(state.disk[ref].appliedTo).toEqual(["second"]);
  expect(state.disk[ref].turningOff).toBe(true);
  applyEveryBotMarks({ id: "later", name: "Later", canUseSkills: true });
  expect(state.enabled.later).toBeUndefined();
  state.crash = "";
  await toggle(false);
  expect(state.disk).toEqual({});
  expect(state.enabled).toEqual({ first: false, second: false });
});
