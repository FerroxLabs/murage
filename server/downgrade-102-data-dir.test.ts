// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Prepare to reinstall" (memory-downgrade --to 10) must leave a data folder 1.0.2's backup can take. 1.0.2's backup refuses any top-level
// name it does not classify (BACKUP_UNCLASSIFIED_COMPONENT), and a 1.0.3 desktop writes a few new derived notes at the root
// (DATA_DIR_NAMES_AFTER_102: the memory repairs note, the model catch-up marker, the kept login-shell environment env/ and others). The
// downgrade removes exactly those; the names 1.0.2 classifies are frozen in testing/data-dir-1.0.2-names.json (from afbf549ba).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { classifyDataDirEntry, DATA_DIR_ENTRIES, DATA_DIR_PATTERNS } from "./data-dir-inventory.ts";
import { DATA_DIR_NAMES_AFTER_102, downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const known102 = new Set((JSON.parse(readFileSync(join(import.meta.dirname, "testing", "data-dir-1.0.2-names.json"), "utf8")) as { names: string[] }).names);
/** Whether 1.0.2's backup classifies this top-level name (its patterns are 1.0.3's, unchanged). */
const classifiedBy102 = (name: string) => known102.has(name) || DATA_DIR_PATTERNS.some(item => item.pattern.test(name));
/** 1.0.3 names only a Cloud home writes (server/cloud-home/, the cloud browser and timezone): a Cloud home never reinstalls desktop 1.0.2. */
const CLOUD_ONLY = [".murage-health", ".murage-home-machine", "cloud-browser-profile-usage.json", "owner.json", "proxy", "secrets", "server-home"];

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeDatabase(); });

describe("1.0.3 data-folder names after memory-downgrade --to 10", () => {
  it("the kept login-shell environment folder (env/) is classified: 1.0.3's own backup takes the folder and leaves it out", () => {
    expect(classifyDataDirEntry("env")).toMatchObject({ backup: "excluded" });
  });

  it("every 1.0.3 name 1.0.2 does not know is removed by the downgrade or written only by a Cloud home", () => {
    const newer = Object.keys(DATA_DIR_ENTRIES).filter(name => !classifiedBy102(name)).sort();
    expect(newer).toEqual([...DATA_DIR_NAMES_AFTER_102, ...CLOUD_ONLY].sort());
    for (const name of DATA_DIR_NAMES_AFTER_102) expect(DATA_DIR_ENTRIES[name]?.backup, name).toBe("excluded");
  });

  it("removes the 1.0.3 notes and env/, keeps the owner's files, and leaves only names 1.0.2's backup classifies", () => {
    database();
    closeDatabase();
    writeFileSync(join(DATA_DIR, "about-me.md"), "owner words");
    writeFileSync(join(DATA_DIR, "memory-repairs.json"), JSON.stringify({ keepallUnwedge103: "x" }));
    writeFileSync(join(DATA_DIR, "memory-model-adopted.json"), "{}");
    writeFileSync(join(DATA_DIR, "memory-model-adopted.json.tmp"), "{}");
    writeFileSync(join(DATA_DIR, "learning-paused-left.json"), "{}");
    writeFileSync(join(DATA_DIR, "pending-grants.json"), "{}");
    writeFileSync(join(DATA_DIR, "setup-backup.json"), "{}");
    mkdirSync(join(DATA_DIR, "env"), { recursive: true });
    writeFileSync(join(DATA_DIR, "env", "owner-env.0123456789abcdef"), "PATH=/bin\0HOME=/h\0");
    expect(readdirSync(DATA_DIR).filter(name => !classifiedBy102(name)).sort()).toEqual([...DATA_DIR_NAMES_AFTER_102].sort());

    expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ status: "downgraded", to: 10 });

    expect(readdirSync(DATA_DIR).filter(name => !classifiedBy102(name))).toEqual([]);
    expect(readFileSync(join(DATA_DIR, "about-me.md"), "utf8")).toBe("owner words");
    expect(existsSync(join(DATA_DIR, "messages.db"))).toBe(true);
    // a second run (already v10) finds nothing more to remove and still succeeds
    expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ to: 10 });
  });
});
