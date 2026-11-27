import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { greeterVariants, startGreeter } from "./greeter.ts";
import { account, assertIsolated, refused, startMailServer, variants } from "./mail-server.ts";
import { startRecorder } from "./recorder-proxy.ts";
import { openWire, type Wire } from "./wire.ts";

type Mail = Awaited<ReturnType<typeof startMailServer>>;
const messageId = "<fixture@mail.example.test>";
const recipient = "shop@vendor.example.test";
const message = `From: ${account}\r\nTo: ${recipient}\r\nMessage-ID: ${messageId}\r\nSubject: Fixture\r\n\r\nBody\r\n`;

async function imapLogin(mail: Mail, connection = openWire(mail, mail.imaps, true)) {
  try {
    expect(await connection.next()).toMatch(/^\* OK .*Dovecot/i);
    expect(await connection.imap("L", `LOGIN "${mail.account}" "${mail.password}"`)).toMatch(/^L OK/m);
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

async function smtpLogin(mail: Mail) {
  const plain = openWire(mail, mail.smtp);
  let wire = plain;
  try {
    expect(await plain.next()).toMatch(/^220 .*ESMTP Postfix/i);
    const plaintextCapabilities = await plain.smtp("EHLO fixture.example.test");
    expect(plaintextCapabilities).toMatch(/STARTTLS/i);
    expect(plaintextCapabilities).not.toMatch(/AUTH/i);
    expect(await plain.smtp("AUTH PLAIN")).toMatch(/^503 .*authentication not enabled/i);
    expect(await plain.smtp("STARTTLS")).toMatch(/^220 /);
    wire = plain.startTls(mail);
    await authenticate(wire, mail);
    return wire;
  } catch (error) {
    wire.close();
    throw error;
  }
}

async function authenticate(wire: Wire, mail: Mail) {
  expect(await wire.smtp("EHLO fixture.example.test")).toMatch(/AUTH .*PLAIN/i);
  const auth = Buffer.from(`\u0000${mail.account}\u0000${mail.password}`).toString("base64");
  expect(await wire.smtp(`AUTH PLAIN ${auth}`)).toMatch(/^235 /);
}

async function sendData(wire: Wire, mail: Mail, rejectRecipient = false) {
  expect(await wire.smtp(`MAIL FROM:<${mail.account}>`)).toMatch(/^250 /);
  if (rejectRecipient) expect(await wire.smtp(`RCPT TO:<${refused}>`)).toMatch(/^550 /);
  expect(await wire.smtp(`RCPT TO:<${recipient}>`)).toMatch(/^250 /);
  expect(await wire.smtp("DATA")).toMatch(/^354 /);
  wire.write(`${message}.\r\n`);
}

async function submit(mail: Mail, to = recipient) {
  const wire = await smtpLogin(mail);
  try {
    await sendData(wire, mail, to === refused);
    expect(await wire.reply(/^\d{3} /)).toMatch(/^250 /);
  } finally {
    wire.close();
  }
}

async function append(wire: Wire, tag: string, folder: string, contents = message) {
  wire.write(`${tag} APPEND ${folder} "01-Jan-2026 00:00:00 +0000" {${Buffer.byteLength(contents)}}\r\n`);
  expect(await wire.next()).toMatch(/^\+/);
  wire.write(`${contents}\r\n`);
  const reply = await wire.reply(new RegExp(`^${tag} `));
  expect(reply).toMatch(new RegExp(`^${tag} OK`, "m"));
  const appendUid = /\[APPENDUID (\d+) (\d+)\]/.exec(reply);
  expect(appendUid).not.toBeNull();
  return Number(appendUid?.[2]);
}

test("D1c uses the reviewed image", () => {
  assertIsolated();
  for (const path of ["/etc/dovecot/private", "/etc/ssl/private/dovecot.pem", "/etc/postfix/main.cf"]) {
    expect(existsSync(path), path).toBe(false);
  }
  const review = JSON.parse(readFileSync("tools/mailtest/DEPS-REVIEW.json", "utf8"));
  expect(process.env.MURAGE_MAILTEST_IMAGE).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(process.env.MURAGE_MAILTEST_IMAGE).toBe(review.image.digest);
  expect(execFileSync("dpkg-query", ["-W", "-f=${Package}=${Version}\n", ...Object.keys(review.packages)], { encoding: "utf8" })
    .trim().split("\n").sort()).toEqual(Object.entries(review.packages).map(([name, version]) => `${name}=${version}`).sort());
});

test("M0 the launcher starts its base servers before the command", async () => {
  const path = process.env.MURAGE_MAILTEST_FIXTURE;
  expect(path).toBeTruthy();
  expect(statSync(path!).mode & 0o777).toBe(0o600);
  const { host, name, caPath, imaps, smtp } = JSON.parse(readFileSync(path!, "utf8"));
  expect(host).toBe("127.0.0.1");
  const endpoint = { host, name, ca: readFileSync(caPath) };
  const imap = openWire(endpoint, imaps, true);
  const submission = openWire(endpoint, smtp);
  try {
    expect(await imap.next()).toMatch(/^\* OK .*Dovecot/i);
    expect(await submission.next()).toMatch(/^220 .*ESMTP Postfix/i);
  } finally {
    imap.close();
    submission.close();
  }
});

test("M0 the base test server speaks real IMAP and SMTP over TLS", async () => {
  const mail = await startMailServer();
  const plain = openWire(mail, mail.imap);
  let imap: Wire | undefined;
  try {
    expect(await plain.next()).toMatch(/^\* OK .*Dovecot/i);
    expect(await plain.imap("C", "CAPABILITY")).toMatch(/STARTTLS/);
    expect(await plain.imap("T", "STARTTLS")).toMatch(/^T OK/m);
    imap = plain.startTls(mail);
    expect(await imap.imap("L", `LOGIN "${mail.account}" "${mail.password}"`)).toMatch(/^L OK/m);
    expect(await imap.imap("S", "SELECT INBOX")).toMatch(/^S OK/m);
    const uid = await append(imap, "A", "INBOX");
    const bySequence = await imap.imap("F", "FETCH 1 (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])");
    expect(bySequence).toContain(messageId);
    expect(bySequence).toMatch(/INTERNALDATE "[ 0]1-Jan-2026 00:00:00 \+0000"/);
    expect(await imap.imap("G", `UID FETCH ${uid} (UID BODY.PEEK[TEXT])`)).toContain("Body");
    expect(await imap.imap("H", `UID SEARCH UID ${uid}:${uid} HEADER Message-ID ${messageId}`)).toMatch(new RegExp(`^\\* SEARCH ${uid}$`, "m"));
    imap.write("I IDLE\r\n");
    expect(await imap.next()).toMatch(/^\+/);
    const arrival = await imapLogin(mail);
    try {
      await append(arrival, "A", "INBOX");
      expect(await imap.reply(/^\* 2 EXISTS$/)).toContain("* 2 EXISTS");
    } finally {
      arrival.close();
    }
    imap.write("DONE\r\n");
    expect(await imap.reply(/^I /)).toMatch(/^I OK/m);
    await submit(mail);
    for (let attempt = 0; attempt < 40 && mail.delivered() === 0; ++attempt) await delay(50);
    expect(mail.delivered()).toBe(1);
    expect(await imap.imap("Z", "SELECT Sent")).toMatch(/^\* 0 EXISTS$/m);
  } finally {
    (imap ?? plain).close();
    await mail.close();
  }
});

test.each(variants)("M0b real daemon variant %s", async variant => {
  const mail = await startMailServer(variant);
  try {
    if (variant === "untrusted-ca" || variant === "wrong-name") {
      const socket = connect({ host: mail.host, port: mail.imaps, servername: mail.name, ca: mail.ca });
      try {
        await expect(once(socket, "secureConnect")).rejects.toMatchObject({
          code: variant === "wrong-name" ? "ERR_TLS_CERT_ALTNAME_INVALID" : "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        });
      } finally {
        socket.destroy();
      }
    } else if (variant === "imap-closed") {
      const imap = openWire(mail, mail.imap);
      try {
        await expect(imap.next()).rejects.toMatchObject({ code: "ECONNREFUSED" });
      } finally {
        imap.close();
      }
      await submit(mail);
    } else if (variant === "no-starttls") {
      const imap = openWire(mail, mail.imap);
      const smtp = openWire(mail, mail.smtp);
      try {
        expect(await imap.next()).toMatch(/^\* OK .*Dovecot/i);
        expect(await imap.imap("C", "CAPABILITY")).not.toMatch(/STARTTLS/);
        expect(await smtp.next()).toMatch(/^220 .*Postfix/i);
        expect(await smtp.smtp("EHLO fixture.example.test")).not.toMatch(/STARTTLS/);
      } finally {
        imap.close();
        smtp.close();
      }
    } else if (variant === "mech-cram") {
      const imap = openWire(mail, mail.imaps, true);
      try {
        expect(await imap.next()).toMatch(/^\* OK .*Dovecot/i);
        expect(await imap.imap("C", "CAPABILITY")).toMatch(/AUTH=PLAIN .*AUTH=LOGIN .*AUTH=CRAM-MD5/);
      } finally {
        imap.close();
      }
    } else {
      await submit(mail, variant === "rcpt-refuse" ? refused : recipient);
      const imap = await imapLogin(mail);
      try {
        const expected = variant === "autosave" ? 1 : 0;
        let selected = "";
        for (let attempt = 0; attempt < 40; ++attempt) {
          selected = await imap.imap("S", "SELECT Sent");
          if (selected.includes(`* ${expected} EXISTS`)) break;
          await delay(50);
        }
        expect(selected).toMatch(new RegExp(`^\\* ${expected} EXISTS$`, "m"));
        if (expected) expect(await imap.imap("F", "FETCH 1 BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]")).toContain(messageId);
      } finally {
        imap.close();
      }
    }
  } finally {
    await mail.close();
  }
});

const mechanisms: Record<string, string> = {
  "ntlm-only": "NTLM", "gssapi-only": "GSSAPI", "cram-only": "CRAM-MD5", "digest-only": "DIGEST-MD5",
};

test.each(greeterVariants.flatMap(variant => (["imap", "smtp"] as const).map(protocol => [variant, protocol] as const)))(
  "M0b scripted greeter %s on %s", async (variant, protocol) => {
    const greeter = await startGreeter(variant, protocol);
    try {
      if (variant === "tls10-only" || variant === "tls11-only" || variant === "plaintext-on-tls-port") {
        const options = { host: greeter.host, port: greeter.port, servername: greeter.name, ca: greeter.ca };
        const rejected = connect({ ...options, minVersion: "TLSv1.2" });
        try {
          await expect(once(rejected, "secureConnect")).rejects.toMatchObject({
            code: variant === "plaintext-on-tls-port" ? "ERR_SSL_WRONG_VERSION_NUMBER" : "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
          });
        } finally {
          rejected.destroy();
        }
        if (variant !== "plaintext-on-tls-port") {
          const version = variant === "tls10-only" ? "TLSv1" : "TLSv1.1";
          const accepted = connect({ ...options, minVersion: version, maxVersion: version, ciphers: "DEFAULT:@SECLEVEL=0" });
          try {
            await once(accepted, "secureConnect");
            expect(accepted.getProtocol()).toBe(version);
          } finally {
            accepted.destroy();
          }
        }
        return;
      }
      const starttls = variant === "starttls-fails";
      const wire = openWire(greeter, greeter.port, !starttls);
      try {
        expect(await wire.next()).toMatch(protocol === "imap" ? /^\* OK / : /^220 /);
        if (protocol === "imap") {
          const capability = await wire.imap("C", "CAPABILITY");
          expect(capability).toContain(starttls ? "STARTTLS LOGINDISABLED" : `AUTH=${mechanisms[variant]}`);
          expect(greeter.received().toString()).toBe("C CAPABILITY\r\n");
          if (starttls) expect(await wire.imap("S", "STARTTLS")).toMatch(/^S NO/);
        } else {
          const capability = await wire.smtp("EHLO fixture.example.test");
          expect(capability).toContain(starttls ? "STARTTLS" : `AUTH ${mechanisms[variant]}`);
          expect(greeter.received().toString()).toBe("EHLO fixture.example.test\r\n");
          if (starttls) expect(await wire.smtp("STARTTLS")).toMatch(/^454 /);
        }
      } finally {
        wire.close();
      }
    } finally {
      await greeter.close();
    }
  },
);

test.each(["drop-after-dot", "hold-dot-reply", "hold-connect"] as const)("recorder SMTP %s", async fault => {
  const mail = await startMailServer();
  try {
    const proxy = await startRecorder("smtp", { port: mail.smtps, name: mail.name, ca: mail.ca }, fault);
    const wire = openWire(proxy, proxy.port, true);
    try {
      if (fault === "hold-connect") {
        await proxy.reached;
        expect(proxy.connections).toEqual([]);
        proxy.release();
        expect(await wire.next()).toMatch(/^220 .*Postfix/i);
        await proxy.settled;
      } else {
        expect(await wire.next()).toMatch(/^220 .*Postfix/i);
        await authenticate(wire, mail);
        await sendData(wire, mail);
        await proxy.reached;
        if (fault === "hold-dot-reply") {
          const capture = proxy.connections[0];
          expect(capture.serverBytes).toBeGreaterThan(capture.forwardedServerBytes);
          proxy.release();
          expect(await wire.reply(/^\d{3} /)).toMatch(/^250 /);
          expect(capture.serverBytes).toBe(capture.forwardedServerBytes);
        } else {
          await expect(wire.next()).rejects.toThrow();
        }
        await proxy.settled;
        for (let attempt = 0; attempt < 40 && mail.delivered() === 0; ++attempt) await delay(50);
        expect(mail.delivered()).toBe(1);
        expect(proxy.connections[0]?.commands.map(command => command.verb)).toEqual(["EHLO", "AUTH", "MAIL", "RCPT", "DATA"]);
      }
      expect(proxy.connections[0]?.serverBytes).toBeGreaterThan(0);
    } finally {
      wire.close();
      await proxy.close();
    }
  } finally {
    await mail.close();
  }
});

test.each(["drop-after-append", "hold-append-tail"] as const)("recorder IMAP %s", async fault => {
  const mail = await startMailServer();
  try {
    const proxy = await startRecorder("imap", { port: mail.imaps, name: mail.name, ca: mail.ca }, fault);
    const wire = await imapLogin(mail, openWire(proxy, proxy.port, true));
    const direct = await imapLogin(mail);
    try {
      expect(await direct.imap("S", "SELECT INBOX")).toMatch(/^\* 0 EXISTS$/m);
      expect(await wire.imap("S", "SELECT INBOX")).toMatch(/^S OK/m);
      const search = `UID 1:100 HEADER Message-ID ${messageId}`;
      expect(await wire.imap("U", `UID SEARCH ${search}`)).toMatch(/^\* SEARCH$/m);
      wire.write(`A APPEND INBOX {${Buffer.byteLength(message)}}\r\n`);
      expect(await wire.next()).toMatch(/^\+/);
      wire.write(`${message}\r\n`);
      await proxy.reached;
      await expect(wire.next()).rejects.toThrow();
      if (fault === "hold-append-tail") {
        expect(await direct.imap("F", `UID SEARCH HEADER Message-ID ${messageId}`)).toMatch(/^\* SEARCH$/m);
        proxy.release();
      }
      await proxy.settled;
      expect(await direct.imap("N", "SELECT INBOX")).toMatch(/^\* 1 EXISTS$/m);
      expect(await direct.imap("G", `UID SEARCH HEADER Message-ID ${messageId}`)).toMatch(/^\* SEARCH \d+$/m);
      expect(proxy.connections[0]?.commands).toMatchObject([
        { verb: "LOGIN" }, { verb: "SELECT", arguments: "INBOX" },
        { verb: "UID SEARCH", arguments: search }, { verb: "APPEND" },
      ]);
      expect(proxy.connections[0]?.commands[0].arguments).toBeUndefined();
      expect(proxy.connections[0]?.clientBytes).toBeGreaterThan(Buffer.byteLength(message));
    } finally {
      direct.close();
      wire.close();
      await proxy.close();
    }
  } finally {
    await mail.close();
  }
});

test("M0b doveadm advances UIDNEXT and recreates INBOX", async () => {
  const mail = await startMailServer();
  const select = async () => {
    const connection = await imapLogin(mail);
    try {
      const reply = await connection.imap("S", "SELECT INBOX");
      return {
        uidnext: Number(/UIDNEXT (\d+)/.exec(reply)?.[1]),
        uidvalidity: Number(/UIDVALIDITY (\d+)/.exec(reply)?.[1]),
      };
    } finally {
      connection.close();
    }
  };
  try {
    const before = await select();
    mail.doveadm("mailbox", "update", "-u", account, "--min-next-uid", String(before.uidnext + 100), "INBOX");
    const advanced = await select();
    expect(advanced.uidnext).toBe(before.uidnext + 100);
    expect(advanced.uidvalidity).toBe(before.uidvalidity);
    mail.recreateInbox();
    const recreated = await select();
    expect(recreated.uidnext).toBe(1);
    expect(recreated.uidvalidity).not.toBe(before.uidvalidity);
    expect(recreated.uidvalidity).toBeGreaterThan(0);
  } finally {
    await mail.close();
  }
});
