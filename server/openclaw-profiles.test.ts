import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import {
  DEFAULT_OPENCLAW_AGENT,
  isOpenclawAgentName,
  listOpenclawAgents,
  openclawAgentOf,
  openclawAgentsDir,
  openclawInstanceAgents,
  openclawInstanceIdFor,
  openclawSessionKey,
  openclawStateDir,
} from "./openclaw-profiles.ts";

describe("OpenClaw agent discovery", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await removeTempDir(d);
  });
  const fixture = () => {
    const home = mkdtempSync(join(tmpdir(), "murage-openclaw-"));
    dirs.push(home);
    return home;
  };
  const agent = (stateDir: string, name: string, marker: "agent" | "sessions" | null = "agent") => {
    const dir = join(stateDir, "agents", name);
    mkdirSync(dir, { recursive: true });
    if (marker) mkdirSync(join(dir, marker));
    if (marker === "agent") writeFileSync(join(dir, "agent", "auth-profiles.json"), "{}");
  };

  it("lists agents from ~/.openclaw/agents/*, main first", () => {
    const home = fixture();
    const state = join(home, ".openclaw");
    agent(state, "zed");
    agent(state, "main");
    agent(state, "alpha", "sessions");
    const listing = listOpenclawAgents({ HOME: home });
    expect(listing.found).toBe(true);
    expect(listing.agents.map((a) => a.name)).toEqual(["main", "alpha", "zed"]);
    expect(listing.agents[0]).toMatchObject({ isDefault: true, label: "OpenClaw" });
    expect(listing.agents[1]).toMatchObject({ isDefault: false, label: "OpenClaw · alpha" });
  });

  it("honors OPENCLAW_STATE_DIR over HOME", () => {
    const home = fixture();
    const other = join(home, "elsewhere");
    agent(join(home, ".openclaw"), "main");
    agent(other, "work");
    const env = { HOME: home, OPENCLAW_STATE_DIR: other };
    expect(openclawStateDir(env)).toBe(other);
    expect(openclawAgentsDir(env)).toBe(join(other, "agents"));
    expect(listOpenclawAgents(env).agents.map((a) => a.name)).toEqual(["work"]);
  });

  it("skips empty dirs, plain files and unsafe names", () => {
    const home = fixture();
    const state = join(home, ".openclaw");
    agent(state, "empty", null);
    agent(state, "Bad Name");
    agent(state, "real");
    writeFileSync(join(state, "agents", "stray.txt"), "x");
    expect(listOpenclawAgents({ HOME: home }).agents.map((a) => a.name)).toEqual(["real"]);
  });

  it("reports not found when nothing is installed", () => {
    expect(listOpenclawAgents({ HOME: fixture() })).toEqual({ found: false, agents: [] });
  });
});

describe("OpenClaw agent names and instances", () => {
  it("validates names and builds the session key", () => {
    expect(isOpenclawAgentName("fred_2-x")).toBe(true);
    for (const bad of ["", "Fred", "-x", "a/b", "..", "a".repeat(65), 3, undefined]) {
      expect(isOpenclawAgentName(bad)).toBe(false);
    }
    expect(openclawSessionKey("fred")).toBe("agent:fred:main");
    expect(() => openclawSessionKey("a:b")).toThrow();
    expect(openclawInstanceIdFor("fred")).toBe("openclaw-agent-fred");
  });

  it("reads the pinned agent off an instance config, defaulting to main", () => {
    expect(openclawAgentOf({ agent: "fred" })).toBe("fred");
    expect(openclawAgentOf({ agent: "../x" })).toBe(DEFAULT_OPENCLAW_AGENT);
    expect(openclawAgentOf(null)).toBe(DEFAULT_OPENCLAW_AGENT);
  });

  it("maps only openclawAgent instances to their agents", () => {
    const map = openclawInstanceAgents({
      a: { driver: "openclawAgent", config: { agent: "fred" } },
      b: { driver: "openclawAgent" },
      c: { driver: "hermesAgent", config: { profile: "x" } },
    });
    expect([...map]).toEqual([["a", "fred"], ["b", "main"]]);
  });
});
