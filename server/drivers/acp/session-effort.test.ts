// ACP-EFFORT-PER-MODEL-1023 (SE): the real ACP driver against the fake engine, one witness per design row.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { CustomAcpDriver } from "./custom.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import type { EffortTouch, EffortTouchStore } from "./session-effort.ts";

const CLI = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve("server/testing/fake-custom-acp-models.ts"))}`;
const FALLBACK = "could not confirm effort";

function touchStore(initial: Record<string, EffortTouch> = {}) {
  const map = new Map<string, EffortTouch>(Object.entries(initial));
  const store: EffortTouchStore = { get: id => map.get(id), set: (id, state) => { map.set(id, state); return true; } };
  return { map, store };
}

async function engine(env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "murage-effort-"));
  const create = () => CustomAcpDriver.create({ instanceId: "effort-fixture", displayName: "Fixture", enabled: true,
    environment: { HOME: home, USERPROFILE: home, FAKE_CUSTOM_ACP_DIRECTORY: home, ...env },
    config: { cli: CLI, fullAuto: false } });
  let instance = await create();
  let recorder = recordEvents(instance.adapter);
  const rows = (): Array<Record<string, any>> => { try { return readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)); } catch { return []; } };
  const turn = async (threadId: string, input: { variant?: string; cursor?: string; touch?: EffortTouchStore; model?: string; text?: string; history?: boolean }) => {
    const before = rows().length;
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: input.text ?? "ACP_PICKER_EFFORT", model: input.model ?? "glm-5.3",
      ...(input.variant ? { variant: input.variant } : {}), ...(input.cursor ? { resumeCursor: input.cursor } : {}), ...(input.touch ? { effortTouch: input.touch } : {}),
      ...(input.history ? { transcript: [{ role: "user" as const, text: "EARLIER_HISTORY_ROW" }, { role: "assistant" as const, text: "EARLIER_REPLY_ROW" }] } : {}) });
    const done = await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId);
    const mine = rows().slice(before);
    const prompt = mine.filter(r => r.method === "session/prompt").at(-1);
    return {
      done, rows: mine, promptSession: prompt?.sessionId as string | undefined, prompt,
      news: mine.filter(r => r.method === "session/new"),
      sets: mine.filter(r => r.method === "session/set_config_option" && r.configId === "thinking"),
      started: recorder.events.filter(e => e.type === "session.started" && "turnId" in e && e.turnId === turnId).map(e => (e as { sessionId?: string | null }).sessionId),
      notices: recorder.events.filter(e => e.type === "item.started" && "turnId" in e && e.turnId === turnId && JSON.stringify(e).includes(FALLBACK)),
    };
  };
  const restart = async () => { recorder.stop(); await instance.dispose(); instance = await create(); recorder = recordEvents(instance.adapter); };
  const close = async () => { recorder.stop(); await instance.dispose(); await removeTempDir(home); };
  return { turn, rows, restart, close };
}

it("X1 Engine decides on a session recorded SET opens one fresh session, sends no set, prompts the fresh one", async () => {
  const e = await engine();
  const { map, store } = touchStore();
  try {
    const first = await e.turn("x1", { variant: "max", touch: store });
    expect(first.done).toMatchObject({ ok: true });
    const S = first.promptSession!;
    const second = await e.turn("x1", { cursor: S, touch: store });
    expect(second.done).toMatchObject({ ok: true });
    expect(second.news).toHaveLength(1);
    expect(second.sets).toHaveLength(0);
    expect(second.promptSession).not.toBe(S);
    expect(second.prompt?.variant).toBe("low");
    expect(map.get(S)).toBe("set");
    expect(map.get(second.promptSession!)).toBe("clean");
    expect(second.notices).toHaveLength(0);
  } finally { await e.close(); }
});

it("E3 Engine decides on a clean session sends nothing, five times", async () => {
  const e = await engine();
  const { store } = touchStore();
  try {
    let cursor = (await e.turn("e3", { touch: store })).promptSession!;
    for (let i = 0; i < 5; i++) {
      const t = await e.turn("e3", { cursor, touch: store });
      expect(t.done).toMatchObject({ ok: true });
      expect(t.news).toHaveLength(0);
      expect(t.sets).toHaveLength(0);
      expect(t.promptSession).toBe(cursor);
      cursor = t.promptSession!;
    }
  } finally { await e.close(); }
});

it("E2 an answer without the value is not a confirmation: one fresh session at the default, one line, no refusal (X2 base case)", async () => {
  const e = await engine({ FAKE_CUSTOM_NO_CONFIRM: "1" });
  const { map, store } = touchStore();
  try {
    const first = await e.turn("e2", { touch: store });
    const S = first.promptSession!;
    const t = await e.turn("e2", { variant: "max", cursor: S, touch: store });
    expect(t.done).toMatchObject({ ok: true });
    expect(t.sets).toHaveLength(1);
    expect(t.news).toHaveLength(1);
    expect(t.promptSession).not.toBe(S);
    expect(t.prompt?.variant).toBe("low");
    expect(t.notices).toHaveLength(1);
    expect(map.get(S)).toBe("pending");
    expect(map.get(t.promptSession!)).toBe("clean");
    // E6e: the replacement becomes the cursor only because its prompt was written, and S is never published
    expect(t.started).toEqual([t.promptSession]);
  } finally { await e.close(); }
});

it("F3 a set the engine refuses falls back the same way", async () => {
  const e = await engine({ FAKE_CUSTOM_SET_ERROR: "1" });
  const { store } = touchStore();
  try {
    const S = (await e.turn("f3", { touch: store })).promptSession!;
    const t = await e.turn("f3", { variant: "max", cursor: S, touch: store });
    expect(t.done).toMatchObject({ ok: true });
    expect(t.news).toHaveLength(1);
    expect(t.promptSession).not.toBe(S);
    expect(t.notices).toHaveLength(1);
  } finally { await e.close(); }
});

it("X4 a reused native id: A0 overwrites the old key, so the next Engine decides turn opens nothing", async () => {
  const e = await engine({ FAKE_CUSTOM_FIXED_ID: "reused-session" });
  const { map, store } = touchStore();
  try {
    const first = await e.turn("x4", { variant: "max", touch: store });
    const S = first.promptSession!;
    expect(S).toBe("reused-session");
    // the owner's cursor is gone but the record still holds S: set; the engine hands S back on session/new
    const second = await e.turn("x4", { touch: store });
    expect(second.news).toHaveLength(1);
    expect(second.promptSession).toBe(S);
    const third = await e.turn("x4", { cursor: S, touch: store });
    expect(third.sets).toHaveLength(0);
    expect(third.news).toHaveLength(0);
    expect(map.get(S)).toBe("clean");
  } finally { await e.close(); }
});

it("X4b a fresh session that comes back with the same native id is stamped clean too", async () => {
  const e = await engine({ FAKE_CUSTOM_FIXED_ID: "reused-session" });
  const { map, store } = touchStore();
  try {
    const S = (await e.turn("x4b", { variant: "max", touch: store })).promptSession!;
    const second = await e.turn("x4b", { cursor: S, touch: store });
    expect(second.news).toHaveLength(1);
    expect(second.promptSession).toBe(S);
    const third = await e.turn("x4b", { cursor: S, touch: store });
    expect(third.sets).toHaveLength(0);
    expect(third.news).toHaveLength(0);
    expect(map.get(S)).toBe("clean");
  } finally { await e.close(); }
});

it("X10 a late change between the confirmation and the final fence falls back instead of throwing", async () => {
  const e = await engine({ FAKE_CUSTOM_LATE_CHANGE: "low" });
  const { map, store } = touchStore();
  try {
    const S = (await e.turn("x10", { touch: store })).promptSession!;
    const t = await e.turn("x10", { variant: "max", cursor: S, touch: store });
    expect(t.done).toMatchObject({ ok: true });
    expect(t.news).toHaveLength(1);
    expect(t.promptSession).not.toBe(S);
    expect(t.notices).toHaveLength(1);
    expect(map.get(t.promptSession!)).toBe("clean");
    // F5: S was published first, then the late fallback publishes R: the last session.started is the cursor the next turn resumes
    expect(t.started.at(-1)).toBe(t.promptSession);
  } finally { await e.close(); }
});

it("E6a a replacement whose model pin fails never becomes the cursor: S is kept and re-announced, R is not published", async () => {
  const e = await engine({ FAKE_CUSTOM_NO_CONFIRM: "1", FAKE_CUSTOM_FAIL_MODEL_ON_NEW_SESSION: "1" });
  const { store } = touchStore();
  try {
    const S = (await e.turn("e6a", { touch: store, model: "glm-5.3-flash" })).promptSession!;
    const t = await e.turn("e6a", { variant: "high", cursor: S, touch: store, model: "glm-5.3-flash" });
    expect(t.done).toMatchObject({ ok: false });
    expect(t.news).toHaveLength(1);
    expect(t.prompt).toBeUndefined();
    expect(t.started).not.toContain(t.news[0]!.sessionId);
    expect(t.started.every(id => id === S)).toBe(true);
  } finally { await e.close(); }
});

it("X6a a caller that passes no store (group-room member turn): one process is exact, a restart reads as touched", async () => {
  const e = await engine();
  try {
    const first = await e.turn("x6a", { variant: "max" });
    const S = first.promptSession!;
    const second = await e.turn("x6a", { cursor: S });
    expect(second.news).toHaveLength(1);
    expect(second.sets).toHaveLength(0);
    const R = second.promptSession!;
    expect(R).not.toBe(S);
    const third = await e.turn("x6a", { cursor: R });
    expect(third.news).toHaveLength(0);
    await e.restart();
    const fourth = await e.turn("x6a", { cursor: R });
    expect(fourth.news).toHaveLength(1);
    expect(fourth.sets).toHaveLength(0);
  } finally { await e.close(); }
});

it("E7 pending is saved before the set request leaves the driver", async () => {
  const e = await engine();
  const { map } = touchStore();
  const seen: Array<{ state: EffortTouch; setsSoFar: number }> = [];
  const store: EffortTouchStore = { get: id => map.get(id), set: (id, state) => {
    if (state === "pending") seen.push({ state, setsSoFar: e.rows().filter(r => r.method === "session/set_config_option" && r.configId === "thinking").length });
    map.set(id, state); return true;
  } };
  try {
    const S = (await e.turn("e7", { touch: store })).promptSession!;
    const t = await e.turn("e7", { variant: "max", cursor: S, touch: store });
    expect(t.done).toMatchObject({ ok: true });
    expect(seen).toEqual([{ state: "pending", setsSoFar: 0 }]);
    expect(t.sets).toHaveLength(1);
  } finally { await e.close(); }
});

it("F4 a write-ahead pending that cannot be saved sends no set: one fresh session at the default, one line", async () => {
  const e = await engine();
  const { map } = touchStore();
  const store: EffortTouchStore = { get: id => map.get(id), set: (id, state) => { if (state === "pending") return false; map.set(id, state); return true; } };
  try {
    const S = (await e.turn("f4", { touch: store })).promptSession!;
    const t = await e.turn("f4", { variant: "max", cursor: S, touch: store });
    expect(t.done).toMatchObject({ ok: true });
    expect(t.sets).toHaveLength(0);
    expect(t.news).toHaveLength(1);
    expect(t.promptSession).not.toBe(S);
    expect(t.notices).toHaveLength(1);
  } finally { await e.close(); }
});

it("X10b the fresh session of a late-change fallback carries the conversation history (the prompt text was built for the session that moved)", async () => {
  const e = await engine({ FAKE_CUSTOM_LATE_CHANGE: "low" });
  const { store } = touchStore();
  try {
    const S = (await e.turn("x10b", { touch: store })).promptSession!;
    const t = await e.turn("x10b", { variant: "max", cursor: S, touch: store, history: true });
    expect(t.done).toMatchObject({ ok: true });
    expect(t.news).toHaveLength(1);
    expect(t.promptSession).not.toBe(S);
    expect(t.prompt?.promptText).toContain("EARLIER_HISTORY_ROW");
    expect(t.prompt?.promptText).toContain("EARLIER_REPLY_ROW");
  } finally { await e.close(); }
});

it("X1b the fresh session opened for an Engine decides turn carries the conversation history", async () => {
  const e = await engine();
  const { store } = touchStore();
  try {
    const S = (await e.turn("x1b", { variant: "max", touch: store })).promptSession!;
    const t = await e.turn("x1b", { cursor: S, touch: store, history: true });
    expect(t.news).toHaveLength(1);
    expect(t.prompt?.promptText).toContain("EARLIER_HISTORY_ROW");
  } finally { await e.close(); }
});
