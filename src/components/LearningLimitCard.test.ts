// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/settings-copy";
import { t } from "@/lib/i18n";
import type { MemoryLearning } from "@/lib/memory-learning";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";

vi.mock("@/state/store", () => ({ api: vi.fn() }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));
import { api } from "@/state/store";
import { LearningLimitCard } from "./LearningLimitCard";

const learning = (revision = 4, input = 100_000_000, output = 15_000_000): MemoryLearning => ({
  revision, defaultOn: true,
  settings: { version: 3, automaticFacts: true, automaticProcedures: true, reviewMode: false, perCallOutputTokens: { extraction: 2000, grounding: 64, reflection: 8000 }, ceiling: { input, output }, callsPerMinute: 6, learnFrom: { chats: true, channels: true }, botsPaused: [] },
  connection: { instanceId: "fixture", source: "chosen", label: "Fixture" },
  ceiling: { month: "2026-11", input, output, inputUsed: 2_000_000, outputUsed: 300_000, paused: input === 0 || output === 0 },
});
const button = (name: string) => {
  const found = Array.from(document.querySelectorAll("button")).find((node) => node.textContent === name);
  expect(found, name).toBeDefined();
  return found!;
};
async function click(name: string) { await act(async () => { button(name).click(); }); }
function typeLimit(index: number, value: string) {
  const input = document.querySelectorAll("input")[index]!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const drafts = () => Array.from(document.querySelectorAll("input"), (input) => input.value);
const writes = () => vi.mocked(api).mock.calls.filter(([path]) => path === "/api/memory/action");
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => { vi.mocked(api).mockReset(); });
afterEach(() => { cleanup(); document.body.replaceChildren(); });

describe("Usage learning limit recovery", () => {
  it("retries the initial read without writing a default", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ learning: learning() });
    mount(createElement(LearningLimitCard));
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(t("memoryPage.loadFailed"));
    await click("Retry");
    await click(t("memoryPage.limit.change"));
    expect(drafts()).toEqual(["100", "15"]);
    expect(api).toHaveBeenCalledTimes(2);
    expect(writes()).toEqual([]);
  });

  it("refreshes a conflicted revision, keeps both drafts through a failed refresh, and saves only on request", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ learning: learning() })
      .mockRejectedValueOnce(new Error("MEMORY_LEARNING_REVISION_CONFLICT"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ learning: learning(5, 120_000_000, 20_000_000) })
      .mockResolvedValueOnce({ learning: learning(6, 250_000_000, 30_000_000) });
    mount(createElement(LearningLimitCard)); await settle();
    await click(t("memoryPage.limit.change"));
    typeLimit(0, "250"); typeLimit(1, "30");
    expect(writes()).toEqual([]);
    await click("Save limit");
    expect(drafts()).toEqual(["250", "30"]);
    expect(button("Save limit").disabled).toBe(true);
    expect(document.body.textContent).toContain(t("memoryPage.conflict"));
    expect(Array.from(document.querySelectorAll("button")).some((node) => node.textContent === "Retry")).toBe(false);
    expect(JSON.parse(String(writes()[0]![1]?.body))).toEqual({ action: "configure", ceiling: { input: 250_000_000, output: 30_000_000 }, learningRevision: 4 });
    await click("Refresh");
    expect(drafts()).toEqual(["250", "30"]);
    expect(button("Save limit").disabled).toBe(true);
    expect(document.body.textContent).toContain(t("memoryPage.loadFailed"));
    await click("Retry");
    expect(drafts()).toEqual(["250", "30"]);
    expect(document.getElementById("memory-limit-read-current")?.textContent).toBe("Current saved limit: 120 million tokens.");
    expect(document.getElementById("memory-limit-written-current")?.textContent).toBe("Current saved limit: 20 million tokens.");
    expect(button("Save limit").disabled).toBe(false);
    expect(document.body.textContent).not.toContain(t("memoryPage.conflict"));
    expect(writes()).toHaveLength(1);
    await click("Save limit");
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(String(writes()[1]![1]?.body))).toEqual({ action: "configure", ceiling: { input: 250_000_000, output: 30_000_000 }, learningRevision: 5 });
    expect(drafts()).toEqual([]);
  });

  it("keeps the editor mounted and preserves typing while a conflict refresh is pending", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockResolvedValueOnce({ learning: learning() })
      .mockRejectedValueOnce(new Error("MEMORY_LEARNING_REVISION_CONFLICT"))
      .mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    mount(createElement(LearningLimitCard)); await settle();
    await click(t("memoryPage.limit.change"));
    typeLimit(0, "250"); typeLimit(1, "30");
    await click("Save limit");
    const read = document.querySelector("input");
    await click("Refresh");
    expect(document.querySelector("input")).toBe(read);
    expect(document.body.textContent).toContain(t("memoryPage.settingsLoading"));
    expect(button("Refresh").disabled).toBe(true);
    expect(button("Save limit").disabled).toBe(true);
    typeLimit(0, "275"); typeLimit(1, "35");
    await act(async () => { resolve({ learning: learning(5, 120_000_000, 20_000_000) }); });
    expect(document.querySelector("input")).toBe(read);
    expect(drafts()).toEqual(["275", "35"]);
    expect(button("Save limit").disabled).toBe(false);
    expect(writes()).toHaveLength(1);
  });

  it("keeps zero valid and lets Cancel choose the refreshed server values without a write", async () => {
    vi.mocked(api).mockResolvedValueOnce({ learning: learning() })
      .mockRejectedValueOnce(new Error("MEMORY_LEARNING_REVISION_CONFLICT"))
      .mockResolvedValueOnce({ learning: learning(5, 120_000_000, 20_000_000) });
    mount(createElement(LearningLimitCard)); await settle();
    await click(t("memoryPage.limit.change"));
    typeLimit(0, "0"); typeLimit(1, "0");
    expect(button("Save limit").disabled).toBe(false);
    expect(document.body.textContent).toContain(t("memoryPage.ceiling.zero"));
    await click("Save limit");
    await click("Refresh");
    expect(drafts()).toEqual(["0", "0"]);
    await click(t("memoryPage.cancel"));
    await click(t("memoryPage.limit.change"));
    expect(drafts()).toEqual(["120", "20"]);
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0]![1]?.body))).toEqual({ action: "configure", ceiling: { input: 0, output: 0 }, learningRevision: 4 });
  });
});
