// SPDX-License-Identifier: AGPL-3.0-or-later
// A conversation lives in a bot's tasks AND in a channel, room or direct message. The used-workspace guards read all of them,
// and a Cloud host restore leaves a provenance marker so even a seed-only snapshot never gets the welcome.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { homeServerEnvironment } from "./cloud-home/boot.ts";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { emptySetupState, setupIsFirstRun, type SetupLiveState } from "../shared/setup.ts";
import { initializeInbox } from "./inbox.ts";
import { RESTORE_PROVENANCE_FILE, hasRestoreProvenance } from "./restore-provenance.ts";
import { readWorkspace, type SetupBotReading } from "./setup.ts";
import { SetupThreadFactsCache } from "./setup-thread-facts.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const databases: DatabaseSync[] = [];
const roots: string[] = [];
afterAll(() => { for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } } roots.splice(0).forEach(root => removeTempDirSync(root)); });

function database() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  initializeInbox(db);
  const put = (thread: string, id: string, role: "user" | "bot", text: string) =>
    db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(thread, id, 1, role, "text", text, JSON.stringify({ id, at: 1, role, kind: "text", text }));
  return { db, put };
}
const chief: SetupBotReading = { id: "chief", threadId: "chief-thread", modelSelection: { instanceId: "fuigo", model: "flux-auto" } };
const live = (reading: ReturnType<typeof readWorkspace>): SetupLiveState => ({
  ownerName: "", agents: [], signedOutAgents: [], flux: { configured: false, conflict: false, looksValid: false }, bundledEngine: { ready: true } as never,
  connectedApps: 0, connectedAppIds: [], routines: { total: 0, briefId: null, briefRan: false }, ...reading,
});
const read = (db: DatabaseSync, channels?: Array<{ threadId: string; tasks?: Array<{ threadId: string }> }>) => {
  const cache = new SetupThreadFactsCache(db);
  return readWorkspace({ bots: [chief], ...(channels ? { channels } : {}), threadFacts: id => cache.facts(id), routesThroughFlux: () => true }, "chief");
};

describe("the used-workspace guards read every place a conversation lives", () => {
  it("an untouched Chief plus a channel holding owner messages is not a first run", () => {
    const { db, put } = database();
    put("chief-thread", "g1", "bot", "Hello, I am your Chief");
    put("channel-thread", "c1", "user", "plan the week");
    const reading = read(db, [{ threadId: "channel-thread" }]);
    expect(reading.ownerMessageExists).toBe(true);
    expect(reading.otherThreadHasMessages).toBe(true);
    expect(setupIsFirstRun(emptySetupState(0), live(reading))).toBe(false);
  });

  it("a channel task thread and a direct message count too", () => {
    const { db, put } = database();
    put("chief-thread", "g1", "bot", "Hello");
    put("room-task-2", "c1", "user", "hi");
    expect(read(db, [{ threadId: "room-main", tasks: [{ threadId: "room-main" }, { threadId: "room-task-2" }] }]).ownerMessageExists).toBe(true);
    const dm = database();
    dm.put("chief-thread", "g1", "bot", "Hello");
    dm.put("dm-thread", "d1", "bot", "bot to bot");
    const reading = read(dm.db, [{ threadId: "dm-thread" }]);
    expect(reading.otherThreadHasMessages).toBe(true);
    expect(reading.ownerMessageExists).toBe(false);
  });

  it("a fresh workspace, with or without empty channels, is still a first run", () => {
    const { db, put } = database();
    put("chief-thread", "g1", "bot", "Hello, I am your Chief");
    expect(setupIsFirstRun(emptySetupState(0), live(read(db))) ).toBe(true);
    expect(setupIsFirstRun(emptySetupState(0), live(read(db, [{ threadId: "empty-channel" }])))).toBe(true);
  });
});

describe("a restore leaves a provenance marker", () => {
  it("the marker the host restore writes reads as a restored install; a fresh data folder does not", () => {
    const fresh = mkdtempSync(join(tmpdir(), "restore-prov-")); roots.push(fresh);
    expect(hasRestoreProvenance(fresh)).toBe(false);
    expect(RESTORE_PROVENANCE_FILE).toBe("restore-provenance.json");
    const restored = mkdtempSync(join(tmpdir(), "restore-prov-")); roots.push(restored);
    mkdirSync(restored, { recursive: true });
    writeFileSync(join(restored, RESTORE_PROVENANCE_FILE), "{}");
    expect(hasRestoreProvenance(restored)).toBe(true);
    // and a restored install is never a first run, whatever it holds
    const { db, put } = database();
    put("chief-thread", "g1", "bot", "Hello");
    expect(setupIsFirstRun(emptySetupState(0), { ...live(read(db)), restoredInstall: hasRestoreProvenance(restored) })).toBe(false);
    expect(setupIsFirstRun(emptySetupState(0), { ...live(read(db)), restoredInstall: hasRestoreProvenance(fresh) })).toBe(true);
  });
});

describe("the host restore and the install agree on where the marker lives", () => {
  const python = spawnSync("python3", ["--version"]).status === 0;
  it.skipIf(!python)("a seed-only restore written by the real restore function reads as a restored install on the production layout", () => {
    const scratch = mkdtempSync(join(tmpdir(), "restore-layout-")); roots.push(scratch);
    const script = [
      "import importlib.machinery, importlib.util, os, shutil, sys",
      "src, root = sys.argv[1], sys.argv[2]",
      "loader = importlib.machinery.SourceFileLoader('mc', src)",
      "mc = importlib.util.module_from_spec(importlib.util.spec_from_loader('mc', loader)); loader.exec_module(mc)",
      "data = os.path.join(root, 'data'); os.makedirs(data)",
      "ctx = {'paths': {'data': data}, 'binding': {}}",
      "def fake_restic(c, cfg, args):",
      "    target = args[args.index('--target') + 1]",
      "    os.makedirs(os.path.join(target, data.lstrip('/'), 'home'))",
      "    return 0, ''",
      "mc.restic = fake_restic",
      "mc.work_dir = lambda c, r, o: os.path.join(root, 'work')",
      "mc.carry_auth_state = lambda *a, **k: None",
      "mc.carry_preflight = lambda *a, **k: None",
      "mc.swap_in = lambda c, work, restored, r, o: shutil.copytree(restored, os.path.join(root, 'live'))",
      "mc.restore_into_place(ctx, {}, 'snap1', 'reset1', 'reset')",
    ].join("\n");
    const run = spawnSync("python3", ["-I", "-c", script, join(import.meta.dirname, "..", "deploy", "cloud-home", "murage-commands"), scratch], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    // The server reads MURAGE_DATA_DIR from the boot contract; the live data disk is /data, mounted at <scratch>/live here.
    const env = homeServerEnvironment({ machineId: "m1", adminUrl: "https://a.example", publicOrigin: "https://p.example", bootstrapSecret: "s" }, "UTC");
    const serverDataDir = join(scratch, "live", posix.relative("/data", String(env.MURAGE_DATA_DIR)));
    expect(hasRestoreProvenance(serverDataDir)).toBe(true);
    const { db, put } = database();
    put("chief-thread", "g1", "bot", "Hello, I am your Chief");
    expect(setupIsFirstRun(emptySetupState(0), { ...live(read(db)), restoredInstall: hasRestoreProvenance(serverDataDir) })).toBe(false);
    // and the marker is not at the disk root, where the old code put it
    expect(hasRestoreProvenance(join(scratch, "live"))).toBe(false);
  });
});
