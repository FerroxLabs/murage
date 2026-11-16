// Dependency-free native filesystem/process tests. Node >=24, no provider calls.
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const [mode, directory, digest = "digest"] = process.argv.slice(2);
const applied = { status: "applied", result: { recordId: "fixture-only" } };
if (mode === "crash") {
  const write = fs.writeFileSync, link = fs.linkSync;
  fs.writeFileSync = (fd, ...args) => {
    if (typeof fd === "number" && digest === "torn") { write(fd, "{torn"); process.exit(73); }
    return write(fd, ...args);
  };
  fs.linkSync = (...args) => {
    if (digest === "before-publication") process.exit(73);
    link(...args);
    if (digest === "after-publication") process.exit(73);
  };
  syncBuiltinESMExports();
  const { FileApprovalJournal } = await import("../server/highlevel/approval-idempotency.ts");
  new FileApprovalJournal(directory).claim("crash-id", "digest");
  throw new Error("Fault injection was not reached");
} else if (mode === "race") {
  const { FileApprovalJournal } = await import("../server/highlevel/approval-idempotency.ts");
  const journal = new FileApprovalJournal(directory);
  process.stdout.write("READY\n");
  await new Promise(resolve => process.stdin.once("data", resolve));
  const claimed = journal.claim("duplicate-id", digest);
  const record = journal.get("duplicate-id");
  process.stdout.write(`${JSON.stringify({ claimed, digest: record.requestDigest })}\n`);
} else {
  const { FileApprovalJournal, runApprovedWrite } = await import("../server/highlevel/approval-idempotency.ts");
  const base = process.env.MURAGE_F03_TEST_ROOT || tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(join(base, "murage-f03-"));
  let passed = 0;
  try {
    for (const fault of ["torn", "before-publication", "after-publication"]) {
      const dir = join(root, fault);
      const child = spawnSync(process.execPath, ["--experimental-strip-types", self, "crash", dir, fault], { encoding: "utf8", timeout: 60000 });
      assert.equal(child.status, 73, child.stderr || String(child.error));
      const journal = new FileApprovalJournal(dir);
      if (fault !== "after-publication") {
        assert.equal(journal.get("crash-id"), undefined);
        assert.equal(journal.claim("crash-id", "digest"), true);
      } else {
        assert.equal(journal.get("crash-id").state, "pending");
        let dispatches = 0, reads = 0;
        assert.deepEqual(await runApprovedWrite(journal, "crash-id", "digest", {
          dispatch: async () => { dispatches++; return applied; },
          reconcile: async () => { reads++; return applied; },
        }), applied);
        assert.equal(dispatches, 0); assert.equal(reads, 1);
      }
      console.log(`PASS native ${fault}`); passed++;
    }
    const dir = join(root, "race");
    // Each child completes its volume probe before both are released together.
    const children = ["first", "second"].map(value => {
      const child = spawn(process.execPath, ["--experimental-strip-types", self, "race", dir, value], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "", errors = "";
      let readyResolve, readyReject;
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      child.stdout.on("data", chunk => { output += chunk; if (output.includes("READY\n")) readyResolve(); });
      child.stderr.on("data", chunk => { errors += chunk; });
      const done = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", code => {
          if (code !== 0) { const error = new Error(errors || `child exit ${code}`); readyReject(error); reject(error); }
          else { try { resolve(JSON.parse(output.trim().split("\n").at(-1))); } catch (error) { reject(error); } }
        });
      });
      // Handle rejection even if a child fails before its READY message.
      void done.catch(() => {});
      return { child, ready, done };
    });
    const timer = setTimeout(() => { for (const { child } of children) child.kill(); }, 60000);
    let results;
    try {
      await Promise.all(children.map(c => c.ready));
      for (const { child } of children) child.stdin.end("GO\n");
      results = await Promise.all(children.map(c => c.done));
    } finally { clearTimeout(timer); for (const { child } of children) if (child.exitCode === null) child.kill(); }
    assert.equal(results.filter(r => r.claimed).length, 1);
    assert.equal(results[0].digest, results[1].digest);
    const winner = results[0].digest;
    const journal = new FileApprovalJournal(dir);
    assert.equal(journal.claim("duplicate-id", "third"), false);
    assert.deepEqual(journal.settle("duplicate-id", winner, applied), applied);
    assert.deepEqual(new FileApprovalJournal(dir).settle("duplicate-id", winner, { status: "conflict", reason: "unconfirmed" }), applied);
    console.log("PASS native duplicate-approvalId (2 processes; 1 winner; immutable outcome)"); passed++;
    console.log(`PASS native total=${passed} platform=${process.platform}`);
  } finally { safeWipeSync(root); }
}
