import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { commitPackageImportFiles } from "./package-import-transaction.ts";

it("the actual import callback exits before queued writers when recovery finds an unknown hash", () => {
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("index.ts", index, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let callback = "";
  const visit = (node: ts.Node) => {
    if (ts.isTryStatement(node) && node.tryBlock.statements.some(statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(source) === "commitPackageImportFiles")) {
      expect(callback).toBe("");
      expect(ts.isBlock(node.parent)).toBe(true);
      const statements = (node.parent as ts.Block).statements;
      const position = statements.indexOf(node);
      const publishes = statements.slice(position + 1, position + 3).map(statement => statement.getText(source));
      expect(publishes).toEqual(["routineBatch.publish();", "botBatch.publish();"]);
      callback = [node.getText(source), ...publishes].join("\n");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(callback).toContain("process.exit(1)");
  const executable = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const root = mkdtempSync(join(tmpdir(), "murage-import-fatal-"));
  const lease = acquireDataDirLease(root);
  try {
    const original = Buffer.from('[{"id":"original"}]');
    writeFileSync(join(root, "bots.json"), original);
    const replacements = new Map([["bots.json", Buffer.from('[{"id":"new"}]')]]);
    const expected = new Map([["bots.json", createHash("sha256").update(original).digest("hex")]]);
    expect(() => commitPackageImportFiles(root, replacements, expected, { allowedNewBotIds: [], assertOwned: () => { lease.utilityServerLeaseEnvironment(); }, checkpoint: phase => { if (phase === "replaced:0") throw new Error("fixture interruption"); } })).toThrow();
    writeFileSync(join(root, "bots.json"), "unknown-private-target-change");
    const journalPath = join(root, ".package-import-transaction", "journal.json");
    const oldPath = join(root, ".package-import-transaction", "old", "0");
    const journal = readFileSync(journalPath), retained = readFileSync(oldPath);
    lease.release();
    const script = `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { acquireDataDirLease } from ${JSON.stringify(new URL("../electron/data-dir-lease.mjs", import.meta.url).href)};
      import { recoverPackageImportTransaction } from ${JSON.stringify(new URL("./package-import-transaction.ts", import.meta.url).href)};
      const DATA_DIR = ${JSON.stringify(root)};
      const owned = acquireDataDirLease(DATA_DIR);
      const assertOwned = () => { owned.utilityServerLeaseEnvironment(); };
      const replacements = new Map(), expected = new Map(), prepared = { bots: [] };
      const commitPackageImportFiles = () => { throw new Error("private-original-commit-cause"); };
      const routineBatch = { publish() { writeFileSync(join(DATA_DIR, "published"), "routines"); } };
      const botBatch = { publish() { writeFileSync(join(DATA_DIR, "published"), "bots"); } };
      queueMicrotask(() => writeFileSync(join(DATA_DIR, "queued-writer"), "must not run"));
      ${executable}
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 10000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.signal).toBeNull();
    expect(child.stderr).toContain("Package import recovery could not establish a consistent installation.");
    expect(child.stderr).not.toMatch(/private-original-commit-cause|unknown-private-target-change|PACKAGE_IMPORT_TARGET_CHANGED/);
    expect(existsSync(join(root, "queued-writer"))).toBe(false);
    expect(existsSync(join(root, "published"))).toBe(false);
    expect(readFileSync(journalPath)).toEqual(journal);
    expect(readFileSync(oldPath)).toEqual(retained);
    expect(retained).toEqual(original);
    expect(readFileSync(join(root, "bots.json"), "utf8")).toBe("unknown-private-target-change");
  } finally {
    lease.release();
    // The fatal child intentionally retained its external lease. Reclaim it
    // only after spawnSync has observed that exact process exit, then release
    // our fixture ownership before deleting the temporary installation.
    const cleanupLease = acquireDataDirLease(root);
    cleanupLease.release();
    rmSync(root, { recursive: true, force: true });
  }
});
