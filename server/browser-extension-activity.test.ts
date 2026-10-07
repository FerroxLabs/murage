// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_MAX_AGE_MS, ACTIVITY_MAX_LINE_BYTES, ACTIVITY_MAX_LINES, BrowserActivityStore,
  configureBrowserActivity, recordBrowserActivity,
} from "./browser-extension-activity.ts";
import { BROWSER_EXTENSION_FILES, classifyDataDirEntry } from "./data-dir-inventory.ts";
import { routeClass, conversationSubject } from "./route-policy.ts";

let dir: string;
let clock = 1_800_000_000_000;
const now = () => clock;
const entry = (over: Record<string, unknown> = {}) => ({
  botId: "bot1", bindingId: "bind1", taskId: "task1", site: "example.com", action: "click",
  target: "Save draft", level: 2 as const, decision: "allowed for this task" as const, decidedBy: "grant" as const, outcome: "done" as const, ...over,
});
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "activity-")); clock = 1_800_000_000_000; });
afterEach(() => { configureBrowserActivity(undefined); rmSync(dir, { recursive: true, force: true }); });

describe("browser activity store", () => {
  it("records the allowed fields and nothing else", () => {
    const store = new BrowserActivityStore(dir, now);
    expect(store.record({ ...entry(), value: "hunter2", text: "my password", password: "x", typed: "y" } as never)).toBe(true);
    const [line] = store.list({ botId: "bot1", bindingId: "bind1" });
    expect(Object.keys(line!).sort()).toEqual(["action", "at", "botId", "bindingId", "decidedBy", "decision", "fromPage", "level", "outcome", "site", "target", "taskId"].sort());
    expect(JSON.stringify(readFileSync(join(dir, "bind1.ndjson"), "utf8"))).not.toMatch(/hunter2|password|my password/);
  });

  it("keeps only the length of typed text", () => {
    const store = new BrowserActivityStore(dir, now);
    store.record(entry({ action: "type", target: "Email field", textLength: 14 }));
    const [line] = store.list({ botId: "bot1", bindingId: "bind1" });
    expect(line!.textLength).toBe(14);
  });

  it("refuses bad ids, unknown enums and path escapes", () => {
    const store = new BrowserActivityStore(dir, now);
    expect(store.record(entry({ bindingId: "../escape" }))).toBe(false);
    expect(store.record(entry({ level: 9 }))).toBe(false);
    expect(store.record(entry({ decision: "whatever" }))).toBe(false);
    expect(store.record(entry({ botId: "" }))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("caps every line at 512 bytes, whatever the label", () => {
    const store = new BrowserActivityStore(dir, now);
    expect(store.record(entry({ target: "é".repeat(5000), site: "a".repeat(5000), action: "b".repeat(5000) }))).toBe(true);
    for (const raw of readFileSync(join(dir, "bind1.ndjson"), "utf8").split("\n").filter(Boolean)) expect(Buffer.byteLength(raw) + 1).toBeLessThanOrEqual(ACTIVITY_MAX_LINE_BYTES);
  });

  it("strips control characters and marks page-derived labels", () => {
    const store = new BrowserActivityStore(dir, now);
    store.record(entry({ target: "Buy\u0000 now\n‮", fromPage: true }));
    const [line] = store.list({ botId: "bot1", bindingId: "bind1" });
    expect(line!.target).toBe("Buy now");
    expect(line!.fromPage).toBe(true);
  });

  it("keeps at most 2,000 lines per binding, newest last", () => {
    const store = new BrowserActivityStore(dir, now);
    for (let i = 0; i < ACTIVITY_MAX_LINES + 130; i++) { clock += 1; store.record(entry({ target: `n${i}` })); }
    const lines = store.list({ botId: "bot1", bindingId: "bind1" });
    expect(lines.length).toBe(ACTIVITY_MAX_LINES);
    expect(lines.at(-1)!.target).toBe(`n${ACTIVITY_MAX_LINES + 129}`);
    expect(lines[0]!.target).toBe("n130");
    expect(readFileSync(join(dir, "bind1.ndjson"), "utf8").split("\n").filter(Boolean).length).toBeLessThanOrEqual(ACTIVITY_MAX_LINES + 100);
  });

  it("drops lines older than 30 days", () => {
    const store = new BrowserActivityStore(dir, now);
    store.record(entry({ target: "old" }));
    clock += ACTIVITY_MAX_AGE_MS + 1;
    store.record(entry({ target: "new" }));
    expect(store.list({ botId: "bot1", bindingId: "bind1" }).map(l => l.target)).toEqual(["new"]);
    store.prune();
    expect(readFileSync(join(dir, "bind1.ndjson"), "utf8")).not.toContain("old");
  });

  it("filters by task and never shows another bot's lines", () => {
    const store = new BrowserActivityStore(dir, now);
    store.record(entry({ taskId: "t1", target: "a" }));
    store.record(entry({ taskId: "t2", target: "b" }));
    store.record(entry({ botId: "other", taskId: "t1", target: "c" }));
    expect(store.list({ botId: "bot1", bindingId: "bind1", taskId: "t1" }).map(l => l.target)).toEqual(["a"]);
    expect(store.list({ botId: "bot1", bindingId: "bind1" }).map(l => l.target)).toEqual(["a", "b"]);
    expect(store.list({ botId: "bot1", bindingId: "../x" })).toEqual([]);
  });

  it("lists every binding of a bot when no binding is named", () => {
    const store = new BrowserActivityStore(dir, now);
    store.record(entry({ bindingId: "b1", target: "a" })); clock += 1;
    store.record(entry({ bindingId: "b2", target: "b" }));
    store.record(entry({ botId: "other", bindingId: "b3", target: "c" }));
    expect(store.list({ botId: "bot1" }).map(l => l.target)).toEqual(["a", "b"]);
  });

  it("is deleted with the binding and survives a corrupt line", () => {
    const store = new BrowserActivityStore(dir, now);
    store.record(entry());
    writeFileSync(join(dir, "bind1.ndjson"), readFileSync(join(dir, "bind1.ndjson"), "utf8") + "{not json\n");
    expect(store.list({ botId: "bot1", bindingId: "bind1" }).length).toBe(1);
    store.deleteBinding("bind1");
    expect(existsSync(join(dir, "bind1.ndjson"))).toBe(false);
  });

  it("recordBrowserActivity is a quiet no-op until configured and never throws", () => {
    expect(recordBrowserActivity(entry())).toBe(false);
    configureBrowserActivity(new BrowserActivityStore(join(dir, "missing", "deeper"), now));
    expect(recordBrowserActivity(entry())).toBe(true);
    // A log folder that cannot be made (its parent is a file) must not throw into the action.
    writeFileSync(join(dir, "blocker"), "x");
    configureBrowserActivity(new BrowserActivityStore(join(dir, "blocker", "child"), now));
    expect(() => recordBrowserActivity(entry())).not.toThrow();
  });
});

describe("browser activity wiring", () => {
  it("is classified as a left-out file of the browser-extension folder", () => {
    expect(Object.keys(BROWSER_EXTENSION_FILES)).toContain("activity");
    expect(classifyDataDirEntry("browser-extension")).toMatchObject({ backup: "excluded" });
  });
  it("the route is a companion route (desktop or paired phone) and shows only visible bots", () => {
    expect(routeClass("GET", "/api/bots/abc/browser-extension/activity")).toBe("companion");
    expect(conversationSubject("/api/bots/abc/browser-extension/activity")).toEqual({ scope: "bot", botId: "abc" });
  });
  it("index.ts serves it behind mayApprove, read only", () => {
    const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    const at = index.indexOf("browser-extension\\/activity");
    expect(at).toBeGreaterThan(0);
    const block = index.slice(at, at + 900);
    expect(block).toMatch(/mayApprove\(req, url\)/);
    expect(block).toMatch(/method !== "GET"/);
    expect(index).toMatch(/join\(DATA_DIR, "browser-extension", "activity"\)/);
  });
});
