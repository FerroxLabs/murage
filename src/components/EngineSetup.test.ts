import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EngineSetup, installCommandFor, needsCli, needsSignIn, setupStep } from "./EngineSetup";
import { installProgressLine } from "./EngineManagement";
import { setLocale } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ dispatch: vi.fn() }) }));
afterEach(async () => { vi.unstubAllGlobals(); await setLocale("en"); });

describe("Pi below the version Murage can run", () => {
  it("offers the update with the reason, not a first install", () => {
    vi.stubGlobal("window", { muragebox: { platform: "linux" } });
    const reason = "Your Pi engine is version 0.73.1, and Murage needs 0.80.5 or newer.";
    const value: InstanceInfo = { ...instance({ state: "unavailable", version: "0.73.1", reason }),
      driverKind: "piAgent", displayName: "Pi", install: { command: { linux: "npm install -g --force @earendil-works/pi-coding-agent" }, needsNode: true, platform: "linux" } };
    const html = renderToStaticMarkup(createElement(EngineSetup, { instance: value }));
    expect(html).toContain("Update Pi");
    expect(html).toContain("Run this once, then check again.");
    expect(html).toContain("npm install -g --force @earendil-works/pi-coding-agent");
    expect(html).not.toContain("Install Pi");
  });
});

describe("bundled engine repair", () => {
  it("renders repair guidance without sending desktop customers to npm", () => {
    vi.stubGlobal("window", { muragebox: { platform: "linux" } });
    const value: InstanceInfo = { ...instance({ state: "unavailable", setupAction: "repair", reason: "Bundled engine could not start." }),
      driverKind: "fuigoAgent", displayName: "Fuigo", install: { command: { linux: "npm install -g fuigo" }, needsNode: true } };
    const html = renderToStaticMarkup(createElement(EngineSetup, { instance: value }));
    expect(html).toContain("Repair bundled Fuigo");
    expect(html).toContain("You do not need Node.js, npm");
    expect(html).toContain("without deleting your workspace");
    expect(html).not.toContain("npm install -g fuigo");
    expect(html).not.toContain("Requires Node.js");
  });
});

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });
});

describe("the install command is the server's (item 167)", () => {
  const command = { darwin: "curl mac", win32: "winget windows", linux: "apt linux" };
  it("shows the command for the computer running the server, not the browser device", () => {
    vi.stubGlobal("window", { muragebox: undefined });
    vi.stubGlobal("navigator", { userAgent: "iPhone Mac OS X" });
    expect(installCommandFor({ command, platform: "win32" })).toBe("winget windows");
    expect(installCommandFor({ command, platform: "linux" })).toBe("apt linux");
  });
  it("falls back to the viewing device when the server did not say", () => {
    vi.stubGlobal("window", { muragebox: { platform: "darwin" } });
    expect(installCommandFor({ command })).toBe("curl mac");
  });
});

describe("set-up steps", () => {
  const claude = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({ ...instance(snapshot), driverKind: "claudeAgent", displayName: "Claude Code", install: { native: true, signInCommand: "claude auth login" } });
  const desktop = () => vi.stubGlobal("window", { muragebox: { platform: "linux", openEngineSetupTerminal: () => true } });
  it("reads the card's step from the state: missing, signed out, signed in", () => {
    expect(setupStep(claude({ state: "unavailable" }))).toBe("install");
    expect(setupStep(claude({ state: "available", authenticated: false }))).toBe("signin");
    expect(setupStep(claude({ state: "available", authenticated: true }))).toBe("check");
    expect(setupStep(claude({ state: "available", authenticated: true }), { authRequired: true })).toBe("signin");
  });
  it("offers no npm line, no Node line and no Terminal on a native card", () => {
    desktop();
    const html = renderToStaticMarkup(createElement(EngineSetup, { instance: claude({ state: "unavailable" }) }));
    expect(html).toContain("Install Claude Code");
    expect(html).not.toContain("npm");
    expect(html).not.toContain("Node.js");
    expect(html).not.toContain("Open install in Terminal");
  });
  it("away from the desktop says where to go instead of a button that cannot work", () => {
    vi.stubGlobal("window", { muragebox: { platform: "linux" } });
    expect(renderToStaticMarkup(createElement(EngineSetup, { instance: claude({ state: "unavailable" }) }))).toContain("This needs the Murage app on your computer.");
  });
  it("a set-up link on a signed-in engine shows one press and starts nothing by itself", () => {
    desktop();
    const value = claude({ state: "available", authenticated: true });
    const html = renderToStaticMarkup(createElement(EngineSetup, { instance: value, setUp: true }));
    expect(html).toContain("Check that it works");
    expect(html).not.toContain("Sign in");
    expect(renderToStaticMarkup(createElement(EngineSetup, { instance: value }))).not.toContain("Check that it works");
  });
  it("words each step of the download", () => {
    expect(installProgressLine({ phase: "download", received: 52_428_800, total: 314_572_800 })).toBe("Downloading 50 of 300 MB");
    expect(installProgressLine({ phase: "install", received: 1, total: 1 })).toBe("Finishing the install…");
  });
  it("leaves the npm-only and vendor-script rows as they are", () => {
    desktop();
    const grok = (platform: "linux" | "win32"): InstanceInfo => ({ ...instance({ state: "unavailable" }), driverKind: "grokAgent", displayName: "Grok", install: { command: { linux: "curl -fsSL https://x.ai/cli/install.sh | bash" }, platform } });
    expect(renderToStaticMarkup(createElement(EngineSetup, { instance: grok("linux") }))).toContain("Open install in Terminal");
    expect(renderToStaticMarkup(createElement(EngineSetup, { instance: grok("win32") }))).toContain("one-line installer");
  });
});

it("L9 B3(d): EngineSetup offers the real-reply Check while a Kimi hint remains marked", () => {
  vi.stubGlobal("window", { muragebox: { platform: "linux", openEngineSetupTerminal: () => true } });
  const marked = instance({ state: "available", authenticated: false, signInAnswerIsLocalHint: true, reason: "This engine is not signed in." });
  const html = renderToStaticMarkup(createElement(EngineSetup, { instance: marked }));
  expect(html).toContain("Check that it works");
  expect(html).toContain("Check");
  expect(html).not.toContain("Signed in to Kimi");
});

describe("Medium 1: marked Kimi recovery respects setup intent", () => {
  const marked = (): InstanceInfo => ({
    ...instance({ state: "available", authenticated: false, signInAnswerIsLocalHint: true, reason: "This engine is not signed in." }),
    install: { command: { linux: "uv tool install kimi-cli" }, platform: "linux", signInCommand: "kimi login" },
  });

  it.each([false, true])("keeps inject on local-model setup (setUp=%s)", (setUp) => {
    vi.stubGlobal("window", { muragebox: { platform: "linux", openEngineSetupTerminal: () => true } });
    const html = renderToStaticMarkup(createElement(EngineSetup, { instance: marked(), intent: "inject", setUp }));
    expect(html).toContain("Install the engine once, then you can run it with local models; no cloud sign-in required.");
    expect(html).toContain("uv tool install kimi-cli");
    expect(html).toContain("Check again");
    expect(html).not.toContain("Check that it works");
    expect(html).not.toContain("Sign in to Kimi");
    expect(html).not.toContain("kimi login");
  });

  it.each([false, true])("keeps cloud on the real-reply check (setUp=%s)", (setUp) => {
    vi.stubGlobal("window", { muragebox: { platform: "linux", openEngineSetupTerminal: () => true } });
    const html = renderToStaticMarkup(createElement(EngineSetup, { instance: marked(), intent: "cloud", setUp }));
    expect(html).toContain("Check that it works");
    expect(html).not.toContain("uv tool install kimi-cli");
    expect(html).not.toContain("Sign in to Kimi");
  });
});


describe("B3(d): marked reply-check copy", () => {
  it.each([
    ["en", "Send a short message to check that the engine can reply.", "You look signed in."],
    ["de", "Sende eine kurze Nachricht, um zu prüfen, ob die Engine antworten kann.", "Du scheinst angemeldet zu sein."],
  ])("describes the marked check and preserves ordinary signed-in copy in %s", async (locale, line, signedIn) => {
    await setLocale(locale);
    vi.stubGlobal("window", { muragebox: { platform: "linux", openEngineSetupTerminal: () => true } });
    const marked = instance({ state: "available", authenticated: false, signInAnswerIsLocalHint: true, reason: "This engine is not signed in." });
    for (const setUp of [false, true]) {
      const html = renderToStaticMarkup(createElement(EngineSetup, { instance: marked, setUp }));
      expect(html).toContain(line);
      expect(html).not.toContain(signedIn);
    }
    const ordinary = renderToStaticMarkup(createElement(EngineSetup, {
      instance: instance({ state: "available", authenticated: true }), setUp: true,
    }));
    expect(ordinary).toContain(signedIn);
    expect(ordinary).not.toContain(line);
  });
});
