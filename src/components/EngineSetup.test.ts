import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EngineSetup, installCommandFor, needsCli, needsSignIn } from "./EngineSetup";
import type { InstanceInfo } from "@/state/store";

vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ dispatch: vi.fn() }) }));
afterEach(() => vi.unstubAllGlobals());

describe("Pi below the version Murage can run", () => {
  it("offers the update with the reason, not a first install", () => {
    vi.stubGlobal("window", { muragebox: { platform: "linux" } });
    const reason = "Pi 0.73.1 is older than 0.80.5, the oldest version Murage can run.";
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
