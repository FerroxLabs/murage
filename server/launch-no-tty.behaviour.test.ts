// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Section (e)+(h) (a) of APP-GRANT-FIXPLAN-r6 (Rule 74c launch clause), with real processes: a parent holding a PTY
// as its controlling terminal launches a fake engine through spawnCli, through execCli and through the Hermes catalog
// probe. The engine and its descendants cannot open /dev/tty (a new session), and the engine's session id differs from
// the parent's. A control raw spawn without detached opens /dev/tty, so the fixture can see one.
//
// The outer test runs this same file again under python3's pty.fork (a new session whose controlling terminal is the
// PTY); the inner run does the checks.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { fetchHermesAcpModels } from "./drivers/acp/hermes.ts";
import { execCli, spawnCli } from "./procs.ts";
import { resetPathCache, resolveFuigoCli } from "./env-path.ts";

const here = fileURLToPath(import.meta.url);
const root = join(dirname(here), "..");
const INNER = process.env.LAUNCH_NO_TTY_INNER === "1";
const posix = process.platform !== "win32";

const PTY_PARENT = [
  "import os, pty, select, sys, time",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    os.execv(sys.argv[1], sys.argv[1:])",
  "status = None",
  "while True:",
  "    ready = select.select([fd], [], [], 0.2)[0]",
  "    chunk = b''",
  "    if ready:",
  "        try:",
  "            chunk = os.read(fd, 65536)",
  "        except OSError:",
  "            chunk = b''",
  "    if chunk:",
  "        sys.stdout.buffer.write(chunk)",
  "        sys.stdout.flush()",
  "        continue",
  "    if status is not None:",
  "        break",
  "    done, st = os.waitpid(pid, os.WNOHANG)",
  "    if done:",
  "        status = st",
  "    elif ready:",
  "        time.sleep(0.05)",
  "sys.exit(os.waitstatus_to_exitcode(status))",
].join("\n");

describe.skipIf(!posix || INNER)("engine processes have no controlling terminal (outer: a parent holding a PTY)", () => {
  it("runs the checks in a process whose controlling terminal is a PTY", () => {
    const run = spawnSync("python3", ["-c", PTY_PARENT, process.execPath, join(root, "node_modules/vitest/vitest.mjs"), "run", here], {
      cwd: root,
      env: { ...process.env, LAUNCH_NO_TTY_INNER: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      encoding: "utf8",
      timeout: 170_000,
    });
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    expect(run.error, out).toBeUndefined();
    expect(out, out).toMatch(/Tests\s+5 passed/);
    expect(run.status, out).toBe(0);
  }, 180_000);
});

describe.skipIf(!posix || !INNER)("engine processes have no controlling terminal (inner, under the PTY)", () => {
  const dir = mkdtempSync(join(tmpdir(), "launch-no-tty-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const engine = join(dir, "fake-engine");
  writeFileSync(engine, [
    "#!/bin/sh",
    "out=\"$FAKE_OUT\"",
    "python3 -c 'import os,sys; print(os.getsid(int(sys.argv[1])))' $$ > \"$out.sid\"",
    "sh -c 'exec 3<>/dev/tty' 2>/dev/null; echo $? > \"$out.tty\"",
    "sh -c 'sh -c \"exec 3<>/dev/tty\"' 2>/dev/null; echo $? > \"$out.desc\"",
    "",
  ].join("\n"));
  chmodSync(engine, 0o755);
  const env = (out: string) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, FAKE_OUT: join(dir, out) });
  const result = (out: string) => ({
    sid: readFileSync(join(dir, `${out}.sid`), "utf8").trim(),
    tty: readFileSync(join(dir, `${out}.tty`), "utf8").trim(),
    desc: readFileSync(join(dir, `${out}.desc`), "utf8").trim(),
  });
  // getsid(2) through python3: BSD ps (macOS) has no `sid` keyword, and node does not expose getsid
  const parentSid = () => execFileSync("python3", ["-c", "import os,sys; print(os.getsid(int(sys.argv[1])))", String(process.pid)], { encoding: "utf8" }).trim();
  const closed = (child: { once: (event: "close", fn: () => void) => unknown }) => new Promise<void>((resolve) => { child.once("close", () => resolve()); });

  it("the fixture can see a terminal: the parent and a raw spawn without detached open /dev/tty", async () => {
    closeSync(openSync("/dev/tty", "r+"));
    const child = spawn(engine, [], { env: env("control"), stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    await closed(child);
    const seen = result("control");
    expect(seen.tty).toBe("0");
    expect(seen.desc).toBe("0");
    expect(seen.sid).toBe(parentSid());
  });

  it("spawnCli: the engine and its descendants cannot open /dev/tty, in a session of their own", async () => {
    const child = spawnCli(engine, [], { env: env("spawncli"), stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    await closed(child);
    const seen = result("spawncli");
    expect(seen.tty).not.toBe("0");
    expect(seen.desc).not.toBe("0");
    expect(seen.sid).not.toBe(parentSid());
  });

  it("execCli: the probe and its descendants cannot open /dev/tty, in a session of their own", async () => {
    await new Promise<void>((resolve) => execCli(engine, ["--version"], { env: env("execcli"), timeout: 10_000 }, () => resolve()));
    const seen = result("execcli");
    expect(seen.tty).not.toBe("0");
    expect(seen.desc).not.toBe("0");
    expect(seen.sid).not.toBe(parentSid());
  });

  it("the Fuigo --version read in the resolver: the engine and its descendants cannot open /dev/tty, in a session of their own", () => {
    // the read runs with a PATH-only env, so each fake writes to a fixed file of its own
    const fake = (at: string, out: string) => {
      writeFileSync(at, [
        "#!/bin/sh",
        `python3 -c 'import os,sys; print(os.getsid(int(sys.argv[1])))' $$ > "${join(dir, out)}.sid"`,
        `sh -c 'exec 3<>/dev/tty' 2>/dev/null; echo $? > "${join(dir, out)}.tty"`,
        `sh -c 'sh -c "exec 3<>/dev/tty"' 2>/dev/null; echo $? > "${join(dir, out)}.desc"`,
        "echo 'fuigo 1.0.0'",
        "",
      ].join("\n"));
      chmodSync(at, 0o755);
    };
    const onPath = mkdtempSync(join(dir, "path-"));
    const bundle = mkdtempSync(join(dir, "bundle-"));
    fake(join(onPath, "fuigo"), "fuigo-path");
    fake(join(bundle, "fuigo"), "fuigo-bundle");
    const before = process.env.PATH;
    process.env.PATH = `${onPath}:${before ?? ""}`;
    resetPathCache();
    try {
      expect(resolveFuigoCli({ MURAGE_FUIGO_DIR: bundle }, "linux").source).toBe("path");
    } finally {
      process.env.PATH = before;
      resetPathCache();
    }
    for (const out of ["fuigo-path", "fuigo-bundle"]) {
      const seen = result(out);
      expect(seen.tty, out).not.toBe("0");
      expect(seen.desc, out).not.toBe("0");
      expect(seen.sid, out).not.toBe(parentSid());
    }
  });

  it("the Hermes catalog probe: the engine and its descendants cannot open /dev/tty, in a session of their own", async () => {
    expect(await fetchHermesAcpModels(engine, env("hermes"), "default")).toEqual([]);
    const seen = result("hermes");
    expect(seen.tty).not.toBe("0");
    expect(seen.desc).not.toBe("0");
    expect(seen.sid).not.toBe(parentSid());
  });
});
