import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, loadConfig, normalizeVpsConfig, saveConfig, vpsSshAlias } from "./config.ts";

describe("VPS config", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("keeps test data in the throwaway home", () => {
    expect(process.env.OMB_DATA_DIR).toBeUndefined();
    expect(DATA_DIR).toContain("omb-test-home-");
  });

  it("accepts a simple SSH config alias and rejects command-shaped targets", () => {
    expect(normalizeVpsConfig({ sshAlias: "production-vps" })).toEqual({ sshAlias: "production-vps" });
    expect(() => normalizeVpsConfig({ sshAlias: "production-vps; touch /tmp/pwned" })).toThrow(/SSH config alias/);
    expect(() => normalizeVpsConfig({ sshAlias: "ssh://production-vps" })).toThrow(/SSH config alias/);
    expect(() => normalizeVpsConfig({ sshAlias: "user@production-vps" })).toThrow(/SSH config alias/);
  });

  it("keeps old config data and persists only the non-secret alias", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({ box: { token: "legacy-box-token" }, instances: { claude: { driver: "claudeAgent" } } }),
    );

    saveConfig({ vps: { sshAlias: "production-vps", privateKey: "must-not-persist" } as never });

    const disk = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    expect(disk.box).toEqual({ token: "legacy-box-token" });
    expect(disk.instances).toEqual({ claude: { driver: "claudeAgent" } });
    expect(disk.vps).toEqual({ sshAlias: "production-vps" });
    expect(JSON.stringify(disk)).not.toContain("must-not-persist");
    expect(vpsSshAlias(loadConfig())).toBe("production-vps");
  });

  it("supports clearing the optional VPS config", () => {
    saveConfig({ vps: { sshAlias: "production-vps" } });
    saveConfig({ vps: { sshAlias: "" } });
    expect(vpsSshAlias(loadConfig())).toBeNull();
  });
});
