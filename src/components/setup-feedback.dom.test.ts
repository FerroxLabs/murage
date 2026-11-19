// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { BrowserSetupList } from "./BrowserSetupList";
import { BrowserExtensionPanel } from "./BrowserExtensionPanel";
import { BotReviewSheet } from "./BotReviewSheet";
import { asAnswer } from "@/state/answer-tag";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ dispatch: fixture.dispatch }) }));
vi.mock("./BrowserApprovalMode", () => ({ useBrowserApprovalMode: () => ({ known: true, mode: "step", view: () => null }) }));
vi.mock("./BrowserApprovedSites", () => ({ BrowserApprovedSites: () => null }));
vi.mock("./BrowserActivityLog", () => ({ BrowserActivityLog: () => null }));
vi.mock("./BrowserPreflight", () => ({ BrowserPreflight: () => null }));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => { cleanup(); vi.useRealTimers(); fixture.api.mockReset(); fixture.dispatch.mockReset(); });

it("shows a setup-list failure even before any bots were loaded", async () => {
  fixture.api.mockRejectedValue(new Error("Setup list unavailable"));
  const { container } = mount(h(BrowserSetupList, { botId: "bot" }));
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Setup list unavailable");
});

it("shows a failed single-profile setup beside the browser controls", async () => {
  fixture.api.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("Profile setup unavailable");
    return { profiles: [{ profileId: "profile", browser: "Chrome" }], bindings: [], helper: { running: true }, storeUrl: null };
  });
  const { container } = mount(h(BrowserExtensionPanel, { bot: { id: "bot", name: "Fixture", browserMode: "chrome-extension", browserSetupRevision: 1, selectionRevision: 1 } as never, onChoose: () => {} }));
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Profile setup unavailable");
});

function delayedSetup() {
  vi.useFakeTimers();
  let resolve!: (value: unknown) => void;
  let reject!: (cause: Error) => void;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; });
  let requested = false;
  fixture.api.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      if (requested) return new Promise(() => {});
      requested = true;
      return response;
    }
    // Each status poll returns a fresh object, as the real JSON response does.
    return { profiles: [{ profileId: "profile", browser: "Chrome" }], bindings: [], helper: { running: true }, storeUrl: null };
  });
  const bot = { id: "bot", name: "Fixture", browserMode: "chrome-extension", browserSetupRevision: 1, selectionRevision: 1 };
  const panel = mount(h(BrowserExtensionPanel, { bot: bot as never, onChoose: () => {} }));
  const posts = () => fixture.api.mock.calls.filter(([, init]) => init?.method === "POST");
  return { ...panel, bot, resolve, reject, posts };
}

it.each(["failure", "success"])("preserves a delayed setup %s across unchanged status polls", async outcome => {
  const panel = delayedSetup();
  await settle();
  for (let poll = 0; poll < 2; poll++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  }
  expect(fixture.api.mock.calls.filter(([, init]) => !init)).toHaveLength(3);
  const updatedBot = { ...panel.bot, browserExtensionProfileId: "profile" };
  await act(async () => {
    if (outcome === "failure") panel.reject(new Error("Delayed profile setup unavailable"));
    else panel.resolve(asAnswer({ bot: updatedBot }));
  });
  if (outcome === "failure") {
    expect(panel.container.querySelector('[role="alert"]')?.textContent).toContain("Delayed profile setup unavailable");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  } else {
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "botPatched", bot: updatedBot }));
  }
  expect(panel.posts()).toHaveLength(1);
});

it.each(["revision", "bot", "unmount"])("ignores a delayed setup result after %s changes", async change => {
  const panel = delayedSetup();
  await settle();
  expect(panel.posts()).toHaveLength(1);
  if (change === "unmount") panel.unmount();
  else panel.rerender(h(BrowserExtensionPanel, {
    bot: { ...panel.bot, ...(change === "bot" ? { id: "other", browserMode: "builtin" } : { selectionRevision: 2 }) } as never,
    onChoose: () => {},
  }));
  await act(async () => { panel.resolve(asAnswer({ bot: { ...panel.bot, browserExtensionProfileId: "profile" } })); });
  expect(fixture.dispatch).not.toHaveBeenCalled();
});

it("preserves both the review action failure and a failed refresh", async () => {
  fixture.api.mockResolvedValueOnce({ surface: "computer", digest: "fixture", spec: { id: "bot", name: "Fixture", role: "", instructions: "", section: "", tasks: [], alwaysAllow: [], staged: null, pendingRevision: null } })
    .mockRejectedValueOnce(new Error("Discard unavailable"))
    .mockRejectedValueOnce(new Error("Review refresh unavailable"));
  const { container } = mount(h(BotReviewSheet, { botIds: ["bot"] }));
  await settle();
  const discard = [...container.querySelectorAll("button")].find(button => button.textContent === "Discard")!;
  expect(discard).toBeDefined();
  await act(async () => { discard.click(); });
  const line = container.querySelector('[role="alert"]')?.textContent;
  expect(line).toContain("Discard unavailable");
  expect(line).toContain("Review refresh unavailable");
});
