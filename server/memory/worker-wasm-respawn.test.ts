// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How long the first search takes after the WebAssembly helper has exited for being idle: a new process, the model
// loaded and verified, then one meaning search (the whole respawn path, real model, WebAssembly forced the way the
// packaged smoke test forces it). Runs only where the pinned model is prepared and RESPAWN_BENCH is set
// (the hz-test lane): RESPAWN_BENCH=1 for an idle machine, =load for the same with busy processes sharing the
// helper's cores. The result line is printed as RESPAWN-TIMING.
import { ChildProcess, fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import type { ModelManifest } from "./embeddings.ts";
import { BRANCH_TABLES_SQL } from "../branch-index.ts";
import { migrateMemorySchema } from "./schema.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const manifest = JSON.parse(readFileSync(resolve("shared/memory-model-manifest.json"), "utf8")) as ModelManifest;
const modelDirectory = resolve(".planning/memory-evidence/model");
const prepared = manifest.files.every(file => existsSync(join(modelDirectory, file.path)));
const mode = process.env.RESPAWN_BENCH;

type Message = { type: string; requestId?: string; [key: string]: unknown };
function startWorker(pin: string[]) {
  const args = ["--experimental-strip-types", resolve("server/memory/worker.ts")];
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", MURAGE_MEMORY_BACKEND: "wasm" };
  const child: ChildProcess = pin.length
    ? spawn("taskset", ["-c", pin.join(","), process.execPath, ...args], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] })
    : fork(args[1], [], { execArgv: [args[0]], env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const mailbox: Message[] = [];
  let wake: (() => void) | undefined, exited: number | null | undefined, output = "";
  child.on("message", message => { mailbox.push(message as Message); wake?.(); });
  child.on("exit", code => { exited = code ?? -1; wake?.(); });
  child.stderr?.on("data", data => { output = (output + data).slice(-4000); });
  const wait = async (type: string, requestId?: string, timeout = 120_000) => {
    const until = Date.now() + timeout;
    for (;;) {
      const at = mailbox.findIndex(m => m.type === type && (!requestId || m.requestId === requestId));
      if (at >= 0) return mailbox.splice(at, 1)[0];
      if (exited !== undefined) throw new Error(`helper exited (${exited}) waiting for ${type}: ${output}`);
      if (Date.now() > until) throw new Error(`timed out waiting for ${type}: ${output}`);
      await new Promise<void>(done => { const timer = setTimeout(done, 50); wake = () => { clearTimeout(timer); done(); }; });
    }
  };
  const gone = async () => { const until = Date.now() + 20_000; while (exited === undefined && Date.now() < until) await new Promise(r => setTimeout(r, 10)); return exited; };
  return { child, wait, gone };
}

function fixture(root: string) {
  const authority = new DatabaseSync(join(root, "authority.db"));
  const records = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, version: 1, scopeId: "allowed", text: i === 0 ? "Orchidneedle. The vehicle needs gasoline to travel." : `Note ${i}: the team agreed on item ${i} for the quarterly plan and moved the review to Thursday.`, deleted: false }));
  try {
    authority.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    migrateMemorySchema(authority);
    authority.exec(BRANCH_TABLES_SQL);
    authority.exec("BEGIN IMMEDIATE");
    authority.prepare("INSERT INTO memory_scopes(id,kind,owner_key,audience,revision) VALUES('allowed','bot','allowed','[]',0)").run();
    for (const record of records) {
      const hash = createHash("sha256").update(record.text).digest("hex");
      authority.prepare("INSERT INTO memory_sources(id,scope_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,?,1,?,'text','owner','completed','active')").run(record.id, record.scopeId, hash);
      authority.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,1,?,?,1)").run(record.id, hash, JSON.stringify({ text: record.text }));
      authority.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'statement',?,'owner-statement','active',1,1)").run(record.id, record.scopeId, record.text);
      authority.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,1,0,?)").run(record.id, record.id, Buffer.byteLength(record.text));
    }
    authority.exec("COMMIT");
  } finally { authority.close(); }
  return records;
}

const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; };

it.runIf(prepared && mode)("the first search after a WebAssembly idle exit: respawn, model load, verify, first meaning search", { timeout: 600_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "respawn-"));
  const loaded = mode === "load";
  const pin = loaded ? ["0", "1"] : [];
  const busy: ChildProcess[] = loaded ? Array.from({ length: 6 }, () => spawn("taskset", ["-c", "0,1", process.execPath, "-e", "for(;;);"], { stdio: "ignore" })) : [];
  try {
    const records = fixture(root);
    const init = { type: "init", indexPath: join(root, "index.db"), authorityPath: join(root, "authority.db"), modelDirectory, manifest, wasmIdleExitMs: 50 };
    const query = (requestId: string) => ({ type: "query", requestId, input: { query: "car fuel", scopeIds: ["allowed"], policyRevision: 0, deletionEpoch: 0, historical: false, cursor: "", limit: 10, semantic: true } });
    // Round 0 indexes the records; it is not timed.
    let worker = startWorker(pin);
    await worker.wait("ready"); worker.child.send(init); await worker.wait("initialised");
    for (let at = 0; at < records.length; at += 16) {
      worker.child.send({ type: "index", requestId: `ix${at}`, records: records.slice(at, at + 16) });
      expect((await worker.wait("index-result", `ix${at}`)).embeddingStatus).toBe("indexed");
    }
    const samples: number[] = [], stages: Array<{ ready: number; initialised: number; answered: number }> = [];
    for (let run = 0; run < 10; run++) {
      // The idle exit: the helper asks, is given leave, and exits (the controller's side of the protocol).
      await worker.wait("idle-exit-request", undefined, 30_000);
      worker.child.send({ type: "idle-exit" });
      expect(await worker.gone()).toBe(0);
      const started = performance.now();
      worker = startWorker(pin);
      await worker.wait("ready"); const ready = performance.now() - started;
      worker.child.send(init); await worker.wait("initialised"); const initialised = performance.now() - started;
      worker.child.send(query(`q${run}`));
      const result = (await worker.wait("query-result", `q${run}`)).result as { vectorRows: number; degradedReason?: string; hits: unknown[] };
      const answered = performance.now() - started;
      expect(result.degradedReason).toBeUndefined();
      expect(result.vectorRows).toBe(records.length);
      expect(result.hits.length).toBeGreaterThan(0);
      samples.push(answered); stages.push({ ready, initialised, answered });
    }
    const round = (n: number) => Math.round(n);
    console.log("RESPAWN-TIMING " + JSON.stringify({ mode: loaded ? "load" : "idle", cpus: pin.length ? 2 : "unpinned", p50: round(percentile(samples, 0.5)), p95: round(percentile(samples, 0.95)), max: round(Math.max(...samples)), samples: samples.map(round), stages: stages.map(s => ({ ready: round(s.ready), initialised: round(s.initialised), answered: round(s.answered) })) }));
    worker.child.disconnect(); await worker.gone();
  } finally { for (const b of busy) b.kill("SIGKILL"); removeTempDirSync(root); }
});
