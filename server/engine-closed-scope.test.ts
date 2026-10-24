// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "This home is in use" means THIS home (designs/ENGINE-CLOSED-SCOPE.md): a process that is the engine holds a home only when the
// home its engine resolves from the process's own environment is that home. A same-named process on another home (the owner's own
// Claude Code, codex or grok in a terminal) no longer keeps a deleted conversation pending; one on the same home still does, and so
// does one whose home cannot be told. Murage's own warm engine on the home is closed by the hold before the plan, and the deletion
// then completes.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { engineState, homesOfProcess } from "./engine-closed.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import { buildFixture, canaryHits, THREAD } from "./testing/engine-history-fixtures.ts";
import { proc, useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-home-scope-")));
const databases: DatabaseSync[] = [];
afterAll(() => { for (const db of databases) db.close(); removeTempDirSync(scratch); });

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); });
afterEach(() => {
  fake.restore();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

let next = 0;
const folder = (name: string): string => { const path = join(scratch, `${name}-${next++}`); mkdirSync(path, { recursive: true }); return path; };
/** An engine process with its own environment (null: one that cannot be read). */
function running(exe: string, environment: Record<string, string> | null, argv: string[] = [exe]): () => void {
  const item = proc(exe, argv, 5000 + next++);
  fake.processes.push(item);
  if (environment) fake.environments.set(item.pid, environment);
  return () => { fake.processes.splice(fake.processes.indexOf(item), 1); fake.environments.delete(item.pid); };
}

describe("(1) a same-named process on a different home does not block", () => {
  it("claude: the owner's Claude Code on ~/.claude does not hold a named account's folder", () => {
    const user = folder("user"), account = folder("account");
    running("/Users/x/.local/share/claude/versions/2.1.308", { HOME: user });
    running("/usr/bin/ugrep", { HOME: user }, ["claude", "-r", "x"]); // Claude Code's own tool children carry its environment
    expect(engineState("claude", account).state).toBe("closed");
  });

  it("claude: Murage's own helper on a temporary CLAUDE_CONFIG_DIR does not hold the instance's home", () => {
    const user = folder("user");
    running("/usr/local/bin/claude", { HOME: user, CLAUDE_CONFIG_DIR: folder("temp-home") });
    expect(engineState("claude", join(user, ".claude")).state).toBe("closed");
  });

  it("codex: a terminal codex on ~/.codex does not hold another CODEX_HOME", () => {
    const user = folder("user");
    running("/opt/homebrew/bin/codex", { HOME: user });
    expect(engineState("codex", folder("codex-scope")).state).toBe("closed");
  });

  it("fuigo: a `grok -p` review run (its home is ~/.grok) does not hold ~/.fuigo", () => {
    const user = folder("user");
    running("/Users/x/.grok/bin/grok", { HOME: user }, ["grok", "-p", "review"]);
    expect(engineState("fuigo", join(user, ".fuigo")).state).toBe("closed");
  });

  it("grok: a fuigo process does not hold ~/.grok", () => {
    const user = folder("user");
    running("/usr/local/bin/fuigo", { HOME: user });
    expect(engineState("grok", join(user, ".grok")).state).toBe("closed");
  });
});

describe("(2) a process on the same home still blocks", () => {
  it("claude: the default <HOME>/.claude, CLAUDE_CONFIG_DIR, a link to the home, and a parent of it all hold it", () => {
    const user = folder("user");
    const home = join(user, ".claude");
    mkdirSync(home);
    let stop = running("/usr/local/bin/claude", { HOME: user });
    expect(engineState("claude", home).state).toBe("open");
    stop();
    stop = running("/usr/local/bin/claude", { HOME: folder("other"), CLAUDE_CONFIG_DIR: home });
    expect(engineState("claude", home).state).toBe("open");
    stop();
    const link = join(folder("links"), "claude-link");
    symlinkSync(home, link);
    stop = running("/usr/local/bin/claude", { HOME: folder("other"), CLAUDE_CONFIG_DIR: link });
    expect(engineState("claude", home).state).toBe("open");
    stop();
    stop = running("/usr/local/bin/claude", { HOME: folder("other"), CLAUDE_CONFIG_DIR: user });
    expect(engineState("claude", home).state).toBe("open");
    stop();
    expect(engineState("claude", home).state).toBe("closed");
  });

  it("codex: CODEX_HOME on the home, and a CODEX_SQLITE_HOME on the folder of a database the plan changes", () => {
    const home = folder("codex");
    let stop = running("/usr/local/bin/codex", { HOME: folder("u"), CODEX_HOME: home });
    expect(engineState("codex", home).state).toBe("open");
    stop();
    const sqlite = folder("codex-sqlite");
    stop = running("/usr/local/bin/codex", { HOME: folder("u"), CODEX_HOME: folder("elsewhere"), CODEX_SQLITE_HOME: sqlite });
    expect(engineState("codex", home).state).toBe("closed");
    expect(engineState("codex", home, { dbs: [join(sqlite, "state_5.sqlite")] }).state).toBe("open");
    stop();
  });

  it("fuigo and grok: a process named grok on ~/.grok holds the grok home; FUIGO_HOME set on any of them holds that home", () => {
    const user = folder("user");
    let stop = running("/usr/local/bin/grok", { HOME: user });
    expect(engineState("grok", join(user, ".grok")).state).toBe("open");
    stop();
    const fuigo = folder("fuigo-home");
    stop = running("/usr/local/bin/grok", { HOME: user, FUIGO_HOME: fuigo });
    expect(engineState("fuigo", fuigo).state).toBe("open");
    stop();
  });

  it("fails closed: an environment that cannot be read, no user home, a relative path, a desktop app, an engine outside the rule", () => {
    const home = folder("claude");
    const cases: Array<[string, Record<string, string> | null, string?]> = [
      ["/usr/local/bin/claude", null],
      ["/usr/local/bin/claude", { PATH: "/usr/bin" }],
      ["/usr/local/bin/claude", { HOME: folder("u"), CLAUDE_CONFIG_DIR: "relative/claude" }],
      ["/Applications/Claude.app/Contents/MacOS/Claude", { HOME: folder("u") }],
    ];
    for (const [exe, environment] of cases) {
      const stop = running(exe, environment);
      expect(engineState("claude", home).state, `${exe} ${JSON.stringify(environment)}`).toBe("open");
      stop();
    }
    const kimi = folder("kimi");
    const stop = running("/usr/local/bin/kimi", { HOME: folder("u"), KIMI_CODE_HOME: folder("other-kimi") });
    expect(engineState("kimi", kimi).state).toBe("open"); // not one of the engines whose home is told from the environment
    stop();
  });

  it("an older addon without environment() keeps the machine-wide gate", () => {
    const stop = running("/usr/local/bin/claude", { HOME: folder("u") });
    const own = fake.environments;
    fake.environments = new Map(); // nothing readable: what an addon without the call answers
    expect(engineState("claude", folder("account")).state).toBe("open");
    fake.environments = own;
    stop();
  });

  it("homesOfProcess resolves as engineHomeFor does", () => {
    expect(homesOfProcess("claude", { HOME: "/h" }, [], false)).toEqual(["/h/.claude"]);
    expect(homesOfProcess("codex", { HOME: "/h", CODEX_SQLITE_HOME: "/s" }, [], false)).toEqual(["/h/.codex", "/s"]);
    expect(homesOfProcess("fuigo", { HOME: "/h" }, ["grok"], false)).toEqual(["/h/.grok"]);
    expect(homesOfProcess("fuigo", { HOME: "/h" }, ["grok"], true)).toEqual(["/h/.grok", "/h/.fuigo"]);
    expect(homesOfProcess("fuigo", { HOME: "/h" }, ["node"], false)).toEqual(["/h/.fuigo", "/h/.grok"]);
    expect(homesOfProcess("claude", {}, [], false)).toBeNull();
    expect(homesOfProcess("hermes", { HOME: "/h" }, [], false)).toBeNull();
  });
});

// ── (3) the whole deletion ──────────────────────────────────────────────────────────────────────────────────────────

class InlineWorker extends EventEmitter {
  threadId = 7;
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.emit("message", { type: "result", result: runEngineHistoryJob(message) })); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}

describe("(3) a warm Murage engine process on the home is released and the deletion completes", () => {
  it("the hold closes the warm claude child; the owner's Claude Code on another home stays running and does not block", async () => {
    const fx = buildFixture("claude", scratch);
    const home = fx.homes[0]!.home;
    // Murage's warm engine for this instance: Murage gives it CLAUDE_CONFIG_DIR (claude-accounts.ts)
    const warm = running("/usr/local/bin/claude", { HOME: folder("u"), CLAUDE_CONFIG_DIR: home }, ["claude", "--input-format", "stream-json"]);
    fake.processes.at(-1)!.ppid = process.pid; // Murage started it (lane 106: a program Murage did not start is left alone before the hold)
    // the owner's own Claude Code in a terminal, on a different home, for the whole deletion
    running("/Users/x/.local/share/claude/versions/2.1.308", { HOME: folder("owner") });
    expect(engineState("claude", home).state).toBe("open"); // the warm child holds it until the hold closes it
    const events: string[] = [];
    let warmAlive = true;
    engineHistoryTestHooks.createWorker = () => new InlineWorker() as unknown as Worker;
    const data = join(fx.root, "data");
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, "messages.db"));
    databases.push(db);
    const deletions = new ConversationDeletions({
      dataDir: data, database: () => db, retryDelaysMs: [],
      // what registry.holdInstances does through the adapter's holdIdle: the idle warm process is closed and has exited
      holdHomes: async (homes) => { events.push(`hold ${homes.length}`); if (warmAlive) { warm(); warmAlive = false; } return { release: () => events.push("release"), skipped: [] }; },
    });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(report.failed).toEqual([]);
    expect(events[0]).toBe("hold 1");
    expect(warmAlive).toBe(false);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(deletions.pending()).toEqual([]);
    expect(fake.processes.length).toBe(1); // the owner's session was never touched
  });
});
