// F5n (Q-K5) Cursor reader: design docs/designs/1023-mcp-k5 r3 witnesses W3, W3c, W3d, W6, W6b, W6d, W7b, W17, W18 (R-K5),
// plus the r3 review build conditions Opus M1 (slot hint) and the Opus Low command+url case.
import { afterEach, expect, it } from "vitest";

import { decodeSource, type DecodedSource, type RefusedItem } from "./source-decode.ts";
import { listSourceCells, resetSourceReviews, reviewSources, sourceCellsState, type CellRead } from "./source-cells.ts";
import { cleanRoots, countingFs, memoryStore, opensOf, sentinel, tempHome } from "./source-fixtures.ts";

const roots: string[] = [];
afterEach(() => { cleanRoots(roots); resetSourceReviews(); });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decoded = (value: unknown) => decodeSource("cursor", bytes(value), []) as DecodedSource;
const one = (entry: unknown) => decoded({ mcpServers: { item: entry } });
const refusedOf = (entry: unknown) => one(entry).refused[0] as RefusedItem;

it("W3 ${env:...} values become slots named by their key and are never resolved; envFile is refused and never opened", () => {
  const token = sentinel("W3t"); const path = sentinel("W3p");
  process.env.FIXTURE_TOKEN = token; process.env.P = path;
  try {
    const h = tempHome(roots);
    h.put(".cursor/mcp.json", JSON.stringify({ mcpServers: {
      env: { command: "fixture-server", env: { TOKEN: "${env:FIXTURE_TOKEN}", PATH: "${env:P}" } },
      keyfile: { command: "fixture-server", envFile: "/home/fixture/.env" },
    } }));
    h.put(".env", `TOKEN=${token}`);
    const cells = listSourceCells({ home: h.home, platform: "linux", dataDir: "/x" });
    const cell = cells.find((c) => c.sourceKind === "cursor")!;
    const mem = memoryStore();
    mem.store.setOptIn(cells, "cursor", cell.cellId, true);
    const fs = countingFs();
    const review = reviewSources({ home: h.home, cells, store: mem.store, existingNames: [], fs }, [cell.cellId]);
    const read = (review as { reads: CellRead[] }).reads[0] as Extract<CellRead, { status: "read" }>;
    const server = read.decoded.servers[0]!;
    expect(server.plan.entry.pendingEnv).toEqual(["TOKEN", "PATH"]); // W3-slots
    expect(server.plan.entry.env).toEqual({});
    expect(JSON.stringify(review)).not.toContain(token);
    expect(JSON.stringify(review)).not.toContain(path);
    expect(read.decoded.refused).toEqual([{ name: "keyfile", reason: "key-file", fields: ["envFile"] }]);
    expect(opensOf(fs, ".env")).toBe(0);
  } finally { delete process.env.FIXTURE_TOKEN; delete process.env.P; }
});

it("W3c placeholders and references where a value is kept literally refuse that item only", () => {
  const out = decoded({ mcpServers: {
    a: { command: "${userHome}/bin/x" }, b: { command: "x", args: ["${workspaceFolder}"] }, c: { command: "x", args: ["${env:X}"] },
    d: { url: "https://${env:H}/m" }, ok: { command: "x", args: ["--flag"] },
  } });
  expect(out.servers.map((server) => server.name)).toEqual(["ok"]); // W3c-literal
  expect(Object.fromEntries(out.refused.map((item) => [item.name, item.fields]))).toEqual({ a: ["command"], b: ["args"], c: ["args"], d: ["url"] });
});

it("W3d a 'Bearer ${env:T}' header is the slot named by its header, never stored; the hint names the prefix and the variable, not the value", () => {
  const token = sentinel("W3d");
  process.env.FIXTURE_TOKEN = token;
  try {
    const out = one({ url: "https://mcp.example.invalid/m", headers: { Authorization: "Bearer ${env:FIXTURE_TOKEN}" } });
    expect(out.refused).toEqual([]); // W3d-slot
    const server = out.servers[0]!;
    expect(server.plan.entry.pendingHeaders).toEqual(["Authorization"]);
    expect(server.plan.entry.headers).toEqual({});
    expect(server.slotHints).toEqual({ Authorization: { prefix: "Bearer", from: "FIXTURE_TOKEN" } }); // M1-hint
    expect(JSON.stringify(out)).not.toContain(token);
    expect(JSON.stringify(out)).not.toContain("Bearer ${env");
  } finally { delete process.env.FIXTURE_TOKEN; }
});

it("W6 Cursor: auth and an unknown key refuse the item by name, no value text", () => {
  expect(refusedOf({ url: "https://mcp.example.invalid/m", auth: { CLIENT_ID: "v-client" } })).toEqual({ name: "item", reason: "oauth", fields: ["auth"] }); // W6-cursor
  const unknown = refusedOf({ command: "x", fixtureUnknown: "v-unknown" });
  expect(unknown).toEqual({ name: "item", reason: "cant-copy-setting", fields: ["fixtureUnknown"] });
});

it("W6b a key in the address refuses as 'has a key in its address'; an invalid name is refused by name, not skipped", () => {
  expect(refusedOf({ url: `https://x.invalid/m?key=${sentinel("W6b")}` })).toEqual({ name: "item", reason: "key-in-address", fields: ["url"] }); // W6b-url
  const bad = decoded({ mcpServers: { "bad/name": { command: "x" } } });
  expect(bad.servers).toEqual([]);
  expect(bad.refused).toEqual([{ name: "(unusable name)", reason: "cant-copy", fields: [] }]); // W6b-name
});

it("W6d headers: underscore, Murage-set and over-cap names refuse the item by name; env on a remote entry too", () => {
  for (const [headers, field] of [[{ API_KEY: "v" }, "API_KEY"], [{ Origin: "v" }, "Origin"], [{ "Content-Type": "v" }, "Content-Type"],
    [Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`X-Fixture-${i}`, "v"])), "X-Fixture-16"]] as const) {
    expect(refusedOf({ url: "https://mcp.example.invalid/m", headers })).toMatchObject({ reason: "cant-copy-setting", fields: expect.arrayContaining([field]) }); // W6d-headers
  }
  expect(refusedOf({ url: "https://mcp.example.invalid/m", env: { A: "b" } }).fields).toEqual(["env"]);
  expect(refusedOf({ url: "https://mcp.example.invalid/m", args: ["--x"] })).toMatchObject({ reason: "cant-copy-setting", fields: ["args"] }); // W6d-remote-args
});

it("W7b Cursor transport: no type → http, sse → sse, stdio → local, ws → refused naming type; command plus url → refused naming both", () => {
  expect(one({ url: "https://mcp.example.invalid/m" }).servers[0]!.plan.entry.transport).toBe("http"); // W7b-cursor
  expect(one({ url: "https://mcp.example.invalid/m", type: "sse" }).servers[0]!.plan.entry.transport).toBe("sse");
  expect(one({ command: "x", type: "stdio" }).servers[0]!.plan.kind).toBe("local");
  expect(refusedOf({ url: "https://mcp.example.invalid/m", type: "ws" })).toEqual({ name: "item", reason: "cant-copy-setting", fields: ["type"] });
  expect(refusedOf({ command: "x", type: "sse" }).fields).toEqual(["type"]);
  expect(refusedOf({ command: "x", url: "https://mcp.example.invalid/m" }).fields).toEqual(["command", "url"]);
});

it("W17 X8 open: Cursor skills are unavailable and never opened; GET /state makes no file call for any cell", () => {
  const h = tempHome(roots);
  h.put(".cursor/skills/s1/SKILL.md", "---\nname: s1\ndescription: d\n---\nbody");
  h.put(".cursor/mcp.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
  const cells = listSourceCells({ home: h.home, platform: "linux", dataDir: "/x" });
  const cursor = cells.find((c) => c.sourceKind === "cursor")!;
  expect(cursor.skills).toBe("unavailable");
  const mem = memoryStore();
  const fs = countingFs();
  // Pin (no code path to mutate): `sourceCellsState` takes no filesystem at all, so GET /state cannot open or stat an app file; its DTO has no path.
  const state = sourceCellsState(cells, mem.store);
  expect(state.every((row) => row.optIn === false && !("relParts" in row))).toBe(true);
  mem.store.setOptIn(cells, "cursor", cursor.cellId, true);
  const review = reviewSources({ home: h.home, cells, store: mem.store, existingNames: [], fs }, [cursor.cellId]);
  expect(((review as { reads: CellRead[] }).reads[0] as Extract<CellRead, { status: "read" }>).decoded.servers).toHaveLength(1);
  expect(fs.calls.some((call) => call.includes("skills"))).toBe(false); // W17-skills
});

it("review #4 more than 200 servers: the overflow is refused by name, never silently dropped", () => {
  const out = decoded({ mcpServers: Object.fromEntries(Array.from({ length: 202 }, (_, i) => [`s${String(i).padStart(3, "0")}`, { command: "x" }])) });
  expect(out.servers.length + out.refused.length).toBe(202); // W-overflow
});

it("W18 Cursor strict JSON: a comment is 'Couldn't read', zero items", () => {
  expect(decodeSource("cursor", new TextEncoder().encode('{ /* c */ "mcpServers": {} }'), [])).toEqual({ error: "couldNotRead" }); // W18-cursor
});

it("R2-H1 a remote entry with env: null refuses that one item by name; the sibling is still listed", () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ mcpServers: { bad: { url: "https://mcp.example.invalid/m", env: null }, ok: { command: "y" } } }));
  expect(() => decodeSource("cursor", bytes, [])).not.toThrow(); // R2-H1-cursor-nothrow
  const out = decodeSource("cursor", bytes, []) as DecodedSource;
  expect(out.servers.map((server) => server.name)).toEqual(["ok"]); // R2-H1-cursor-sibling
  expect(out.refused).toEqual([{ name: "bad", reason: "cant-copy-setting", fields: ["env"] }]); // R2-H1-cursor-refused
});
