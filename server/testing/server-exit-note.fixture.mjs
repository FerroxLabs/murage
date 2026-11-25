// A server child that ends in one of the ways the owner's Mac saw, in a process
// of its own (the exit record can only be read by a parent).
//
// Usage: node server-exit-note.fixture.mjs <graceful|stalled|throw|plain>
//   graceful  SIGTERM is answered like server/index.ts: note it, close, exit 0
//   stalled   SIGTERM is noted but shutdown never finishes (a writer that will
//             not stop); the parent then kills it, as the desktop does
//   throw     an uncaught exception after start
//   plain     exits 0 with nobody asking (an exit with no close request)
import { installServerChildCrashObserver, installServerChildExitNote } from "../server-child-crash.mjs";

const [, , mode] = process.argv;
installServerChildCrashObserver();
const note = installServerChildExitNote();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    note.closeRequested(signal);
    if (mode === "graceful") setTimeout(() => process.exit(0), 20);
  });
}
// The portable close request (Windows has no signal handlers): a line on stdin, like the server's close message.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (!String(chunk).includes("close")) return;
  note.closeRequested("message");
  if (mode === "graceful") setTimeout(() => process.exit(0), 20);
});
setInterval(() => {}, 1000); // a server does not exit on its own
process.stdout.write("ready\n");
if (mode === "throw") setTimeout(() => { throw new TypeError("boom"); }, 20);
if (mode === "plain") setTimeout(() => process.exit(0), 20);
