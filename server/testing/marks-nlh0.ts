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

/** NOLIM B5 (Astra C): the initiator a fixture PROVES, stated from its stored facts alone (never from the verdict under test). `base` is the origin
 * the calling test's own context carries before the cell's patch is laid over it (the owner, in every MARKS row). */
export function provenInitiator(patch: Record<string, unknown> = {}, base: Record<string, unknown> = { fullAccessOrigin: "owner" }): boolean {
  const facts = { ...base, ...patch };
  const quiet = facts.unattended !== true && facts.channelOwner !== true;
  if (facts.fullAccessOrigin === "owner") return quiet && facts.automated !== true;
  if (facts.fullAccessOrigin === "routine") return quiet && facts.routineLevel === true;
  if (facts.fullAccessOrigin === "owner-channel") return facts.channelOwner === true;
  return false;
}

export type Added = { classification?: "ask" | "deny"; reason?: string; namedCatastrophe?: true };
export type CellSpec = {
  text: string;
  n2: boolean;
  held?: Record<string, Added>;
  owner?: Record<string, unknown>;
};

// Independent fixture vocabulary; the B5 drift test compares it with the policy list.
export const WIPE_RULES: ReadonlySet<string> = new Set(["delete-root", "delete-home", "delete-system-folder", "disk-erase", "fork-bomb"]);
const ADDED_KEYS = ["classification", "reason", "namedCatastrophe"] as const;

/** Select solely from the pinned cell, never from the actual verdict's winning rule. */
export function selectAdded(pin: unknown, spec: CellSpec, bot: unknown, patch: unknown): Added | undefined {
  if (!plainObject(pin) || pin.approve !== null || pin.source !== "always-ask") return undefined;
  const key = `${pin.rule}${pin.reader ? "/held" : ""}`;
  return spec.held?.[`${key}@${JSON.stringify(bot)}|${JSON.stringify(patch)}`] ?? spec.held?.[key];
}

/** Keep the actual verdict at this seam so tests can prove it cannot select its own expectation. */
export function selectForCell(pin: unknown, _verdict: unknown, spec: CellSpec, bot: unknown, patch: unknown): Added | undefined {
  return selectAdded(pin, spec, bot, patch);
}

/** Only fixture authority can authorize an ask-to-run transition. */
export function runRefusal(pin: string, actual: unknown, spec: { allowRun: boolean; n2: boolean }): string | undefined {
  const base = JSON.parse(pin) as { approve?: unknown; rule?: string };
  const got = actual as { approve?: unknown; source?: unknown; rule?: unknown } | null;
  if (!spec.allowRun) return "the fixture's level or initiator does not authorise a run";
  if (base.approve !== null) return "the pinned NLH0 answer was not an ask";
  if (WIPE_RULES.has(base.rule ?? "")) return "the pinned NLH0 answer is a wipe row";
  if (!got || typeof got !== "object" || typeof got.approve !== "string" || got.source !== "no-limits" || typeof got.rule !== "string" || !got.rule.startsWith("n1="))
    return "the actual verdict is not the finalizer's run";
  if (spec.n2) return "the fixture states N2: it must stay a card";
  return undefined;
}

/** Direct comparisons cannot authorize a changed run. Validate added fields before equality. */
export function nlh0(id: string, actual: unknown, run?: { allowRun: boolean; n2: boolean }, added?: Added): void {
  if (RECORD) { recorded[id] = canon(actual); return; }
  const pin = pinned[id];
  expect(pin, `${id} has a pinned NLH0 answer`).toBeDefined();
  const authorizedRun = isRun(actual) && run !== undefined && runRefusal(pin!, actual, run) === undefined;
  const compared = checkAdded(actual, JSON.parse(pin!), id, added, authorizedRun);
  if (compared === pin) return;
  if (isRun(actual)) {
    expect(run ? runRefusal(pin!, actual, run) : "a direct nlh0 comparison never authorises a run", `${id}: a run at No limits`).toBeUndefined();
    return;
  }
  expect(compared, id).toBe(pin);
}

function isRun(actual: unknown): boolean {
  const verdict = actual as { approve?: unknown; source?: unknown } | null;
  return !!verdict && typeof verdict === "object" && typeof verdict.approve === "string" && verdict.source === "no-limits";
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Every new field must be declared and equal its literal expectation before normalization. */
export function checkAdded(actual: unknown, base: unknown, id: string, added: Added | undefined, authorizedRun: boolean): string {
  if (!plainObject(actual) || !plainObject(base)) return canon(actual);
  const copy = { ...actual };
  for (const key of ADDED_KEYS) if (!(key in base)) {
    if (key in copy) {
      expect(added !== undefined && key in added, `${id}: ${key} is added but the fixture states no expected value`).toBe(true);
      expect(copy[key], `${id}: ${key}`).toBe(added![key]);
      delete copy[key];
    } else if (added && key in added && !authorizedRun) {
      expect.fail(`${id}: the fixture states ${key}=${added[key]} and the actual value lacks it`);
    }
  }
  return canon(copy);
}

if (RECORD) afterAll(() => {
  mkdirSync(RECORD, { recursive: true });
  writeFileSync(join(RECORD, `${basename(expect.getState().testPath ?? "file")}.json`), JSON.stringify(recorded));
});

/** True while the NLH0 tree is being recorded (every cell is recorded, nothing is asserted). */
export const recording = RECORD !== undefined;

/** One level × context cell, with literal fixture authority for both owner and pinned comparisons. */
export function cell(id: string, bot: { noLimits?: boolean }, patch: Record<string, unknown>, verdict: unknown, spec: CellSpec): void {
  if (isOwnerCell(bot, patch) && !recording) {
    const actual = verdict as Record<string, unknown>;
    if (spec.n2) {
      expect(verdict).toMatchObject({ approve: null, source: "always-ask" });
      expect(spec.owner, `${id}: an N2 owner cell states its verdict`).toBeDefined();
      expect(verdict, `${id}: owner verdict ${canon(spec.owner)}`).toMatchObject(spec.owner!);
      expect("namedCatastrophe" in actual, `${id}: a verdict never carries namedCatastrophe`).toBe(false);
    } else {
      expect(actual.approve, `${id}: the owner's No limits turn runs it`).toBeTruthy();
      for (const key of ADDED_KEYS) expect(key in actual, `${id}: a run carries no ${key}`).toBe(false);
    }
    return;
  }
  const cellId = `${id}|${JSON.stringify(bot)}|${JSON.stringify(patch)}`;
  const pin = pinned[cellId];
  const added = selectForCell(pin === undefined ? undefined : JSON.parse(pin), verdict, spec, bot, patch);
  nlh0(cellId, verdict, { allowRun: bot.noLimits === true && provenInitiator(patch), n2: spec.n2 }, added);
}
