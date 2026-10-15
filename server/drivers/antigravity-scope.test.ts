// Antigravity isolation: agy runs in a Murage-owned HOME, so the owner's
// personal MCP servers, plugins, hooks, skills, workflows and instruction
// files are absent, Murage's own tools are present, the login still resolves,
// and the owner's real ~/.gemini is not written.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, linkSync as linkSyncReal, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { recordEvents } from "../testing/events.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { antigravityLockConfig, buildAntigravityScopedHome, forgetLiveScopes, recoverAllScopedHomes, removeAntigravityLegacyMcpEntries, type MirrorOps } from "./antigravity-scope.ts";
import { processIdentity } from "./process-identity.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");

const LEGACY_COMPUTER = {
  command: "/Applications/Murage.app/Contents/MacOS/Murage",
  args: ["/Applications/Murage.app/Contents/Resources/server/computer-proxy.js"],
  env: { ELECTRON_RUN_AS_NODE: "1", MURAGEBOX_BOX_ID: "box", MURAGEBOX_BOX_TOKEN: "stale-token", MURAGE_CONTROL_URL: "", MURAGE_CONTROL_TOKEN: "" },
};
const LEGACY_LINK_NOTES = {
  command: "/Applications/Murage.app/Contents/MacOS/Murage",
  args: ["/Applications/Murage.app/Contents/Resources/server/drivers/remote-mcp-proxy.js", "--server", "notes"],
  env: { ELECTRON_RUN_AS_NODE: "1", MURAGE_HARNESS_URL: "http://127.0.0.1:4100", MURAGE_MCP_TOKEN: "stale" },
};
const LEGACY_AGENTS = {
  command: "/usr/bin/node",
  args: ["/opt/murage/server/drivers/agents-proxy.ts"],
  env: { ELECTRON_RUN_AS_NODE: "1", MURAGE_HARNESS_URL: "http://127.0.0.1:4100", MURAGE_BOT_ID: "b", MURAGE_THREAD_ID: "t", MURAGE_COMMS_TOKEN: "old", MURAGE_TURN_DEPTH: "0", MURAGE_SKILL_AUTHORING_ENABLED: "0" },
};
const OWNER_KEPT = ["murage-agents", "murage-custom-mine", "personal-db", "personal-github"];

/** A synthetic heavy home: personal servers, plugin, hook, skill, workflow, rules, instruction files, a login. */
function heavyHome(): string {
  const home = mkdtempSync(join(tmpdir(), "murage-agy-heavy-"));
  const gemini = join(home, ".gemini");
  const config = join(gemini, "config");
  const cli = join(gemini, "antigravity-cli");
  for (const dir of [
    join(config, "plugins", "personal-plugin"),
    join(config, "skills", "my-skill"),
    join(config, "workflows"),
    join(config, "rules"),
    join(config, "global_workflows"),
    cli,
    join(gemini, "jetski", "brain"),
    join(home, ".ssh"),
  ]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(config, "mcp_config.json"), JSON.stringify({
    mcpServers: {
      "personal-github": { command: "npx", args: ["gh-mcp"], env: { GH: "x" } },
      "personal-db": { command: "db-mcp", args: [] },
      // what Murage before 1.0.2 left behind, in the exact shape it wrote (antigravity.ts at 6a28f6423)
      "murage-computer": LEGACY_COMPUTER,
      "murage-custom-notes": LEGACY_LINK_NOTES,
      // the owner's own servers under Murage-like names: not provably Murage's, so kept
      "murage-agents": { command: "python3", args: ["my_agents.py"], env: {} },
      "murage-custom-mine": { command: "npx", args: ["notes-mcp"], env: { NOTES: "1" } },
    },
    theme: "keep-me",
  }, null, 2));
  writeFileSync(join(config, "plugins", "personal-plugin", "mcp_config.json"), "{}");
  writeFileSync(join(config, "skills", "my-skill", "SKILL.md"), "# skill");
  writeFileSync(join(config, "workflows", "w.md"), "w");
  writeFileSync(join(config, "rules", "r.md"), "r");
  writeFileSync(join(config, "hooks.json"), "{}");
  writeFileSync(join(config, "GEMINI.md"), "personal rules");
  writeFileSync(join(config, "config.json"), "{\"plugins\":{}}");
  writeFileSync(join(gemini, "GEMINI.md"), "personal instructions");
  writeFileSync(join(gemini, "AGENTS.md"), "personal agents");
  writeFileSync(join(cli, "hooks.json"), "{}");
  writeFileSync(join(cli, "settings.json"), "{\"model\":\"m\"}");
  writeFileSync(join(cli, "auth.json"), "LOGIN-TOKEN-FIXTURE");
  writeFileSync(join(home, ".ssh", "config"), "ssh");
  writeFileSync(join(home, ".gitconfig"), "git");
  return home;
}

const murageServers = {
  "murage-agents": { command: process.execPath, args: [SPAWNED_PROXIES.agents], env: { MURAGE_COMMS_TOKEN: "t" } },
};

describe("buildAntigravityScopedHome", () => {
  it("drops the owner's personal items, keeps login and the rest of the home, mounts only Murage's servers", () => {
    const home = heavyHome();
    const root = mkdtempSync(join(tmpdir(), "murage-agy-scope-"));
    try {
      const scoped = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "t1", servers: murageServers });
      const g = join(scoped.home, ".gemini");
      for (const gone of [
        join(g, "GEMINI.md"), join(g, "AGENTS.md"),
        join(g, "config", "plugins"), join(g, "config", "skills"), join(g, "config", "workflows"),
        join(g, "config", "rules"), join(g, "config", "global_workflows"), join(g, "config", "hooks.json"),
        join(g, "config", "GEMINI.md"), join(g, "antigravity-cli", "hooks.json"),
      ]) expect(existsSync(gone), gone).toBe(false);
      const mcp = JSON.parse(readFileSync(join(g, "config", "mcp_config.json"), "utf8"));
      expect(Object.keys(mcp.mcpServers)).toEqual(["murage-agents"]);
      expect(JSON.stringify(mcp)).not.toContain("personal-");
      // login, settings, conversations, ssh and git setup all resolve to the real files
      expect(readFileSync(join(g, "antigravity-cli", "auth.json"), "utf8")).toBe("LOGIN-TOKEN-FIXTURE");
      expect(readFileSync(join(g, "antigravity-cli", "settings.json"), "utf8")).toBe("{\"model\":\"m\"}");
      expect(readFileSync(join(g, "config", "config.json"), "utf8")).toBe("{\"plugins\":{}}");
      expect(existsSync(join(g, "jetski", "brain"))).toBe(true);
      expect(readFileSync(join(scoped.home, ".gitconfig"), "utf8")).toBe("git");
      expect(readFileSync(join(scoped.home, ".ssh", "config"), "utf8")).toBe("ssh");
      // the scoped mcp file is private
      if (process.platform !== "win32") expect(lstatSync(join(g, "config", "mcp_config.json")).mode & 0o777).toBe(0o600);
      scoped.dispose();
      expect(existsSync(scoped.home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never writes the owner's files: their mcp_config.json and personal items are byte-identical afterwards", () => {
    const home = heavyHome();
    const root = mkdtempSync(join(tmpdir(), "murage-agy-scope-"));
    const before = readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8");
    try {
      const scoped = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "t2", servers: murageServers });
      scoped.dispose();
      expect(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8")).toBe(before);
      expect(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8")).toBe("personal instructions");
      expect(existsSync(join(home, ".gemini", "config", "plugins", "personal-plugin", "mcp_config.json"))).toBe(true);
      expect(readFileSync(join(home, ".gemini", "antigravity-cli", "auth.json"), "utf8")).toBe("LOGIN-TOKEN-FIXTURE");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a tool-less turn gets no mcp_config.json at all, and state agy creates is kept in the real home", () => {
    const home = heavyHome();
    const root = mkdtempSync(join(tmpdir(), "murage-agy-scope-"));
    try {
      const scoped = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "t3", servers: {} });
      const g = join(scoped.home, ".gemini");
      expect(existsSync(join(g, "config", "mcp_config.json"))).toBe(false);
      // agy creates a new conversation store and a new config file during the turn
      mkdirSync(join(g, "newstate"));
      writeFileSync(join(g, "newstate", "c.pb"), "conv");
      writeFileSync(join(g, "config", "created.json"), "{}");
      scoped.dispose();
      expect(readFileSync(join(home, ".gemini", "newstate", "c.pb"), "utf8")).toBe("conv");
      expect(readFileSync(join(home, ".gemini", "config", "created.json"), "utf8")).toBe("{}");
      // but a file the owner never had in the personal set is never adopted over theirs
      expect(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8")).toBe("personal instructions");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("removeAntigravityLegacyMcpEntries", () => {
  it("removes only Murage's own keys and keeps every other server and top-level key", () => {
    const home = heavyHome();
    try {
      const removed = removeAntigravityLegacyMcpEntries(home);
      expect(removed.sort()).toEqual(["murage-computer", "murage-custom-notes"]);
      const after = JSON.parse(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8"));
      expect(Object.keys(after.mcpServers).sort()).toEqual(OWNER_KEPT);
      expect(after.mcpServers["murage-agents"]).toEqual({ command: "python3", args: ["my_agents.py"], env: {} });
      expect(after.theme).toBe("keep-me");
      expect(after.mcpServers["personal-github"]).toEqual({ command: "npx", args: ["gh-mcp"], env: { GH: "x" } });
      // second run: nothing left, file untouched
      expect(removeAntigravityLegacyMcpEntries(home)).toEqual([]);
      // a name that merely resembles ours is the owner's; so is a Murage key whose shape is not Murage's
      const path = join(home, ".gemini", "config", "mcp_config.json");
      const legacyAgents = LEGACY_AGENTS;
      writeFileSync(path, JSON.stringify({ mcpServers: {
        "murage-computer-2": LEGACY_COMPUTER,
        "my-murage-custom-x": LEGACY_LINK_NOTES,
        "murage-agents": legacyAgents,
        // Murage's proxy but no Murage capability in env, or an extra key the owner added: not provable
        "murage-computer": { ...LEGACY_COMPUTER, env: { ELECTRON_RUN_AS_NODE: "1" } },
        "murage-custom-notes": { ...LEGACY_LINK_NOTES, disabled: true },
        // a link-server entry whose --server does not match its key
        "murage-custom-other": LEGACY_LINK_NOTES,
      } }));
      expect(removeAntigravityLegacyMcpEntries(home)).toEqual(["murage-agents"]);
      expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).mcpServers).sort()).toEqual(["murage-computer", "murage-computer-2", "murage-custom-notes", "murage-custom-other", "my-murage-custom-x"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves a missing, malformed or wrong-shaped file byte-identical", () => {
    const home = mkdtempSync(join(tmpdir(), "murage-agy-legacy-"));
    try {
      expect(removeAntigravityLegacyMcpEntries(home)).toEqual([]);
      const path = join(home, ".gemini", "config", "mcp_config.json");
      mkdirSync(dirname(path), { recursive: true });
      for (const bytes of ["{ not json", "[]", JSON.stringify({ mcpServers: [] }), JSON.stringify({ mcpServers: { "personal-x": {} } })]) {
        writeFileSync(path, bytes);
        expect(removeAntigravityLegacyMcpEntries(home)).toEqual([]);
        expect(readFileSync(path, "utf8")).toBe(bytes);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Antigravity driver isolation (fake CLI)", () => {
  const run = async (fullAuto: boolean, integrations?: Record<string, unknown>) => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = heavyHome();
    const homeDump = join(home, "child-home.json");
    const mcpDump = join(home, "child-mcp.json");
    const before = readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8");
    const instance = await AntigravityDriver.create({
      instanceId: "agy-iso", displayName: undefined,
      environment: { HOME: home, FAKE_AGY_HOME_DUMP: homeDump, FAKE_AGY_MCP_DUMP: mcpDump },
      enabled: true, config: { cli: FAKE_CLI, fullAuto },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      // the start-up cleanup already took Murage's stale entries out of the owner's file
      const afterStart = JSON.parse(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8"));
      expect(Object.keys(afterStart.mcpServers).sort()).toEqual(OWNER_KEPT);
      expect(before).toContain("stale-token");
      await instance.adapter.sendTurn({ threadId: "t-iso", text: "hi", integrations: integrations as never });
      await recorder.until((e) => e.type === "turn.completed");
      return {
        home,
        child: JSON.parse(readFileSync(homeDump, "utf8")) as { home: string; seen: string[]; loginReal: string | null; loginText: string | null },
        mcp: JSON.parse(readFileSync(mcpDump, "utf8")) as { mcpServers?: Record<string, unknown> } | null,
        owner: () => JSON.parse(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8")),
        done: () => recorder.events.find((e) => e.type === "turn.completed"),
        errors: () => recorder.events.filter((e) => e.type === "runtime.error"),
        cleanup: async () => { recorder.stop(); await instance.dispose(); rmSync(home, { recursive: true, force: true }); },
      };
    } catch (error) {
      recorder.stop();
      await instance.dispose();
      rmSync(home, { recursive: true, force: true });
      throw error;
    }
  };

  it("the child sees none of the owner's personal setup, sees Murage's tools and the login, and the owner's file is not touched", async () => {
    const r = await run(true, { agents: { command: process.execPath, args: [SPAWNED_PROXIES.agents], env: { MURAGE_COMMS_TOKEN: "turn-secret" } } });
    try {
      expect(r.child.home).not.toBe(r.home);
      const seen = r.child.seen.join("\n");
      for (const personal of ["GEMINI.md", "AGENTS.md", "plugins", "skills", "workflows", "rules", "hooks.json", "global_workflows"]) {
        expect(seen, personal).not.toContain(personal);
      }
      expect(Object.keys(r.mcp?.mcpServers ?? {})).toEqual(["murage-agents"]);
      expect(r.child.loginText).toBe("LOGIN-TOKEN-FIXTURE");
      expect(r.child.loginReal).toContain(join(".gemini", "antigravity-cli", "auth.json"));
      // owner's file keeps their servers and the unknown key, and never held the turn's token
      const owner = r.owner();
      expect(Object.keys(owner.mcpServers).sort()).toEqual(OWNER_KEPT);
      expect(owner.theme).toBe("keep-me");
      expect(JSON.stringify(owner)).not.toContain("turn-secret");
      expect(r.done()).toMatchObject({ ok: true });
      expect(r.errors()).toEqual([]);
      // scoped tree is gone after the turn
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(existsSync(r.child.home)).toBe(false);
    } finally {
      await r.cleanup();
    }
  });

  it("a tool-less safe-mode turn still runs isolated, with no Murage servers and none of the owner's", async () => {
    const r = await run(false, undefined);
    try {
      expect(r.mcp).toBeNull();
      expect(r.child.seen.join("\n")).not.toContain("hooks.json");
      expect(r.child.loginText).toBe("LOGIN-TOKEN-FIXTURE");
      expect(r.done()).toMatchObject({ ok: true });
    } finally {
      await r.cleanup();
    }
  });
});

/** A scope root inside its own temp folder, so the kept folder (its sibling) is cleaned with it. */
function scopeDirs(): { base: string; root: string; kept: string } {
  const base = mkdtempSync(join(tmpdir(), "murage-agy-rec-"));
  return { base, root: join(base, "antigravity-scope"), kept: join(base, "antigravity-kept") };
}
/** Every file under `dir`, as relative paths. */
function filesUnder(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return lstatSync(path).isDirectory() ? filesUnder(path, join(prefix, name)) : [join(prefix, name)];
  });
}
/** agy's way of saving a file: a temp file renamed over it (which replaces a symlink). */
function atomicSave(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}
const setMtime = (path: string, ms: number) => utimesSync(path, new Date(ms), new Date(ms));

describe("legacy cleanup keeps a symlinked mcp_config.json a symlink", () => {
  it("updates the resolved target in place and leaves the owner's dotfiles link intact", () => {
    const home = heavyHome();
    const dotfiles = mkdtempSync(join(tmpdir(), "murage-agy-dotfiles-"));
    try {
      const link = join(home, ".gemini", "config", "mcp_config.json");
      const target = join(dotfiles, "agy-mcp.json");
      writeFileSync(target, readFileSync(link));
      chmodSync(target, 0o640);
      rmSync(link);
      symlinkSync(target, link);
      expect(removeAntigravityLegacyMcpEntries(home).sort()).toEqual(["murage-computer", "murage-custom-notes"]);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(target);
      expect(Object.keys(JSON.parse(readFileSync(target, "utf8")).mcpServers).sort()).toEqual(OWNER_KEPT);
      expect(lstatSync(target).mode & 0o777).toBe(0o640);
      expect(readdirSync(dotfiles)).toEqual(["agy-mcp.json"]); // no temp file left behind
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dotfiles, { recursive: true, force: true });
    }
  });
});

describe("scoped homes reconcile what agy wrote; nothing is discarded", () => {
  it("two first turns that each create the same new state folder keep both turns' contents", () => {
    const home = heavyHome();
    const { base, root } = scopeDirs();
    try {
      const a = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "a", servers: {} });
      const b = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "b", servers: {} });
      for (const [scope, conv] of [[a, "conv-a"], [b, "conv-b"]] as const) {
        mkdirSync(join(scope.home, ".gemini", "antigravity", "conversations"), { recursive: true });
        writeFileSync(join(scope.home, ".gemini", "antigravity", "conversations", `${conv}.pb`), conv);
      }
      a.dispose();
      b.dispose();
      const convs = join(home, ".gemini", "antigravity", "conversations");
      expect(readdirSync(convs).sort()).toEqual(["conv-a.pb", "conv-b.pb"]);
      expect(readFileSync(join(convs, "conv-b.pb"), "utf8")).toBe("conv-b");
      expect(existsSync(a.home) || existsSync(b.home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a login file agy replaces by temp-and-rename is written back to the real file, through the owner's symlink", () => {
    const home = heavyHome();
    const dotfiles = mkdtempSync(join(tmpdir(), "murage-agy-dotfiles-"));
    const { base, root } = scopeDirs();
    try {
      const realAuth = join(home, ".gemini", "antigravity-cli", "auth.json");
      const target = join(dotfiles, "auth.json");
      writeFileSync(target, "LOGIN-TOKEN-FIXTURE");
      rmSync(realAuth);
      symlinkSync(target, realAuth);
      const scope = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "refresh", servers: {} });
      atomicSave(join(scope.home, ".gemini", "antigravity-cli", "auth.json"), "REFRESHED-TOKEN");
      scope.dispose();
      expect(lstatSync(realAuth).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("REFRESHED-TOKEN");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dotfiles, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("when both sides changed, the newer one wins and the other is kept, never dropped", () => {
    const home = heavyHome();
    const { base, root, kept } = scopeDirs();
    try {
      const realAuth = join(home, ".gemini", "antigravity-cli", "auth.json");
      // 1: the real file was refreshed by another turn later than ours: the real one stays, ours is kept
      const one = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "one", servers: {} });
      atomicSave(join(one.home, ".gemini", "antigravity-cli", "auth.json"), "OURS-OLDER");
      setMtime(join(one.home, ".gemini", "antigravity-cli", "auth.json"), Date.now() - 60_000);
      writeFileSync(realAuth, "OTHER-TURN-NEWER");
      one.dispose();
      expect(readFileSync(realAuth, "utf8")).toBe("OTHER-TURN-NEWER");
      expect(filesUnder(kept).some((f) => f.endsWith(join("antigravity-cli", "auth.json")))).toBe(true);
      expect(filesUnder(kept).map((f) => readFileSync(join(kept, f), "utf8"))).toContain("OURS-OLDER");
      // 2: ours is newer: it is written back, and the other side's version is kept
      const two = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "two", servers: {} });
      writeFileSync(realAuth, "OTHER-OLDER");
      setMtime(realAuth, Date.now() - 60_000);
      atomicSave(join(two.home, ".gemini", "antigravity-cli", "auth.json"), "OURS-NEWER");
      two.dispose();
      expect(readFileSync(realAuth, "utf8")).toBe("OURS-NEWER");
      expect(filesUnder(kept).map((f) => readFileSync(join(kept, f), "utf8"))).toContain("OTHER-OLDER");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a personal-named file agy writes in a bot turn is kept aside, never put into the owner's setup", () => {
    const home = heavyHome();
    const { base, root, kept } = scopeDirs();
    try {
      const scope = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "p", servers: {} });
      writeFileSync(join(scope.home, ".gemini", "GEMINI.md"), "bot memory");
      scope.dispose();
      expect(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8")).toBe("personal instructions");
      expect(filesUnder(kept).map((f) => readFileSync(join(kept, f), "utf8"))).toContain("bot memory");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a run that stopped before dispose is reconciled at the next start from its manifest", () => {
    const home = heavyHome();
    const { base, root } = scopeDirs();
    try {
      const scope = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "crashed", servers: murageServers });
      atomicSave(join(scope.home, ".gemini", "antigravity-cli", "auth.json"), "REFRESHED-BEFORE-CRASH");
      mkdirSync(join(scope.home, ".gemini", "brand-new"));
      writeFileSync(join(scope.home, ".gemini", "brand-new", "x"), "x");
      // no dispose: the server stopped. The next start (a new process: nothing is live, the old owner is gone):
      restartAfterCrash(root);
      recoverAllScopedHomes(root);
      expect(readFileSync(join(home, ".gemini", "antigravity-cli", "auth.json"), "utf8")).toBe("REFRESHED-BEFORE-CRASH");
      expect(readFileSync(join(home, ".gemini", "brand-new", "x"), "utf8")).toBe("x");
      expect(readdirSync(root)).toEqual([]);
      // Murage's mount file never reaches the owner's home
      expect(JSON.stringify(JSON.parse(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8")))).not.toContain(SPAWNED_PROXIES.agents);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/** A process that sleeps until killed; resolves once it is running. */
async function sleeper(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", () => resolve()); child.once("error", reject); });
  return child;
}
async function stopped(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
}
/** The server that built these scopes stopped: no scope is live and every manifest's owner is a dead process. */
function restartAfterCrash(root: string, owner: { pid: number; id: string | null } = { pid: 2 ** 22 - 3, id: null }): void {
  forgetLiveScopes();
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(".manifest.json")) continue;
    const path = join(root, entry);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.owner = owner;
    writeFileSync(path, JSON.stringify(manifest));
  }
}
const setChild = (root: string, name: string, child: { pid: number; id: string | null }) => {
  const path = join(root, `${name}.manifest.json`);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.child = child;
  writeFileSync(path, JSON.stringify(manifest));
};

describe("round 2: token freshness, ownership, provenance", () => {
  const now = Date.now();
  const authPath = (home: string) => join(home, ".gemini", "antigravity-cli", "auth.json");

  it("the newest refreshed token wins whatever order the scopes are disposed in (reconcile time is never freshness)", () => {
    for (const order of [["a", "b"], ["b", "a"]] as const) {
      const home = heavyHome();
      const { base, root, kept } = scopeDirs();
      try {
        const a = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "a", servers: {} });
        const b = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "b", servers: {} });
        atomicSave(authPath(a.home), "T1-OLDER");
        setMtime(authPath(a.home), now - 20_000);
        atomicSave(authPath(b.home), "T2-NEWER");
        setMtime(authPath(b.home), now - 10_000);
        const scopes = { a, b };
        for (const name of order) scopes[name].dispose();
        expect(readFileSync(authPath(home), "utf8"), order.join()).toBe("T2-NEWER");
        // the older token is kept aside, never lost
        expect(filesUnder(kept).map((f) => readFileSync(join(kept, f), "utf8")), order.join()).toContain("T1-OLDER");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
      }
    }
  });

  it("a write-back keeps the source's write time, so it cannot look newer than a later real write", () => {
    const home = heavyHome();
    const { base, root } = scopeDirs();
    try {
      const a = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "a", servers: {} });
      atomicSave(authPath(a.home), "T1");
      setMtime(authPath(a.home), now - 30_000);
      a.dispose();
      expect(Math.abs(lstatSync(authPath(home)).mtimeMs - (now - 30_000))).toBeLessThan(2_000);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a write-back waits for another Murage process holding the file's lock: the scope is kept, then reconciled once the holder is gone", async () => {
    const home = heavyHome();
    const { base, root } = scopeDirs();
    const holder = await sleeper();
    const saved = { ...antigravityLockConfig };
    try {
      antigravityLockConfig.timeoutMs = 300;
      const a = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "a", servers: {} });
      atomicSave(authPath(a.home), "T-LOCKED");
      const lockRoot = join(base, "antigravity-locks");
      mkdirSync(lockRoot, { recursive: true });
      const { createHash } = await import("node:crypto");
      const lock = join(lockRoot, createHash("sha256").update(authPath(home)).digest("hex").slice(0, 24));
      mkdirSync(lock);
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: holder.pid, id: processIdentity(holder.pid!) }));
      a.dispose(); // times out: deferred, nothing written, nothing lost
      expect(readFileSync(authPath(home), "utf8")).toBe("LOGIN-TOKEN-FIXTURE");
      expect(existsSync(a.home)).toBe(true);
      await stopped(holder);
      restartAfterCrash(root);
      recoverAllScopedHomes(root); // the holder is gone: its lock is broken
      expect(readFileSync(authPath(home), "utf8")).toBe("T-LOCKED");
      expect(readdirSync(root)).toEqual([]);
    } finally {
      Object.assign(antigravityLockConfig, saved);
      await stopped(holder);
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("startup recovery leaves the home of a surviving agy child alone, and recovers it once the child is gone", async () => {
    const home = heavyHome();
    const { base, root } = scopeDirs();
    const child = await sleeper();
    try {
      const a = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "a", servers: murageServers });
      atomicSave(authPath(a.home), "REFRESHED-BY-SURVIVOR");
      a.adoptChild(child.pid);
      const manifest = JSON.parse(readFileSync(join(root, "a.manifest.json"), "utf8"));
      expect(manifest.child.pid).toBe(child.pid);
      expect(manifest.owner.pid).toBe(process.pid);
      restartAfterCrash(root); // the server crashed; the detached agy keeps running
      recoverAllScopedHomes(root);
      expect(existsSync(a.home)).toBe(true);
      expect(existsSync(join(root, "a.manifest.json"))).toBe(true);
      expect(readFileSync(authPath(home), "utf8")).toBe("LOGIN-TOKEN-FIXTURE");
      await stopped(child);
      recoverAllScopedHomes(root);
      expect(readFileSync(authPath(home), "utf8")).toBe("REFRESHED-BY-SURVIVOR");
      expect(readdirSync(root)).toEqual([]);
    } finally {
      await stopped(child);
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a recorded child whose pid now belongs to an unrelated process (start time differs) does not hold the home", async () => {
    const home = heavyHome();
    const { base, root } = scopeDirs();
    const stranger = await sleeper();
    try {
      const a = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "a", servers: {} });
      atomicSave(authPath(a.home), "R");
      restartAfterCrash(root);
      if (processIdentity(stranger.pid!) === null) return; // no start time available on this platform: pid reuse cannot be told apart
      setChild(root, "a", { pid: stranger.pid!, id: "not-this-process's-start-time" });
      recoverAllScopedHomes(root);
      expect(readFileSync(authPath(home), "utf8")).toBe("R");
      expect(readdirSync(root)).toEqual([]);
    } finally {
      await stopped(stranger);
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a home whose owner server is another running process is not recovered", async () => {
    const home = heavyHome();
    const { base, root } = scopeDirs();
    const otherServer = await sleeper();
    try {
      const a = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "a", servers: {} });
      atomicSave(authPath(a.home), "MID-TURN");
      restartAfterCrash(root, { pid: otherServer.pid!, id: processIdentity(otherServer.pid!) });
      recoverAllScopedHomes(root);
      expect(existsSync(a.home)).toBe(true);
      expect(readFileSync(authPath(home), "utf8")).toBe("LOGIN-TOKEN-FIXTURE");
      await stopped(otherServer);
      recoverAllScopedHomes(root);
      expect(readFileSync(authPath(home), "utf8")).toBe("MID-TURN");
    } finally {
      await stopped(otherServer);
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a scope this very process is still running is never recovered by a second driver start", () => {
    const home = heavyHome();
    const { base, root } = scopeDirs();
    try {
      const a = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "a", servers: {} });
      atomicSave(authPath(a.home), "LIVE");
      recoverAllScopedHomes(root);
      expect(existsSync(a.home)).toBe(true);
      expect(readFileSync(authPath(home), "utf8")).toBe("LOGIN-TOKEN-FIXTURE");
      a.dispose();
      expect(readFileSync(authPath(home), "utf8")).toBe("LIVE");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("legacy cleanup needs Murage's own executable, proxy folder, argv and env: every ambiguous entry stays", () => {
    const home = heavyHome();
    const path = join(home, ".gemini", "config", "mcp_config.json");
    try {
      const ownerEntries: Record<string, unknown> = {
        // the report's reproduction: arbitrary executable, a proxy file outside any server folder, extra args, an empty token
        "murage-agents": { command: "/bin/sh", args: ["/owner/agents-proxy.js", "--extra"], env: { MURAGE_COMMS_TOKEN: "" } },
        // right file names, wrong executable
        "murage-computer": { ...LEGACY_COMPUTER, command: "/usr/bin/python3" },
        // right executable, proxy outside a server folder
        "murage-custom-a": { ...LEGACY_LINK_NOTES, args: ["/owner/bin/remote-mcp-proxy.js", "--server", "a"] },
        // extra argument
        "murage-custom-b": { ...LEGACY_LINK_NOTES, args: [...LEGACY_LINK_NOTES.args.slice(0, 2), "b", "--more"] },
        // extra env name the owner added
        "murage-custom-c": { ...LEGACY_LINK_NOTES, args: [LEGACY_LINK_NOTES.args[0], "--server", "c"], env: { ...LEGACY_LINK_NOTES.env, OWNER_FLAG: "1" } },
        // empty token
        "murage-custom-d": { ...LEGACY_LINK_NOTES, args: [LEGACY_LINK_NOTES.args[0], "--server", "d"], env: { ...LEGACY_LINK_NOTES.env, MURAGE_MCP_TOKEN: "" } },
        // a relative command and proxy
        "murage-custom-e": { command: "Murage", args: ["server/drivers/remote-mcp-proxy.js", "--server", "e"], env: LEGACY_LINK_NOTES.env },
      };
      writeFileSync(path, JSON.stringify({ mcpServers: { ...ownerEntries, "murage-custom-notes": LEGACY_LINK_NOTES } }));
      const before = Object.keys(ownerEntries).sort();
      expect(removeAntigravityLegacyMcpEntries(home)).toEqual(["murage-custom-notes"]);
      expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).mcpServers).sort()).toEqual(before);
      // the exact shapes Murage wrote are still taken back (dev node and the packaged app, posix and Windows paths)
      writeFileSync(path, JSON.stringify({ mcpServers: {
        "murage-computer": { ...LEGACY_COMPUTER, command: "C:\\Program Files\\Murage\\Murage.exe", args: ["C:\\Program Files\\Murage\\resources\\server\\computer-proxy.js"] },
        "murage-agents": LEGACY_AGENTS,
      } }));
      expect(removeAntigravityLegacyMcpEntries(home).sort()).toEqual(["murage-agents", "murage-computer"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Windows without symlink rights (file ops mocked: no runner here)", () => {
  /** An ordinary Windows account: junctions work, file symlinks are refused (EPERM). */
  const windowsOps = (link: "works" | "refused"): MirrorOps => ({
    symlink: (target, path, type) => {
      if (type !== "junction") throw Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });
      symlinkSync(target, path);
    },
    link: (existing, path) => {
      if (link === "refused") throw Object.assign(new Error("EXDEV: cross-device link"), { code: "EXDEV" });
      linkSyncReal(existing, path);
    },
    copyFile: (from, to) => writeFileSync(to, readFileSync(from)),
  });

  it("copies small files, still mounts Murage's servers, and writes a refreshed login back on dispose", () => {
    const home = heavyHome();
    const { base, root } = scopeDirs();
    try {
      // a home-root file too big to copy (a locked NTUSER.DAT stand-in) is left out, not fatal
      writeFileSync(join(home, "NTUSER.DAT"), Buffer.alloc(2 * 1024 * 1024));
      const scope = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "win", servers: murageServers, platform: "win32", ops: windowsOps("refused") });
      const g = join(scope.home, ".gemini");
      expect(Object.keys(JSON.parse(readFileSync(join(g, "config", "mcp_config.json"), "utf8")).mcpServers)).toEqual(["murage-agents"]);
      const auth = join(g, "antigravity-cli", "auth.json");
      expect(lstatSync(auth).isSymbolicLink()).toBe(false);
      expect(readFileSync(auth, "utf8")).toBe("LOGIN-TOKEN-FIXTURE");
      expect(lstatSync(join(scope.home, ".ssh")).isSymbolicLink()).toBe(true); // folders are junctions
      expect(existsSync(join(scope.home, "NTUSER.DAT"))).toBe(false);
      expect(existsSync(join(g, "GEMINI.md"))).toBe(false);
      writeFileSync(auth, "REFRESHED-ON-WINDOWS"); // in place, on the copy
      scope.dispose();
      expect(readFileSync(join(home, ".gemini", "antigravity-cli", "auth.json"), "utf8")).toBe("REFRESHED-ON-WINDOWS");
      expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe("git");
      expect(existsSync(scope.home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("uses hard links when the volume allows them: an in-place write reaches the real file at once", () => {
    const home = heavyHome();
    const { base, root } = scopeDirs();
    try {
      const scope = buildAntigravityScopedHome({ realHome: home, scopeRoot: root, name: "winlink", servers: murageServers, platform: "win32", ops: windowsOps("works") });
      const auth = join(scope.home, ".gemini", "antigravity-cli", "auth.json");
      writeFileSync(auth, "REFRESHED-IN-PLACE");
      expect(readFileSync(join(home, ".gemini", "antigravity-cli", "auth.json"), "utf8")).toBe("REFRESHED-IN-PLACE");
      atomicSave(auth, "REFRESHED-BY-RENAME"); // breaks the hard link
      scope.dispose();
      expect(readFileSync(join(home, ".gemini", "antigravity-cli", "auth.json"), "utf8")).toBe("REFRESHED-BY-RENAME");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});
