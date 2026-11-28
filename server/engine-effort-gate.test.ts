// ACP-EFFORT-PER-MODEL-1023 X3 (L2): a model-mode engine never refuses a turn over a leftover engine-wide effort; Grok and Fuigo keep their 409.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { CustomAcpDriver } from "./drivers/acp/custom.ts";
import { GrokAgentDriver } from "./drivers/acp/grok.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const CLI = `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve("server/testing/fake-custom-acp-models.ts"))}`;

const loadGate = async () => (await import("./engine-effort-gate.ts").catch(() => undefined))?.turnEffortRefused;

it("X3 a model-mode engine ignores a stale engine-wide effort; an engine-wide engine with an unlisted level is still refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "murage-effort-gate-"));
  const model = await CustomAcpDriver.create({ instanceId: "gate-model", displayName: "Fixture", enabled: true,
    environment: { HOME: home, USERPROFILE: home, FAKE_CUSTOM_ACP_DIRECTORY: home }, config: { cli: CLI, fullAuto: false } });
  const wide = await GrokAgentDriver.create({ instanceId: "gate-wide", displayName: "Grok", enabled: true,
    environment: { HOME: home, USERPROFILE: home }, config: { cli: CLI, fullAuto: false } });
  try {
    const turnEffortRefused = await loadGate();
    expect(turnEffortRefused, "server/engine-effort-gate.ts exports turnEffortRefused").toBeTypeOf("function");
    expect(model.adapter.capabilities.effortLevels).toBeUndefined();
    expect(model.adapter.capabilities.effortMode).toBe("model");
    expect(turnEffortRefused!(model.adapter.capabilities, "high")).toBe(false);
    expect(wide.adapter.capabilities.effortMode).toBeUndefined();
    expect(turnEffortRefused!(wide.adapter.capabilities, "high")).toBe(false);
    expect(turnEffortRefused!(wide.adapter.capabilities, "turbo")).toBe(true);
    expect(turnEffortRefused!(wide.adapter.capabilities, undefined)).toBe(false);
  } finally { await model.dispose(); await wide.dispose(); await removeTempDir(home); }
});

it("X3 the turn gate in index.ts goes through turnEffortRefused, not an inline engine-wide check", () => {
  const source = readFileSync("server/index.ts", "utf8");
  expect(source).toContain("if (turnEffortRefused(instance.adapter.capabilities, effort)) {");
  expect(source).not.toContain("capabilities.effortLevels?.includes(effort)");
});
