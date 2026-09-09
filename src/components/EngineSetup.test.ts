import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EngineSetup, needsCli, needsSignIn } from "./EngineSetup";
import type { InstanceInfo } from "@/state/store";

vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ dispatch: vi.fn() }) }));
afterEach(() => vi.unstubAllGlobals());

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
