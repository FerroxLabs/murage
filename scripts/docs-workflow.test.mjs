import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const workflow = parse(readFileSync(join(root, ".github/workflows/docs.yml"), "utf8"));
const syncScript = new URL("../apps/docs/scripts/sync-assets.mjs", import.meta.url);
// Resolve the real input literals used by prebuild, rather than maintaining
// a test-only list that could agree with an equally stale workflow.
const inputs = [...readFileSync(syncScript, "utf8").matchAll(/new URL\('([^']+)', import\.meta\.url\)/g)]
  .map(([, path]) => relative(root, fileURLToPath(new URL(path, syncScript))).replaceAll("\\", "/"))
  .filter(path => !path.startsWith("apps/docs/"));
const matches = (path, patterns) => patterns.some(pattern => pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern);

describe("docs input trigger coverage (upstream 4f84fce3)", () => {
  it.each(["pull_request", "push"])("verifies shared asset changes on %s", (event) => {
    const patterns = workflow.on[event].paths;
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      const changed = input.endsWith(".svg") ? input : `${input}/new-screenshot.png`;
      expect(matches(changed, patterns), `${event} misses prebuild input ${changed}`).toBe(true);
    }
    expect(matches("apps/docs/content/docs/index.mdx", patterns)).toBe(true);
    expect(matches("server/unrelated.ts", patterns)).toBe(false);
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("copies the actual prebuild inputs offline without copying unrelated files", () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-doc-assets-"));
    try {
      const script = join(scratch, "apps/docs/scripts/sync-assets.mjs");
      mkdirSync(dirname(script), { recursive: true });
      mkdirSync(join(scratch, "docs/screenshots"), { recursive: true });
      mkdirSync(join(scratch, "public"));
      copyFileSync(syncScript, script);
      for (const extension of ["png", "jpg", "webp"]) writeFileSync(join(scratch, `docs/screenshots/fixture.${extension}`), `fixture-${extension}`);
      writeFileSync(join(scratch, "docs/screenshots/private.txt"), "do not copy");
      writeFileSync(join(scratch, "public/app-icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      execFileSync(process.execPath, [script], { cwd: scratch, timeout: 10_000 });
      for (const extension of ["png", "jpg", "webp"]) expect(readFileSync(join(scratch, `apps/docs/public/screenshots/fixture.${extension}`), "utf8")).toBe(`fixture-${extension}`);
      expect(readFileSync(join(scratch, "apps/docs/public/app-icon.svg"), "utf8")).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
      expect(existsSync(join(scratch, "apps/docs/public/screenshots/private.txt"))).toBe(false);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
