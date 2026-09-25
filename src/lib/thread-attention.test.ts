// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeThreadSnooze, resetThreadAttention, setQuestionThreads, setThreadSnoozes } from "./thread-attention";

describe("shared snooze and question state", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); resetThreadAttention(); });
  afterEach(() => { resetThreadAttention(); vi.useRealTimers(); });

  it("keeps only snoozes still ahead and drops each one at its time", async () => {
    const { peekThreadAttention } = await import("./thread-attention");
    setThreadSnoozes([{ threadId: "a", until: 1_000_500 }, { threadId: "b", until: 1_002_000 }, { threadId: "old", until: 999_000 }]);
    expect([...peekThreadAttention().snoozes.keys()]).toEqual(["a", "b"]);
    vi.advanceTimersByTime(600);
    expect([...peekThreadAttention().snoozes.keys()]).toEqual(["b"]);
    vi.advanceTimersByTime(2_000);
    expect(peekThreadAttention().snoozes.size).toBe(0);
  });

  it("does not republish identical questions, so rows do not re-render every poll", async () => {
    const { peekThreadAttention } = await import("./thread-attention");
    setQuestionThreads({ a: 1 });
    const first = peekThreadAttention();
    setQuestionThreads({ a: 1 });
    expect(peekThreadAttention()).toBe(first);
    setQuestionThreads(undefined);
    expect(peekThreadAttention().questions).toEqual({});
  });

  it("sends a snooze and an unsnooze to the desktop route and keeps the answer", async () => {
    const { peekThreadAttention } = await import("./thread-attention");
    const api = vi.fn(async (_path: string, init?: RequestInit) =>
      ({ snoozes: init?.method === "PUT" ? [{ threadId: "a b", until: 1_010_000 }] : [] }));
    await changeThreadSnooze(api, "a b", 1_010_000);
    expect(api).toHaveBeenCalledWith("/api/thread-snoozes/a%20b", { method: "PUT", body: JSON.stringify({ until: 1_010_000 }) });
    expect(peekThreadAttention().snoozes.get("a b")).toBe(1_010_000);
    await changeThreadSnooze(api, "a b", null);
    expect(api).toHaveBeenLastCalledWith("/api/thread-snoozes/a%20b", { method: "DELETE" });
    expect(peekThreadAttention().snoozes.size).toBe(0);
  });
});
