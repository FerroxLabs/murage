// The engine version manifest cannot drift from the constants that actually pin each engine.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("scripts/engine-versions.json", root), "utf8"));

describe("engine version manifest", () => {
  it("lists every bundled engine", () => {
    expect(Object.keys(manifest.engines).sort()).toEqual([
      "age", "agent-browser", "chrome-headless-shell", "cloudflared", "cua-driver", "cua-driver-container",
      "electron", "fuigo", "fuigo-qualified", "hermes", "restic",
    ]);
  });
  for (const [name, entry] of Object.entries(manifest.engines)) {
    it(`${name} equals the version its source pins`, () => {
      const match = new RegExp(entry.pattern).exec(readFileSync(new URL(entry.source, root), "utf8"));
      expect(match, `${entry.source} no longer matches ${entry.pattern}`).not.toBeNull();
      expect(entry.version).toBe(match[1]);
    });
  }
});
