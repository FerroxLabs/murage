import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { agentBrowserIntegration, browserHostRequiresSandboxBypass } from "./browser-engine.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const dirs: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", platform); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
it.each(["docker", "kubepods", "lxc"])("refuses the pinned browser's %s cgroup signal without marker files", name => {
  expect(browserHostRequiresSandboxBypass({ platform: "linux", uid: 1000, markerPresent: false, cgroup: `0::/system.slice/${name}/fixture` })).toBe(true);
});
it("keeps root and marker refusal and admits an ordinary VM", () => {
  const host = { platform: "linux" as const, uid: 1000, markerPresent: false, cgroup: "0::/init.scope" };
  expect(browserHostRequiresSandboxBypass(host)).toBe(false);
  expect(browserHostRequiresSandboxBypass({ ...host, uid: 0 })).toBe(true);
  expect(browserHostRequiresSandboxBypass({ ...host, markerPresent: true })).toBe(true);
});
it("never forwards CI to the browser child", () => {
  // Environment assembly is platform-independent. Use a supported non-container
  // platform in this unit fixture; the separate host cases retain Linux refusal.
  // A real Windows host keeps win32 (the owner-only mode check does not apply there); spoofing darwin on Windows would demand POSIX modes.
  Object.defineProperty(process, "platform", { ...platform, value: platform.value === "win32" ? "win32" : "darwin" });
  const dataDir = mkdtempSync(join(tmpdir(), "cloud-browser-")); dirs.push(dataDir);
  const spec = agentBrowserIntegration({ binaryPath: "/fixture/browser", session: "fixture", encryptionKey: "a".repeat(64), realmId: "fixture", dataDir, env: { CI: "1", PATH: "/usr/bin", AGENT_BROWSER_NO_SANDBOX: "1" } });
  expect(spec.env).not.toHaveProperty("CI");
  expect(spec.env).not.toHaveProperty("AGENT_BROWSER_NO_SANDBOX");
  expect(spec.args).not.toContain("--no-sandbox");
  removeTempDirSync(spec.env.AGENT_BROWSER_SOCKET_DIR);
});
