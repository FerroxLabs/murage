// SPDX-License-Identifier: AGPL-3.0-or-later
import { ServerResponse, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { cloudHomeCopy } from "./copy.ts";

/** The WebSocket routes are the engine sign-in relay (engine-login.ts), the own-server relay and the bot call channel.
 * Authenticate before anything else; a relay runs only after this same gate,
 * and an upgrade no relay takes is rejected. */
export function attachCloudUpgradeGate(server: Server, auth: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>,
  relay?: (req: IncomingMessage, socket: Socket, head: Buffer, url: URL) => Promise<boolean>): void {
  server.on("upgrade", (req, socket, head) => {
    const res = new ServerResponse(req);
    res.assignSocket(socket as Socket);
    res.shouldKeepAlive = false;
    res.setHeader("connection", "close");
    res.once("finish", () => socket.end());
    void (async () => {
      let url: URL;
      try { url = new URL(req.url ?? "/", "http://localhost"); }
      catch { res.writeHead(400); res.end(); return; }
      if (await auth(req, res, url)) return;
      if (relay && await relay(req, socket as Socket, head, url)) return;
      res.writeHead(404, { "content-type": "application/json", "connection": "close" });
      res.end(JSON.stringify({ error: cloudHomeCopy.unsupportedUpgrade }));
    })().catch(() => socket.destroy());
  });
}
