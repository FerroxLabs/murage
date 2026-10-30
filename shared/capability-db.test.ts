// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The capability database (CAPABILITY-DB-1010): the YAML under
// shared/capabilities is valid, the generated shared/capability-db.ts is fresh,
// every settings path is one the app renders and belongs to the thing the
// entry's anchor names, and `rev` moves only when a fact moves.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { CAPABILITY_DB_REV, CAPABILITY_ENTRIES } from "./capability-db.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "build-capability-db.mjs");
const SOURCE = join(root, "shared", "capabilities");
const scratch = mkdtempSync(join(tmpdir(), "capdb-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

let fixtureCount = 0;
/** A copy of the real YAML with one change, checked against a fresh generated file of its own. */
function checkFixture(mutate: (files: Map<string, { schema: number; entries: Record<string, unknown>[]; retired?: unknown[] }>) => void) {
  const dir = join(scratch, `src-${fixtureCount += 1}`);
  cpSync(SOURCE, dir, { recursive: true });
  const files = new Map(readdirSync(dir).filter((name) => name.endsWith(".yaml")).map((name) => [name, parse(readFileSync(join(dir, name), "utf8"))]));
  mutate(files);
  for (const [name, doc] of files) writeFileSync(join(dir, name), stringify(doc));
  const out = join(scratch, `db-${fixtureCount}.ts`);
  const written = run(["--src", dir, "--out", out]);
  if (!written.ok) return written;
  return run(["--check", "--src", dir, "--out", out]);
}
const entry = (files: Map<string, { entries: Record<string, unknown>[] }>, id: string) => {
  for (const doc of files.values()) {
    const found = doc.entries.find((candidate) => candidate.id === id);
    if (found) return found;
  }
  throw new Error(`no entry ${id}`);
};

const SLICE = [
  "apps.chat-approval-buttons", "apps.own-browser", "bots.channel-turns", "bots.rename-chief",
  "engines.continue-with-chatgpt-grok", "engines.grok-images", "engines.openai-compatible-tools",
  "install-account.policy-lock", "install-account.ubuntu-computer-control", "limits.spending-per-bot",
  "memory.learn-about-me", "memory.pin",
];

describe("capability database", () => {
  it("is valid and the generated file is fresh (recomputed from the sources, never the committed inventory)", () => {
    const result = run(["--check"]);
    expect(result.out).toContain("capability db up to date");
    expect(result.ok).toBe(true);
  });

  it("holds exactly the twelve 1.0.10 slice entries", () => {
    expect(CAPABILITY_ENTRIES.map((record) => record.capability).sort()).toEqual(SLICE);
    for (const record of CAPABILITY_ENTRIES) expect(record.id).toBe(`cap:${record.capability}`);
    expect(CAPABILITY_DB_REV).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a Settings path under the wrong parent", () => {
    const result = checkFixture((files) => { entry(files, "bots.channel-turns").settings_path = "Settings → Memory → Advanced → Channel turn timeout"; });
    expect(result.ok).toBe(false);
    expect(result.out).toContain("is not a path the app renders");
  });

  it("rejects a real label borrowed by an entry whose anchor is another card on the same page", () => {
    const result = checkFixture((files) => {
      const record = entry(files, "bots.channel-turns");
      record.anchors = ["settings-card:botDefaults/new-bot-effort"];
    });
    expect(result.ok).toBe(false);
    expect(result.out).toContain("belongs to card:botDefaults/channel-turns");
  });

  it("rejects a reused id", () => {
    const result = checkFixture((files) => {
      const doc = [...files.values()].find((candidate) => candidate.entries.some((record) => record.id === "memory.pin"))!;
      doc.entries.push({ ...entry(files, "memory.pin") });
    });
    expect(result.ok).toBe(false);
    expect(result.out).toContain("is used again");
  });

  it("rejects a cannot entry with no ask_your_bot step (House Rule 4)", () => {
    const result = checkFixture((files) => { entry(files, "install-account.policy-lock").ask_your_bot = ""; });
    expect(result.ok).toBe(false);
    expect(result.out).toContain("needs ask_your_bot");
  });

  it("rejects a phone platform on a desktop-only Settings path", () => {
    const result = checkFixture((files) => { entry(files, "memory.learn-about-me").platforms = ["all"]; });
    expect(result.ok).toBe(false);
    expect(result.out).toContain("is desktop only");
  });

  it("rejects copy that breaks the rules", () => {
    const result = checkFixture((files) => { entry(files, "memory.pin").answer = "It is safe and free — always."; });
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/dash/);
    expect(result.out).toMatch(/"safe"/);
    expect(result.out).toMatch(/"free"/);
  });

  it("rejects a stale generated file", () => {
    const out = join(scratch, "stale.ts");
    expect(run(["--out", out]).ok).toBe(true);
    writeFileSync(out, readFileSync(out, "utf8").replace(/"rev": "[0-9a-f]{64}"/, `"rev": "${"0".repeat(64)}"`));
    const result = run(["--check", "--out", out]);
    expect(result.ok).toBe(false);
    expect(result.out).toContain("is stale");
  });
});

describe("rev moves only when an answer-relevant fact moves", () => {
  it("is identical across rebuilds, version and verified bumps, and reformatting", async () => {
    const { buildDatabase, entryRev } = await import("../scripts/build-capability-db.mjs");
    const first = await buildDatabase();
    const second = await buildDatabase();
    expect(second.entries.map((record: { rev: string }) => record.rev)).toEqual(first.entries.map((record: { rev: string }) => record.rev));
    const base = first.entries.find((record: { id: string }) => record.id === "memory.learn-about-me");
    expect(entryRev({ ...base, verified: "9.9.9", since: "0.0.1", doc: "other", questions: ["a", "b", "c"], internal: "note" })).toBe(base.rev);
    expect(entryRev({ ...base, answer: `  ${base.answer.replace(/ /g, "\n ")}  ` })).toBe(base.rev);
    expect(entryRev({ ...base, platforms: [...base.platforms].reverse() })).toBe(base.rev);
  });

  it("changes when status, answer, limits, ask_your_bot, settings_path, platforms or engines change", async () => {
    const { buildDatabase, entryRev } = await import("../scripts/build-capability-db.mjs");
    const base = (await buildDatabase()).entries.find((record: { id: string }) => record.id === "limits.spending-per-bot");
    const changes = [
      { status: "cannot" }, { answer: `${base.answer} More.` }, { limits: `${base.limits} Also this.` },
      { ask_your_bot: `${base.ask_your_bot} Again.` }, { settings_path: "Settings → Bots" }, { platforms: ["mac"] }, { engines: ["fuigo"] },
    ];
    for (const change of changes) expect(entryRev({ ...base, ...change }), JSON.stringify(change)).not.toBe(base.rev);
  });
});

describe("export and diff", () => {
  it("exports without internal fields and with the app's valid paths, and a bootstrap diff reports every entry as added", () => {
    const file = join(scratch, "export.json");
    expect(run(["--export", file, "--sha", "abc123"]).ok).toBe(true);
    const exported = JSON.parse(readFileSync(file, "utf8"));
    expect(exported.db_rev).toBe(CAPABILITY_DB_REV);
    expect(exported.sha).toBe("abc123");
    expect(exported.entries).toHaveLength(SLICE.length);
    expect(JSON.stringify(exported)).not.toContain("\"internal\"");
    for (const record of exported.entries) expect(record.applies).toMatch(/^Applies to /);
    expect(exported.valid_paths).toEqual(expect.arrayContaining([
      "Settings → Bots → Advanced → Channel turn timeout", "Settings → Memory → Learn about me", "Team map", "Routines", "Connected apps", "Tools",
    ]));
    const diff = run(["--diff", join(scratch, "no-previous.json"), "--current", file]);
    expect(diff.ok).toBe(true);
    expect(diff.out).toContain(`+${SLICE.length} added`);
  });

  it("fails when an id from the previous export is neither an entry nor retired", () => {
    const file = join(scratch, "export2.json");
    expect(run(["--export", file]).ok).toBe(true);
    const previous = JSON.parse(readFileSync(file, "utf8"));
    previous.entries.push({ ...previous.entries[0], id: "memory.gone" });
    previous.entries[1] = { ...previous.entries[1], rev: "0".repeat(64) };
    const previousFile = join(scratch, "previous.json");
    writeFileSync(previousFile, JSON.stringify(previous));
    const diff = run(["--diff", previousFile, "--current", file]);
    expect(diff.ok).toBe(false);
    expect(diff.out).toContain("memory.gone");
    expect(diff.out).toContain("Facts changed");
  });

  it("keeps retired ids retired: a dropped tombstone or a reused retired id fails", () => {
    const file = join(scratch, "export3.json");
    expect(run(["--export", file]).ok).toBe(true);
    const previous = JSON.parse(readFileSync(file, "utf8"));
    previous.retired = [{ id: "memory.old-thing", version: "1.0.9", why: "replaced" }, { id: "memory.pin", version: "1.0.9", why: "test" }];
    const previousFile = join(scratch, "previous-retired.json");
    writeFileSync(previousFile, JSON.stringify(previous));
    const diff = run(["--diff", previousFile, "--current", file]);
    expect(diff.ok).toBe(false);
    expect(diff.out).toContain("memory.old-thing");
    expect(diff.out).toContain("retired id(s) reused as entries: memory.pin");
  });

  it("ships the export as a named release asset that the installed updater's checksum file never lists", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain('node scripts/build-capability-db.mjs --export "release/capability-db-$v.json" --sha "$CANDIDATE_SHA"');
    expect(workflow).not.toMatch(/releases\/latest[^\n]*\|\| true/);
    expect(workflow).toContain("release/capability-db-*.json");
    expect(workflow).toMatch(/required=\([\s\S]*"capability-db-\$VERSION\.json"[\s\S]*?\)/);
    expect(workflow).toContain("sha256sum Murage-$v-amd64.deb Murage-$v-x86_64.AppImage > SHA256SUMS-ubuntu-x64.txt");
    expect(workflow).toContain("--diff \"$previous\" --current \"assets/capability-db-$VERSION.json\"");
    const verifier = readFileSync(join(root, "scripts", "verify-linux-package.mjs"), "utf8");
    for (const where of ["resources", "debResources", "appImageResources"]) expect(verifier).toContain(`verifyCapabilityDb(${where})`);
  });
});
