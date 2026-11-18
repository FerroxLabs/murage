// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

type Snapshot = { names: string[]; bytes: string; groups: string; existing: unknown; messages: number; leftovers: string[] };
const fixture = fileURLToPath(new URL("./testing/store-create-crash-fixture.ts", import.meta.url));
const uncommitted = ["journal:open", "journal:write", "journal:fsync", "journal:close", "journal:rename", "journal:dirsync", "sqlite:marker-schema", "sqlite:marker",
  "roster:open", "roster:write", "roster:fsync", "roster:close", "roster:rename", "roster:dirsync", "second-roster:rename", "sqlite:before-commit",
  "groups:open", "groups:write", "groups:fsync", "groups:close", "groups:rename", "groups:dirsync",
  "rollback:groups:open", "rollback:groups:write", "rollback:groups:fsync", "rollback:groups:close", "rollback:groups:rename", "rollback:groups:dirsync",
  "rollback:roster:open", "rollback:roster:write", "rollback:roster:fsync", "rollback:roster:close", "rollback:roster:rename", "rollback:roster:dirsync", "rollback:journal:cleanup"];
// Windows has no directory fsync, so directory-sync write boundaries do not exist there.
const recovery = ["roster", "groups"].flatMap(file => ["open", "write", "fsync", "close", "rename", "dirsync"].map(step => `recovery:${file}:${step}`)).concat("recovery:journal:cleanup");
const checkpoints = [...uncommitted, ...recovery, "sqlite:after-commit", "journal:cleanup", "checkpoint:cleanup"].filter(stage => process.platform !== "win32" || !stage.endsWith(":dirsync"));
for (const stage of checkpoints) {
  it(`SIGKILL at ${stage} recovers the exact prior state or the whole committed create`, () => {
    const home = mkdtempSync(join(tmpdir(), "murage-create-crash-")), data = join(home, "data"); mkdirSync(data);
    const run = (mode: string, point = stage) => spawnSync(process.execPath, ["--experimental-strip-types", fixture, mode, point], {
      env: { ...process.env, HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data }, encoding: "utf8", timeout: 30_000,
    });
    const snapshot = (mode: string): Snapshot => {
      const result = run(mode);
      expect(result.status, result.stderr).toBe(0);
      const line = result.stdout.split("\n").find(row => row.startsWith("CREATE_SNAPSHOT "));
      expect(line, result.stdout).toBeDefined();
      return JSON.parse(line!.slice("CREATE_SNAPSHOT ".length));
    };
    try {
      const before = snapshot("setup");
      if (stage.startsWith("recovery:")) {
        const initial = run("crash", "sqlite:before-commit");
        expect(initial.stdout).toContain("CREATE_CRASH sqlite:before-commit\n");
        expect(initial.signal ?? (process.platform === "win32" && initial.status === 1 ? "SIGKILL" : null), initial.stderr).toBe("SIGKILL");
      }
      const crash = run(stage.startsWith("recovery:") ? "recover-crash" : "crash");
      expect(crash.stdout).toContain(`CREATE_CRASH ${stage}\n`);
      // Windows reports a self SIGKILL as exit 1, as in settle-copy-crash.test.ts.
      const signal = crash.signal ?? (process.platform === "win32" && crash.status === 1 ? "SIGKILL" : null);
      expect(signal, crash.stderr).toBe("SIGKILL");
      const after = snapshot("inspect");
      if (uncommitted.includes(stage) || recovery.includes(stage)) expect(after).toEqual(before);
      else {
        expect(after.names).toEqual(["Second new", "First new", "Existing"]);
        expect(JSON.parse(Buffer.from(after.groups, "base64").toString())).toMatchObject([{ name: "Changed room" }]);
        expect(after.existing).toEqual(before.existing);
        expect(after.messages).toBe(before.messages + 4);
        expect(after.leftovers).toEqual([]);
      }
      expect(snapshot("inspect")).toEqual(after);
    } finally { removeTempDirSync(home); }
  });
}

for (const stage of ["receipt:append", "sqlite:before-commit", "sqlite:after-commit", ...["open", "write", "fsync", "close", "append"].map(step => `recovery:receipt:${step}`)]) {
  it(`real event receipt at ${stage} recovers with its bot or refunds the unused admission`, () => {
    const home = mkdtempSync(join(tmpdir(), "murage-receipt-crash-")), data = join(home, "data"); mkdirSync(data);
    const run = (mode: string, point = stage) => spawnSync(process.execPath, ["--experimental-strip-types", fixture, mode, point], {
      env: { ...process.env, HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data }, encoding: "utf8", timeout: 30_000,
    });
    const snapshot = (mode: string) => {
      const result = run(mode);
      expect(result.status, result.stderr).toBe(0);
      const line = result.stdout.split("\n").find(row => row.startsWith("RECEIPT_SNAPSHOT "));
      expect(line, result.stdout).toBeDefined();
      return JSON.parse(line!.slice("RECEIPT_SNAPSHOT ".length));
    };
    try {
      const before = snapshot("receipt-setup");
      if (stage.startsWith("recovery:")) {
        const initial = run("receipt-crash", "sqlite:before-commit");
        expect(initial.stdout).toContain("CREATE_CRASH sqlite:before-commit\n");
        expect(initial.signal ?? (process.platform === "win32" && initial.status === 1 ? "SIGKILL" : null), initial.stderr).toBe("SIGKILL");
      }
      const crash = run(stage.startsWith("recovery:") ? "receipt-recover-crash" : "receipt-crash");
      expect(crash.stdout).toContain(`CREATE_CRASH ${stage}\n`);
      expect(crash.stdout).not.toContain("CREATE_PUBLICATION");
      expect(crash.signal ?? (process.platform === "win32" && crash.status === 1 ? "SIGKILL" : null), crash.stderr).toBe("SIGKILL");
      const after = snapshot("receipt-inspect");
      if (stage !== "sqlite:after-commit") expect(after).toEqual(before);
      else {
        expect(after.names).toEqual(["Reviewed", "Existing"]);
        const bot = JSON.parse(Buffer.from(after.bytes, "base64").toString()).find((bot: { name: string }) => bot.name === "Reviewed");
        expect(after.admission).toBe(true); expect(after.receipt).toBe(`bot:${bot.id}`);
        expect(after.messages).toBe(before.messages + 1); expect(after.leftovers).toEqual([]);
      }
      expect(snapshot("receipt-inspect")).toEqual(after);
    } finally { removeTempDirSync(home); }
  });
}
