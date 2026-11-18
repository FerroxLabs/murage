import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { directTranscriptRows } from "../partition-sources.ts";
import { replayBudgetBytes, replayWindow, REPLAY_BUDGET_CAP_BYTES } from "./disclosures.ts";
import { crossThreadLineageRefs, ownShownLineIds } from "./prompt-parts.ts";
import { COPY_ORIGINS, type LineageRef } from "./lineage-types.ts";
import { GROUP_CONTEXT_MESSAGES, roomContextMessages } from "../room-context.ts";
import { queueExternalUpdate } from "../external-context-delivery.ts";

const url = new URL("./retained-refs.ts", import.meta.url);
const retained = existsSync(url) ? await import(url.href) as typeof import("./retained-refs.ts") : undefined;
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

// control: T-X2 input derivation. A saturating context budget covers every
// finite supported engine budget, including future larger context windows.
it("T-X2 derives replay rows from the saturated production byte budget", () => {
  const bytes = replayBudgetBytes(Number.MAX_SAFE_INTEGER)!;
  expect(bytes).toBe(REPLAY_BUDGET_CAP_BYTES);
  expect(bytes).toBe(192 * 1024);
  const rows = directTranscriptRows(bytes);
  expect(rows).toBe(3072);
  expect(replayWindow(Array.from({ length: rows }, (_, id) => ({ id, text: "x" })), { maxBytes: bytes })).toHaveLength(rows);
  expect(source("../index.ts").includes("...skillCommandPart.lineageOf"), "builder retains ...skillCommandPart.lineageOf").toBe(true);
  expect(source("../index.ts").includes("working.part.lineageOf"), "builder retains working.part.lineageOf").toBe(true);
  expect(source("../index.ts").includes("learnedBlock.lessonIds.map"), "builder retains learnedBlock.lessonIds.map").toBe(true);
});

// red-at-4df086541: the required lossless normalizer is absent at baseline.
// Structural contract assertion, not runtime-boundary evidence. Quotes can be older
// than the replay, and every copied row can name COPY_ORIGINS distinct originals.
it("T-X2 counts distinct replay, quote, copy, pin, working and object parents", () => {
  expect(retained, "T-X2 requires the design's lossless normalizer before counting").toBeDefined();
  const rows = directTranscriptRows(replayBudgetBytes(Number.MAX_SAFE_INTEGER)!);
  const replay = Array.from({ length: rows }, (_, i) => `replay-${i}`);
  const shown = replay.flatMap(id => [
    { threadId: "direct", id, copyOf: { threadId: "originals", messageIds: Array.from({ length: COPY_ORIGINS }, (_, j) => `${id}-${j}`) } },
    { threadId: "direct", id: `quote-${id}`, copyOf: { threadId: "originals", messageIds: Array.from({ length: COPY_ORIGINS }, (_, j) => `quote-${id}-${j}`) } },
  ]);
  const own = ownShownLineIds("direct", replay, shown, new Set());
  const refs: LineageRef[] = [
    { kind: "prefix", threadId: "direct", shown: own },
    ...crossThreadLineageRefs("direct", shown, new Set()),
    ...Array.from({ length: 8 }, (_, i): LineageRef => ({ kind: "line", threadId: "working", messageId: String(i) })),
    ...Array.from({ length: 100 }, (_, i): LineageRef => ({ kind: "memory", ref: { kind: "lesson", id: String(i) } })),
    { kind: "memory", ref: { kind: "skill", id: "expanded-command" } },
    { kind: "receipt", bundleId: "dispatch", scopeIds: [], lsn: 1 },
  ];
  const normalized = retained!.normalizeRetainedRefs([...refs, ...refs]);
  const counts = retained!.retainedRefCounts(normalized);
  expect(counts).toEqual({ lines: rows * 2 * (1 + COPY_ORIGINS) + 8, objects: 102 });
  expect(counts.objects).toBeLessThanOrEqual(retained!.RETAINED_OBJECTS_MAX);
  const room = roomContextMessages(Array.from({ length: GROUP_CONTEXT_MESSAGES + 1 }, (_, i) => ({ id: String(i), kind: "text" as const, text: "x" })), GROUP_CONTEXT_MESSAGES, "0");
  expect(room).toHaveLength(GROUP_CONTEXT_MESSAGES + 1);
});

// r2 A3.7 pins a 4096-line hard cap and refuses crossing it; it does not
// promise an initial half-cap. Preserve the historical 3072-row lower-bound
// witness without asserting the incompatible historical 2048-row allowance.
it("T-X2 saturated replay fits the fixed hard cap without shrinking the window", () => {
  const rows = directTranscriptRows(replayBudgetBytes(Number.MAX_SAFE_INTEGER)!);
  expect(rows).toBe(3072);
  expect(rows).toBeLessThanOrEqual(retained?.RETAINED_LINES_MAX ?? 4096);
});

// control: records why a finite complete T-X2 proof cannot currently be made.
// Oversized unions must be refused by the ledger; this does not cut a window.
it("T-X2 records the unbounded owed-parent input to the direct builder", () => {
  let owed: string[] = [];
  for (let i = 0; i < 4097; i++) owed = queueExternalUpdate(owed, `owed-${i}`);
  expect(owed).toHaveLength(4097);
  expect(source("../index.ts").includes("...(memoryLastResort ? [] : task.externalUpdates ?? [])"), "ordinary builder retains the whole task.externalUpdates input").toBe(true);
});
