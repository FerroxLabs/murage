import { mkdtempSync } from "node:fs";
import { safeWipeSync } from "../../testing/safe-wipe.mjs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type TLSSocket } from "node:tls";
import { assertIsolated, certificates, host, name } from "./mail-server.ts";

export type WireFault = "drop-after-dot" | "drop-after-append" | "hold-append-tail" | "hold-dot-reply" | "hold-connect";
type Protocol = "imap" | "smtp";
type Capture = {
  commands: Array<{ verb: string; bytes: number; arguments?: string }>;
  clientBytes: number;
  serverBytes: number;
  forwardedServerBytes: number;
};
const CRLF = Buffer.from("\r\n");
const smtpVerbs = new Set(["EHLO", "HELO", "AUTH", "MAIL", "RCPT", "DATA", "RSET", "NOOP", "QUIT"]);
const imapVerbs = new Set(["CAPABILITY", "LOGIN", "AUTHENTICATE", "SELECT", "EXAMINE", "APPEND", "FETCH",
  "SEARCH", "STATUS", "LIST", "IDLE", "LOGOUT", "NOOP"]);

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

export async function startRecorder(
  protocol: Protocol,
  upstream: { port: number; name: string; ca: Buffer },
  fault?: WireFault,
) {
  assertIsolated();
  if (fault && fault !== "hold-connect" && (fault.includes("append") ? protocol !== "imap" : protocol !== "smtp")) {
    throw new Error("Recorder fault does not match the selected protocol");
  }
  const directory = mkdtempSync(join(tmpdir(), "mail-recorder-"));
  const sockets = new Set<Socket>();
  const connections: Capture[] = [];
  const reached = barrier();
  const release = barrier();
  const settled = barrier();
  let armed = fault;

  function claim(at: WireFault) {
    if (armed !== at) return false;
    armed = undefined;
    reached.resolve();
    return true;
  }

  function track(socket: Socket) {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  }

  function forward(client: TLSSocket) {
    if (client.destroyed) return;
    const peer = connect({ host, port: upstream.port, servername: upstream.name, ca: upstream.ca });
    track(peer);
    const capture: Capture = { commands: [], clientBytes: 0, serverBytes: 0, forwardedServerBytes: 0 };
    connections.push(capture);
    let pendingClient = Buffer.alloc(0);
    let pendingPeer = Buffer.alloc(0);
    let literalSize: number | undefined;
    let appendTag: string | undefined;
    let smtpData = false;
    let dataRequested = false;
    let awaitingDot = false;
    let detached = false;
    let holdingReply = false;

    const reply = (line: Buffer) => {
      if (client.destroyed) return;
      capture.forwardedServerBytes += line.byteLength;
      client.write(line);
    };
    const endDetached = () => {
      settled.resolve();
      peer.end();
    };
    const dropClient = () => {
      detached = true;
      client.destroy();
    };

    client.on("close", () => {
      if (!detached) peer.destroy();
      if (holdingReply) settled.resolve();
    });
    peer.on("close", () => {
      if (detached || holdingReply) settled.resolve();
      client.destroy();
    });

    client.on("data", (chunk: Buffer) => {
      capture.clientBytes += chunk.byteLength;
      pendingClient = Buffer.concat([pendingClient, chunk]);
      while (pendingClient.byteLength > 0) {
        if (literalSize !== undefined) {
          if (pendingClient.byteLength < literalSize + CRLF.length) return;
          const literal = pendingClient.subarray(0, literalSize + CRLF.length);
          pendingClient = pendingClient.subarray(literal.byteLength);
          literalSize = undefined;
          if (claim("hold-append-tail")) {
            const previous = literal.lastIndexOf(CRLF, literal.byteLength - 5);
            const tail = previous < 0 ? 0 : previous + CRLF.length;
            peer.write(literal.subarray(0, tail));
            dropClient();
            void release.promise.then(() => { if (!peer.destroyed) peer.write(literal.subarray(tail)); });
            return;
          }
          peer.write(literal);
          if (claim("drop-after-append")) {
            dropClient();
            return;
          }
          continue;
        }

        const end = pendingClient.indexOf(CRLF);
        if (end < 0) return;
        const line = pendingClient.subarray(0, end + CRLF.length);
        pendingClient = pendingClient.subarray(line.byteLength);
        const text = line.toString("utf8").trimEnd();
        if (protocol === "smtp" && smtpData) {
          peer.write(line);
          if (text === ".") {
            smtpData = false;
            awaitingDot = true;
            if (claim("drop-after-dot")) {
              dropClient();
              return;
            }
          }
          continue;
        }

        const [first = "", second = "", third = ""] = text.split(/\s+/, 3);
        if (protocol === "smtp") {
          const verb = first.toUpperCase();
          if (smtpVerbs.has(verb)) {
            const args = verb === "MAIL" || verb === "RCPT" ? text.slice(first.length).trim() : undefined;
            capture.commands.push({ verb, bytes: line.byteLength, arguments: args });
          }
          if (verb === "DATA") dataRequested = true;
        } else {
          const verb = second.toUpperCase();
          const uidVerb = third.toUpperCase();
          const command = text.slice(first.length).trimStart();
          if (imapVerbs.has(verb)) {
            const args = ["SELECT", "EXAMINE", "FETCH", "SEARCH", "STATUS"].includes(verb)
              ? command.slice(second.length).trim() : undefined;
            capture.commands.push({ verb, bytes: line.byteLength, arguments: args });
          } else if (verb === "UID" && ["FETCH", "SEARCH"].includes(uidVerb)) {
            capture.commands.push({
              verb: `UID ${uidVerb}`,
              bytes: line.byteLength,
              arguments: command.slice(second.length).trimStart().slice(third.length).trim(),
            });
          } else if (/^DONE$/i.test(text)) {
            capture.commands.push({ verb: "DONE", bytes: line.byteLength });
          }
          if (verb === "APPEND") {
            appendTag = first;
            const size = /\{(\d+)\+?\}$/.exec(text);
            if (size) literalSize = Number(size[1]);
          }
        }
        peer.write(line);
      }
    });

    peer.on("data", (chunk: Buffer) => {
      capture.serverBytes += chunk.byteLength;
      pendingPeer = Buffer.concat([pendingPeer, chunk]);
      let end: number;
      while ((end = pendingPeer.indexOf(CRLF)) >= 0) {
        const line = pendingPeer.subarray(0, end + CRLF.length);
        pendingPeer = pendingPeer.subarray(line.byteLength);
        const text = line.toString("utf8");
        if (protocol === "smtp" && /^\d{3} /.test(text)) {
          if (dataRequested) {
            dataRequested = false;
            smtpData = text.startsWith("354 ");
          } else if (awaitingDot) {
            awaitingDot = false;
            if (detached) {
              endDetached();
              return;
            }
            if (claim("hold-dot-reply")) {
              holdingReply = true;
              void release.promise.then(() => {
                holdingReply = false;
                reply(line);
                settled.resolve();
              });
              continue;
            }
          }
        }
        if (appendTag && text.startsWith(`${appendTag} `)) {
          appendTag = undefined;
          if (detached) {
            endDetached();
            return;
          }
        }
        if (!detached) reply(line);
      }
    });
  }

  let identity;
  try { identity = certificates(directory); } catch (error) {
    safeWipeSync(directory);
    throw error;
  }
  const server = createServer(identity, client => {
    track(client);
    if (claim("hold-connect")) {
      client.once("close", () => settled.resolve());
      void release.promise.then(() => {
        forward(client);
        settled.resolve();
      });
      return;
    }
    forward(client);
  });
  server.on("connection", track);
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("Recorder port unavailable"));
        resolve(address.port);
      });
    });
    return {
      host, name, ca: identity.ca, port, connections,
      reached: reached.promise, release: release.resolve, settled: settled.promise,
      async close() {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        safeWipeSync(directory);
      },
    };
  } catch (error) {
    safeWipeSync(directory);
    throw error;
  }
}
