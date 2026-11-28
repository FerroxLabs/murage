// G2: the roster-only offer must actually create usable bots through the desktop route.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startDesktopShell } from "./testing/desktop-shell.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { TERMS_VERSION } from "../shared/terms.ts";

it("moves a roster-only bot on the default engine, unpinned, and retains it after restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "murage-roster-import-"));
  let shell: Awaited<ReturnType<typeof startDesktopShell>> | undefined;
  try {
    mkdirSync(join(home, ".murage"));
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: {} }));
    const folder = join(home, ".config", "Grok Bot", "sand-client-persistence");
    mkdirSync(folder, { recursive: true });
    // Canonical base32 of sand.client.slice.account.user%2E1.roster.last-roster, from the upstream fixture schema.
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    let value = 0, bits = 0, name = "";
    for (const byte of Buffer.from("sand.client.slice.account.user%2E1.roster.last-roster")) {
      value = (value << 8) | byte; bits += 8;
      while (bits >= 5) { name += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
      value &= (1 << bits) - 1;
    }
    if (bits) name += alphabet[(value << (5 - bits)) & 31];
    writeFileSync(join(folder, `${name}.blob`), JSON.stringify({ schemaVersion: 1, value: { rows: [{ id: "b1", name: "Drew" }] } }));
    // Past the terms screen: Grok Bot data is not looked for before the terms are accepted (1.0.21 row).
    shell = await startDesktopShell({ home, env: { MURAGE_TERMS_ACCEPTED: TERMS_VERSION } });
    const found = await shell.desktop("GET", "/api/move-in/found");
    expect(found).toMatchObject({ status: 200, body: { grok: { count: 1 } } });
    const moved = await shell.desktop("POST", "/api/move-in/grok", {});
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.moved).toEqual(["Drew"]);
    expect(moved.body.notes.join(" ")).toMatch(/names only/);
    const bots = (await shell.desktop("GET", "/api/bots")).body.bots;
    const drew = bots.find((bot: { name: string }) => bot.name === "Drew");
    expect(drew).toBeDefined();
    expect(drew.pinned).not.toBe(true);
    expect(drew.modelSelection).toBeDefined();
    await shell.restart();
    expect((await shell.desktop("GET", "/api/bots")).body.bots.filter((bot: { name: string }) => bot.name === "Drew")).toHaveLength(1);
    expect((await shell.desktop("POST", "/api/move-in/grok", {})).body.moved).toEqual(["Drew"]);
    expect((await shell.desktop("GET", "/api/bots")).body.bots.filter((bot: { name: string }) => bot.name === "Drew")).toHaveLength(1);
  } finally {
    await shell?.stop();
    await removeTempDir(home);
  }
}, 90_000);
