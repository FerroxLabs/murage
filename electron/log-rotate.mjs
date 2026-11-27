// server.log grows for as long as Murage runs, so at launch an oversized log
// becomes one old copy and the new run starts a fresh file.
//
// This runs once, after the single-instance lock: a second launch exits before
// it, so a running Murage never has its log moved from under it. Every failure
// is left as it is. On Windows a file another program holds open can refuse the
// rename, and then the run keeps appending to the same file, so nothing is lost
// and launch carries on. The rename replaces the previous old copy in one step,
// and if that step is refused both files stay as they were.
import fs from "node:fs";

export const SERVER_LOG_MAX_BYTES = 50 * 1024 * 1024;

/** server.log -> server.log.1, the name call-trace.log's old copy already uses. */
export function oldLogPath(logPath) {
  return `${logPath}.1`;
}

/** Returns true when the log moved to its old copy. Never throws. */
export function rotateLogAtLaunch(logPath, { maxBytes = SERVER_LOG_MAX_BYTES, fileSystem = fs } = {}) {
  try {
    const seen = fileSystem.lstatSync(logPath);
    if (!seen.isFile() || seen.size <= maxBytes) return false;
    fileSystem.renameSync(logPath, oldLogPath(logPath));
    return true;
  } catch {
    return false;
  }
}

/** Open a log for appending. A stream with no error listener takes the whole
 * app down when a file cannot be opened, as it can on Windows while another
 * program holds it; here the caller just hears the stream is gone. */
export function openLogStream(logPath, onLost, fileSystem = fs) {
  const stream = fileSystem.createWriteStream(logPath, { flags: "a" });
  stream.on("error", () => onLost(stream));
  return stream;
}

/** The running app's log writer. It counts the bytes it appends and, once the
 * file passes maxBytes, moves it to the old copy and opens a fresh file, so a
 * run of weeks keeps the same bound as a launch. Lines already handed to the
 * old stream still land in the old copy. If the move is refused (Windows, file
 * held open) the run keeps appending to the same file and tries again after
 * another retryBytes, so nothing is lost. */
export function createServerLog(logPath, { maxBytes = SERVER_LOG_MAX_BYTES, retryBytes = 1024 * 1024, fileSystem = fs } = {}) {
  let stream = null;
  let bytes = 0;
  let nextCheck = maxBytes;
  const open = () => {
    try { bytes = fileSystem.lstatSync(logPath).size; } catch { bytes = 0; }
    nextCheck = Math.max(maxBytes, bytes + 1);
    // The descriptor is taken now, not when the stream gets round to it, so a
    // move right after this never leaves queued lines heading for a new file.
    const fd = fileSystem.openSync(logPath, "a", 0o600);
    const opened = fileSystem.createWriteStream(logPath, { fd, flags: "a" });
    opened.on("error", () => { if (stream === opened) stream = null; });
    stream = opened;
  };
  return {
    write(text) {
      if (!stream) open();
      stream.write(text);
      bytes += Buffer.byteLength(text);
      if (bytes <= nextCheck) return;
      const held = stream;
      try {
        fileSystem.renameSync(logPath, oldLogPath(logPath));
      } catch {
        nextCheck = bytes + retryBytes;
        return;
      }
      held.end();
      stream = null;
      bytes = 0;
      nextCheck = maxBytes;
    },
  };
}
