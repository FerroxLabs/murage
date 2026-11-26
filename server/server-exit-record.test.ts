// cause12 (1.0.21 hold): on the owner's Mac the server started 22 times in
// three days and for eight of those starts the log could not say why the
// previous server ended. Two gaps, both pinned here against real processes:
//
// 1. The exit census ([io-census], io-child-meter.ts) was written with a single
//    writeSync on fd 2. fd 2 is a pipe the desktop reads, Node makes it
//    non-blocking, and a full pipe answers EAGAIN: the census was silently
//    dropped, and a clean exit then read exactly like a kill.
// 2. Nothing else said why the server ended. installServerChildExitNote
//    (server-child-crash.mjs) writes a close line per close request and an
//    exit line on every exit event, so the absence of an exit line now means
//    the process was killed or aborted from outside.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { writeExitLineSync } from "./io-child-meter.ts";
import { installServerChildExitNote } from "./server-child-crash.mjs";

const NOTE_FIXTURE = fileURLToPath(new URL("./testing/server-exit-note.fixture.mjs", import.meta.url));

interface Ended { code: number | null; signal: NodeJS.Signals | null; stderr: string }

function runNoteFixture(mode: string, after: (child: ReturnType<typeof spawn>, seen: (text: string) => Promise<void>) => void): Promise<Ended> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NOTE_FIXTURE, mode], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "", ready = false;
    let waiters: Array<{ text: string; done: () => void }> = [];
    const wake = () => {
      for (const waiter of waiters) if (stderr.includes(waiter.text)) waiter.done();
      waiters = waiters.filter((waiter) => !stderr.includes(waiter.text));
    };
    // Resolves once the child's stderr holds `text`: each signal waits for the previous line, never for a fixed delay.
    const seen = (text: string) => new Promise<void>((done) => { waiters.push({ text, done: () => done() }); wake(); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk; wake(); });
    child.stdout!.on("data", (chunk: Buffer) => { if (!ready && String(chunk).includes("ready")) { ready = true; after(child, seen); } });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

const lines = (stderr: string, event: string) => stderr.split("\n").filter((line) => line.startsWith(`event=${event} `));
// child.kill("SIGTERM") never reaches a JS signal handler on Windows (it terminates the process), so the signal witnesses are POSIX-only.
const posixOnly = it.skipIf(process.platform === "win32");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the exit line writer", () => {
  it("retries EAGAIN, continues partial writes, and gives up on anything else", () => {
    const written: number[] = [];
    let refusals = 2;
    const flaky = (_fd: number, data: Uint8Array, offset: number, length: number) => {
      if (refusals-- > 0) throw Object.assign(new Error("again"), { code: "EAGAIN" });
      const n = Math.min(length, 5);
      written.push(...data.subarray(offset, offset + n));
      return n;
    };
    expect(writeExitLineSync("[io-census] {}\n", flaky)).toBe(true);
    expect(Buffer.from(written).toString()).toBe("[io-census] {}\n");
    expect(writeExitLineSync("x\n", () => { throw Object.assign(new Error("gone"), { code: "EPIPE" }); })).toBe(false);
    expect(writeExitLineSync("x\n", () => { throw Object.assign(new Error("again"), { code: "EAGAIN" }); }), "bounded, never forever").toBe(false);
  });
});

describe("every way the server can still speak says why it ended", () => {
  it("a close request answered gracefully (stdin message, any platform) leaves a close line and an exit line", async () => {
    const ended = await runNoteFixture("graceful", (child) => { child.stdin!.write("close\n"); });
    expect(ended.code).toBe(0);
    expect(lines(ended.stderr, "server-child-close")).toEqual(["event=server-child-close via=message"]);
    expect(lines(ended.stderr, "server-child-exit")).toEqual(["event=server-child-exit code=0 cause=close:message"]);
  }, 20_000);

  it("a stalled shutdown that is force-killed leaves the close line and NO exit line (any platform)", async () => {
    const ended = await runNoteFixture("stalled", (child, seen) => {
      void (async () => {
        child.stdin!.write("close\n");
        await seen("event=server-child-close via=message\n");
        await delay(50);
        child.kill("SIGKILL"); // terminates outright on Windows too
      })();
    });
    expect(ended.signal).not.toBeNull();
    expect(lines(ended.stderr, "server-child-close")).toEqual(["event=server-child-close via=message"]);
    expect(lines(ended.stderr, "server-child-exit")).toEqual([]);
  }, 20_000);

  posixOnly("a SIGTERM answered gracefully leaves a close line and an exit line", async () => {
    const ended = await runNoteFixture("graceful", (child) => child.kill("SIGTERM"));
    expect(ended.code).toBe(0);
    expect(lines(ended.stderr, "server-child-close")).toEqual(["event=server-child-close via=SIGTERM"]);
    expect(lines(ended.stderr, "server-child-exit")).toEqual(["event=server-child-exit code=0 cause=close:SIGTERM"]);
  }, 20_000);

  posixOnly("a shutdown that stalls and is killed leaves the close, the repeat, and NO exit line", async () => {
    const ended = await runNoteFixture("stalled", (child, seen) => {
      void (async () => {
        child.kill("SIGTERM");
        await seen("event=server-child-close via=SIGTERM\n");
        child.kill("SIGTERM"); // the desktop's kill after its grace period
        await seen("repeat=1 still-closing\n");
        await delay(50); // a stalled shutdown does not exit on its own: give it the chance to prove it
        child.kill("SIGKILL"); // the OS, a force quit, or memory pressure
      })();
    });
    expect(ended.signal).toBe("SIGKILL");
    expect(lines(ended.stderr, "server-child-close")).toEqual([
      "event=server-child-close via=SIGTERM",
      "event=server-child-close via=SIGTERM repeat=1 still-closing",
    ]);
    expect(lines(ended.stderr, "server-child-exit")).toEqual([]);
  }, 20_000);

  it("an uncaught exception leaves the failure line and an exit line naming it", async () => {
    const ended = await runNoteFixture("throw", () => {});
    expect(ended.code).toBe(1);
    expect(ended.stderr).toContain("event=server-child-failure origin=uncaughtException error=TypeError");
    expect(lines(ended.stderr, "server-child-exit")).toEqual(["event=server-child-exit code=1 cause=failure"]);
  }, 20_000);

  it("an exit nobody asked for says cause=none", async () => {
    const ended = await runNoteFixture("plain", () => {});
    expect(ended.code).toBe(0);
    expect(lines(ended.stderr, "server-child-exit")).toEqual(["event=server-child-exit code=0 cause=none"]);
  }, 20_000);

  it("admits only its fixed vocabulary and bounds repeats", () => {
    const target = new EventEmitter() as unknown as NodeJS.Process;
    const out: string[] = [];
    const note = installServerChildExitNote({ processTarget: target, write: (line) => out.push(line) });
    (note.closeRequested as (via: unknown) => void)("SIGTERM; key=sk-live-FIXTURE");
    for (let i = 0; i < 6; i += 1) note.closeRequested("SIGTERM");
    target.emit("exit", 0);
    expect(out).toEqual([
      "event=server-child-close via=other\n",
      "event=server-child-close via=SIGTERM repeat=1 still-closing\n",
      "event=server-child-close via=SIGTERM repeat=2 still-closing\n",
      "event=server-child-close via=SIGTERM repeat=3 still-closing\n",
      "event=server-child-exit code=0 cause=close:other\n",
    ]);
    note.dispose();
  });
});

// The fixtures install the note themselves; this ties it to the shipped entry.
it("the server entry installs the exit note and routes every close path through it", () => {
  const entry = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(entry).toContain("const serverExitNote = installServerChildExitNote();");
  expect(entry).toMatch(/function closeRequested\(via: "SIGINT" \| "SIGTERM" \| "message"\): void \{\n  serverExitNote\.closeRequested\(via\);/);
  expect(entry).toContain('for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => closeRequested(signal));');
  expect(entry.match(/isAppCloseRequest\(message\)\) \{? ?closeRequested\("message"\)/g)?.length).toBe(2);
  expect(entry).toContain('serverExitNote.closeRequested("restart");');
  expect(entry).not.toMatch(/closeRequested\(\)/);
});
