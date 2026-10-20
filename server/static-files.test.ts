// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStaticFile } from "./static-files.ts";

describe("static file resolution", () => {
  const root = "/opt/murage/dist";
  it("maps the root and ordinary assets inside the directory", () => {
    // the file is the platform's absolute path under the root (D:\opt\murage\dist\index.html on Windows)
    expect(resolveStaticFile(root, "/")).toEqual({ kind: "file", file: resolve(root, "index.html"), rel: "/index.html" });
    expect(resolveStaticFile(root, "/assets/app-1a2b.js")).toMatchObject({ kind: "file", file: resolve(root, "assets", "app-1a2b.js") });
    expect(resolveStaticFile(root, "/enter")).toMatchObject({ kind: "file" });
  });
  it("refuses traversal in every encoding", () => {
    for (const p of ["/../etc/passwd", "/%2e%2e/etc/passwd", "/%2E%2E/%2e%2e/x", "/assets/..%2f..%2fetc/passwd", "/assets/../../x", "/a/%2e%2e", "/..%5c..%5cx", "/a\\b", "/%00", "/x%00.js", "/%zz", "//etc/passwd", "/a//b", "etc/passwd"])
      expect(resolveStaticFile(root, p), p).toEqual({ kind: "refused" });
  });
  it("refuses dotfiles and dot-directories, including the build manifest directory", () => {
    for (const p of ["/.env", "/.git/config", "/.vite/manifest.json", "/assets/.hidden", "/%2eenv", "/.well-known/x"]) expect(resolveStaticFile(root, p), p).toEqual({ kind: "refused" });
  });
  it("is the handler index.ts uses, for GET and HEAD only", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toContain('(method === "GET" || method === "HEAD") && !path.startsWith("/api/") && STATIC_DIR');
    expect(index).toContain("resolveStaticFile(STATIC_DIR, path)");
    expect(index).toContain('method === "HEAD" ? undefined : data');
  });
});
