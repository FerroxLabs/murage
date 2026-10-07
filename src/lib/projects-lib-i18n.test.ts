// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { en } from "@/locales";
import { allLocalePacks } from "@/locales/testing";
import { activityActor, activityLine, activityTime, sinceYouLeftLine } from "./project-activity";
import { boardAnnouncements, boardWriteFailure, cardFace, faceCacheKey, planMove, stateName, stateNames, swimlanes, workTime } from "./project-board";
import { cardHistoryLine } from "./project-card-history";
import { projectWriteReason, type ProjectBoardRead, type ProjectCard, type ProjectRead } from "./project-client";
import { channelProjectStatusLabel, channelProjectStatusNote, projectTimingLine } from "./channel-surface";
import { goalActionBody, goalActionLabel, goalBudgetLines, goalFormBody, goalStateLabel } from "./project-goal-view";
import { newProjectBody, startProjectReason } from "./project-new";
import { CHANNEL_PROJECT_STATUS_LABELS } from "../../shared/project";

afterEach(() => setLocale("en"));

const card = (over: Partial<ProjectCard> = {}): ProjectCard => ({ id: "c", number: 12, title: "Title", state: "doing", revision: 1, createdAt: 0, ...over });
const row = (kind: string, detail: Record<string, unknown> = {}) => ({ id: kind, kind, detail, at: 1000, actor: "owner", workItemId: "c", goalId: null, requestId: null });
const project = (over: Partial<ProjectRead> = {}) => ({ lifecycle: "open", settings: { endedAt: null, closedAt: null }, ...over }) as ProjectRead;

describe("card face and activity render in German", () => {
  it("names card states and card face text in German", async () => {
    await setLocale("de");
    const face = cardFace(card({ state: "review", dueAt: 1, createdAt: 0, usage: { workMs: 90 * 60000, tokens: 1500, tokensReported: true } }), [], [], [], [], 1000 * 60 * 60 * 5);
    expect(face.state).toBe("In Prüfung");
    expect(face.assignee).toBe("Nicht zugewiesen");
    expect(face.time).toBe("überfällig");
    expect(face.work).toBe("1 Std. 30 Min.");
    expect(cardFace(card({ state: "todo" }), [], [], [], [], 0).state).toBe("Zu erledigen");
    expect(stateName("cancelled")).toBe("Archiviert");
  });

  it("writes activity lines and card history in German", async () => {
    await setLocale("de");
    const cards = [card()];
    expect(activityLine(row("card_moved", { from: "doing", to: "waiting" }), cards, null)).toBe("Karte 12 von In Arbeit nach Wartet verschoben");
    expect(activityLine(row("card_created"), cards, null)).toBe("Karte 12 „Title“ wurde hinzugefügt");
    expect(activityLine(row("goal_state", { to: "working" }), cards, null)).toBe("Das Ziel ist jetzt In Arbeit");
    expect(activityLine(row("deadline"), cards, null)).toBe("Die Frist wurde erreicht");
    expect(cardHistoryLine(row("card_moved", { from: "todo", to: "done" }))).toBe("Von Zu erledigen nach Erledigt verschoben");
    expect(activityActor("owner", [])).toBe("Du");
    expect(activityTime(1000, 121000)).toBe("vor 2 Min.");
    expect(sinceYouLeftLine({ messages: 2, cards: 1, decisions: 1 })).toBe("Seit deinem Weggang: 2 Nachrichten, 1 Karte geändert, 1 Entscheidung");
    expect(workTime(60000 * 61)).toBe("1 Std. 1 Min.");
  });

  it("translates the refusal reasons, goal labels and form errors shown in the UI", async () => {
    await setLocale("de");
    expect(projectWriteReason(null)).toBe("Projektdetails sind noch nicht verfügbar");
    expect(projectWriteReason(project({ lifecycle: "closed" }))).toBe("Dieses Projekt ist geschlossen");
    expect(goalStateLabel("awaiting_signoff")).toBe("Wartet auf deine Freigabe");
    expect(goalActionLabel("approve_plan")).toBe("Plan genehmigen");
    expect(goalFormBody({ title: "", description: "", criteria: [], planFirst: false, review: false, deadline: "" })).toEqual({ error: "Gib dem Ziel einen Titel mit bis zu 200 Zeichen." });
    expect(goalActionBody({ id: "g", title: "t", state: "working", revision: 1 }, "start")).toEqual({ error: "Diese Aktion ist für dieses Ziel nicht verfügbar." });
    expect(boardWriteFailure({ error: "changed" }).line).toBe("Das hat sich geändert. Das Board ist jetzt auf dem neuesten Stand.");
    expect(startProjectReason({ leadBotId: null, parts: {} }, {})).toBe("Wähle eine Leitung und aktiviere Projektleitungen, bevor du startest.");
    expect(() => newProjectBody({ purpose: "", mode: "goal", members: [], leadBotId: "", goalTitle: "", goalDescription: "", criteria: [], deadline: "", folder: "" }, "id")).toThrow("Prüfe die Länge von Zweck und Zieltext.");
  });

  it("translates the status labels and notes on the project home", async () => {
    await setLocale("de");
    expect(channelProjectStatusLabel("active")).toBe("In Arbeit");
    expect(channelProjectStatusNote("paused")).toBe("Vorerst beiseitegelegt. Nichts geht verloren.");
    expect(projectTimingLine({ startedAt: Date.UTC(2026, 0, 5, 12) })).toMatch(/^Gestartet am .*2026\.$/);
  });

  it("translates move reasons, announcements, lanes and budget lines", async () => {
    await setLocale("de");
    const board = { lifecycle: "open", columns: [], columnsRevision: 1, cards: [card({ state: "todo", assigneeBotId: "a" })] } as ProjectBoardRead;
    const plan = planMove(board, "c", { columnId: "review", index: 0 });
    expect(plan).toMatchObject({ ok: false, reason: "Karte 12 kann nicht nach In Prüfung verschoben werden." });
    expect(swimlanes([]).map(l => l.name)).toEqual(["Nicht zugewiesen", "Du"]);
    const next = { ...board, cards: [{ ...board.cards[0], state: "done" as const, revision: 2 }] };
    expect(boardAnnouncements(board, next)).toEqual(["„Title“ verschoben nach Erledigt"]);
    const usage = { lifecycle: "open", totals: { workMs: 600000, input: 1000, output: 500, tokensReported: true, charge: null }, byBot: [], notReported: [], budgets: [] } as never;
    expect(goalBudgetLines({ id: "b", state: "warned", revision: 1, maxWorkMinutes: 60 }, usage, [])).toEqual(["10 Min. von 1 Std.", "1.5K Tokens", "80 % verbraucht"]);
  });
});

describe("the language-neutral values stay English", () => {
  it("keeps state ids, bot-bound and shared constants English whatever the language", async () => {
    await setLocale("de");
    expect(stateNames.doing).toBe("In progress");
    expect(CHANNEL_PROJECT_STATUS_LABELS.active).toBe("In progress");
    const plan = planMove({ lifecycle: "open", columns: [], columnsRevision: 1, cards: [card({ state: "review" })] } as ProjectBoardRead, "c", { columnId: "done", index: 0 });
    expect(plan).toMatchObject({ ok: true, body: { action: "move", toState: "done" } });
  });
});

describe("the card face cache follows the language", () => {
  it("changes its key when the language version changes", () => {
    const inputs = { members: [], goal: null, requests: [], cards: [], now: 0 };
    expect(faceCacheKey(inputs, 0)).not.toBe(faceCacheKey(inputs, 1));
    expect(faceCacheKey(inputs, 1)).toBe(faceCacheKey(inputs, 1));
  });
});

describe("the flag, not the text", () => {
  it("marks a past due card with a flag the sheet can test", async () => {
    expect(cardFace(card({ dueAt: 5 }), [], [], [], [], 10).pastDue).toBe(true);
    expect(cardFace(card({ dueAt: 50 }), [], [], [], [], 10).pastDue).toBe(false);
    expect(cardFace(card(), [], [], [], [], 10).pastDue).toBe(false);
    await setLocale("de");
    expect(cardFace(card({ dueAt: 5 }), [], [], [], [], 10).pastDue).toBe(true);
    const sheet = readFileSync(new URL("../components/ProjectCardSheet.tsx", import.meta.url), "utf8");
    expect(sheet).not.toContain('"past due"');
    expect(sheet).toContain("face.pastDue");
  });
});

describe("German projects strings use the informal du", () => {
  it("has no formal Sie forms in de projects.*", async () => {
    const de = (await allLocalePacks()).de as Record<string, string>;
    const hits = Object.entries(de).filter(([key, value]) => key.startsWith("projects.") && /\b(Sie|Ihnen|Ihr\w*)\b/.test(value)).map(([key]) => key);
    expect(hits).toEqual([]);
  });
});

describe("every projects.* key, old and new, is in every pack", () => {
  it("has no missing projects.* value and keeps the banned words out", async () => {
    const keys = Object.keys(en).filter(key => key.startsWith("projects."));
    expect(keys.length).toBeGreaterThan(450);
    for (const [code, pack] of Object.entries(await allLocalePacks())) {
      for (const key of keys) {
        const value = (pack as Record<string, string | undefined>)[key];
        expect(value, `${code} ${key}`).toBeTruthy();
        expect(value, `${code} ${key}`).not.toMatch(/—|–|composio|\b(safe|safely|safety|unsafe)\b/i);
      }
    }
  });
});
