// Sentinel OS scheduling (1.0.9, GAP-SENTINEL-109 sections 10.1 and 10.2): the exact argv, plist, task XML and unit
// text for all three OSes (asserted on any OS through the injected runner), readback parsing, the registration state
// machine, update and rollback, and removal scope. Needs `pnpm build:server` (the real descriptor writer and guards
// come from dist-server/health/host-boundary.js).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import {
  APPRUN_NO_SANDBOX, PROOF_DEADLINE_MS, SCHED_S_TASK_HAS_NOT_RUN, buildSentinelRegistration, createSentinelScheduleProvider, decodeOutput, entryDigest,
  parseLaunchdPlist, parseSchtasksLastResult, parseSystemdService, parseTaskXml, parseWindowsArguments, proveSentinelRegistration, pruneEntries,
  readRegistrationRecord, reconcileSentinelRegistration, sentinelInvocation, sentinelNames, stageEntry, windowsArgument,
} from "./sentinel-schedule.mjs";
import { SENTINEL_TRAMPOLINE_FLAG } from "./sentinel-trampoline.mjs";

const POSIX_ONLY = process.platform === "win32" && "owner uid and mode checks are POSIX-only";
const boundary = await import(pathToFileURL(path.join(import.meta.dirname, "..", "dist-server", "health", "host-boundary.js")).href);
const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) safeWipeSync(root); });
const temp = prefix => { const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix))); roots.push(dir); chmodSync(dir, 0o700); return dir; };

function descriptorFor({ platform = "linux", exe = "/opt/Murage App/murage", entry = "/home/o/.local/state/MurageSentinel/" + ID + "/runtime/cli-0123456789abcdef.js", revision = 3 } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const root = platform === "win32" ? "C:\\Users\\o\\.murage" : "/home/o/.murage";
  const out = platform === "win32" ? `C:\\Users\\o\\AppData\\Local\\MurageSentinel\\${ID}` : `/home/o/.local/state/MurageSentinel/${ID}`;
  return {
    descriptor: { version: 1, installationId: ID, installationRoot: root, inputRoot: p.join(root, "health"), outputRoot: out, sources: {}, executable: { path: exe, entry, sha256: null }, scheduleRevision: revision },
    descriptorPath: p.join(out, "descriptor.json"),
  };
}

// ---------------------------------------------------------------------------
// Names, invocation and definitions
// ---------------------------------------------------------------------------

test("names are fixed per installation and refuse anything but an opaque id", () => {
  assert.deepEqual({ ...sentinelNames(ID) }, {
    label: `com.ferroxlabs.murage.sentinel.${ID}`, task: `\\FerroxLabs\\Murage\\Sentinel\\${ID}`, unit: `murage-sentinel-${ID}`, autostart: `murage-sentinel-${ID}.desktop`,
  });
  for (const bad of ["", "ABCDEF0123456789", "0123456789abcde", "../x", `${ID}/x`, null]) assert.throws(() => sentinelNames(bad), /refused/);
});

test("invocation: absolute argv, no shell; Linux carries --no-sandbox last, Windows goes through the trampoline", () => {
  const mac = descriptorFor({ platform: "darwin" });
  assert.deepEqual(sentinelInvocation({ platform: "darwin", ...mac }), { executable: mac.descriptor.executable.path, args: [mac.descriptor.executable.entry, mac.descriptorPath, "--once"], env: { ELECTRON_RUN_AS_NODE: "1" } });
  const lin = descriptorFor();
  assert.deepEqual(sentinelInvocation({ platform: "linux", ...lin }).args, [lin.descriptor.executable.entry, lin.descriptorPath, "--once", APPRUN_NO_SANDBOX]);
  assert.deepEqual(sentinelInvocation({ platform: "linux", ...lin, mode: "--watch" }).args, [lin.descriptor.executable.entry, lin.descriptorPath, "--watch", APPRUN_NO_SANDBOX]);
  const win = descriptorFor({ platform: "win32", exe: "C:\\Program Files\\Murage\\Murage.exe", entry: `C:\\Users\\o\\AppData\\Local\\MurageSentinel\\${ID}\\runtime\\cli-0123456789abcdef.js` });
  assert.deepEqual(sentinelInvocation({ platform: "win32", ...win }), { executable: "C:\\Program Files\\Murage\\Murage.exe", args: [SENTINEL_TRAMPOLINE_FLAG, win.descriptor.executable.entry, win.descriptorPath, "--once"], env: {} });
  assert.throws(() => sentinelInvocation({ platform: "linux", ...lin, mode: "--check-install" }), /refused/);
  assert.throws(() => sentinelInvocation({ platform: "linux", descriptor: { ...lin.descriptor, executable: { ...lin.descriptor.executable, path: "murage" } }, descriptorPath: lin.descriptorPath }), /refused/);
  assert.throws(() => sentinelInvocation({ platform: "linux", ...lin, descriptorPath: "/x/descriptor.json\n--watch" }), /refused/);
});

test("macOS LaunchAgent: RunAtLoad, StartInterval 120, Background, LowPriorityIO, no wake, escaped arguments that read back", () => {
  const mac = descriptorFor({ platform: "darwin", exe: "/Applications/Murage & Co.app/Contents/MacOS/Murage", entry: `/Users/o "q"/Library/Application Support/MurageSentinel/${ID}/runtime/cli-0123456789abcdef.js` });
  const reg = buildSentinelRegistration({ platform: "darwin", ...mac, home: "/Users/o" });
  assert.equal(reg.mechanism, "launchd");
  assert.equal(reg.files.length, 1);
  assert.equal(reg.files[0].path, `/Users/o/Library/LaunchAgents/com.ferroxlabs.murage.sentinel.${ID}.plist`);
  const text = reg.files[0].text;
  for (const fragment of [
    `<key>Label</key><string>com.ferroxlabs.murage.sentinel.${ID}</string>`, "<key>RunAtLoad</key><true/>", "<key>StartInterval</key><integer>120</integer>",
    "<key>ProcessType</key><string>Background</string>", "<key>LowPriorityIO</key><true/>", "<key>KeepAlive</key><false/>",
    "<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>", "Murage &amp; Co.app", "&quot;q&quot;", `MurageSentinel ${ID} revision=3`,
  ]) assert.ok(text.includes(fragment), fragment);
  for (const absent of ["WakeSystem", "StartCalendarInterval", "UserName", "sh -c", "/bin/sh"]) assert.ok(!text.includes(absent), absent);
  assert.deepEqual(parseLaunchdPlist(text), { executable: mac.descriptor.executable.path, args: [mac.descriptor.executable.entry, mac.descriptorPath, "--once"], installationId: ID, revision: 3 });
  assert.equal(parseLaunchdPlist("<plist/>"), null);
});

test("Windows arguments quote exactly as CommandLineToArgvW reads them back", () => {
  for (const value of ["plain", "C:\\Program Files\\Murage\\Murage.exe", "with \"quote\"", "trailing\\", "trailing space\\", "a\\\\\"b", "", "tab\there"]) {
    assert.deepEqual(parseWindowsArguments(windowsArgument(value)), [value], JSON.stringify(value));
  }
  const args = [SENTINEL_TRAMPOLINE_FLAG, "C:\\Users\\O Name\\AppData\\Local\\MurageSentinel\\x\\runtime\\cli-0123456789abcdef.js", "C:\\Users\\O Name\\d\\descriptor.json", "--once"];
  assert.deepEqual(parseWindowsArguments(args.map(windowsArgument).join(" ")), args);
  assert.throws(() => windowsArgument("a\nb"), /refused/);
});

test("Windows task XML: logon + PT2M, IgnoreNew, priority 7, no wake, bounded run, least privilege, interactive token, no password", () => {
  const win = descriptorFor({ platform: "win32", exe: "C:\\Program Files\\Murage\\Murage.exe", entry: `C:\\Users\\O & Name\\AppData\\Local\\MurageSentinel\\${ID}\\runtime\\cli-0123456789abcdef.js` });
  const sid = "S-1-5-21-1111111111-2222222222-3333333333-1001";
  const reg = buildSentinelRegistration({ platform: "win32", ...win, userSid: sid, home: "C:\\Users\\o" });
  assert.equal(reg.mechanism, "task-scheduler");
  assert.equal(reg.name, `\\FerroxLabs\\Murage\\Sentinel\\${ID}`);
  const xml = reg.xml;
  for (const fragment of [
    "<LogonTrigger>", "<Interval>PT2M</Interval>", "<StartWhenAvailable>true</StartWhenAvailable>", "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "<Priority>7</Priority>", "<WakeToRun>false</WakeToRun>", "<ExecutionTimeLimit>PT1M</ExecutionTimeLimit>", "<RunLevel>LeastPrivilege</RunLevel>",
    "<LogonType>InteractiveToken</LogonType>", `<UserId>${sid}</UserId>`, "<Command>C:\\Program Files\\Murage\\Murage.exe</Command>", "O &amp; Name",
  ]) assert.ok(xml.includes(fragment), fragment);
  for (const absent of ["<Password>", "HighestAvailable", "S4U", "<WakeToRun>true", "cmd.exe", "powershell"]) assert.ok(!xml.includes(absent), absent);
  const read = parseTaskXml(xml);
  assert.equal(read.executable, "C:\\Program Files\\Murage\\Murage.exe");
  assert.deepEqual(read.args, [SENTINEL_TRAMPOLINE_FLAG, win.descriptor.executable.entry, win.descriptorPath, "--once"]);
  assert.equal(read.owner, sid);
  assert.equal(read.revision, 3);
  assert.equal(read.installationId, ID);
  assert.throws(() => buildSentinelRegistration({ platform: "win32", ...win, userSid: null, home: "C:\\Users\\o" }), /refused/);
  assert.equal(parseTaskXml(xml.replace("</Exec>", "</Exec><Exec><Command>x</Command></Exec>")), null);
});

test("schtasks last result: the Last Result column; never-run is null; anything else unreadable", () => {
  const row = (result) => `"PC","\\FerroxLabs\\Murage\\Sentinel\\${ID}","N/A","Ready","Interactive only","10/27/2026 9:00:00 AM","${result}","Murage","C:\\x.exe"`;
  assert.equal(parseSchtasksLastResult(row("0")), 0);
  assert.equal(parseSchtasksLastResult(row("1")), 1);
  assert.equal(parseSchtasksLastResult(row(String(SCHED_S_TASK_HAS_NOT_RUN))), null);
  assert.equal(parseSchtasksLastResult(row("abc")), undefined);
  assert.equal(parseSchtasksLastResult(""), undefined);
  assert.equal(decodeOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<Task/>", "utf16le")])), "<Task/>");
  assert.equal(decodeOutput(Buffer.from("<Task/>", "utf16le")), "<Task/>");
  assert.equal(decodeOutput(Buffer.from("\uFEFF<Task/>", "utf8")), "<Task/>");
});

test("Linux systemd user units: OnActiveSec 30, OnUnitInactiveSec 120, idle priority, no wake, escaped words that read back", () => {
  const lin = descriptorFor({ exe: "/home/o/Apps/Murage 50%.AppImage", entry: `/home/o/.local/state/MurageSentinel/${ID}/runtime/cli-0123456789abcdef.js` });
  const reg = buildSentinelRegistration({ platform: "linux", ...lin, home: "/home/o" });
  assert.equal(reg.mechanism, "systemd");
  assert.deepEqual(reg.files.map(file => file.path), [`/home/o/.config/systemd/user/murage-sentinel-${ID}.service`, `/home/o/.config/systemd/user/murage-sentinel-${ID}.timer`]);
  const [service, timer] = reg.files.map(file => file.text);
  for (const fragment of ["Type=oneshot", "Environment=ELECTRON_RUN_AS_NODE=1", "Nice=19", "IOSchedulingClass=idle", "UMask=0077", "KillMode=process", "TimeoutStartSec=60", `"/home/o/Apps/Murage 50%%.AppImage"`]) assert.ok(service.includes(fragment), fragment);
  for (const fragment of ["OnActiveSec=30s", "OnUnitInactiveSec=120s", `Unit=murage-sentinel-${ID}.service`, "WantedBy=timers.target"]) assert.ok(timer.includes(fragment), fragment);
  for (const absent of ["WakeSystem", "Persistent=true", "User=", "/bin/sh", "bash -c"]) { assert.ok(!service.includes(absent), absent); assert.ok(!timer.includes(absent), absent); }
  assert.deepEqual(parseSystemdService(service), { executable: lin.descriptor.executable.path, args: [lin.descriptor.executable.entry, lin.descriptorPath, "--once", APPRUN_NO_SANDBOX], installationId: ID, revision: 3 });
  const xdg = buildSentinelRegistration({ platform: "linux", ...lin, home: "/home/o", configHome: "/srv/o-config" });
  assert.equal(xdg.files[0].path, `/srv/o-config/systemd/user/murage-sentinel-${ID}.service`);
  assert.throws(() => buildSentinelRegistration({ platform: "linux", ...descriptorFor({ exe: "/home/o/a\"b" }), home: "/home/o" }), /refusing/);
});

test("Linux fallback: an owning-user autostart entry for the --watch supervisor, through env, never a shell", () => {
  const lin = descriptorFor({ exe: "/home/o/Apps/Murage.AppImage" });
  const reg = buildSentinelRegistration({ platform: "linux", ...lin, home: "/home/o", mechanism: "autostart" });
  assert.equal(reg.files[0].path, `/home/o/.config/autostart/murage-sentinel-${ID}.desktop`);
  assert.ok(reg.files[0].text.includes(`Exec=/usr/bin/env ELECTRON_RUN_AS_NODE=1 /home/o/Apps/Murage.AppImage ${lin.descriptor.executable.entry} ${lin.descriptorPath} --watch --no-sandbox`));
  assert.ok(reg.files[0].text.includes("Terminal=false"));
  assert.throws(() => buildSentinelRegistration({ platform: "linux", ...descriptorFor({ exe: "/home/o/$HOME/murage" }), home: "/home/o", mechanism: "autostart" }), /refused/);
});

// ---------------------------------------------------------------------------
// Providers through a fake runner
// ---------------------------------------------------------------------------

function fakeRunner(answers) {
  const calls = [];
  const run = async ({ executable, args }) => {
    calls.push([executable, ...args]);
    for (const [match, answer] of answers) if (match([executable, ...args])) return typeof answer === "function" ? answer([executable, ...args]) : answer;
    return { code: 0, stdout: "" };
  };
  return { run, calls };
}

test("macOS provider: bootout then bootstrap in gui/<uid>, owner-only plist, readback compares the loaded job", { skip: POSIX_ONLY }, async () => {
  const home = temp("murage-sentinel-mac-");
  const uid = process.getuid();
  const mac = descriptorFor({ platform: "darwin" });
  const label = `com.ferroxlabs.murage.sentinel.${ID}`;
  let loaded = { version: 1, status: "absent" };
  const fake = fakeRunner([[argv => argv[0] === "/usr/bin/osascript", () => ({ code: 0, stdout: JSON.stringify(loaded) })]]);
  const provider = createSentinelScheduleProvider({ platform: "darwin", home, uid, run: fake.run });
  assert.equal(await provider.read(mac.descriptor, mac.descriptorPath), null);
  await provider.install(mac.descriptor, mac.descriptorPath);
  const plist = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  assert.equal(lstatSync(plist).mode & 0o777, 0o600);
  assert.deepEqual(fake.calls.slice(1), [["/bin/launchctl", "bootout", `gui/${uid}/${label}`], ["/bin/launchctl", "bootstrap", `gui/${uid}`, plist]]);
  assert.deepEqual(fake.calls[0].slice(0, 4), ["/usr/bin/osascript", "-l", "JavaScript", "-e"]);
  assert.deepEqual(fake.calls[0].slice(5), ["--", label]);
  const invocation = sentinelInvocation({ platform: "darwin", ...mac });
  loaded = { version: 1, status: "found", program: null, args: [invocation.executable, ...invocation.args], lastExit: 0, pid: null };
  const reg = await provider.read(mac.descriptor, mac.descriptorPath);
  assert.deepEqual(reg, { mechanism: "launchd", registered: true, executable: invocation.executable, args: invocation.args, owner: String(uid), revision: 3, lastResult: 0 });
  assert.equal(boundary.registrationMatches(reg, mac.descriptor, mac.descriptorPath), true);
  loaded = { ...loaded, args: [invocation.executable, "/elsewhere/cli.js", mac.descriptorPath, "--once"] };
  assert.equal((await provider.read(mac.descriptor, mac.descriptorPath)).registered, false);
});

test("Windows provider: schtasks /Create /XML from a private UTF-16 file, /Run once, readback by /Query /XML and the CSV result", async () => {
  const dir = temp("murage-sentinel-win-");
  const sid = "S-1-5-21-1-2-3-1001";
  const win = descriptorFor({ platform: "win32", exe: "C:\\Program Files\\Murage\\Murage.exe", entry: `C:\\Users\\o\\AppData\\Local\\MurageSentinel\\${ID}\\runtime\\cli-0123456789abcdef.js` });
  const name = `\\FerroxLabs\\Murage\\Sentinel\\${ID}`;
  const schtasks = "C:\\Windows\\System32\\schtasks.exe";
  let stored = null;
  let createdFile = null;
  const fake = fakeRunner([
    [argv => argv[1] === "/Create", argv => { createdFile = argv[5]; const bytes = readFileSync(argv[5]); assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]); stored = bytes.subarray(2).toString("utf16le"); return { code: 0, stdout: "SUCCESS" }; }],
    [argv => argv[1] === "/Query" && argv.includes("/XML"), () => stored ? { code: 0, stdout: stored } : { code: 1, stdout: "" }],
    [argv => argv[1] === "/Query" && argv.includes("CSV"), () => ({ code: 0, stdout: `"PC","${name}","N/A","Ready","Interactive only","N/A","${SCHED_S_TASK_HAS_NOT_RUN}","Murage","x"\r\n` })],
  ]);
  const provider = createSentinelScheduleProvider({ platform: "win32", home: "C:\\Users\\o", userSid: sid, run: fake.run, env: { SystemRoot: "C:\\Windows" }, taskFileDir: dir });
  assert.equal(await provider.read(win.descriptor, win.descriptorPath), null);
  await provider.install(win.descriptor, win.descriptorPath);
  assert.deepEqual(fake.calls[1], [schtasks, "/Create", "/TN", name, "/XML", createdFile, "/F"]);
  assert.deepEqual(fake.calls[2], [schtasks, "/Run", "/TN", name]);
  assert.equal(existsSync(createdFile), false, "the definition file is removed after /Create");
  const reg = await provider.read(win.descriptor, win.descriptorPath);
  assert.deepEqual(reg, { mechanism: "task-scheduler", registered: true, executable: win.descriptor.executable.path, args: [SENTINEL_TRAMPOLINE_FLAG, win.descriptor.executable.entry, win.descriptorPath, "--once"], owner: sid, revision: 3, lastResult: null });
  assert.equal(boundary.registrationMatches(reg, win.descriptor, win.descriptorPath), true);
  // Another account's task under our name is not our registration.
  stored = stored.replaceAll(sid, "S-1-5-21-1-2-3-500");
  assert.equal((await provider.read(win.descriptor, win.descriptorPath)).registered, false);
  await provider.remove(ID);
  assert.deepEqual(fake.calls.at(-1), [schtasks, "/Delete", "/TN", name, "/F"]);
});

function systemdShow(stateFor) {
  return argv => {
    const unit = argv.at(-1);
    const kind = unit.endsWith(".timer") ? "timer" : "service";
    const requested = argv.find(arg => arg.startsWith("--property=")).slice("--property=".length).split(",");
    const values = { Id: unit, ...stateFor(kind, unit) };
    return { code: 0, stdout: requested.map(key => `${key}=${values[key] ?? ""}`).join("\n") + "\n" };
  };
}

test("Linux provider: daemon-reload and enable --now the timer; readback demands the exact loaded fragment", { skip: POSIX_ONLY }, async () => {
  const home = temp("murage-sentinel-linux-");
  const uid = process.getuid();
  const lin = descriptorFor();
  const unit = `murage-sentinel-${ID}`;
  const dir = path.join(home, ".config", "systemd", "user");
  let loaded = false;
  let lastRun = "0";
  const state = (kind) => loaded
    ? { LoadState: "loaded", FragmentPath: path.join(dir, `${unit}.${kind}`), DropInPaths: "", NeedDaemonReload: "no", ActiveState: "active", UnitFileState: "enabled", Result: "success", ExecMainStatus: "0", ExecMainExitTimestampMonotonic: lastRun }
    : { LoadState: "not-found", FragmentPath: "", DropInPaths: "", NeedDaemonReload: "no", ActiveState: "inactive", UnitFileState: "", Result: "success", ExecMainStatus: "0", ExecMainExitTimestampMonotonic: "0" };
  const fake = fakeRunner([[argv => argv[1] === "--user" && argv[2] === "show", systemdShow(state)]]);
  const provider = createSentinelScheduleProvider({ platform: "linux", home, uid, run: fake.run });
  assert.equal(await provider.read(lin.descriptor, lin.descriptorPath), null);
  await provider.install(lin.descriptor, lin.descriptorPath);
  assert.deepEqual(fake.calls.slice(-2), [["/usr/bin/systemctl", "--user", "daemon-reload"], ["/usr/bin/systemctl", "--user", "enable", "--now", `${unit}.timer`]]);
  for (const kind of ["service", "timer"]) assert.equal(lstatSync(path.join(dir, `${unit}.${kind}`)).mode & 0o777, 0o600);
  loaded = true;
  let reg = await provider.read(lin.descriptor, lin.descriptorPath);
  assert.equal(reg.registered, true);
  assert.equal(reg.lastResult, null, "never ran");
  assert.equal(boundary.registrationMatches(reg, lin.descriptor, lin.descriptorPath), true);
  lastRun = "123456";
  reg = await provider.read(lin.descriptor, lin.descriptorPath);
  assert.equal(reg.lastResult, 0);
  // A drop-in or a pending reload means the loaded unit is not the owned fragment.
  const drift = fakeRunner([[argv => argv[2] === "show", systemdShow(kind => ({ ...state(kind), DropInPaths: kind === "service" ? "/etc/x.conf" : "" }))]]);
  const drifted = createSentinelScheduleProvider({ platform: "linux", home, uid, run: drift.run });
  assert.equal((await drifted.read(lin.descriptor, lin.descriptorPath)).registered, false);
});

test("Linux without a user manager: install fails with no-user-manager; the autostart fallback is written owner-only", { skip: POSIX_ONLY }, async () => {
  const home = temp("murage-sentinel-nouser-");
  const uid = process.getuid();
  const lin = descriptorFor();
  const fake = fakeRunner([[argv => argv[2] === "daemon-reload", { code: 1, stdout: "" }]]);
  const provider = createSentinelScheduleProvider({ platform: "linux", home, uid, run: fake.run });
  await assert.rejects(provider.install(lin.descriptor, lin.descriptorPath), error => error.code === "SENTINEL_NO_USER_MANAGER");
  await provider.installFallback(lin.descriptor, lin.descriptorPath);
  const file = path.join(home, ".config", "autostart", `murage-sentinel-${ID}.desktop`);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  const reg = await provider.readFallback(lin.descriptor, lin.descriptorPath);
  assert.equal(reg.mechanism, "autostart");
  assert.equal(boundary.registrationMatches(reg, lin.descriptor, lin.descriptorPath), true);
});

test("Linux: the autostart fallback of this installation, and only it, is removed once systemd is proven", { skip: POSIX_ONLY }, async () => {
  const home = temp("murage-sentinel-nofallback-");
  const autostart = path.join(home, ".config", "autostart");
  mkdirSync(autostart, { recursive: true, mode: 0o700 });
  for (const id of [ID, OTHER]) writeFileSync(path.join(autostart, `murage-sentinel-${id}.desktop`), "x", { mode: 0o600 });
  const fake = fakeRunner([]);
  const provider = createSentinelScheduleProvider({ platform: "linux", home, uid: process.getuid(), run: fake.run });
  assert.equal((await provider.removeFallback(ID)).removed.length, 1);
  assert.deepEqual(readdirSync(autostart), [`murage-sentinel-${OTHER}.desktop`]);
  assert.deepEqual((await provider.removeFallback(ID)).removed, []);
  assert.deepEqual(fake.calls, [], "no scheduler call: the timer stays");
});

test("removal takes down only this installation's names", { skip: POSIX_ONLY }, async () => {
  const home = temp("murage-sentinel-remove-");
  const uid = process.getuid();
  const agents = path.join(home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  for (const id of [ID, OTHER]) writeFileSync(path.join(agents, `com.ferroxlabs.murage.sentinel.${id}.plist`), "x", { mode: 0o600 });
  const fake = fakeRunner([]);
  await createSentinelScheduleProvider({ platform: "darwin", home, uid, run: fake.run }).remove(ID);
  assert.deepEqual(fake.calls, [["/bin/launchctl", "bootout", `gui/${uid}/com.ferroxlabs.murage.sentinel.${ID}`]]);
  assert.deepEqual(readdirSync(agents), [`com.ferroxlabs.murage.sentinel.${OTHER}.plist`]);
  const config = path.join(home, ".config");
  for (const sub of ["systemd/user", "autostart"]) mkdirSync(path.join(config, sub), { recursive: true, mode: 0o700 });
  for (const id of [ID, OTHER]) {
    for (const kind of ["service", "timer"]) writeFileSync(path.join(config, "systemd", "user", `murage-sentinel-${id}.${kind}`), "x", { mode: 0o600 });
    writeFileSync(path.join(config, "autostart", `murage-sentinel-${id}.desktop`), "x", { mode: 0o600 });
  }
  const linux = fakeRunner([]);
  await createSentinelScheduleProvider({ platform: "linux", home, uid, run: linux.run }).remove(ID);
  assert.deepEqual(linux.calls, [
    ["/usr/bin/systemctl", "--user", "disable", "--now", `murage-sentinel-${ID}.timer`], ["/usr/bin/systemctl", "--user", "stop", `murage-sentinel-${ID}.service`], ["/usr/bin/systemctl", "--user", "daemon-reload"],
  ]);
  assert.deepEqual(readdirSync(path.join(config, "systemd", "user")).sort(), [`murage-sentinel-${OTHER}.service`, `murage-sentinel-${OTHER}.timer`]);
  assert.deepEqual(readdirSync(path.join(config, "autostart")), [`murage-sentinel-${OTHER}.desktop`]);
});

// ---------------------------------------------------------------------------
// The state machine with the real descriptor writer
// ---------------------------------------------------------------------------

function installation() {
  const base = temp("murage-sentinel-sm-");
  const installationRoot = path.join(base, "data");
  mkdirSync(installationRoot, { mode: 0o700 });
  const outputRoot = path.join(base, "state", "MurageSentinel", ID);
  mkdirSync(path.join(base, "state"), { mode: 0o700 });
  const app = path.join(base, "app");
  mkdirSync(app, { mode: 0o700 });
  const executable = path.join(app, "Murage");
  writeFileSync(executable, "synthetic, never executed", { mode: 0o700 });
  const entrySource = path.join(app, "cli.js");
  writeFileSync(entrySource, "// entry v1\n", { mode: 0o600 });
  return { base, installationRoot, outputRoot, executable, entrySource, descriptorPath: path.join(outputRoot, "descriptor.json") };
}

function fakeProvider({ installFails = null, readback = "match" } = {}) {
  const installs = [];
  let registered = null;
  return {
    installs,
    async install(descriptor, descriptorPath) {
      installs.push(descriptor.scheduleRevision);
      if (installFails && installFails(descriptor)) throw Object.assign(new Error("refused"), { code: installFails(descriptor) });
      registered = { descriptor: structuredClone(descriptor), descriptorPath };
    },
    async read() {
      if (!registered) return null;
      const invocation = sentinelInvocation({ platform: "linux", descriptor: registered.descriptor, descriptorPath: registered.descriptorPath });
      return { mechanism: "systemd", registered: true, executable: invocation.executable, args: readback === "match" ? invocation.args : ["/x"], owner: "1", revision: registered.descriptor.scheduleRevision, lastResult: null };
    },
    async remove() {},
  };
}

const reconcile = (fx, provider, extra = {}) => reconcileSentinelRegistration({
  platform: "linux", uid: process.getuid(), installationId: ID, installationRoot: fx.installationRoot, outputRoot: fx.outputRoot, executable: fx.executable,
  entrySource: fx.entrySource, provider, boundary, probe: async () => boundary.EXIT.notProven, now: () => 1_000, ...extra,
});

test("first install: unregistered -> staged -> registered, with a staged owner-only entry and descriptor revision 1", { skip: POSIX_ONLY }, async () => {
  const fx = installation();
  const provider = fakeProvider();
  const result = await reconcile(fx, provider);
  assert.deepEqual(result, { state: "registered", mechanism: "systemd", revision: 1, reason: null });
  const loaded = boundary.loadDescriptor(fx.descriptorPath, { platform: "linux" });
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const sha = entryDigest(readFileSync(fx.entrySource));
  assert.equal(loaded.value.executable.entry, path.join(fx.outputRoot, "runtime", `cli-${sha.slice(0, 16)}.js`));
  assert.equal(loaded.value.executable.sha256, sha);
  assert.equal(lstatSync(loaded.value.executable.entry).mode & 0o777, 0o600);
  const record = readRegistrationRecord(fx.outputRoot, { platform: "linux" });
  assert.equal(record.state, "registered");
  assert.equal(record.registeredAt, 1_000);
  assert.deepEqual(provider.installs, [1]);
  // Nothing changed: no new revision, no reinstall.
  assert.deepEqual(await reconcile(fx, provider), { state: "registered", mechanism: "systemd", revision: 1, reason: null });
  assert.deepEqual(provider.installs, [1]);
});

test("update: a new entry is staged as the next revision, the previous identity is kept, older copies are pruned", { skip: POSIX_ONLY }, async () => {
  const fx = installation();
  const provider = fakeProvider();
  await reconcile(fx, provider);
  const first = boundary.loadDescriptor(fx.descriptorPath, { platform: "linux" }).value.executable.entry;
  writeFileSync(fx.entrySource, "// entry v2\n");
  assert.equal((await reconcile(fx, provider)).revision, 2);
  const second = boundary.loadDescriptor(fx.descriptorPath, { platform: "linux" }).value.executable.entry;
  let record = readRegistrationRecord(fx.outputRoot, { platform: "linux" });
  assert.equal(record.previous.entry, first);
  assert.equal(record.current.entry, second);
  writeFileSync(fx.entrySource, "// entry v3\n");
  assert.equal((await reconcile(fx, provider)).revision, 3);
  record = readRegistrationRecord(fx.outputRoot, { platform: "linux" });
  assert.equal(record.previous.entry, second);
  assert.deepEqual(readdirSync(path.join(fx.outputRoot, "runtime")).sort(), [path.basename(second), path.basename(record.current.entry)].sort());
  assert.deepEqual(provider.installs, [1, 2, 3]);
});

test("a refused replacement keeps the prior valid registration and descriptor (registration-needed)", { skip: POSIX_ONLY }, async () => {
  const fx = installation();
  const provider = fakeProvider({ installFails: d => (d.scheduleRevision === 2 ? "SENTINEL_SCHEDULER_REFUSED" : null) });
  await reconcile(fx, provider);
  writeFileSync(fx.entrySource, "// entry v2\n");
  const result = await reconcile(fx, provider);
  assert.deepEqual(result, { state: "registration-needed", mechanism: "systemd", revision: 1, reason: "scheduler-refused" });
  assert.equal(boundary.loadDescriptor(fx.descriptorPath, { platform: "linux" }).value.scheduleRevision, 1, "descriptor restored");
  assert.deepEqual(provider.installs, [1, 2, 1], "the prior registration is put back");
});

test("no user manager is reported as such (the host then uses the supervisor fallback)", { skip: POSIX_ONLY }, async () => {
  const fx = installation();
  const result = await reconcile(fx, fakeProvider({ installFails: () => "SENTINEL_NO_USER_MANAGER" }));
  assert.equal(result.state, "registration-needed");
  assert.equal(result.reason, "no-user-manager");
  assert.equal(boundary.loadDescriptor(fx.descriptorPath, { platform: "linux" }).ok, true, "the descriptor stays for the fallback supervisor");
});

test("an entry that does not load under this executable is never registered", { skip: POSIX_ONLY }, async () => {
  const fx = installation();
  const provider = fakeProvider();
  await reconcile(fx, provider);
  writeFileSync(fx.entrySource, "// entry v2 broken\n");
  const result = await reconcile(fx, provider, { probe: async () => boundary.EXIT.usage });
  assert.equal(result.state, "registration-needed");
  assert.equal(result.reason, "entry-probe");
  assert.deepEqual(provider.installs, [1]);
  assert.equal(boundary.loadDescriptor(fx.descriptorPath, { platform: "linux" }).value.scheduleRevision, 1);
});

test("a registration that does not read back as this entry+descriptor+revision is not registered", { skip: POSIX_ONLY }, async () => {
  const fx = installation();
  const result = await reconcile(fx, fakeProvider({ readback: "other" }));
  assert.equal(result.state, "registration-needed");
  assert.equal(result.reason, "readback");
});

test("staging refuses nothing it did not write and prunes only cli-<16 hex>.js names", { skip: POSIX_ONLY }, () => {
  const fx = installation();
  assert.equal(boundary.ensureOutputRoot(fx.outputRoot, { platform: "linux" }).ok, true);
  const staged = stageEntry({ outputRoot: fx.outputRoot, source: fx.entrySource, platform: "linux" });
  writeFileSync(staged.entry, "tampered");
  const again = stageEntry({ outputRoot: fx.outputRoot, source: fx.entrySource, platform: "linux" });
  assert.equal(entryDigest(readFileSync(again.entry)), again.sha256, "a damaged copy is replaced");
  const runtime = path.join(fx.outputRoot, "runtime");
  writeFileSync(path.join(runtime, "cli-aaaaaaaaaaaaaaaa.js"), "old");
  writeFileSync(path.join(runtime, "notes.txt"), "keep");
  assert.deepEqual(pruneEntries({ outputRoot: fx.outputRoot, keep: [again.entry], platform: "linux" }), ["cli-aaaaaaaaaaaaaaaa.js"]);
  assert.deepEqual(readdirSync(runtime).sort(), [path.basename(again.entry), "notes.txt"].sort());
});

// ---------------------------------------------------------------------------
// Proof and rollback
// ---------------------------------------------------------------------------

function proofBoundary(report) {
  return { ...boundary, checkInstall: async () => ({ descriptor: "ok", installationId: ID, registrations: [{ matches: report.state !== "registration-needed" }], heartbeatAgeMs: null, heartbeatFresh: report.state === "proven", scanner: null, ...report }) };
}

test("proven only by a heartbeat written after this registration; an older heartbeat keeps it registered", { skip: POSIX_ONLY }, async () => {
  const fx = installation();
  await reconcile(fx, fakeProvider(), { now: () => 10_000 });
  const prove = (report, now) => proveSentinelRegistration({ platform: "linux", outputRoot: fx.outputRoot, provider: fakeProvider(), boundary: proofBoundary(report), now: () => now });
  assert.equal((await prove({ state: "proven", heartbeatAt: 9_999 }, 20_000)).state, "registered");
  assert.equal((await prove({ state: "proven", heartbeatAt: 10_000 }, 20_000)).state, "proven");
  assert.equal(readRegistrationRecord(fx.outputRoot, { platform: "linux" }).state, "proven");
  // A proven registration whose job no longer matches needs registration again.
  assert.equal((await prove({ state: "registration-needed", heartbeatAt: 10_000 }, 30_000)).state, "registration-needed");
});

test("no heartbeat from the new revision past the proof deadline rolls back to the previous identity", { skip: POSIX_ONLY }, async () => {
  const fx = installation();
  const provider = fakeProvider();
  await reconcile(fx, provider, { now: () => 1_000 });
  writeFileSync(fx.entrySource, "// entry v2\n");
  await reconcile(fx, provider, { now: () => 2_000 });
  const rolled = [];
  const prove = now => proveSentinelRegistration({
    platform: "linux", outputRoot: fx.outputRoot, provider, boundary: proofBoundary({ state: "registered", heartbeatAt: 1_500 }), now: () => now,
    rollback: async previous => { rolled.push(previous); return { state: "registered" }; },
  });
  assert.equal((await prove(2_000 + PROOF_DEADLINE_MS)).state, "registered", "at the deadline it still waits");
  assert.equal(rolled.length, 0);
  const result = await prove(2_000 + PROOF_DEADLINE_MS + 1);
  assert.equal(result.rolledBack, true);
  assert.equal(rolled.length, 1);
  assert.equal(rolled[0].revision, 1);
});

test("the deadline counts awake time: a resume restarts the wait", { skip: POSIX_ONLY }, async () => {
  const fx = installation();
  await reconcile(fx, fakeProvider(), { now: () => 1_000 });
  const result = await proveSentinelRegistration({
    platform: "linux", outputRoot: fx.outputRoot, provider: fakeProvider(), boundary: proofBoundary({ state: "registered", heartbeatAt: null }),
    now: () => 1_000 + PROOF_DEADLINE_MS + 10, awakeSince: 1_000 + PROOF_DEADLINE_MS,
  });
  assert.equal(result.state, "registered");
});

test("no previous identity: past the deadline the registration needs attention, nothing is invented", { skip: POSIX_ONLY }, async () => {
  const fx = installation();
  await reconcile(fx, fakeProvider(), { now: () => 1_000 });
  const result = await proveSentinelRegistration({ platform: "linux", outputRoot: fx.outputRoot, provider: fakeProvider(), boundary: proofBoundary({ state: "registered", heartbeatAt: null }), now: () => 1_001 + PROOF_DEADLINE_MS });
  assert.equal(result.state, "registration-needed");
  assert.equal(readRegistrationRecord(fx.outputRoot, { platform: "linux" }).reason, "no-heartbeat");
});
