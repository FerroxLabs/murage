// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MARKS R1 (MurageMain 11-08): only the owner's own clean No limits turn reads with the MARKS denies; every other level and origin gives
// exactly what NLH0 (1320a3e29) gave. These helpers let a MARKS row state both halves: the owner cell keeps its strict expectation, and
// every other cell is compared with the verdict NLH0 produced for the same text, pinned in marks-nlh0-verdicts.json.
//
// The pinned file is made by running the same test files on the NLH0 tree with the marker file .marks-nlh0-record at the repo root: there every cell is recorded
// and nothing is asserted (NLH0 has no owner read, so the owner cells record NLH0's answer too and are simply never compared).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect } from "vitest";
import * as marks from "../shell/marks.ts";

/** ownerMarks where it exists (this tree); a plain call on the NLH0 tree, which has no owner read. */
export function ownerMarks<T>(read: () => T): T {
  const own = (marks as unknown as { ownerMarks?: <U>(run: () => U) => U }).ownerMarks;
  return own ? own(read) : read();
}

// Recording is switched on by an empty marker file at the repo root (the NLH0 run drops it there), not by an environment variable.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RECORD = existsSync(join(ROOT, ".marks-nlh0-record")) ? join(ROOT, ".marks-nlh0-out") : undefined;
const recorded: Record<string, string> = {};
let pinned: Record<string, string> = {};
if (!RECORD) pinned = JSON.parse(readFileSync(fileURLToPath(new URL("./marks-nlh0-verdicts.json", import.meta.url)), "utf8")) as Record<string, string>;

/** Stable text of a verdict or hit: sorted keys, functions and undefined dropped. */
export function canon(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([, v]) => v !== undefined && typeof v !== "function").sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [k, sort(v)]))
      : item;
  return JSON.stringify(sort(value) ?? null);
}

/** The cell is the owner's own clean No limits turn (the one place the MARKS denies are read). */
export function isOwnerCell(bot: { noLimits?: boolean }, patch: Record<string, unknown> = {}): boolean {
  return bot.noLimits === true && patch.ownerStarted !== false && patch.fullAccessOrigin !== "other" && patch.unattended !== true
    && patch.automated !== true && patch.routineLevel !== true && patch.channelOwner !== true;
}

/** A cell outside the owner's turn: it must equal what NLH0 gave for the same text (R1). */
export function nlh0(id: string, actual: unknown): void {
  const text = canon(actual);
  if (RECORD) { recorded[id] = text; return; }
  expect(pinned[id], `${id} has a pinned NLH0 answer`).toBeDefined();
  expect(text, id).toBe(pinned[id]);
}

if (RECORD) afterAll(() => {
  mkdirSync(RECORD, { recursive: true });
  writeFileSync(join(RECORD, `${basename(expect.getState().testPath ?? "file")}.json`), JSON.stringify(recorded));
});

/** True while the NLH0 tree is being recorded (every cell is recorded, nothing is asserted). */
export const recording = RECORD !== undefined;

/** One level x context cell of a MARKS row: the owner's clean No limits cell keeps its strict expectation, every other cell equals NLH0. */
export function cell(id: string, bot: { noLimits?: boolean }, patch: Record<string, unknown>, verdict: unknown, expectOwner: () => void): void {
  if (isOwnerCell(bot, patch) && !recording) expectOwner();
  else nlh0(`${id}|${JSON.stringify(bot)}|${JSON.stringify(patch)}`, verdict);
}
