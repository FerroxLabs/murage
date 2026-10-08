// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listSite, resolveSiteFolder, SITE_LIMITS } from "./site-files.ts";

let base = "";
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "publish-site-"))); mkdirSync(join(base, "site")); });
afterEach(() => rmSync(base, { recursive: true, force: true }));
const put = (rel: string, body = "x") => { const path = join(base, "site", rel); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, body); };
const failure = (run: () => unknown) => { try { run(); } catch (error) { return error as Error & { code?: string }; } throw new Error("expected a refusal"); };

it("lists the site files in order and totals their size", () => {
  put("index.html", "<h1>hi</h1>"); put("css/app.css", "body{}"); put("img/a.png", "png");
  const site = listSite(join(base, "site"));
  expect(site.files.map(file => file.rel)).toEqual(["css/app.css", "img/a.png", "index.html"]);
  expect(site.bytes).toBe(11 + 6 + 3);
  expect(site.skipped).toEqual([]);
});

it("leaves out dotfiles, keys, env files, memory and node_modules, and names what it left out", () => {
  put("index.html", "ok");
  for (const rel of [".env", ".env.local", ".git/config", ".DS_Store", "assets/.hidden", "MEMORY.md", "docs/memory.md", "notes/Memory.md",
    "server.pem", "id.key", "cert.p12", "cert.pfx", "id_rsa", "id_ed25519.pub", "node_modules/pkg/index.js", "secrets.json", "credentials.json"]) put(rel, "secret");
  const site = listSite(join(base, "site"));
  expect(site.files.map(file => file.rel)).toEqual(["index.html"]);
  expect(site.skipped.sort()).toEqual([".DS_Store", ".env", ".env.local", ".git", "assets/.hidden", "cert.p12", "cert.pfx", "credentials.json", "id.key", "id_ed25519.pub", "id_rsa", "node_modules", "notes/Memory.md", "MEMORY.md", "docs/memory.md", "secrets.json", "server.pem"].sort());
});

it("refuses a symlink anywhere in the site, even one that points inside it", () => {
  put("index.html", "ok"); put("real.txt", "real");
  symlinkSync(join(base, "site", "real.txt"), join(base, "site", "alias.txt"));
  const error = failure(() => listSite(join(base, "site")));
  expect(error.code).toBe("symlink");
  expect(error.message).toContain("alias.txt");
});

it("refuses a symlink that points outside the folder", () => {
  put("index.html", "ok"); writeFileSync(join(base, "outside.txt"), "private");
  symlinkSync(join(base, "outside.txt"), join(base, "site", "leak.txt"));
  expect(failure(() => listSite(join(base, "site"))).code).toBe("symlink");
});

it("refuses a site folder that is itself a symlink", () => {
  mkdirSync(join(base, "real")); writeFileSync(join(base, "real", "index.html"), "ok");
  symlinkSync(join(base, "real"), join(base, "linked"));
  expect(failure(() => listSite(join(base, "linked"))).code).toBe("symlink");
});

it("needs an index.html at the top and a folder that exists", () => {
  put("about.html", "x");
  expect(failure(() => listSite(join(base, "site"))).code).toBe("no-index");
  expect(failure(() => listSite(join(base, "missing"))).code).toBe("no-folder");
});

it("resolves the folder inside the bot workspace and refuses anything outside", () => {
  expect(resolveSiteFolder(base, "site")).toBe(join(base, "site"));
  expect(resolveSiteFolder(base, "./site/")).toBe(join(base, "site"));
  for (const bad of ["../x", "/etc", "site/../../x", "", "   ", "C:\\x", "a\\0b"]) expect(failure(() => resolveSiteFolder(base, bad)).code).toBe("outside");
  symlinkSync(tmpdir(), join(base, "escape"));
  expect(failure(() => resolveSiteFolder(base, "escape")).code).toBe("outside");
});

it("stops at the file count cap", () => {
  put("index.html", "ok");
  for (let i = 0; i < SITE_LIMITS.maxFiles; i++) put(`f/${i}.txt`, "x");
  const error = failure(() => listSite(join(base, "site")));
  expect(error.code).toBe("too-many-files");
  expect(error.message).toContain(String(SITE_LIMITS.maxFiles));
});

it("stops at the total size cap and names the biggest files", () => {
  put("index.html", "ok");
  const limits = { ...SITE_LIMITS, maxBytes: 1000, maxFileBytes: 900 };
  put("big.mp4", "x".repeat(600)); put("mid.png", "x".repeat(300)); put("small.css", "x".repeat(200));
  const error = failure(() => listSite(join(base, "site"), limits));
  expect(error.code).toBe("too-large");
  expect(error.message.indexOf("big.mp4")).toBeGreaterThan(-1);
  expect(error.message.indexOf("big.mp4")).toBeLessThan(error.message.indexOf("mid.png"));
});

it("stops at the single-file cap and names that file", () => {
  put("index.html", "ok"); put("movie.mov", "x".repeat(500));
  const error = failure(() => listSite(join(base, "site"), { ...SITE_LIMITS, maxFileBytes: 400 }));
  expect(error.code).toBe("too-large");
  expect(error.message).toContain("movie.mov");
});

it("refuses a file that is hard-linked to something else", () => {
  put("index.html", "ok"); writeFileSync(join(base, "private.txt"), "secret");
  linkSync(join(base, "private.txt"), join(base, "site", "innocent.txt"));
  expect(failure(() => listSite(join(base, "site"))).code).toBe("symlink");
});

it("refuses a site folder whose own path is hidden or protected", () => {
  mkdirSync(join(base, ".private", "site"), { recursive: true }); mkdirSync(join(base, "node_modules", "pkg"), { recursive: true });
  expect(failure(() => resolveSiteFolder(base, ".private/site")).code).toBe("outside");
  expect(failure(() => resolveSiteFolder(base, "node_modules/pkg")).code).toBe("outside");
});

it("keeps the bytes it read, so later changes on disk do not change the listing", () => {
  put("index.html", "first");
  const site = listSite(join(base, "site"));
  writeFileSync(join(base, "site", "index.html"), "second");
  expect(site.files[0]!.data.toString()).toBe("first");
});
