// A server child that dies on demand, in a process of its own.
//
// It HAS to be a separate process. The claim under test is "the observer
// records the fault and the process still dies", and no in-process assertion
// can watch its own death: by the time Node's fatal path runs, the test
// runner's expectations are as dead as the code they were checking. So the
// only instrument that proves anything here is an exit code read by a parent.
//
// Usage:
//   node server-child-crash.fixture.mjs <on|off> <throw|reject|custom> [sync|async] [backlog]
//
//   on|off            install the observer, or reproduce today's silence
//   throw             a plain uncaught exception
//   reject            an unhandled rejection (Node's other fatal origin)
//   custom            an exception whose class name and message are both
//                     things that must never reach the log line
//   sync|async        which writer the observer is handed — `sync` is the
//                     shipped `writeCrashLineSync`, `async` is the ordinary
//                     `process.stderr.write` it exists to avoid
//   backlog           queue 4 MB on the async stderr stream ahead of the
//                     crash line, which is the state a busy server's log is
//                     already in when it dies
import { installServerChildCrashObserver, writeCrashLineSync } from "../server-child-crash.mjs";

const [, , observer, fault, writer = "sync", backlog] = process.argv;

// Enough to overflow the OS pipe buffer several times over, so the stream has
// a real queue rather than a write that happened to complete inline.
const BACKLOG = `${"P".repeat(4 * 1024 * 1024)}\n`;

function chosenWrite(line) {
  if (backlog === "backlog") process.stderr.write(BACKLOG);
  if (writer === "async") process.stderr.write(line);
  else writeCrashLineSync(line);
}

if (observer === "on") {
  // The default install takes no `write` at all; the injection here exists so
  // the test can run the async writer as a controlled comparison against the
  // shipped synchronous one.
  installServerChildCrashObserver(writer === "sync" && backlog !== "backlog" ? {} : { write: chosenWrite });
}

// A credential-shaped value and a bespoke error class, both of which a real
// provider client produces and neither of which may appear in the record.
class FluxAuthError extends Error {
  name = "FluxAuthError";
}

setTimeout(() => {
  if (fault === "reject") {
    // No `.catch`, no `unhandledRejection` listener anywhere: Node's default
    // mode raises this through the same fatal path, with origin
    // "unhandledRejection".
    void Promise.reject(new RangeError("dropped"));
    return;
  }
  if (fault === "custom") throw new FluxAuthError("auth failed for api_key=sk-live-FIXTURE0NOTREAL0SECRET");
  throw new TypeError("boom");
}, 50);

// Never reached if the fault stayed fatal. If this prints, the observer
// swallowed the exception and the server is still running on corrupt state —
// the exact outcome this design refuses.
setTimeout(() => {
  console.log("SURVIVED");
  process.exit(0);
}, 2000);
