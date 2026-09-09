import { closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { artifactsRequest, ARTIFACT_MAX_BYTES, ARTIFACT_STORAGE_MAX_BYTES, describeArtifact, initializeArtifacts, listArtifacts, previewArtifact, readArtifact, registerArtifact, type ArtifactAccess } from "./artifacts.ts";
const roots: string[] = [], databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-artifact-")); roots.push(root);
  const workspace = join(root, "workspace"), storage = join(root, "artifact-files"), file = join(root, "messages.db"); mkdirSync(workspace);
  const db = new DatabaseSync(file); databases.push(db); initializeArtifacts(db);
  const access: ArtifactAccess = { owner: true, scopes: [{ botId: "bot", botName: "Research bot", threadId: "thread", runId: "run", workspaceRoot: workspace }] };
  const input = { botId: "bot", threadId: "thread", relativePath: "report.html", name: "Weekly report" };
  const content = "<!doctype html><h1>Verified weekly result</h1><p>Three updates.</p>";
  writeFileSync(join(workspace, input.relativePath), content);
  return { root, workspace, storage, file, db, access, input, content };
}
it("verifies real bytes, stores one immutable copy and returns the same identity on duplicate registration", () => {
  const f = fixture(), saved = registerArtifact(f.db, f.storage, f.input, f.access);
  expect(saved).toMatchObject({ name: "Weekly report", filename: "Weekly report.html", botId: "bot", threadId: "thread", runId: "run", sourceState: "current", savedState: "available" });
  expect(saved.sha256).toBe(createHash("sha256").update(f.content).digest("hex"));
  expect(registerArtifact(f.db, f.storage, f.input, f.access).id).toBe(saved.id);
  expect(readdirSync(f.storage)).toHaveLength(1);
  expect(listArtifacts(f.db, f.storage, {}, f.access).total).toBe(1);
  const downloaded = readArtifact(f.db, f.storage, saved.id, f.access);
  expect(downloaded.bytes.toString()).toBe(f.content);
  expect(downloaded.verifiedNativePath).not.toBe(join(f.workspace, "report.html"));
  expect(downloaded.verifiedNativePath).toContain("artifact-files");
});
it("preserves report history after overwrite, source deletion and database restart", () => {
  const f = fixture(), first = registerArtifact(f.db, f.storage, f.input, f.access);
  writeFileSync(join(f.workspace, "report.html"), "<h1>New report</h1>");
  expect(listArtifacts(f.db, f.storage, {}, f.access).items[0].sourceState).toBe("changed");
  expect(readArtifact(f.db, f.storage, first.id, f.access).bytes.toString()).toBe(f.content);
  const second = registerArtifact(f.db, f.storage, f.input, f.access); expect(second.id).not.toBe(first.id);
  rmSync(f.workspace, { recursive: true }); f.db.close();
  const reopened = new DatabaseSync(f.file); databases.push(reopened); initializeArtifacts(reopened);
  const retained = { owner: true, scopes: [{ ...f.access.scopes[0], threadId: undefined, threadAvailable: false }] };
  expect(listArtifacts(reopened, f.storage, {}, retained).items).toHaveLength(2);
  expect(readArtifact(reopened, f.storage, first.id, retained)).toMatchObject({ artifact: { sourceState: "missing", sourceConversationAvailable: false } });
  expect(readArtifact(reopened, f.storage, first.id, retained).bytes.toString()).toBe(f.content);
});
it("rejects traversal, absolute paths, private setup files and symlink/hardlink sources without copying them", () => {
  const f = fixture();
  for (const relativePath of ["../secret", "/etc/passwd", "C:\\secret", "a/../report.html", ".env", "memory/private.md", "MEMORY.md", "skills/private.txt"]) {
    expect(() => registerArtifact(f.db, f.storage, { ...f.input, relativePath }, f.access)).toThrow();
  }
  symlinkSync(join(f.workspace, "report.html"), join(f.workspace, "alias.html"));
  expect(() => registerArtifact(f.db, f.storage, { ...f.input, relativePath: "alias.html" }, f.access)).toThrow("Linked files");
  symlinkSync(f.workspace, join(f.workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  expect(() => registerArtifact(f.db, f.storage, { ...f.input, relativePath: "linked/report.html" }, f.access)).toThrow("Linked files");
  linkSync(join(f.workspace, "report.html"), join(f.workspace, "hard.html"));
  expect(() => registerArtifact(f.db, f.storage, f.input, f.access)).toThrow("ordinary files");
  expect(existsSync(f.storage)).toBe(false);
});
it("never trusts the caller's root/run or permits another bot, deleted bot or remote access", () => {
  const f = fixture(), saved = registerArtifact(f.db, f.storage, f.input, f.access);
  expect(artifactsRequest(f.db, f.storage, { method: "POST", path: "/api/artifacts/register", body: { ...f.input, workspaceRoot: f.root } as never }, f.access).status).toBe(400);
  expect(artifactsRequest(f.db, f.storage, { method: "POST", path: "/api/artifacts/register", body: { ...f.input, runId: "other" } as never }, f.access).status).toBe(400);
  expect(() => registerArtifact(f.db, f.storage, { ...f.input, botId: "other" }, f.access)).toThrow("unavailable");
  expect(listArtifacts(f.db, f.storage, {}, { owner: true, scopes: [] }).total).toBe(0);
  expect(() => readArtifact(f.db, f.storage, saved.id, { owner: true, scopes: [] })).toThrow("unavailable");
  for (const path of ["/api/artifacts", `/api/artifacts/${saved.id}/preview`, `/api/artifacts/${saved.id}/download`, `/api/artifacts/${saved.id}/reveal`]) expect(artifactsRequest(f.db, f.storage, { method: "GET", path }, { ...f.access, owner: false }).status).toBe(404);
});
it("detects missing or changed snapshots and never silently falls back to original bytes", () => {
  const f = fixture(), saved = registerArtifact(f.db, f.storage, f.input, f.access);
  const path = readArtifact(f.db, f.storage, saved.id, f.access).verifiedNativePath;
  writeFileSync(path, "x".repeat(Buffer.byteLength(f.content)));
  expect(() => readArtifact(f.db, f.storage, saved.id, f.access)).toThrow("saved copy changed");
  rmSync(path); expect(listArtifacts(f.db, f.storage, {}, f.access).items[0].savedState).toBe("missing");
  expect(() => previewArtifact(f.db, f.storage, saved.id, f.access)).toThrow("missing or unreadable");
  expect(readFileSync(join(f.workspace, "report.html"), "utf8")).toBe(f.content);
});
it("enforces file and storage limits without removing originals or saved history", () => {
  const f = fixture();
  const big = join(f.workspace, "large.bin"), fd = openSync(big, "w"); ftruncateSync(fd, ARTIFACT_MAX_BYTES + 1); closeSync(fd);
  expect(() => registerArtifact(f.db, f.storage, { ...f.input, relativePath: "large.bin" }, f.access)).toThrow("size limit");
  mkdirSync(f.storage); const quota = join(f.storage, "quota-fixture"), quotaFd = openSync(quota, "w"); ftruncateSync(quotaFd, ARTIFACT_STORAGE_MAX_BYTES); closeSync(quotaFd);
  expect(() => registerArtifact(f.db, f.storage, f.input, f.access)).toThrow("storage limit");
  expect(existsSync(big)).toBe(true); expect(existsSync(quota)).toBe(true);
});
it("supports bounded stable search/page/type/date/bot/task filtering", () => {
  const f = fixture();
  for (let i = 0; i < 8; i++) { writeFileSync(join(f.workspace, `${i}.txt`), `Result ${i}`); registerArtifact(f.db, f.storage, { ...f.input, relativePath: `${i}.txt`, name: `Report ${i}` }, f.access); }
  const first = listArtifacts(f.db, f.storage, { kind: "text", pageSize: 3 }, f.access), next = listArtifacts(f.db, f.storage, { kind: "text", pageSize: 3, page: 1 }, f.access);
  expect(first.total).toBe(8); expect(first.items).toHaveLength(3); expect(first.items.some(item => next.items.some(other => item.id === other.id))).toBe(false);
  expect(listArtifacts(f.db, f.storage, { query: "Report 4", botId: "bot", threadId: "thread", since: 0, until: Date.now() + 1000 }, f.access).total).toBe(1);
  expect(listArtifacts(f.db, f.storage, { botId: "other" }, f.access).total).toBe(0);
  expect(() => listArtifacts(f.db, f.storage, { pageSize: 101 }, f.access)).toThrow("filters");
  expect(() => listArtifacts(f.db, f.storage, { query: 3 } as never, f.access)).toThrow("filters");
});
it("keeps preview responses inert and downloads byte-exact with attachment headers", () => {
  const f = fixture(), saved = registerArtifact(f.db, f.storage, f.input, f.access);
  const preview = artifactsRequest(f.db, f.storage, { method: "GET", path: `/api/artifacts/${saved.id}/preview` }, f.access);
  expect(preview).toMatchObject({ status: 200, body: { mode: "html", content: f.content }, headers: { "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff" } });
  const download = artifactsRequest(f.db, f.storage, { method: "GET", path: `/api/artifacts/${saved.id}/download` }, f.access);
  expect(download).toMatchObject({ status: 200, bytes: Buffer.from(f.content), headers: { "content-type": "application/octet-stream", "content-disposition": "attachment; filename*=UTF-8''Weekly%20report.html" } });
  expect(JSON.stringify(preview)).not.toContain(f.workspace);
  writeFileSync(join(f.workspace, "report.pdf"), "fake PDF bytes");
  const pdf = registerArtifact(f.db, f.storage, { ...f.input, relativePath: "report.pdf" }, f.access);
  expect(previewArtifact(f.db, f.storage, pdf.id, f.access).mode).toBe("download");
});

it("describes registry metadata without reading the saved payload and preserves scope denial", () => {
  const f = fixture(), saved = registerArtifact(f.db, f.storage, f.input, f.access);
  const blob = readArtifact(f.db, f.storage, saved.id, f.access).verifiedNativePath;
  writeFileSync(blob, "x".repeat(saved.bytes));
  expect(describeArtifact(f.db, f.storage, saved.id, f.access).id).toBe(saved.id);
  const response = artifactsRequest(f.db, f.storage, { method: "GET", path: `/api/artifacts/${saved.id}` }, f.access);
  expect(response).toMatchObject({ status: 200, body: { artifact: { id: saved.id } } });
  expect(response).not.toHaveProperty("bytes");
  expect(JSON.stringify(response)).not.toContain(f.storage);
  expect(artifactsRequest(f.db, f.storage, { method: "GET", path: `/api/artifacts/${saved.id}` }, { owner: true, scopes: [] }).status).toBe(404);
  expect(() => readArtifact(f.db, f.storage, saved.id, f.access)).toThrow("saved copy changed");
});
