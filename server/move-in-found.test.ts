import { describe, expect, it, vi } from "vitest";

import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { removeTempDirSync } from "./testing/cleanup.ts";

import { convertGrokExports, findMoveIn, forgetGrokCount, grokCountForSetup, grokCountPending, grokCountReading, offMain, PENDING_MAX_MS, stuckProbeCount, readGrokExports, realMoveInFs, type MoveInFs } from "./move-in-found.ts";

const HOME = join("/", "home", "fixture");

const EXPORT = JSON.stringify({ name: "Helper", instructions: "Help.", skills: [], routines: [] });

function fixtureFs(files: Record<string, string>, opened: string[] = []): MoveInFs {
  return {
    home: () => HOME,
    list: (dir) => {
      if (dir !== join(HOME, "Downloads")) throw new Error(`listed ${dir}`);
      return Object.keys(files);
    },
    size: (path) => files[basename(path)]?.length ?? null,
    read: (path) => {
      opened.push(path);
      return files[basename(path)]!;
    },
  };
}

describe("F1 and F2 the finder", () => {
  it("returns a label and a count, never a path, and opens only grok export files in Downloads", async () => {
    const opened: string[] = [];
    const fs = fixtureFs({ "grok-bot-export.json": EXPORT, "sand-secrets.json": "{}", "cookies.json": "{}", "notes.txt": "x", "Grok Helper.json": EXPORT }, opened);
    const found = await findMoveIn(fs);
    expect(Object.keys(found.grok).sort()).toEqual(["count", "label"]);
    expect(JSON.stringify(found)).not.toContain("/home");
    expect(opened.map((path) => basename(path)).sort()).toEqual(["Grok Helper.json", "grok-bot-export.json"]);
    expect((await readGrokExports(fixtureFs({ "sand-secrets.json": "{}" }))).length).toBe(0);
  });
});

describe("F2b names that say chat, cookie or secret are never opened", () => {
  it("skips them before reading, whatever they hold", async () => {
    const opened: string[] = [];
    const fs = fixtureFs({ "grok-chat.json": EXPORT, "grok-conversations.json": EXPORT, "grok-cookies.json": EXPORT, "grok-secrets.json": EXPORT, "grok-bot-export.json": EXPORT }, opened);
    expect((await readGrokExports(fs)).length).toBe(1);
    expect(opened.map((path) => basename(path))).toEqual(["grok-bot-export.json"]);
  });
  it("the real reader skips a link and does not follow it", async () => {
    const root = mkdtempSync(join(tmpdir(), "move-in-"));
    try {
      writeFileSync(join(root, "outside.json"), EXPORT);
      mkdirSync(join(root, "Downloads"));
      symlinkSync(join(root, "outside.json"), join(root, "Downloads", "grok-export.json"));
      writeFileSync(join(root, "Downloads", "grok-bot-real.json"), EXPORT);
      const real: MoveInFs = { ...realMoveInFs, home: () => root };
      expect(await readGrokExports(real)).toEqual([EXPORT]);
      await expect((async () => realMoveInFs.read(join(root, "Downloads", "grok-export.json")))()).rejects.toThrow();
    } finally {
      removeTempDirSync(root);
    }
  });
});

describe("F2c only bot-export names, and never through a linked Downloads", () => {
  it("skips names that are not exports, and a Downloads that is not a real directory", async () => {
    const opened: string[] = [];
    const fs = fixtureFs({ "grok-config.json": EXPORT, "grok-settings.json": EXPORT, "grok-bot-export (1).json": EXPORT }, opened);
    expect((await readGrokExports(fs)).length).toBe(1);
    expect(opened.map((path) => basename(path))).toEqual(["grok-bot-export (1).json"]);
    expect(await readGrokExports({ ...fixtureFs({ "grok-bot-export.json": EXPORT }), realDir: () => false })).toEqual([]);
  });
});

describe("F3 a throwing finder", () => {
  it("is a count of 0", async () => {
    const broken: MoveInFs = { home: () => { throw new Error("no home"); }, list: () => [], size: () => 0, read: () => "" };
    expect((await findMoveIn(broken)).grok.count).toBe(0);
    forgetGrokCount();
    expect(grokCountForSetup(broken)).toBe(0);
    await grokCountReading();
    expect(grokCountForSetup(broken)).toBe(0);
  });
});

describe("F4 a listing the OS holds (1.0.21 row: the macOS Downloads question)", () => {
  it("the setup count is never waited for: the last count at once, the fresh one once read", async () => {
    forgetGrokCount();
    const fs = fixtureFs({ "grok-bot-export.json": EXPORT });
    expect(grokCountForSetup(fs, 1_000)).toBe(0);
    await grokCountReading();
    expect(grokCountForSetup(fs, 2_000)).toBe(1);
    expect(grokCountReading()).toBeNull();
  });
  it("a held listing keeps answering the last count and starts no second listing, whoever asks", async () => {
    forgetGrokCount();
    let listings = 0;
    const held: MoveInFs = { ...fixtureFs({}), list: () => { listings++; return new Promise<string[]>(() => {}); } };
    expect(grokCountForSetup(held, 1_000)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listings).toBe(1);
    // Polled long after the count went stale, the move-in step asked too, and a move-in reset the count: still one listing.
    expect(grokCountForSetup(held, 120_000)).toBe(0);
    void findMoveIn(held);
    forgetGrokCount();
    expect(grokCountForSetup(held, 240_000)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listings).toBe(1);
    forgetGrokCount();
  });
  it("a reading older than a move-in never writes its count over the reset", async () => {
    forgetGrokCount();
    let release!: (names: string[]) => void;
    const slow: MoveInFs = { ...fixtureFs({ "grok-bot-export.json": EXPORT }), list: () => new Promise<string[]>((resolve) => { release = resolve; }) };
    expect(grokCountForSetup(slow, 1_000)).toBe(0);
    const older = grokCountReading();
    await new Promise((resolve) => setTimeout(resolve, 10));
    forgetGrokCount();
    release(["grok-bot-export.json"]);
    await older;
    expect(grokCountReading()).toBeNull();
    // The count a fresh reading writes, not the older one's.
    expect(grokCountForSetup(fixtureFs({}), 2_000)).toBe(0);
    await grokCountReading();
    expect(grokCountForSetup(fixtureFs({}), 3_000)).toBe(0);
    forgetGrokCount();
  });
});

// Format evidence: OpenMausBot 2fa2a08e2 server/grok-local.ts and its fixture,
// located by _ev/designs/UPSTREAM-SETTINGS-DIFF-1106.md. No live data used.
const base32 = (text: string) => {
  let bits = 0, value = 0, out = "";
  for (const byte of Buffer.from(text)) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += "abcdefghijklmnopqrstuvwxyz234567"[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  return out + (bits ? "abcdefghijklmnopqrstuvwxyz234567"[(value << (5 - bits)) & 31] : "");
};
const slice = (kind: string) => `${base32(`sand.client.slice.account.user%2E1.${kind}`)}.blob`;
const roster = JSON.stringify({ schemaVersion: 1, value: { rows: [
  { id: "b1", name: "Drew" }, { id: "b2", name: "Helper" }, { name: "Group", isGroup: true },
] } });
const folders = ["Library/Application Support/Grok Bot", "AppData/Roaming/Grok Bot", ".config/Grok Bot"];
function rosterFs(folder: string, raw = roster) {
  const cache = join(HOME, ...folder.split("/"), "sand-client-persistence");
  const opened: string[] = [];
  const fs: MoveInFs = {
    home: () => HOME,
    realDir: () => true,
    list: (dir) => dir === cache ? [slice("transcript.replicas.b1"), "sand-secrets.json", slice("settings.tokens"), slice("roster.last-roster")] : [],
    size: () => Buffer.byteLength(raw),
    read: (path) => {
      opened.push(path);
      if (path !== join(cache, slice("roster.last-roster"))) throw new Error("must not read other slices");
      return raw;
    },
  };
  return { fs, opened, cache };
}

describe("G2 roster-only discovery and import", () => {
  for (const folder of folders) it(`discovers and converts the names-only roster at ${folder}`, async () => {
    const { fs, opened, cache } = rosterFs(folder);
    expect(await findMoveIn(fs)).toEqual({ grok: { label: "Grok Bot", count: 2 } });
    const packages = await convertGrokExports(fs);
    expect(packages.map((p) => p.document.package.agents[0].name)).toEqual(["Drew", "Helper"]);
    for (const p of packages) {
      expect(p.document.package.routines ?? []).toEqual([]);
      expect(p.document.package.playbooks ?? []).toEqual([]);
      expect(p.notes.join(" ")).toMatch(/names only/i);
    }
    expect(new Set(opened)).toEqual(new Set([join(cache, slice("roster.last-roster"))]));
  });
  it("fails closed on malformed or unknown envelopes, groups and oversized slices", async () => {
    for (const raw of ["bad json", '{"value":{"rows":"unknown"}}', '{"schemaVersion":2,"value":{"rows":[{"name":"Drew"}]}}', '{"schemaVersion":1,"value":{"rows":[{"name":"Group","isGroup":true}]}}']) {
      expect((await findMoveIn(rosterFs(folders[0], raw).fs)).grok.count).toBe(0);
    }
    const { fs, opened } = rosterFs(folders[0]);
    expect((await findMoveIn({ ...fs, size: () => 33 * 1024 * 1024 })).grok.count).toBe(0);
    expect(opened).toEqual([]);
    expect((await findMoveIn({ ...fs, realDir: () => false })).grok.count).toBe(0);
    expect(opened).toEqual([]);
  });
  it("prefers an export to a names-only roster entry for the same bot", async () => {
    const { fs } = rosterFs(folders[0]);
    const converted = await convertGrokExports({ ...fs,
      list: (dir) => dir.endsWith("Downloads") ? ["grok-bot-export.json"] : fs.list(dir),
      read: (path) => path.endsWith("grok-bot-export.json") ? EXPORT : fs.read(path),
    });
    expect(converted.map((p) => p.document.package.agents[0].name).sort()).toEqual(["Drew", "Helper"]);
    expect(converted.find((p) => p.document.package.agents[0].name === "Helper")!.document.package.agents[0].description).toBe("Help.");
  });
});

it("G2 never follows a linked roster file or a linked cache ancestor", async () => {
  const root = mkdtempSync(join(tmpdir(), "move-in-roster-links-"));
  try {
    const outside = join(root, "outside");
    mkdirSync(join(outside, "Grok Bot", "sand-client-persistence"), { recursive: true });
    writeFileSync(join(outside, "Grok Bot", "sand-client-persistence", slice("roster.last-roster")), roster);
    const home = join(root, "home");
    mkdirSync(home);
    symlinkSync(outside, join(home, ".config"), "junction");
    const opened: string[] = [];
    const fs: MoveInFs = { ...realMoveInFs, home: () => home, read: (path, cap) => { opened.push(path); return realMoveInFs.read(path, cap); } };
    expect((await findMoveIn(fs)).grok.count).toBe(0);
    expect(opened).toEqual([]);
    const app = join(home, "Library", "Application Support", "Grok Bot", "sand-client-persistence");
    mkdirSync(app, { recursive: true });
    symlinkSync(join(outside, "Grok Bot", "sand-client-persistence", slice("roster.last-roster")), join(app, slice("roster.last-roster")));
    expect((await findMoveIn(fs)).grok.count).toBe(0);
    expect(opened).toEqual([]);
  } finally { removeTempDirSync(root); }
});

it("G2 imports only names from a roster, never other row fields or credential-looking names", async () => {
  // MAIN RULING INT-CONFLICT-DEFAULT 76e4f565de 26d4947565: keep newer reviewed neutral fixture and redaction assertions.
  const credential = `sk-${"a".repeat(32)}`;
  const raw = JSON.stringify({ schemaVersion: 1, value: { rows: [
    { name: "Drew", instructions: "ROW_PRIVATE_TEXT", skills: ["ROW_PRIVATE_TEXT"], messages: ["ROW_PRIVATE_TEXT"] },
    { name: `api_key=${credential}` },
  ] } });
  const result = await convertGrokExports(rosterFs(folders[0], raw).fs);
  expect(result.map((p) => p.document.package.agents[0].name)).toEqual(["Drew"]);
  expect(JSON.stringify(result)).not.toContain("ROW_PRIVATE_TEXT");
  // MAIN RULING 2026-11-14 neutral generated fixture value keeps the credential-name exclusion assertion.
  expect(JSON.stringify(result)).not.toContain(credential);
});

it("G2 refuses a final-file link even when the OS has no O_NOFOLLOW", async () => {
  const root = mkdtempSync(join(tmpdir(), "move-in-no-follow-"));
  try {
    writeFileSync(join(root, "private.json"), roster);
    symlinkSync(join(root, "private.json"), join(root, "roster.blob"));
    vi.doMock("node:fs", async () => {
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...fs, constants: { ...fs.constants, O_NOFOLLOW: 0 } };
    });
    vi.resetModules();
    const { realMoveInFs: withoutNoFollow } = await import("./move-in-found.ts");
    await expect((async () => withoutNoFollow.read(join(root, "roster.blob")))()).rejects.toThrow();
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
    removeTempDirSync(root);
  }
});

describe("F5 a first reading that never settles cannot hold setup for ever", () => {
  it("is pending for a bounded time, then released, and the late count still lands", async () => {
    forgetGrokCount();
    let release: (names: string[]) => void = () => {};
    const held: MoveInFs = { ...fixtureFs({ "grok-bot-export.json": EXPORT }), list: () => new Promise<string[]>((resolve) => { release = resolve; }) };
    expect(grokCountPending(1_000)).toBe(false);
    grokCountForSetup(held, 1_000);
    expect(grokCountPending(1_000 + PENDING_MAX_MS - 1)).toBe(true);
    expect(grokCountPending(1_000 + PENDING_MAX_MS)).toBe(false);
    release(["grok-bot-export.json"]);
    await grokCountReading();
    expect(grokCountForSetup(held, 1_000 + PENDING_MAX_MS + 1)).toBe(1);
    forgetGrokCount();
  });
});

describe("the folder probes run off the main thread", () => {
  it("a listing the OS never answers is given up on time, holds one worker only, and the main thread keeps ticking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "move-in-probe-"));
    const held = join(dir, "Downloads");
    const release = join(dir, "release");
    mkdirSync(held);
    const hook = Symbol.for("murage.moveIn.probePrelude");
    (globalThis as Record<symbol, unknown>)[hook] = `
      const heldFs = require("node:fs");
      const heldList = heldFs.readdirSync;
      heldFs.readdirSync = function (dir, ...rest) {
        while (require("node:path").basename(String(dir)) === "Downloads" && !heldFs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        return heldList.call(this, dir, ...rest);
      };`;
    try {
      let ticks = 0;
      const ticker = setInterval(() => { ticks++; }, 10);
      const started = performance.now();
      await expect(offMain("list", held, 300)).rejects.toThrow("held too long");
      expect(performance.now() - started).toBeLessThan(1500);
      // The main thread was never blocked while the listing was held.
      expect(ticks).toBeGreaterThan(10);
      clearInterval(ticker);
      expect(stuckProbeCount()).toBe(1);
      // While that worker is still stuck, a second probe is refused at once rather than taking another thread.
      const again = performance.now();
      await expect(offMain("list", held, 300)).rejects.toThrow("still held");
      expect(performance.now() - again).toBeLessThan(100);
      // Once the OS lets go, probing works again.
      writeFileSync(release, "");
      await vi.waitFor(() => expect(stuckProbeCount()).toBe(0), { timeout: 5000 });
      expect(existsSync(release)).toBe(true);
      expect(await offMain<string[]>("list", dir, 5000)).toContain("Downloads");
    } finally {
      delete (globalThis as Record<symbol, unknown>)[hook];
      removeTempDirSync(dir);
    }
  });
});
