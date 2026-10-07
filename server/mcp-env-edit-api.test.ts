// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Editing what a command server runs while it holds saved env values asks the
// owner to keep or clear them; the harness refuses an edit that does not say
// (review L6). Boots node server/index.ts on a throwaway home.
import { describe, expect, it } from "vitest";

import { desktopApi } from "./testing/index-harness.ts";

const listing = async (name: string) => ((await desktopApi("GET", "/api/mcp/servers")).body.servers as Array<{ name: string; envKeys?: string[] }>).find((row) => row.name === name);

describe("a command edit never silently keeps saved env values", () => {
  it("refuses an edit that does not say, keeps on request, and clears on request", async () => {
    const name = "envedit";
    try {
      expect((await desktopApi("POST", "/api/mcp/servers", { name, command: "npx", args: ["-y", "@x/a"], env: { TOKEN: "v1" } })).status).toBe(201);
      const unsaid = await desktopApi("PUT", `/api/mcp/servers/${name}`, { command: "npx", args: ["-y", "@x/b"], env: { TOKEN: true } });
      expect(unsaid.status).toBe(400);
      expect(unsaid.body.code).toBe("env-choice");
      expect((await listing(name))?.envKeys).toEqual(["TOKEN"]);
      // an edit that leaves the command alone needs no answer
      expect((await desktopApi("PUT", `/api/mcp/servers/${name}`, { command: "npx", args: ["-y", "@x/a"], env: { TOKEN: true } })).status).toBe(200);
      const kept = await desktopApi("PUT", `/api/mcp/servers/${name}`, { command: "npx", args: ["-y", "@x/b"], env: { TOKEN: true }, keepSavedValues: true });
      expect(kept.status).toBe(200);
      expect((await listing(name))?.envKeys).toEqual(["TOKEN"]);
      const cleared = await desktopApi("PUT", `/api/mcp/servers/${name}`, { command: "node", args: ["x.js"], env: {}, keepSavedValues: false });
      expect(cleared.status).toBe(200);
      expect((await listing(name))?.envKeys).toEqual([]);
      // clearing never carries an old value across through a keep placeholder
      expect((await desktopApi("POST", "/api/mcp/servers", { name: "envedit2", command: "npx", args: [], env: { TOKEN: "v1" } })).status).toBe(201);
      const carried = await desktopApi("PUT", "/api/mcp/servers/envedit2", { command: "node", args: [], env: { TOKEN: true }, keepSavedValues: false });
      expect(carried.status).toBe(400);
    } finally {
      await desktopApi("DELETE", `/api/mcp/servers/${name}`);
      await desktopApi("DELETE", "/api/mcp/servers/envedit2");
    }
  });
});
