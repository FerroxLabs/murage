import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutineWatchFileAdapter, ROUTINE_WATCH_FILE_MAX_BYTES } from "./routine-watch-file.ts";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "murage-watch-file-"))); roots.push(root);
  fs.writeFileSync(join(root, "report.txt"), "one");
  const scope = { botId: "bot", workspaceId: "workspace", workspaceRoot: root };
  const resolve = vi.fn((id: string) => id === "binding" ? scope : null);
  const adapter = createRoutineWatchFileAdapter(resolve);
  const read = (path = "report.txt") => adapter.read({ adapterId: "file", scopeId: "binding", sourceId: path }, new AbortController().signal);
  return { root, scope, resolve, adapter, read };
}
describe("bounded workspace file watch", () => {
  it("hashes content, ignores touch, sees content change even with restored mtime", async () => {
    const f = fixture(); const first = await f.read(); const file = join(f.root, "report.txt");
    fs.utimesSync(file, new Date(), new Date(1_000));
    expect(await f.read()).toEqual(first);
    fs.writeFileSync(file, "two"); fs.utimesSync(file, new Date(), new Date(1_000));
    expect(await f.read()).not.toEqual(first);
    expect(Object.keys(first)).toEqual(["fingerprint"]);
  });
  it.each(["../report.txt", "/tmp/report.txt", "a\\b", "*.txt", "a/../b", "a//b", ".env", "a."])("rejects path %s", async path => {
    await expect(fixture().read(path)).rejects.toMatchObject({ code: "invalid-source" });
  });
  it.each(["credentials.json", "config.json", "settings/local.txt", "private.key", "MEMORY.md", "api-token.txt"])("rejects private setup %s", async path => {
    await expect(fixture().read(path)).rejects.toMatchObject({ code: "unsafe" });
  });
  it("distinguishes absence and revoked access from an observation", async () => {
    const f = fixture(); await expect(f.read("absent.txt")).rejects.toMatchObject({ code: "missing" });
    f.resolve.mockReturnValue(null); await expect(f.read()).rejects.toMatchObject({ code: "unavailable" });
  });
  it("rejects directory, symlink, parent symlink and hardlink", async () => {
    const f = fixture(); fs.mkdirSync(join(f.root, "folder"));
    fs.symlinkSync(join(f.root, "report.txt"), join(f.root, "link.txt"));
    fs.symlinkSync(join(f.root, "folder"), join(f.root, "linked"));
    fs.writeFileSync(join(f.root, "folder", "data.txt"), "data");
    for (const path of ["folder", "link.txt", "linked/data.txt"]) await expect(f.read(path)).rejects.toMatchObject({ code: "unsafe" });
    fs.linkSync(join(f.root, "report.txt"), join(f.root, "hard.txt"));
    await expect(f.read("hard.txt")).rejects.toMatchObject({ code: "unsafe" });
  });
  it("enforces size limit including empty file handling", async () => {
    const f = fixture(); fs.writeFileSync(join(f.root, "report.txt"), "");
    expect((await f.read()).fingerprint).toMatch(/^[a-f0-9]{64}$/);
    fs.writeFileSync(join(f.root, "report.txt"), Buffer.alloc(ROUTINE_WATCH_FILE_MAX_BYTES + 1));
    await expect(f.read()).rejects.toMatchObject({ code: "too-large" });
  });
  it("rechecks current authority and respects cancellation", async () => {
    const f = fixture(); f.resolve.mockReturnValueOnce(f.scope).mockReturnValue(null);
    await expect(f.read()).rejects.toMatchObject({ code: "unavailable" });
    const controller = new AbortController(); controller.abort();
    await expect(f.adapter.read({ adapterId: "file", scopeId: "binding", sourceId: "report.txt" }, controller.signal)).rejects.toMatchObject({ code: "aborted" });
  });
  it("rejects replacement during descriptor read and closes its handle", async () => {
    const f = fixture(); const original = fs.readSync; let replaced = false;
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      if (!replaced) { replaced = true; fs.renameSync(join(f.root, "report.txt"), join(f.root, "old.txt")); fs.writeFileSync(join(f.root, "report.txt"), "two"); }
      return original(...args);
    });
    const close = vi.spyOn(fs, "closeSync");
    await expect(f.read()).rejects.toMatchObject({ code: "changed-during-read" });
    expect(close).toHaveBeenCalledOnce();
  });
});
