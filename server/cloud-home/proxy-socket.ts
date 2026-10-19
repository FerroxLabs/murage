// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { isAbsolute } from "node:path";
import { cloudHomeCopy } from "./copy.ts";

/** Transport provenance is assigned only by our Unix listener, never headers. */
const unixConnections = new WeakMap<Socket, string>();
export function trustedCloudSocket(req: IncomingMessage, trustedProxy?: string): boolean {
  const path = unixConnections.get(req.socket);
  return !req.socket.remoteAddress && path !== undefined && trustedProxy === `unix:${path}`;
}

/** Call after binding TCP, so another live home cannot lose its proxy socket. */
export function listenCloudProxy(upstream: Server, path: string): Server | null {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return null;
  if (!isAbsolute(path)) throw new Error(cloudHomeCopy.invalidProxySocket);
  const previous = lstatSync(path, { throwIfNoEntry: false });
  if (previous) {
    if (!previous.isSocket() || previous.uid !== process.getuid?.()) throw new Error(cloudHomeCopy.invalidProxySocket);
    unlinkSync(path);
  }
  const proxy = createServer();
  proxy.headersTimeout = upstream.headersTimeout;
  proxy.requestTimeout = upstream.requestTimeout;
  proxy.keepAliveTimeout = upstream.keepAliveTimeout;
  proxy.on("connection", socket => { unixConnections.set(socket, path); });
  proxy.on("request", (req, res) => { upstream.emit("request", req, res); });
  proxy.on("upgrade", (req, socket, head) => {
    if (!upstream.listenerCount("upgrade")) socket.destroy();
    else upstream.emit("upgrade", req, socket, head);
  });
  proxy.on("error", error => { upstream.emit("error", error); });
  upstream.once("close", () => { proxy.close(); proxy.closeAllConnections(); });
  proxy.listen(path, () => { chmodSync(path, 0o660); });
  return proxy;
}
