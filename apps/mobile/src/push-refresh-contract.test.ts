// Source contracts for the foreground push refresh: the relay deletes devices
// idle for 30 days and opening the app does not count, so both platforms refresh
// the registration when the app comes to the front, at most once every 24 hours,
// through the existing PUT /v1/devices/self/token path.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)); // apps/mobile
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const droid = (f: string) => read(`android/app/src/main/java/com/murage/mobile/${f}`);
const ios = (f: string) => read(`ios/App/MurageShell/Sources/${f}`);

describe("foreground push refresh: iOS", () => {
  it("becameActive refreshes, and the scene calls becameActive", () => {
    expect(ios("MurageShell/PushServices.swift")).toMatch(/static func becameActive\(\) \{[\s\S]*?PushRegistrar\.shared\.refreshIfDue\(\)/);
    expect(read("ios/App/App/SceneDelegate.swift")).toMatch(/sceneDidBecomeActive[\s\S]*?PushSetup\.becameActive\(\)/);
  });
  it("the refresher runs enrolment.refresh, which reuses the token PUT and adds no endpoint", () => {
    expect(ios("MurageShell/PushRegistrar.swift")).toMatch(/PushRefresher\(store: DefaultsRefreshStore\(\)[\s\S]*?enrolment\.refresh\(\)/);
    const core = ios("MurageShellCore/PushEnrolment.swift");
    expect(core).toMatch(/func refresh\(\) async -> PushRefreshResult \{[\s\S]*?\.updateToken\(secret: secret, pushToken: token\)/);
    expect(ios("MurageShellCore/PushRefresh.swift")).toContain("24 * 3600");
  });
  it("never logs the token", () => {
    for (const f of ["MurageShell/PushRegistrar.swift", "MurageShellCore/PushRefresh.swift"]) {
      const lines = ios(f).split("\n").filter((l) => l.includes("ShellLog.") && /refresh/i.test(l));
      for (const l of lines) expect(l).not.toMatch(/token|secret/i);
    }
  });
});

describe("foreground push refresh: Android", () => {
  it("both activities refresh on resume", () => {
    expect(droid("WorkspaceActivity.java")).toMatch(/onResume\(\) \{[\s\S]*?PushRegistrar\.get\(this\)\.refreshIfDue\(\)/);
    expect(droid("MainActivity.java")).toMatch(/onResume\(\) \{[\s\S]*?PushRegistrar\.get\(this\)\.refreshIfDue\(\)/);
  });
  it("the registrar queues it off the main thread through PushEnrolment.refreshIfDue", () => {
    expect(droid("PushRegistrar.java")).toMatch(/void refreshIfDue\(\) \{[\s\S]*?io\.execute\(\(\) -> enrolment\(\)\.refreshIfDue\(/);
  });
  it("PushEnrolment reuses the token PUT, and the policy is daily", () => {
    expect(droid("PushEnrolment.java")).toMatch(/void refreshIfDue\([\s\S]*?"PUT", "\/v1\/devices\/self\/token"/);
    expect(droid("shell/PushRefreshPolicy.java")).toContain("DAY_MS = 24L * 3_600_000L");
  });
  it("never logs the token", () => {
    const lines = [...droid("PushEnrolment.java").split("\n"), ...droid("PushRegistrar.java").split("\n")].filter((l) => l.includes("ShellLog.i(") && /refresh/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toMatch(/pushToken|secret|fcmToken/i);
  });
});
