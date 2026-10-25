// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Three gaps of the shipped 1.0.3 engine-history deletion (F16 design, R3.1), each reproduced first:
//   X1  recovery finishes only the journals of the homes the attempt holds (`only`), never another home's
//   X2  a pasted text is unlinked only with a writer proof: `noWriters` on macOS and Linux, the share-none deletion handle on Windows
//   X3  a Claude Code plan file goes only when no transcript that stays names its slug, read from the parsed rows at plan time and
//       again when the step runs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { executeEnginePlans } from "./engine-exec.ts";
import { planEngineHistory, removeEngineHistoryFiles } from "./engine-history-run.ts";
import { ASIDE_SUFFIX, homeKey } from "./engine-plan-core.ts";
import { dropRedo, listRedo, writeRedo } from "./engine-redo.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture } from "./testing/engine-history-fixtures.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-preexisting-")));
afterAll(() => removeTempDirSync(scratch));
let fake: FakeExclusion | null = null;
afterEach(() => { fake?.restore(); fake = null; });
let counter = 0;
const fresh = (name: string) => { const dir = join(scratch, `${name}-${++counter}`); mkdirSync(dir, { recursive: true }); return dir; };
const dump = (value: unknown) => `${JSON.stringify(value)}\n`;

describe("X1: recovery runs only for the homes the attempt holds", () => {
  it("a journal of home B is not finished by a plan of home A alone; the attempt that holds B finishes it", () => {
    const a = fresh("codex-a"), b = fresh("codex-b"), folder = fresh("desk");
    const id = writeRedo({ path: join(b, "history.jsonl"), dev: "1", ino: "2", engine: "codex", home: b, how: "lock", format: "codex-history", rows: [] });
    try {
      const homes = [{ engine: "codex" as const, home: a }, { engine: "codex" as const, home: b }];
      planEngineHistory({ kind: "plan", homes, folders: [folder], memoryFolders: [], sessions: {}, only: [homeKey("codex", a)] });
      expect(listRedo().map((rec) => rec.id), "B's journal was finished by an attempt that did not hold B").toContain(id);
      planEngineHistory({ kind: "plan", homes, folders: [folder], memoryFolders: [], sessions: {}, only: [homeKey("codex", b)] });
      expect(listRedo().map((rec) => rec.id)).not.toContain(id);
    } finally { dropRedo(id); }
  });
});

/** The Claude fixture with its history rows already cleared, so the only step left to run is the paste's. */
function pasteOnly() {
  const fx = buildFixture("claude", scratch);
  const home = fx.homes[0]!.home;
  const planned = planEngineHistory({ kind: "plan", homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions });
  const key = homeKey("claude", home);
  const plan = planned.plans![key]!;
  const paste = plan.steps.find((step) => step.k === "removeUnlessReferenced");
  expect(paste, "the fixture plans its paste").toBeTruthy();
  // the history first (the paste's row must be gone before the paste can go)
  const history = plan.steps.filter((step) => step.k === "rewrite");
  expect(executeEnginePlans({ [key]: { ...plan, steps: history } }).failed).toEqual([]);
  const target = (paste as { target: string }).target;
  return { key, plan: { ...plan, steps: [paste!] }, target, text: readFileSync(target, "utf8") };
}

describe("X2: the paste cache is unlinked only with a writer proof", () => {
  it("macOS and Linux: a process with the moved-aside paste open for writing keeps it (held), and it is back under its name", () => {
    const { key, plan, target, text } = pasteOnly();
    fake = useFakeExclusion("posix");
    const asked: string[][] = [];
    fake.onWriters = (paths) => { asked.push(paths); return paths.some((path) => path === `${target}${ASIDE_SUFFIX}`) ? { writers: [{ pid: 4242, index: 0 }], unreadable: [] } : undefined; };
    const ran = executeEnginePlans({ [key]: plan });
    expect(asked.flat(), "the aside was never asked about").toContain(`${target}${ASIDE_SUFFIX}`);
    expect(ran.failed).toContain(target);
    expect(ran.reasons[target]).toBe("held");
    expect(readFileSync(target, "utf8")).toBe(text);
    expect(existsSync(`${target}${ASIDE_SUFFIX}`)).toBe(false);
  });

  it("Windows: a paste the share-none deletion handle cannot open is kept (held), and it is back under its name", () => {
    const { key, plan, target, text } = pasteOnly();
    fake = useFakeExclusion("win32");
    fake.refuse.add(target);
    const ran = executeEnginePlans({ [key]: plan });
    expect(fake.calls).toContain(`openFile delete ${target}${ASIDE_SUFFIX}`);
    expect(ran.failed).toContain(target);
    expect(ran.reasons[target]).toBe("held");
    expect(readFileSync(target, "utf8")).toBe(text);
  });

  it("Windows: a paste nobody holds is removed through that handle", () => {
    const { key, plan, target } = pasteOnly();
    fake = useFakeExclusion("win32");
    const ran = executeEnginePlans({ [key]: plan });
    expect(ran.failed).toEqual([]);
    expect(fake.calls).toContain(`delete ${target}${ASIDE_SUFFIX}`);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}${ASIDE_SUFFIX}`)).toBe(false);
  });
});

describe("X3: a plan file another transcript names stays", () => {
  /** The Claude fixture (session A, slug cool-slug, plans/cool-slug.md) plus a slug only A names, and its plan file. */
  function withOwnSlug() {
    const fx = buildFixture("claude", scratch);
    const home = fx.homes[0]!.home;
    const key = fx.folders[0]!.replace(/[^a-zA-Z0-9]/g, "-");
    const transcript = join(home, "projects", key, "sess-claude-1.jsonl");
    writeFileSync(transcript, readFileSync(transcript, "utf8") + dump({ type: "user", cwd: fx.folders[0], slug: "only-ours", message: "x" }));
    writeFileSync(join(home, "plans", "only-ours.md"), "ours alone");
    writeFileSync(join(home, "plans", "only-ours-agent-1.md"), "ours alone");
    return { fx, home, transcript };
  }
  const other = (home: string, text: string) => { mkdirSync(join(home, "projects", "-other2"), { recursive: true }); writeFileSync(join(home, "projects", "-other2", "B.jsonl"), text); };

  for (const [name, text] of [
    ["the slug field as Claude Code writes it", dump({ type: "user", cwd: "/other2", sessionId: "B", slug: "cool-slug" })],
    ["with whitespace and an escape in the JSON", `{"type":"user", "cwd" : "/other2", "slug" :  "cool-\\u0073lug"}\n`],
    ["in a nested field", dump({ type: "summary", cwd: "/other2", meta: { plan: { slug: "cool-slug" } } })],
    ["in a row that cannot be parsed", `{"type":"user","cwd":"/other2","slug":"cool-slug"\n`],
  ] as const) {
    it(`another folder's transcript naming the slug (${name}) keeps plans/cool-slug.md; A's transcript and A-only plans go`, () => {
      const { fx, home, transcript } = withOwnSlug();
      other(home, text);
      const result = removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions);
      expect(result.failed).toEqual([]);
      expect(existsSync(join(home, "plans", "cool-slug.md")), "a plan file another session names was removed").toBe(true);
      expect(existsSync(join(home, "projects", "-other2", "B.jsonl"))).toBe(true);
      expect(existsSync(transcript)).toBe(false);
      // a row that cannot be read could name any slug: every plan file asked about is kept (it cannot be told)
      const unreadable = name === "in a row that cannot be parsed";
      expect(existsSync(join(home, "plans", "only-ours.md"))).toBe(unreadable);
      expect(existsSync(join(home, "plans", "only-ours-agent-1.md"))).toBe(unreadable);
      expect(existsSync(join(home, "plans", "other-slug.md"))).toBe(true);
    });
  }

  it("a transcript that names the slug only after the plan was made keeps the plan file when the step runs", () => {
    const { fx, home, transcript } = withOwnSlug();
    const planned = planEngineHistory({ kind: "plan", homes: fx.homes, folders: fx.folders, memoryFolders: fx.memoryFolders, sessions: fx.sessions });
    const key = homeKey("claude", home);
    expect(planned.plans![key]!.steps.some((step) => step.k === "remove" && step.target === join(home, "plans", "cool-slug.md")), "no other transcript named it when planned").toBe(true);
    other(home, dump({ type: "user", cwd: "/other2", sessionId: "B", slug: "cool-slug" }));
    const ran = executeEnginePlans(planned.plans!);
    expect(ran.failed).toEqual([]);
    expect(existsSync(join(home, "plans", "cool-slug.md")), "removed although a transcript that stays names it now").toBe(true);
    expect(existsSync(transcript)).toBe(false);
    expect(existsSync(join(home, "plans", "only-ours.md"))).toBe(false);
  });

  it("no other transcript names it: the plan file goes (unchanged)", () => {
    const { fx, home } = withOwnSlug();
    other(home, dump({ type: "user", cwd: "/other2", sessionId: "B", slug: "another-slug" }));
    expect(removeEngineHistoryFiles(fx.homes, fx.folders, fx.memoryFolders, fx.sessions).failed).toEqual([]);
    expect(existsSync(join(home, "plans", "cool-slug.md"))).toBe(false);
  });
});
