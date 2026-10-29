// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sentinel OS scheduling (1.0.9, GAP-SENTINEL-109 sections 10.1 and 10.2). One owning-user registration per
// installation, written and read back without a shell:
//
//   macOS    LaunchAgent com.ferroxlabs.murage.sentinel.<id>: RunAtLoad, StartInterval 120, ProcessType Background,
//            LowPriorityIO, no wake; launchctl bootstrap/bootout gui/<uid>. Read back: the owned plist bytes plus the
//            loaded job (Program, ProgramArguments, LastExitStatus) through one bounded JXA query.
//   Windows  Task Scheduler task \FerroxLabs\Murage\Sentinel\<id>: logon trigger with PT2M repetition,
//            StartWhenAvailable, MultipleInstancesPolicy IgnoreNew, priority 7, no WakeToRun, a 1 minute
//            ExecutionTimeLimit, LeastPrivilege, InteractiveToken, no stored password; schtasks /Create /XML and read
//            back with schtasks /Query /XML (executable, arguments, owner SID, revision) plus the last result. A task
//            cannot carry an environment, so it runs the executable with the trampoline flag
//            (electron/sentinel-trampoline.mjs), which starts the scanner with ELECTRON_RUN_AS_NODE=1 and exits.
//   Linux    systemd --user murage-sentinel-<id>.service + .timer: OnActiveSec=30, OnUnitInactiveSec=120, Nice=19,
//            IOSchedulingClass=idle, no wake, no root. Read back: the loaded unit must be exactly the owned fragment
//            (no drop-ins, no pending reload); ExecStart words come from that fragment, the last result from systemd.
//            No user manager: the independent `--watch` supervisor plus an XDG autostart entry.
//
// Every OS command goes through the injected runner as an argv array, so tests on any OS assert the exact argv, plist,
// XML and unit text for all three. Registration state (section 10.2): unregistered -> staged -> registered -> proven;
// a failure is registration-needed and keeps the prior valid registration. An update stages the new entry, validates it,
// replaces the registration, and is proven only by a heartbeat newer than that replacement; the previous identity is
// kept for rollback. The OS job keeps one name per installation, so an old and a new scanner never both run.
// Removal touches only this installation's names. Quitting the app never calls removal.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execStartExecutable, execStartWord, environmentLine } from "../installer/lib/systemd.mjs";
import { SENTINEL_TRAMPOLINE_FLAG } from "./sentinel-trampoline.mjs";

export const SENTINEL_INTERVAL_SECONDS = 120;
export const SENTINEL_TASK_FOLDER = "\\FerroxLabs\\Murage\\Sentinel\\";
export const SENTINEL_RECORD_FILE = "registration.json";
export const SENTINEL_RUNTIME_DIR = "runtime";
export const APPRUN_NO_SANDBOX = "--no-sandbox";
/** Windows "task has not yet run" (SCHED_S_TASK_HAS_NOT_RUN). */
export const SCHED_S_TASK_HAS_NOT_RUN = 0x41303;
/** A registration is proven by a heartbeat written after it; the scanner writes one at most every 15 min, so allow two
 *  heartbeat intervals plus two cadences (awake time) before an update is rolled back. */
export const PROOF_DEADLINE_MS = 2 * 15 * 60_000 + 2 * SENTINEL_INTERVAL_SECONDS * 1000 + 15_000;
const ID = /^[0-9a-f]{16,64}$/;
const ENTRY_NAME = /^cli-[0-9a-f]{16}\.js$/;
const LIMIT = 65536;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const refuse = (code = "SENTINEL_SCHEDULE_REFUSED") => { throw Object.assign(new Error("Sentinel scheduling refused."), { code }); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pathFor = platform => (platform === "win32" ? path.win32 : path.posix);

/** The per-installation OS names. Nothing else is ever created, read or removed. */
export function sentinelNames(installationId) {
  if (typeof installationId !== "string" || !ID.test(installationId)) refuse("SENTINEL_INSTALLATION_ID_INVALID");
  return Object.freeze({
    label: `com.ferroxlabs.murage.sentinel.${installationId}`,
    task: `${SENTINEL_TASK_FOLDER}${installationId}`,
    unit: `murage-sentinel-${installationId}`,
    autostart: `murage-sentinel-${installationId}.desktop`,
  });
}

/** What the OS runs: absolute executable, entry and descriptor; `--once` for schedulers, `--watch` for the fallback. */
export function sentinelInvocation({ platform, descriptor, descriptorPath, mode = "--once" }) {
  if (!["--once", "--watch"].includes(mode)) refuse();
  const exe = descriptor?.executable;
  const p = pathFor(platform);
  for (const value of [exe?.path, exe?.entry, descriptorPath]) if (typeof value !== "string" || !p.isAbsolute(value) || /[\0\r\n]/.test(value)) refuse("SENTINEL_PATH_INVALID");
  if (platform === "win32") return { executable: exe.path, args: [SENTINEL_TRAMPOLINE_FLAG, exe.entry, descriptorPath, mode], env: {} };
  return { executable: exe.path, args: [exe.entry, descriptorPath, mode, ...(platform === "linux" ? [APPRUN_NO_SANDBOX] : [])], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const unxml = value => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name]);
const marker = (id, revision) => `MurageSentinel ${id} revision=${revision}`;
const MARKER = /MurageSentinel ([0-9a-f]{16,64}) revision=(0|[1-9][0-9]{0,8})\b/;

/** One Windows command-line argument (CommandLineToArgvW rules): quoted when needed, backslashes before a quote doubled. */
export function windowsArgument(value) {
  const s = String(value);
  if (/[\0\r\n]/.test(s)) refuse("SENTINEL_PATH_INVALID");
  if (s && !/[ \t"]/.test(s)) return s;
  let out = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === "\\") { slashes++; continue; }
    if (ch === '"') { out += "\\".repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    out += "\\".repeat(slashes) + ch; slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/** Splits a Windows argument string (the task's <Arguments>) exactly as CommandLineToArgvW does for argv[1..]. */
export function parseWindowsArguments(text) {
  const args = [];
  let i = 0;
  while (i < text.length) {
    while (text[i] === " " || text[i] === "\t") i++;
    if (i >= text.length) break;
    let arg = "";
    let quoted = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (!quoted && (ch === " " || ch === "\t")) break;
      if (ch === "\\") {
        let n = 0;
        while (text[i] === "\\") { n++; i++; }
        if (text[i] === '"') { arg += "\\".repeat(Math.floor(n / 2)); if (n % 2) { arg += '"'; continue; } i--; continue; }
        arg += "\\".repeat(n); i--; continue;
      }
      if (ch === '"') { if (quoted && text[i + 1] === '"') { arg += '"'; i++; continue; } quoted = !quoted; continue; }
      arg += ch;
    }
    args.push(arg);
  }
  return args;
}

function launchdPlist(id, revision, invocation) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(sentinelNames(id).label)}</string>
<key>ProgramArguments</key><array>${[invocation.executable, ...invocation.args].map(value => `<string>${xml(value)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>${SENTINEL_INTERVAL_SECONDS}</integer>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
<key>KeepAlive</key><false/>
<!-- ${marker(id, revision)} -->
</dict></plist>
`;
}

/** The ProgramArguments and marker of an owned plist (our own format only; anything else is null). */
export function parseLaunchdPlist(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > LIMIT) return null;
  const args = /<key>ProgramArguments<\/key><array>((?:<string>[^<]*<\/string>)+)<\/array>/.exec(text);
  const found = MARKER.exec(text);
  if (!args || !found) return null;
  const words = [...args[1].matchAll(/<string>([^<]*)<\/string>/g)].map(match => unxml(match[1]));
  return { executable: words[0], args: words.slice(1), installationId: found[1], revision: Number(found[2]) };
}

function taskXml(id, revision, invocation, userSid) {
  if (typeof userSid !== "string" || !/^S-1-(?:\d+-){1,14}\d+$/.test(userSid)) refuse("SENTINEL_OWNER_UNKNOWN");
  const args = invocation.args.map(windowsArgument).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Murage</Author>
    <Description>Murage Sentinel health checks. ${marker(id, revision)}</Description>
    <URI>${xml(sentinelNames(id).task)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${userSid}</UserId>
      <Repetition>
        <Interval>PT2M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${userSid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(invocation.executable)}</Command>
      <Arguments>${xml(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

const tag = (text, name) => { const all = [...text.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`, "g"))]; return all.length === 1 ? unxml(all[0][1]).trim() : null; };

/** Reads what Task Scheduler actually holds (schtasks /Query /XML): one Exec action, its principal and our marker. */
export function parseTaskXml(text) {
  if (typeof text !== "string" || text.length > LIMIT) return null;
  if ((text.match(/<Exec>/g) ?? []).length !== 1) return null;
  const command = tag(text, "Command");
  const argumentText = tag(text, "Arguments") ?? "";
  const description = tag(text, "Description") ?? "";
  const found = MARKER.exec(description);
  const principal = /<Principal\b[^>]*>([\s\S]*?)<\/Principal>/.exec(text);
  if (!command || !found || !principal) return null;
  const userId = tag(principal[1], "UserId");
  const logonType = tag(principal[1], "LogonType");
  const runLevel = tag(principal[1], "RunLevel");
  return {
    executable: command, args: parseWindowsArguments(argumentText), owner: userId, installationId: found[1], revision: Number(found[2]),
    logonType, runLevel, wakeToRun: tag(text, "WakeToRun"), multipleInstances: tag(text, "MultipleInstancesPolicy"),
  };
}

/** `schtasks /Query /TN <name> /FO CSV /NH /V`: the Last Result column (index 6), null when the task never ran. */
export function parseSchtasksLastResult(csv) {
  if (typeof csv !== "string" || csv.length > LIMIT) return undefined;
  const line = csv.split(/\r?\n/).find(row => row.trim());
  if (!line) return undefined;
  const cells = [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1].replaceAll('""', '"'));
  if (cells.length < 7 || !/^-?\d{1,10}$/.test(cells[6].trim())) return undefined;
  const value = Number(cells[6].trim());
  return value === SCHED_S_TASK_HAS_NOT_RUN ? null : value;
}

function systemdUnits(id, revision, invocation) {
  const names = sentinelNames(id);
  const exec = [execStartExecutable("Sentinel executable", invocation.executable), ...invocation.args.map(value => execStartWord("Sentinel argument", value))].join(" ");
  const service = `# ${marker(id, revision)}
[Unit]
Description=Murage Sentinel health check

[Service]
Type=oneshot
ExecStart=${exec}
${environmentLine("ELECTRON_RUN_AS_NODE", "1")}
UMask=0077
Nice=19
IOSchedulingClass=idle
TimeoutStartSec=60
KillMode=process
StandardOutput=null
StandardError=null
`;
  const timer = `# ${marker(id, revision)}
[Unit]
Description=Murage Sentinel health check timer

[Timer]
OnActiveSec=30s
OnUnitInactiveSec=${SENTINEL_INTERVAL_SECONDS}s
AccuracySec=15s
Unit=${names.unit}.service

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

/** The ExecStart words of an owned service fragment (inverse of installer/lib/systemd.mjs quoting), and its marker. */
export function parseSystemdService(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > LIMIT) return null;
  const line = text.split("\n").filter(row => row.startsWith("ExecStart="));
  const found = MARKER.exec(text);
  if (line.length !== 1 || !found) return null;
  const words = [...line[0].slice("ExecStart=".length).matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]);
  if (!words.length) return null;
  const executable = words[0].replaceAll("%%", "%");
  const args = words.slice(1).map(word => word.replaceAll("$$", "$").replaceAll("%%", "%"));
  return { executable, args, installationId: found[1], revision: Number(found[2]) };
}

/** XDG desktop-entry Exec quoting: reserved characters are quoted; values a launcher would reinterpret are refused. */
function desktopExecWord(value) {
  const s = String(value);
  if (!s || /["`$\\\0\r\n]/.test(s)) refuse("SENTINEL_PATH_INVALID");
  const escaped = s.replaceAll("%", "%%");
  return /^[A-Za-z0-9_/.:@+,=-]+$/.test(s) ? escaped : `"${escaped}"`;
}

function autostartEntry(id, revision, invocation) {
  const exec = ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", invocation.executable, ...invocation.args].map(desktopExecWord).join(" ");
  return `[Desktop Entry]
Type=Application
Name=Murage Sentinel
Comment=Murage health checks. ${marker(id, revision)}
Exec=${exec}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

/**
 * Builds the exact files for one registration. `paths`: { home, configHome, userSid } as the platform needs.
 * Answers { mechanism, name, files: [{ path, text }], invocation, revision, installationId }.
 */
export function buildSentinelRegistration({ platform, descriptor, descriptorPath, home, configHome, userSid, mechanism }) {
  const id = descriptor?.installationId;
  const names = sentinelNames(id);
  const revision = descriptor.scheduleRevision;
  if (!Number.isSafeInteger(revision) || revision < 0) refuse();
  if (platform === "darwin") {
    const invocation = sentinelInvocation({ platform, descriptor, descriptorPath });
    return { mechanism: "launchd", name: names.label, installationId: id, revision, invocation, files: [{ path: path.posix.join(home, "Library", "LaunchAgents", `${names.label}.plist`), text: launchdPlist(id, revision, invocation) }] };
  }
  if (platform === "win32") {
    const invocation = sentinelInvocation({ platform, descriptor, descriptorPath });
    return { mechanism: "task-scheduler", name: names.task, installationId: id, revision, invocation, files: [], xml: taskXml(id, revision, invocation, userSid) };
  }
  if (platform !== "linux") refuse("SENTINEL_PLATFORM_UNSUPPORTED");
  const base = configHome && path.posix.isAbsolute(configHome) ? configHome : path.posix.join(home, ".config");
  if (mechanism === "autostart") {
    const invocation = sentinelInvocation({ platform, descriptor, descriptorPath, mode: "--watch" });
    return { mechanism: "autostart", name: names.autostart, installationId: id, revision, invocation, files: [{ path: path.posix.join(base, "autostart", names.autostart), text: autostartEntry(id, revision, invocation) }] };
  }
  const invocation = sentinelInvocation({ platform, descriptor, descriptorPath });
  const units = systemdUnits(id, revision, invocation);
  const dir = path.posix.join(base, "systemd", "user");
  return {
    mechanism: "systemd", name: names.unit, installationId: id, revision, invocation,
    files: [{ path: path.posix.join(dir, `${names.unit}.service`), text: units.service }, { path: path.posix.join(dir, `${names.unit}.timer`), text: units.timer }],
  };
}

// ---------------------------------------------------------------------------
// OS provider (all commands through `run`)
// ---------------------------------------------------------------------------

/** Loaded-job query: one label in the user's launchd domain; answers its Program, ProgramArguments, LastExitStatus and
 *  PID only (bounded), or absent. No launchctl print parsing. */
export const SENTINEL_MAC_QUERY = String.raw`ObjC.import('Foundation');ObjC.import('ServiceManagement');
function run(argv){try{if(argv.length!==1)throw Error();var raw=$.SMJobCopyDictionary($.kSMDomainUserLaunchd,$(argv[0]));
if(raw===null||raw===undefined)return JSON.stringify({version:1,status:'absent'});var job=ObjC.castRefToObject(raw);
if(job.isNil())return JSON.stringify({version:1,status:'absent'});var d=ObjC.deepUnwrap(job);if(!d||typeof d!=='object')throw Error();
var args=Array.isArray(d.ProgramArguments)?d.ProgramArguments.slice(0,16).map(function(v){return String(v).slice(0,1024);}):null;
return JSON.stringify({version:1,status:'found',program:typeof d.Program==='string'?d.Program.slice(0,1024):null,args:args,
lastExit:typeof d.LastExitStatus==='number'?d.LastExitStatus:null,pid:typeof d.PID==='number'?d.PID:null});
}catch(_){return JSON.stringify({version:1,status:'unavailable'});}}`;

/** Default runner: execFile with a fixed minimal environment, bounded output, never a shell. Answers { code, stdout }. */
export function defaultScheduleRun({ executable, args, timeoutMs = 15_000, env }) {
  return new Promise(resolve => {
    const baseEnv = { PATH: process.platform === "win32" ? process.env.PATH ?? "" : "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
    for (const key of ["HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LOCALAPPDATA", "TEMP", "TMP"]) if (typeof process.env[key] === "string") baseEnv[key] = process.env[key];
    execFile(executable, args, { env: { ...baseEnv, ...(env ?? {}) }, encoding: "buffer", timeout: timeoutMs, maxBuffer: LIMIT * 2, windowsHide: true, shell: false }, (error, stdout) => {
      if (error && (error.killed || typeof error.code !== "number")) { resolve({ code: null, stdout: "" }); return; }
      resolve({ code: error?.code ?? 0, stdout: decodeOutput(stdout) });
    });
  });
}

/** schtasks writes UTF-16 for /XML on some builds; everything else is UTF-8. */
export function decodeOutput(buffer) {
  if (!Buffer.isBuffer(buffer)) return typeof buffer === "string" ? buffer : "";
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer.length >= 4 && buffer[1] === 0 && buffer[3] === 0) return buffer.toString("utf16le");
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

const system32 = (env, name) => path.win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", name);

function readOwned(file, uid, platform) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMIT || stat.nlink !== 1 || (platform !== "win32" && (stat.uid !== uid || (stat.mode & 0o022)))) refuse();
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) { const n = readSync(fd, buffer, read, buffer.length - read, read); if (n <= 0) break; read += n; }
    return buffer.subarray(0, read).toString("utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function ensurePrivateDirs(base, leaf, uid, platform) {
  // Every directory from `base` down to `leaf` must be real (no link), ours and not writable by others.
  const p = pathFor(platform);
  const rel = p.relative(base, leaf);
  if (rel.startsWith("..") || p.isAbsolute(rel)) refuse();
  let current = base;
  const check = dir => {
    const s = lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || (platform !== "win32" && (s.uid !== uid || (s.mode & 0o022)))) refuse();
  };
  check(current);
  for (const part of rel ? rel.split(p.sep) : []) {
    current = p.join(current, part);
    try { check(current); } catch (error) { if (error?.code !== "ENOENT") throw error; mkdirSync(current, { mode: 0o700 }); check(current); }
  }
}

function writeOwnedAtomic(file, text, platform) {
  const temp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
  if (platform !== "win32") chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/**
 * The OS side. `run({ executable, args, input? })` answers { code, stdout }. Tests pass a fake runner and a temp home.
 * read(descriptor, descriptorPath) answers a RegistrationState (server/sentinel/cli.ts) or null when nothing is
 * registered. install(registration) replaces this installation's registration and starts it. remove(installationId)
 * takes down only this installation's names.
 */
export function createSentinelScheduleProvider({ platform = process.platform, run = defaultScheduleRun, home, configHome, uid = process.getuid?.() ?? -1, userSid = null, env = process.env, taskFileDir = null } = {}) {
  if (typeof home !== "string" || !pathFor(platform).isAbsolute(home)) refuse("SENTINEL_HOME_INVALID");
  const configBase = platform === "linux" ? (configHome && path.posix.isAbsolute(configHome) ? configHome : path.posix.join(home, ".config")) : null;
  async function command(executable, args, options = {}) {
    let result;
    try { result = await run({ executable, args, ...options }); } catch { refuse("SENTINEL_SCHEDULER_UNAVAILABLE"); }
    if (!result || (result.code !== null && !Number.isInteger(result.code)) || typeof result.stdout !== "string" || result.stdout.length > LIMIT * 2) refuse("SENTINEL_SCHEDULER_UNAVAILABLE");
    return result;
  }
  const build = (descriptor, descriptorPath, mechanism) => buildSentinelRegistration({ platform, descriptor, descriptorPath, home, configHome: configBase, userSid, mechanism });
  // The directory chain checked and created below: the home, or an XDG_CONFIG_HOME outside it (which must exist).
  const linuxBase = () => { const rel = path.posix.relative(home, configBase); return rel.startsWith("..") || path.posix.isAbsolute(rel) ? configBase : home; };
  const uidOk = () => platform === "win32" || (Number.isSafeInteger(uid) && uid > 0);

  async function readMac(descriptor, descriptorPath) {
    const reg = build(descriptor, descriptorPath);
    const file = reg.files[0].path;
    const text = readOwned(file, uid, platform);
    const result = await command("/usr/bin/osascript", ["-l", "JavaScript", "-e", SENTINEL_MAC_QUERY, "--", reg.name]);
    let loaded;
    try { loaded = JSON.parse(result.stdout); } catch { refuse("SENTINEL_SCHEDULER_UNAVAILABLE"); }
    if (result.code !== 0 || loaded?.version !== 1 || !["absent", "found"].includes(loaded.status)) refuse("SENTINEL_SCHEDULER_UNAVAILABLE");
    if (text === null && loaded.status === "absent") return null;
    const disk = text === null ? null : parseLaunchdPlist(text);
    const words = loaded.status === "found" && Array.isArray(loaded.args) ? loaded.args : null;
    const registered = !!disk && loaded.status === "found" && !!words && same(words, [disk.executable, ...disk.args]) && (loaded.program === null || loaded.program === disk.executable) && disk.installationId === descriptor.installationId;
    return {
      mechanism: "launchd", registered, executable: registered ? words[0] : disk?.executable ?? null, args: registered ? words.slice(1) : disk?.args ?? null,
      owner: text === null ? null : String(uid), revision: disk?.revision ?? null, lastResult: Number.isInteger(loaded.lastExit) ? loaded.lastExit : null,
    };
  }

  async function readWindows(descriptor) {
    const names = sentinelNames(descriptor.installationId);
    const query = await command(system32(env, "schtasks.exe"), ["/Query", "/TN", names.task, "/XML"]);
    if (query.code !== 0) return null; // not registered (schtasks answers 1 for an unknown task)
    const task = parseTaskXml(query.stdout);
    if (!task) return { mechanism: "task-scheduler", registered: false, executable: null, args: null, owner: null, revision: null, lastResult: null };
    const status = await command(system32(env, "schtasks.exe"), ["/Query", "/TN", names.task, "/FO", "CSV", "/NH", "/V"]);
    const lastResult = status.code === 0 ? parseSchtasksLastResult(status.stdout) ?? null : null;
    const ownerOk = typeof userSid === "string" && task.owner === userSid && task.logonType === "InteractiveToken" && task.runLevel === "LeastPrivilege" && task.wakeToRun === "false";
    return {
      mechanism: "task-scheduler", registered: ownerOk && task.installationId === descriptor.installationId, executable: task.executable, args: task.args,
      owner: task.owner, revision: task.revision, lastResult,
    };
  }

  async function readSystemd(descriptor, descriptorPath) {
    const reg = build(descriptor, descriptorPath);
    const [serviceFile, timerFile] = reg.files.map(file => file.path);
    const service = readOwned(serviceFile, uid, platform);
    const timer = readOwned(timerFile, uid, platform);
    const props = {};
    for (const [kind, requested] of [["service", ["Id", "LoadState", "FragmentPath", "DropInPaths", "NeedDaemonReload", "Result", "ExecMainStatus", "ExecMainExitTimestampMonotonic"]], ["timer", ["Id", "LoadState", "ActiveState", "UnitFileState", "FragmentPath", "DropInPaths", "NeedDaemonReload"]]]) {
      const result = await command("/usr/bin/systemctl", ["--user", "show", "--no-pager", `--property=${requested.join(",")}`, `${reg.name}.${kind}`]);
      if (result.code !== 0) refuse("SENTINEL_SCHEDULER_UNAVAILABLE");
      props[kind] = parseProperties(result.stdout, requested);
    }
    if (service === null && timer === null && props.service.LoadState === "not-found" && props.timer.LoadState === "not-found") return null;
    const parsed = service === null ? null : parseSystemdService(service);
    const exact = (kind, file) => props[kind].LoadState === "loaded" && props[kind].FragmentPath === file && props[kind].DropInPaths === "" && props[kind].NeedDaemonReload === "no";
    const timerRev = timer === null ? null : MARKER.exec(timer);
    const registered = !!parsed && !!timerRev && Number(timerRev[2]) === parsed.revision && exact("service", serviceFile) && exact("timer", timerFile)
      && props.timer.UnitFileState === "enabled" && props.timer.ActiveState === "active" && parsed.installationId === descriptor.installationId;
    const ran = props.service.ExecMainExitTimestampMonotonic !== "0" && /^\d+$/.test(props.service.ExecMainExitTimestampMonotonic);
    const status = /^-?\d+$/.test(props.service.ExecMainStatus) ? Number(props.service.ExecMainStatus) : null;
    return {
      mechanism: "systemd", registered, executable: parsed?.executable ?? null, args: parsed?.args ?? null, owner: service === null ? null : String(uid),
      revision: parsed?.revision ?? null, lastResult: ran ? (props.service.Result === "success" ? status ?? 0 : status ?? -1) : null,
    };
  }

  async function readAutostart(descriptor, descriptorPath) {
    const reg = build(descriptor, descriptorPath, "autostart");
    const text = readOwned(reg.files[0].path, uid, platform);
    if (text === null) return null;
    const found = MARKER.exec(text);
    const exact = text === reg.files[0].text;
    return { mechanism: "autostart", registered: exact, executable: exact ? reg.invocation.executable : null, args: exact ? reg.invocation.args : null, owner: String(uid), revision: found ? Number(found[2]) : null, lastResult: null };
  }

  return {
    platform,
    /** The scheduler registration, read back from the OS (never assumed from our own files alone). */
    async read(descriptor, descriptorPath) {
      if (!uidOk()) refuse("SENTINEL_OWNER_UNKNOWN");
      if (platform === "darwin") return readMac(descriptor, descriptorPath);
      if (platform === "win32") return readWindows(descriptor, descriptorPath);
      if (platform === "linux") return readSystemd(descriptor, descriptorPath);
      refuse("SENTINEL_PLATFORM_UNSUPPORTED");
    },
    /** The Linux fallback registration (XDG autostart of the `--watch` supervisor), read back. */
    async readFallback(descriptor, descriptorPath) {
      if (platform !== "linux") return null;
      return readAutostart(descriptor, descriptorPath);
    },
    /** Replaces this installation's registration with `descriptor`'s and starts it. Throws on any refusal. */
    async install(descriptor, descriptorPath) {
      if (!uidOk()) refuse("SENTINEL_OWNER_UNKNOWN");
      const reg = build(descriptor, descriptorPath);
      if (platform === "darwin") {
        const file = reg.files[0];
        ensurePrivateDirs(home, path.posix.dirname(file.path), uid, platform);
        const domain = `gui/${uid}`;
        await command("/bin/launchctl", ["bootout", `${domain}/${reg.name}`]); // absent is fine: replacing, never two
        writeOwnedAtomic(file.path, file.text, platform);
        const boot = await command("/bin/launchctl", ["bootstrap", domain, file.path]);
        if (boot.code !== 0) refuse("SENTINEL_SCHEDULER_REFUSED");
        return reg;
      }
      if (platform === "win32") {
        // schtasks reads the definition from a file: a private UTF-16 copy in the output root, removed afterwards.
        const file = path.join(taskFileDir ?? path.win32.dirname(descriptorPath), `.task-${randomBytes(6).toString("hex")}.xml`);
        writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(reg.xml, "utf16le")]), { flag: "wx", mode: 0o600 });
        try {
          const created = await command(system32(env, "schtasks.exe"), ["/Create", "/TN", reg.name, "/XML", file, "/F"]);
          if (created.code !== 0) refuse("SENTINEL_SCHEDULER_REFUSED");
        } finally { try { unlinkSync(file); } catch { /* removed at the next install */ } }
        // A logon trigger first fires at the next sign-in: start it once now so coverage begins today.
        await command(system32(env, "schtasks.exe"), ["/Run", "/TN", reg.name]);
        return reg;
      }
      const dir = path.posix.dirname(reg.files[0].path);
      ensurePrivateDirs(linuxBase(), dir, uid, platform);
      for (const file of reg.files) writeOwnedAtomic(file.path, file.text, platform);
      const reload = await command("/usr/bin/systemctl", ["--user", "daemon-reload"]);
      if (reload.code !== 0) refuse("SENTINEL_NO_USER_MANAGER");
      const enable = await command("/usr/bin/systemctl", ["--user", "enable", "--now", `${reg.name}.timer`]);
      if (enable.code !== 0) refuse("SENTINEL_SCHEDULER_REFUSED");
      return reg;
    },
    /** Linux without a user manager: writes the owning-user autostart entry (the host starts this session's supervisor). */
    async installFallback(descriptor, descriptorPath) {
      if (platform !== "linux") refuse("SENTINEL_PLATFORM_UNSUPPORTED");
      const reg = build(descriptor, descriptorPath, "autostart");
      ensurePrivateDirs(linuxBase(), path.posix.dirname(reg.files[0].path), uid, platform);
      writeOwnedAtomic(reg.files[0].path, reg.files[0].text, platform);
      return reg;
    },
    /** Linux: removes only this installation's autostart entry, once its systemd timer is proven (the fallback is then
     *  not needed; its running supervisor stops by itself when the descriptor's revision moves on). */
    async removeFallback(installationId) {
      if (platform !== "linux") return { removed: [] };
      const file = path.posix.join(configBase, "autostart", sentinelNames(installationId).autostart);
      try { const s = lstatSync(file); if (s.isFile() && !s.isSymbolicLink()) { unlinkSync(file); return { removed: [file] }; } } catch { /* absent */ }
      return { removed: [] };
    },
    /** Takes down only this installation's names (never another installation's, never a prefix match). */
    async remove(installationId) {
      const names = sentinelNames(installationId);
      const removed = [];
      const unlinkOwned = file => { try { const s = lstatSync(file); if (s.isFile() && !s.isSymbolicLink()) { unlinkSync(file); removed.push(file); } } catch { /* absent */ } };
      if (platform === "darwin") {
        await command("/bin/launchctl", ["bootout", `gui/${uid}/${names.label}`]);
        unlinkOwned(path.posix.join(home, "Library", "LaunchAgents", `${names.label}.plist`));
      } else if (platform === "win32") {
        await command(system32(env, "schtasks.exe"), ["/Delete", "/TN", names.task, "/F"]);
      } else if (platform === "linux") {
        await command("/usr/bin/systemctl", ["--user", "disable", "--now", `${names.unit}.timer`]);
        await command("/usr/bin/systemctl", ["--user", "stop", `${names.unit}.service`]);
        const dir = path.posix.join(configBase, "systemd", "user");
        unlinkOwned(path.posix.join(dir, `${names.unit}.service`));
        unlinkOwned(path.posix.join(dir, `${names.unit}.timer`));
        unlinkOwned(path.posix.join(configBase, "autostart", names.autostart));
        await command("/usr/bin/systemctl", ["--user", "daemon-reload"]);
      }
      return { removed };
    },
  };
}

function parseProperties(stdout, requested) {
  const out = {};
  for (const line of stdout.trimEnd().split("\n")) {
    const at = line.indexOf("=");
    if (at < 1) refuse("SENTINEL_SCHEDULER_UNAVAILABLE");
    const key = line.slice(0, at);
    if (!requested.includes(key) || Object.hasOwn(out, key)) refuse("SENTINEL_SCHEDULER_UNAVAILABLE");
    out[key] = line.slice(at + 1);
  }
  if (requested.some(key => !Object.hasOwn(out, key))) refuse("SENTINEL_SCHEDULER_UNAVAILABLE");
  return out;
}

// ---------------------------------------------------------------------------
// Staging, the registration record, and the state machine (section 10.2)
// ---------------------------------------------------------------------------

export const REGISTRATION_STATES = Object.freeze(["unregistered", "staged", "registered", "proven", "registration-needed"]);

/** SHA-256 hex of the bundled scanner entry. */
export function entryDigest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

/** Copies the bundled entry to <outputRoot>/runtime/cli-<sha16>.js (owner-only, exclusive, verified). The copy is the
 *  stable installed location every registration names: an app update, a moved AppImage or a translocated bundle never
 *  changes the file a registered job runs. */
export function stageEntry({ outputRoot, source, platform = process.platform, uid = process.getuid?.() ?? -1 }) {
  const p = pathFor(platform);
  const bytes = readFileSync(source);
  if (bytes.length === 0 || bytes.length > 16 * 1024 * 1024) refuse("SENTINEL_ENTRY_INVALID");
  const sha256 = entryDigest(bytes);
  const dir = p.join(outputRoot, SENTINEL_RUNTIME_DIR);
  ensurePrivateDirs(outputRoot, dir, uid, platform);
  const entry = p.join(dir, `cli-${sha256.slice(0, 16)}.js`);
  let existing = null;
  try { existing = readFileSync(entry); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (existing && entryDigest(existing) === sha256) return { entry, sha256 };
  if (existing) unlinkSync(entry); // a damaged copy is replaced, never trusted
  writeOwnedAtomic(entry, bytes, platform);
  if (entryDigest(readFileSync(entry)) !== sha256) refuse("SENTINEL_ENTRY_INVALID");
  return { entry, sha256 };
}

/** Removes staged entries other than `keep` (current and previous). Only cli-<16 hex>.js names are touched. */
export function pruneEntries({ outputRoot, keep, platform = process.platform }) {
  const p = pathFor(platform);
  const dir = p.join(outputRoot, SENTINEL_RUNTIME_DIR);
  const keepNames = new Set(keep.filter(Boolean).map(file => p.basename(file)));
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const name of names) {
    if (!ENTRY_NAME.test(name) || keepNames.has(name)) continue;
    try { unlinkSync(p.join(dir, name)); removed.push(name); } catch { /* retried next time */ }
  }
  return removed;
}

const RECORD_KEYS = ["version", "installationId", "state", "mechanism", "revision", "registeredAt", "provenAt", "current", "previous", "reason"];
const IDENTITY_KEYS = ["path", "entry", "sha256", "revision"];
const validIdentity = value => value === null || (value && typeof value === "object" && Object.keys(value).sort().join() === [...IDENTITY_KEYS].sort().join()
  && typeof value.path === "string" && typeof value.entry === "string" && (value.sha256 === null || /^[0-9a-f]{64}$/.test(value.sha256)) && Number.isSafeInteger(value.revision));

/** Reads <outputRoot>/registration.json (owner-only); null when absent or not ours. */
export function readRegistrationRecord(outputRoot, { platform = process.platform, uid = process.getuid?.() ?? -1 } = {}) {
  const file = pathFor(platform).join(outputRoot, SENTINEL_RECORD_FILE);
  let text;
  try { text = readOwned(file, uid, platform); } catch { return null; }
  if (text === null) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || Object.keys(value).sort().join() !== [...RECORD_KEYS].sort().join() || value.version !== 1 || !ID.test(value.installationId)
    || !REGISTRATION_STATES.includes(value.state) || !validIdentity(value.current) || !validIdentity(value.previous)) return null;
  return value;
}

export function writeRegistrationRecord(outputRoot, record, { platform = process.platform } = {}) {
  const value = Object.fromEntries(RECORD_KEYS.map(key => [key, record[key] ?? null]));
  value.version = 1;
  writeOwnedAtomic(pathFor(platform).join(outputRoot, SENTINEL_RECORD_FILE), `${JSON.stringify(value)}\n`, platform);
  return value;
}

const identityOf = descriptor => descriptor ? { path: descriptor.executable.path, entry: descriptor.executable.entry, sha256: descriptor.executable.sha256, revision: descriptor.scheduleRevision } : null;
const sameIdentity = (a, b) => !!a && !!b && a.path === b.path && a.entry === b.entry && a.sha256 === b.sha256;

/**
 * Brings this installation's registration to the desired executable and entry (section 10.2). Never throws.
 *
 * deps: {
 *   platform, uid, installationId, installationRoot (canonical DATA_DIR), outputRoot, executable, entrySource,
 *   provider (createSentinelScheduleProvider), boundary (the bundled host boundary: paths helpers, checkInstall,
 *   registrationMatches), probe(descriptorPath, entry) -> exit code of `<exe> <entry> <descriptor> --check-install`,
 *   now()
 * }
 * Answers { state, mechanism, revision, reason }.
 */
export async function reconcileSentinelRegistration(deps) {
  const { platform = process.platform, uid = process.getuid?.() ?? -1, installationId, installationRoot, outputRoot, executable, entrySource, provider, boundary, probe } = deps;
  const now = deps.now ?? Date.now;
  const p = pathFor(platform);
  const descriptorPath = p.join(outputRoot, boundary.DESCRIPTOR_FILE);
  const prior = readRegistrationRecord(outputRoot, { platform, uid });
  const save = (record) => { try { return writeRegistrationRecord(outputRoot, { installationId, ...record }, { platform }); } catch { return null; } };
  const needed = (reason, extra = {}) => {
    save({ state: "registration-needed", mechanism: prior?.mechanism ?? null, revision: prior?.revision ?? null, registeredAt: prior?.registeredAt ?? null, provenAt: prior?.provenAt ?? null, current: prior?.current ?? null, previous: prior?.previous ?? null, reason, ...extra });
    return { state: "registration-needed", mechanism: extra.mechanism ?? prior?.mechanism ?? null, revision: prior?.revision ?? null, reason };
  };

  const root = boundary.ensureOutputRoot(outputRoot, { platform });
  if (!root.ok) return { state: "registration-needed", mechanism: null, revision: null, reason: `output-root-${root.reason}` };

  // 1. Stage the entry where registrations can rely on it.
  let staged;
  try { staged = stageEntry({ outputRoot, source: entrySource, platform, uid }); } catch { return needed("entry"); }
  const loaded = boundary.loadDescriptor(descriptorPath, { platform });
  const current = loaded.ok && loaded.value.installationId === installationId && loaded.value.installationRoot === installationRoot ? loaded.value : null;
  const desired = { path: executable, entry: staged.entry, sha256: staged.sha256 };

  // 2. Unchanged identity and a matching OS registration: nothing to replace.
  if (current && sameIdentity(identityOf(current), desired)) {
    let reg = null;
    try { reg = await provider.read(current, descriptorPath); } catch { reg = null; }
    if (reg && boundary.registrationMatches(reg, current, descriptorPath)) {
      const state = prior?.state === "proven" && prior.revision === current.scheduleRevision ? "proven" : "registered";
      save({ state, mechanism: reg.mechanism, revision: current.scheduleRevision, registeredAt: prior?.registeredAt ?? now(), provenAt: state === "proven" ? prior.provenAt : null, current: identityOf(current), previous: prior?.previous ?? null, reason: null });
      return { state, mechanism: reg.mechanism, revision: current.scheduleRevision, reason: null };
    }
  }

  // 3. Stage a new revision: write it, prove the new entry loads under this executable, then replace the registration.
  const revision = Math.max(current?.scheduleRevision ?? 0, prior?.revision ?? 0) + 1;
  const next = {
    version: boundary.DESCRIPTOR_VERSION, installationId, installationRoot, inputRoot: p.join(installationRoot, boundary.HEALTH_DIR), outputRoot,
    sources: boundary.sourcePaths(p.join(installationRoot, boundary.HEALTH_DIR), platform), executable: { ...desired }, scheduleRevision: revision,
  };
  if (!boundary.validateDescriptor(next, platform).ok) return needed("descriptor-invalid");
  save({ state: "staged", mechanism: prior?.mechanism ?? null, revision: prior?.revision ?? null, registeredAt: prior?.registeredAt ?? null, provenAt: prior?.provenAt ?? null, current: prior?.current ?? identityOf(current), previous: prior?.previous ?? null, reason: null });
  const restore = () => { if (current) boundary.writeDescriptor(current, { platform }); };
  if (!boundary.writeDescriptor(next, { platform }).ok) return needed("descriptor-write");
  let probed = null;
  try { probed = await probe(descriptorPath, staged.entry); } catch { probed = null; }
  if (probed !== boundary.EXIT.ok && probed !== boundary.EXIT.notProven) { restore(); return needed("entry-probe"); }

  let reg = null;
  try {
    await provider.install(next, descriptorPath);
    reg = await provider.read(next, descriptorPath);
  } catch (error) { reg = { failed: error?.code ?? "refused" }; }
  if (!reg || reg.failed || !boundary.registrationMatches(reg, next, descriptorPath)) {
    // Keep the prior valid registration: put its descriptor back and re-register it when it existed.
    restore();
    if (current) { try { await provider.install(current, descriptorPath); } catch { /* the prior job may still be in place */ } }
    const code = reg?.failed ?? "readback";
    return needed(code === "SENTINEL_NO_USER_MANAGER" ? "no-user-manager" : code === "readback" ? "readback" : "scheduler-refused");
  }
  const at = now();
  const previous = current && !sameIdentity(identityOf(current), desired) ? identityOf(current) : prior?.previous ?? null;
  save({ state: "registered", mechanism: reg.mechanism, revision, registeredAt: at, provenAt: null, current: identityOf(next), previous, reason: null });
  pruneEntries({ outputRoot, keep: [staged.entry, previous?.entry], platform });
  return { state: "registered", mechanism: reg.mechanism, revision, reason: null };
}

/**
 * The proof step: a registration that runs this entry+descriptor+revision AND a heartbeat written after it was
 * registered (so the heartbeat came from the new revision). Past the proof deadline (awake time), an update rolls back to
 * the previous identity by registering it as the next revision. Never throws.
 * deps: { platform, uid, outputRoot, provider, boundary, now, awakeSince, rollback(previousIdentity) }
 */
export async function proveSentinelRegistration(deps) {
  const { platform = process.platform, uid = process.getuid?.() ?? -1, outputRoot, provider, boundary } = deps;
  const now = (deps.now ?? Date.now)();
  const record = readRegistrationRecord(outputRoot, { platform, uid });
  if (!record) return { state: "unregistered", heartbeatAt: null, heartbeatFresh: false };
  const descriptorPath = pathFor(platform).join(outputRoot, boundary.DESCRIPTOR_FILE);
  let report;
  try {
    report = await boundary.checkInstall(descriptorPath, { now: () => now, registrationReaders: [descriptor => provider.read(descriptor, descriptorPath)] });
  } catch { report = null; }
  if (!report) return { state: record.state, heartbeatAt: null, heartbeatFresh: false };
  const heartbeatAt = report.heartbeatAt;
  const fromThisRevision = heartbeatAt !== null && record.registeredAt !== null && heartbeatAt >= record.registeredAt;
  if (report.state === "proven" && fromThisRevision) {
    if (record.state !== "proven") writeRegistrationRecord(outputRoot, { ...record, state: "proven", provenAt: now, reason: null }, { platform });
    return { state: "proven", heartbeatAt, heartbeatFresh: report.heartbeatFresh };
  }
  if (record.state === "registered" && record.registeredAt !== null) {
    const since = Math.max(record.registeredAt, deps.awakeSince ?? record.registeredAt);
    if (now - since > PROOF_DEADLINE_MS) {
      if (record.previous && deps.rollback) {
        const rolled = await deps.rollback(record.previous).catch(() => null);
        return { state: rolled?.state ?? "registration-needed", heartbeatAt, heartbeatFresh: report.heartbeatFresh, rolledBack: true };
      }
      writeRegistrationRecord(outputRoot, { ...record, state: "registration-needed", reason: "no-heartbeat" }, { platform });
      return { state: "registration-needed", heartbeatAt, heartbeatFresh: report.heartbeatFresh };
    }
  }
  if (record.state === "proven" && report.state !== "proven") {
    // A proven registration that lost its match or its heartbeat goes back to registered or needs registration.
    const state = report.registrations.some(r => r.matches) ? "registered" : "registration-needed";
    writeRegistrationRecord(outputRoot, { ...record, state, reason: state === "registered" ? "heartbeat-stale" : "registration-changed" }, { platform });
    return { state, heartbeatAt, heartbeatFresh: report.heartbeatFresh };
  }
  return { state: record.state, heartbeatAt, heartbeatFresh: report.heartbeatFresh };
}

/** Exposed for tests that pin the definition text. */
export const definitionInternals = Object.freeze({ launchdPlist, taskXml, systemdUnits, autostartEntry, desktopExecWord });
