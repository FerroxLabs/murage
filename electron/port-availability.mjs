// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";

/** Whether this process could listen on host:port right now. The desktop
 * checks before forking the harness on a port: forking onto a port another
 * program already holds made the child die with an uncaught EADDRINUSE and
 * exit 1, which the crash log recorded as an abnormal utility exit on every
 * launch (and every backup return) whenever 8799 was taken. Resolves false
 * only for "in use"; any other failure resolves true so the fork, and its own
 * error reporting, still decide. */
export function portAvailable(port, host = "127.0.0.1") {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", error => resolve(error?.code !== "EADDRINUSE"));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}
