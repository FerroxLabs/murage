import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createServer, type TLSSocket } from "node:tls";
import { ImapFlow } from "imapflow";
import SMTPConnection from "nodemailer/lib/smtp-connection";
import { afterAll, beforeAll, expect, it } from "vitest";

const host = "127.0.0.1";
let cert: Buffer;
let key: Buffer;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "mail-probe-"));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=mail.example.test", "-addext", `subjectAltName=IP:${host}`,
      "-out", certPath, "-keyout", keyPath], { stdio: "pipe" });
    cert = readFileSync(certPath);
    key = readFileSync(keyPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
afterAll(() => { key?.fill(0); });

async function serve(greeting: string, respond: (line: string) => string, probe: (port: number) => Promise<void>) {
  const lines: string[] = [];
  const sockets = new Set<TLSSocket>();
  const server = createServer({ cert, key }, socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.write(greeting + "\r\n");
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", line => {
      lines.push(line);
      const reply = respond(line);
      if (reply) {
        socket.write(reply + "\r\n");
        if (/^(QUIT|\w+ LOGOUT)$/.test(line)) socket.end();
      }
    });
  });
  server.listen(0, host);
  await once(server, "listening");
  const endpoint = server.address();
  if (!endpoint || typeof endpoint === "string") throw new Error("Missing loopback port");
  try {
    await probe(endpoint.port);
    return lines;
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const envelope = {
  from: "owner@mail.example.test",
  to: ["accepted@mail.example.test", "refused@mail.example.test"],
};

it.each([false, true])("D1e reads both RCPT replies before DATA (PIPELINING=%s)", async pipelining => {
  let body = false;
  const replies: number[] = [];
  const wire = await serve("220 fixture ESMTP", line => {
    if (body) {
      if (line !== ".") return "";
      body = false;
      return "250 accepted";
    }
    if (line.startsWith("EHLO ")) return pipelining ? "250-fixture\r\n250 PIPELINING" : "250 fixture";
    if (line.startsWith("MAIL FROM:")) return "250 sender accepted";
    if (line === `RCPT TO:<${envelope.to[0]}>`) return "250 recipient accepted";
    if (line === `RCPT TO:<${envelope.to[1]}>`) return "550 recipient refused";
    if (line === "RSET") return "250 reset";
    if (line === "QUIT") return "221 goodbye";
    if (line === "DATA") { body = true; return "354 end with dot"; }
    return "500 unexpected";
  }, async port => {
    const smtp = new SMTPConnection({ host, port, secure: true, name: `[${host}]`, tls: { ca: cert } });
    // The pinned library routes each reply through this queue before its high-level send path can write DATA.
    const wire = smtp as unknown as {
      _responseActions: Array<(reply: string) => void>;
      _sendCommand(command: string): void;
    };
    const command = (line: string) => new Promise<number>(resolve => {
      wire._responseActions.push(reply => resolve(Number(reply.slice(0, 3))));
      wire._sendCommand(line);
    });
    let rejectSocket!: (error: Error) => void;
    const socketFailure = new Promise<never>((_, reject) => { rejectSocket = reject; });
    smtp.on("error", error => rejectSocket(error));
    const ended = once(smtp, "end");
    // Observe a possible early error immediately, even before the test awaits shutdown.
    void ended.catch(() => {});
    try {
      const connected = once(smtp, "connect");
      smtp.connect();
      await Promise.race([connected, socketFailure]);
      expect(await Promise.race([command(`MAIL FROM:<${envelope.from}>`), socketFailure])).toBe(250);
      for (const recipient of envelope.to) {
        replies.push(await Promise.race([command(`RCPT TO:<${recipient}>`), socketFailure]));
      }
      if (replies.some(code => code >= 400)) {
        await Promise.race([new Promise<void>((resolve, reject) => smtp.reset(error => error ? reject(error) : resolve())), socketFailure]);
      } else {
        await Promise.race([command("DATA"), socketFailure]);
      }
      smtp.quit();
      await ended;
    } finally {
      smtp.close();
    }
  });
  expect(wire.filter(line => line.startsWith("RCPT TO:"))).toEqual(envelope.to.map(to => `RCPT TO:<${to}>`));
  expect(wire.filter(line => line === "DATA")).toHaveLength(0);
  expect(replies).toEqual([250, 550]);
  expect(wire.slice(-2)).toEqual(["RSET", "QUIT"]);
});

it("D1e suppresses IMAP ID and fetches by sequence while returning the UID", async () => {
  let fetched: unknown;
  const capabilities = "* CAPABILITY IMAP4rev1 ID NAMESPACE";
  const wire = await serve("* OK fixture IMAP", line => {
    const [tag, verb] = line.split(" ");
    switch (verb) {
      case "CAPABILITY": return `${capabilities}\r\n${tag} OK capability`;
      case "ID": return `* ID NIL\r\n${tag} OK id`;
      case "LOGIN": return `${tag} OK login`;
      case "NAMESPACE": return `* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK namespace`;
      case "LIST": return `* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK list`;
      case "LSUB": return `${tag} OK lsub`;
      case "EXAMINE": case "SELECT": return `* FLAGS (\\Seen)\r\n* 3 EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 94] next\r\n${tag} OK [READ-ONLY] opened`;
      case "FETCH": case "UID": return `* 3 FETCH (UID 93)\r\n${tag} OK fetched`;
      case "LOGOUT": return `* BYE done\r\n${tag} OK logout`;
      default: return `${tag} BAD unexpected`;
    }
  }, async port => {
    const imap = new ImapFlow({ host, port, secure: true, tls: { ca: cert }, logger: false, disableAutoIdle: true,
      auth: { user: "fixture", pass: "fixture" } });
    // The command map is shared by default. Override ID on this connection only.
    const dispatch = imap as unknown as { commands: Map<string, unknown> };
    dispatch.commands = new Map(dispatch.commands).set("ID", async () => false);
    try {
      await imap.connect();
      await imap.mailboxOpen("INBOX", { readOnly: true });
      fetched = await imap.fetchOne("3", { uid: true }, { uid: false });
      await imap.logout();
    } finally {
      imap.close();
    }
  });
  expect(wire.filter(line => /^\S+ ID\b/.test(line))).toHaveLength(0);
  expect(wire.filter(line => /^\S+ (?:UID )?FETCH\b/.test(line))).toEqual([expect.stringMatching(/^\S+ FETCH 3 (?:UID|\(UID\))$/)]);
  expect(fetched).toMatchObject({ seq: 3, uid: 93 });
});
