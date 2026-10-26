// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DELETION-WHILE-OPEN-107, Grok design r1: the proof the open-home pass needs from every process on the home (engine-closed.ts holdersClearOf).
import { afterEach, expect, it } from "vitest";

import { holdersClearOf as clearOf } from "./engine-closed.ts";
import { exclOps } from "./engine-fs.ts";

const T = "/home/u/.claude/projects/-work-thread";
const FOLDER = "/data/threads/t1";
const before = { ...exclOps };
afterEach(() => { Object.assign(exclOps, before); });

/** The ops as the tests give them; each case installs its own view of the processes. */
interface Ops { platform: "linux" | "darwin" | "win32"; readlink: (path: string) => string; readdir: (path: string) => string[]; lsof: (pids: readonly number[]) => string; realpath: (path: string) => string | null }
function holdersClearOf(pids: number[], targets: string[], ops: Ops) {
  const absent = (error: unknown) => (error as { code?: string }).code === "ENOENT";
  Object.assign(exclOps, {
    mode: ops.platform === "win32" ? "win32" : "posix",
    procView: ops.platform === "win32" ? null : ops.platform,
    realpathOf: ops.realpath,
    procCwd: (pid: number) => { try { return ops.readlink(`/proc/${pid}/cwd`); } catch { return null; } },
    procFiles: (pid: number) => {
      let fds: string[];
      try { fds = ops.readdir(`/proc/${pid}/fd`); } catch { return null; }
      const out: string[] = [];
      for (const fd of fds) { try { out.push(ops.readlink(`/proc/${pid}/fd/${fd}`)); } catch (error) { if (!absent(error)) return null; } }
      return out;
    },
    lsofFiles: (list: readonly number[]) => { try { return ops.lsof(list); } catch { return null; } },
  });
  return clearOf(pids, targets);
}

function linux(view: Record<number, { cwd?: string | Error; fds?: Array<string | Error> | Error }>): Ops {
  const pidOf = (path: string) => Number(path.split("/")[2]);
  return {
    platform: "linux",
    realpath: (path) => path,
    lsof: () => { throw new Error("no"); },
    readlink: (path) => {
      const v = view[pidOf(path)];
      if (!v) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const got = path.endsWith("/cwd") ? v.cwd ?? "/work/app" : (v.fds as Array<string | Error>)[Number(path.split("/").pop())]!;
      if (got instanceof Error) throw got;
      return got;
    },
    readdir: (path) => {
      const v = view[pidOf(path)];
      if (!v) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (v.fds instanceof Error) throw v.fds;
      return (v.fds ?? []).map((_, index) => String(index));
    },
  };
}
const enoent = () => Object.assign(new Error("gone"), { code: "ENOENT" });
const eacces = () => Object.assign(new Error("denied"), { code: "EACCES" });

it("Linux: processes working elsewhere with nothing of the targets open are proven clear", () => {
  expect(holdersClearOf([1, 2], [T, FOLDER], linux({ 1: { fds: ["/dev/null", "socket:[1]", "/home/u/.claude/history.jsonl"] }, 2: {} }))).toEqual({ proven: true });
});

it("Linux: a working folder inside a target, or a target open for reading, is no proof", () => {
  expect(holdersClearOf([1], [T, FOLDER], linux({ 1: { cwd: `${FOLDER}/src` } }))).toMatchObject({ proven: false, why: "cwd-inside", pid: 1 });
  expect(holdersClearOf([1], [T, FOLDER], linux({ 1: { cwd: FOLDER } }))).toMatchObject({ proven: false, why: "cwd-inside" });
  expect(holdersClearOf([1], [T], linux({ 1: { fds: [`${T}/sess.jsonl`] } }))).toMatchObject({ proven: false, why: "holds-target" });
  expect(holdersClearOf([1], [T], linux({ 1: { fds: [`${T}/sess.jsonl (deleted)`] } }))).toMatchObject({ proven: false, why: "holds-target" });
  // a sibling whose name only starts the same is not inside
  expect(holdersClearOf([1], [T], linux({ 1: { fds: [`${T}-other/sess.jsonl`] } }))).toEqual({ proven: true });
});

it("Linux: an unreadable process, working folder or open-file list is no proof; a file closed mid-listing is", () => {
  expect(holdersClearOf([1], [T], linux({}))).toMatchObject({ proven: false, why: "unreadable", pid: 1 });
  expect(holdersClearOf([1], [T], linux({ 1: { cwd: eacces() } }))).toMatchObject({ proven: false, why: "unreadable" });
  expect(holdersClearOf([1], [T], linux({ 1: { fds: eacces() } }))).toMatchObject({ proven: false, why: "unreadable" });
  expect(holdersClearOf([1], [T], linux({ 1: { fds: [eacces()] } }))).toMatchObject({ proven: false, why: "unreadable" });
  expect(holdersClearOf([1], [T], linux({ 1: { fds: [enoent(), "/dev/null"] } }))).toEqual({ proven: true });
  expect(holdersClearOf([1], [T], linux({ 1: { cwd: "(unreachable)/x" } }))).toMatchObject({ proven: false, why: "unreadable" });
});

it("a target's real path counts too (a home reached through a link)", () => {
  const ops: Ops = { ...linux({ 1: { fds: [`/real/projects/-work-thread/sess.jsonl`] } }), realpath: (path: string) => (path === T ? "/real/projects/-work-thread" : null) };
  expect(holdersClearOf([1], [T], ops)).toMatchObject({ proven: false, why: "holds-target" });
});

it("no holders, or a platform it cannot read yet (Windows), is no proof", () => {
  expect(holdersClearOf([], [T], linux({}))).toMatchObject({ proven: false, why: "no-holders" });
  expect(holdersClearOf([1], [T], { ...linux({ 1: {} }), platform: "win32" })).toMatchObject({ proven: false, why: "unsupported" });
});

function mac(text: string | Error): Ops {
  return { platform: "darwin", realpath: (path) => path, readlink: () => { throw new Error("no"); }, readdir: () => { throw new Error("no"); }, lsof: () => { if (text instanceof Error) throw text; return text; } };
}

it("macOS: one lsof for every holder; each must show its working folder, and none a target", () => {
  const clear = "p11\nfcwd\nn/home/u/work\nftxt\nn/usr/bin/node\nf3\nn/home/u/.claude/history.jsonl\np12\nfcwd\nn/home/u\n";
  expect(holdersClearOf([11, 12], [T], mac(clear))).toEqual({ proven: true });
  expect(holdersClearOf([11, 12, 13], [T], mac(clear))).toMatchObject({ proven: false, why: "unreadable", pid: 13 });
  expect(holdersClearOf([11], [T], mac(`p11\nfcwd\nn/home/u\nf4\nn${T}/sess.jsonl\n`))).toMatchObject({ proven: false, why: "holds-target", pid: 11 });
  expect(holdersClearOf([11], [T, FOLDER], mac(`p11\nfcwd\nn${FOLDER}\n`))).toMatchObject({ proven: false, why: "cwd-inside" });
  expect(holdersClearOf([11], [FOLDER], mac(`p11\nfcwd\nn${FOLDER}/a\n`))).toMatchObject({ proven: false, why: "cwd-inside" });
  // macOS folds case: a path told in another case is the same file on the usual disk
  expect(holdersClearOf([11], [T], mac(`p11\nfcwd\nn/home/u\nf4\nn${T.toUpperCase()}/S.jsonl\n`))).toMatchObject({ proven: false, why: "holds-target" });
  expect(holdersClearOf([11], [T], mac(new Error("lsof exited 1")))).toMatchObject({ proven: false, why: "unreadable" });
});
