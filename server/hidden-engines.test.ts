// 1.0.18 U22 G20 (upstream f4fe7cb06, #4159): hide an engine you do not use.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withInstanceHidden, type AppConfig } from "./config.ts";
import { ENGINE_IN_USE, FUIGO_NOT_HIDDEN, hiddenEngineRows, hideEngineRefusal, isHiddenEngine, withoutHiddenEngines } from "./hidden-engines.ts";

describe("a hidden engine", () => {
  it("drops out of every selectable list, and an unhidden one comes back", () => {
    const instances = [{ instanceId: "fuigo" }, { instanceId: "claude" }, { instanceId: "hermes" }];
    expect(withoutHiddenEngines(instances, { hermes: { driver: "hermesAgent", hidden: true } }).map((instance) => instance.instanceId)).toEqual(["fuigo", "claude"]);
    expect(withoutHiddenEngines(instances, { hermes: { driver: "hermesAgent" } }).map((instance) => instance.instanceId)).toEqual(["fuigo", "claude", "hermes"]);
  });

  it("is saved as hidden: true, and unhiding saves hidden: false", () => {
    const cfg: AppConfig = { instances: { claude: { driver: "claudeAgent" }, hermes: { driver: "hermesAgent", displayName: "Hermes" } } };
    const hidden = withInstanceHidden(cfg, "hermes", true);
    expect(hidden.ok).toBe(true);
    expect(hidden.config.instances!.hermes).toEqual({ driver: "hermesAgent", displayName: "Hermes", hidden: true });
    expect(cfg.instances!.hermes).not.toHaveProperty("hidden");
    const shown = withInstanceHidden(hidden.config, "hermes", false);
    expect(shown.config.instances!.hermes).toEqual({ driver: "hermesAgent", displayName: "Hermes", hidden: false });
    expect(withoutHiddenEngines([{ instanceId: "hermes" }], shown.config.instances!)).toEqual([{ instanceId: "hermes" }]);
    expect(withInstanceHidden(cfg, "nobody", true).ok).toBe(false);
  });

  it("stays unhidden after the config write merges it over a stored hidden: true (Astra r1 Medium)", () => {
    // writeConfigPatch merges each patched instance entry over the one on disk (Object.assign), so a dropped key kept the old true.
    const onDisk = { driver: "hermesAgent", hidden: true };
    const shown = withInstanceHidden({ instances: { claude: { driver: "claudeAgent" }, hermes: { ...onDisk } } }, "hermes", false);
    const merged = Object.assign({ ...onDisk }, shown.config.instances!.hermes);
    expect(merged.hidden).toBe(false);
    expect(withoutHiddenEngines([{ instanceId: "hermes" }], { hermes: merged })).toEqual([{ instanceId: "hermes" }]);
  });

  it("is listed apart with its name", () => {
    const rows = hiddenEngineRows({ claude: { driver: "claudeAgent" }, hermes: { driver: "hermesAgent", hidden: true }, pi: { driver: "piAgent", hidden: true, displayName: "My pi" } },
      (driver) => (driver === "hermesAgent" ? "Hermes" : undefined));
    expect(rows).toEqual([{ instanceId: "hermes", driverKind: "hermesAgent", displayName: "Hermes" }, { instanceId: "pi", driverKind: "piAgent", displayName: "My pi" }]);
  });

  it("is refused while something uses it, and Fuigo is never hidden", () => {
    const bots = [{ modelSelection: { instanceId: "claude" }, tasks: [{ modelSelection: { instanceId: "codex" } }, { lastInstanceId: "grok" }] }];
    const reading = (instanceId: string, driverKind: string, primaryId: string | null = null) => hideEngineRefusal({ instanceId, driverKind, primaryId, bots });
    expect(reading("fuigo", "fuigoAgent")).toEqual({ status: 400, error: FUIGO_NOT_HIDDEN });
    expect(reading("claude", "claudeAgent")).toEqual({ status: 409, error: ENGINE_IN_USE });
    expect(reading("codex", "codex")).toEqual({ status: 409, error: ENGINE_IN_USE });
    expect(reading("grok", "grokAgent")).toEqual({ status: 409, error: ENGINE_IN_USE });
    expect(reading("hermes", "hermesAgent", "hermes")).toEqual({ status: 409, error: ENGINE_IN_USE });
    expect(reading("hermes", "hermesAgent")).toBeNull();
  });

  it("is refused while a bot keeps it as its limit backup (Astra r1 Medium)", () => {
    const bots = [{ modelSelection: { instanceId: "claude" }, limitBackup: { selection: { instanceId: "kimi" } } }, { modelSelection: { instanceId: "claude" }, limitBackup: null }];
    expect(hideEngineRefusal({ instanceId: "kimi", driverKind: "kimiAgent", primaryId: null, bots })).toEqual({ status: 409, error: ENGINE_IN_USE });
    expect(hideEngineRefusal({ instanceId: "hermes", driverKind: "hermesAgent", primaryId: null, bots })).toBeNull();
  });

  it("is never offered, saved or started as a limit backup (Astra r2 Medium)", () => {
    expect(isHiddenEngine({ kimi: { driver: "kimiAgent", hidden: true }, claude: { driver: "claudeAgent", hidden: false } }, "kimi")).toBe(true);
    expect(isHiddenEngine({ kimi: { driver: "kimiAgent", hidden: true }, claude: { driver: "claudeAgent", hidden: false } }, "claude")).toBe(false);
    expect(isHiddenEngine({}, "nobody")).toBe(false);
    // backupUsable gates the limit card's choices, the card's answer, the automatic failover and a routine's backup;
    // the backup PUT refuses one too. Both read the same helper.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    // Since the U22 chokepoint both ask the one gate (limit-backup-gate.test.ts has a test per call site).
    const usable = source.slice(source.indexOf("const backupVerdict = backupGate({"), source.indexOf("function resolveTurnFor("));
    expect(usable).toContain("hidden: (id) => isHiddenEngine(instanceConfigs(cfg), id)");
    expect(usable).toContain("return backupVerdict(from, backup, now).ok;");
    const put = source.slice(source.indexOf("/limit-backup$/"), source.indexOf("const botRoutines = (botId: string)"));
    expect(put).toContain("backupVerdict(record.modelSelection, selection)");
  });
});
