import { describe, expect, it } from "vitest";

import { RepeatDetector, askCallKey, askCallLabel, callKey } from "./repeat-detector.ts";

describe("callKey", () => {
  it("keys on tool plus arguments, normalizing whitespace, and ignores a bare tool name", () => {
    expect(callKey("Bash", "git   status\n")).toBe("Bash:git status");
    expect(callKey("Bash", "  git status ")).toBe("Bash:git status");
    expect(callKey("Bash", undefined)).toBeNull();
    expect(callKey("Bash", "")).toBeNull();
    // ACP titles that are just the tool name again carry no arguments
    expect(callKey("Bash", "Bash")).toBeNull();
    expect(callKey("Read", "Read src/index.ts")).toBe("Read:Read src/index.ts");
  });
});

describe("RepeatDetector", () => {
  it("fires once at each threshold for the same call in one thread", () => {
    const d = new RepeatDetector({ thresholds: [5, 10, 20] });
    const hits: number[] = [];
    for (let i = 0; i < 25; i++) {
      const r = d.record("t1", "Bash:git status");
      if (r.threshold) hits.push(r.threshold);
    }
    expect(hits).toEqual([5, 10, 20]);
    expect(d.record("t1", "Bash:git status").count).toBe(26);
  });

  it("keeps threads and calls apart", () => {
    const d = new RepeatDetector({ thresholds: [3] });
    for (let i = 0; i < 2; i++) d.record("t1", "Bash:a");
    for (let i = 0; i < 2; i++) d.record("t2", "Bash:a");
    expect(d.record("t1", "Bash:b").threshold).toBeUndefined();
    expect(d.record("t1", "Bash:a").threshold).toBe(3);
    expect(d.record("t2", "Bash:a").threshold).toBe(3);
  });

  it("forgets a thread on settle", () => {
    const d = new RepeatDetector({ thresholds: [3] });
    for (let i = 0; i < 2; i++) d.record("t1", "Bash:a");
    d.settle("t1");
    expect(d.record("t1", "Bash:a").count).toBe(1);
  });

  it("bounds distinct calls per thread and evicts the least recently seen", () => {
    const d = new RepeatDetector({ thresholds: [2], maxKeysPerThread: 2 });
    d.record("t1", "Bash:a");
    d.record("t1", "Bash:b");
    // Refresh a, so b is the least-recently-seen entry.
    expect(d.record("t1", "Bash:a").threshold).toBe(2);
    d.record("t1", "Bash:c");
    expect(d.record("t1", "Bash:a").count).toBe(3);
    expect(d.record("t1", "Bash:b").count).toBe(1);
  });

  it("rejects an invalid memory bound", () => {
    expect(() => new RepeatDetector({ thresholds: [2], maxKeysPerThread: 0 })).toThrow(/positive integer/);
  });
});

describe("permission asks from an engine that files every app call under one title (Fuigo/ACP)", () => {
  const TITLE = "murage_connectors__APPS_MULTI_EXECUTE_TOOL";
  const ask = (slug: string, args: Record<string, unknown> = {}) => ({
    tool: "other",
    summary: TITLE,
    toolInput: JSON.stringify({ tools: [{ tool_slug: slug, arguments: args }] }),
  });

  it("counts five different connected-app actions as five calls, not one call repeated", () => {
    const asks = [
      ask("GMAIL_LIST_DRAFTS"),
      ask("GMAIL_FETCH_EMAILS", { query: "is:unread" }),
      ask("GOOGLECALENDAR_EVENTS_LIST"),
      ask("GOOGLECALENDAR_CREATE_EVENT", { summary: "Hold" }),
      ask("GOOGLESHEETS_BATCH_UPDATE", { range: "H7:H12" }),
    ];
    // the title alone is the same for all five
    expect(new Set(asks.map((a) => callKey(a.tool, a.summary))).size).toBe(1);
    const keys = asks.map(askCallKey);
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(5);
    const detector = new RepeatDetector({ thresholds: [5] });
    expect(keys.map((key) => detector.record("t", key!).threshold).filter(Boolean)).toEqual([]);
  });

  it("still counts the same action with the same arguments as a repeat", () => {
    const detector = new RepeatDetector({ thresholds: [5] });
    const hits = Array.from({ length: 5 }, () => detector.record("t", askCallKey(ask("GMAIL_LIST_DRAFTS"))!).threshold);
    expect(hits.at(-1)).toBe(5);
  });

  it("names the call in plain words, never the service id or the engine's generic kind", () => {
    expect(askCallLabel(ask("GMAIL_LIST_DRAFTS"))).toBe("Gmail: list drafts");
    expect(askCallLabel({ tool: "other", summary: TITLE, toolCall: { name: TITLE, input: { tools: [{ tool_slug: "GOOGLECALENDAR_EVENTS_LIST" }, { tool_slug: "GMAIL_LIST_DRAFTS" }] } } }))
      .toBe("Google Calendar: events list, Gmail: list drafts");
    const bare = askCallLabel({ tool: "other", summary: TITLE });
    expect(bare).not.toMatch(/murage_connectors|APPS_|other/);
    expect(askCallLabel({ tool: "shell", summary: "git status" })).toBe("shell: git status");
  });
});

describe("permission asks whose summary is already the call (Claude Bash)", () => {
  it("counts five identical commands with different model-written descriptions as one call repeated", () => {
    const detector = new RepeatDetector({ thresholds: [5] });
    const hits = ["List files", "Check the folder", "Look again", "See what is there", "One more look"].map((description) =>
      detector.record("t", askCallKey({ tool: "Bash", summary: "ls -la ~/Documents/Brightline", toolInput: JSON.stringify({ command: "ls -la ~/Documents/Brightline", description }) })!).threshold);
    expect(hits.at(-1)).toBe(5);
  });

  it("keeps a bare-title key small when the input is large, and still tells inputs apart", () => {
    const big = (n: number) => ({ tool: "other", summary: "murage_connectors__APPS_MULTI_EXECUTE_TOOL", toolInput: JSON.stringify({ tools: [{ tool_slug: "GMAIL_CREATE_EMAIL_DRAFT", arguments: { body: `${"x".repeat(10_000)}${n}` } }] }) });
    const a = askCallKey(big(1))!;
    expect(a.length).toBeLessThan(600);
    expect(askCallKey(big(2))).not.toBe(a);
    expect(askCallKey(big(1))).toBe(a);
  });
});
