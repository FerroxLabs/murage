// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LineageRef } from "./lineage-types.ts";
import { memoryRefKey } from "./lineage-types.ts";
import { chargeReleaseWork } from "./release-budget.ts";

// T-X2 must prove the complete initial-parent upper bound before increasing
// this cap. The saturated replay alone is 3072 rows; direct externalUpdates
// also contributes parents without a finite queue cap. Neither shrinking the
// replay nor counting only its newest 40 rows supplies that missing proof.
export const RETAINED_LINES_MAX = 4096;
export const RETAINED_OBJECTS_MAX = 512;
type Judge = "content" | "audience";
export const lineJudge = (ref: Extract<LineageRef, { kind: "line" }>): Judge =>
  ref.judge === "content" || ref.copyOfShown === true ? "content" : "audience";
export const prefixLineJudge = (ref: Extract<LineageRef, { kind: "prefix" }>, id: string): Judge =>
  ref.shownJudges !== undefined ? ref.shownJudges[id] === "content" ? "content" : "audience" : ref.content === true ? "content" : "audience";
const lineKey = (thread: string, id: string) => JSON.stringify([thread, id]);
const strictest = (a: Judge | undefined, b: Judge): Judge => a === "audience" || b === "audience" ? "audience" : "content";

/** Lossless union, including overlaps between prefixes, explicit lines and copy origins. */
export function normalizeRetainedRefs(refs: readonly LineageRef[], spend: (units: number) => void = chargeReleaseWork): LineageRef[] {
  const judges = new Map<string, Judge>();
  const out = new Map<string, LineageRef>();
  for (const ref of refs) {
    spend(1);
    if (ref.kind === "line") {
      const key = lineKey(ref.threadId, ref.messageId);
      judges.set(key, strictest(judges.get(key), lineJudge(ref)));
      const old = out.get(`l${key}`);
      out.set(`l${key}`, { ...ref, ...(old?.kind === "line" && old.replay ? { replay: true } : {}) });
    } else if (ref.kind === "prefix") {
      const key = `p${JSON.stringify([ref.threadId, ref.headLsn])}`;
      const old = out.get(key);
      const shown = new Set<string>();
      for (const id of old?.kind === "prefix" ? old.shown ?? [] : []) { spend(1); shown.add(id); }
      for (const id of ref.shown ?? []) {
        spend(1);
        shown.add(id);
        const key = lineKey(ref.threadId, id);
        judges.set(key, strictest(judges.get(key), prefixLineJudge(ref, id)));
      }
      const content = ref.content === true && (!old || old.kind === "prefix" && old.content === true);
      let held = ref.held;
      let heldFrom = ref.heldFrom;
      if (old?.kind === "prefix" && (old.held !== undefined || ref.held !== undefined)) {
        const before = old.held === undefined ? old.headLsn : old.held;
        const after = ref.held === undefined ? ref.headLsn : ref.held;
        // null means no unlisted retained span; undefined head means an
        // unbounded legacy prefix. Union must preserve the stricter bound.
        held = before === undefined || after === undefined ? undefined
          : before === null ? after : after === null ? before : Math.max(before, after);
        const invalidStart = (value: Extract<LineageRef, { kind: "prefix" }>) =>
          value.held !== null && value.heldFrom !== undefined &&
          (!Number.isSafeInteger(value.heldFrom) || !Number.isSafeInteger(value.held) || value.heldFrom > value.held!);
        // A union retains the earliest proven start. An unknown or malformed
        // participating span cannot borrow a later sibling's proof.
        heldFrom = invalidStart(old) || invalidStart(ref) ? Number.NaN
          : old.held === null ? ref.heldFrom : ref.held === null ? old.heldFrom
          : old.heldFrom === undefined || ref.heldFrom === undefined ? undefined
          : Math.min(old.heldFrom, ref.heldFrom);
      }
      spend(shown.size);
      out.set(key, { kind: "prefix", threadId: ref.threadId, headLsn: ref.headLsn,
        ...(held !== undefined ? { held } : {}),
        ...(heldFrom !== undefined ? { heldFrom } : {}),
        ...(shown.size || ref.shown !== undefined || old?.kind === "prefix" && old.shown !== undefined ? { shown: [...shown] } : {}),
        ...(content ? { content: true } : {}) });
    } else {
      const key = ref.kind === "memory" ? `m${memoryRefKey(ref.ref)}:${ref.ref.scopeId ?? ""}`
        : ref.kind === "receipt" ? `r${ref.bundleId}` : `n${ref.reason}`;
      const old = out.get(key);
      // Receipt scopes are obligations, so a duplicate may only strengthen them.
      if (ref.kind === "receipt") {
        const scopes = new Set<string>();
        for (const id of old?.kind === "receipt" ? old.scopeIds : []) { spend(1); scopes.add(id); }
        for (const id of ref.scopeIds) { spend(1); scopes.add(id); }
        spend(scopes.size);
        out.set(key, { ...ref, lsn: old?.kind === "receipt" ? Math.min(old.lsn, ref.lsn) : ref.lsn, scopeIds: [...scopes] });
      } else out.set(key, ref);
    }
  }
  spend(out.size);
  return [...out.values()].map((ref): LineageRef => {
    spend(1);
    if (ref.kind === "line") {
      const { judge: _judge, copyOfShown: _copy, ...base } = ref;
      return judges.get(lineKey(ref.threadId, ref.messageId)) === "content"
        ? { ...base, judge: "content", ...(ref.copyOfShown ? { copyOfShown: true } : {}) } : base;
    }
    if (ref.kind === "prefix" && ref.shown !== undefined) {
      const shownJudges: Record<string, Judge> = Object.create(null);
      for (const id of ref.shown) { spend(1); shownJudges[id] = judges.get(lineKey(ref.threadId, id)) ?? "audience"; }
      return { ...ref, shownJudges };
    }
    return ref;
  });
}

export function retainedRefCounts(refs: readonly LineageRef[]): { lines: number; objects: number } {
  const lines = new Set<string>(), objects = new Set<string>();
  for (const ref of refs) {
    chargeReleaseWork();
    if (ref.kind === "line") lines.add(lineKey(ref.threadId, ref.messageId));
    else if (ref.kind === "prefix") for (const id of ref.shown ?? []) { chargeReleaseWork(); lines.add(lineKey(ref.threadId, id)); }
    else if (ref.kind === "memory") objects.add(`m${memoryRefKey(ref.ref)}`);
    else if (ref.kind === "receipt") objects.add(`r${ref.bundleId}`);
  }
  return { lines: lines.size, objects: objects.size };
}
