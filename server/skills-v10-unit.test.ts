// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10, lane skills: K4 the "In every message" preview equals the index
// a turn renders, and K5 bulk operations (recorded, read back, retried, undone).
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { handleSkillsBulk, readBulkOp, type BulkOp, type IsOn, type PinOver } from "./skills-bulk.ts";
import type { SkillsApiBot, SkillsApiRequest, SkillsApiResponse } from "./skills-api.ts";
import { INDEX_MAX_SKILLS, installSkill, setSkillEnabled, skillIndexPreview, skillsSystemPrompt } from "./skills.ts";

const SKILL = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the thing.\n`;
const unique = () => Math.random().toString(36).slice(2, 10);

describe("K4 skillIndexPreview", () => {
  it("names the lines in the rendered index, their sizes, and what is looked up instead, for a bot over the size", () => {
    const bot = `sv10-preview-${unique()}`;
    const names = Array.from({ length: 24 }, (_, i) => `house-skill-${String(i).padStart(2, "0")}`);
    for (const name of names) {
      expect(installSkill(bot, "src", [{ path: "SKILL.md", content: SKILL(name, "Does one house task the way the team does it, step by step.") }])).not.toHaveProperty("error");
      setSkillEnabled(bot, name, true);
    }
    const prompt = skillsSystemPrompt(bot);
    const lines = prompt.split("\n").filter((line) => line.startsWith("- "));
    const preview = skillIndexPreview(bot);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(24);
    expect(preview.inEveryMessage.map((entry) => entry.name)).toEqual(lines.map((line) => /^- ([a-z0-9-]+):/.exec(line)![1]));
    expect(preview.inEveryMessage.map((entry) => entry.bytes)).toEqual(lines.map((line) => Buffer.byteLength(line, "utf8")));
    expect(preview.lookedUp).toEqual(names.slice(lines.length));
    expect(preview.omitted).toBe(24 - lines.length);
    expect(preview.reason).toMatch(/cap$/);
  });

  it("puts every skill in the message for a bot under the size", () => {
    const bot = `sv10-preview-${unique()}`;
    installSkill(bot, "src", [{ path: "SKILL.md", content: SKILL("alpha", "Short.") }]);
    setSkillEnabled(bot, "alpha", true);
    expect(skillIndexPreview(bot)).toEqual({ inEveryMessage: [{ name: "alpha", bytes: expect.any(Number) }], lookedUp: [], omitted: 0, reason: null });
    expect(skillIndexPreview(`sv10-preview-${unique()}`)).toEqual({ inEveryMessage: [], lookedUp: [], omitted: 0, reason: null });
    expect(INDEX_MAX_SKILLS).toBeGreaterThan(1);
  });
});

describe("K5 bulk operations", () => {
  const made: string[] = [];
  afterEach(() => { for (const id of made.splice(0)) rmSync(join(DATA_DIR, "skills-bulk", `${id}.json`), { force: true }); });
  const opId = () => { const id = `op-${unique()}${unique()}`; made.push(id); return id; };
  const bots: SkillsApiBot[] = ["Tess", "Pepper", "Dax"].map((name) => ({ id: `sv10-${name.toLowerCase()}-${unique()}`, name, canUseSkills: true }));
  const [tess, pepper, dax] = bots as [SkillsApiBot, SkillsApiBot, SkillsApiBot];

  /** A stand-in for the single-switch route: it flips this map and answers like the route does. */
  function world(refusals: Record<string, { code: string; error: string }> = {}, faults: string[] = []) {
    const on = new Set<string>();
    const preOn: Record<string, number> = {};
    const calls: string[] = [];
    let dieOn: string | null = null;
    const isOn: IsOn = (botId, skill) => on.has(`${botId}|${skill}`);
    const apply = async (request: SkillsApiRequest): Promise<SkillsApiResponse | null> => {
      const match = /^\/api\/skills\/([^/]+)\/bots\/([\w-]+)$/.exec(request.path)!;
      const skill = decodeURIComponent(match[1]!);
      const botId = match[2]!;
      const key = `${botId}|${skill}`;
      calls.push(key);
      if (dieOn === key) throw new Error("the process died");
      const { on: want } = (await request.readBody()) as { on: boolean };
      if (faults.includes(skill)) return { status: 503, body: { error: "The skills library could not be read.", code: "library-unavailable" } };
      const refusal = want ? refusals[skill] : undefined;
      if (refusal) return { status: 409, body: refusal };
      if (want) on.add(key); else on.delete(key);
      return { status: 200, body: { skill: want ? { enabled: true } : null } };
    };
    const countOn = (botId: string) => [...on].filter((key) => key.startsWith(`${botId}|`)).length + (preOn[botId] ?? 0);
    return { on, calls, isOn, countOn, apply, dieOn: (key: string | null) => { dieOn = key; }, preOn };
  }
  const req = (method: string, path: string, body?: unknown, extra: Partial<SkillsApiRequest> = {}): SkillsApiRequest => ({
    method, path, url: new URL(`http://127.0.0.1${path}`), readBody: async () => body, bots: () => bots, ...extra,
  });
  const run = (w: ReturnType<typeof world>, method: string, path: string, body?: unknown, extra: Partial<SkillsApiRequest> = {}, pinOver: PinOver = () => false) =>
    handleSkillsBulk(req(method, path, body, extra), w.apply, w.isOn, w.countOn, pinOver);
  const pairOf = (op: BulkOp, skill: string, bot: SkillsApiBot) => op.pairs.find((pair) => pair.skill === skill && pair.botId === bot.id)!;

  it("a lost reply is read back by its id and reports each pair as on", async () => {
    const w = world();
    const id = opId();
    await run(w, "PUT", "/api/skills/bulk", { opId: id, skills: ["library:alpha", "library:beta"], on: true, target: { botIds: [tess.id, pepper.id] } });
    const back = await run(w, "GET", `/api/skills/bulk/${id}`);
    const op = (back!.body as { op: BulkOp }).op;
    expect(op.pairs).toHaveLength(4);
    expect(op.pairs.map((pair) => pair.state)).toEqual(["on", "on", "on", "on"]);
    expect((await run(w, "GET", "/api/skills/bulk/op-missing0001"))!.status).toBe(404);
  });

  it("a flagged skill and a bot that cannot use skills are refused and named, the rest go on", async () => {
    const w = world({ "library:flagged": { code: "needs-review", error: "This skill needs a look before it can be switched on." } });
    const id = opId();
    const reply = await run(w, "PUT", "/api/skills/bulk", { opId: id, skills: ["library:flagged", "library:clean"], on: true, target: { botIds: [tess.id] } });
    const op = (reply!.body as { op: BulkOp }).op;
    expect(pairOf(op, "library:flagged", tess)).toMatchObject({ state: "refused", code: "needs-review", reason: expect.stringContaining("needs a look") });
    expect(pairOf(op, "library:clean", tess).state).toBe("on");
  });

  it("a team is expanded once; a retry after the team changed touches only the pairs that were still unknown", async () => {
    const w = world();
    const id = opId();
    let members = [tess.id, pepper.id];
    const extra = { teamMembers: () => members };
    w.dieOn(`${pepper.id}|library:alpha`);
    await expect(run(w, "PUT", "/api/skills/bulk", { opId: id, skills: ["library:alpha"], on: true, target: { teamId: "crew" } }, extra)).rejects.toThrow("died");
    const half = readBulkOp(id)!;
    expect(half.pairs.map((pair) => [pair.botName, pair.state])).toEqual([["Tess", "on"], ["Pepper", "unknown"]]);
    members = [dax.id];
    w.dieOn(null);
    w.calls.length = 0;
    const retry = await run(w, "PUT", "/api/skills/bulk", { opId: id, skills: ["library:alpha"], on: true, target: { teamId: "crew" } }, extra);
    expect(w.calls).toEqual([`${pepper.id}|library:alpha`]);
    expect((retry!.body as { op: BulkOp }).op.pairs.map((pair) => [pair.botName, pair.state])).toEqual([["Tess", "on"], ["Pepper", "on"]]);
  });

  it("after a restart a pair that never recorded its outcome stays unknown, even though the manifest says on", async () => {
    const w = world();
    const id = opId();
    w.dieOn(`${tess.id}|library:alpha`);
    await expect(run(w, "PUT", "/api/skills/bulk", { opId: id, skills: ["library:alpha"], on: true, target: { botIds: [tess.id] } })).rejects.toThrow();
    w.on.add(`${tess.id}|library:alpha`); // the write landed before the process died
    const back = (await run(w, "GET", `/api/skills/bulk/${id}`))!.body as { op: BulkOp };
    expect(back.op.pairs[0]!.state).toBe("unknown");
    w.dieOn(null);
    // Try again: the pair was off before this operation (recorded before the switch moved), so it reads On and Undo puts it back.
    const retried = (await run(w, "PUT", "/api/skills/bulk", { opId: id, skills: ["library:alpha"], on: true, target: { botIds: [tess.id] } }))!.body as { op: BulkOp };
    expect(retried.op.pairs[0]!.state).toBe("on");
    const undo = (await run(w, "PUT", `/api/skills/bulk/${id}/undo`, { opId: opId() }))!.body as { op: BulkOp };
    expect(undo.op.pairs[0]!.state).toBe("off");
    expect(w.on.has(`${tess.id}|library:alpha`)).toBe(false);
  });

  it("a server fault is Could not check, not Not saved, and a retry runs that pair again", async () => {
    const w = world({}, ["library:alpha"]);
    const id = opId();
    const first = (await run(w, "PUT", "/api/skills/bulk", { opId: id, skills: ["library:alpha"], on: true, target: { botIds: [tess.id] } }))!.body as { op: BulkOp };
    expect(first.op.pairs[0]!).toMatchObject({ state: "unknown" });
    expect(first.op.pairs[0]!.reason).toBeUndefined();
    w.calls.length = 0;
    await run(w, "PUT", "/api/skills/bulk", { opId: id, skills: ["library:alpha"], on: true, target: { botIds: [tess.id] } });
    expect(w.calls).toEqual([`${tess.id}|library:alpha`]);
  });

  it("undo puts back what the operation changed and leaves a pair someone changed later as it is", async () => {
    const w = world();
    const id = opId();
    await run(w, "PUT", "/api/skills/bulk", { opId: id, skills: ["library:alpha"], on: true, target: { botIds: [tess.id, pepper.id] } });
    w.on.delete(`${pepper.id}|library:alpha`); // a later save by the owner
    const undoId = opId();
    const reply = await run(w, "PUT", `/api/skills/bulk/${id}/undo`, { opId: undoId });
    const undo = (reply!.body as { op: BulkOp }).op;
    expect(pairOf(undo, "library:alpha", tess).state).toBe("off");
    expect(pairOf(undo, "library:alpha", pepper)).toMatchObject({ state: "kept" });
    expect(w.on.has(`${tess.id}|library:alpha`)).toBe(false);
    // Asking again with the same id returns the same record and does nothing more.
    w.calls.length = 0;
    await run(w, "PUT", `/api/skills/bulk/${id}/undo`, { opId: undoId });
    expect(w.calls).toEqual([]);
  });

  it("is refused from an owner's browser, where each switch needs its own code", async () => {
    const w = world();
    const reply = await run(w, "PUT", "/api/skills/bulk", { opId: opId(), skills: ["library:alpha"], on: true, target: { botIds: [tess.id] } }, { ownerCode: async () => null });
    expect(reply).toMatchObject({ status: 409, body: { code: "bulk-needs-desktop" } });
    expect(w.calls).toEqual([]);
  });

  it("an id reused with different skills is refused, and a second request while one runs waits instead of racing", async () => {
    const w = world();
    const id = opId();
    const body = { opId: id, skills: ["library:alpha"], on: true, target: { botIds: [tess.id] } };
    await run(w, "PUT", "/api/skills/bulk", body);
    expect(await run(w, "PUT", "/api/skills/bulk", { ...body, skills: ["library:beta"] })).toMatchObject({ status: 409, body: { code: "op-mismatch" } });
    const slow = world();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inner = slow.apply;
    slow.apply = async (request) => { await gate; return inner(request); };
    const second = opId();
    const first = run(slow, "PUT", "/api/skills/bulk", { ...body, opId: second });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await run(slow, "PUT", "/api/skills/bulk", { ...body, opId: second })).toMatchObject({ status: 409, body: { code: "in-progress" } });
    release();
    await first;
    expect(slow.calls).toHaveLength(1);
  });

  it("a crashed undo is finished by asking again, and an undo id that belongs to another operation is refused", async () => {
    const w = world();
    const id = opId();
    await run(w, "PUT", "/api/skills/bulk", { opId: id, skills: ["library:alpha"], on: true, target: { botIds: [tess.id, pepper.id] } });
    const undoId = opId();
    w.dieOn(`${pepper.id}|library:alpha`);
    await expect(run(w, "PUT", `/api/skills/bulk/${id}/undo`, { opId: undoId })).rejects.toThrow("died");
    w.dieOn(null);
    const done = (await run(w, "PUT", `/api/skills/bulk/${id}/undo`, { opId: undoId }))!.body as { op: BulkOp };
    expect(done.op.pairs.map((pair) => pair.state)).toEqual(["off", "off"]);
    expect(w.on.size).toBe(0);
    const other = opId();
    await run(w, "PUT", "/api/skills/bulk", { opId: other, skills: ["library:alpha"], on: true, target: { botIds: [tess.id] } });
    expect(await run(w, "PUT", `/api/skills/bulk/${other}/undo`, { opId: undoId })).toMatchObject({ status: 409, body: { code: "op-mismatch" } });
  });

  it("turning on is all or nothing per bot at the ceiling: a bot the request would push past 40 is refused whole with no switch moved, others go on", async () => {
    const w = world();
    w.preOn[tess.id] = 38;
    const id = opId();
    const reply = await run(w, "PUT", "/api/skills/bulk", { opId: id, skills: ["library:alpha", "library:beta", "library:gamma"], on: true, target: { botIds: [tess.id, pepper.id] } });
    const op = (reply!.body as { op: BulkOp }).op;
    for (const skill of ["library:alpha", "library:beta", "library:gamma"]) {
      expect(pairOf(op, skill, tess)).toMatchObject({ state: "refused", code: "SKILL_CEILING", reason: expect.stringContaining("none were added") });
      expect(pairOf(op, skill, pepper)).toMatchObject({ state: "on" });
    }
    expect(w.calls.filter((call) => call.startsWith(tess.id))).toEqual([]);
    expect([...w.on].filter((key) => key.startsWith(tess.id))).toEqual([]);
    // exactly fitting is fine
    const fit = await run(w, "PUT", "/api/skills/bulk", { opId: opId(), skills: ["library:alpha", "library:beta"], on: true, target: { botIds: [tess.id] } });
    expect((fit!.body as { op: BulkOp }).op.pairs.map((pair) => pair.state)).toEqual(["on", "on"]);
  });

  it("library:x and collection:x in one request are one skill toward the 40, since only one of them can turn on", async () => {
    const w = world({ "collection:alpha": { code: "name-taken", error: "Tess already has a different skill called alpha." } });
    w.preOn[tess.id] = 39;
    const reply = await run(w, "PUT", "/api/skills/bulk", { opId: opId(), skills: ["library:alpha", "collection:alpha"], on: true, target: { botIds: [tess.id] } });
    const op = (reply!.body as { op: BulkOp }).op;
    expect(op.pairs.map((pair) => [pair.skill, pair.state, pair.code])).toEqual([["library:alpha", "on", undefined], ["collection:alpha", "refused", "name-taken"]]);
  });

  it("a bot the pin size limit would trip is refused whole with no switch moved, though it is under 40; a bot under the limit goes on", async () => {
    const w = world();
    const tooBig: PinOver = (botId, adding) => botId === tess.id && adding.length > 1;
    const reply = await run(w, "PUT", "/api/skills/bulk", { opId: opId(), skills: ["library:alpha", "library:beta"], on: true, target: { botIds: [tess.id, pepper.id] } }, {}, tooBig);
    const op = (reply!.body as { op: BulkOp }).op;
    for (const skill of ["library:alpha", "library:beta"]) {
      expect(pairOf(op, skill, tess)).toMatchObject({ state: "refused", code: "SKILL_CEILING", reason: expect.stringContaining("too large") });
      expect(pairOf(op, skill, pepper)).toMatchObject({ state: "on" });
    }
    expect(w.calls.filter((call) => call.startsWith(tess.id))).toEqual([]);
  });
});
