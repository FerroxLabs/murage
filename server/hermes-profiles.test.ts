// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { recordEvents } from "./testing/events.ts";
import type { InstanceConfigMap, ProviderInstance } from "./contracts.ts";
import {
  firstSentence,
  hermesHome,
  hermesProfileOf,
  hermesProfileOwnsIdentity,
  hermesRoot,
  listHermesProfiles,
  planHermesImport,
  planHermesProfilePins,
  stickyHermesProfile,
} from "./hermes-profiles.ts";
import { HERMES_CONFIG_MODEL_ID, HermesAgentDriver, hermesConfiguredModel, hermesSpawnArgs } from "./drivers/acp/hermes.ts";
import { hermesProfileCarry } from "../shared/hermes-profile-name.ts";
import { hermesPinNoteActivityName, hermesPinNoteProfile, hermesPinNoteText } from "../shared/hermes-pin-note.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

/** A fake user home holding a Hermes install shaped like the owner's test
 * Mac: `default` at the root, named profiles under `profiles/`, and a sticky
 * `active_profile`. Nothing here touches the real ~/.hermes. */
function fakeHome(opts: { sticky?: string; profiles?: Record<string, { model?: string; soul?: string; meta?: string; skills?: number }>; rootModel?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "murage-hermes-profiles-"));
  dirs.push(home);
  const root = join(home, ".hermes");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.yaml"), `model:\n  default: ${opts.rootModel ?? "openrouter/root-model"}\n  provider: openrouter\n`);
  if (opts.sticky !== undefined) writeFileSync(join(root, "active_profile"), `${opts.sticky}\n`);
  for (const [name, spec] of Object.entries(opts.profiles ?? {})) {
    const dir = join(root, "profiles", name);
    mkdirSync(dir, { recursive: true });
    if (spec.model) writeFileSync(join(dir, "config.yaml"), `model:\n  default: ${spec.model}\n  provider: deepseek\n`);
    if (spec.soul !== undefined) writeFileSync(join(dir, "SOUL.md"), spec.soul);
    if (spec.meta !== undefined) writeFileSync(join(dir, "profile.yaml"), spec.meta);
    for (let i = 0; i < (spec.skills ?? 0); i += 1) {
      mkdirSync(join(dir, "skills", `group${i % 2}`, `skill${i}`), { recursive: true });
      writeFileSync(join(dir, "skills", `group${i % 2}`, `skill${i}`, "SKILL.md"), "# skill\n");
    }
  }
  return { home, root, env: { HOME: home } as Record<string, string | undefined> };
}

describe("hermesHome and hermesRoot follow Hermes' own resolution", () => {
  it("resolves default to the root and a name to profiles/<name>", () => {
    const { root, env } = fakeHome();
    expect(hermesRoot(env)).toBe(root);
    expect(hermesHome(env)).toBe(root);
    expect(hermesHome(env, "fred")).toBe(join(root, "profiles", "fred"));
  });

  it("treats a HERMES_HOME that is itself a profile as naming its root", () => {
    const { root, env } = fakeHome();
    const profileEnv = { ...env, HERMES_HOME: join(root, "profiles", "fred") };
    expect(hermesRoot(profileEnv)).toBe(root);
    expect(hermesHome(profileEnv)).toBe(root);
    expect(hermesHome(profileEnv, "flux-ceo")).toBe(join(root, "profiles", "flux-ceo"));
  });

  it("keeps a custom root HERMES_HOME as the root", () => {
    expect(hermesHome({ HOME: "/h", HERMES_HOME: "/opt/data" }, "fred")).toBe(join("/opt/data", "profiles", "fred"));
  });

  it.each(["../etc", "Fred", "", "-x", "a/b", "x".repeat(65)])("refuses %j before it can become a path", (name) => {
    expect(() => hermesHome({ HOME: "/h" }, name)).toThrow(/not a Hermes profile name/);
  });

  it("reads the profile off an instance config, default when absent or invalid", () => {
    expect(hermesProfileOf({ profile: "fred" })).toBe("fred");
    expect(hermesProfileOf({ profile: "../x" })).toBe("default");
    expect(hermesProfileOf(undefined)).toBe("default");
    expect(hermesProfileOwnsIdentity({ profile: "fred" })).toBe(true);
    expect(hermesProfileOwnsIdentity({ profile: "flux-ceo", profileOrigin: "sticky" })).toBe(false);
    expect(hermesProfileOwnsIdentity({ profile: "default" })).toBe(false);
  });
});

describe("stickyHermesProfile: what a bare `hermes acp` ran before 0.1.61", () => {
  it("follows active_profile to a live profile", () => {
    const { env } = fakeHome({ sticky: "flux-ceo", profiles: { "flux-ceo": { model: "deepseek-v4-pro" } } });
    expect(stickyHermesProfile(env)).toBe("flux-ceo");
  });

  it("is default with no active_profile, or when it says default", () => {
    expect(stickyHermesProfile(fakeHome().env)).toBe("default");
    expect(stickyHermesProfile(fakeHome({ sticky: "default" }).env)).toBe("default");
  });

  it("is default when the sticky profile could not start (missing, deleted or invalid)", () => {
    expect(stickyHermesProfile(fakeHome({ sticky: "ghost" }).env)).toBe("default");
    const deleted = fakeHome({ sticky: "old", profiles: { old: { model: "m" } } });
    mkdirSync(join(deleted.root, "profiles", ".deleted"), { recursive: true });
    writeFileSync(join(deleted.root, "profiles", ".deleted", "old"), "deleted\n");
    expect(stickyHermesProfile(deleted.env)).toBe("default");
    expect(stickyHermesProfile(fakeHome({ sticky: "Bad Name" }).env)).toBe("default");
  });

  it("ignores HERMES_PROFILE, exactly as Hermes does", () => {
    const { env } = fakeHome({ sticky: "flux-ceo", profiles: { "flux-ceo": { model: "m" }, fred: { model: "f" } } });
    expect(stickyHermesProfile({ ...env, HERMES_PROFILE: "fred" })).toBe("flux-ceo");
  });

  it("trusts a HERMES_HOME that points at a profile directory", () => {
    const { root, env } = fakeHome({ sticky: "flux-ceo", profiles: { "flux-ceo": { model: "m" }, fred: { model: "f" } } });
    expect(stickyHermesProfile({ ...env, HERMES_HOME: join(root, "profiles", "fred") })).toBe("fred");
  });

  it("reads active_profile from ~/.hermes even when HERMES_HOME is the root", () => {
    const { root, env } = fakeHome({ sticky: "flux-ceo", profiles: { "flux-ceo": { model: "m" } } });
    expect(stickyHermesProfile({ ...env, HERMES_HOME: root })).toBe("flux-ceo");
  });
});

describe("listHermesProfiles reads the filesystem only", () => {
  it("lists default and every live profile with model, skills, persona and the sticky mark", () => {
    const { root, env } = fakeHome({
      sticky: "flux-ceo",
      profiles: {
        "flux-ceo": { model: "deepseek-v4-pro", soul: "# Flux CEO\n\nYou run Flux Labs. You decide fast.\n", skills: 3 },
        fred: { model: "anthropic/claude-opus-4.6", meta: "display_name: Fred\ndescription: Research partner.\n" },
      },
    });
    // Not profiles: an identity-less directory, a tombstoned one, a bad name.
    mkdirSync(join(root, "profiles", "cache-only"), { recursive: true });
    mkdirSync(join(root, "profiles", "gone"), { recursive: true });
    writeFileSync(join(root, "profiles", "gone", "config.yaml"), "model: x\n");
    mkdirSync(join(root, "profiles", ".deleted"), { recursive: true });
    writeFileSync(join(root, "profiles", ".deleted", "gone"), "deleted\n");
    mkdirSync(join(root, "profiles", "Bad Name"), { recursive: true });
    writeFileSync(join(root, "profiles", "Bad Name", "config.yaml"), "model: x\n");

    const listing = listHermesProfiles(env);
    expect(listing.found).toBe(true);
    expect(listing.profiles.map((profile) => profile.name)).toEqual(["default", "flux-ceo", "fred"]);
    const [def, ceo, fred] = listing.profiles;
    expect(def).toMatchObject({ model: "openrouter/root-model", sticky: false });
    expect(ceo).toMatchObject({ label: "flux-ceo", model: "deepseek-v4-pro", skillCount: 3, hasSoul: true, sticky: true, description: "You run Flux Labs." });
    expect(fred).toMatchObject({ label: "Fred", description: "Research partner.", hasSoul: false, sticky: false });
  });

  it("finds nothing where Hermes is not installed", () => {
    const home = mkdtempSync(join(tmpdir(), "murage-hermes-none-"));
    dirs.push(home);
    expect(listHermesProfiles({ HOME: home })).toEqual({ found: false, profiles: [] });
  });

  it("takes the first sentence of SOUL.md, not a heading", () => {
    expect(firstSentence("# Title\n\n**You are Fred.** You help. More.")).toBe("You are Fred.");
    expect(firstSentence("")).toBe("");
  });
});

describe("planHermesImport", () => {
  const instances: InstanceConfigMap = {
    hermes: { driver: "hermesAgent" },
    "hermes-profile-fred": { driver: "hermesAgent", config: { profile: "fred" } },
    claude: { driver: "claudeAgent" },
  };
  const available = new Set(["default", "fred", "flux-ceo", "flux-cro"]);

  it("creates one bot per profile, reusing an instance already pinned to it", () => {
    const plan = planHermesImport({ requested: ["fred", "flux-ceo"], available, instances, bots: [], maxBots: 100 });
    expect(plan).toEqual([
      { profile: "fred", action: "create", instanceId: "hermes-profile-fred", newInstance: false },
      { profile: "flux-ceo", action: "create", instanceId: "hermes-profile-flux-ceo", newInstance: true },
    ]);
  });

  it("is idempotent: a profile a bot already runs is skipped and names that bot", () => {
    const withBots: InstanceConfigMap = { ...instances, "hermes-profile-flux-ceo": { driver: "hermesAgent", config: { profile: "flux-ceo" } } };
    const bots = [{ id: "b1", name: "Fred", instanceId: "hermes-profile-fred" }, { id: "b2", name: "Ceo", instanceId: "hermes-profile-flux-ceo" }];
    const plan = planHermesImport({ requested: ["fred", "flux-ceo", "fred"], available, instances: withBots, bots, maxBots: 100 });
    expect(plan).toEqual([
      { profile: "fred", action: "skip", reason: "already-imported", botName: "Fred" },
      { profile: "flux-ceo", action: "skip", reason: "already-imported", botName: "Ceo" },
    ]);
  });

  it("counts a bot on the plain Hermes engine as the default profile's bot", () => {
    const plan = planHermesImport({ requested: ["default"], available, instances, bots: [{ id: "b", name: "Old Hermes", instanceId: "hermes" }], maxBots: 100 });
    expect(plan).toEqual([{ profile: "default", action: "skip", reason: "already-imported", botName: "Old Hermes" }]);
  });

  it("stops at the workspace bot limit", () => {
    const bots = Array.from({ length: 99 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, instanceId: "claude" }));
    const plan = planHermesImport({ requested: ["fred", "flux-ceo", "flux-cro"], available, instances, bots, maxBots: 100 });
    expect(plan.map((item) => [item.profile, item.action, item.action === "skip" ? item.reason : ""])).toEqual([
      ["fred", "create", ""],
      ["flux-ceo", "skip", "limit"],
      ["flux-cro", "skip", "limit"],
    ]);
  });

  it("skips a profile Hermes does not have and a name Hermes would refuse", () => {
    const plan = planHermesImport({ requested: ["nobody", "../../etc"], available, instances, bots: [], maxBots: 100 });
    expect(plan).toEqual([
      { profile: "nobody", action: "skip", reason: "not-found" },
      { profile: "../../etc", action: "skip", reason: "invalid" },
    ]);
  });
});

describe("the 0.1.61 upgrade pin (O12)", () => {
  it("pins an unpinned instance to its sticky profile, and nothing for default", () => {
    const sticky = fakeHome({ sticky: "flux-ceo", profiles: { "flux-ceo": { model: "deepseek-v4-pro" } } });
    const instances: InstanceConfigMap = {
      hermes: { driver: "hermesAgent" },
      pinned: { driver: "hermesAgent", config: { profile: "default" } },
      claude: { driver: "claudeAgent" },
    };
    expect(planHermesProfilePins(instances, sticky.env)).toEqual([{ instanceId: "hermes", profile: "flux-ceo", origin: "sticky" }]);
    expect(planHermesProfilePins(instances, fakeHome().env)).toEqual([]);
  });

  it("resolves each instance under its own environment", () => {
    const { root, env } = fakeHome({ sticky: "flux-ceo", profiles: { "flux-ceo": { model: "m" }, fred: { model: "f" } } });
    const instances: InstanceConfigMap = { research: { driver: "hermesAgent", environment: { HERMES_HOME: join(root, "profiles", "fred") } } };
    expect(planHermesProfilePins(instances, env)).toEqual([{ instanceId: "research", profile: "fred", origin: "sticky" }]);
  });

  it("gives an imported instance that lost its config its own name back, never the sticky one", () => {
    const { env } = fakeHome({ sticky: "flux-ceo", profiles: { "flux-ceo": { model: "m" }, fred: { model: "f" } } });
    expect(planHermesProfilePins({ "hermes-profile-fred": { driver: "hermesAgent" } }, env)).toEqual([{ instanceId: "hermes-profile-fred", profile: "fred", origin: "import" }]);
    // A collision suffix is not a profile: no live "fred-2", so the id says nothing (audit, Kimi 4).
    expect(planHermesProfilePins({ "hermes-profile-fred-2": { driver: "hermesAgent" } }, env)).toEqual([{ instanceId: "hermes-profile-fred-2", profile: "flux-ceo", origin: "sticky" }]);
  });

  let instance: ProviderInstance | undefined;
  afterEach(async () => {
    await instance?.dispose();
    instance = undefined;
  });

  it("ACCEPTANCE: an upgraded sticky flux-ceo bot still runs flux-ceo (fake home)", async () => {
    const { home, root, env } = fakeHome({
      rootModel: "openrouter/root-model",
      sticky: "flux-ceo",
      profiles: { "flux-ceo": { model: "deepseek-v4-pro", soul: "You are the Flux CEO." }, fred: { model: "anthropic/claude-opus-4.6" } },
    });
    // 0.1.60's fleet: the plain Hermes engine, no profile anywhere.
    const [pin] = planHermesProfilePins({ hermes: { driver: "hermesAgent" } }, env);
    expect(pin).toEqual({ instanceId: "hermes", profile: "flux-ceo", origin: "sticky" });
    const config = { profile: pin.profile, profileOrigin: "sticky" as const };

    // The home Murage now reads and writes is flux-ceo's, and so is the model
    // it shows: before 0.1.61 it read `default`'s config.yaml here.
    expect(hermesHome(env, hermesProfileOf(config))).toBe(join(root, "profiles", "flux-ceo"));
    expect(hermesConfiguredModel({ ...env }, "flux-ceo")?.label).toBe("deepseek-v4-pro (Hermes profile flux-ceo)");

    // Somebody later runs `hermes profile use fred` in a terminal. The bot
    // must not follow it: the spawn names its profile.
    writeFileSync(join(root, "active_profile"), "fred\n");
    const dump = join(home, "dump.json");
    instance = await HermesAgentDriver.create({
      instanceId: "hermes",
      displayName: "Hermes",
      environment: { HOME: home, FAKE_ACP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_ACP, fullAuto: true, ...config },
    });
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-sticky", text: "who are you", model: HERMES_CONFIG_MODEL_ID });
    await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();
    const { argv } = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] };
    expect(argv).toEqual(["-p", "flux-ceo", "acp"]);
  });
});

describe("spawn argv", () => {
  it("always names the profile, default included", () => {
    expect(hermesSpawnArgs(undefined, { HOME: "/h" })).toEqual(["-p", "default", "acp"]);
    expect(hermesSpawnArgs({ profile: "fred" }, { HOME: "/h" })).toEqual(["-p", "fred", "acp"]);
  });

  it("uses default inside a home Murage made for one turn, where -p <name> could not resolve", () => {
    const data = mkdtempSync(join(tmpdir(), "murage-hermes-data-"));
    dirs.push(data);
    // Murage marks the homes it makes (markHermesRoutedHome); being under the
    // data dir alone is not enough (audit round 1, Astra 3).
    const turnHome = join(data, "flux-hermes-home");
    expect(hermesSpawnArgs({ profile: "flux-ceo", profileOrigin: "sticky" }, { HOME: "/h", MURAGE_DATA_DIR: data, HERMES_HOME: turnHome, MURAGE_HERMES_ROUTED_HOME: turnHome })).toEqual(["-p", "default", "acp"]);
    expect(hermesSpawnArgs({ profile: "flux-ceo", profileOrigin: "sticky" }, { HOME: "/h", MURAGE_DATA_DIR: data, HERMES_HOME: turnHome })).toEqual(["-p", "flux-ceo", "acp"]);
    expect(hermesSpawnArgs({ profile: "fred" }, { HOME: "/h", MURAGE_DATA_DIR: data, HERMES_HOME: "/elsewhere/.hermes" })).toEqual(["-p", "fred", "acp"]);
  });
});

describe("backup and restore carry the profile, nothing else", () => {
  it("keeps profile and origin for a Hermes engine only", () => {
    expect(hermesProfileCarry("hermesAgent", { profile: "fred", cli: "/x/hermes", token: "t" })).toEqual({ profile: "fred" });
    expect(hermesProfileCarry("hermesAgent", { profile: "flux-ceo", profileOrigin: "sticky" })).toEqual({ profile: "flux-ceo", profileOrigin: "sticky" });
    expect(hermesProfileCarry("hermesAgent", { profile: "../x" })).toBeUndefined();
    expect(hermesProfileCarry("claudeAgent", { profile: "fred" })).toBeUndefined();
  });
});

describe("the one-time pin note", () => {
  it("round-trips the profile and reads as a plain sentence", () => {
    const name = hermesPinNoteActivityName("flux-ceo");
    expect(hermesPinNoteProfile(name)).toBe("flux-ceo");
    expect(hermesPinNoteText(hermesPinNoteProfile(name)!)).toContain("\"flux-ceo\"");
    expect(hermesPinNoteProfile("error: boom")).toBeUndefined();
  });
});

describe("Import from Hermes binds to the listed root (audit round 1, Astra 2)", () => {
  it("never reuses, or counts as imported, an instance running a same-name profile in another root", () => {
    const baseEnv = { HOME: "/h" };
    const instances: InstanceConfigMap = {
      research: { driver: "hermesAgent", config: { profile: "fred" }, environment: { HERMES_HOME: "/other/hermes" } },
    };
    const plan = planHermesImport({
      requested: ["fred"], available: new Set(["fred"]), instances,
      bots: [{ id: "b1", name: "Research", instanceId: "research" }], maxBots: 10, baseEnv,
    });
    expect(plan).toEqual([{ profile: "fred", action: "create", instanceId: "hermes-profile-fred", newInstance: true }]);
    const taken: InstanceConfigMap = { "hermes-profile-fred": { driver: "hermesAgent", config: { profile: "fred" }, environment: { HERMES_HOME: "/other/hermes" } } };
    expect(planHermesImport({ requested: ["fred"], available: new Set(["fred"]), instances: taken, bots: [], maxBots: 10, baseEnv }))
      .toEqual([{ profile: "fred", action: "create", instanceId: "hermes-profile-fred-2", newInstance: true }]);
    const local: InstanceConfigMap = { ...instances, mine: { driver: "hermesAgent", config: { profile: "fred" } } };
    expect(planHermesImport({ requested: ["fred"], available: new Set(["fred"]), instances: local, bots: [], maxBots: 10, baseEnv }))
      .toEqual([{ profile: "fred", action: "create", instanceId: "mine", newInstance: false }]);
  });
});
