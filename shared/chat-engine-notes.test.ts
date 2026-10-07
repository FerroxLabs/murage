// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { claimExcerpts, ENGINE_LABEL_NOTICE, engineChangedLine, engineDividers, engineHoverLabel } from "./chat-engine-notes";

const bot = (id: string, instanceId?: string) => ({ id, role: "bot" as const, ...(instanceId ? { engine: { instanceId } } : {}) });

describe("engine notes", () => {
  it("copy is exact", () => {
    expect(engineChangedLine("Engine B")).toBe("Engine changed: Engine B. The record carries over. Engines differ in tools, context size and what they will do, so the voice and the answers may differ.");
    expect(ENGINE_LABEL_NOTICE).toBe("Replies will be labelled with the engine that wrote them.");
    expect(engineHoverLabel({ instanceId: "a", model: "m1" }, () => "Engine A")).toBe("Engine A, m1");
  });
  it("divides where the engine changes and before the first labelled row after unlabelled ones", () => {
    const rows = [bot("0"), bot("1", "a"), bot("2", "a"), { id: "u", role: "user" as const }, bot("3", "b"), bot("4", "a")];
    const out = engineDividers(rows, (e) => e.instanceId.toUpperCase());
    expect([...out.keys()]).toEqual(["1", "3", "4"]);
    expect(out.get("3")).toContain("Engine changed: B.");
  });
  it("no divider when nothing is labelled, or for the very first labelled row of a new thread", () => {
    expect(engineDividers([bot("1"), bot("2")], () => "x").size).toBe(0);
    expect(engineDividers([bot("1", "a")], () => "A").size).toBe(0);
  });
  it("excerpts mark flagged and earlier claims only", () => {
    const check = { state: "flagged" as const, claims: [
      { class: "send" as const, span: [0, 6] as [number, number], state: "flagged" as const },
      { class: "save" as const, span: [8, 15] as [number, number], state: "earlier" as const, rowId: "r1" },
      { class: "run" as const, span: [16, 20] as [number, number], state: "recorded" as const },
    ] };
    expect(claimExcerpts("I sent, I saved ran it", check).map((e) => e.state)).toEqual(["flagged", "earlier"]);
  });
});
