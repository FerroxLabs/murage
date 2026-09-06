import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { stageInstallationState } from "./installation-state-snapshot.ts";

const roots: string[] = [];
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "murage-state-stage-test-"));
  roots.push(parent);
  const data = join(parent, "installation");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({
    profile: { name: "Fixture owner", privateToken: "nested-secret-canary" },
    flux: { apiKey: "provider-secret-canary" },
    instances: { fixture: { driver: "fuigoAgent", enabled: true, environment: { TOKEN: "env-secret-canary" }, config: { cli: "custom", apiKey: "config-secret-canary" } } },
    mcpServers: { secret: { command: "anything", env: { TOKEN: "mcp-secret-canary" } } },
  }));
  writeFileSync(join(data, "bots.json"), JSON.stringify([{ id: "bot", threadId: "thread", name: "Fixture bot", cwd: join(parent, "external"), resumeCursors: { provider: "native-cursor-canary" } }]));
  writeFileSync(join(data, "webhooks.json"), JSON.stringify({ version: 1, webhooks: [{ id: "hook", endpointId: "endpoint", name: "Hook", prompt: "Task", botId: "bot", runOn: "ember", createdAt: 1, updatedAt: 1, deliveryCount: 1, secretHash: "a8".repeat(32), enabled: true }], deliveries: [{ key: "endpoint:already-accepted", runId: "finished-run", at: 1 }] }));
  mkdirSync(join(data, "attachments"));
  writeFileSync(join(data, "attachments", "fixture.txt"), "Private attachment content");
  mkdirSync(join(parent, "external"));
  writeFileSync(join(parent, "external", "untouched.txt"), "external-data-canary");
  return { parent, data };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("stages private app content under one epoch, excluding credential fields and external folders", async () => {
  const f = fixture();
  const original = readFileSync(join(f.data, "config.json"), "utf8");
  const { directory, manifest } = await stageInstallationState(f.data, f.parent);
  expect(manifest.format).toBe("murage.installation-stage");
  expect(manifest.restorePolicy).toBe("paused-review-required");
  expect(manifest.database.status).toBe("absent");
  const config = readFileSync(join(directory, "state", "config.json"), "utf8");
  expect(config).not.toMatch(/secret-canary/);
  expect(JSON.parse(config)).toEqual({ profile: { name: "Fixture owner" }, instances: { fixture: { driver: "fuigoAgent", enabled: false } } });
  expect(readFileSync(join(directory, "state", "bots.json"), "utf8")).not.toContain("native-cursor-canary");
  const webhooks = JSON.parse(readFileSync(join(directory, "state", "webhooks.json"), "utf8"));
  expect(webhooks.webhooks[0]).toMatchObject({ id: "hook", endpointId: "endpoint", enabled: false });
  expect(webhooks.webhooks[0]).not.toHaveProperty("secretHash");
  expect(JSON.stringify(webhooks)).not.toContain("a8".repeat(32));
  expect(webhooks.deliveries).toEqual([{ key: "endpoint:already-accepted", runId: "finished-run", at: 1 }]);
  expect(readFileSync(join(directory, "state", "attachments", "fixture.txt"), "utf8")).toBe("Private attachment content");
  expect(manifest.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
  expect(manifest.files.some(file => file.path.includes("external"))).toBe(false);
  expect(readFileSync(join(f.data, "config.json"), "utf8")).toBe(original);
  expect(readFileSync(join(f.parent, "external", "untouched.txt"), "utf8")).toBe("external-data-canary");
});

it("refuses a live installation owner before copying any component", async () => {
  const f = fixture();
  const held = acquireDataDirLease(f.data);
  try { await expect(stageInstallationState(f.data, f.parent)).rejects.toThrow(); }
  finally { held.release(); }
  expect(readdirSync(f.parent).filter(name => name.startsWith(".murage-state-snapshot-"))).toEqual([]);
});

it("combines WAL-backed receipts and app files in the same owned stage", async () => {
  const f = fixture();
  const db = new DatabaseSync(join(f.data, "messages.db"));
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id));
      CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);`);
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("thread", "receipt", 1, "bot", "goal.run", null, JSON.stringify({ id: "receipt", at: 1, role: "bot", kind: "goal.run", goalRun: { status: "completed" } }));
    db.exec("INSERT INTO thread_state VALUES('thread','receipt')");
    const stage = await stageInstallationState(f.data, f.parent);
    expect(stage.manifest.database).toMatchObject({ status: "copied", messages: 1, threads: 1 });
    expect(stage.manifest.files.map(file => file.path)).toEqual(expect.arrayContaining(["config.json", "bots.json", "webhooks.json", "messages.db", join("attachments", "fixture.txt")]));
    const copied = new DatabaseSync(join(stage.directory, "state", "messages.db"), { readOnly: true });
    try { expect(JSON.parse(String(copied.prepare("SELECT json FROM messages").get()?.json)).goalRun.status).toBe("completed"); }
    finally { copied.close(); }
  } finally { db.close(); }
});

it.each(["cancel", "quota", "corruption"])("cleans only owned staging on %s and leaves source intact", async kind => {
  const f = fixture();
  const controller = new AbortController();
  if (kind === "cancel") controller.abort();
  if (kind === "corruption") writeFileSync(join(f.data, "config.json"), '{"private":"parse-secret-canary",');
  const before = readFileSync(join(f.data, "config.json"));
  await expect(stageInstallationState(f.data, f.parent, { signal: controller.signal, maxBytes: kind === "quota" ? 1 : undefined })).rejects.toThrow();
  expect(readdirSync(f.parent).filter(name => name.startsWith(".murage-state-snapshot-"))).toEqual([]);
  expect(readFileSync(join(f.data, "config.json"))).toEqual(before);
  const lease = acquireDataDirLease(f.data);
  lease.release();
});

it.skipIf(process.platform === "win32")("never follows app-owned symlinks into external content", async () => {
  const f = fixture();
  mkdirSync(join(f.data, "workspaces"));
  symlinkSync(join(f.parent, "external"), join(f.data, "workspaces", "outside"));
  const result = await stageInstallationState(f.data, f.parent);
  expect(result.manifest.omitted).toContainEqual({ path: join("workspaces", "outside"), reason: "Directory symlink not followed" });
  expect(result.manifest.files.some(file => file.path.includes("untouched"))).toBe(false);
});

it("omits headless companion bindings and restored connection profiles without reading their contents", async () => {
  const f = fixture();
  for (const directory of ["companion", "connection-profiles"]) {
    mkdirSync(join(f.data, directory));
    writeFileSync(join(f.data, directory, "private.json"), "private-connection-canary");
  }
  const result = await stageInstallationState(f.data, f.parent);
  expect(result.manifest.files.some(file => file.path.startsWith("companion/") || file.path.startsWith("connection-profiles/"))).toBe(false);
  expect(result.manifest.omitted.map(item => item.path)).toEqual(expect.arrayContaining(["companion", "connection-profiles"]));
  expect(JSON.stringify(result.manifest)).not.toContain("private-connection-canary");
  expect(readFileSync(join(f.data, "companion", "private.json"), "utf8")).toBe("private-connection-canary");
});
