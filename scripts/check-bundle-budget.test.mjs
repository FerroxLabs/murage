// The first-paint budget (spec §6: "CI fails if the first-paint brotli size
// goes over budget"). The real dist/ only exists after a build, so the logic
// is proved here against a fixture build: a manifest, an entry, a static
// import, a lazy chunk the first paint must NOT count, and the CSS.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { BROWSER_STATIC } from "../companion/src/routes.ts";
import { DOOR_ASSET, FIRST_PAINT_BROTLI_BUDGET, brotliSize, checkBudget, firstPaintFiles } from "./check-bundle-budget.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) safeWipeSync(root); });

/** A dist/ with random (incompressible) bytes, so brotli sizes are predictable. */
function fixture({ lazyName = "assets/CallView-Cc3.js" } = {}) {
  const dist = mkdtempSync(join(tmpdir(), "murage-budget-"));
  roots.push(dist);
  mkdirSync(join(dist, "assets"));
  mkdirSync(join(dist, ".vite"));
  const files = {
    "index.html": Buffer.from('<!doctype html><script type="module" src="/assets/index-Aa1.js"></script>'),
    "assets/index-Aa1.js": randomBytes(4000),
    "assets/vendor-Bb2.js": randomBytes(3000),
    "assets/index-Dd4.css": randomBytes(500),
    [lazyName]: randomBytes(50_000),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dist, name), bytes);
  const manifest = {
    "index.html": { file: "assets/index-Aa1.js", src: "index.html", isEntry: true, imports: ["_vendor-Bb2.js"], dynamicImports: ["src/components/CallView.tsx"], css: ["assets/index-Dd4.css"] },
    "_vendor-Bb2.js": { file: "assets/vendor-Bb2.js", imports: ["index.html"] },
    "src/components/CallView.tsx": { file: lazyName, isDynamicEntry: true, imports: ["_vendor-Bb2.js"] },
  };
  writeFileSync(join(dist, ".vite", "manifest.json"), JSON.stringify(manifest));
  return { dist, files, manifest };
}

describe("first-paint payload budget", () => {
  it("counts the entry, its static imports and their CSS, and not a lazy chunk", () => {
    const { manifest } = fixture();
    expect(firstPaintFiles(manifest)).toEqual(["assets/index-Aa1.js", "assets/index-Dd4.css", "assets/vendor-Bb2.js"]);
  });

  it("totals the brotli size of exactly those files plus the page", () => {
    const { dist, files } = fixture();
    const expected = ["index.html", "assets/index-Aa1.js", "assets/vendor-Bb2.js", "assets/index-Dd4.css"]
      .reduce((sum, name) => sum + brotliSize(files[name]), 0);
    const result = checkBudget(dist, 1_000_000);
    expect(result.total).toBe(expected);
    expect(result.ok).toBe(true);
  });

  it("fails one byte over the budget and passes at it", () => {
    const { dist } = fixture();
    const { total } = checkBudget(dist, 1_000_000);
    expect(checkBudget(dist, total).ok).toBe(true);
    expect(checkBudget(dist, total - 1).ok).toBe(false);
  });

  it("fails a chunk the browser door would 404, even a lazy one", () => {
    // companion/src/routes.ts serves /assets/ only for [\w-]+ segments: a
    // space in the name still 404s a phone while the desktop works.
    const { dist } = fixture({ lazyName: "assets/a b.js" });
    const result = checkBudget(dist, 1_000_000);
    expect(result.doorMisses).toEqual(["assets/a b.js"]);
    expect(result.ok).toBe(false);
  });

  it("no longer flags a dotted chunk name as a door miss", () => {
    // vite keeps a chunk's source name ahead of its hash, e.g.
    // `purify.es-Cz4mVeUR.js` — the door 404'd this until the fix (E4
    // first-paint budget, Hetzner build d489043f, first paint 698.0 KiB).
    const { dist } = fixture({ lazyName: "assets/purify.es-Cz4mVeUR.js" });
    const result = checkBudget(dist, 1_000_000);
    expect(result.doorMisses).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("agrees with the browser door about script and style names", () => {
    const door = BROWSER_STATIC.filter((entry) => entry.method === "GET").map((entry) => entry.path);
    const served = (name) => door.some((path) => path.test(`/${name}`));
    for (const name of ["assets/CallView-Cc3_x.js", "assets/index-Dd4.css", "assets/ort.wasm.min-Cc3.js", "assets/purify.es-Cz4mVeUR.js", "assets/a b.js", "assets/a..js", "assets/.js", "assets/a.js.map"]) {
      expect(DOOR_ASSET.test(name), name).toBe(served(name));
    }
  });

  it("refuses a dist/ without a manifest instead of passing it", () => {
    const dist = mkdtempSync(join(tmpdir(), "murage-budget-"));
    roots.push(dist);
    expect(() => checkBudget(dist)).toThrow(/build\.manifest/);
  });

  it("holds the budget the spec set, not a placeholder", () => {
    expect(FIRST_PAINT_BROTLI_BUDGET).toBe(720 * 1024);
  });
});
