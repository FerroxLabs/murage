// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The quality gate's table (designs/MEMORY-GATE-1012.md). Dropped lines are thin or passing; every kept line is one a looser rule
// would have lost, because a false drop costs a real memory.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { captureSource } from "./capture.ts";
import { gateCandidates, gateReason } from "./candidate-gate.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource } from "./consolidate.ts";
import { extractCandidates, memoryExtractionMessages, parseMemoryExtractionCandidates, type TextOnlyExtractor } from "./extract.ts";
import { EXTRACTION_SUMMARY_MS, extractionOutcomes } from "./extraction-outcomes.ts";
import { claimMemoryJob, publishMemoryWork, resetMemoryClaimCursor } from "./jobs.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";

const NOW = Date.UTC(2026, 9, 30, 12);

describe("gate table", () => {
  it.each([
    ["The user liked the photo", "placeholder"],
    ["The user liked the photo.", "placeholder"],
    ["The speaker likes it", "placeholder"],
    ["You sent the photo", "placeholder"],
    ["You uploaded an image", "placeholder"],
    ["She really loved those screenshots", "placeholder"],
    ["The speaker is already at the airport", "transient"],
    ["The speaker is already at the airport.", "transient"],
    ["You are at the airport", "transient"],
    ["Already at the gate", "transient"],
    ["You're on the train", "transient"],
    ["The user’s at the gym right now", "transient"],
    ["I am currently waiting for the bus", "transient"],
    ["The user is having lunch", "transient"],
    ["You are on your way home", "transient"],
    ["You are heading to the airport", "transient"],
    ["The speaker is about to board", "transient"],
    ["You are feeling a bit tired today", "transient"],
    ["We are in a meeting", "transient"],
    ["Sounds good", "thin"],
    ["Thanks!", "thin"],
    ["Okay", "thin"],
  ])("drops %s", (text, reason) => { expect(gateReason({ text }, NOW)).toBe(reason); });

  it.each([
    "She has epilepsy",
    "They are married",
    "He is vegetarian",
    "She is vegan",
    "You prefer tea over coffee",
    "You are allergic to peanuts",
  ])("a durable line is kept from an old-shaped reply, and with the flag on: %s", text => {
    const quote = "said so";
    expect(gateCandidates([{ text, quote }], NOW).kept).toEqual([{ text, quote }]);
    expect(gateCandidates([{ text, quote, transient: true }], NOW).kept).toEqual([{ text, quote }]);
  });

  it.each([
    "You wrote the document",
    "You own the image",
    "You signed the document",
    "You took the photo",
    "You made the video",
    "You lost the file",
    "You love them",
    "You will send the file",
    "You never open the attachment",
    "You did not send the message",
    "I did not like that",
    "You do not share the photo",
    "It was great",
    "That works",
    "They are vegan",
    "She is walking",
    "He is driving",
    "You are in line for a promotion",
    "You are in the restaurant business",
    "You were at Changi airport on 2026-10-28 before the flight to Miami",
    "Your daughter Mia starts school in September",
    "You keep the house keys in the blue bowl",
    "The user's daughter Mia starts school in September",
    "The user is vegetarian",
    "The speaker prefers morning meetings",
    "The user loved the photo of Mia at the beach",
    "The user sent the signed lease file to the landlord",
    "You sent the photo to Mia",
    "You keep the file in the blue folder",
    "Mia liked the photo",
    "The user hates it when meetings run long",
    "You are in sales",
    "You are on the board",
    "You are at Google",
    "You are in Miami",
    "The user is currently at Acme",
    "You are at the office every Tuesday",
    "You are at the airport on 2026-11-03",
    "You work at the airport",
    "You are not at the airport",
    "You were at the airport",
    "You are on the train to Boston",
    "You are having a baby in June",
    "You are having surgery next month",
    "You are going to Japan in March",
    "You are about to start a new job",
    "You are waiting for the visa approval",
    "You are feeling burned out at work",
    "Mia is allergic to peanuts",
    "Allergic to peanuts",
    "Vegetarian",
    "It costs $40 a month",
    "It is due Friday",
    "He teaches piano on weekends in Austin",
    "Tu hija Mia empieza la escuela en septiembre",
    "El usuario está en el aeropuerto",
    "",
  ])("keeps %s", text => { expect(gateReason({ text }, NOW)).toBeNull(); });

  it("an object key that names the thing keeps a placeholder line; a bare one does not", () => {
    expect(gateReason({ text: "The user liked the photo", object: "beach photo" }, NOW)).toBeNull();
    expect(gateReason({ text: "You like it", object: "green tea" }, NOW)).toBeNull();
    for (const object of ["photo", "the photo", "it", "  ", "those screenshots"]) expect(gateReason({ text: "The user liked the photo", object }, NOW)).toBe("placeholder");
  });

  it("a long line is never read by the text rules, however it begins", () => {
    expect(gateReason({ text: `The user liked the photo ${"and more ".repeat(300)}` }, NOW)).toBeNull();
    expect(gateReason({ text: "You are at the airport and then you are at the airport and then home" }, NOW)).toBeNull();
  });

  const flagStates = [{}, { transient: false }, { transient: true }];

  it.each(["You are in the restaurant business", "You are going back to college"])("a durable line is kept whatever the flag says: %s", text => {
    for (const flag of flagStates) expect(gateReason({ text, ...flag }, NOW)).toBeNull();
  });

  it.each([
    ["The user liked the photo", "placeholder"],
    ["The speaker is already at the airport", "transient"],
  ])("a thin line drops on its words, whatever the flag says: %s", (text, reason) => {
    for (const flag of flagStates) expect(gateReason({ text, ...flag }, NOW)).toBe(reason);
  });

  it("the flag never drops a line: only the whole line's words can", () => {
    for (const text of [
      "You are stuck in traffic behind a truck", "You are at the gym with your sister",
      "Estás en el aeropuerto", "You are in the carpool", "You are in Miami today", "You are at the airport on 2026-11-03",
      "You are waiting for a kidney transplant", "You are sleeping with your boss", "You are having a baby soon", "You are feeling better about the move",
    ]) for (const flag of flagStates) expect(gateReason({ text, ...flag }, NOW)).toBeNull();
  });

  it("a when on another day keeps the line, for the words and the flag alike; today or a bad date does not", () => {
    for (const fields of [{}, { transient: true }, { transient: false }]) {
      for (const when of ["2026-10-31", "2026-11-03", "2026-10-28"]) expect(gateReason({ text: "You are going home", when, ...fields }, NOW)).toBeNull();
      for (const when of ["2026-10-30", "2026-10-29", "not a date", ""]) expect(gateReason({ text: "You are going home", when, ...fields }, NOW)).toBe("transient");
    }
  });

  it("corrections, fiction and procedures pass untouched", () => {
    for (const fields of [{ update: true }, { claimType: "character-canon" }, { claimType: "procedure" }]) {
      expect(gateReason({ text: "She is at the airport", transient: true, ...fields }, NOW)).toBeNull();
      expect(gateReason({ text: "Okay", ...fields }, NOW)).toBeNull();
    }
    expect(gateReason({ text: "Okay", claimType: "owner-statement" }, NOW)).toBe("thin");
  });

  it("survivors carry no reply-only field, so the id hash and all later code see today's shape", () => {
    const base = { text: "You prefer tea over coffee", quote: "tea", startByte: 0, endByte: 3, claimType: "owner-statement", subject: "drink", predicate: "prefers" };
    const { kept, dropped } = gateCandidates([{ ...base, object: "tea", when: "2026-10-30", transient: false }], NOW);
    expect(kept).toEqual([base]);
    expect(JSON.stringify(kept[0])).toBe(JSON.stringify(base));
    expect(dropped).toEqual({ placeholder: 0, transient: 0, thin: 0 });
  });

  it("counts every drop by reason and keeps the rest in reply order", () => {
    const { kept, dropped } = gateCandidates([{ text: "Sounds good" }, { text: "Mia is allergic to peanuts" }, { text: "The user liked the photo" }, { text: "You are at the gym" }, { text: "You prefer tea over coffee" }], NOW);
    expect(kept.map(candidate => candidate.text)).toEqual(["Mia is allergic to peanuts", "You prefer tea over coffee"]);
    expect(dropped).toEqual({ placeholder: 1, transient: 1, thin: 1 });
  });
});

describe("reply fields", () => {
  const source = "I prefer green tea in the morning.";
  const item = { text: "You prefer green tea", quote: "green tea" };
  it("old-shaped replies parse in both modes", () => {
    for (const mode of ["strict", "keep-grounded"] as const) expect(parseMemoryExtractionCandidates(source, JSON.stringify([item]), mode)).toEqual([{ ...item, startByte: 9, endByte: 18 }]);
  });
  it("a bad extra never costs its candidate", () => {
    const bad = JSON.stringify([{ ...item, object: "x".repeat(500), when: 42, transient: "yes" }]);
    for (const mode of ["strict", "keep-grounded"] as const) {
      const [one] = parseMemoryExtractionCandidates(source, bad, mode);
      expect(one).toMatchObject({ ...item, startByte: 9 });
      expect(one!.object).toBeUndefined(); expect(one!.when).toBeUndefined(); expect(one!.transient).toBeUndefined();
    }
  });
  it("the prompt asks for them and says what the flag is not for", () => {
    const system = memoryExtractionMessages("x")[0]!.content;
    for (const words of ["object when the predicate takes one", "when (an ISO date)", "transient=true", "never for plans"]) expect(system).toContain(words);
    expect(system).toContain("update=true only for explicit corrections");
  });
});

describe("the gate in the extraction path", () => {
  const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
  const signal = () => new AbortController().signal;
  beforeEach(() => {
    extractionOutcomes.clear();
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    reconcileMemoryRoster(roster); setMemoryMode("capture"); resetMemoryClaimCursor();
  });
  afterEach(() => { extractionOutcomes.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });
  function captured(text: string) {
    storeAnchorMessage(database(), "thread", "m-src", text);
    captureSource(database(), { id: "src", threadId: "thread", messageId: "m-src", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text } as Parameters<typeof captureSource>[1]);
    const work = claimMemoryJob("w")!; publishMemoryWork(work, "w", captureWork(work));
    return work.id;
  }
  /** Candidate rows only: the captured source keeps its own row, whatever the gate does. */
  const rows = (source: string) => database().prepare("SELECT text FROM memory_records ORDER BY text").all().map(row => String(row.text)).filter(text => text !== source);

  it("a dropped candidate reaches no grounding call and no row; a kept one still does", async () => {
    const source = "I am at the airport. I prefer green tea in the morning.";
    const extractor = (async () => JSON.stringify([
      { text: "The speaker is already at the airport", quote: "I am at the airport", claimType: "owner-statement" },
      { text: "You prefer green tea in the morning", quote: "I prefer green tea in the morning", claimType: "owner-statement" },
    ])) as TextOnlyExtractor;
    const ground = vi.fn(async () => '{"supported":true}'); extractor.ground = ground;
    expect((await consolidateMemorySource(captured(source), extractor, signal())).status).toBe("complete");
    expect(ground).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(ground.mock.calls)).not.toContain("airport");
    expect(rows(source)).toEqual(["You prefer green tea in the morning"]);
  });

  it("a slice where everything drops commits like an empty reply: no retry, no failed attempt", async () => {
    const source = "I am at the airport.";
    const extractor = vi.fn(async () => JSON.stringify([{ text: "The speaker is already at the airport", quote: "I am at the airport" }])) as unknown as TextOnlyExtractor;
    expect((await consolidateMemorySource(captured(source), extractor, signal())).status).toBe("complete");
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(rows(source)).toEqual([]);
  });

  it("the hourly line says how many, by reason, and never what", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const source = "I am at the airport and I liked the photo of the sea.";
    const extractor = (async () => JSON.stringify([
      { text: "The speaker is at the airport", quote: "I am at the airport" },
      { text: "The user liked the photo", quote: "I liked the photo" },
    ])) as TextOnlyExtractor;
    expect(await extractCandidates(source, extractor, signal())).toMatchObject({ status: "complete", candidates: [] });
    vi.advanceTimersByTime(EXTRACTION_SUMMARY_MS);
    const lines = info.mock.calls.map(call => String(call[0]));
    expect(lines.filter(line => line.includes("extraction outcomes"))).toHaveLength(1);
    expect(lines).toContainEqual(expect.stringMatching(/^\[memory\] extraction gate dropped=2 placeholder=1 transient=1 thin=0 extractor=[0-9a-f]{32} engine=[a-z-]+$/));
    expect(lines.join("\n")).not.toMatch(/airport|photo|speaker/);
  });

  it("no drops, no gate line", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const source = "I prefer green tea.";
    await extractCandidates(source, (async () => JSON.stringify([{ text: "You prefer green tea", quote: "green tea" }])) as TextOnlyExtractor, signal());
    vi.advanceTimersByTime(EXTRACTION_SUMMARY_MS);
    expect(info.mock.calls.map(call => String(call[0])).join("\n")).not.toContain("extraction gate");
  });
});
