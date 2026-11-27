// A process whose exit census has to get past a full stderr pipe.
//
// It HAS to be a separate process: the census is written on the way out, on
// fd 2, which in the packaged server is a PIPE read by the desktop. Once
// anything touches process.stderr, Node puts that pipe in non-blocking mode,
// and a pipe whose reader is behind then refuses a write with EAGAIN instead
// of blocking. A census dropped there reads, in the owner's log, exactly like
// a server that was killed without ever reaching its exit path.
//
// Usage: node --experimental-strip-types io-census-backlog.fixture.ts [full]
//   full  fill the stderr pipe until it refuses (the parent is not reading),
//         then say "exiting" on stdout and exit at once. The parent resumes
//         reading only after that, the way a busy desktop catches up late.
import { writeSync } from "node:fs";

const [, , mode] = process.argv;
// Seed the launch counts before the meter module reads them, so the census has
// something to say without spawning anything (the counts are what a real
// server has accumulated by the time it exits).
const key = Symbol.for("murage.io.child-launches");
(globalThis as Record<symbol, unknown>)[key] = {
  installed: false,
  reported: false,
  entries: new Set<string>(),
  counts: { OWNED_NODE: 2, ENGINE_EXCLUDED: 3, UNMAPPED_NODE: 0 },
};
const { reportChildIoCensus } = await import("../io-child-meter.ts");
process.once("exit", reportChildIoCensus);

function fillUntilRefused(): void {
  const chunk = Buffer.alloc(4096, 0x50);
  for (let i = 0; i < 100_000; i += 1) {
    try { writeSync(2, chunk); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EAGAIN") return; throw error; }
  }
  throw new Error("stderr never refused a write: the pipe is blocking, so this run proves nothing");
}

if (mode === "full") {
  process.stderr.write(""); // the stream's first use is what makes fd 2 non-blocking
  fillUntilRefused();
  // The parent's stream may still pull up to its high-water mark after the
  // first refusal; let it stop, then fill what it took, so the pipe is full at exit.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  fillUntilRefused();
  writeSync(1, "exiting\n");
}
process.exit(0);
