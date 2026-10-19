// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

import { HANDOFF_FILE, HANDOFF_MAX_AGE_MS, argvWithoutLink, handOffDoorLink, needsDoorHandoff, stashDoorLink, takeStashedDoorLink } from "./cloud-link-handoff.mjs";
import { doorLinkFromCommandLine, parseDoorLink } from "./cloud-door-link.mjs";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://h-0123456789abcdef0123456789abcdef.murage.ai";
const TICKET = `${Buffer.from(JSON.stringify({ type: "murage-door-v2", account: "owner-1", bind: "a".repeat(64) })).toString("base64url")}.${"S".repeat(86)}`;
const DOOR = `murage://door?h=home-0123456789abcdef01234567&o=${encodeURIComponent(ORIGIN)}#t=${TICKET}`;
const sealing = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from("SEALED:" + Buffer.from(text).toString("base64")),
  decryptString: (buffer) => { const text = buffer.toString(); if (!text.startsWith("SEALED:")) throw new Error("not sealed"); return Buffer.from(text.slice(7), "base64").toString(); },
});
let dir;
test.beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "door-handoff-")); });
test.afterEach(() => { safeWipeSync(dir); });

test("handoff: seals and removes the stash", async () => {
  await stashDoorLink({ safeStorage: sealing(), directory: dir, url: DOOR });
  const file = path.join(dir, HANDOFF_FILE);
  assert.ok(existsSync(file));
  const onDisk = readFileSync(file).toString();
  assert.ok(!onDisk.includes(TICKET) && !onDisk.includes("murage://"), "sealed, never plain");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const taken = await takeStashedDoorLink({ safeStorage: sealing(), directory: dir });
  assert.deepEqual(taken, { kind: "door", url: DOOR });
  assert.equal(existsSync(file), false, "read once, then deleted");
  assert.equal(await takeStashedDoorLink({ safeStorage: sealing(), directory: dir }), null);
});

test("handoff: a stale, unsealed or foreign stash is deleted unread", async () => {
  const file = path.join(dir, HANDOFF_FILE);
  let clock = 1_000_000;
  await stashDoorLink({ safeStorage: sealing(), directory: dir, url: DOOR, now: () => clock });
  clock += HANDOFF_MAX_AGE_MS + 1;
  assert.equal(await takeStashedDoorLink({ safeStorage: sealing(), directory: dir, now: () => clock }), null);
  assert.equal(existsSync(file), false);
  writeFileSync(file, `{"url":"${DOOR}","at":${Date.now()}}`); // written by something else, not sealed
  assert.equal(await takeStashedDoorLink({ safeStorage: sealing(), directory: dir }), null);
  assert.equal(existsSync(file), false);
  writeFileSync(file, sealing().encryptString(JSON.stringify({ url: "murage://package?url=x", at: Date.now() })));
  assert.equal(await takeStashedDoorLink({ safeStorage: sealing(), directory: dir }), null, "only a door link comes out");
  await assert.rejects(stashDoorLink({ safeStorage: sealing(), directory: dir, url: "murage://connect-cloud" }), /not a door link/);
  await assert.rejects(stashDoorLink({ safeStorage: { ...sealing(), isEncryptionAvailable: () => false }, directory: dir, url: DOOR }), /no sealed storage/);
});

test("handoff: argv filtered", () => {
  assert.deepEqual(argvWithoutLink(["--flag", DOOR, "--other=1"]), ["--flag", "--other=1"]);
  assert.deepEqual(argvWithoutLink(["MURAGE://door?x", "murage://connect-cloud", "keep"]), ["keep"]);
  assert.deepEqual(argvWithoutLink([]), []);
  assert.deepEqual(argvWithoutLink(undefined), []);
  assert.equal(needsDoorHandoff({ platform: "win32", link: { kind: "door" } }), true);
  assert.equal(needsDoorHandoff({ platform: "linux", link: { kind: "door" } }), true);
  assert.equal(needsDoorHandoff({ platform: "darwin", link: { kind: "door" } }), false, "macOS gets links through open-url");
  assert.equal(needsDoorHandoff({ platform: "win32", link: { kind: "connect-cloud" } }), false, "no secret, no handoff");
  assert.equal(needsDoorHandoff({ platform: "linux", link: { kind: "open-cloud" } }), false);
});

test("handoff: the first process seals, lets go of the lock, relaunches without the link and exits", async () => {
  const calls = [];
  const app = { releaseSingleInstanceLock: () => calls.push("release"), exit: (code) => calls.push(`exit ${code}`) };
  let relaunchedWith;
  const done = await handOffDoorLink({ app, safeStorage: sealing(), directory: dir, url: DOOR, argv: ["C:\\Murage\\Murage.exe", "--x", DOOR],
    relaunch: (args) => { calls.push("relaunch"); relaunchedWith = args; } });
  assert.equal(done, true);
  assert.deepEqual(calls, ["release", "relaunch", "exit 0"]);
  assert.deepEqual(relaunchedWith, ["--x"], "relaunch args: everything but the link");
  assert.ok(!JSON.stringify(relaunchedWith).includes(TICKET));
  assert.deepEqual(await takeStashedDoorLink({ safeStorage: sealing(), directory: dir }), { kind: "door", url: DOOR }, "the relaunched process finds it");
  // A restart that cannot work here (or sealing that fails) keeps the link in this process instead.
  const kept = [];
  assert.equal(await handOffDoorLink({ app: { releaseSingleInstanceLock: () => kept.push("release"), exit: () => kept.push("exit") }, safeStorage: sealing(), directory: dir, url: DOOR, relaunch: () => kept.push("relaunch"), blocked: () => "BACKUP_RELAUNCH_BLOCKED" }), false);
  assert.equal(await handOffDoorLink({ app: { releaseSingleInstanceLock: () => kept.push("release"), exit: () => kept.push("exit") }, safeStorage: { ...sealing(), isEncryptionAvailable: () => false }, directory: dir, url: DOOR, relaunch: () => kept.push("relaunch") }), false);
  assert.deepEqual(kept, []);
});

/**
 * How Windows splits a command line into argv (CommandLineToArgvW and the MSVC runtime): whitespace separates arguments
 * outside quotes; 2n backslashes before a quote are n backslashes and the quote toggles; 2n+1 are n and a literal quote;
 * other backslashes are literal; "" inside quotes is a literal quote.
 */
function windowsArgv(commandLine) {
  const out = [];
  let current = "", inQuotes = false, started = false;
  for (let i = 0; i < commandLine.length; i++) {
    const c = commandLine[i];
    if (c === "\\") {
      let n = 0; while (commandLine[i + n] === "\\") n++;
      if (commandLine[i + n] === "\"") { current += "\\".repeat(Math.floor(n / 2)); if (n % 2) { current += "\""; i += n; } else { i += n - 1; } }
      else { current += "\\".repeat(n); i += n - 1; }
      started = true; continue;
    }
    if (c === "\"") {
      if (inQuotes && commandLine[i + 1] === "\"") { current += "\""; i++; started = true; continue; }
      inQuotes = !inQuotes; started = true; continue;
    }
    if ((c === " " || c === "\t") && !inQuotes) { if (started) { out.push(current); current = ""; started = false; } continue; }
    current += c; started = true;
  }
  if (started) out.push(current);
  return out;
}

test("Windows argv: the #t= fragment survives the registry handler's quoting (simulated)", () => {
  // electron-builder's NSIS installer writes HKCU\Software\Classes\murage\shell\open\command = "<exe>" "%1" for the
  // `protocols` scheme. Windows substitutes the whole URL for %1, inside the quotes, and starts the process with that line.
  const builder = readFileSync(path.join(electronDir, "..", "electron-builder.yml"), "utf8");
  assert.match(builder, /protocols:[\s\S]*?schemes:\s*\[\s*murage\s*\]/, "the murage scheme is registered by the installer");
  const registryCommand = "\"C:\\Users\\Ann Lee\\AppData\\Local\\Programs\\Murage\\Murage.exe\" \"%1\"";
  for (const url of [DOOR, `murage://door?h=home-0123456789abcdef01234567&o=${encodeURIComponent(ORIGIN)}&x=a%20b#t=${"A".repeat(8000)}.B_-`]) {
    const commandLine = registryCommand.replace("%1", url);
    assert.ok(commandLine.length < 32_767, "under the Windows command-line cap");
    const argv = windowsArgv(commandLine);
    assert.equal(argv.length, 2, commandLine.slice(0, 120));
    assert.equal(argv[0], "C:\\Users\\Ann Lee\\AppData\\Local\\Programs\\Murage\\Murage.exe");
    assert.equal(argv[1], url, "the link arrives whole, & and # included");
    const link = doorLinkFromCommandLine(argv);
    assert.equal(link?.kind, "door");
    if (url === DOOR) assert.equal(parseDoorLink(link.url)?.ticket, TICKET, "the ticket after #t= is intact");
    assert.deepEqual(argvWithoutLink(argv.slice(1)), [], "and the relaunch carries none of it");
  }
  // The splitter itself, against the documented examples.
  assert.deepEqual(windowsArgv("\"a b c\" d e"), ["a b c", "d", "e"]);
  assert.deepEqual(windowsArgv("\"ab\\\"c\" \"\\\\\" d"), ["ab\"c", "\\", "d"]);
  assert.deepEqual(windowsArgv("a\\\\\\b d\"e f\"g h"), ["a\\\\\\b", "de fg", "h"]);
  assert.deepEqual(windowsArgv("a\\\\\\\"b c d"), ["a\\\"b", "c", "d"]);
  assert.deepEqual(windowsArgv("a\\\\\\\\\"b c\" d e"), ["a\\\\b c", "d", "e"]);
});
