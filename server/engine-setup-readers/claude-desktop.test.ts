// F5n (Q-K5) Claude Desktop reader: design docs/designs/1023-mcp-k5 r3 witnesses W1, W2, W6, W6b, W6c, W6d, W18 (R-K5).
import { afterEach, expect, it } from "vitest";

import { decodeSource, decodeServer, type DecodedSource, type RefusedItem } from "./source-decode.ts";
import { checkSources, listSourceCells, resetSourceReviews, reviewSources, type CellRead } from "./source-cells.ts";
import { cleanRoots, countingFs, memoryStore, opensOf, sentinel, tempHome } from "./source-fixtures.ts";

const roots: string[] = [];
afterEach(() => { cleanRoots(roots); resetSourceReviews(); });
const CD = "Library/Application Support/Claude/claude_desktop_config.json";
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decoded = (value: unknown) => decodeSource("claude-desktop", bytes(value), []) as DecodedSource;
const refusedOf = (value: unknown, name = "item") => decoded({ mcpServers: { [name]: value } }).refused.find((item) => item.name === name) as RefusedItem;
const readOf = (reads: CellRead[]) => reads[0] as Extract<CellRead, { status: "read" }>;

function darwinSetup(file: unknown) {
  const h = tempHome(roots);
  h.put(CD, typeof file === "string" ? file : JSON.stringify(file));
  const cells = listSourceCells({ home: h.home, platform: "darwin", dataDir: "/nonexistent-murage-data" });
  const cell = cells.find((c) => c.sourceKind === "claude-desktop")!;
  const mem = memoryStore();
  mem.store.setOptIn(cells, "claude-desktop", cell.cellId, true);
  return { ...h, cells, cell, mem };
}

it("W1 lists both servers, a literal env key becomes its named slot and never leaves the file; preferences are never part of the revision", () => {
  const key = sentinel("W1");
  const file = { preferences: { theme: "dark" }, mcpServers: { files: { command: "npx", args: ["-y", "fixture-files"] }, keyed: { command: "fixture-keyed", env: { FIXTURE_API_KEY: key } } } };
  const s = darwinSetup(file);
  const fs = countingFs();
  const review = reviewSources({ home: s.home, cells: s.cells, store: s.mem.store, existingNames: [], fs }, [s.cell.cellId]);
  expect(review.status).toBe(200);
  const read = readOf((review as { reads: CellRead[] }).reads);
  expect(read.decoded.servers.map((server) => server.name)).toEqual(["files", "keyed"]);
  const keyed = read.decoded.servers.find((server) => server.name === "keyed")!;
  expect(keyed.plan.needsKey).toBe(true);
  expect(keyed.plan.entry.pendingEnv).toEqual(["FIXTURE_API_KEY"]);
  expect(JSON.stringify(review)).not.toContain(key); // W1-secret
  expect(keyed.plan.entry.disabledReason).toBe("Copied from Claude Desktop; turn on to use it");
  s.put(CD, JSON.stringify({ ...file, preferences: { theme: "light", extra: 1 } }));
  const check = checkSources({ home: s.home, cells: s.cells, store: s.mem.store, existingNames: [], fs }, [s.cell.cellId]);
  expect(readOf((check as { reads: CellRead[] }).reads).revision).toBe(read.revision); // W1-revision
});

it("W2 Windows: X9 open and an %APPDATA% outside <home> make the row unavailable with zero opens and no fallback", () => {
  const h = tempHome(roots);
  h.put("AppData/Roaming/Claude/claude_desktop_config.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
  for (const appData of [`${h.home}/AppData/Roaming`, "/elsewhere/AppData/Roaming"]) {
    const cells = listSourceCells({ home: h.home, platform: "win32", appData, dataDir: "/nonexistent-murage-data" });
    const cell = cells.find((c) => c.sourceKind === "claude-desktop")!;
    expect(cell.state).toBe("unqualified");
    expect(cell.relParts).toEqual([]); // W2-nofallback
    const mem = memoryStore({ [cell.cellId]: { optIn: true, epoch: 1 } });
    const fs = countingFs();
    expect(reviewSources({ home: h.home, cells, store: mem.store, existingNames: [], fs }, [cell.cellId])).toEqual({ status: 409, error: "source-unavailable" });
    expect(fs.calls).toEqual([]);
  }
  expect(listSourceCells({ home: h.home, platform: "linux", dataDir: "/x" }).some((c) => c.sourceKind === "claude-desktop")).toBe(false);
});

it("W6 Claude Desktop: cwd, url and an unknown key each refuse the item by name with no value text", () => {
  for (const [key, value] of [["cwd", "/tmp/fixture"], ["url", "https://x.invalid/m"], ["fixtureUnknown", "v-unknown"]] as const) {
    const item = refusedOf({ command: "fixture-server", [key]: value });
    expect(item).toMatchObject({ reason: "cant-copy-setting", fields: expect.arrayContaining([key]) }); // W6-closed
    expect(JSON.stringify(item)).not.toContain(value);
  }
});

it("W6b a secret-shaped arg refuses the item as 'has a key in its command line', never copied with emptied args", () => {
  const out = decoded({ mcpServers: { conn: { command: "fixture-db", args: ["--conn", sentinel("W6b")] } } });
  expect(out).toEqual({ servers: [], refused: [{ name: "conn", reason: "key-in-command-line", fields: ["args"] }] }); // W6b-args
  const many = refusedOf({ command: "fixture-db", args: Array.from({ length: 65 }, (_, i) => `a${i}`) });
  expect(many.reason).toBe("cant-copy-setting");
});

it("W6c Murage's own packaged entry is 'This is Murage itself'; a third-party mcp-server.js is not; DWEB_URL gets the generic reason", () => {
  const packaged = refusedOf({ command: "/Applications/Murage.app/Contents/MacOS/Murage", args: ["/Applications/Murage.app/Contents/Resources/server/mcp-server.js"], env: { ELECTRON_RUN_AS_NODE: "1", MURAGE_TOKEN: "fixture", MURAGE_PORT: "8799" } });
  expect(packaged.reason).toBe("murage-itself");
  expect(refusedOf({ command: "fixture", env: { ELECTRON_RUN_AS_NODE: "1" } })).toMatchObject({ reason: "murage-itself" }); // W6c-env
  expect(refusedOf({ command: "/opt/Murage/murage", args: ["/opt/Murage/resources/server/mcp-server.js"] })).toMatchObject({ reason: "murage-itself" }); // W6c-args
  const thirdParty = decoded({ mcpServers: { other: { command: "node", args: ["/home/fixture/tools/server/mcp-server.js"] } } });
  expect(thirdParty.servers.map((server) => server.name)).toEqual(["other"]); // W6c-third-party
  const dweb = refusedOf({ command: "fixture", env: { DWEB_URL: "x" } });
  expect(dweb.reason).toBe("cant-copy-setting"); // W6c-dweb
  expect(dweb.fields).toEqual(["DWEB_URL"]);
});

it("W6d invariant E: every input env key is stored byte-equal or a slot, every value typed, else refused by name; a token-shaped key is unnamed", () => {
  const cases: Array<[string, unknown, string]> = [
    ["lower", { command: "npx", env: { https_proxy: "http://proxy.invalid" } }, "https_proxy"],
    ["envStr", { command: "npx", env: "x" }, "env"],
    ["envNum", { command: "npx", env: { A: 1 } }, "env"],
    ["argNum", { command: "npx", args: ["--port", 8080] }, "args"],
    ["space", { command: " npx" }, "command"],
    ["localHeaders", { command: "npx", headers: { Authorization: "x" } }, "headers"],
    ["many", { command: "npx", env: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`FIXTURE_K${i}`, "v"])) }, "FIXTURE_K64"],
  ];
  for (const [name, entry, field] of cases) {
    expect(refusedOf(entry, name), name).toMatchObject({ reason: "cant-copy-setting", fields: expect.arrayContaining([field]) }); // W6d-invariant
  }
  const tokenKey = sentinel("Key");
  expect(refusedOf({ command: "npx", fixtureUnknown: 1, [tokenKey]: 1 }).fields).toEqual(["fixtureUnknown", null]); // W6d-display
  const clean = decoded({ mcpServers: { clean: { command: "npx", env: { PATH: "/usr/bin", FIXTURE_TOKEN: "t" } } } }).servers[0]!;
  expect([...Object.keys(clean.plan.entry.env as object), ...(clean.plan.entry.pendingEnv as string[])].sort()).toEqual(["FIXTURE_TOKEN", "PATH"]);
});

it("W18 strict JSON: a trailing comma or a comment reads the whole source as 'Couldn't read'; one leading BOM parses", () => {
  expect(decodeSource("claude-desktop", new TextEncoder().encode('{"mcpServers":{"a":{"command":"x"},}}'), [])).toEqual({ error: "couldNotRead" });
  expect(decodeSource("claude-desktop", new TextEncoder().encode('{"mcpServers":{"a":{"command":"x"}} // c\n}'), [])).toEqual({ error: "couldNotRead" }); // W18-strict
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes({ mcpServers: { a: { command: "x" } } })]);
  expect((decodeSource("claude-desktop", bom, []) as DecodedSource).servers.map((server) => server.name)).toEqual(["a"]);
  expect(decodeServer("claude-desktop", "bad name!", { command: "x" }, [])).toMatchObject({ reason: "cant-copy" });
});

it("W12 (part) an ON cell with no file is 'Nothing found', and the read made no open outside the configured file", () => {
  const h = tempHome(roots);
  const cells = listSourceCells({ home: h.home, platform: "darwin", dataDir: "/x" });
  const cell = cells.find((c) => c.sourceKind === "claude-desktop")!;
  const mem = memoryStore();
  mem.store.setOptIn(cells, "claude-desktop", cell.cellId, true);
  const fs = countingFs();
  const review = reviewSources({ home: h.home, cells, store: mem.store, existingNames: [], fs }, [cell.cellId]);
  expect((review as { reads: CellRead[] }).reads[0]!.status).toBe("nothingFound"); // W12-missing
  expect(opensOf(fs, ".cursor", ".gemini", ".claude")).toBe(0);
});
