// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The AppContainer read grant on the bundled browser folder: icacls /save /T read by SID, and icacls /grant only when an entry lacks
// ReadAndExecute for ALL APPLICATION PACKAGES (S-1-15-2-1). No PowerShell (murage-releases #1).
//
// The Linux Chrome sandbox check (Ubuntu 24.04 gate): the bundled Chrome is
// asked once whether it has a sandbox, and a refusal reaches the browser panel
// and the log as a message with the step that fixes it, never a generic 500
// and never a browser started with --no-sandbox.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBrowserSpec } from "./browser-engine.ts";
import {
  APP_CONTAINER_SID, appContainerCanRead, grantAppContainerRead,
  classifyChromeSandboxProbe, clearLinuxSandboxChecks, ensureBrowserSandboxAccess, ensureLinuxChromeSandbox,
  LINUX_SANDBOX_RECHECK_MS, linuxDebChromePath, linuxSandboxBlockedMessage, linuxUserNamespaces,
} from "./browser-sandbox.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";


const saved = (...pairs: Array<[string, string]>) => Buffer.from("\uFEFF" + pairs.map(([name, sddl]) => `${name}\r\n${sddl}\r\n`).join(""), "utf16le");
const PROGRAM_FILES = "D:PAI(A;OICIID;FA;;;S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)(A;OICIID;0x1200a9;;;AC)(A;OICIID;0x1200a9;;;S-1-15-2-2)";

describe("does the AppContainer already read the browser?", () => {
  it("yes on a stock Program Files install, for the folder and every file under it", () => {
    expect(appContainerCanRead(saved(["chrome-win", PROGRAM_FILES], ["chrome-win\\chrome.exe", PROGRAM_FILES], ["chrome-win\\locales\\en-US.pak", PROGRAM_FILES]))).toBe(true);
  });
  it("by its SID or alias, with specific or generic rights", () => {
    for (const ace of ["(A;;FA;;;AC)", "(A;ID;0x1200a9;;;S-1-15-2-1)", "(A;OICI;GRGX;;;AC)", "(A;;GA;;;S-1-15-2-1)", "(A;;FRFX;;;AC)"])
      expect(appContainerCanRead(saved(["x", `D:P${ace}`])), ace).toBe(true);
  });
  it("no when one item lacks it, when it is inherit-only, read-only, a deny, or the listing is unreadable", () => {
    expect(appContainerCanRead(saved(["chrome-win", PROGRAM_FILES], ["chrome-win\\chrome.exe", "D:PAI(A;;FA;;;SY)(A;;FA;;;BA)"]))).toBe(false);
    for (const ace of ["(A;OICIIO;FA;;;AC)", "(A;;FR;;;AC)", "(D;;FA;;;AC)", "(A;;FA;;;S-1-15-2-2)"]) expect(appContainerCanRead(saved(["x", `D:P${ace}`])), ace).toBe(false);
    expect(appContainerCanRead(Buffer.from(""))).toBe(false);
    expect(appContainerCanRead(Buffer.from("garbage\r\n", "utf16le"))).toBe(false);
  });
  it("an account this check has no use for (an unresolvable domain alias) never forces a grant", () => {
    expect(appContainerCanRead(saved(["x", "D:P(A;;FA;;;DA)(A;;0x1200a9;;;AC)(A;;FA;;;QQ)"]))).toBe(true);
  });
});

describe("the grant", () => {
  const run = (answers: boolean[]) => vi.fn(async (_file: string, _args: string[]) => answers.shift() ?? false);
  it("reads first and grants nothing when it is already there", async () => {
    const tool = run([true]);
    await grantAppContainerRead("C:\\Program Files\\Murage\\resources\\browser-engine\\chrome-win", "C:\\Windows", tool, () => saved(["chrome-win", PROGRAM_FILES]));
    expect(tool).toHaveBeenCalledOnce();
    const [file, args] = tool.mock.calls[0]!;
    expect(file.replaceAll("/", "\\")).toBe("C:\\Windows\\System32\\icacls.exe");
    expect(args[0]).toBe("C:\\Program Files\\Murage\\resources\\browser-engine\\chrome-win");
    expect(args.slice(1, 2)).toEqual(["/save"]);
    expect(args.slice(3)).toEqual(["/T", "/C", "/Q"]);
  });
  it("grants RX to the AppContainer when an entry lacks it, and fails plainly when the grant fails", async () => {
    const tool = run([true, true]);
    await grantAppContainerRead("C:\\b\\chrome-win", "C:\\Windows", tool, () => saved(["chrome-win", "D:PAI(A;;FA;;;SY)"]));
    expect(tool.mock.calls[1]![1]).toEqual(["C:\\b\\chrome-win", "/grant", `*${APP_CONTAINER_SID}:(OI)(CI)(RX)`, "/T", "/C", "/Q"]);
    await expect(grantAppContainerRead("C:\\b\\chrome-win", "C:\\Windows", run([false, false]), () => Buffer.from(""))).rejects.toThrow("could not be prepared");
  });
  it("a SystemRoot holding cmd or quote syntax is never used", async () => {
    const tool = run([true]);
    await grantAppContainerRead("C:\\b", 'C:\\W"x', tool, () => saved(["b", "D:P(A;;FA;;;AC)"]));
    expect(tool.mock.calls[0]![0].replaceAll("/", "\\")).toBe("C:\\Windows\\System32\\icacls.exe");
  });
  it("starts no PowerShell", () => {
    expect(readFileSync(new URL("./browser-sandbox.ts", import.meta.url), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n")).not.toMatch(/powershell|Get-Acl|EncodedCommand/i);
  });
});

const NO_USABLE_SANDBOX = "[1021/064134.452129:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.";
const SUID_MISCONFIGURED = "[1:1:FATAL:setuid_sandbox_host.cc(163)] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now.";
const RESTRICTED: Record<string, string> = { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1", "/proc/sys/kernel/unprivileged_userns_clone": "1", "/proc/sys/user/max_user_namespaces": "63000" };
const read = (values: Record<string, string>) => (file: string) => values[file] ?? null;

const directories: string[] = [];
afterEach(() => {
  clearLinuxSandboxChecks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) removeTempDirSync(directory);
});
function fakeChrome(script = "#!/bin/sh\nexit 0\n"): string {
  const directory = mkdtempSync(join(tmpdir(), "murage-sandbox-test-"));
  directories.push(directory);
  const file = join(directory, "chrome-headless-shell");
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}
const spec = (chrome: string, extra: Record<string, string> = {}): AgentBrowserSpec => ({ command: "/opt/agent-browser", args: ["mcp"], env: { AGENT_BROWSER_EXECUTABLE_PATH: chrome, ...extra } });
const message = (error: unknown) => (error as Error).message;

describe("Linux user namespace settings", () => {
  it("reads Ubuntu's AppArmor restriction and a kernel that turns namespaces off", () => {
    expect(linuxUserNamespaces(read(RESTRICTED))).toEqual({ off: false, restricted: true });
    expect(linuxUserNamespaces(read({}))).toEqual({ off: false, restricted: false });
    expect(linuxUserNamespaces(read({ "/proc/sys/kernel/unprivileged_userns_clone": "0" }))).toEqual({ off: true, restricted: false });
    expect(linuxUserNamespaces(read({ "/proc/sys/user/max_user_namespaces": "0" }))).toEqual({ off: true, restricted: false });
    expect(linuxUserNamespaces(read({ "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0" }))).toEqual({ off: false, restricted: false });
  });
});

describe("Chrome's own sandbox verdict", () => {
  it("is blocked only when Chrome says it has no usable sandbox", () => {
    expect(classifyChromeSandboxProbe({ failed: true, stderr: NO_USABLE_SANDBOX })).toBe("blocked");
    expect(classifyChromeSandboxProbe({ failed: true, stderr: SUID_MISCONFIGURED })).toBe("blocked");
    expect(classifyChromeSandboxProbe({ failed: false, stderr: "dbus/bus.cc:405] Failed to connect to the bus" })).toBe("available");
    // A missing library or a timeout is not a sandbox question.
    expect(classifyChromeSandboxProbe({ failed: true, stderr: "error while loading shared libraries: libXfixes.so.3" })).toBe("unknown");
  });
});

describe("the message a person sees", () => {
  const namespaces = { off: false, restricted: true };
  it("tells a .deb install how to load the rule it installed", () => {
    expect(linuxSandboxBlockedMessage({ chrome: linuxDebChromePath(), namespaces })).toBe("The bot browser can't start: Ubuntu hasn't loaded the AppArmor rule Murage installed for it. Restart your computer, or run: sudo apparmor_parser -r /etc/apparmor.d/murage");
  });
  it("tells an AppImage to install the .deb", () => {
    const text = linuxSandboxBlockedMessage({ chrome: "/tmp/.mount_MuragexYz12/resources/browser-engine/chrome/chrome-headless-shell-linux64/chrome-headless-shell", namespaces });
    expect(text).toContain("Install Murage from the .deb package to use the browser.");
    expect(text).toContain("Murage never runs the browser without its sandbox.");
  });
  it("tells a system with namespaces off what to ask for", () => {
    expect(linuxSandboxBlockedMessage({ chrome: linuxDebChromePath(), namespaces: { off: true, restricted: false } })).toContain("user namespaces turned off");
  });
  it("follows the copy rules", () => {
    for (const text of [linuxSandboxBlockedMessage({ chrome: linuxDebChromePath(), namespaces }), linuxSandboxBlockedMessage({ chrome: "/tmp/x", namespaces }), linuxSandboxBlockedMessage({ chrome: "/tmp/x", namespaces: { off: true, restricted: false } })]) {
      expect(text).not.toMatch(/\u2014|\bsafe|\bunsafe|\bsafety|--no-sandbox|500/iu);
    }
  });
});

describe.skipIf(process.platform !== "linux")("ensureLinuxChromeSandbox", () => {
  it("launches nothing where the kernel does not restrict namespaces", async () => {
    const run = vi.fn();
    await ensureLinuxChromeSandbox(spec(fakeChrome()), { read: read({}), run });
    expect(run).not.toHaveBeenCalled();
  });

  it("asks Chrome once and keeps a success", async () => {
    const run = vi.fn(async () => ({ failed: false, stderr: "" }));
    const chrome = fakeChrome();
    for (let pass = 0; pass < 3; pass += 1) await ensureLinuxChromeSandbox(spec(chrome), { read: read(RESTRICTED), run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(chrome);
  });

  it("refuses with a 503 the panel shows, logs once, and asks again after the recheck interval", async () => {
    let now = 1_000;
    const run = vi.fn(async () => ({ failed: true, stderr: NO_USABLE_SANDBOX }));
    const log = vi.fn();
    const chrome = fakeChrome();
    const attempt = () => ensureLinuxChromeSandbox(spec(chrome), { read: read(RESTRICTED), run, log, now: () => now }).then(() => null, (error: unknown) => error);
    const first = await attempt() as Error & { status?: number; code?: string };
    expect(first).toBeInstanceOf(Error);
    expect(first.status).toBe(503);
    expect(first.code).toBe("browser_sandbox_unavailable");
    expect(message(first)).toBe(linuxSandboxBlockedMessage({ chrome, namespaces: { off: false, restricted: true } }));
    now += LINUX_SANDBOX_RECHECK_MS - 1;
    expect(message(await attempt())).toBe(message(first));
    expect(run).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(`[browser] ${message(first)}`);
    // The profile was loaded meanwhile: the next ask after the interval succeeds.
    run.mockResolvedValue({ failed: false, stderr: "" });
    now += 1;
    expect(await attempt()).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not refuse for a failure that is not about the sandbox", async () => {
    const run = vi.fn(async () => ({ failed: true, stderr: "error while loading shared libraries" }));
    await expect(ensureLinuxChromeSandbox(spec(fakeChrome()), { read: read(RESTRICTED), run })).resolves.toBeUndefined();
  });

  it("starts no Chrome for the owner's own Chrome, a Cloud home, or no bundled Chrome", async () => {
    const run = vi.fn();
    await ensureLinuxChromeSandbox(spec(fakeChrome(), { AGENT_BROWSER_CDP: "ws://127.0.0.1:9222/devtools/browser/x" }), { read: read(RESTRICTED), run });
    await ensureLinuxChromeSandbox({ command: "/opt/agent-browser", args: [], env: {} }, { read: read(RESTRICTED), run });
    await ensureLinuxChromeSandbox(spec("/nonexistent/chrome-headless-shell"), { read: read(RESTRICTED), run });
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    await ensureLinuxChromeSandbox(spec(fakeChrome()), { read: read(RESTRICTED), run });
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the real bundled binary headless, in a throwaway profile, and never with --no-sandbox", async () => {
    const directory = mkdtempSync(join(tmpdir(), "murage-sandbox-args-"));
    directories.push(directory);
    const record = join(directory, "args");
    const chrome = fakeChrome(`#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\necho '${NO_USABLE_SANDBOX}' >&2\nkill -TRAP $$\n`);
    const error = await ensureLinuxChromeSandbox(spec(chrome), { read: read(RESTRICTED), log: () => {} }).then(() => null, (cause: unknown) => cause);
    expect((error as { code?: string }).code).toBe("browser_sandbox_unavailable");
    const args = readFileSync(record, "utf8").trim().split("\n");
    expect(args).toContain("--headless");
    expect(args).toContain("about:blank");
    // No switch that turns a sandbox off or swaps it (--no-sandbox, --disable-*-sandbox, --no-zygote-sandbox).
    expect(args.filter((arg) => !arg.startsWith("--user-data-dir=")).some((arg) => /sandbox|zygote/iu.test(arg))).toBe(false);
    const profile = args.find((arg) => arg.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
    expect(profile.startsWith(join(tmpdir(), "murage-sandbox-probe-"))).toBe(true);
    expect(existsSync(profile)).toBe(false);
  });

  it("is what the relay's ensureBrowserSandboxAccess runs on Linux", async () => {
    // A Chrome that does not exist is never launched, so this resolves on any host.
    await expect(ensureBrowserSandboxAccess(spec("/nonexistent/chrome-headless-shell"))).resolves.toBeUndefined();
    const source = readFileSync(new URL("./browser-sandbox.ts", import.meta.url), "utf8");
    expect(source).toContain('if (process.platform === "linux") return ensureLinuxChromeSandbox(spec);');
    expect(source).not.toMatch(/["'`]--no-sandbox/u);
  });
});
