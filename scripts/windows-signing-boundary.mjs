// Pipe client owner: win-sac-sign; SYSTEM pipe server, token authorization and VM lifetime owner: MAIN.
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
const pipe = "\\\\.\\pipe\\MurageSigningBoundary";
const fail = () => Error("WINDOWS_SIGNING_BOUNDARY_REJECTED");

/** One connection for the lease lifetime: a disconnect revokes it at the service. */
export function windowsSigningBoundary({ lease, launchSha256, runAuthorizationSha256, platform = process.platform, open = connect } = {}) {
  if (platform !== "win32" || [lease, launchSha256, runAuthorizationSha256].some(value => !/^[a-f0-9]{64}$/.test(value ?? ""))) throw fail();
  let socket, pending, buffer = Buffer.alloc(0), sealed = false, used = false, closed = false;
  const close = () => { closed = true; socket?.destroy(); pending?.reject(fail()); pending = undefined; };
  const request = async (operation, fields) => {
    if (closed || pending) throw fail();
    if (!socket) {
      socket = open(pipe);
      socket.setTimeout(31 * 60_000, close);
      socket.on("error", close); socket.on("close", close);
      socket.on("data", bytes => {
        buffer = Buffer.concat([buffer, bytes]);
        if (buffer.length > 4096) return close();
        const end = buffer.indexOf(10);
        if (end === -1) return;
        if (!pending || end !== buffer.length - 1) return close();
        try {
          const value = JSON.parse(buffer.subarray(0, end));
          if (value.id !== pending.id || value.ok !== true || Object.keys(value).sort().join(",") !== "id,ok,result") return close();
          const resolve = pending.resolve; pending = undefined; buffer = Buffer.alloc(0); resolve(value.result);
        } catch { close(); }
      });
    }
    return new Promise((resolve, reject) => {
      const id = randomBytes(16).toString("hex"); pending = { id, resolve, reject };
      socket.write(`${JSON.stringify({ id, operation, lease, ...fields })}\n`, error => { if (error) close(); });
    });
  };
  return Object.freeze({
    async assertIsolatedAndSealed() {
      if (sealed || used) throw fail();
      const result = await request("seal", { launchSha256, runAuthorizationSha256 });
      if (!result || Object.keys(result).join(",") !== "measurementId" || !/^[a-f0-9]{64}$/.test(result.measurementId ?? "")) { close(); throw fail(); }
      sealed = result.measurementId;
    },
    async release() {
      if (!sealed || used) throw fail();
      used = true;
      try {
        const result = await request("release", { measurementId: sealed });
        if (!result || Object.keys(result).sort().join(",") !== "exitCode,receiptSha256" || result.exitCode !== 0
          || !/^[a-f0-9]{64}$/.test(result.receiptSha256 ?? "")) throw fail();
        return result;
      } finally { close(); }
    },
    close,
  });
}
