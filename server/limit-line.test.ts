// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The limit handler never replaces a transcript row that has text with empty text, on any path.
import { describe, expect, it } from "vitest";
import { putLimitLineInto, type LimitLineStore } from "./limit-line.ts";
import type { Message } from "./store.ts";

function fixture(rows: Message[]) {
  const store: LimitLineStore & { rows: Message[] } = {
    rows,
    scanNewest: (_t, visit) => { for (const m of [...rows].reverse()) if (visit(m)) return true; return false; },
    patchMessage: (_t, id, patch) => { const m = rows.find(r => r.id === id); if (!m) return false; Object.assign(m, patch); return true; },
    appendMessage: (_t, m) => { rows.push(m); },
  };
  return store;
}
const row = (id: string, text: string) => ({ id, role: "bot", kind: "text", text }) as unknown as Message;

describe("putLimitLineInto", () => {
  it("the engine's relayed refusal row is rewritten with the line, never emptied", () => {
    const store = fixture([row("a", "partial words")]);
    putLimitLineInto(store, "t", { textActivity: true, text: "partial words" }, "Engine is at its limit.");
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].text).toBe("Engine is at its limit.");
  });
  it("no matching row: the line is appended and no row loses its text", () => {
    const store = fixture([row("a", "an earlier answer")]);
    putLimitLineInto(store, "t", { textActivity: true, text: "other" }, "Engine is at its limit.");
    expect(store.rows[0].text).toBe("an earlier answer");
    expect(store.rows).toHaveLength(2);
  });
  it("an empty line never blanks a row that has text", () => {
    const store = fixture([row("a", "partial words")]);
    putLimitLineInto(store, "t", { textActivity: true, text: "partial words" }, "");
    expect(store.rows[0].text).toBe("partial words");
  });
});
