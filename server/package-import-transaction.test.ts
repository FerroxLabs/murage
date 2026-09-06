import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { commitPackageImportFiles, recoverPackageImportTransaction } from "./package-import-transaction.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-package-transaction-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const lease = acquireDataDirLease(root); cleanup.push(() => { lease.release(); });
  const assertOwned = () => { lease.utilityServerLeaseEnvironment(); };
  const botId = randomUUID();
  const originals = new Map([["bots.json", Buffer.from('[{"id":"existing"}]')], ["groups.json", Buffer.from("[]")], ["routines.json", Buffer.from('{"version":1,"routines":[],"runs":[]}')]]);
  for (const [path, bytes] of originals) writeFileSync(join(root, path), bytes);
  const replacements = new Map([...originals].map(([path]) => [path, Buffer.from(`new ${path}`)]));
  replacements.set(`workspaces/${botId}/SOUL.md`, Buffer.from("Safe imported instructions"));
  replacements.set(`workspaces/${botId}/skills/research/SKILL.md`, Buffer.from("Check facts"));
  replacements.set(`skill-state/${botId}/skills.json`, Buffer.from('{"research":{"enabled":false}}'));
  const expected = new Map([...replacements].map(([path]) => [path, originals.has(path) ? sha(originals.get(path)!) : null]));
  return { root, botId, originals, replacements, expected, options: { allowedNewBotIds: [botId], assertOwned } };
}

it("durably commits records and fresh owned payloads before returning", () => {
  const f = fixture();
  expect(commitPackageImportFiles(f.root, f.replacements, f.expected, f.options).status).toBe("committed");
  for (const [path, bytes] of f.replacements) expect(readFileSync(join(f.root, path))).toEqual(bytes);
  expect(existsSync(join(f.root, ".package-import-transaction"))).toBe(false);
  expect(recoverPackageImportTransaction(f.root, f.options)).toEqual({ status: "none" });
});

it.each(["replaced:0", "committed"])("the synchronous caller wrapper recovers %s before publishing memory", phase => {
  const f = fixture();
  let published = false;
  const originalError = new Error("injected commit interruption");
  const importAndPublish = () => {
    try {
      commitPackageImportFiles(f.root, f.replacements, f.expected, { ...f.options, checkpoint: at => { if (at === phase) throw originalError; } });
    } catch (error) {
      // Exactly the integration decision: never publish rolled-back state,
      // and never turn durable committed data into a reported failed import.
      const recovered = recoverPackageImportTransaction(f.root, f.options);
      if (recovered.status !== "committed") throw error;
    }
    for (const [path, bytes] of f.replacements) expect(readFileSync(join(f.root, path))).toEqual(bytes);
    published = true;
  };
  if (phase === "committed") {
    expect(importAndPublish).not.toThrow();
    expect(published).toBe(true);
  } else {
    expect(importAndPublish).toThrow(originalError);
    expect(published).toBe(false);
    for (const [path, bytes] of f.originals) expect(readFileSync(join(f.root, path))).toEqual(bytes);
    for (const path of f.replacements.keys()) if (!f.originals.has(path)) expect(existsSync(join(f.root, path))).toBe(false);
  }
  expect(existsSync(join(f.root, ".package-import-transaction"))).toBe(false);
});

it.each(["staged", "prepared", "replaced:0", "replaced:3", "replaced:5", "committed"])("recovers deterministically after interruption at %s", phase => {
  const f = fixture();
  expect(() => commitPackageImportFiles(f.root, f.replacements, f.expected, { ...f.options, checkpoint: at => { if (at === phase) throw new Error("simulated process interruption"); } })).toThrow("simulated process interruption");
  expect(() => commitPackageImportFiles(f.root, f.replacements, f.expected, f.options)).toThrow("PACKAGE_IMPORT_RECOVERY_REQUIRED");
  const result = recoverPackageImportTransaction(f.root, f.options);
  expect(result.status).toBe(phase === "committed" ? "committed" : "rolled-back");
  for (const [path, bytes] of f.replacements) {
    if (phase === "committed") expect(readFileSync(join(f.root, path))).toEqual(bytes);
    else if (f.originals.has(path)) expect(readFileSync(join(f.root, path))).toEqual(f.originals.get(path));
    else expect(existsSync(join(f.root, path))).toBe(false);
  }
  expect(recoverPackageImportTransaction(f.root, f.options).status).toBe("none");
});

it("can resume an interrupted rollback and remove its partial task-owned temporary file", () => {
  const f = fixture();
  expect(() => commitPackageImportFiles(f.root, f.replacements, f.expected, { ...f.options, checkpoint: phase => { if (phase === "replaced:3") throw new Error("stop"); } })).toThrow();
  const journal = JSON.parse(readFileSync(join(f.root, ".package-import-transaction/journal.json"), "utf8"));
  writeFileSync(join(f.root, `bots.json.package-${journal.id}.tmp`), "partial staged replacement");
  expect(() => recoverPackageImportTransaction(f.root, { ...f.options, checkpoint: phase => { if (phase === "recovered:0") throw new Error("stop again"); } })).toThrow("stop again");
  expect(recoverPackageImportTransaction(f.root, f.options).status).toBe("rolled-back");
  expect(readFileSync(join(f.root, "bots.json"))).toEqual(f.originals.get("bots.json"));
  expect(existsSync(join(f.root, `bots.json.package-${journal.id}.tmp`))).toBe(false);
});

it("refuses unknown target changes before rolling back any file", () => {
  const f = fixture();
  expect(() => commitPackageImportFiles(f.root, f.replacements, f.expected, { ...f.options, checkpoint: phase => { if (phase === "replaced:1") throw new Error("stop"); } })).toThrow();
  writeFileSync(join(f.root, "groups.json"), "foreign user edit");
  expect(() => recoverPackageImportTransaction(f.root, f.options)).toThrow("PACKAGE_IMPORT_TARGET_CHANGED");
  expect(readFileSync(join(f.root, "bots.json"))).toEqual(f.replacements.get("bots.json"));
  expect(readFileSync(join(f.root, "groups.json"), "utf8")).toBe("foreign user edit");
});

it("refuses mismatched expected hashes, unsafe paths and existing workspace roots before writes", () => {
  const f = fixture();
  const wrong = new Map(f.expected); wrong.set("bots.json", "0".repeat(64));
  expect(() => commitPackageImportFiles(f.root, f.replacements, wrong, f.options)).toThrow("PACKAGE_IMPORT_SOURCE_CHANGED");
  for (const path of ["config.json", "../bots.json", `workspaces/${f.botId}/other.txt`, `skill-state/${f.botId}/staged.json`]) {
    expect(() => commitPackageImportFiles(f.root, new Map([[path, Buffer.from("x")]]), new Map([[path, null]]), f.options)).toThrow();
  }
  mkdirSync(join(f.root, "workspaces", f.botId), { recursive: true });
  expect(() => commitPackageImportFiles(f.root, f.replacements, f.expected, f.options)).toThrow("PACKAGE_IMPORT_BOT_PATH_EXISTS");
  expect(readFileSync(join(f.root, "bots.json"))).toEqual(f.originals.get("bots.json"));
  expect(existsSync(join(f.root, ".package-import-transaction"))).toBe(false);
});

it("enforces the payload byte budget and caller ownership before mutation", () => {
  const f = fixture();
  expect(() => commitPackageImportFiles(f.root, new Map([["bots.json", Buffer.alloc(50 * 1024 * 1024 + 1)]]), new Map([["bots.json", f.expected.get("bots.json")!]]), f.options)).toThrow("PACKAGE_IMPORT_LIMIT");
  expect(() => commitPackageImportFiles(f.root, f.replacements, f.expected, { ...f.options, assertOwned: () => { throw new Error("lease released"); } })).toThrow("lease released");
  expect(existsSync(join(f.root, ".package-import-transaction"))).toBe(false);
});

it.skipIf(process.platform === "win32")("refuses symlinked payload parents without following them", () => {
  const f = fixture();
  const external = mkdtempSync(join(tmpdir(), "murage-transaction-external-")); cleanup.push(() => rmSync(external, { recursive: true, force: true }));
  symlinkSync(external, join(f.root, "workspaces"));
  expect(() => commitPackageImportFiles(f.root, f.replacements, f.expected, f.options)).toThrow("UNSAFE_PACKAGE_IMPORT_PATH");
  expect(existsSync(join(external, f.botId))).toBe(false);
});
