// F5n (Q-K5) source cells and the epoch fence: design docs/designs/1023-mcp-k5 r3 witnesses W8b, W9, W9b, W9c(a), W10, W12 (cell part),
// W13 (state-function part), W15 (config part) (C-K5 + R-K5). Opt-in/opt-out always go through the real state function `setOptIn`.
import { afterEach, expect, it } from "vitest";

import { checkSources, commitFenced, configSourcesPersistence, listSourceCells, resetSourceReviews, reviewSources, SourceCellStore, sourcesFromConfig, type CellRead, type SourceCell } from "./engine-setup-readers/source-cells.ts";
import { cleanRoots, countingFs, memoryStore, opensOf, tempHome } from "./engine-setup-readers/source-fixtures.ts";

const roots: string[] = [];
afterEach(() => { cleanRoots(roots); resetSourceReviews(); });
const CD = "Library/Application Support/Claude/claude_desktop_config.json";
const servers = (name: string) => JSON.stringify({ mcpServers: { [name]: { command: "fixture-server" } } });

function setup() {
  const h = tempHome(roots);
  h.put(CD, servers("fromDesktop"));
  h.put(".cursor/mcp.json", servers("fromCursor"));
  const cells = listSourceCells({ home: h.home, platform: "darwin", dataDir: "/x" });
  const of = (kind: SourceCell["sourceKind"]) => cells.find((c) => c.sourceKind === kind)!;
  const mem = memoryStore();
  const on = (kind: SourceCell["sourceKind"], optIn = true) => mem.store.setOptIn(cells, kind, of(kind).cellId, optIn);
  return { ...h, cells, of, mem, on };
}

it("W8b a changed Gemini root is a new OFF cell; the startup prune drops only OFF unlisted cells and never runs on a save", () => {
  const h = tempHome(roots);
  h.put("a/.gemini/settings.json", servers("x")); h.put("b/.gemini/settings.json", servers("y"));
  const listA = listSourceCells({ home: h.home, platform: "linux", dataDir: "/x", geminiInstances: [{ id: "g", env: { GEMINI_CLI_HOME: `${h.home}/a` } }] });
  const listB = listSourceCells({ home: h.home, platform: "linux", dataDir: "/x", geminiInstances: [{ id: "g", env: { GEMINI_CLI_HOME: `${h.home}/b` } }] });
  const a = listA.find((c) => c.sourceKind === "gemini")!; const b = listB.find((c) => c.sourceKind === "gemini")!;
  expect(b.cellId).not.toBe(a.cellId); // W8b-cell
  const mem = memoryStore();
  mem.store.setOptIn(listA, "gemini", a.cellId, true);
  expect(mem.store.isOn(b.cellId)).toBe(false);
  mem.store.setOptIn(listA, "gemini", a.cellId, false);
  const fs = countingFs();
  expect(reviewSources({ home: h.home, cells: listB, store: mem.store, existingNames: [], fs }, [b.cellId])).toEqual({ status: 409, error: "reading-off" });
  expect(fs.calls).toEqual([]);
  const writesBefore = mem.writes;
  mem.store.setOptIn(listB, "cursor", listB.find((c) => c.sourceKind === "cursor")!.cellId, false);
  expect(Object.keys(mem.map())).toContain(a.cellId); // W8b-no-prune-on-save
  expect(mem.writes).toBe(writesBefore + 1);
  const off = "src_" + "0".repeat(24); const onUnlisted = "src_" + "1".repeat(24);
  const boot = memoryStore({ [off]: { optIn: false, epoch: 3 }, [onUnlisted]: { optIn: true, epoch: 2 }, [b.cellId]: { optIn: false, epoch: 1 } });
  boot.store.pruneAtStartup(listB);
  expect(Object.keys(boot.map()).sort()).toEqual([b.cellId, onUnlisted].sort()); // W8b-prune
});

it("W9 a Copy after opt-out is 409 stale-review with zero commits and zero opens; opting back in (e+2) does not revive it", async () => {
  const s = setup();
  s.on("cursor");
  const review = reviewSources({ home: s.home, cells: s.cells, store: s.mem.store, existingNames: [] }, [s.of("cursor").cellId]) as { reviewId: string };
  s.on("cursor", false);
  let commits = 0;
  expect(await commitFenced(s.mem.store, review.reviewId, { commit: () => { commits++; } })).toEqual({ status: 409, error: "stale-review" }); // W9-stale
  s.on("cursor");
  expect(s.mem.store.epoch(s.of("cursor").cellId)).toBe(3);
  expect(await commitFenced(s.mem.store, review.reviewId, { commit: () => { commits++; } })).toEqual({ status: 409, error: "stale-review" }); // W9-revive
  expect(commits).toBe(0);
});

it("W9b the whole bound map is compared: opting out of the second cell refuses a Copy of the review", async () => {
  const s = setup();
  s.on("cursor"); s.on("claude-desktop");
  const review = reviewSources({ home: s.home, cells: s.cells, store: s.mem.store, existingNames: [] }, [s.of("cursor").cellId, s.of("claude-desktop").cellId]) as { reviewId: string };
  s.on("claude-desktop", false);
  let commits = 0;
  expect(await commitFenced(s.mem.store, review.reviewId, { commit: () => { commits++; } })).toEqual({ status: 409, error: "stale-review" }); // W9b-whole
  expect(commits).toBe(0);
});

it("W9c(a) an opt-out of Cursor landing inside the Claude Desktop open stops the walk: Cursor's file is never opened, Review 409, no snapshot", () => {
  const s = setup();
  s.on("cursor"); s.on("claude-desktop");
  const fs = countingFs();
  fs.onOpen = (path) => { if (path.endsWith("/claude_desktop_config.json")) s.on("cursor", false); };
  const review = reviewSources({ home: s.home, cells: s.cells, store: s.mem.store, existingNames: [], fs }, [s.of("claude-desktop").cellId, s.of("cursor").cellId]);
  expect(review).toEqual({ status: 409, error: "stale-review" });
  expect(opensOf(fs, "mcp.json")).toBe(0);
  expect(opensOf(fs, ".cursor")).toBe(0);
  // Inside one walk: the opt-out lands at the open of a parent folder, so the opens after it (the Claude folder and the file) never happen.
  const walk = countingFs();
  walk.onOpen = (path) => { if (path.endsWith("/Library")) s.on("claude-desktop", false); };
  s.on("claude-desktop");
  expect(reviewSources({ home: s.home, cells: s.cells, store: s.mem.store, existingNames: [], fs: walk }, [s.of("claude-desktop").cellId])).toEqual({ status: 409, error: "stale-review" });
  expect(opensOf(walk, "claude_desktop_config.json", "Claude")).toBe(0); // W9c-fence
});

it("W10 an opt-out at beforeCommit (the last pre-commit await) refuses inside the synchronous segment: 409, persistMcp 0, nothing written", async () => {
  const s = setup();
  s.on("cursor");
  const review = reviewSources({ home: s.home, cells: s.cells, store: s.mem.store, existingNames: [] }, [s.of("cursor").cellId]) as { reviewId: string; reads: CellRead[] };
  const mcp: Record<string, unknown> = {};
  let persistMcp = 0;
  const commit = (reads: readonly CellRead[]) => {
    for (const read of reads) if (read.status === "read") for (const server of read.decoded.servers) mcp[server.plan.slug] = server.plan.entry;
    persistMcp++;
  };
  const result = await commitFenced(s.mem.store, review.reviewId, { beforeCommit: async () => { s.on("cursor", false); }, commit });
  expect(result).toEqual({ status: 409, error: "stale-review" }); // W10-segment
  expect(persistMcp).toBe(0);
  expect(mcp).toEqual({});
  s.on("cursor");
  const again = reviewSources({ home: s.home, cells: s.cells, store: s.mem.store, existingNames: [] }, [s.of("cursor").cellId]) as { reviewId: string };
  expect(await commitFenced(s.mem.store, again.reviewId, { commit })).toEqual({ status: 200 });
  expect(Object.keys(mcp)).toEqual(["fromcursor"]);
});

it("W12 (cell part) Check carries no reviewId, refuses an OFF cell before any open, and an unreadable file is 'Couldn't check', not 'gone'", () => {
  const s = setup();
  const fs = countingFs();
  const off = checkSources({ home: s.home, cells: s.cells, store: s.mem.store, existingNames: [], fs }, [s.of("cursor").cellId]);
  expect((off as { reads: CellRead[] }).reads[0]!.status).toBe("readingOff"); // W12-off
  expect(fs.calls).toEqual([]);
  s.on("cursor");
  const eacces = countingFs();
  const realOpen = eacces.openSync;
  eacces.openSync = (path, flags) => { if (path.endsWith("/mcp.json")) throw Object.assign(new Error("denied"), { code: "EACCES" }); return realOpen(path, flags); };
  const check = checkSources({ home: s.home, cells: s.cells, store: s.mem.store, existingNames: [], fs: eacces }, [s.of("cursor").cellId]);
  expect((check as { reads: CellRead[] }).reads[0]!.status).toBe("couldNotRead"); // W12-eacces
});

it("review #5 an async commit is refused: the compare and the writes must stay in one synchronous segment", async () => {
  const s = setup();
  s.on("cursor");
  const review = reviewSources({ home: s.home, cells: s.cells, store: s.mem.store, existingNames: [] }, [s.of("cursor").cellId]) as { reviewId: string };
  await expect(commitFenced(s.mem.store, review.reviewId, { commit: (async () => {}) as never })).rejects.toThrow("must be synchronous"); // W10-async
});

it("W13 (state function) unknown kind, unlisted cell, a path as cellId and an UNQUALIFIED cell are refused before any open", () => {
  const h = tempHome(roots);
  const cells = listSourceCells({ home: h.home, platform: "win32", appData: `${h.home}/AppData/Roaming`, dataDir: "/x" });
  const mem = memoryStore();
  const cursor = cells.find((c) => c.sourceKind === "cursor")!;
  expect(mem.store.setOptIn(cells, "windsurf", cursor.cellId, true).status).toBe(400); // W13-refused
  expect(mem.store.setOptIn(cells, "cursor", "src_" + "9".repeat(24), true).status).toBe(400);
  expect(mem.store.setOptIn(cells, "cursor", `${h.home}/.cursor/mcp.json`, true).status).toBe(400);
  expect(mem.store.setOptIn(cells, "claude-desktop", cells.find((c) => c.sourceKind === "claude-desktop")!.cellId, true).status).toBe(409);
  expect(mem.writes).toBe(0);
});

it("W15 (config part) a restored config has no source cells: every cell reads OFF, the next opt-in is epoch 1, a pre-restart review is unknown", async () => {
  const restored = { engineDiscovery: "explicit", instances: {} };
  const cfg: { engineSetup?: { sources?: Record<string, { optIn: boolean; epoch: number }> }; [key: string]: unknown } = { ...restored };
  const saved: unknown[] = [];
  const store = new SourceCellStore(configSourcesPersistence(() => cfg, (patch) => saved.push(patch)));
  const h = tempHome(roots);
  h.put(".cursor/mcp.json", servers("fromCursor"));
  const cells = listSourceCells({ home: h.home, platform: "linux", dataDir: "/x" });
  expect(cells.every((cell) => !store.isOn(cell.cellId))).toBe(true);
  const cursor = cells.find((c) => c.sourceKind === "cursor")!;
  expect(store.setOptIn(cells, "cursor", cursor.cellId, true)).toEqual({ status: 200, optIn: true, epoch: 1 });
  expect(saved).toEqual([{ engineSetup: { sources: { [cursor.cellId]: { optIn: true, epoch: 1 } } } }]);
  const old = reviewSources({ home: h.home, cells, store, existingNames: [] }, [cursor.cellId]) as { reviewId: string };
  resetSourceReviews(); // the restart: snapshots are in memory only
  expect(await commitFenced(store, old.reviewId, { commit: () => { throw new Error("must not commit"); } })).toEqual({ status: 409, error: "stale-review" });
  expect(sourcesFromConfig({ engineSetup: { sources: { "../x": { optIn: true, epoch: 1 } } } })).toEqual({});
});
