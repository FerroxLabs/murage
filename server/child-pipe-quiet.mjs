// AN UNHEARD 'error' ON A CHILD'S PIPE ENDS THE SERVER.
//
// THE OUTAGE THIS EXISTS FOR. On 2026-09-22 at 05:43:42Z the owner's server
// died mid-session and nothing restarted it. He could not send a message and
// his inbox could not load: one corpse, two masks. It was the SECOND crash of
// that shape in nine hours. The first was a WebSocket torn down without a
// listener (see browser-socket-teardown.ts); this one was a plain pipe.
//
//     Error: write EPIPE
//         at Socket._writeGeneric → Socket._write → Writable.write
//         at send (…/server/index.js:168476)
//     Emitted 'error' event on Socket instance at: emitErrorNT
//
// WHAT THE CODE BELIEVED, AND WHY IT IS WRONG. Four places write to a child's
// stdin, and the two that thought about failure at all wrote this:
//
//     if (!child.stdin?.writable) return;            // does not help
//     try {                                           // does not help
//       child.stdin.write(payload, (error) => { … }); // does not help
//     } catch { … }
//
// None of those three defences does anything here, and that is the whole
// lesson:
//
//   - `writable` is TRUE right up until the write syscall fails. A pipe whose
//     reader has gone does not announce itself in advance.
//   - `try/catch` cannot catch it. The failure arrives on a LATER TICK, by
//     which time the try block is long gone — the same reason it could not
//     save the WebSocket teardown.
//   - THE WRITE CALLBACK RUNS AND THE PROCESS DIES ANYWAY. This is the one
//     that reads as safe, and it is worse than useless: it is not wrong about
//     the error, it is wrong about what handling an error means. On a pipe,
//     EPIPE destroys the stream and emits `'error'` ON THE STREAM. A write
//     callback is not an `'error'` listener. The callback is handed the code,
//     runs the caller's recovery, and then Node ends the process over the
//     unheard event regardless. The recovery never mattered.
//
// That last point was got WRONG on the first pass here — the comment claimed
// the callback never runs — and the negative control in
// `child-pipe-quiet.test.ts` caught it: the unguarded fixture prints
// `CALLBACK:EPIPE` and still dies. It is worth keeping the correction, because
// the false version makes the bug look like an oversight and the true version
// shows it is a misconception. Every one of these sites was written by
// somebody who had thought about failure.
//
// Verified rather than reasoned about, because the same callback DOES survive
// on a TCP socket, and that near miss is how the belief stays alive. A child
// that closes stdin and keeps running reproduces the owner's stack line for
// line; a child that has merely exited gives ERR_STREAM_DESTROYED on a
// different, non-fatal path and proves nothing.
//
// So the fix is a listener, not a guard — the same shape as
// `closeSocketQuietly`, for the same reason. A no-op listener does not
// swallow anything a caller is already handling: existing `'error'` handlers
// and write callbacks keep running. It removes exactly one behaviour, which
// is Node ending the process over a pipe that went away.

/**
 * Make a spawned child's pipes unable to kill this process.
 *
 * Call it once, immediately after spawn, before anything can be written. All
 * three streams are covered: stdin is where this bit the owner, but an `'error'`
 * on stdout or stderr is fatal by exactly the same rule, and a child dying at
 * the wrong moment can produce one.
 *
 * @param {{ stdin?: unknown, stdout?: unknown, stderr?: unknown } | null | undefined} child
 */
export function quietChildPipes(child) {
  if (!child) return;
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    // `on`, not `once`: a stream can emit more than one, and the second would
    // be the fatal one. Duck-typed so a fake child in a test is covered too.
    if (stream && typeof stream.on === "function") stream.on("error", () => {});
  }
}
