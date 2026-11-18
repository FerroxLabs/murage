// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The handle route resolves the exact stored card before it refuses a late answer. The note writer must be handed that
// card, not search again by request id: a settled card older than the newest scanned rows is not found by that search,
// so its replay would skip the settled/told checks and write the note again.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

describe("a late answer's note is written against the resolved card", () => {
  it("the handle route passes the stored card to noteUnreachableAnswer", () => {
    const calls = [...source.matchAll(/noteUnreachableAnswer\(threadId, stored\.card\.requestId[^;]*;/g)].map((m) => m[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/, stored\);$/);
  });
  it("the note writer uses a passed card before any search by request id", () => {
    const body = source.slice(source.indexOf("function noteUnreachableAnswer("), source.indexOf("function expireQuestionCard("));
    const passed = body.search(/resolvedCard\s*\?/);
    const searched = body.indexOf("cardByRequest(threadId, requestId)");
    expect(passed).toBeGreaterThan(-1);
    expect(searched).toBeGreaterThan(passed);
    expect(body).toContain("store.messageById(threadId, resolvedCard.id)");
  });
});
