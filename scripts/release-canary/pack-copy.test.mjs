import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { copySyntheticPack, packInventoryViolations } from "./pack-copy.mjs";

const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), "canary-pack-"));
  dirs.push(dir);
  const source = join(dir, "input");
  for (const [name, contents] of Object.entries(files)) {
    const path = join(source, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  return { source, destination: join(dir, "output"), kind: "synthetic" };
}

test("W18b inventory copy excludes authority and unknown names; retains derived state", async () => {
  const args = await fixture({
    "mcp-access.token": "dummy marker",
    "sentinel-io/host.key": "dummy marker",
    "mcp-grants.json": "dummy marker",
    "mcp-grants.json.0f8e2b1a.tmp": "dummy marker",
    "pending-grants.json": "dummy marker",
    "cloud-computer-turns.json": "dummy marker",
    "unclassified.bin": "dummy marker",
    "workspaces/nested/mcp-access.token": "dummy marker",
    "workspaces/nested/example.md": "synthetic content",
    "about-me.md": "synthetic content",
    "memory-index.db": "synthetic derived bytes",
    "search.db-wal": "synthetic derived bytes",
    "data-version.json": "{}",
    "queued-messages.json": '[{"text":"dummy queued message"}]',
    "bots.json": '[{"name":"sample","pendingHeldWork":[{"id":"dummy"}]}]',
  });
  const copy = await copySyntheticPack(args);
  expect((await readdir(args.destination)).sort()).toEqual([
    "about-me.md", "bots.json", "data-version.json", "memory-index.db", "queued-messages.json", "search.db-wal", "workspaces",
  ]);
  expect(await readdir(join(args.destination, "workspaces", "nested"))).toEqual(["example.md"]);
  expect(copy.skipped).toEqual(expect.arrayContaining([
    "mcp-access.token", "sentinel-io", "mcp-grants.json", "pending-grants.json",
    "cloud-computer-turns.json", "unclassified.bin", "workspaces/nested/mcp-access.token",
  ]));
  expect(copy.emptied.sort()).toEqual(["bots.json", "queued-messages.json"]);
  expect(JSON.parse(await readFile(join(args.destination, "queued-messages.json"), "utf8"))).toEqual([]);
  expect(JSON.parse(await readFile(join(args.destination, "bots.json"), "utf8"))).toEqual([{ name: "sample", pendingHeldWork: [] }]);
  expect(await packInventoryViolations(args.destination)).toEqual([]);
  await writeFile(join(args.destination, "mcp-access.token"), "dummy marker");
  expect(await packInventoryViolations(args.destination)).toEqual(["mcp-access.token"]);
});

test("pack copy skips a symlink under an allowed name", async () => {
  const args = await fixture({ "sentinel-io/host.key": "dummy marker" });
  await symlink(join(args.source, "sentinel-io"), join(args.source, "workspaces"), "junction");
  await copySyntheticPack(args);
  expect(await readdir(args.destination)).toEqual([]);
});

test("pack copy requires synthetic input and leaves an existing destination untouched", async () => {
  const args = await fixture({ "about-me.md": "synthetic content" });
  await expect(copySyntheticPack({ ...args, kind: "real" })).rejects.toThrow("DATA_NOT_ALLOWED");
  await mkdir(args.destination);
  await expect(copySyntheticPack(args)).rejects.toThrow(/EEXIST/);
  expect(await readdir(args.destination)).toEqual([]);
});
