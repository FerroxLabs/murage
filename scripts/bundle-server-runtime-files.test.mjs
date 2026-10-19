// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A server module that reads a file from beside itself at run time (not an import, so esbuild never sees it) needs that
// file copied next to its bundle, or the packaged server dies at boot: 1.0.3's drivers/murage-exec did exactly that
// (ENOENT .../res/server/murage-exec, the Linux package smoke timed out). Every such reader in server/ must be listed in
// scripts/bundle-server.mjs RUNTIME_SIBLINGS, which copies the file and fails the bundle if it cannot.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = join(root, "server");
const SKIP = /(\.test\.|\.bench\.|[\\/]testing[\\/]|[\\/]testdata[\\/]|fixture)/;
const SIBLING_READ = /readFileSync\(\s*join\(\s*dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)\s*,\s*["']([^"']+)["']\s*\)/g;

function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry) && !SKIP.test(full)) out.push(full);
  }
  return out;
}

const listed = [...readFileSync(join(root, "scripts", "bundle-server.mjs"), "utf8")
  .matchAll(/\{\s*reader:\s*"([^"]+)",\s*file:\s*"([^"]+)",\s*mode:\s*0o[0-7]+\s*\}/g)].map((m) => ({ reader: m[1], file: m[2] }));

test("every file a server module reads from beside itself is copied next to its bundle", () => {
  const readers = sources(server).flatMap((file) => [...readFileSync(file, "utf8").matchAll(SIBLING_READ)]
    .map((m) => ({ reader: relative(server, file).split("\\").join("/"), name: m[1] })))
    .filter(({ name }) => !/\.(?:m?[jt]s|json)$/.test(name));
  expect(readers.length).toBeGreaterThan(0); // the scan really reads the tree (murage-exec.ts is one)
  for (const { reader, name } of readers) {
    const file = join(dirname(reader), name).split("\\").join("/");
    expect(listed, `${reader} reads ${name}`).toContainEqual({ reader, file });
  }
});

test("every listed file exists in the tree", () => {
  expect(listed.length).toBeGreaterThan(0);
  for (const { reader, file } of listed) {
    expect(existsSync(join(server, reader)), reader).toBe(true);
    expect(existsSync(join(server, file)), file).toBe(true);
  }
});
