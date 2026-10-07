import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The desktop shell gives the server and companion a V8 compile cache folder.
// Once Node has read it, nothing they start (engine CLIs, MCP servers, bot
// commands, tool processes) may inherit it.
const STATEMENT = "delete process.env.NODE_COMPILE_CACHE;";
const entries = [
  ["server", new URL("./index.ts", import.meta.url)],
  ["companion", new URL("../companion/src/index.ts", import.meta.url)],
] as const;

describe("NODE_COMPILE_CACHE stays with the process that was started with it", () => {
  for (const [name, url] of entries) {
    it(`${name} entry removes it before it starts anything`, () => {
      const source = readFileSync(url, "utf8");
      const at = source.indexOf(STATEMENT);
      expect(at).toBeGreaterThan(0);
      expect(source.slice(0, at)).not.toMatch(/\b(spawn|fork|execFile)\(/);
      const env: Record<string, string | undefined> = { NODE_COMPILE_CACHE: "/cache/1.0", PATH: "/bin" };
      new Function("process", STATEMENT)({ env });
      expect(env).toEqual({ PATH: "/bin" });
    });
  }
});
