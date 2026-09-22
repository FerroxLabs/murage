// WHAT WOULD MAKE THIS TEST WORTHLESS, AND HOW EACH IS RULED OUT.
//
// A crash observer is easy to "prove" by accident. Assert only that the line
// appears and the test passes just as happily if the observer also SWALLOWED
// the fault and left a corrupt server running — which is the one outcome the
// design refuses. Assert only that the process died and the test passes with
// no observer at all, because the process was always going to die. So every
// claim here is paired with the run that would break it:
//
//   observer installed  → the line is there AND the process still dies
//   observer absent     → the process dies AND the line is not there
//   synchronous writer  → the line survives a fatal exit behind a full queue
//   asynchronous writer → the same line is lost, every time
//
// The last pair is the reason `writeCrashLineSync` exists rather than a call
// to `process.stderr.write`, and it is measured here rather than asserted from
// the Node documentation.
//
// All of it runs in a spawned process, because the subject is what happens
// when a process dies and no in-process assertion outlives that.
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { formatServerChildFailure, installServerChildCrashObserver } from "./server-child-crash.mjs";

const run = promisify(execFile);
const FIXTURE = fileURLToPath(new URL("./testing/server-child-crash.fixture.mjs", import.meta.url));

// The whole record, matched as one unit, so a test can assert on exactly what
// was published and not merely on a substring of it.
const RECORD = /event=server-child-failure origin=[A-Za-z]+ error=[A-Za-z]+/;

async function spawnFixture(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    // The backlog runs deliberately emit megabytes; the default 1 MB maxBuffer
    // would kill the child itself and confuse that with the crash under test.
    const { stdout, stderr } = await run(process.execPath, [FIXTURE, ...args], {
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const recordIn = (stderr: string): string | null => stderr.match(RECORD)?.[0] ?? null;

describe("the server child must say what killed it, and still die of it", () => {
  it("records an uncaught exception without rescuing the process from it", async () => {
    const observed = await spawnFixture("on", "throw");

    // THE HALF THAT MATTERS MOST. An observer that kept the process alive
    // would leave every bot, lease and half-written store mutation in place
    // with nobody able to tell the server had faulted.
    expect(observed.code, "the fault must stay fatal").not.toBe(0);
    expect(observed.stdout, "code after the fault must never run").not.toContain("SURVIVED");
    // Node's own fatal report is still printed: nothing was consumed.
    expect(observed.stderr).toContain("TypeError: boom");

    expect(recordIn(observed.stderr)).toBe("event=server-child-failure origin=uncaughtException error=TypeError");
  }, 30_000);

  it("NEGATIVE CONTROL: the same crash today, with no observer, says nothing", async () => {
    const bare = await spawnFixture("off", "throw");

    expect(bare.code, "it dies either way — that is why dying proves nothing").not.toBe(0);
    expect(bare.stdout).not.toContain("SURVIVED");
    expect(bare.stderr).toContain("TypeError: boom");
    // The check can fail. Without the wiring there is no record at all, which
    // is exactly the state both of 2026-09-22's outages were investigated in.
    expect(recordIn(bare.stderr), "no observer, no line").toBeNull();
  }, 30_000);

  it("covers the unhandledRejection origin, which is the other fatal path", async () => {
    const observed = await spawnFixture("on", "reject");

    expect(observed.code, "a dropped rejection is fatal by default and must stay so").not.toBe(0);
    expect(observed.stdout).not.toContain("SURVIVED");
    expect(recordIn(observed.stderr)).toBe("event=server-child-failure origin=unhandledRejection error=RangeError");
  }, 30_000);

  it("NEGATIVE CONTROL: a dropped rejection with no observer says nothing either", async () => {
    const bare = await spawnFixture("off", "reject");

    expect(bare.code).not.toBe(0);
    expect(recordIn(bare.stderr), "no observer, no line").toBeNull();
  }, 30_000);

  it("admits the origin and an allowlisted class name, and nothing the error was carrying", async () => {
    const observed = await spawnFixture("on", "custom");
    const record = recordIn(observed.stderr);

    // A bespoke class name is NOT echoed: it fails the allowlist and reports
    // as the generic Error. Names get chosen after whatever failed, and the
    // thing that failed is often an account or a host.
    expect(record).toBe("event=server-child-failure origin=uncaughtException error=Error");
    expect(record).not.toContain("FluxAuthError");
    expect(record).not.toContain("sk-live-FIXTURE0NOTREAL0SECRET");

    // And the reason that is a real property rather than a coincidence: the
    // secret and the class name DID reach the observer — Node prints both in
    // its own dump on the same stream. The record withheld them.
    expect(observed.stderr, "the error really did carry a credential-shaped value")
      .toContain("sk-live-FIXTURE0NOTREAL0SECRET");
    expect(observed.stderr).toContain("FluxAuthError");
  }, 30_000);
});

describe("why the write is synchronous", () => {
  it("survives a fatal exit with 4MB already queued on stderr", async () => {
    const observed = await spawnFixture("on", "throw", "sync", "backlog");

    expect(observed.code).not.toBe(0);
    expect(recordIn(observed.stderr)).toBe("event=server-child-failure origin=uncaughtException error=TypeError");
  }, 30_000);

  it("NEGATIVE CONTROL: the identical line written to the async stream is lost", async () => {
    const observed = await spawnFixture("on", "throw", "async", "backlog");

    // Same observer, same record, same crash. The only change is the writer,
    // and the line never reaches the parent: process.stderr in a forked child
    // is a pipe, a pipe-backed stream is asynchronous on POSIX, and a fatal
    // exit does not drain its queue. This is the failure mode the shipped
    // writer exists to remove, so it is measured and not assumed.
    expect(observed.code).not.toBe(0);
    expect(recordIn(observed.stderr), "the async line does not survive the exit").toBeNull();
    // The crash itself was still reported by Node, so the run is a real crash
    // and not a fixture that failed to fault.
    expect(observed.stderr).toContain("TypeError: boom");
  }, 30_000);
});

// The formatter is pure, so its edges are cheaper to pin in-process than to
// spawn for. None of these can be reached from the fixture, and all of them
// are reachable from a real fault.
describe("the record's edges", () => {
  it("falls back rather than echoing an origin or a name it does not recognise", () => {
    expect(formatServerChildFailure(new TypeError("x"), "uncaughtException")).toBe(
      "event=server-child-failure origin=uncaughtException error=TypeError\n",
    );
    // An origin Node does not currently produce is reported as the
    // conservative default instead of being passed through into the line.
    expect(formatServerChildFailure(new Error("x"), "somethingNew")).toBe(
      "event=server-child-failure origin=uncaughtException error=Error\n",
    );
    // A thrown non-Error (a string, a rejected object) has no name at all.
    expect(formatServerChildFailure("just a string", "unhandledRejection")).toBe(
      "event=server-child-failure origin=unhandledRejection error=Error\n",
    );
    expect(formatServerChildFailure(null, "unhandledRejection")).toBe(
      "event=server-child-failure origin=unhandledRejection error=Error\n",
    );
  });

  it("survives an error whose own name getter throws", () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("nope");
      },
    });
    expect(formatServerChildFailure(hostile, "uncaughtException")).toBe(
      "event=server-child-failure origin=uncaughtException error=Error\n",
    );
  });

  it("installs on the injected target and removes cleanly", () => {
    const written: string[] = [];
    const target = new EventEmitter() as unknown as NodeJS.Process;
    const dispose = installServerChildCrashObserver({ processTarget: target, write: (line) => written.push(line) });

    target.emit("uncaughtExceptionMonitor", new RangeError("x"), "unhandledRejection");
    expect(written).toEqual(["event=server-child-failure origin=unhandledRejection error=RangeError\n"]);

    dispose();
    target.emit("uncaughtExceptionMonitor", new RangeError("x"), "unhandledRejection");
    expect(written, "the disposer must actually detach").toHaveLength(1);
  });

  it("does not let a failing writer throw out of the fatal path", () => {
    const target = new EventEmitter() as unknown as NodeJS.Process;
    installServerChildCrashObserver({
      processTarget: target,
      write: () => {
        throw new Error("the log is gone");
      },
    });
    expect(() => target.emit("uncaughtExceptionMonitor", new Error("x"), "uncaughtException")).not.toThrow();
  });
});

// A module nobody installs observes nothing, and the test above would still
// be green — it spawns a fixture that installs the observer itself. This is
// the assertion that ties the shipped behaviour to the shipped entry point.
// It reads the entry as source rather than importing it, because importing
// server/index.ts starts a server and touches the owner's data directory.
it("the server entry installs the observer before it does anything else", () => {
  const entry = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("index.ts", entry, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  expect(entry, "the entry must import it from the shipped module").toContain(
    'import { installServerChildCrashObserver } from "./server-child-crash.mjs";',
  );

  // FIRST, and asserted as first rather than merely present. A fault raised
  // while the entry is still setting up — reading a lease, opening the store —
  // is exactly the boot-time crash there is currently no record of, and it is
  // only covered if nothing executable precedes this call.
  const first = source.statements.find((statement) => !ts.isImportDeclaration(statement));
  expect(first && ts.isExpressionStatement(first) && first.expression.getText(source)).toBe(
    "installServerChildCrashObserver()",
  );
});
