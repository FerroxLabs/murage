// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { IoMeterFileId } from "./engine-exclusion.ts";
import { checkpointLedger } from "./admission-shared.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let root: string, binary: string;
const copies: string[] = [];
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "meter-native-")));
  binary = resolve("dist-native", "engine-exclusion", `${process.platform}-${process.arch}`, "engine-exclusion.node");
  if (process.platform === "linux") {
    binary = join(root, "engine-exclusion.node");
    execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
  }
  expect(existsSync(binary), "a real platform addon is required; build it before the Windows native run").toBe(true);
});
afterEach(() => { for (const dir of copies.splice(0)) removeTempDirSync(dir); });
afterAll(() => { if (root) removeTempDirSync(root); });

// A fresh process both qualifies the copy and loads it into SQLite, then exits so Windows releases the DLL before substitution.
function qualifiedCopy(): { path: string; id: IoMeterFileId } {
  const meter = pathToFileURL(resolve("server/io-meter.ts")).href;
  const script = `import {ensureIoMeter,ioMeterNativePath,ioMeterNativeId} from ${JSON.stringify(meter)};
    if (!ensureIoMeter()) throw Error("native SQLite meter did not load");
    // The process removes its own private copy at exit, so the test keeps a byte-identical file of its own for the substitution cases.
    import {copyFileSync,mkdtempSync,statSync,readFileSync} from "node:fs"; import {createHash} from "node:crypto"; import {join} from "node:path";
    const kept=join(mkdtempSync(join(process.env.KEEP_DIR,"kept-")),"engine-exclusion.node"); copyFileSync(ioMeterNativePath(),kept);
    const st=statSync(kept);
    console.log(JSON.stringify({path:kept,id:{dev:st.dev,ino:st.ino,size:st.size,sha256:createHash("sha256").update(readFileSync(kept)).digest("hex")},own:ioMeterNativePath(),ownId:ioMeterNativeId()}));`;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", MURAGE_ENGINE_EXCLUSION_PATH: binary, KEEP_DIR: root };
  for (const key of ["MURAGE_PACKAGED", "MURAGE_RESOURCES_PATH", "OMB_RESOURCES_PATH"]) delete env[key];
  const loaded = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" })) as { path: string; id: IoMeterFileId; own: string; ownId: IoMeterFileId };
  expect(loaded.ownId.sha256, "the kept file is the bytes SQLite loaded").toBe(loaded.id.sha256);
  if (process.platform !== "win32") expect(existsSync(loaded.own), "the process removed its own private copy at exit").toBe(false);
  copies.push(dirname(loaded.path));
  expect(loaded.own, "SQLite publishes the private copy after loadExtension succeeds").not.toBe(binary);
  expect(createHash("sha256").update(readFileSync(loaded.path)).digest("hex")).toBe(loaded.id.sha256);
  const st = statSync(loaded.path);
  expect([st.dev, st.ino, st.size]).toEqual([loaded.id.dev, loaded.id.ino, loaded.id.size]);
  return loaded;
}

function workerSource(): string {
  const file = ts.createSourceFile("wal-maintenance.ts", readFileSync(new URL("./wal-maintenance.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let source: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "WORKER_SOURCE" && node.initializer && ts.isNoSubstitutionTemplateLiteral(node.initializer)) source = node.initializer.text;
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(source, "run the entire production worker source, including its native loader").toBeTypeOf("string");
  return source!;
}

// Each worker's process exits before substitution, so no native-library handle can pin the copy on Windows.
function loadWorker(loaded: { path: string; id: IoMeterFileId }): string {
  const file = join(dirname(loaded.path), "worker.db");
  const script = `const { Worker } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(file)}); db.exec("CREATE TABLE IF NOT EXISTS fixture(value)"); db.close();
    const worker = new Worker(${JSON.stringify(workerSource())}, { eval: true, workerData: {
      file: ${JSON.stringify(file)}, shared: new SharedArrayBuffer(28 * 4), copied: new SharedArrayBuffer(8),
      admission: new SharedArrayBuffer(32 * 8), admissionSource: ${JSON.stringify(checkpointLedger.toString())},
      nativeMeterPath: ${JSON.stringify(loaded.path)}, nativeMeterId: ${JSON.stringify(loaded.id)}, osPageSize: 65536,
      stepBytes: 4 * 1024 * 1024, pollMs: 25, dueMs: 250, debtBytes: 8 * 1024 * 1024, debtFd: { debt: -1, index: -1 },
    } });
    worker.once("message", async message => { console.log(message.type); await worker.terminate(); });
    worker.once("error", error => console.log(error.message));`;
  return execFileSync(process.execPath, ["-e", script], { encoding: "utf8", windowsHide: true }).trim();
}

it("W-same-file-native: parent require, SQLite loadExtension and the real worker load the same private copy", async () => {
  const loaded = qualifiedCopy();
  expect(await loadWorker(loaded)).toBe("ready");
});

it.each(["bytes", "identity", "alias"] as const)("P5-native-reject: the real worker refuses a substituted private copy (%s)", async kind => {
  const loaded = qualifiedCopy();
  expect(await loadWorker(loaded), "positive control: this exact copy loads before substitution").toBe("ready");
  if (kind === "bytes") {
    const bytes = readFileSync(loaded.path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    writeFileSync(loaded.path, bytes);
  } else if (kind === "identity") {
    const old = join(dirname(loaded.path), "original.node");
    renameSync(loaded.path, old); copyFileSync(old, loaded.path);
  } else if (process.platform === "win32") {
    // Junctions need no symlink privilege; the original copy's identity is unchanged through this alias.
    const alias = join(root, "junction");
    symlinkSync(dirname(loaded.path), alias, "junction"); loaded.path = join(alias, "engine-exclusion.node");
  } else {
    const old = join(dirname(loaded.path), "original.node");
    renameSync(loaded.path, old); symlinkSync(old, loaded.path);
  }
  const why = kind === "bytes" ? "the file content changed" : kind === "identity" ? "the file identity changed" : process.platform === "win32" ? "the path is not canonical" : "not a regular file";
  expect(await loadWorker(loaded), "rejection must come from the production loader, before require").toBe(`wal-worker: native meter refused: ${why}`);
});
