// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Synced homes (Astra r28c, r29c). A home in a folder a sync client mirrors is told at PLANNING time, by markers (only to decide whether the owner is told); every install rewrites Kimi's index
// in place: no aside and no private working name is ever made there. A local folder that is only NAMED like a sync folder is not
// synced and is deleted as always. An aside an earlier build stranded in a synced home heals by the ordinary rejoin. The owner is told
// once, after the deletion, that the cloud provider may still hold older copies.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConversationDeletions, runConversationDeletion, syncedHomeText } from "./conversation-deletion.ts";
import { planEngineHistory, removeEngineHistoryFiles } from "./engine-history-run.ts";
import { mutOps } from "./engine-fs.ts";
import { homeKey } from "./engine-plan-core.ts";
import { useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture, canaryHits, THREAD, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-synced-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });
let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); });
afterEach(() => { fake.restore(); });

const dump = (value: unknown) => `${JSON.stringify(value)}\n`;
const key = (fx: Fixture) => homeKey(fx.homes[0]!.engine, fx.homes[0]!.home);
const indexOf = (fx: Fixture) => join(fx.homes[0]!.home, "session_index.jsonl");
/** Every private working name under a tree. */
function privateNames(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (/\.murage-(deleting|rejoining)$/.test(entry.name)) found.push(join(dir, entry.name));
      if (entry.isDirectory()) walk(join(dir, entry.name));
    }
  };
  walk(root);
  return found;
}
/** A Kimi fixture whose home sits under a folder that carries the Google Drive mirror markers (a custom path, no fixed name). */
function mirrored(): Fixture {
  const fx = buildFixture("kimi", scratch);
  const marker = join(dirname(fx.homes[0]!.home), ".tmp.driveupload");
  mkdirSync(marker, { recursive: true });
  return fx;
}
/** A Kimi fixture under a local folder only NAMED like a sync folder, with no marker anywhere. */
function namedOnly(): Fixture {
  const base = join(scratch, `Dropbox-archive-${Math.random().toString(36).slice(2)}`);
  mkdirSync(base, { recursive: true });
  return buildFixture("kimi", base);
}

describe("a custom-path Google Drive mirror is synced, and never gets a private name", () => {
  it("is classified at planning time and the index is planned in place", () => {
    const fx = mirrored();
    const planned = planEngineHistory({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" });
    expect(planned.syncedHomes).toEqual([key(fx)]);
    const rewrite = planned.plans![key(fx)]!.steps.find((step) => step.k === "rewrite");
    expect(rewrite && "how" in rewrite ? rewrite.how : undefined).toBe("inplace");
  });

  it("the deletion removes the conversation, keeps the others, and makes no aside and no private name", () => {
    const fx = mirrored();
    const out = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(out.failedHomes).toEqual([]);
    expect(out.syncedHomes).toEqual([key(fx)]);
    expect(privateNames(fx.root)).toEqual([]);
    // the index is never moved to a private name (the folders and files being removed are set aside and deleted as always)
    expect(fake.calls.filter((call) => call.startsWith("renameNoReplace") && call.includes("session_index"))).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(readFileSync(indexOf(fx), "utf8")).toContain("bystander-kimi-9917");
  });
});

describe("a local folder only named like a sync folder is not synced", () => {
  it("is deleted as always, with nothing stranded and no owner line", () => {
    const fx = namedOnly();
    expect(fx.homes[0]!.home).toContain("Dropbox-archive");
    const planned = planEngineHistory({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" });
    expect(planned.syncedHomes).toEqual([]);
    const rewrite = planned.plans![key(fx)]!.steps.find((step) => step.k === "rewrite");
    expect(rewrite && "how" in rewrite ? rewrite.how : undefined).toBe("inplace");
    const out = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(out.failedHomes).toEqual([]);
    expect(out.syncedHomes).toEqual([]);
    expect(privateNames(fx.root)).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });
});

describe("a home the markers cannot tell is still never given a private name (r29c)", () => {
  function plannedHow(fx: Fixture): string | undefined {
    const planned = planEngineHistory({ homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions, kind: "plan" });
    const rewrite = planned.plans![key(fx)]!.steps.find((step) => step.k === "rewrite");
    return rewrite && "how" in rewrite ? rewrite.how : undefined;
  }

  it("an iCloud Desktop and Documents home (its real path is plain Documents, no marker) is planned in place and deleted with no private name", () => {
    const base = join(scratch, `Users-${Math.random().toString(36).slice(2)}`, "Documents");
    mkdirSync(base, { recursive: true });
    const fx = buildFixture("kimi", base);
    expect(plannedHow(fx)).toBe("inplace");
    const out = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(out.failedHomes).toEqual([]);
    expect(privateNames(fx.root)).toEqual([]);
    expect(fake.calls.filter((call) => call.startsWith("renameNoReplace") && call.includes("session_index"))).toEqual([]);
    expect(readFileSync(indexOf(fx), "utf8")).toContain("bystander-kimi-9917");
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  it("a classic Dropbox root with .dropbox and .dropbox.cache but no info.json is planned in place and deleted with no private name", () => {
    const base = join(scratch, `Dropbox-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(base, ".dropbox"), { recursive: true });
    mkdirSync(join(base, ".dropbox.cache"), { recursive: true });
    const fx = buildFixture("kimi", base);
    expect(plannedHow(fx)).toBe("inplace");
    const out = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(out.failedHomes).toEqual([]);
    expect(privateNames(fx.root)).toEqual([]);
    expect(readFileSync(indexOf(fx), "utf8")).toContain("bystander-kimi-9917");
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  it("when Kimi puts the title back after the in-place clear, the home stays pending and a later attempt clears it", () => {
    const fx = buildFixture("kimi", scratch);
    const index = indexOf(fx);
    const original = readFileSync(index, "utf8");
    const real = mutOps.fsync;
    let restored = false;
    // Kimi starting inside the hold writes its old rows back (the accepted twin of Codex's R4)
    mutOps.fsync = ((fd: never) => { real(fd); if (!restored) { restored = true; writeFileSync(index, original); } }) as typeof mutOps.fsync;
    let first: ReturnType<typeof removeEngineHistoryFiles>;
    try { first = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions); } finally { mutOps.fsync = real; }
    expect(restored).toBe(true);
    // either a further round already cleared it, or the home is reported pending: never reported done with the title still there
    if (!first.failedHomes?.length) expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    const next = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions, first.discovery, true);
    expect(next.failedHomes).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(readFileSync(index, "utf8")).toContain("bystander-kimi-9917");
  });
});

describe("an aside an earlier build stranded in a synced home heals by the ordinary rejoin", () => {
  it("the older rows come back under the name with the engine's newer rows after them", () => {
    const fx = mirrored();
    const index = indexOf(fx);
    const away = `${index}.murage-deleting`;
    writeFileSync(away, readFileSync(index));
    const newer = [dump({ sessionId: "s3", workDir: "/third", title: "NEWER-ROW-ONE" })];
    writeFileSync(index, newer.join(""));
    const out = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
    expect(out.failedHomes).toEqual([]);
    expect(privateNames(fx.root)).toEqual([]);
    expect(existsSync(index)).toBe(true);
    const text = readFileSync(index, "utf8");
    expect(text).toContain("NEWER-ROW-ONE");
    expect(text).toContain("bystander-kimi-9917");
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });
});

describe("the owner is told once, in the deletion result, only for a synced home", () => {
  async function deleted(fx: Fixture) {
    const data = join(fx.root, "data");
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    const notices = deletions.notices().map((item) => item.text);
    deletions.dispose();
    return notices;
  }

  it("a synced home", async () => {
    const notices = await deleted(mirrored());
    expect(notices).toEqual([syncedHomeText("Kimi")]);
    expect(notices[0]).toBe("This conversation is removed from Kimi. Kimi keeps its files in a synced folder, so your cloud provider may still hold older copies in its version history.");
  });

  it("a home that is not synced", async () => {
    expect(await deleted(namedOnly())).toEqual([]);
  });
});
