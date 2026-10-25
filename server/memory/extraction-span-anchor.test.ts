// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.5: Memory > What it learned said "Could not learn from part of this conversation" after every learning run on the
// training rig. Each slice's replies came back (usage was reported) and were then refused whole by the span check, because
// a model cannot count the UTF-8 byte offsets of a source it was shown JSON-escaped. Three paid attempts later the slice was
// skipped. The span is now found from the quote itself; the model's offsets are a hint.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureSource } from "./capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { consolidateMemorySource } from "./consolidate.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { anchorQuote, parseMemoryExtractionCandidates, type TextOnlyExtractor } from "./extract.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "thread" }], groups: [] });
});
function capture(text: string) {
  captureSource(database(), { id: "source", threadId: "thread", origin: { kind: "attended" }, kind: "text", speaker: "owner", outcome: "recorded", text });
  const work = claimMemoryJob("fixture")!; expect(work).toBeTruthy();
  publishMemoryWork(work, "fixture", captureWork(work)); return work.id;
}
const signal = () => new AbortController().signal;
// What the model was shown is {"source":"..."}: counting from there puts every offset 11 bytes late.
const SHOWN_PREFIX = Buffer.byteLength('{"source":"');
const skippedEvents = () => Number(database().prepare("SELECT count(*) AS n FROM memory_learning_events WHERE json_extract(detail,'$.outcome')='slice-skipped'").get()!.n);
const learned = () => database().prepare("SELECT text,state FROM memory_records WHERE id LIKE 'candidate:%'").all();

it("a reply whose offsets are counted from the JSON it was shown is learned on the first attempt, not skipped after three", async () => {
  const text = "Hi Ember, I'm Maya. I run Wren & Willow — a bike shop in Austin.", quote = "I run Wren & Willow — a bike shop in Austin.";
  const at = Buffer.from(text).indexOf(Buffer.from(quote));
  const extractor: TextOnlyExtractor = vi.fn(async () => JSON.stringify([{ text: quote, quote, claimType: "owner-statement", startByte: at + SHOWN_PREFIX, endByte: at + SHOWN_PREFIX + Buffer.byteLength(quote) }]));
  const job = capture(text);
  const result = await consolidateMemorySource(job, extractor, signal());
  expect(result).toMatchObject({ status: "complete" });
  expect(extractor).toHaveBeenCalledTimes(1);
  expect(learned()).toEqual([{ text: quote, state: "active" }]);
  // the stored evidence is the quote's exact bytes in the source
  const span = database().prepare("SELECT start_byte,end_byte FROM memory_evidence WHERE record_id LIKE 'candidate:%'").get()!;
  expect(Buffer.from(text).subarray(Number(span.start_byte), Number(span.end_byte)).toString("utf8")).toBe(quote);
  expect(skippedEvents()).toBe(0);
});

it("a reply wrapped in a ```json fence is read, and one ungrounded candidate costs only itself", async () => {
  const text = "I prefer short answers. Send invoices on Fridays.";
  const reply = "```json\n" + JSON.stringify([
    { text: "I prefer short answers.", quote: "I prefer short answers.", claimType: "owner-statement", startByte: 3, endByte: 9 },
    { text: "Maya lives in Paris.", quote: "I live in Paris.", claimType: "owner-statement", startByte: 0, endByte: 16 },
    { text: "Send invoices on Fridays.", quote: "Send invoices on Fridays.", claimType: "not-a-type" },
  ]) + "\n```";
  const job = capture(text);
  const result = await consolidateMemorySource(job, async () => reply, signal());
  expect(result).toMatchObject({ status: "complete" });
  // the words the source does not contain are never learned; the malformed one is dropped; the grounded one is kept
  expect(learned()).toEqual([{ text: "I prefer short answers.", state: "active" }]);
  expect(skippedEvents()).toBe(0);
});

it("a reply that offers candidates but grounds none is not a valid empty answer: the slice is retried, never closed with nothing", async () => {
  const text = "I prefer short answers.";
  expect(parseMemoryExtractionCandidates(text, "[]", "keep-grounded")).toEqual([]);
  expect(() => parseMemoryExtractionCandidates(text, JSON.stringify([{ text: "Maya lives in Paris.", quote: "I live in Paris." }]), "keep-grounded")).toThrow("MEMORY_EXTRACTION_NONE_GROUNDED");
  expect(() => parseMemoryExtractionCandidates(text, JSON.stringify([{ text: "x", quote: "I prefer short answers.", claimType: "not-a-type" }]), "keep-grounded")).toThrow("MEMORY_EXTRACTION_NONE_GROUNDED");
  const job = capture(text);
  const result = await consolidateMemorySource(job, async () => JSON.stringify([{ text: "Maya lives in Paris.", quote: "I live in Paris." }]), signal());
  expect(result).toMatchObject({ status: "deferred" });
  expect(learned()).toEqual([]);
});

it("objective evaluation stays strict: an ungrounded quote or a malformed candidate invalidates the reply, offsets are re-anchored", () => {
  const text = "ส่งแล้ว ok";
  expect(parseMemoryExtractionCandidates(text, JSON.stringify([{ text: "ok", quote: "ok", startByte: 0, endByte: 2 }]))[0]).toMatchObject({ startByte: Buffer.byteLength("ส่งแล้ว "), endByte: Buffer.byteLength(text) });
  expect(() => parseMemoryExtractionCandidates(text, JSON.stringify([{ text: "no", quote: "not there" }]))).toThrow("ungrounded span");
  expect(() => parseMemoryExtractionCandidates(text, JSON.stringify([{ text: "ok", quote: "ok", claimType: "not-a-type" }]))).toThrow();
  expect(() => parseMemoryExtractionCandidates(text, "Here are the facts: []")).toThrow("MEMORY_EXTRACTION_NOT_JSON");
});

it("a quote found twice takes the occurrence nearest the model's hint", () => {
  const source = Buffer.from("yes. no. yes.");
  expect(anchorQuote(source, "yes.", 0)).toEqual({ startByte: 0, endByte: 4 });
  expect(anchorQuote(source, "yes.", 12)).toEqual({ startByte: 9, endByte: 13 });
  expect(anchorQuote(source, "maybe", 0)).toBeNull();
});
