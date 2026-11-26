import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, chownSync, closeSync, mkdirSync, mkdtempSync, openSync,
  readdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { safeWipeSync } from "../../testing/safe-wipe.mjs";
import { connect, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const host = "127.0.0.1";
export const name = "mail.example.test";
export const account = "owner@mail.example.test";
export const refused = "refused@vendor.example.test";
export const variants = ["base", "autosave", "mech-cram", "imap-closed", "no-starttls",
  "untrusted-ca", "wrong-name", "rcpt-refuse"] as const;
type Variant = typeof variants[number];

export function assertIsolated() {
  if (process.platform !== "linux" || Object.values(networkInterfaces()).flat().some(address => !address?.internal)) {
    throw new Error("Mail fixtures require the offline Linux container");
  }
}

export function certificates(directory: string, hostname = name) {
  const issue = (args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  issue(["req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=Fixture CA", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", "ca.key", "-out", "ca.pem"]);
  issue(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${hostname}`, "-keyout", "leaf.key", "-out", "leaf.csr"]);
  writeFileSync(join(directory, "extensions"), `subjectAltName=DNS:${hostname}\nextendedKeyUsage=serverAuth\n`);
  issue(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
    "-days", "1", "-extfile", "extensions", "-out", "leaf.pem"]);
  return {
    key: readFileSync(join(directory, "leaf.key")),
    cert: readFileSync(join(directory, "leaf.pem")),
    ca: readFileSync(join(directory, "ca.pem")),
  };
}

async function reservePorts(count: number) {
  const servers = Array.from({ length: count }, () => createServer());
  try {
    return await Promise.all(servers.map(server => new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("Fixture port unavailable"));
        resolve(address.port);
      });
    })));
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}

async function waitForListener(port: number, child: ChildProcess, label: string) {
  for (let attempt = 0; attempt < 100; ++attempt) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (await new Promise<boolean>(resolve => {
      const socket = connect(port, host);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    })) return;
    await delay(25);
  }
  throw new Error(`Fixture ${label} did not open its loopback listener`);
}

async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

export async function startMailServer(variant: Variant = "base") {
  assertIsolated();
  if (!variants.includes(variant)) throw new Error("Unknown mail fixture variant");
  const directory = mkdtempSync(join(tmpdir(), "mail-fixture-"));
  const children: ChildProcess[] = [];
  const close = async () => {
    for (const child of children.reverse()) await stop(child);
    safeWipeSync(directory);
  };
  try {
    chmodSync(directory, 0o755);
    const password = randomBytes(24).toString("hex");
    const ports = await reservePorts(4);
    const [imap, imaps, smtp, smtps] = ports;
    const identity = certificates(directory, variant === "wrong-name" ? "other.example.test" : name);
    let ca = identity.ca;
    if (variant === "untrusted-ca") {
      const trust = join(directory, "trust");
      mkdirSync(trust, { mode: 0o700 });
      ca = certificates(trust).ca;
    }

    const config = join(directory, "dovecot.conf");
    const spool = join(directory, "postfix-spool");
    const postfix = join(directory, "postfix");
    const mail = join(directory, "mail");
    const file = (path: string, data: string) => writeFileSync(join(directory, path), data, { mode: 0o600 });
    const launch = (command: string, args: string[], label: string) => {
      const log = openSync(join(directory, `${label}.log`), "a", 0o600);
      try {
        const child = spawn(command, args, { stdio: ["ignore", log, log] });
        child.on("error", () => {});
        children.push(child);
        return child;
      } finally {
        closeSync(log);
      }
    };
    const id = (flag: "-u" | "-g", user: string) => Number(execFileSync("id", [flag, user], { encoding: "utf8" }));
    const uid = id("-u", "mailfixture");
    const gid = id("-g", "mailfixture");
    const postfixUid = id("-u", "postfix");
    const postfixGid = id("-g", "postfix");
    mkdirSync(mail, { mode: 0o700 });
    chownSync(mail, uid, gid);
    for (const folder of ["inbox", "sink", "folders"]) {
      for (const sub of ["", "cur", "new", "tmp"]) {
        const path = join(mail, folder, sub);
        mkdirSync(path, { mode: 0o700 });
        chownSync(path, uid, gid);
      }
    }
    file("passwd", `${account}:{PLAIN}${password}\n`);
    chownSync(join(directory, "passwd"), 0, id("-g", "dovecot"));
    chmodSync(join(directory, "passwd"), 0o640);
    chownSync(join(directory, "leaf.key"), 0, postfixGid);
    chmodSync(join(directory, "leaf.key"), 0o640);
    file("dovecot.conf", `
base_dir = ${directory}/dovecot
state_dir = ${directory}/dovecot
listen = ${host}
protocols = imap
log_path = ${directory}/dovecot.log
ssl = ${variant === "no-starttls" ? "no" : "required"}
ssl_min_protocol = TLSv1.2
ssl_cert = <${directory}/leaf.pem
ssl_key = <${directory}/leaf.key
disable_plaintext_auth = yes
auth_mechanisms = plain login ${variant === "mech-cram" ? "cram-md5" : ""}
mail_location = maildir:${mail}/folders:INBOX=${mail}/inbox
mailbox_idle_check_interval = 1s
mail_home = ${mail}
mail_uid = ${uid}
mail_gid = ${gid}
first_valid_uid = ${uid}
passdb {
  driver = passwd-file
  args = ${directory}/passwd
}
userdb {
  driver = static
  args = uid=${uid} gid=${gid} home=${mail}
}
namespace inbox {
  inbox = yes
  mailbox Sent {
    auto = create
    special_use = \\Sent
  }
}
service imap-login {
  inet_listener imap {
    port = ${variant === "imap-closed" ? 0 : imap}
  }
  inet_listener imaps {
    port = ${variant === "imap-closed" || variant === "no-starttls" ? 0 : imaps}
    ssl = yes
  }
}
service auth {
  unix_listener smtp-auth {
    mode = 0660
    user = postfix
    group = postfix
  }
}
`);
    const dovecot = launch("dovecot", ["-F", "-c", config], "imap-daemon");
    if (variant !== "imap-closed") await waitForListener(imap, dovecot, "IMAP");

    mkdirSync(postfix);
    mkdirSync(spool);
    const master = readFileSync("/etc/postfix/master.cf", "utf8").replace(/^smtp\s+inet\s+.*$/m, "");
    file("postfix/master.cf", `${master}
${host}:${smtp} inet n - n - - smtpd
${host}:${smtps} inet n - n - - smtpd
  -o smtpd_tls_wrappermode=yes
`);
    file("postfix/delivery", `/^${account.replaceAll(".", "\\.")}$/ inbox/
/^sent@mail\\.example\\.test$/ folders/.Sent/
/./ sink/
`);
    file("postfix/refused", `${refused} 550 fixture recipient refused\n`);
    file("postfix/bcc", `${account} sent@mail.example.test\n`);
    file("postfix/main.cf", `
compatibility_level = 3.6
myhostname = ${name}
myorigin = $myhostname
inet_interfaces = ${host}
inet_protocols = ipv4
mydestination =
mynetworks = 127.0.0.0/8
queue_directory = ${spool}
data_directory = ${directory}/postfix-data
maillog_file_prefixes = ${directory}/
maillog_file = ${directory}/postfix.log
smtpd_tls_cert_file = ${directory}/leaf.pem
smtpd_tls_key_file = ${directory}/leaf.key
smtpd_tls_security_level = ${variant === "no-starttls" ? "none" : "may"}
smtpd_tls_auth_only = yes
smtpd_sasl_type = dovecot
smtpd_sasl_path = ${directory}/dovecot/smtp-auth
smtpd_sasl_auth_enable = yes
smtpd_sasl_security_options = noanonymous
smtpd_relay_restrictions = permit_sasl_authenticated, reject
smtpd_recipient_restrictions = ${variant === "rcpt-refuse" ? `check_recipient_access hash:${postfix}/refused` : ""}
${variant === "autosave" ? `sender_bcc_maps = hash:${postfix}/bcc` : ""}
smtpd_tls_loglevel = 0
smtpd_tls_received_header = no
always_add_missing_headers = no
default_transport = virtual
relay_transport = virtual
virtual_transport = virtual
virtual_mailbox_domains = mail.example.test, vendor.example.test
virtual_mailbox_base = ${mail}
virtual_mailbox_maps = regexp:${postfix}/delivery
virtual_uid_maps = static:${uid}
virtual_gid_maps = static:${gid}
virtual_minimum_uid = ${uid}
`);
    const data = join(directory, "postfix-data");
    mkdirSync(data);
    chownSync(data, postfixUid, postfixGid);
    for (const map of ["delivery", "bcc", "refused"]) chmodSync(join(postfix, map), 0o644);
    for (const map of ["bcc", "refused"]) execFileSync("postmap", ["-c", postfix, join(postfix, map)], { stdio: "pipe" });
    execFileSync("postfix", ["-c", postfix, "check"], { stdio: "pipe" });
    const daemon = launch("postfix", ["-c", postfix, "start-fg"], "smtp-daemon");
    await waitForListener(smtp, daemon, "SMTP");
    const doveadm = (...args: string[]) => execFileSync("doveadm", ["-c", config, ...args], { encoding: "utf8" });
    const delivered = () => readdirSync(join(mail, "sink", "new")).length;
    const recreateInbox = () => {
      const uidValidity = () => Number(/uidvalidity=(\d+)/.exec(doveadm("mailbox", "status", "-u", account, "uidvalidity", "INBOX"))?.[1]);
      const previous = uidValidity();
      if (!Number.isSafeInteger(previous)) throw new Error("Fixture UIDVALIDITY missing");
      // Dovecot forbids deleting INBOX. Retire its Maildir with clients disconnected and let doveadm create the new one.
      const retired = mkdtempSync(join(directory, "retired-inbox-"));
      renameSync(join(mail, "inbox"), join(retired, "mail"));
      doveadm("mailbox", "create", "-u", account, "INBOX");
      if (uidValidity() === previous) {
        doveadm("mailbox", "update", "-u", account, "--uid-validity", String(previous + 1), "INBOX");
      }
    };
    return { directory, host, name, account, password, ca, imap, imaps, smtp, smtps, doveadm, delivered, recreateInbox, close };
  } catch (error) {
    const details = ["imap-daemon.log", "dovecot.log", "smtp-daemon.log", "postfix.log"].flatMap(name => {
      try { return [readFileSync(join(directory, name), "utf8")]; }
      catch { return []; }
    });
    await close();
    throw new Error([String(error), ...details].filter(Boolean).join("\n"), { cause: error });
  }
}
