// F5n (Q-K5) Gemini CLI reader: design docs/designs/1023-mcp-k5 r3 witnesses W3b, W3c, W3d, W5 (trust flag part), W6, W7, W7b, W8, W17, W18
// (R-K5), plus Fable r3 M1 (Windows %NAME%, fail closed).
import { afterEach, expect, it } from "vitest";

import { decodeSource, stripJsonComments, type DecodedSource, type RefusedItem } from "./source-decode.ts";
import { listSourceCells, resetSourceReviews, reviewSources, type CellRead } from "./source-cells.ts";
import { cleanRoots, countingFs, memoryStore, opensOf, sentinel, tempHome } from "./source-fixtures.ts";

const roots: string[] = [];
afterEach(() => { cleanRoots(roots); resetSourceReviews(); });
const text = (value: string) => new TextEncoder().encode(value);
const decoded = (value: unknown) => decodeSource("gemini", text(JSON.stringify(value)), []) as DecodedSource;
const one = (entry: unknown) => decoded({ mcpServers: { item: entry } });
const refusedOf = (entry: unknown) => one(entry).refused[0] as RefusedItem;

it("W3b $NAME and ${NAME} are slots, never expanded; an allow-listed key with a reference mixed in refuses the item naming it", () => {
  const key = sentinel("W3b");
  process.env.FIXTURE_KEY = key;
  try {
    const out = one({ command: "fixture", env: { API_KEY: "$FIXTURE_KEY", B: "${FIXTURE_KEY}", C: "prefix-$FIXTURE_KEY" } });
    expect(out.servers[0]!.plan.entry.pendingEnv).toEqual(["API_KEY", "B", "C"]); // W3b-slots
    expect(JSON.stringify(out)).not.toContain(key);
    expect(refusedOf({ command: "fixture", env: { PATH: "$HOME/bin:$PATH" } })).toEqual({ name: "item", reason: "cant-copy-setting", fields: ["PATH"] }); // W3b-mixed
    expect(one({ command: "fixture", env: { PATH: "$FIXTURE_KEY" } }).servers[0]!.plan.entry.pendingEnv).toEqual(["PATH"]);
  } finally { delete process.env.FIXTURE_KEY; }
});

it("Fable M1 a Windows %NAME% reference is treated like $NAME: a slot where a slot is made, refused where kept literally", () => {
  expect(one({ command: "fixture", env: { PATH: "%FIXTURE_P%" } }).servers[0]?.plan.entry.pendingEnv).toEqual(["PATH"]); // M1-percent
  expect(refusedOf({ command: "fixture", args: ["%APPDATA%\\x"] }).fields).toEqual(["args"]);
});

it("W3c Gemini references in command and httpUrl refuse that item; siblings still listed", () => {
  const out = decoded({ mcpServers: { a: { command: "$TOOL" }, b: { httpUrl: "https://$H/m" }, ok: { command: "x" } } });
  expect(out.servers.map((server) => server.name)).toEqual(["ok"]); // W3c-gemini
  expect(Object.fromEntries(out.refused.map((item) => [item.name, item.fields]))).toEqual({ a: ["command"], b: ["httpUrl"] });
});

it("W3d a local 'Bearer $T' env value is the slot TOKEN; the literal value is nowhere", () => {
  const token = sentinel("W3dg");
  process.env.FIXTURE_TOKEN = token;
  try {
    const out = one({ command: "fixture", env: { TOKEN: "Bearer $FIXTURE_TOKEN" } });
    expect(out.refused).toEqual([]); // W3d-gemini
    expect(out.servers[0]?.plan.entry.pendingEnv).toEqual(["TOKEN"]);
    expect(out.servers[0]!.slotHints).toEqual({ TOKEN: { prefix: "Bearer", from: "FIXTURE_TOKEN" } });
    expect(JSON.stringify(out)).not.toContain("Bearer $");
    expect(JSON.stringify(out)).not.toContain(token);
  } finally { delete process.env.FIXTURE_TOKEN; }
});

it("W5 (adapter part) trust: true is dropped from the copy and flagged for the .trustDropped disclosure", () => {
  const server = one({ command: "fixture", trust: true, timeout: 5000, description: "d" }).servers[0]!;
  expect(server.trustDropped).toBe(true); // W5-trust
  expect(JSON.stringify(server.plan.entry)).not.toContain("trust");
});

it("W6 Gemini: tool filters, OAuth, cwd and tcp each refuse the item with category and field name", () => {
  const expected: Array<[string, unknown, string]> = [["includeTools", ["a"], "tool-filter"], ["excludeTools", ["a"], "tool-filter"], ["oauth", { enabled: true }, "oauth"],
    ["authProviderType", "google_credentials", "oauth"], ["cwd", "/tmp/fixture", "needs-folder"], ["tcp", "localhost:1", "cant-copy-setting"]];
  for (const [key, value, reason] of expected) expect(refusedOf({ command: "fixture", [key]: value })).toEqual({ name: "item", reason, fields: [key] }); // W6-gemini
});

it("W7 comments outside strings are stripped; '//' inside a string is kept byte-equal; an unterminated comment is 'Couldn't read'", () => {
  const file = '{\n // owner note\n "mcpServers": { /* block */ "a": { "command": "x", "args": ["https://x.invalid//p", "/* not a comment */"] } }\n}';
  const out = decodeSource("gemini", text(file), []) as DecodedSource;
  expect((out as Partial<DecodedSource>).servers?.[0]?.plan.entry.args).toEqual(["https://x.invalid//p", "/* not a comment */"]); // W7-strings
  expect(decodeSource("gemini", text('{ "mcpServers": {} /* open'), [])).toEqual({ error: "couldNotRead" });
  expect(stripJsonComments('"a\\"//b"')).toBe('"a\\"//b"');
});

it("W7b X10 open: Gemini url, httpUrl and url+type are refused by name, never silently skipped; a local sibling is listed", () => {
  const out = decoded({ mcpServers: {
    u: { url: "https://mcp.example.invalid/sse" }, h: { httpUrl: "https://mcp.example.invalid/m", headers: { Authorization: "Bearer $T" } },
    t: { url: "https://mcp.example.invalid/m", type: "http" }, both: { url: "https://a.invalid/m", httpUrl: "https://b.invalid/m" }, local: { command: "x" },
  } });
  expect(out.servers.map((server) => server.name)).toEqual(["local"]);
  const by = Object.fromEntries(out.refused.map((item) => [item.name, item]));
  expect(by.u).toEqual({ name: "u", reason: "unconfirmed-transport", fields: ["url"] }); // W7b-x10
  expect(by.h).toEqual({ name: "h", reason: "unconfirmed-transport", fields: ["httpUrl"] });
  expect(by.t!.reason).toBe("unconfirmed-transport");
  expect(by.t!.fields).toEqual(["url", "type"]);
  expect(by.both!.fields).toEqual(["url", "httpUrl"]);
});

it("W8 the configured instance's in-home GEMINI_CLI_HOME is read; the default root, Murage's process env, outside-home and Murage-data roots are not", () => {
  const h = tempHome(roots);
  h.put(".gemini/settings.json", JSON.stringify({ mcpServers: { fromDefault: { command: "x" } } }));
  h.put("alt/.gemini/settings.json", JSON.stringify({ mcpServers: { fromInstance: { command: "x" } } }));
  const saved = process.env.GEMINI_CLI_HOME;
  process.env.GEMINI_CLI_HOME = `${h.home}/other`;
  try {
    const dataDir = `${h.home}/murage-data`;
    const cells = listSourceCells({ home: h.home, platform: "linux", dataDir, geminiInstances: [
      { id: "g1", env: { GEMINI_CLI_HOME: `${h.home}/alt` } }, { id: "g2", env: { GEMINI_CLI_HOME: "/outside-home" } }, { id: "g3", env: { GEMINI_CLI_HOME: `${dataDir}/native/gemini-scope/x` } },
    ] });
    const [g1, g2, g3] = cells.filter((c) => c.sourceKind === "gemini");
    expect([g1!.state, g2!.state, g3!.state]).toEqual(["qualified", "refused", "refused"]); // W8-roots
    const mem = memoryStore();
    mem.store.setOptIn(cells, "gemini", g1!.cellId, true);
    const fs = countingFs();
    const review = reviewSources({ home: h.home, cells, store: mem.store, existingNames: [], fs }, [g1!.cellId]);
    const read = (review as { reads: CellRead[] }).reads[0] as Extract<CellRead, { status: "read" }>;
    expect(read.decoded.servers.map((server) => server.name)).toEqual(["fromInstance"]); // W8-instance
    expect(fs.calls.filter((call) => call.startsWith("open ") && call.includes("/other")).length).toBe(0);
    expect(mem.store.setOptIn(cells, "gemini", g2!.cellId, true)).toEqual({ status: 409, error: "source-unavailable" });
    const before = fs.calls.length;
    expect(reviewSources({ home: h.home, cells, store: memoryStore({ [g2!.cellId]: { optIn: true, epoch: 1 } }).store, existingNames: [], fs }, [g2!.cellId]).status).toBe(409);
    expect(fs.calls.length).toBe(before);
    expect(opensOf(fs, "settings.json")).toBe(1);
  } finally { if (saved === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = saved; }
});

it("W17 X7 open: Gemini skills are unavailable", () => {
  const cells = listSourceCells({ home: "/home/fixture", platform: "linux", dataDir: "/x" });
  expect(cells.find((c) => c.sourceKind === "gemini")!.skills).toBe("unavailable"); // W17-gemini
});

it("W18 a timeout or description change only leaves the revision unchanged", () => {
  const h = tempHome(roots);
  const put = (timeout: number) => h.put(".gemini/settings.json", JSON.stringify({ ui: { theme: timeout }, mcpServers: { a: { command: "x", timeout, description: `d${timeout}` } } }));
  const cells = listSourceCells({ home: h.home, platform: "linux", dataDir: "/x" });
  const g = cells.find((c) => c.sourceKind === "gemini")!;
  const mem = memoryStore();
  mem.store.setOptIn(cells, "gemini", g.cellId, true);
  const rev = () => ((reviewSources({ home: h.home, cells, store: mem.store, existingNames: [] }, [g.cellId]) as { reads: CellRead[] }).reads[0] as Extract<CellRead, { status: "read" }>).revision;
  put(1000); const first = rev();
  put(2000);
  expect(rev()).toBe(first); // W18-timeout
});

it("R2-H1 a local entry with headers: null refuses that one item by name; the sibling is still listed", () => {
  const input = { mcpServers: { bad: { command: "x", headers: null }, ok: { command: "y" } } };
  expect(() => decoded(input)).not.toThrow(); // R2-H1-gemini-nothrow
  const out = decoded(input);
  expect(out.servers.map((server) => server.name)).toEqual(["ok"]); // R2-H1-gemini-sibling
  expect(out.refused).toEqual([{ name: "bad", reason: "cant-copy-setting", fields: ["headers"] }]); // R2-H1-gemini-refused
});
