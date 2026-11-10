// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BRTOKEN19: the Murage side of the engine's control token. A tokenless client is refused, the right token is accepted, and the
// token is in the engine's environment but never its argv. The known-answer vectors below are the ones the engine's own
// control_token.rs tests check (computed with openssl and Python's hmac, independent of both implementations).
import { createHmac } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { CONTROL_TOKEN_ENV, ControlClient, ControlSession, FRAME_PREFIX_LEN, closeDaemonSession, controlTokenFrom, framePrefixByteOk, isControlTokenMismatch, newControlToken, streamAuthHeaders } from "./browser-control-token.ts";

const TOKEN = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const OTHER = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
const CN = "a".repeat(32), SN = "b".repeat(32);
const SESSION_KEY = "22bae8d134ae0fab1650bc7641f5fbb1cc40828cf6489b8ee51b5893b48ac618";
const KAT = {
  proof: "1d791b794e71a4c99475f1f8a2cba691875b5f96123dc6f5624274adbd72915f",
  auth: "486e08f1ce516bc3d10d8b5617d314f6220f8098cd01e29bddad53dbca574e08",
  // ab1 frames, n = 0: HMAC(K, "ab1" || dir || 8 zero bytes || payload)
  clientFrameX: "ab1 0000000000000000 116e1abbf08ddbe595cb837441176d8ff233d0550f5d507686b0eb3b9d9a3653 x\n",
  serverFrameY: "ab1 0000000000000000 3aaac339e05b1cf23d894043ac8b7656defa95675f7914384316e8185895934f y\n",
};
const token = (hex = TOKEN) => Buffer.from(hex, "hex");
const bytes = (text: string) => Buffer.from(text, "utf8");

describe("the token itself", () => {
  it("is 32 random bytes per launch, in the child environment and never in argv", async () => {
    const a = newControlToken(), b = newControlToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(a).not.toBe(b);
    const source = readFileSync(new URL("./browser-engine.ts", import.meta.url), "utf8");
    // both launch environments (local and Cloud home) carry a fresh token; no args array mentions it
    expect(source.match(/\[CONTROL_TOKEN_ENV\]: newControlToken\(\)/gu)?.length).toBe(2);
    expect(source).not.toMatch(/args:[^\n]*CONTROL_TOKEN/u);
  });
  it("controlTokenFrom accepts exactly 64 hex characters", () => {
    expect(controlTokenFrom({ [CONTROL_TOKEN_ENV]: TOKEN })?.length).toBe(32);
    for (const bad of [undefined, "", "abc", TOKEN.slice(1), `${TOKEN}0`, TOKEN.replace("0", "g")]) expect(controlTokenFrom({ [CONTROL_TOKEN_ENV]: bad })).toBeUndefined();
    expect(streamAuthHeaders({ [CONTROL_TOKEN_ENV]: TOKEN })).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(streamAuthHeaders({})).toBeUndefined();
  });
  it("recognises the engine's stale-daemon refusal", () => {
    expect(isControlTokenMismatch('{"success":false,"error":"control_token_mismatch: the daemon did not prove the control token"}')).toBe(true);
    expect(isControlTokenMismatch("Failed to connect: refused")).toBe(false);
  });
});

describe("the handshake and the ab1 framing match the engine's known answers", () => {
  it("proof, auth and both frames", () => {
    const client = new ControlClient(token(), CN);
    const finished = client.finish(JSON.stringify({ proof: KAT.proof, nonce: SN }));
    expect(finished).toBeDefined();
    const { auth, session } = finished!;
    expect(JSON.parse(auth).auth).toBe(KAT.auth);
    expect(session.seal("x").toString("utf8")).toBe(KAT.clientFrameX);
    expect(session.open(bytes(KAT.serverFrameY))).toBe("y");
  });
  it("a daemon that does not know the token gets nothing: a wrong proof is refused before any auth is produced", () => {
    const client = new ControlClient(token(OTHER), CN);
    expect(client.finish(JSON.stringify({ proof: KAT.proof, nonce: SN }))).toBeUndefined();
    expect(client.finish(JSON.stringify({ proof: "11".repeat(32), nonce: SN }))).toBeUndefined();
    expect(client.finish("not json")).toBeUndefined();
    expect(client.finish(JSON.stringify({ proof: KAT.proof, nonce: "short" }))).toBeUndefined();
  });
  it("a server nonce must be exactly 32 LOWERCASE hex characters", () => {
    const client = new ControlClient(token(), CN);
    expect(client.finish(JSON.stringify({ proof: KAT.proof, nonce: SN }))).toBeDefined();
    for (const nonce of ["B".repeat(32), `${"b".repeat(31)}B`, "b".repeat(31), "b".repeat(33), `${"b".repeat(31)}g`, ` ${"b".repeat(31)}`]) {
      expect(client.finish(JSON.stringify({ proof: KAT.proof, nonce }))).toBeUndefined();
    }
  });
  it("there is no downgrade: an answer without a proof (an unpatched engine, or a squatter saying so) is refused like a wrong one", () => {
    const client = new ControlClient(token(), CN);
    expect(client.finish(JSON.stringify({ success: false, error: "Invalid command" }))).toBeUndefined();
    expect(client.finish("{}")).toBeUndefined();
    expect(client.finish(JSON.stringify({ success: true, data: { closed: true } }))).toBeUndefined();
  });
  it("a negative, signed, fractional, uppercase or mis-sized counter is refused, never thrown", () => {
    const key = Buffer.from(SESSION_KEY, "hex");
    const frame = (nField: string, payload = "x") => {
      // MAC'd as n = 0 so that a coercing parser would accept it
      const mac = createHmac("sha256", key).update("ab1").update("s").update(Buffer.alloc(8)).update(payload).digest("hex");
      return bytes(`ab1 ${nField} ${mac} ${payload}\n`);
    };
    const session = new ControlSession(key);
    for (const nField of ["-000000000000000", "+000000000000000", "-0000000000000001", "000000000000000A", "00000000000000", "00000000000000000", "0000000000000 00", "1.50000000000000", "0x00000000000000"]) {
      expect(session.open(frame(nField))).toBeUndefined();
    }
    // the control: the real frame for n = 0 still opens, so none of the refusals advanced the counter
    expect(session.open(frame("0000000000000000"))).toBe("x");
  });
  it("the legacy JSON frame is refused at byte 0", () => {
    const session = new ControlSession(Buffer.from(SESSION_KEY, "hex"));
    expect(session.open(bytes(`${JSON.stringify({ n: 0, m: "y", mac: "35e194a6a54150d84b890489509bbab752943c7b7bd45300a97c6b4ec5f99af5" })}\n`))).toBeUndefined();
    expect(framePrefixByteOk(0, "{".charCodeAt(0))).toBe(false);
  });
  it("the grammar rejects at the first wrong byte of the 86-byte prefix", () => {
    const prefix = `ab1 ${"0".repeat(16)} ${"1".repeat(64)} `;
    expect(prefix.length).toBe(FRAME_PREFIX_LEN);
    for (let i = 0; i < FRAME_PREFIX_LEN; i++) {
      for (let k = 0; k < FRAME_PREFIX_LEN; k++) expect(framePrefixByteOk(k, prefix.charCodeAt(k))).toBe(true);
      expect(framePrefixByteOk(i, "X".charCodeAt(0))).toBe(false);
    }
    for (const [pos, ch] of [[4, "A"], [4, "-"], [4, "+"], [30, "F"], [10, "\n"]] as const) expect(framePrefixByteOk(pos, ch.charCodeAt(0))).toBe(false);
  });
  it("frames reject replay, a skipped counter, tampering, a bare line and the client's own direction", () => {
    const session = new ControlSession(Buffer.from(SESSION_KEY, "hex"));
    const second = bytes(KAT.serverFrameY.replace("0000000000000000", "0000000000000001"));
    expect(session.open(second)).toBeUndefined();
    expect(session.open(bytes(KAT.serverFrameY.replace(" y\n", " Y\n")))).toBeUndefined();
    expect(session.open(bytes(KAT.clientFrameX))).toBeUndefined();
    expect(session.open(bytes('{"id":"1","action":"close"}\n'))).toBeUndefined();
    expect(session.open(bytes(KAT.serverFrameY))).toBe("y");
    expect(session.open(bytes(KAT.serverFrameY))).toBeUndefined();
  });
  it("the MAC is checked before UTF-8: a wrong MAC over invalid UTF-8 is refused, an authentic invalid-UTF-8 payload is refused too and advances nothing", () => {
    const key = Buffer.from(SESSION_KEY, "hex");
    const session = new ControlSession(key);
    const payload = Buffer.from([0xff, 0xfe, 0x7b]);
    const framed = (mac: string) => Buffer.concat([bytes(`ab1 ${"0".repeat(16)} ${mac} `), payload, bytes("\n")]);
    expect(session.open(framed("0".repeat(64)))).toBeUndefined();
    const real = createHmac("sha256", key).update("ab1").update("s").update(Buffer.alloc(8)).update(payload).digest("hex");
    expect(session.open(framed(real))).toBeUndefined();
    expect(session.open(bytes(KAT.serverFrameY))).toBe("y");
  });
  it("seal refuses a payload with a newline and every sealed line is exactly prefix + payload + newline", () => {
    const session = new ControlSession(Buffer.from(SESSION_KEY, "hex"));
    expect(() => session.seal("a\nb")).toThrow();
    const wire = session.seal("hello");
    expect(wire.length).toBe(FRAME_PREFIX_LEN + 5 + 1);
    expect(wire.toString("utf8").startsWith("ab1 0000000000000000 ")).toBe(true);
    expect(session.seal("hello").toString("utf8").startsWith("ab1 0000000000000001 ")).toBe(true);
  });
});

const sockets: Server[] = [];
afterEach(() => { for (const s of sockets.splice(0)) s.close(); });
const listen = (onConnection: (socket: Socket) => void): Promise<number> => new Promise((resolve) => {
  const server = createServer(onConnection);
  sockets.push(server);
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});
const lines = (socket: Socket, onLine: (line: string) => void) => {
  let data = "";
  socket.on("data", (chunk) => { data += chunk.toString(); let i: number; while ((i = data.indexOf("\n")) >= 0) { const l = data.slice(0, i); data = data.slice(i + 1); onLine(l); } });
  socket.on("error", () => {});
};
const mac = (key: Buffer, ...parts: Array<Buffer | string>) => { const h = createHmac("sha256", key); for (const p of parts) h.update(p); return h.digest(); };
const counter = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const frame = (key: Buffer, dir: "c" | "s", n: number, payload: string) => `ab1 ${n.toString(16).padStart(16, "0")} ${mac(key, "ab1", dir, counter(n), Buffer.from(payload)).toString("hex")} ${payload}\n`;

/** A patched daemon in miniature: proves the token, checks auth, then reads only authentic ab1 framed lines. */
function patchedDaemon(daemonToken: Buffer, seen: string[], replyFor: (key: Buffer) => string | Buffer = (key) => frame(key, "s", 0, JSON.stringify({ success: true, data: { closed: true } }))) {
  return listen((socket) => {
    let stage: "hello" | "auth" | "framed" = "hello";
    let cn = "", key: Buffer | undefined, received = 0;
    lines(socket, (line) => {
      if (stage === "hello") {
        try { cn = JSON.parse(line).hello; } catch { return socket.destroy(); }
        if (typeof cn !== "string" || !/^[0-9a-f]{32}$/u.test(cn)) return socket.destroy();
        socket.write(`${JSON.stringify({ proof: mac(daemonToken, "srv", cn).toString("hex"), nonce: SN })}\n`);
        stage = "auth";
      } else if (stage === "auth") {
        let presented = ""; try { presented = JSON.parse(line).auth; } catch { return socket.destroy(); }
        if (presented !== mac(daemonToken, "cli", SN, cn).toString("hex")) return socket.destroy();
        key = mac(daemonToken, "key", cn, SN); stage = "framed";
      } else {
        const m = /^ab1 ([0-9a-f]{16}) ([0-9a-f]{64}) (.*)$/u.exec(line);
        if (!m) return socket.destroy();
        const n = Number.parseInt(m[1]!, 16);
        if (n !== received || m[2] !== mac(key!, "ab1", "c", counter(n), Buffer.from(m[3]!)).toString("hex")) return socket.destroy();
        received++; seen.push(m[3]!);
        socket.write(replyFor(key!));
      }
    });
  });
}

describe("the Windows daemon port: closing a session", () => {
  it("the right token is accepted: the close is executed and its framed reply read", async () => {
    const seen: string[] = [];
    const port = await patchedDaemon(token(), seen);
    await expect(closeDaemonSession({ host: "127.0.0.1", port }, token())).resolves.toBeUndefined();
    expect(JSON.parse(seen[0]!).action).toBe("close");
  });
  it("a tokenless client is refused: the daemon never executes a command it did not authenticate", async () => {
    const seen: string[] = [];
    const port = await patchedDaemon(token(), seen);
    await expect(closeDaemonSession({ host: "127.0.0.1", port }, undefined)).rejects.toThrow();
    expect(seen).toEqual([]);
  });
  it("a daemon that does not hold our token is refused before anything is sent, and the token is not on the wire", async () => {
    const wire: string[] = [];
    // a squatter that answers the hello with a made-up proof
    const squat = await listen((socket) => {
      lines(socket, (l) => { wire.push(l); if (wire.length === 1) socket.write(`${JSON.stringify({ proof: "11".repeat(32), nonce: SN })}\n`); });
    });
    await expect(closeDaemonSession({ host: "127.0.0.1", port: squat }, token())).rejects.toThrow("did not prove");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wire.length).toBe(1);
    expect(wire.join("")).not.toContain(TOKEN);
  });
  it("a daemon with the other token fails the proof", async () => {
    const port = await patchedDaemon(token(OTHER), []);
    await expect(closeDaemonSession({ host: "127.0.0.1", port }, token())).rejects.toThrow("did not prove");
  });
  it("an engine without the patch, or a squatter claiming success, is refused: no plain close is ever sent to it and its 'closed' is not believed", async () => {
    const seen: string[] = [];
    const port = await listen((socket) => lines(socket, (line) => {
      seen.push(line);
      // answers every line as if it had closed
      socket.write(`${JSON.stringify({ success: true, data: { closed: true } })}\n`);
    }));
    await expect(closeDaemonSession({ host: "127.0.0.1", port }, token())).rejects.toThrow("did not prove");
    expect(seen.length).toBe(1);
    expect(JSON.parse(seen[0]!)).toHaveProperty("hello");
  });
  it("without a token (Unix, or none configured) it is the plain close", async () => {
    const port = await listen((socket) => lines(socket, () => socket.write(`${JSON.stringify({ success: true, data: { closed: true } })}\n`)));
    await expect(closeDaemonSession({ host: "127.0.0.1", port }, undefined)).resolves.toBeUndefined();
  });
  it("a reply whose first byte is not the frame grammar is refused at once, without waiting for a newline", async () => {
    const port = await patchedDaemon(token(), [], () => "{"); // a legacy JSON frame start, never finished, connection held open
    const started = Date.now();
    await expect(closeDaemonSession({ host: "127.0.0.1", port }, token())).rejects.toThrow("invalid");
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("a reply that breaks the prefix grammar part-way (an uppercase hex digit in the counter) is refused at that byte", async () => {
    const port = await patchedDaemon(token(), [], () => "ab1 000000000000000A");
    const started = Date.now();
    await expect(closeDaemonSession({ host: "127.0.0.1", port }, token())).rejects.toThrow("invalid");
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("a reply larger than its cap is refused without buffering past it, even with no newline", async () => {
    const port = await patchedDaemon(token(), [], (key) => {
      const head = frame(key, "s", 0, "").slice(0, FRAME_PREFIX_LEN); // a grammar-valid prefix
      return head + "a".repeat(65536 + 4096); // payload bytes with no newline, past 86 + 65536 + 1
    });
    await expect(closeDaemonSession({ host: "127.0.0.1", port }, token())).rejects.toThrow("exceeded its bound");
  });
  it("an oversized proof line is refused at 4096 bytes", async () => {
    const port = await listen((socket) => { lines(socket, () => socket.write("a".repeat(8192))); });
    await expect(closeDaemonSession({ host: "127.0.0.1", port }, token())).rejects.toThrow("exceeded its bound");
  });
  it("a daemon that drips bytes fails at the single 5 s deadline, not when the drip ends", async () => {
    const port = await listen((socket) => {
      lines(socket, () => {
        const head = `{"proof":"`;
        let i = 0;
        const timer = setInterval(() => { if (socket.destroyed) return clearInterval(timer); socket.write(head[i % head.length]!); i++; }, 400);
        socket.once("close", () => clearInterval(timer));
      });
    });
    const started = Date.now();
    await expect(closeDaemonSession({ host: "127.0.0.1", port }, token())).rejects.toThrow("timed out");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(6500);
  }, 15000);
});

describe("the stream port: the Authorization header", () => {
  it("a tokenless client is refused and the right token is accepted, against a server that checks the header", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, verifyClient: (info, done) => done(info.req.headers.authorization === `Bearer ${TOKEN}`, 401, "Unauthorized") });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as { port: number }).port;
    const dial = (headers?: Record<string, string>) => new Promise<"open" | string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`, headers ? { headers } : {});
      ws.once("open", () => { ws.close(); resolve("open"); });
      ws.once("error", (e) => resolve(e.message));
    });
    expect(await dial()).toMatch(/401/u);
    expect(await dial({ Authorization: `Bearer ${OTHER}` })).toMatch(/401/u);
    expect(await dial(streamAuthHeaders({ [CONTROL_TOKEN_ENV]: TOKEN }))).toBe("open");
    wss.close();
  });
  it("the relay presents the header on the stream connection and recovers from a stale daemon once", () => {
    const relay = readFileSync(new URL("./browser-native-relay.ts", import.meta.url), "utf8");
    expect(relay).toContain("headers: streamAuthHeaders(spec.env)");
    expect(relay).toContain("staleRecovered");
    expect(relay).toContain("closeDaemonSession(endpoint()");
  });
});
