// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProjectTables } from "./project-tables.ts";
import { projectRoomWorkRoot, rootsForStructuredWrite, WriterRootClaims } from "./writer-roots.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "e1-root-")));
  dirs.push(dir);
  const stat = statSync(dir, { bigint: true });
  return { canonicalPath: dir, dev: stat.dev.toString(), ino: stat.ino.toString() };
};
const owner = (name: string) => ({ botId: name, threadId: `${name}-t`, turnGeneration: `${name}-g` });

describe("writer claims on work roots (SPEC-P 5.4, 5.4a)", () => {
  it("one writer per root, nested roots conflict, release is idempotent", () => {
    const claims = new WriterRootClaims();
    const a = root();
    const release = claims.claim(a, owner("jax"));
    expect(release).toBeTypeOf("function");
    expect(claims.claim(a, owner("kim"))).toBeNull();
    mkdirSync(join(a.canonicalPath, "sub"));
    const sub = { canonicalPath: join(a.canonicalPath, "sub"), dev: a.dev, ino: statSync(join(a.canonicalPath, "sub"), { bigint: true }).ino.toString() };
    expect(claims.claim(sub, owner("kim"))).toBeNull();
    expect(claims.holder(sub)?.botId).toBe("jax");
    const other = root();
    expect(claims.claim(other, owner("kim"))).toBeTypeOf("function");
    release!(); release!();
    expect(claims.claim(a, owner("lee"))).toBeTypeOf("function");
  });

  it("one turn can hold several late writer roots without losing its first claim", () => {
    const claims = new WriterRootClaims(), a = root(), b = root(), who = owner("jax");
    const releaseA = claims.claim(a, who)!, releaseB = claims.claim(b, who)!;
    expect(claims.holder(a)).toEqual(who); expect(claims.holder(b)).toEqual(who);
    releaseA(); expect(claims.holder(a)).toBeUndefined(); expect(claims.holder(b)).toEqual(who);
    releaseB(); expect(claims.holder(b)).toBeUndefined();
  });

  it("reads the project's first work root and refuses one that moved", () => {
    const db = new DatabaseSync(":memory:");
    initializeProjectTables(db);
    const a = root();
    db.prepare("INSERT INTO project_settings (group_id, work_roots, updated_at) VALUES ('g', ?, 1)").run(JSON.stringify([{ path: a.canonicalPath, dev: a.dev, ino: a.ino, label: "Repo", addedAt: 1 }]));
    expect(projectRoomWorkRoot(db, "g")).toEqual(a);
    db.prepare("UPDATE project_settings SET work_roots=?").run(JSON.stringify([{ path: a.canonicalPath, dev: a.dev, ino: "1", label: "Repo", addedAt: 1 }]));
    expect(projectRoomWorkRoot(db, "g")).toBeUndefined();
    expect(projectRoomWorkRoot(db, "channel")).toBeUndefined();
  });
});

it("late writes inside a root require its claim; reads and outside paths do not", () => {
  const a = root();
  expect(rootsForStructuredWrite("Write", [join(a.canonicalPath, "new.txt")], a.canonicalPath, [a])).toEqual([a]);
  expect(rootsForStructuredWrite("Read", [join(a.canonicalPath, "new.txt")], a.canonicalPath, [a])).toEqual([]);
  expect(rootsForStructuredWrite("Edit", ["/elsewhere/file"], a.canonicalPath, [a])).toEqual([]);
});


it("transfers a retry writer atomically and ignores release from the old generation", () => {
  const claims = new WriterRootClaims(), a = root(), first = owner("jax"), next = { ...first, turnGeneration: "retry" };
  const oldRelease = claims.claim(a, first)!;
  const release = claims.claim(a, next, first);
  expect(release).toBeTypeOf("function");
  oldRelease(); expect(claims.holder(a)).toEqual(next);
  release!(); expect(claims.holder(a)).toBeUndefined();
});
it("a refused writer transfer retains the old root and cannot replace another bot", () => {
  const claims = new WriterRootClaims(), a = root(), b = root(), first = owner("jax"), other = owner("ivy");
  claims.claim(a, first); claims.claim(b, other);
  expect(claims.claim(b, { ...first, turnGeneration: "retry" }, first)).toBeNull();
  expect(claims.holder(a)).toEqual(first); expect(claims.holder(b)).toEqual(other);
  expect(claims.claim(a, other, first)).toBeNull();
});
