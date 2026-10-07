import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(root + path, "utf8");
const plist = (path: string) => JSON.parse(execFileSync("python3", ["-c", "import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1], 'rb'))))", root + path], { encoding: "utf8" }));

const appData = ["DeviceID", "AudioData", "EmailsOrTextMessages", "PhotosorVideos", "OtherUserContent"];
const extensionData = ["DeviceID", "OtherUserContent"];

describe("SEC-010: shipped privacy declarations", () => {
  it.each(["App", "NotificationService"])("parses %s's manifest and pins its API reasons and data draft", (target) => {
    const manifest = plist(`ios/App/${target}/PrivacyInfo.xcprivacy`);
    expect(manifest.NSPrivacyTracking).toBe(false);
    expect(manifest.NSPrivacyTrackingDomains).toEqual([]);
    expect(manifest.NSPrivacyAccessedAPITypes).toEqual(target === "App" ? [
      { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults", NSPrivacyAccessedAPITypeReasons: ["CA92.1"] },
      { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp", NSPrivacyAccessedAPITypeReasons: ["C617.1"] },
      { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime", NSPrivacyAccessedAPITypeReasons: ["35F9.1"] },
    ] : []);
    expect(manifest.NSPrivacyCollectedDataTypes).toEqual((target === "App" ? appData : extensionData).map((type) => ({
      NSPrivacyCollectedDataType: `NSPrivacyCollectedDataType${type}`,
      NSPrivacyCollectedDataTypeLinked: true,
      NSPrivacyCollectedDataTypeTracking: false,
      NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
    })));
  });

  it("resolves each target's resource phase through its own group, file reference and build file", () => {
    const project = read("ios/App/App.xcodeproj/project.pbxproj");
    const objects = new Map([...project.matchAll(/^\t\t([A-F0-9]{24})(?: \/\*[^\n]*?\*\/)? = \{([\s\S]*?)\n?\s*\};/gm)].map((m) => [m[1]!, m[2]!]));
    const refs = (body: string) => body.match(/\b[A-F0-9]{24}\b/g) ?? [];
    const manifests: string[] = [];
    for (const target of ["App", "NotificationService"]) {
      const group = [...objects.values()].find((v) => v.includes("isa = PBXGroup;") && v.includes(`path = ${target};`))!;
      const reference = refs(group).find((id) => objects.get(id)?.includes("path = PrivacyInfo.xcprivacy;"));
      expect(reference).toBeDefined();
      manifests.push(reference!);
      const native = [...objects.values()].find((v) => v.includes("isa = PBXNativeTarget;") && v.includes(`name = ${target};`))!;
      const resources = refs(native).map((id) => objects.get(id) ?? "").find((v) => v.includes("isa = PBXResourcesBuildPhase;"))!;
      const files = refs(resources).map((id) => objects.get(id) ?? "");
      expect(files.filter((v) => v.includes(`fileRef = ${reference}`))).toHaveLength(1);
      expect(files.filter((v) => v.includes("PrivacyInfo.xcprivacy"))).toHaveLength(1);
    }
    expect(new Set(manifests).size).toBe(2);
  });
});

describe("SEC-008: workspace snapshots", () => {
  it("covers the iOS scene at resign-active and removes its opaque cover at activation", () => {
    const scene = read("ios/App/App/SceneDelegate.swift");
    const cover = scene.match(/func sceneWillResignActive[\s\S]*?\n    \}/)?.[0] ?? "";
    expect(cover).toContain("coverWindow.addSubview(cover)");
    expect(cover).toContain("cover.backgroundColor = ShellColors.canvas");
    expect(cover).toContain("cover.isOpaque = true");
    expect(cover).toContain("cover.frame = coverWindow.bounds");
    expect(cover).toContain("[.flexibleWidth, .flexibleHeight]");
    expect(scene).toMatch(/func sceneDidBecomeActive[\s\S]*?coverWindow\?\.isHidden = true[\s\S]*?coverWindow = nil/);
  });
  it("Android 13+ hides only the recents thumbnail, so screenshots still work", () => {
    const activity = read("android/app/src/main/java/com/murage/mobile/WorkspaceActivity.java");
    const create = activity.slice(activity.indexOf("void onCreate("));
    const call = create.indexOf("setRecentsScreenshotEnabled(false)");
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(create.indexOf("new WebView("));
    expect(activity).toMatch(/Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.TIRAMISU[\s\S]{0,200}setRecentsScreenshotEnabled\(false\)/);
  });
  it("Android 10-12 keeps FLAG_SECURE on the workspace window only, set before its content", () => {
    const activity = read("android/app/src/main/java/com/murage/mobile/WorkspaceActivity.java");
    const flag = activity.indexOf("getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE)");
    expect(flag).toBeGreaterThan(activity.indexOf("void onCreate("));
    expect(flag).toBeLessThan(activity.indexOf("new WebView("));
    expect(activity.slice(flag - 200, flag)).toMatch(/else|< Build\.VERSION_CODES\.TIRAMISU|SDK_INT < /);
    expect(activity).not.toMatch(/clearFlags\([^)]*FLAG_SECURE/);
    expect(read("android/app/src/main/java/com/murage/mobile/MainActivity.java")).not.toContain("FLAG_SECURE");
  });
});

describe("UX-001: native loading progress", () => {
  it("iOS shows progress immediately and exposes retry once after eight seconds without resetting at finish", () => {
    const overlay = read("ios/App/MurageShell/Sources/MurageShell/LoadingOverlay.swift");
    expect(overlay).toContain('"Connecting to your computer…"');
    expect(overlay).toContain('"Still connecting…"');
    expect(overlay).not.toContain("panel.isHidden = true");
    expect(overlay).not.toContain('"Show it anyway"');
    const vc = read("ios/App/MurageShell/Sources/MurageShell/WorkspaceViewController.swift");
    expect(vc).toContain("8 - Date().timeIntervalSince(progressStarted)");
    expect(vc).toContain("!slowShown");
    expect(vc).toContain("self.slowShown = true");
    expect(vc).toMatch(/viewDidLoad\(\)[\s\S]*?beginProgress\(\)[\s\S]*?probeBeforeLoading\(path: startPath\)/);
    expect(vc).toContain("repeats: false");
  });
  it("Android shows progress immediately and exposes retry once after eight seconds without resetting at finish", () => {
    const overlay = read("android/app/src/main/java/com/murage/mobile/LoadingOverlay.java");
    expect(overlay).toContain("R.string.connecting");
    expect(overlay).not.toContain("panel.setVisibility(GONE)");
    expect(overlay).not.toContain("R.string.show_anyway");
    const activity = read("android/app/src/main/java/com/murage/mobile/WorkspaceActivity.java");
    expect(activity).toContain("READY_DEADLINE_MS = 8_000");
    expect(activity).toContain("READY_DEADLINE_MS - (SystemClock.elapsedRealtime() - progressStarted)");
    expect(activity).toContain("slowShown = true");
    expect(activity).toMatch(/onCreate\([\s\S]*?beginProgress\(\)[\s\S]*?probeBeforeLoading\(path\)/);
    const strings = read("android/app/src/main/res/values/strings.xml");
    expect(strings).toContain('name="connecting">Connecting to your computer…');
    expect(strings).toContain('name="slow_title">Still connecting…');
  });
});

describe("RES-008: iPhone call guidance", () => {
  it("announces foreground-only calling once at session start through the native shell", () => {
    const vc = read("ios/App/MurageShell/Sources/MurageShell/WorkspaceViewController.swift");
    const start = vc.slice(vc.indexOf("case .callSessionOpen:"), vc.indexOf("case .callSessionClose:"));
    expect(start).toContain("if !callSessionOpen");
    expect(start).toContain('Toast.show("Keep Murage open during your call. On iPhone, the call pauses when you leave the app or lock your phone.", in: view)');
    expect(start.indexOf("Toast.show")).toBeLessThan(start.indexOf("callSessionOpen = true"));
  });
});

describe("review minors: gate and cover wiring", () => {
  const A = "android/app/src/main/java/com/murage/mobile/";
  it("M1: Android trusts the gate only through an explicit extra that finishOpen sets", () => {
    const activity = read(A + "WorkspaceActivity.java");
    expect(activity).toContain('static final String EXTRA_HOST_OK = "murage.hostOk";');
    expect(activity).toContain("hostCapabilityChecked = state == null && getIntent().getBooleanExtra(EXTRA_HOST_OK, false);");
    expect(activity).not.toContain('hostCapabilityChecked = "full".equals(mode)');
    const shell = read(A + "Shell.java");
    expect(shell).toContain("startWorkspace(from, origin, credential, verdict.mode(), true, verdict.approvalProofOk())");
    expect(shell).toMatch(/String startWorkspace\(Activity from, WorkspaceOrigin origin, String credential, String mode\) \{\s*return startWorkspace\(from, origin, credential, mode, false, false\);/);
  });
  it("M3: the iOS cover sits in its own window above any presentation", () => {
    const scene = read("ios/App/App/SceneDelegate.swift");
    expect(scene).toContain("UIWindow(windowScene:");
    expect(scene).toContain("windowLevel = .alert + 1");
    expect(scene).toContain("cover.backgroundColor = ShellColors.canvas");
    expect(scene).toMatch(/func sceneDidBecomeActive[\s\S]*?coverWindow\?\.isHidden = true[\s\S]*?coverWindow = nil/);
  });
  it("M5: iOS probe-first retries load the saved route, as Android does, and the basic branch is explained", () => {
    const vc = read("ios/App/MurageShell/Sources/MurageShell/WorkspaceViewController.swift");
    expect(vc).toContain("private func probeBeforeLoading(path: String)");
    expect(vc).toContain("probeBeforeLoading(path: routes.startPath(for: origin))");
    expect(vc).toContain("probeBeforeLoading(path: startPath)");
    expect(vc).toContain("only a lowered gate reaches basic");
    expect(read(A + "WorkspaceActivity.java")).toContain("only a lowered gate reaches basic");
  });
  it("M8: iOS records the desktop's name only after the capability check", () => {
    const coordinator = read("ios/App/MurageShell/Sources/MurageShell/ShellCoordinator.swift");
    const gate = coordinator.indexOf("guard verdict.hostCapabilityOk else { return .success(verdict) }");
    const record = coordinator.indexOf("names[origin] = name");
    expect(gate).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(gate);
  });
});
