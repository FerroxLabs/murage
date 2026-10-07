// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The `learned` shape (bot-learning batch B3): one text block that rides the
// turn's message on every engine, pinned per turn, refreshed on a resumed
// session when a lesson is added, edited or undone.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BOT_LEARNING } from "./bot-learning.ts";
import {
  SHAPE_CATALOGUE, botShapeRows, learnedForTurn, pinLearnedForTurn, recordTurnShapes, shapeLayer, withLearned, lastTurnShapes, joinShapeLayers,
  type CurrentShapes,
} from "./bot-shapes.ts";
import { CLAUDE_TOOL_SURFACE, CODEX_TOOL_SURFACE, FUIGO_TOOL_SURFACE, NEUTRAL_TOOL_SURFACE, NO_TOOL_SURFACE, PI_TOOL_SURFACE, renderMurageTools } from "./murage-tool-surface.ts";
import { changeLearningEvent } from "./memory/learning-history.ts";
import { addLesson, renderLearnedBlock } from "./memory/lessons.ts";
import { migrateMemorySchema } from "./memory/schema.ts";

let db: DatabaseSync;
let clock = 1_700_000_000_000;
const learn = (text: string) => { const r = addLesson(db, { botId: "ember", text, origin: "typed", learning: DEFAULT_BOT_LEARNING, now: clock++ }); if (r.status !== "applied") throw new Error(r.status); return r.lesson; };
const block = () => renderLearnedBlock(db, { botId: "ember", threadId: "t1", ownerAudience: true, now: clock, turnsSince: () => 0 });
beforeEach(() => { db = new DatabaseSync(":memory:"); migrateMemorySchema(db); });

describe("the learned shape row", () => {
  it("is in the catalogue as a read-only row before the skills list, and never part of the system prompt", () => {
    expect(SHAPE_CATALOGUE.learned).toMatchObject({ label: "What it learned", group: "identity" });
    learn("No emojis in client emails");
    const current: CurrentShapes = { houseRules: { on: true, text: "" }, persona: "P", teamBrief: null, memory: "", chiefGuide: null, skills: [], learned: block().text };
    const ids = botShapeRows(current, null).map(row => row.id);
    expect(ids).toContain("learned");
    const rows = botShapeRows(current, null);
    expect(rows.find(row => row.id === "learned")!.text).toContain("No emojis in client emails");
    // after a turn it shows exactly what that turn carried
    recordTurnShapes("ember", { where: "chat", threadId: "t1", layers: [shapeLayer("persona", "P"), shapeLayer("learned", "<what-it-learned>\nOLD\n</what-it-learned>")] });
    expect(botShapeRows(current, lastTurnShapes("ember")).find(row => row.id === "learned")!.text).toContain("OLD");
    expect(lastTurnShapes("ember")!.text).toBe("P"); // not in the system text
    expect(joinShapeLayers(lastTurnShapes("ember")!.layers.filter(l => l.id !== "learned"))).toBe("P");
  });
  it("shows no row when nothing has been learned", () => {
    const current: CurrentShapes = { houseRules: { on: true, text: "" }, persona: "P", teamBrief: null, memory: "", chiefGuide: null, skills: [], learned: "" };
    expect(botShapeRows(current, null).some(row => row.id === "learned")).toBe(false);
  });
});

describe("engine parity: the block is plain text", () => {
  it("is byte for byte the same through every engine's tool surface", () => {
    learn("Prefer the calendar tool over asking me for dates");
    const text = block().text;
    expect(text.length).toBeGreaterThan(0);
    for (const surface of [CLAUDE_TOOL_SURFACE, CODEX_TOOL_SURFACE, FUIGO_TOOL_SURFACE, PI_TOOL_SURFACE, NEUTRAL_TOOL_SURFACE, NO_TOOL_SURFACE])
      expect(renderMurageTools(text, surface, { agents: "agents", memory: "murage-memory" })).toBe(text);
    expect(withLearned("Hello", text)).toBe(`${text}\n\nHello`);
    expect(withLearned("Hello", "")).toBe("Hello");
  });
});

describe("pinning and refresh", () => {
  it("a turn reads one block: a rebuild inside the turn gets the same lessons even if one was undone meanwhile", () => {
    const lesson = learn("Lead with the decision");
    const first = pinLearnedForTurn("turn-1", block);
    changeLearningEvent(db, lesson.learningEventId!, "undo", clock++);
    expect(pinLearnedForTurn("turn-1", block)).toBe(first);
    expect(pinLearnedForTurn("turn-2", block).text).toBe("");
  });
  it("a fresh session gets the block; a resumed one only when it changed", () => {
    learn("Lead with the decision");
    const a = block();
    expect(learnedForTurn("s1", a, true)).toBe(a.text);
    expect(learnedForTurn("s1", a, false)).toBe(""); // already has it
    expect(learnedForTurn("s1", a, true)).toBe(a.text); // a new session starts over
    learn("No emojis");
    const b = block();
    const sent = learnedForTurn("s1", b, false);
    expect(sent).toContain("No emojis");
    expect(sent).toMatch(/replace any earlier/i);
    expect(learnedForTurn("s1", b, false)).toBe("");
  });
  it("Undo reaches a resumed session at its next turn, including the last lesson", () => {
    const one = learn("Lead with the decision");
    const two = learn("No emojis");
    learnedForTurn("s2", block(), true);
    changeLearningEvent(db, two.learningEventId!, "undo", clock++);
    const afterOne = learnedForTurn("s2", block(), false);
    expect(afterOne).toContain("Lead with the decision");
    expect(afterOne).not.toContain("No emojis");
    changeLearningEvent(db, one.learningEventId!, "undo", clock++);
    expect(learnedForTurn("s2", block(), false)).toMatch(/Nothing you learned .* applies right now/);
    expect(learnedForTurn("s2", block(), false)).toBe(""); // said once
    // and a fresh session never hears about it at all
    expect(learnedForTurn("s3", block(), true)).toBe("");
  });
  it("Undo reaches a session resumed after an app restart, before it has read anything this run (T1-06)", () => {
    const one = learn("Lead with the decision");
    const two = learn("No emojis");
    changeLearningEvent(db, two.learningEventId!, "undo", clock++);
    // "r1" has never been seen by this process: the delivered digest is unknown, so the block replaces whatever the session holds
    const resumed = learnedForTurn("restart-1", block(), false);
    expect(resumed).toMatch(/replace any earlier/i);
    expect(resumed).toContain("Lead with the decision");
    expect(resumed).not.toContain("No emojis");
    expect(learnedForTurn("restart-1", block(), false)).toBe(""); // said once
    changeLearningEvent(db, one.learningEventId!, "undo", clock++);
    expect(learnedForTurn("restart-2", block(), false)).toMatch(/Nothing you learned .* applies right now/); // the clear still arrives
    expect(learnedForTurn("restart-2", block(), false)).toBe("");
  });
  it("a resumed session of a bot that never learned anything hears nothing, before or after a restart", () => {
    expect(learnedForTurn("restart-3", block(), false)).toBe("");
    expect(learnedForTurn("restart-3", block(), false)).toBe("");
  });
  it("Keep within 30 seconds puts it back in front of the resumed session", () => {
    const lesson = learn("Lead with the decision");
    learnedForTurn("s4", block(), true);
    const t = clock++;
    changeLearningEvent(db, lesson.learningEventId!, "undo", t);
    learnedForTurn("s4", block(), false);
    changeLearningEvent(db, lesson.learningEventId!, "keep", t + 1000);
    expect(learnedForTurn("s4", block(), false)).toContain("Lead with the decision");
  });
  it("the switch off clears what a session read and sends nothing new", () => {
    learn("Lead with the decision");
    learnedForTurn("s5", block(), true);
    expect(learnedForTurn("s5", block(), false, false)).toMatch(/Nothing you learned/);
    expect(learnedForTurn("s5", block(), false, false)).toBe("");
  });
});
