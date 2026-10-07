// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 L0a: the data-folder inventory guard fails an unclassified write.
// data-dir-inventory.test.ts and data-dir-inventory-api.test.ts pass when
// every name is classified; this proves each of their nets actually turns
// red when a writer creates a name no backup knows, so a green run means
// something. The writers here are synthetic fixtures in a throwaway folder.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dataDirWriteRecorder, scanDataDirWrites, unclassifiedDataDirNames, unclassifiedStaticWrites } from "./testing/data-dir-guard.ts";

const scratch = mkdtempSync(join(tmpdir(), "murage-inventory-guard-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the data-folder inventory guard", () => {
  it("static net: a source file writing an unclassified name under the data folder fails", () => {
    const writer = join(scratch, "writer.ts");
    writeFileSync(writer, [
      'import { join } from "node:path";',
      'import { DATA_DIR } from "./config.ts";',
      'const PAIRED = "paired-clients.json";',
      'export const a = join(DATA_DIR, "unclassified-probe.json");',
      'export const b = join(DATA_DIR, PAIRED);',
      'export function c(dataDir = DATA_DIR) { return join(dataDir, "probe-folder", "inner.json"); }',
      'export const d = join(DATA_DIR, "bots.json");',
    ].join("\n"));
    const found = unclassifiedStaticWrites(scanDataDirWrites([writer]));
    expect(found.map(line => line.split(": ").at(-1))).toEqual(["unclassified-probe.json", "paired-clients.json", "probe-folder"]);
  });

  it("runtime net: a process creating an unclassified name under MURAGE_DATA_DIR is recorded and fails", () => {
    const data = join(scratch, "data");
    mkdirSync(data);
    const log = join(scratch, "created.txt");
    const preload = join(scratch, "recorder.mjs");
    writeFileSync(preload, dataDirWriteRecorder(log));
    const writes = [
      "const fs = await import('node:fs');",
      "const { join } = await import('node:path');",
      "const dir = process.env.MURAGE_DATA_DIR;",
      "fs.writeFileSync(join(dir, 'bots.json'), '{}');",
      // written and renamed away: gone from the folder, still recorded
      "fs.writeFileSync(join(dir, 'probe.tmp-write'), 'x');",
      "fs.renameSync(join(dir, 'probe.tmp-write'), join(dir, 'config.json'));",
      "fs.mkdirSync(join(dir, 'browser-probe', 'client-configs'), { recursive: true });",
      // a Buffer path and a file: URL are writes too (audit round 1, Astra M8)
      "fs.writeFileSync(Buffer.from(join(dir, 'buffer-probe')), 'x');",
      "fs.writeFileSync((await import('node:url')).pathToFileURL(join(dir, 'url probe')), 'x');",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", writes], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: scratch, MURAGE_DATA_DIR: data },
    });
    expect(result.status, result.stderr).toBe(0);
    const created = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(created).toEqual(expect.arrayContaining(["bots.json", "probe.tmp-write", "config.json", "browser-probe", "buffer-probe", "url probe"]));
    expect(unclassifiedDataDirNames(created).sort()).toEqual(["browser-probe", "buffer-probe", "probe.tmp-write", "url probe"]);
  });
});
