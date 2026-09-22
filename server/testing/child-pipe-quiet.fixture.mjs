// The owner's crash, on demand, in a process of its own.
//
// It has to be a separate process because the thing being tested is whether
// the process SURVIVES. An in-process assertion cannot observe its own death,
// and `expect(() => …).toThrow()` is exactly the wrong instrument: the throw
// arrives on a later tick, from Node's fatal path, not from the call.
//
// argv[2] === "guard" applies the fix. Anything else reproduces the outage.
import { spawn } from "node:child_process";

import { quietChildPipes } from "../child-pipe-quiet.mjs";

// A child that CLOSES ITS STDIN AND KEEPS RUNNING. That is the shape that
// produces a real EPIPE: the pipe still exists, the write reaches the syscall,
// and the syscall fails. A child that has merely exited gives
// ERR_STREAM_DESTROYED instead, which is a different and non-fatal path — the
// first attempt at this fixture made that mistake and proved nothing.
const child = spawn("/bin/sh", ["-c", "exec 0<&-; sleep 5"], { stdio: ["pipe", "ignore", "ignore"] });

if (process.argv[2] === "guard") quietChildPipes(child);

setTimeout(() => {
  // Every defence the real code had, none of which keeps the process alive.
  // The callback below DOES fire with EPIPE in the unguarded run, and the
  // process still dies: handling an error is not the same as hearing the
  // event, and only the second one matters to Node.
  try {
    if (!child.stdin?.writable) {
      console.log("UNREACHABLE: the pipe reported itself unwritable");
      process.exit(0);
    }
    child.stdin.write("probe\n", (error) => {
      console.log(`CALLBACK:${error?.code ?? "none"}`);
    });
  } catch (error) {
    console.log(`CAUGHT:${error?.code ?? "unknown"}`);
  }
}, 300);

setTimeout(() => {
  console.log("SURVIVED");
  child.kill("SIGKILL");
  process.exit(0);
}, 1500);
