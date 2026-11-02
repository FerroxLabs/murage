// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FLUX ROUTER AND FUIGO ARE FRONT AND CENTER (Sean 11-02; FUIGO-FIRST-SIGNIN-PLACEMENT, 1.0.14).
//
// Other engines stay reachable from Settings and engine setup, and are never
// pushed. So Needs you reports an engine nobody is signed in to only when a bot
// runs on it (its turns fail), with "Use Fuigo instead" as the main button, and
// the Chief's first-run card shows Fuigo and Flux only.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let setupReply: unknown = {};
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: async (path: string) => (path === "/api/setup" ? setupReply : {}),
  useStore: () => ({ state: { instances: [] }, dispatch: () => {}, refreshInstances: () => {} }),
}));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));
vi.mock("@/lib/analytics", () => ({ identifyEmail: () => {}, setEmailGateDone: () => {} }));

const { signedOutEngineRows } = await import("@/lib/signed-out-engines");
const { InboxEngineSignInRow } = await import("./InboxEngineSignInRow");
const { FirstRunCard } = await import("./FirstRunCard");
const { readSetupView, forgetSetupView } = await import("./FirstRunChrome");
const { FIRST_RUN_COPY } = await import("@/lib/first-run-copy");
const { setupCardKey } = await import("../../shared/setup-card");
import type { SetupView } from "../../shared/setup";

const asHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const view = (signedOutAgents: unknown[]): SetupView =>
  ({ signedOutAgents, agents: [], conversationLive: false, next: null } as unknown as SetupView);

describe("Needs you, an engine nobody is signed in to", () => {
  it("never lists an engine that no bot or routine uses", () => {
    expect(signedOutEngineRows(view([{ id: "codex", name: "Codex", installed: true, usedBy: [] }]))).toEqual([]);
    expect(signedOutEngineRows(view([{ id: "codex", name: "Codex", installed: true }]))).toEqual([]);
  });

  it("lists one a bot runs on, and names the bot", () => {
    const rows = signedOutEngineRows(view([
      { id: "claude", name: "Claude Code", installed: true, signInCommand: "claude auth login", usedBy: [{ id: "scout", name: "Scout" }] },
      { id: "codex", name: "Codex", installed: true, usedBy: [] },
    ]));
    expect(rows).toEqual([{ id: "claude", name: "Claude Code", signInCommand: "claude auth login", usedBy: [{ id: "scout", name: "Scout" }] }]);
  });

  const row = (fuigoReady: boolean) => renderToStaticMarkup(createElement(InboxEngineSignInRow, {
    engine: { id: "claude", name: "Claude Code", signInCommand: "claude auth login", usedBy: [{ id: "scout", name: "Scout" }] },
    fuigoReady,
    onUseFuigo: () => {},
    onOpenModels: () => {},
    onDone: () => {},
    bridge: {} as never,
  }));

  it("puts Use Fuigo instead first, as the main button, with sign-in after it", () => {
    const markup = row(true);
    expect(markup).toContain("Scout");
    expect(markup).toContain("Use Fuigo instead");
    expect(markup).toContain("data-primary");
    const fuigo = markup.indexOf("Use Fuigo instead");
    const signIn = markup.indexOf("data-engine-signin-button");
    expect(signIn).toBeGreaterThan(-1);
    expect(fuigo).toBeLessThan(signIn);
    expect(markup).not.toMatch(/\b(?:safe|unsafe|safety)\b|[–—]/i);
    // The bots lead; the engine is named once, in the line under the title (MurageMain 11-02).
    expect(markup).toContain(asHtml("Scout can't answer yet."));
    expect(markup).toContain("Scout runs on Claude Code, so its turns fail until you sign in or use Fuigo instead.");
    expect(markup).not.toContain("needs your own");
  });

  it("says their turns for more than one bot", () => {
    const markup = renderToStaticMarkup(createElement(InboxEngineSignInRow, {
      engine: { id: "claude", name: "Claude Code", usedBy: [{ id: "scout", name: "Scout" }, { id: "ember", name: "Ember" }] },
      fuigoReady: true, onUseFuigo: () => {}, onOpenModels: () => {}, onDone: () => {}, bridge: {} as never,
    }));
    expect(markup).toContain(asHtml("Scout and Ember can't answer yet."));
    expect(markup).toContain("Scout and Ember run on Claude Code, so their turns fail until you sign in or use Fuigo instead.");
  });

  it("points to the Flux key first when Fuigo has nothing to think with yet", () => {
    const markup = row(false);
    expect(markup).not.toContain("Use Fuigo instead");
    expect(markup.indexOf("data-primary")).toBeLessThan(markup.indexOf("data-engine-signin-button"));
    expect(markup).toContain("Scout runs on Claude Code, so its turns fail until you sign in, or add your Flux key and then use Fuigo instead.");
  });
});

describe("the Chief's first-run card shows Fuigo and Flux only", () => {
  const bot = { id: "chief", threadId: "thread-1", name: "Chief of Staff" } as never;
  const render = () => renderToStaticMarkup(createElement(FirstRunCard, {
    bot,
    message: {
      id: "card-signed-out", role: "bot", kind: "options", at: 1,
      card: { title: "Setup", options: [], setup: { step: "detect", variant: "signed-out", key: setupCardKey("detect", "signed-out") } },
    } as never,
  }));
  async function machine(patch: Record<string, unknown>) {
    setupReply = { steps: [], agents: [], signedOutAgents: [], ownerName: "Sean", ...patch };
    forgetSetupView();
    await readSetupView(true);
  }
  const codex = { id: "codex", name: "Codex", installed: true, signInCommand: "codex login" };

  it("has no sign-in button for another engine, and does not name it", async () => {
    await machine({ agents: [], signedOutAgents: [codex] });
    const markup = render();
    expect(markup).not.toContain("data-engine-signin-button");
    expect(markup).not.toContain("Codex");
    expect(markup).not.toContain(asHtml(FIRST_RUN_COPY.agents["signed-out"].chief));
    // Nothing can answer yet, so it says the key is next, in the words the flow already uses.
    expect(markup).toContain(asHtml(FIRST_RUN_COPY.agents["bare-needs-key"].second));
    expect(markup).toContain(FIRST_RUN_COPY.agents.detect.action);
  });

  it("says the engine in the box is running when it is", async () => {
    await machine({ agents: [{ id: "fuigo", name: "Fuigo", installed: false }], signedOutAgents: [codex] });
    const markup = render();
    expect(markup).not.toContain("data-engine-signin-button");
    expect(markup).not.toContain("Codex");
    expect(markup).toContain(asHtml(FIRST_RUN_COPY.agents.bare.second));
  });
});

describe("first run names no engine nobody is signed in to", () => {
  const codex = { id: "codex", name: "Codex", installed: true, signInCommand: "codex login" };

  it("the hello card's footer does not name it", async () => {
    const { probeLine } = await import("@/lib/first-run-copy");
    expect(probeLine({ agents: [], signedOutAgents: [codex] })).toBeNull();
    expect(probeLine({ agents: [{ name: "Fuigo", installed: false }], signedOutAgents: [codex] })).toBe(FIRST_RUN_COPY.hello.welcome.probe.bundled);
    expect(probeLine({ agents: [{ name: "Claude Code", installed: true }], signedOutAgents: [codex] })).toBe("Found Claude Code, signed in.");
  });

  it("the found card lists only what can answer, with no list behind a button", async () => {
    const { firstRunDetection } = await import("@/lib/first-run-detect");
    const detection = firstRunDetection({ agents: [{ id: "claude", name: "Claude Code", installed: true }], signedOutAgents: [codex], ownerName: "" } as unknown as SetupView);
    expect(detection.rows.map((one) => one.title)).toEqual(["Claude Code"]);
    expect(JSON.stringify(detection)).not.toContain("Codex");
  });
});
