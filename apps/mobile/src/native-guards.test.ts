// Invariants of the native projects that no compiler checks, read from the
// source the way Plan 1 pins React wiring (src/lib/install-prompt.test.ts).
// Each block names the task that owns the code and the finding it holds.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)); // apps/mobile
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      if (["node_modules", "build", ".gradle", ".build", "DerivedData", "public"].includes(name)) continue;
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(ROOT, full));
    }
  };
  walk(join(ROOT, dir));
  return out;
}

describe("P1: only the kept parts of the Codex scaffold came across", () => {
  it("has both native projects and the icons", () => {
    expect(existsSync(join(ROOT, "android/app/src/main/AndroidManifest.xml"))).toBe(true);
    expect(existsSync(join(ROOT, "ios/App/App.xcodeproj/project.pbxproj"))).toBe(true);
    expect(existsSync(join(ROOT, "ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json"))).toBe(true);
    expect(existsSync(join(ROOT, "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"))).toBe(true);
  });

  it("dropped the native transport, the second UI and the Codex notification code (spec §10)", () => {
    const native = [...files("android"), ...files("ios")];
    // MurageMessagingService is no longer on this list: Plan 3b A1 adds it back
    // deliberately, as the FCM service the manifest declares, not the dropped Codex one.
    const dropped =
      /MurageTransport|TransportPolicy|IncrementalSSE|SecureProfiles|NotificationAccount|NotificationVault|NotificationSyncPolicy|MurageNotifications|MediaFiles|DocumentFiles|LaunchReadiness|DocumentUITests|MediaPolicyTests/;
    expect(native.filter((path) => dropped.test(path))).toEqual([]);
    expect(existsSync(join(ROOT, "src/App.tsx"))).toBe(false);
    expect(existsSync(join(ROOT, "demo"))).toBe(false);
  });

  it("keeps the app id", () => {
    expect(read("capacitor.config.ts")).toContain('appId: "com.murage.mobile"');
  });
});

describe("P2: the iOS app target builds only the shell", () => {
  it("links the MurageShell package and nothing from the Codex transport or notifications", () => {
    const project = read("ios/App/App.xcodeproj/project.pbxproj");
    expect(project).toContain("relativePath = MurageShell;");
    expect(project).toContain("productName = MurageShell;");
    expect(project).toContain("ShellPlugin.swift");
    expect(project).not.toMatch(
      /TransportPolicy|MurageTransport|SecureProfiles|NotificationAccount|MurageNotifications|NotificationSyncPolicy|AppearanceMode|MurageAppearance/,
    );
  });

  it("targets iOS 17, where WKDownload, isInspectable and callAsyncJavaScript all exist", () => {
    const targets = read("ios/App/App.xcodeproj/project.pbxproj").match(/IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;/g) ?? [];
    expect(targets.length).toBe(6); // project, app and (Plan 3b I1) the notification extension, Debug and Release each
    expect(targets.every((line) => line.includes("17.0"))).toBe(true);
  });

  it("the app delegate only hands push to PushSetup (Plan 3b I4)", () => {
    const delegate = read("ios/App/App/AppDelegate.swift");
    expect(delegate).toContain("PushSetup.launch()");
    expect(delegate).toContain("PushSetup.didRegister(deviceToken: deviceToken)");
    expect(delegate).not.toMatch(/UNUserNotificationCenter|requestAuthorization/);
  });
});

describe("P3: the Android manifest", () => {
  const manifest = () => read("android/app/src/main/AndroidManifest.xml");

  it("launches with launchMode standard, never singleTask (Phase 0 surprise 2)", () => {
    const launcher = manifest().match(/<activity[^>]*android:name="\.MainActivity"[^>]*>/)?.[0] ?? "";
    expect(launcher).toContain('android:launchMode="standard"');
  });

  // Plan 3b A1 (below) now owns the Firebase service and POST_NOTIFICATIONS: the
  // "not yet" guard that used to live here is superseded by that describe block.

  it("never allows cleartext", () => {
    expect(manifest()).toContain('android:usesCleartextTraffic="false"');
  });

  it("builds on the build host only", () => {
    const script = read("scripts/android-remote.sh");
    expect(script).toContain("ssh \"$HOST\"");
    expect(script).toContain("ghcr.io/cirruslabs/android-sdk:35");
    expect(script).not.toMatch(/^\s*\.\/gradlew/m); // gradle only ever runs inside the remote docker command
  });
});

describe("P14: iOS storage and the probe", () => {
  const shell = (name: string) => read(`ios/App/MurageShell/Sources/MurageShell/${name}`);

  it("keeps installId and the saved computers on this device only, readable after first unlock", () => {
    expect(shell("KeychainItem.swift")).toContain("kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly");
    expect(shell("ShellStores.swift")).toContain('service: "com.murage.mobile.install"');
  });

  it("clears the saved computers after a reinstall but never the install id (Decision 7)", () => {
    const stores = shell("ShellStores.swift");
    expect(stores).toContain("murage-install-v1");
    expect(stores).toContain("isExcludedFromBackup = true");
    const identity = stores.slice(stores.indexOf("enum InstallIdentity"));
    expect(identity).not.toContain("delete()");
  });

  it("probes with no cookies and no cache", () => {
    const probe = shell("ProbeClient.swift");
    expect(probe).toContain("URLSessionConfiguration.ephemeral");
    expect(probe).toContain("httpShouldSetCookies = false");
    expect(probe).toContain('"/healthz"');
  });

  it("never follows a redirect: a 3xx is classified as a status (basic)", () => {
    const probe = shell("ProbeClient.swift");
    expect(probe).toContain("willPerformHTTPRedirection");
    expect(probe).toContain("completionHandler(nil)");
  });

  it("tells an unreadable Keychain from an empty one", () => {
    expect(shell("KeychainItem.swift")).toContain("errSecItemNotFound");
    const stores = shell("ShellStores.swift");
    expect(stores).toContain("func load() -> WorkspaceBook?");
    expect(stores).toContain("static func value() -> String?");
  });

  it("logs only public, content-free strings", () => {
    expect(shell("ShellLog.swift")).toContain('subsystem: "com.murage.mobile", category: "shell"');
  });
});

describe("P18: Android storage, backup and the probe", () => {
  const java = (name: string) => read(`android/app/src/main/java/com/murage/mobile/${name}`);

  it("backs up exactly one file, the install id (spec §3.3 Device records)", () => {
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain('android:allowBackup="true"');
    expect(manifest).toContain('android:fullBackupContent="@xml/backup_rules"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    const included = (xml: string) => [...xml.matchAll(/<include [^>]*path="([^"]+)"/g)].map((m) => m[1]);
    const legacy = read("android/app/src/main/res/xml/backup_rules.xml");
    expect(included(legacy)).toEqual(["murage_install.xml"]);
    expect(legacy).toMatch(/<include [^>]*path="murage_install\.xml"[^>]*requireFlags="clientSideEncryption"/);
    const rules = read("android/app/src/main/res/xml/data_extraction_rules.xml");
    const cloud = rules.slice(rules.indexOf("<cloud-backup"), rules.indexOf("</cloud-backup>"));
    expect(included(cloud)).toEqual(["murage_install.xml"]);
  });

  it("sends nothing to a new phone by device-to-device transfer (review ruling)", () => {
    const rules = read("android/app/src/main/res/xml/data_extraction_rules.xml");
    const transfer = rules.slice(rules.indexOf("<device-transfer"), rules.indexOf("</device-transfer>"));
    expect(transfer).not.toContain("<include");
    const domains = ["root", "file", "database", "sharedpref", "external", "device_root", "device_file", "device_database", "device_sharedpref"];
    for (const domain of domains) expect(transfer).toContain(`<exclude domain="${domain}" path="." />`);
  });

  it("probes with no cookie handler: Capacitor's CapacitorCookies installs one over the WebView jar", () => {
    const main = java("MainActivity.java");
    expect(main).toMatch(/super\.onCreate\([^)]*\);[\s\S]{0,300}CookieHandler\.setDefault\(null\)/);
    expect(java("ProbeClient.java")).toMatch(/CookieHandler\.getDefault\(\) != null[\s\S]{0,200}CookieHandler\.setDefault\(null\)/);
  });

  it("tells an unreadable book from an empty one and never mints a key to read", () => {
    const store = java("SecureStore.java");
    expect(store).toContain("enum State { EMPTY, OK, UNREADABLE }");
    const read = store.slice(store.indexOf("Read read()"), store.indexOf("boolean write("));
    expect(read).not.toContain("create()");
  });

  it("seals the saved computers with a Keystore key", () => {
    expect(java("SecureStore.java")).toContain('KeyStore.getInstance("AndroidKeyStore")');
    expect(java("SecureStore.java")).toContain('"AES/GCM/NoPadding"');
    expect(java("InstallId.java")).toContain('"murage_install"');
  });

  it("probes /healthz with no cookies and no cache, off the UI thread", () => {
    const probe = java("ProbeClient.java");
    expect(probe).toContain('"/healthz"');
    expect(probe).toContain("setUseCaches(false)");
    expect(probe).toContain("@WorkerThread");
  });

  it("caps the /healthz body it reads and logs under MurageShell", () => {
    expect(java("ProbeClient.java")).toContain("MAX_BODY = 4096");
    expect(java("ShellLog.java")).toContain('TAG = "MurageShell"');
  });
});

describe("P15: the iOS workspace screen", () => {
  const vc = () => read("ios/App/MurageShell/Sources/MurageShell/WorkspaceViewController.swift");

  it("injects the wrapper into the main frame only and listens in the page world", () => {
    expect(vc()).toContain("injectionTime: .atDocumentStart, forMainFrameOnly: true");
    expect(vc()).toContain("contentWorld: .page, name: ChannelScript.iosHandlerName");
  });

  it("checks every message natively and answers a dropped one (Phase 0: no hanging promise)", () => {
    expect(vc()).toContain("ChannelGate.admit(isMainFrame: message.frameInfo.isMainFrame");
    expect(vc()).toContain("replyHandler(nil, ChannelError.unavailable.rawValue)");
  });

  it("lets the web UI own the safe area (Decision 1)", () => {
    expect(vc()).toContain("contentInsetAdjustmentBehavior = .never");
  });

  it("classifies provisional failures, so a download is never can't-reach (surprise 3)", () => {
    expect(vc()).toMatch(/didFailProvisionalNavigation[\s\S]*?failed\(error\)/);
    expect(vc()).toContain("NavigationFailure.classify(domain:");
  });

  it("closes on a 401 or gateway-error document and reloads the route when the web process dies", () => {
    expect(vc()).toContain("if let reason = MainDocument.closeReason(status: http.statusCode) { decisionHandler(.cancel); close(reason); return }");
    // Budget wide enough for callSessionOpen's own reset in between
    // (callbar-rereview2.md G4) without pinning the exact body.
    expect(vc()).toMatch(/webViewWebContentProcessDidTerminate[\s\S]{0,320}reloadRoute\(\)/);
  });

  it("is inspectable in debug builds only", () => {
    expect(vc()).toMatch(/#if DEBUG\s+webView\.isInspectable = true\s+#endif/);
  });

  it("arms the readiness deadline on every load and after an ignored failure, so the splash never stays up (P10 carry)", () => {
    const source = vc();
    expect(source).toMatch(/private func load\(path: String\) \{[\s\S]*?armDeadline\(\)[\s\S]*?\n {4}\}/);
    expect(source).toMatch(/case \.ignore: armDeadline\(\)/);
  });

  it("sends a navigation off the origin only through the openExternal rule", () => {
    const source = vc();
    expect(source).toContain("ChannelArgs.externalURL([\"url\": url.absoluteString])");
    // One door out of the app: every system-browser open goes through the rule.
    expect(source.match(/UIApplication\.shared\.open\(/g)).toHaveLength(1);
  });

  it("keeps the workspace session in a store Capacitor's bridge never touches", () => {
    // CAPBridgeViewController mirrors every cookie of WKWebsiteDataStore.default()
    // into HTTPCookieStorage.shared, and CapacitorCookies can clear it.
    expect(vc()).toContain("WKWebsiteDataStore(forIdentifier: WorkspaceDataStore.identifier)");
    expect(vc()).not.toContain("websiteDataStore = .default()");
    const config = read("capacitor.config.ts");
    expect(config).toContain("CapacitorCookies: { enabled: false }");
    expect(config).toContain("CapacitorHttp: { enabled: false }");
  });

  it("leaves the notification delegate to PushResponder (Capacitor would take it when the launcher loads)", () => {
    expect(read("capacitor.config.ts")).toMatch(/ios: \{[^}]*handleApplicationNotifications: false[^}]*\}/);
  });

  it("stops reloading after a second web-content crash within a minute (P15 review)", () => {
    const crash = vc().slice(vc().indexOf("func mayReloadAfterCrash"));
    // Budget wide enough for callSessionOpen's own reset in between
    // (callbar-rereview2.md G4) without pinning the exact body.
    expect(vc()).toMatch(/webViewWebContentProcessDidTerminate[\s\S]{0,200}guard mayReloadAfterCrash\(\) else \{ return \}/);
    expect(crash).toMatch(/timeIntervalSince\(\$0\) < 60/);
    expect(crash).toMatch(/guard crashes\.count < 2 else \{[\s\S]*?overlay\.showSlow\(\)[\s\S]*?return\s*\}/);
  });

  it("keeps foreign blob: and every data: page out of the main frame (P15 review; the rule is NavigationPolicy now)", () => {
    const source = vc();
    expect(source).not.toContain('["about", "blob", "data"]');
    expect(source).not.toMatch(/scheme == "(about|blob|data|https?)"/);
  });

  it("always arms the deadline, never after closing, and coalesces early notifications (P15 review)", () => {
    const source = vc();
    expect(source).toContain("let url = origin.url(path: path) ?? origin.url");
    expect(source).toContain("guard splashUp, !isReady, !closing, !slowShown else { return }");
    // reloadOrKeepPending (not a bare reloadRoute) since callbar-review.md
    // M4 / callbar-rereview2.md G3: a live call holds this reload too.
    expect(source).toContain("if splashUp { queuedOpen = open } else { reloadOrKeepPending() }");
  });

  it("shows native panels only for the workspace page itself (P15 review)", () => {
    const source = vc();
    expect(source).toContain("guard fromPage(frame) else { completionHandler(); return }");
    expect(source).toContain("guard fromPage(frame) else { completionHandler(false); return }");
    expect(source).toContain("guard fromPage(frame) else { completionHandler(nil); return }");
  });

  it("logs through typed, content-free calls only", () => {
    expect(vc()).not.toMatch(/ShellLog\.info\(|\bprint\(|NSLog\(/);
    expect(vc()).not.toMatch(/url\.path\)|\.fragment/);
  });
});

describe("P16: iOS saving", () => {
  const saves = () => read("ios/App/MurageShell/Sources/MurageShell/SaveController.swift");

  it("downloads a server file with the WebView's own cookies, never across the channel", () => {
    expect(saves()).toContain("webView.startDownload(using: URLRequest(url: url))");
  });

  it("refuses to save an error page as the user's file (Plan 1 note 5)", () => {
    expect(saves()).toMatch(/DownloadGate\.accept\(status:[\s\S]{0,200}completionHandler\(nil\)/);
  });

  it("assembles chunks with the tested core and hands the result to the share sheet", () => {
    expect(saves()).toContain("ChunkAssembler(sink: FileSink())");
    expect(saves()).toContain("UIActivityViewController(activityItems: [file]");
  });

  it("left no stub behind in the workspace screen", () => {
    expect(read("ios/App/MurageShell/Sources/MurageShell/WorkspaceViewController.swift")).not.toContain("final class SaveController");
  });
});

describe("P16 fixes: iOS saves stay on the origin and clean up safely", () => {
  const saves = () => read("ios/App/MurageShell/Sources/MurageShell/SaveController.swift");
  const vc = () => read("ios/App/MurageShell/Sources/MurageShell/WorkspaceViewController.swift");

  it("never follows a download redirect off the workspace origin", () => {
    expect(saves()).toMatch(/willPerformHTTPRedirection[\s\S]{0,300}origin\.contains\(url\)[\s\S]{0,200}decisionHandler\(\.cancel\)/);
  });

  it("refuses an HTTP download whose response came from another origin", () => {
    expect(saves()).toMatch(/as\? HTTPURLResponse \{[\s\S]{0,200}origin\.contains\(url\)[\s\S]{0,200}\.foreignURL\)[\s\S]{0,60}completionHandler\(nil\)/);
  });

  it("lets a share extension finish before the file goes, and prunes only stale leftovers", () => {
    expect(saves()).toMatch(/completionWithItemsHandler[\s\S]{0,120}asyncAfter/);
    expect(saves()).toMatch(/static func freshDirectory\(\) throws -> URL \{\s*prune\(\)/);
  });

  it("sweeps at screen load and cancels every save when the screen closes", () => {
    expect(vc()).toMatch(/viewDidLoad\(\) \{[\s\S]{0,200}SaveController\.sweepLeftovers\(\)/);
    expect(vc()).toMatch(/closing = true[\s\S]{0,200}saves\.cancelAll\(\)/);
    expect(saves()).toMatch(/!isClosing\(\)[\s\S]{0,120}done\(\.unavailable\)/);
  });

  it("logs through typed, content-free calls only", () => {
    expect(saves()).not.toMatch(/ShellLog\.info\(|\bprint\(|NSLog\(/);
  });
});

describe("P17: iOS coordinator, plugin and hooks", () => {
  const shell = (name: string) => read(`ios/App/MurageShell/Sources/MurageShell/${name}`);

  it("sends installId only to a door that answered mobile: 1 (Review Focus 5)", () => {
    expect(shell("ShellCoordinator.swift")).toContain("installId: verdict?.isFull == true ? installId : nil");
  });

  it("auto-opens through the tested launch rule, once", () => {
    expect(shell("ShellCoordinator.swift")).toContain("LaunchPolicy.autoOpen(book:");
  });

  it("exposes exactly the launcher's five methods and the close event", () => {
    const plugin = read("ios/App/App/ShellPlugin.swift");
    expect(plugin).toContain('["state", "scan", "open", "remove", "openTailscale"]');
    expect(plugin).toContain('notifyListeners("workspaceClosed"');
    expect(plugin).toContain('jsName = "MurageShell"');
  });

  it("compiles the E2E hooks into debug builds only, with no arbitrary script", () => {
    const probe = shell("E2EProbe.swift");
    expect(probe.trimStart().startsWith("#if DEBUG && os(iOS)")).toBe(true);
    expect(shell("ShellCoordinator.swift")).toMatch(/#if DEBUG\s+\/\/\/[^\n]*\n\s+public func applyDebugArguments/);
    expect(read("ios/App/App/SceneDelegate.swift")).toMatch(/#if DEBUG\s+ShellCoordinator\.shared\.applyDebugArguments/);
    expect(`${probe}${shell("ShellCoordinator.swift")}`).not.toMatch(/evaluateJavaScript\(|Spike/);
  });

  // Spike code lives in its own debug-only files; the coordinator only asks,
  // from inside #if DEBUG, whether a debug screen was shown.
  it("keeps the debug launch screens in debug-only files", () => {
    for (const name of ["DebugLaunch.swift", "CallAudioSpike.swift", "CallAudioSelfTest.swift"]) {
      const file = shell(name).trim();
      expect(file.startsWith("#if DEBUG && os(iOS)"), name).toBe(true);
      expect(file.endsWith("#endif"), name).toBe(true);
      expect(file.match(/^#if /gm), name).toHaveLength(1);
    }
    expect(shell("DebugLaunch.swift")).toContain("CallAudioSpikeViewController(");
    expect(shell("ShellCoordinator.swift")).toMatch(/#if DEBUG\s+if !autoOpened, let launcher, presentDebugScreen\(on: launcher\) \{ return \}\s+#endif/);
  });

  it("handles the Switch computer shortcut on cold and warm launches", () => {
    const scene = read("ios/App/App/SceneDelegate.swift");
    expect(scene).toContain("connectionOptions.shortcutItem?.type == ShellCoordinator.switchShortcut");
    expect(scene).toContain("performActionFor shortcutItem");
  });

  // R4 and the P15 carry: the session lives in the workspace's own store.
  it("signs out of the workspace's own store, cookies and HTTP cache, never the default one", () => {
    const coordinator = shell("ShellCoordinator.swift");
    expect(coordinator).toContain("WKWebsiteDataStore(forIdentifier: WorkspaceDataStore.identifier)");
    expect(coordinator).toContain("WKWebsiteDataTypeDiskCache");
    expect(coordinator).toContain("httpCookieStore");
    expect(coordinator).not.toContain(".default()");
  });

  // P14 carry: an unreadable Keychain is never an empty list, and no pairing without an install id.
  it("refuses, rather than empties, when the saved computers or the install id cannot be read", () => {
    const coordinator = shell("ShellCoordinator.swift");
    expect(coordinator).toContain("guard books.load() != nil else { return .failure(.unreadable) }");
    expect(coordinator).toContain("guard let id = currentInstallId() else { return .failure(.unreadable) }");
    expect(coordinator).not.toContain("lazy var installId");
    expect(read("ios/App/App/ShellPlugin.swift")).toContain('call.reject("unreadable", "unreadable")');
  });

  it("answers only the bundled launcher page, and every call", () => {
    const plugin = read("ios/App/App/ShellPlugin.swift");
    expect(plugin).toContain("guard fromLauncher(call) else { return }");
    for (const method of ["state", "scan", "open", "remove", "openTailscale"]) {
      const body = plugin.split(`@objc func ${method}(`)[1]?.split("@objc func")[0] ?? "";
      expect(body, method).toContain("guard fromLauncher(call) else { return }");
    }
  });

  // P17 fix round 1: one open at a time, a replaced workspace closes properly, remove trims like open.
  it("answers a second open while one is in flight, and closes a replaced workspace properly", () => {
    const coordinator = shell("ShellCoordinator.swift");
    const open = coordinator.split("public func open(originString:")[1] ?? "";
    expect(open.indexOf("guard !opening else { return .failure(.busy) }")).toBeGreaterThan(-1);
    expect(open.indexOf("guard !opening else { return .failure(.busy) }")).toBeLessThan(open.indexOf("await ProbeClient.probe"));
    expect(open).toContain("defer { opening = false }");
    expect(coordinator).toContain("if let old = current { old.onClose = nil; old.closeFromShell(.launcher) }");
    expect(coordinator).toContain("installId: verdict?.isFull == true ? installId : nil,");
  });

  it("trims a removed origin the same way as an opened one", () => {
    const coordinator = shell("ShellCoordinator.swift");
    const trim = "WorkspaceOrigin.trimInput(originString)"; // final review M4: the shared rule
    expect(coordinator.split("public func open(originString:")[1]).toContain(trim);
    expect(coordinator.split("public func remove(originString:")[1]?.split("public func")[0]).toContain(trim);
  });

  it("has no Main storyboard left in the project", () => {
    expect(existsSync(join(ROOT, "ios/App/App/Base.lproj/Main.storyboard"))).toBe(false);
    expect(read("ios/App/App.xcodeproj/project.pbxproj")).not.toContain("Main.storyboard");
  });

  it("hands the launcher only a pairing link the core parses", () => {
    expect(shell("QRScannerViewController.swift")).toContain("PairingLink.parse(value) != nil");
  });

  it("builds the window in code, with no Main storyboard", () => {
    const plist = read("ios/App/App/Info.plist");
    expect(plist).not.toContain("UIMainStoryboardFile");
    expect(plist).not.toContain("UISceneStoryboardFile");
  });

  it("logs through typed, content-free calls only", () => {
    for (const name of ["ShellCoordinator.swift", "QRScannerViewController.swift", "E2EProbe.swift"]) {
      expect(shell(name)).not.toMatch(/ShellLog\.info\(|\bprint\(|NSLog\(/);
    }
  });
});

describe("P19: the Android workspace screen", () => {
  const java = (name: string) => read(`android/app/src/main/java/com/murage/mobile/${name}`);

  it("requires both WebView features or fails closed (spec §2)", () => {
    const bridge = java("ChannelBridge.java");
    expect(bridge).toContain("WebViewFeature.WEB_MESSAGE_LISTENER");
    expect(bridge).toContain("WebViewFeature.DOCUMENT_START_SCRIPT");
    expect(bridge).toContain("WebViewCompat.addWebMessageListener(webView, ChannelScript.PORT, rules");
    expect(bridge).toContain("Collections.singleton(origin.serialized())");
  });

  it("checks isMainFrame and the origin natively and answers a dropped message", () => {
    const bridge = java("ChannelBridge.java");
    expect(bridge).toContain("ChannelGate.admit(isMainFrame, frame, origin)");
    expect(bridge).toMatch(/error\("unavailable"\)/);
  });

  it("destroys and recreates the WebView when its renderer dies, and returns true (Phase 0 Q5, surprise 1)", () => {
    expect(java("WorkspaceActivity.java")).toMatch(/onRenderProcessGone[\s\S]*?view\.destroy\(\);[\s\S]*?createWebView\(\);[\s\S]*?return true;/);
  });

  it("owns the insets and consumes them (Decision 1)", () => {
    expect(java("WorkspaceActivity.java")).toContain("return WindowInsetsCompat.CONSUMED;");
  });

  it("closes on a 401 or gateway-error document (spec §3.2, Decision 13)", () => {
    expect(java("WorkspaceActivity.java")).toContain("CloseReason reason = MainDocument.closeReason(response.getStatusCode());");
  });

  it("never replays a spent pairing code, and Back never lands on the launcher", () => {
    const activity = java("WorkspaceActivity.java");
    expect(activity).toContain("getIntent().removeExtra(EXTRA_CREDENTIAL)");
    expect(activity).toContain("moveTaskToBack(true)");
  });

  it("keeps the page console out of logcat except the debug probe line", () => {
    expect(java("WorkspaceActivity.java")).toMatch(/onConsoleMessage[\s\S]*?E2EProbe\.isProbeOutput[\s\S]*?return true;/);
  });

  it("declares the workspace activity unexported and singleTop", () => {
    const entry = read("android/app/src/main/AndroidManifest.xml").match(/<activity[^>]*\.WorkspaceActivity[^>]*>/)?.[0] ?? "";
    expect(entry).toContain('android:exported="false"');
    expect(entry).toContain('android:launchMode="singleTop"');
  });

  it("runs the same E2E probe script as iOS, in debug builds only", () => {
    const flat = (text: string) => text.replace(/\s+/g, " ").trim();
    const ios = read("ios/App/MurageShell/Sources/MurageShell/E2EProbe.swift").match(/script = #"""\n([\s\S]*?)\n"""#/)?.[1] ?? "ios";
    const debug = read("android/app/src/debug/java/com/murage/mobile/E2EProbe.java");
    const android = debug.match(/SCRIPT = """\n([\s\S]*?)"""/)?.[1] ?? "android";
    expect(flat(android)).toBe(flat(ios));
    expect(android).not.toContain("\\");
    expect(read("android/app/src/release/java/com/murage/mobile/E2EProbe.java")).not.toContain("SCRIPT");
  });

  // Carried rulings (P14/P17/P18 reviews): the Android twins of the iOS coordinator's refusals.
  it("never reads an unreadable book as empty, and never saves over it", () => {
    const shell = java("Shell.java");
    expect(shell).toContain("if (read.state == SecureStore.Read.State.UNREADABLE) return null;");
    const update = shell.slice(shell.indexOf("private synchronized boolean update("));
    expect(update).toMatch(/if \(book == null\)[\s\S]{0,120}return false;/);
    expect(shell).not.toMatch(/final String installId\b/);
    expect(shell).toContain('failed("unreadable")');
  });

  it("answers a second open while one is in flight, and closes a replaced workspace properly", () => {
    const shell = java("Shell.java");
    const open = shell.split("void open(Activity from,")[1] ?? "";
    expect(open.indexOf('done.failed("busy")')).toBeGreaterThan(-1);
    expect(open.indexOf('done.failed("busy")')).toBeLessThan(open.indexOf("ProbeClient.probe"));
    expect(shell).toContain("old.closeFromShell();");
    expect(shell).toContain("WorkspaceOrigin.parseInput(originText)");
  });

  it("signs out of the session: cookies and the WebView HTTP cache (R4)", () => {
    const shell = java("Shell.java");
    expect(shell).toContain("clearCache(true)");
    expect(shell).toContain('Max-Age=0');
  });

  it("sweeps leftover saves once per process and starts the ready deadline on every load", () => {
    expect(java("Shell.java")).toMatch(/private Shell\(Context app\) \{[\s\S]{0,200}CacheSink\.sweep\(app\);/);
    const activity = java("WorkspaceActivity.java");
    const load = activity.slice(activity.indexOf("private void load(String path)"), activity.indexOf("private void reloadRoute()"));
    expect(load).toContain("armDeadline();");
    expect(activity).toMatch(/LoadFailure\.IGNORE[\s\S]{0,80}armDeadline\(\)/);
  });

  it("commits the release source set (R7)", () => {
    expect(read(".gitignore")).toContain("!/android/app/src/release/");
  });
});

describe("P19 fix round 1: threading, sign-out, foreign pages and dialogs", () => {
  const java = (name: string) => read(`android/app/src/main/java/com/murage/mobile/${name}`);
  const between = (text: string, from: string, to: string) => {
    const start = text.indexOf(from);
    return start < 0 ? "" : text.slice(start, text.indexOf(to, start + from.length));
  };

  it("guards the close hand-off: callers may be off the main thread (P21's plugin)", () => {
    const shell = java("Shell.java");
    expect(shell).toContain("synchronized void closed(WorkspaceActivity workspace, CloseReason reason)");
    expect(shell).toContain("synchronized String[] takePendingClose()");
    expect(shell).toContain("synchronized boolean hasPendingClose()");
    expect(shell).toContain("Callers may be off the main thread");
  });

  it("never puts a computer back on the list once its screen is closing (Android and iOS)", () => {
    const activity = java("WorkspaceActivity.java");
    for (const body of [between(activity, "private void markReady()", "private void revealBasic()"), between(activity, "public void onPageFinished(", "public boolean onRenderProcessGone(")]) {
      expect(body).toContain("if (closing) return;");
      expect(body.indexOf("if (closing) return;")).toBeLessThan(body.indexOf("signedIn();"));
    }
    const ios = read("ios/App/MurageShell/Sources/MurageShell/WorkspaceViewController.swift");
    expect(between(ios, "private func markReady()", "private func revealBasic()")).toContain("guard !isReady, !closing else { return }");
    expect(ios).toMatch(/if !closing \{\s*switch MainDocument\.arrival\(status: http\.statusCode, path: path\) \{\s*case \.signedIn: signedIn\(\)\s*case \.inUse: loadedInUse\(\)/);
    // "Last connected" moving on while in use only touches a saved computer, and never once closing.
    expect(between(activity, "private void stillInUse()", "private void revealBasic()")).toContain("if (!signedInSeen || closing) return;");
    expect(between(ios, "private func stillInUse()", "private func revealBasic()")).toContain("guard signedInSeen, !closing else { return }");
    expect(between(java("Shell.java"), "void inUse(WorkspaceOrigin origin)", "// ---- opening")).toContain("updateIfChanged(book -> book.touched(origin, now))");
    expect(between(read("ios/App/MurageShell/Sources/MurageShell/ShellCoordinator.swift"), "private func inUse(", "// MARK: closing")).toContain("books.updateIfChanged({ $0.touched(origin, at: now) })");
  });

  // Fix round 1 (I1): only "/" and ready() may add a computer (signedIn); any
  // other page that loads only touches it. A touch never adds, activates or evicts.
  it("a page other than / only touches the computer, on both platforms", () => {
    const activity = java("WorkspaceActivity.java");
    const finished = between(activity, "public void onPageFinished(", "public boolean onRenderProcessGone(");
    expect(finished).toMatch(/switch \(MainDocument\.arrival\(mainDocumentStatus, path\)\) \{\s*case SIGNED_IN:\s*signedIn\(\);\s*break;\s*case IN_USE:\s*loadedInUse\(\);/);
    expect(finished).not.toContain("shell.signedIn(");
    const javaTouch = between(activity, "private void loadedInUse()", "private void revealBasic()");
    expect(javaTouch).toContain("stillInUse();");
    expect(javaTouch).not.toMatch(/signedIn\(/);
    const ios = read("ios/App/MurageShell/Sources/MurageShell/WorkspaceViewController.swift");
    const iosTouch = between(ios, "private func loadedInUse()", "private func revealBasic()");
    expect(iosTouch).toContain("stillInUse()");
    expect(iosTouch).not.toMatch(/signedIn\(|onSignedIn/);
    // signedIn stays where it was: markReady and the "/" arrival only.
    expect(activity.match(/\bsignedIn\(\);/g)).toHaveLength(2);
    expect(ios.match(/\bsignedIn\(\)$/gm)).toHaveLength(2); // markReady and `case .signedIn: signedIn()`
    expect(ios).toContain("case .signedIn: signedIn()");
    // The touch goes through touched only.
    for (const [shell, from] of [[java("Shell.java"), "void inUse(WorkspaceOrigin origin)"], [read("ios/App/MurageShell/Sources/MurageShell/ShellCoordinator.swift"), "private func inUse("]] as const) {
      const body = between(shell, from, "touched(");
      expect(body).not.toBe("");
      expect(body).not.toContain("signedIn");
    }
  });

  it("reads interfaces the same way on both platforms: up and running, and unknown when none can be read", () => {
    expect(read("ios/App/MurageShell/Sources/MurageShell/ShellCoordinator.swift")).toContain("let live = UInt32(IFF_UP | IFF_RUNNING)");
    expect(java("Shell.java")).toContain("if (all == null) return null;");
  });

  it("stops a main-frame load that left the origin without asking (a form POST)", () => {
    const started = between(java("WorkspaceActivity.java"), "public void onPageStarted(", "public void onReceivedHttpError(");
    expect(started).toContain("view.stopLoading();");
    expect(started).toContain("openOutside(");
    // P26 on the S25: onPageStarted comes after the commit, so stopLoading alone
    // left example.com's POST reply showing in the workspace. It must go back.
    // Fix round 1 (I1): one return at a time (OriginReturn), sent out only on
    // the first leave, checked where it lands, and a reload clears the history.
    const activity = java("WorkspaceActivity.java");
    expect(started).toContain("originReturn.left()");
    expect(started.indexOf("case SEND_OUT_AND_RETURN")).toBeLessThan(started.indexOf("openOutside("));
    expect(started).toContain("returnToOrigin(view);");
    const back = between(activity, "private void returnToOrigin(", "@Override");
    expect(back).toContain("if (closing || view != webView) return;");
    expect(back).toContain("originReturn.run(view.canGoBack())");
    expect(back).toContain("view.goBack();");
    expect(back).toContain("reloadAndForget();");
    expect(between(activity, "private void reloadAndForget()", "/**")).toContain("reloadRoute();");
    const visited = between(activity, "public void doUpdateVisitedHistory(", "@Override");
    expect(visited).toContain("originReturn.landed(");
    const finished = between(activity, "public void onPageFinished(", "public boolean onRenderProcessGone(");
    expect(finished).toContain("originReturn.landed(");
    expect(finished).toContain("originReturn.reloaded(");
    expect(finished).toContain("view.clearHistory();");
    // a new WebView (renderer death) starts with no return in flight
    expect(between(activity, "private void createWebView()", "private String enterPath(")).toContain("originReturn = new OriginReturn();");
  });

  it("finishes a launcher that the icon stacks over a task it did not start (P26 F2)", () => {
    const main = java("MainActivity.java");
    const create = between(main, "protected void onCreate(", "getBridge().setWebViewClient(");
    expect(create).toContain("LaunchPolicy.isLauncherReentry(");
    const reentry = create.indexOf("LaunchPolicy.isLauncherReentry(");
    expect(reentry).toBeLessThan(create.indexOf("registerPlugin(ShellPlugin.class)"));
    const early = create.slice(reentry, create.indexOf("registerPlugin(ShellPlugin.class)"));
    expect(early).toContain("super.onCreate(state);");
    expect(early).toContain("finish();");
    expect(early).toContain("return;");
    expect(read("android/app/src/main/AndroidManifest.xml")).toMatch(/android:name="\.MainActivity"[\s\S]*?android:launchMode="standard"/);
  });

  it("answers JavaScript dialogs silently unless the page is on the saved origin", () => {
    const activity = java("WorkspaceActivity.java");
    for (const name of ["onJsAlert", "onJsConfirm", "onJsPrompt"]) {
      const body = between(activity, `public boolean ${name}(`, "@Override");
      expect(body, name).toContain("if (!origin.contains(url))");
      expect(body, name).toContain("result.cancel();");
    }
  });

  it("keeps the workspace across a light/dark switch", () => {
    const entry = read("android/app/src/main/AndroidManifest.xml").match(/<activity[^>]*\.WorkspaceActivity[^>]*>/)?.[0] ?? "";
    expect(entry).toMatch(/android:configChanges="[^"]*\buiMode\b/);
  });
});

describe("P20: Android saving", () => {
  const java = (name: string) => read(`android/app/src/main/java/com/murage/mobile/${name}`);
  const saves = () => java("SaveController.java");
  const fetch = () => java("SameOriginFetch.java");
  const between = (text: string, from: string, to: string) => {
    const start = text.indexOf(from);
    return start < 0 ? "" : text.slice(start, text.indexOf(to, start + from.length));
  };

  // Ruling (the session cookie never leaves the origin): AOSP DownloadThread re-adds every
  // request header, Cookie included, on each redirect hop to any host, so DownloadManager
  // is not used; the shell fetches itself and follows only same-origin redirects.
  it("fetches a server file itself, never through DownloadManager", () => {
    expect(saves()).not.toMatch(/import android\.app\.DownloadManager|DownloadManager\.Request|DOWNLOAD_SERVICE|addRequestHeader\(/);
    expect(fetch()).toContain("setInstanceFollowRedirects(false)");
    expect(fetch()).toContain("static final int MAX_REDIRECTS = 5;");
  });

  it("sends the WebView's cookie only to the saved origin, redirects included", () => {
    const loop = fetch();
    expect(loop).toMatch(/if \(!sameOrigin\(current, origin\)\) throw new Refused\("foreign_url"\);[\s\S]{0,900}setRequestProperty\("Cookie", cookie\)/);
    expect(loop).toMatch(/Location[\s\S]{0,700}if \(!sameOrigin\(next, origin\)\)[\s\S]{0,120}throw new Refused\("foreign_url"\)/);
    expect(loop).toContain("DownloadGate.accept(status)");
    expect(saves()).toContain("ProbeClient.dropCookieHandler();");
  });

  it("names a server file through FileNames.safe and publishes it to Downloads", () => {
    expect(saves()).toContain("FileNames.safe(URLUtil.guessFileName(url, contentDisposition, mimeType))");
    expect(saves()).toContain("MediaStore.Downloads.EXTERNAL_CONTENT_URI");
    expect(saves()).toContain("MediaStore.Downloads.IS_PENDING");
  });

  it("removes a failed or cancelled save instead of keeping part of it (Plan 1 note 5)", () => {
    expect(saves()).toMatch(/catch \([^)]*\) \{[\s\S]{0,300}resolver\.delete\(target, null, null\)/);
  });

  it("leaves blob: URLs to saveFile (Phase 0 surprise 4)", () => {
    expect(saves()).toMatch(/startsWith\("blob:"\)[\s\S]{0,200}return;/);
  });

  it("assembles generated files in the cache sink and clears them after the hand-off", () => {
    expect(saves()).toContain("new ChunkAssembler(new CacheSink(context)");
    expect(saves()).toMatch(/finally \{[\s\S]{0,120}CacheSink\.delete\(file\.file\.getParentFile\(\)\)/);
    expect(java("CacheSink.java")).toContain("implements ChunkAssembler.Sink");
    expect(between(java("CacheSink.java"), "public File create(", "@Override")).toContain("prune(");
  });

  it("takes a download only from the page on the saved origin", () => {
    const activity = java("WorkspaceActivity.java");
    expect(activity).not.toContain("setDownloadListener(saves::onDownload)");
    expect(activity).toMatch(/setDownloadListener\([\s\S]{0,200}origin\.contains\(webView\.getUrl\(\)\)[\s\S]{0,300}saves\.onDownload\(/);
  });

  it("cancels every save in flight when the workspace closes or is replaced", () => {
    const activity = java("WorkspaceActivity.java");
    for (const body of [between(activity, "void close(CloseReason reason)", "void closeFromShell()"), between(activity, "void closeFromShell()", "void emit(")]) {
      expect(body).toContain("saves.cancelAll();");
    }
    const cancel = between(saves(), "void cancelAll()", "\n    }\n");
    expect(cancel).toContain('error("unavailable")');
    expect(cancel).toContain("assembler.abort(");
    expect(saves()).toMatch(/if \(closed\)[\s\S]{0,80}error\("unavailable"\)/);
  });
});

describe("P20 fix round 1: MIME, publish result, deadline and parity", () => {
  const java = (name: string) => read(`android/app/src/main/java/com/murage/mobile/${name}`);
  const saves = () => java("SaveController.java");

  it("cleans the page's MIME type before MediaStore sees it (I1)", () => {
    expect(saves()).toContain("store(in, file.filename, SameOriginFetch.mimeOf(file.mime, null)");
    expect(saves()).toMatch(/values\.put\(MediaStore\.Downloads\.MIME_TYPE, SameOriginFetch\.mimeOf\(mime, null\)\)/);
  });

  it("publishes only when MediaStore confirms the row (I3)", () => {
    expect(saves()).toMatch(/if \(resolver\.update\(target, values, null, null\) != 1\) throw new IOException/);
  });

  it("never lets a failed delete hide the original error (M3)", () => {
    expect(saves()).toMatch(/try \{\s*resolver\.delete\(target, null, null\);\s*\} catch \(RuntimeException/);
  });

  it("counts bytes as long and gives every fetch an overall deadline (M1, M2)", () => {
    expect(saves()).not.toMatch(/\bint (bytes|total)\b/);
    expect(saves()).toContain("FETCH_DEADLINE_MS");
    expect(java("SameOriginFetch.java")).toMatch(/opener\.open\(new URL\(current\)\);\s*try \{\s*watch\.opened\(connection\);/);
  });

  it("documents the Android frame limit on the download check (parity note)", () => {
    expect(java("WorkspaceActivity.java")).toMatch(/Android parity[\s\S]{0,700}setDownloadListener/);
  });
});

describe("SEC-006 P6: Android fresh authentication", () => {
  const keys = read("android/app/src/main/java/com/murage/mobile/ApprovalKeys.java");
  const workspace = read("android/app/src/main/java/com/murage/mobile/WorkspaceActivity.java");
  const shell = read("android/app/src/main/java/com/murage/mobile/Shell.java");
  it("makes an auth-bound EC key in AndroidKeyStore only on a secured device", () => {
    expect(keys).toContain('KeyStore.getInstance("AndroidKeyStore")');
    expect(keys).toContain("isDeviceSecure()");
    expect(keys).toContain("setUserAuthenticationRequired(true)");
    expect(keys).toContain('new ECGenParameterSpec("secp256r1")');
    expect(keys).toContain("setInvalidatedByBiometricEnrollment(false)");
  });
  it("prefers StrongBox and falls back to the TEE", () => {
    expect(keys).toContain("setIsStrongBoxBacked(true)");
    expect(keys).toContain("FEATURE_STRONGBOX_KEYSTORE");
  });
  it("retries on the TEE after any failure of the StrongBox attempt, not only StrongBoxUnavailableException (M3)", () => {
    const enrol = keys.slice(keys.indexOf("static String enrol("), keys.indexOf("private static java.security.KeyPair generate"));
    expect(enrol).toMatch(/generate\(alias, true\);\s*\} catch \(GeneralSecurityException \| RuntimeException e\) \{[\s\S]*remove\(origin\)[\s\S]*generate\(alias, false\)/);
    expect(keys).not.toContain("catch (StrongBoxUnavailableException");
  });
  it("has no unused publicPoint reader", () => {
    expect(keys).not.toContain("publicPoint");
  });
  it("authenticates per use on API 30+, with biometrics or the device credential", () => {
    expect(keys).toContain("setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL)");
    expect(keys).toContain("new BiometricPrompt.CryptoObject(");
    expect(keys).toContain("setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL)");
  });
  it("uses a 5 second window only on API 29", () => {
    expect(keys).toMatch(/SDK_INT >= 30[\s\S]*setUserAuthenticationValidityDurationSeconds\(5\)/);
  });
  it("signs only Request.message()", () => {
    expect(keys).toContain("update(request.message())");
    expect(keys).not.toMatch(/\.update\((?!request\.message\(\))/);
  });
  it("maps a biometric cancel to cancelled and never logs", () => {
    expect(keys).toMatch(/BIOMETRIC_ERROR_USER_CANCELED[\s\S]*callback\.error\("cancelled"\)/);
    expect(keys).not.toMatch(/ShellLog|Log\.|println/);
  });
  it("catches every keystore failure and answers sign once", () => {
    expect(keys).toContain("RuntimeException");
    expect(keys).toContain("AtomicBoolean");
    expect(keys).toContain("answered.compareAndSet(false, true)");
  });
  it("deletes the old key first in enrol, before the screen-lock check", () => {
    const enrol = keys.slice(keys.indexOf("static String enrol("), keys.indexOf("private static java.security.KeyPair generate"));
    expect(enrol.indexOf("remove(origin)")).toBeGreaterThan(-1);
    expect(enrol.indexOf("remove(origin)")).toBeLessThan(enrol.indexOf("isDeviceSecure()"));
  });
  it("declares USE_BIOMETRIC", () => {
    expect(read("android/app/src/main/AndroidManifest.xml")).toContain("android.permission.USE_BIOMETRIC");
  });
  it("routes approveWithDevice and always resets approving", () => {
    expect(workspace).toContain('case "approveWithDevice": {');
    expect(workspace).toContain('if (!hasWindowFocus()) { reply.error("unavailable"); break; }');
    expect(workspace).toContain('if (approving) { reply.error("busy"); break; }');
    const at = workspace.slice(workspace.indexOf('case "approveWithDevice"'), workspace.indexOf('case "callSessionClose"'));
    expect(at).toMatch(/try \{[\s\S]*ApprovalKeys\.sign\([\s\S]*\} catch \(RuntimeException e\) \{\s*approving = false;/);
    expect(at.match(/approving = false/g)?.length).toBeGreaterThanOrEqual(3);
  });
  it("makes the key at pairing, drops the old one otherwise, and sends it only with the relay's statement (P9)", () => {
    expect(workspace).toContain("ApprovalKeys.enrol(getApplicationContext(), origin)");
    expect(workspace).not.toContain("ApprovalKeys.enrol(this, origin)");
    expect(workspace).toMatch(/else ApprovalKeys\.remove\(origin\);/);
    expect(workspace).toContain("EXTRA_APPROVAL_PROOF");
    expect(workspace).not.toMatch(/PairingLink\.enterPath\([^)]*approvalKey/);
    // Only ApprovalAttestation.enterPath puts a key in the link, and only beside a valid statement.
    expect(workspace).toContain("ApprovalAttestation.enterPath(credential, installId, key, statement)");
    expect(workspace).toContain("ApprovalAttestation.statement(RelayClient::call");
    expect(workspace).toContain("PushRegistrar.integrityToken(getApplicationContext(), nonce)");
  });
  it("fetches the statement off the main thread once, capped, and logs no statement, key or nonce (P9)", () => {
    const at = workspace.slice(workspace.indexOf("private void loadPairing("), workspace.indexOf("/** The bar icons"));
    expect(at).toContain("attestIo.execute(");
    expect(at).toContain("ATTEST_BUDGET_MS");
    expect(at).toContain("isDestroyed()");
    expect(at).toContain('ShellLog.i(statement == null ? "approval statement: no" : "approval statement: yes")');
    expect(at).not.toMatch(/ShellLog\.i\([^)]*(key|nonce|statement \+|\+ statement)/);
    expect(read("android/app/src/main/java/com/murage/mobile/ApprovalAttestation.java")).not.toContain("ShellLog");
  });
  it("makes the key on the attest executor, inside the 10 second budget, and never sends a key without a statement (M2)", () => {
    const at = workspace.slice(workspace.indexOf("private void loadPairing("), workspace.indexOf("/** The bar icons"));
    const io = at.slice(at.indexOf("attestIo.execute("));
    expect(io).toContain("ApprovalKeys.enrol(getApplicationContext(), origin)");
    expect(io.indexOf("ApprovalKeys.enrol(")).toBeLessThan(io.indexOf("ApprovalAttestation.statement("));
    expect(at.indexOf("main.postDelayed(attestTimeout")).toBeLessThan(at.indexOf("attestIo.execute("));
    // No key, no statement: the plain path, and a key with no statement is deleted.
    expect(io).toMatch(/key == null[\s\S]*proceed\.accept\(null/);
    expect(io).toMatch(/statement == null[\s\S]*ApprovalKeys\.remove\(origin\)/);
    const enter = workspace.slice(workspace.indexOf("private String enterPath("), workspace.indexOf("/** The live WebView"));
    expect(enter).not.toContain("ApprovalKeys.enrol");
    expect(workspace).not.toContain("private String approvalKey");
  });
  it("removes the key on a 401 sign-out and on every keyless re-pair path (M1)", () => {
    const closed = shell.slice(shell.indexOf("synchronized void closed("), shell.indexOf("synchronized String[] takePendingClose"));
    expect(closed).toMatch(/reason == CloseReason\.SIGNED_OUT[\s\S]*ApprovalKeys\.remove\(origin\)/);
    const enter = workspace.slice(workspace.indexOf("private String enterPath("), workspace.indexOf("/** The live WebView"));
    const basic = enter.slice(enter.indexOf('if (!"full".equals(mode))'), enter.indexOf("String installId"));
    expect(basic).toContain("ApprovalKeys.remove(origin)");
    const noId = enter.slice(enter.indexOf("String installId"), enter.indexOf("return PairingLink.enterPath(credential, installId)"));
    expect(noId).toMatch(/installId == null\) \{\s*ApprovalKeys\.remove\(origin\);\s*return null;/);
  });
  it("removes the key when a computer is forgotten, signs out or re-pairs", () => {
    const forget = shell.slice(shell.indexOf("boolean forget("), shell.indexOf("boolean forget(") + 600);
    expect(forget).toContain("ApprovalKeys.remove(origin)");
    expect(workspace).toMatch(/case "signOut":\s*ApprovalKeys\.remove\(origin\);/);
    expect(workspace).toMatch(/case "rePair":\s*ApprovalKeys\.remove\(origin\);/);
  });
});

describe("P21: the Android launcher side", () => {
  const java = (name: string) => read(`android/app/src/main/java/com/murage/mobile/${name}`);
  const ios = () => read("ios/App/App/ShellPlugin.swift");
  const coordinator = () => read("ios/App/MurageShell/Sources/MurageShell/ShellCoordinator.swift");
  const METHODS = ["state", "scan", "open", "remove", "openTailscale"];
  /** The body of one @PluginMethod, up to the next annotation or helper. */
  const method = (plugin: string, name: string) => plugin.split(`public void ${name}(PluginCall call)`)[1]?.split(/@PluginMethod|\n    private |\n    \/\*\*/)[0] ?? "";

  it("survives the shared renderer dying under the launcher too (Phase 0 surprise 1)", () => {
    const main = java("MainActivity.java");
    expect(main).toMatch(/new BridgeWebViewClient\(getBridge\(\)\)[\s\S]*?onRenderProcessGone[\s\S]*?view\.destroy\(\);[\s\S]*?return true;/);
    expect(main).toMatch(/launcherWebViewDead[\s\S]*?recreate\(\)/);
  });

  // Carried ruling 4: book() is null when the store can't be read, and autoOpen dereferences it.
  it("auto-opens through the tested launch rule, only with a readable book, not on a Switch computer launch", () => {
    const main = java("MainActivity.java");
    expect(main).toContain("ACTION_SWITCH.equals(getIntent().getAction())");
    expect(main).toContain("WorkspaceBook book = shell.book();");
    expect(main).toMatch(/if \(book != null\) \{[\s\S]{0,200}LaunchPolicy\.autoOpen\(book, shell\.autoOpened, switching, shell\.hasPendingClose\(\)\)/);
    expect(main).not.toContain("LaunchPolicy.autoOpen(shell.book()");
  });

  it("keeps native HTTP free of cookies and the Capacitor Cookies/Http plugins off (ruling 9)", () => {
    expect(java("MainActivity.java")).toContain("CookieHandler.setDefault(null);");
    expect(read("capacitor.config.ts")).toContain("plugins: { CapacitorCookies: { enabled: false }, CapacitorHttp: { enabled: false } }");
  });

  it("reads the E2E extras only in debug builds", () => {
    const main = java("MainActivity.java");
    expect(main).toContain("if (BuildConfig.DEBUG) applyDebugExtras(getIntent());");
    expect(main).toMatch(/private void applyDebugExtras\(Intent intent\) \{\s+if \(!BuildConfig\.DEBUG\) return;/);
    expect(main).toContain("WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)");
  });

  it("exposes exactly the launcher's five methods and the close event, like iOS", () => {
    const plugin = java("ShellPlugin.java");
    const methods = [...plugin.matchAll(/@PluginMethod\s+public void (\w+)/g)].map((m) => m[1]);
    expect(methods).toEqual(METHODS);
    expect(ios()).toContain(JSON.stringify(METHODS).replace(/,/g, ", "));
    expect(plugin).toContain('notifyListeners("workspaceClosed", event, true)');
    expect(plugin).toContain('@CapacitorPlugin(name = "MurageShell")');
    expect(java("MainActivity.java")).toContain("registerPlugin(ShellPlugin.class);");
  });

  // Carried rulings 1-3: the bundled page only, on the main thread, and every path answers.
  it("answers only the bundled launcher page, on the main thread, for every method", () => {
    const plugin = java("ShellPlugin.java");
    for (const name of METHODS) expect(method(plugin, name), name).toMatch(/^\s*\{\s*onLauncher\(call, /);
    const gate = plugin.slice(plugin.indexOf("private void onLauncher("));
    expect(gate).toContain("getBridge().executeOnMainThread(");
    expect(gate).toMatch(/if \(!fromLauncher\(\)\) \{\s*call\.reject\("unavailable", "unavailable"\);\s*return;/);
    const check = plugin.slice(plugin.indexOf("private boolean fromLauncher()"));
    expect(check).toContain("getBridge().getLocalUrl()");
    expect(check).toContain("getBridge().getWebView()");
  });

  it("is a thin door onto Shell: no probe, no book of its own", () => {
    const plugin = java("ShellPlugin.java");
    expect(plugin).not.toMatch(/ProbeClient|WorkspaceBook|ExecutorService|startWorkspace|takePendingClose/);
    expect(method(plugin, "state")).toMatch(/JSONObject state = shell\(\)\.snapshot\(\);\s*if \(state == null\) \{\s*call\.reject\("unreadable", "unreadable"\);/);
    expect(method(plugin, "open")).toContain("shell().open(getActivity(), origin, call.getString(\"credential\"), new Shell.OpenDone()");
    expect(method(plugin, "open")).toMatch(/if \(origin == null\) \{\s*call\.reject\("bad_origin", "bad_origin"\);/);
    expect(method(plugin, "remove")).toContain("shell().remove(");
  });

  it("stops listening only for itself when a launcher goes away", () => {
    const plugin = java("ShellPlugin.java");
    expect(plugin).toMatch(/handleOnDestroy\(\) \{[\s\S]{0,200}if \(shell\(\)\.listener == closes\) shell\(\)\.listener = null;/);
  });

  it("rejects only with the codes the iOS plugin uses", () => {
    const iosCodes = new Set(["unavailable"]);
    for (const enumName of ["OpenFailure", "ScanFailure"]) {
      const body = coordinator().split(`public enum ${enumName}: String, Error {`)[1]?.split("}")[0] ?? "";
      for (const line of body.split("\n")) {
        const cases = line.match(/case (.*)/)?.[1];
        if (!cases) continue;
        for (const part of cases.split(",")) {
          const [name, raw] = part.split("=").map((s) => s.trim());
          iosCodes.add(raw ? JSON.parse(raw) : name);
        }
      }
    }
    expect(iosCodes).toContain("bad_credential");
    expect(iosCodes).toContain("camera_denied");
    const android = ["ShellPlugin.java", "Shell.java", "QrScanner.java"].map(java).join("\n");
    const used = [...android.matchAll(/(?:reject|failed)\("([a-z_]+)"|return "([a-z_]+)";/g)].map((m) => m[1] ?? m[2]);
    expect(used.length).toBeGreaterThan(5);
    expect(used).toContain("no_launcher"); // Shell.startWorkspace returns it as a plain string (fix round 1)
    for (const code of used) expect(iosCodes, code).toContain(code);
    expect(java("QrScanner.java")).toContain('done.failed("cancelled")');
  });

  // Carried ruling 6: only what the core parses, trimmed the way open() trims.
  it("hands the launcher only a pairing link the core parses, trimmed like open()", () => {
    const scanner = java("QrScanner.java");
    expect(scanner).toContain("PairingLink.parse(trimmed) == null ? null : trimmed");
    expect(scanner).toContain("String trimmed = WorkspaceOrigin.trimInput(raw);");
    expect(read("android/app/src/main/java/com/murage/mobile/shell/WorkspaceOrigin.java")).toContain("return parse(trimInput(value));");
  });

  it("offers Switch computer as a launcher shortcut", () => {
    expect(read("android/app/src/main/res/xml/shortcuts.xml")).toContain('android:action="com.murage.mobile.SWITCH"');
    expect(read("android/app/src/main/AndroidManifest.xml")).toContain('android:resource="@xml/shortcuts"');
    expect(java("MainActivity.java")).toContain('static final String ACTION_SWITCH = "com.murage.mobile.SWITCH";');
  });

  // Carried ruling 7 / Decision 10: native honours handled === true from a raw murageNative.on
  // listener, but the web's onNativeEvent discards its listener's return (pinned in
  // src/lib/native-shell.test.ts), so today Back always takes the native path below.
  it("handles Back natively in the workspace: history, then the home screen, never the launcher", () => {
    const back = java("WorkspaceActivity.java").split("new OnBackPressedCallback(true)")[1]?.split("\n    };")[0] ?? "";
    expect(back).toContain("if (!handled) backWithoutPage();");
    expect(back).not.toContain("finish()");
  });
});

describe("P21 fix round 1: renderer death, scanner module, config, Back", () => {
  const java = (name: string) => read(`android/app/src/main/java/com/murage/mobile/${name}`);

  it("lets a close wait as pending while the launcher's renderer is dead (Important 1)", () => {
    const gone = java("MainActivity.java").split("onRenderProcessGone(")[1]?.split("return true;")[0] ?? "";
    expect(gone).toContain("releaseShell();");
    expect(java("MainActivity.java")).toMatch(/private void releaseShell\(\) \{[\s\S]{0,300}getBridge\(\)\.getPlugin\("MurageShell"\)[\s\S]{0,200}\.release\(\);/);
    const plugin = java("ShellPlugin.java");
    expect(plugin).toMatch(/void release\(\) \{\s*dead = true;\s*if \(shell\(\)\.listener == closes\) shell\(\)\.listener = null;/);
    expect(plugin).toMatch(/handleOnResume\(\) \{\s*if \(dead\) return;/);
  });

  it("declares the scanner module and requests it before the scanner's UI ever shows (Important 2, P23 fix round 2)", () => {
    expect(read("android/app/src/main/AndroidManifest.xml")).toContain('<meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="barcode_ui" />');
    const scanner = java("QrScanner.java");
    expect(scanner).toContain("ModuleInstall.getClient(activity).installModules(");
    // The module's availability is pinned before startScan is ever called.
    const checkModule = scanner.split("private static void checkModule(")[1]?.split("\n    private static void next(")[0] ?? "";
    expect(checkModule).toContain("ModuleInstall.getClient(activity).areModulesAvailable(scanner)");
    expect(checkModule).toMatch(/if \(response\.areModulesAvailable\(\)\) \{\s*next\(activity, scanner, done\);\s*return;\s*\}\s*[^\n]*\s*requestModule\(activity, scanner\);\s*done\.failed\("unavailable"\);/);
    // If the check itself fails, the scan is tried anyway rather than blocked.
    expect(checkModule).toMatch(/\.addOnFailureListener\(error -> \{\s*[^\n]*\s*next\(activity, scanner, done\);\s*\}\);/);
    expect(checkModule).toMatch(/catch \(RuntimeException unavailable\) \{\s*[^\n]*\s*next\(activity, scanner, done\);\s*\}/);
  });

  it("answers cancelled for every startScan failure once the module is available, not just Back (P23 fix round 2)", () => {
    // Seen on a Galaxy S25 (Android 16): Back fires addOnFailureListener with
    // MlKitException code 13 (INTERNAL), never CODE_SCANNER_CANCELLED and
    // never addOnCanceledListener -- so the decision no longer singles that
    // code out, it treats every failure (but a denied camera permission) as
    // the person having left the scanner's screen.
    const scanner = java("QrScanner.java");
    expect(scanner).not.toContain("cancelledByPerson");
    expect(scanner).toMatch(
      /static String failureCode\(Exception error\) \{\s*if \(error instanceof MlKitException\s*&& \(\(MlKitException\) error\)\.getErrorCode\(\) == MlKitException\.CODE_SCANNER_CAMERA_PERMISSION_NOT_GRANTED\) \{\s*return "unavailable";\s*\}\s*return "cancelled";\s*\}/,
    );
    expect(scanner).toContain('.addOnCanceledListener(() -> done.failed("cancelled"))');
    // The failure branch after startScan never requests the module.
    const next = scanner.split("private static void next(")[1]?.split("\n    private static void requestModule(")[0] ?? "";
    expect(next).toContain("done.failed(failureCode(error));");
    expect(next).not.toContain("requestModule");
  });

  it("trims a scanned code on iOS the way Android does (Minor 1)", () => {
    const ios = read("ios/App/MurageShell/Sources/MurageShell/QRScannerViewController.swift");
    expect(ios).toContain("let value = code.stringValue.map(WorkspaceOrigin.trimInput)");
    expect(ios).toMatch(/PairingLink\.parse\(value\) != nil else \{ continue \}\s*finish\(\.success\(value\)\)/);
  });

  it("keeps the launcher on the bundled origin: no server url, hostname, allowNavigation or legacy bridge (Minor 2)", () => {
    const config = read("capacitor.config.ts").replace(/\/\/.*$/gm, "");
    for (const key of ["url", "hostname", "allowNavigation", "useLegacyBridge"]) expect(config, key).not.toMatch(new RegExp(`\\b${key}\\s*:`));
  });

  it("frees the scanner slot when a scan call throws (Minor 3)", () => {
    const gate = java("ShellPlugin.java").split("private void onLauncher(")[1] ?? "";
    expect(gate).toMatch(/catch \(RuntimeException unexpected\) \{[\s\S]{0,200}if \("scan"\.equals\(call\.getMethodName\(\)\)\) scanning = false;/);
  });

  it("falls back on Back when the page does not answer in time (Minor 5)", () => {
    const activity = java("WorkspaceActivity.java");
    expect(activity).toContain("BACK_TIMEOUT_MS = 500");
    const back = activity.split("new OnBackPressedCallback(true)")[1]?.split("\n    };")[0] ?? "";
    expect(back).toContain("main.postDelayed(fallback, BACK_TIMEOUT_MS);");
    expect(back).toContain("main.removeCallbacks(fallback);");
    expect(activity).toMatch(/private void backWithoutPage\(\) \{\s*if \(webView != null && webView\.canGoBack\(\)\) webView\.goBack\(\);\s*else moveTaskToBack\(true\);/);
  });

  it("refuses to build when the synced config leaves CapacitorCookies on (optional 9)", () => {
    const script = read("scripts/android-remote.sh");
    expect(script).toContain("android/app/src/main/assets/capacitor.config.json");
    expect(script).toMatch(/CapacitorCookies\.enabled === false[\s\S]{0,400}exit 1/);
  });
});

describe("Final review fixes", () => {
  const java = (name: string) => read(`android/app/src/main/java/com/murage/mobile/${name}`);
  const swift = (name: string) => read(`ios/App/MurageShell/Sources/MurageShell/${name}`);
  const plistString = (key: string) => read("ios/App/App/Info.plist").match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];

  it("declares every usage string the camera, microphone and share sheet need (I1: Save Image without one ends the app)", () => {
    for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSPhotoLibraryAddUsageDescription"]) {
      expect(plistString(key), key).toMatch(/\S/);
    }
  });

  it("resets Capacitor's cookie handler after every super.onCreate in the launcher, the re-entry path too (I2)", () => {
    const create = java("MainActivity.java").split("protected void onCreate(")[1]?.split("\n    }\n")[0] ?? "";
    const calls = create.split("super.onCreate(state);").slice(1);
    // The launcher and the icon re-entry. (The A5 review moved the notification-tap
    // trampoline off the launcher into PushOpenActivity, which builds no bridge.)
    expect(calls.length).toBe(2);
    // Each super.onCreate is followed by the reset before anything returns or reads the book.
    for (const after of calls) {
      const reset = after.indexOf("CookieHandler.setDefault(null);");
      expect(reset).toBeGreaterThan(-1);
      const exit = after.indexOf("return;");
      if (exit >= 0) expect(reset).toBeLessThan(exit);
    }
  });

  it("decides every iOS navigation, new window and capture with the tested NavigationPolicy (I3)", () => {
    const vc = swift("WorkspaceViewController.swift");
    const between = (from: string, to: string) => vc.slice(vc.indexOf(from), vc.indexOf(to, vc.indexOf(from)));
    const action = between("decidePolicyFor action: WKNavigationAction", "decidePolicyFor response:");
    expect(action).toContain("switch NavigationPolicy.decide(url.absoluteString, target: target, saved: origin) {");
    expect(action).toContain("action.targetFrame?.isMainFrame ?? true ? .mainFrame : .subframe");
    expect(action).toMatch(/case \.allow: decisionHandler\(\.allow\)/);
    expect(action).toMatch(/case \.sendOut:\s*openOutside\(url\)[^\n]*\s*decisionHandler\(\.cancel\)/);
    expect(action).toMatch(/case \.cancel, \.openHere: decisionHandler\(\.cancel\)/);
    expect(action.match(/decisionHandler\(\.allow\)/g)).toHaveLength(1);
    const window = between("createWebViewWith configuration", "requestMediaCapturePermissionFor");
    expect(window).toContain("switch NavigationPolicy.decide(url.absoluteString, target: .newWindow, saved: origin) {");
    expect(window).toMatch(/case \.openHere: webView\.load\(action\.request\)/);
    expect(window).toMatch(/case \.sendOut: openOutside\(url\)/);
    expect(window).toContain("return nil");
    const capture = between("requestMediaCapturePermissionFor", "private func fromPage(");
    expect(capture).toContain("NavigationPolicy.mayCapture(requester: requester, isMainFrame: frame.isMainFrame, saved: self.origin) ? .grant : .deny");
  });

  it("decides every Android navigation and capture with the tested NavigationPolicy (I3)", () => {
    const activity = java("WorkspaceActivity.java");
    const between = (from: string, to: string) => activity.slice(activity.indexOf(from), activity.indexOf(to, activity.indexOf(from)));
    expect(between("private boolean mayShowInMainFrame(", "@Override")).toContain(
      "return NavigationPolicy.decide(url, NavigationPolicy.Target.MAIN_FRAME, origin) == NavigationPolicy.Decision.ALLOW;",
    );
    const override = between("public boolean shouldOverrideUrlLoading(", "/**");
    expect(override).toContain("switch (NavigationPolicy.decide(url, request.isForMainFrame() ? NavigationPolicy.Target.MAIN_FRAME : NavigationPolicy.Target.SUBFRAME, origin)) {");
    expect(override).toMatch(/case ALLOW:\s*return false;/);
    expect(override).toMatch(/case SEND_OUT:[\s\S]{0,120}openOutside\(request\.getUrl\(\)\);[^\n]*\s*return true;/);
    expect(override).toMatch(/default:\s*return true;/);
    expect(override.match(/return false;/g)).toHaveLength(1);
    expect(between("public void onPermissionRequest(", "List<String> needed")).toContain(
      "if (!NavigationPolicy.mayCapture(request.getOrigin().toString(), null, origin)) {",
    );
    // P19: no file:// or content:// in the workspace WebView.
    const create = between("private void createWebView()", "private String enterPath(");
    expect(create).toContain("settings.setAllowFileAccess(false);");
    expect(create).toContain("settings.setAllowContentAccess(false);");
    expect(create).toContain("settings.setSupportMultipleWindows(false);");
  });

  it("trims launcher input and scanned codes with the shared rule, never Foundation's whitespace set (M4)", () => {
    const ios = [...files("ios/App/MurageShell/Sources"), ...files("ios/App/App")].filter((path) => path.endsWith(".swift"));
    for (const path of ios) expect(read(path).replace(/\/\/.*$/gm, ""), path).not.toContain(".whitespacesAndNewlines");
    const coordinator = swift("ShellCoordinator.swift");
    expect(coordinator.match(/WorkspaceOrigin\(string: WorkspaceOrigin\.trimInput\(originString\)\)/g)).toHaveLength(2);
  });

  it("closes on a main-frame load error only for the workspace's own document (M3)", () => {
    const activity = java("WorkspaceActivity.java");
    const error = activity.slice(activity.indexOf("public void onReceivedError("), activity.indexOf("public void onReceivedSslError("));
    const own = error.indexOf("if (!NavigationPolicy.isOwnMainDocument(request.getUrl().toString(), true, origin)) {");
    expect(own).toBeGreaterThan(-1);
    expect(own).toBeLessThan(error.indexOf("close(CloseReason.UNREACHABLE)"));
    expect(error.slice(own, error.indexOf("mainDocumentFailed = true;"))).toMatch(/leftOrigin\(view, [^)]*\)[\s\S]*armDeadline\(\);\s*return;/);
  });

  it("runs native events through the scripts that check the origin inside (M6)", () => {
    expect(swift("WorkspaceViewController.swift")).toContain('ChannelScript.iosEmit,\n            arguments: ["name": name, "detail": detail ?? NSNull(), "origin": origin.serialized]');
    expect(swift("WorkspaceViewController.swift").match(/callAsyncJavaScript\(/g)).toHaveLength(1);
    const activity = java("WorkspaceActivity.java");
    expect(activity).toContain("webView.evaluateJavascript(ChannelScript.emit(name, detail, origin.serialized()), value -> {");
    expect(activity.replace(/\/\*\*.*\*\//g, "")).not.toContain("__murageNativeEmit");
  });

  it("writes a save only as a plain name directly inside its fresh directory, on both iOS paths (M1)", () => {
    const saves = swift("SaveController.swift");
    const create = saves.slice(saves.indexOf("func create(id: String, filename: String)"), saves.indexOf("func append("));
    expect(create).toMatch(/guard let file = FileNames\.contained\(filename, in: directory\) else \{\s*Self\.remove\(directory\)\s*throw ChannelError\.writeFailed/);
    const destination = saves.slice(saves.indexOf("decideDestinationUsing"), saves.indexOf("func downloadDidFinish("));
    expect(destination).toMatch(/guard let destination = FileNames\.contained\(FileNames\.safe\([^)]*\), in: directory\) else \{\s*FileSink\.remove\(directory\)\s*finish\(key, error: \.writeFailed\)\s*completionHandler\(nil\)/);
    expect(saves).not.toMatch(/freshDirectory\(\)\.appendingPathComponent/);
  });

  it("never lets a foreign frame's download reach the share sheet on iOS (M2)", () => {
    const vc = swift("WorkspaceViewController.swift");
    expect(vc).toContain("if action.shouldPerformDownload { decisionHandler(fromPage(action.sourceFrame) ? .download : .cancel); return }");
    const response = vc.slice(vc.indexOf("decidePolicyFor response:"), vc.indexOf("navigationAction: WKNavigationAction, didBecome download"));
    // A frame's non-HTTP response (blob:, data:) never becomes a download; HTTP ones meet the origin check in SaveController.
    expect(response).toMatch(/!response\.isForMainFrame && !\(response\.response is HTTPURLResponse\)[\s\S]{0,120}decisionHandler\(\.cancel\)/);
  });

  it("always answers the page's saveFile promise from the share sheet (M9)", () => {
    const share = swift("SaveController.swift").split("private func share(")[1] ?? "";
    expect(share).toMatch(/host\.isBeingDismissed \|\| host\.isBeingPresented \|\| host\.transitionCoordinator != nil/);
    expect(share).toContain("Self.presentTimeout");
    expect(share).toMatch(/sheet\?\.presentingViewController == nil[\s\S]{0,160}FileSink\.remove\(directory\)[\s\S]{0,80}answer\(\.unavailable\)/);
    expect(share).toContain("host.present(sheet, animated: true) { answer(nil) }");
  });

  it("never builds a Capacitor bridge for the throwaway re-entry launcher (I2)", () => {
    const main = java("MainActivity.java");
    // BridgeActivity.onCreate ends in load(), which builds the bridge (and loads CapacitorCookies).
    expect(main).toMatch(/@Override protected void load\(\) \{\s*if \(reentry\) return;[^}]*super\.load\(\);\s*\}/);
    const create = main.split("protected void onCreate(")[1] ?? "";
    expect(create.indexOf("reentry = true;")).toBeLessThan(create.indexOf("super.onCreate(state);"));
  });
});

describe("Tailscale follow-up (P27 on the iPhone)", () => {
  const coordinator = () => read("ios/App/MurageShell/Sources/MurageShell/ShellCoordinator.swift");
  const between = (text: string, from: string, to: string) => {
    const start = text.indexOf(from);
    return start < 0 ? "" : text.slice(start, text.indexOf(to, start + from.length));
  };

  it("lists exactly the tailscale scheme for canOpenURL", () => {
    const plist = read("ios/App/App/Info.plist");
    expect(plist).toMatch(/<key>LSApplicationQueriesSchemes<\/key>\s*<array>\s*<string>tailscale<\/string>\s*<\/array>/);
  });

  it("opens Tailscale itself when iOS can, and its App Store page otherwise or when that open fails", () => {
    const open = between(coordinator(), "public func openTailscale()", "private func tailscaleStatus()");
    expect(coordinator()).toContain('URL(string: "tailscale://")!');
    expect(open).toContain("guard UIApplication.shared.canOpenURL(Self.tailscaleApp) else {");
    expect(open).toContain("UIApplication.shared.open(Self.tailscaleApp) { opened in");
    expect(open).toContain("if !opened { UIApplication.shared.open(Self.tailscaleStore) }");
  });

  it("reads connected from up interfaces only, through the shared core rule, on both platforms", () => {
    expect(coordinator()).toContain("guard entry.pointee.ifa_flags & live == live");
    expect(coordinator()).toContain("TailscaleStatus.ios(opensScheme:");
    const shell = read("android/app/src/main/java/com/murage/mobile/Shell.java");
    expect(shell).toContain("if (!each.isUp()) continue;");
    expect(shell).toContain("TailscaleStatus.android(installed, interfaceAddresses())");
    expect(shell).toContain("getPackageInfo(TAILSCALE, 0)");
    expect(read("android/app/src/main/AndroidManifest.xml")).toMatch(/<queries>\s*<package android:name="com\.tailscale\.ipn" \/>\s*<\/queries>/);
  });
});

describe("Plan 3b I1: the iOS push project", () => {
  const project = () => read("ios/App/App.xcodeproj/project.pbxproj");

  it("builds a Notification Service Extension that links only the Foundation core", () => {
    expect(project()).toContain('productType = "com.apple.product-type.app-extension";');
    expect(project()).toContain("PRODUCT_BUNDLE_IDENTIFIER = com.murage.mobile.NotificationService;");
    expect(project()).toMatch(/dstSubfolderSpec = 13;[\s\S]*NotificationService\.appex in Embed Foundation Extensions/);
    const nse = project().slice(project().indexOf("/* NotificationService */ = {\n\t\t\tisa = PBXNativeTarget;"));
    expect(nse.slice(0, nse.indexOf("};"))).toContain("MurageShellCore");
    expect(nse.slice(0, nse.indexOf("};"))).not.toMatch(/\bMurageShell \*\//);
    expect(read("ios/App/MurageShell/Package.swift")).toContain('.library(name: "MurageShellCore", targets: ["MurageShellCore"])');
  });

  it("the app's own Keychain group stays first, so Plan 2's items stay app-only", () => {
    const app = read("ios/App/App/App.entitlements");
    const groups = app.slice(app.indexOf("<key>keychain-access-groups</key>"));
    expect(groups.indexOf("$(AppIdentifierPrefix)com.murage.mobile<")).toBeGreaterThan(-1);
    expect(groups.indexOf("$(AppIdentifierPrefix)com.murage.mobile<")).toBeLessThan(groups.indexOf("$(AppIdentifierPrefix)com.murage.mobile.shared<"));
    for (const key of ["aps-environment", "com.apple.developer.devicecheck.appattest-environment", "com.apple.security.application-groups", "com.apple.developer.usernotifications.time-sensitive"]) {
      expect(app).toContain(`<key>${key}</key>`);
    }
  });

  it("the extension can read the shared group and the App Group, nothing else", () => {
    const nse = read("ios/App/NotificationService/NotificationService.entitlements");
    expect(nse).toContain("group.com.murage.mobile");
    expect(nse).toContain("$(AppIdentifierPrefix)com.murage.mobile.shared");
    expect(nse).not.toContain("$(AppIdentifierPrefix)com.murage.mobile<");
    expect(nse).not.toContain("aps-environment");
  });

  it("both Info.plists name the groups", () => {
    for (const plist of ["ios/App/App/Info.plist", "ios/App/NotificationService/Info.plist"]) {
      expect(read(plist)).toContain("<key>MurageKeychainGroup</key>");
      expect(read(plist)).toContain("<string>group.com.murage.mobile</string>");
    }
  });
});

describe("Plan 3b A1: Android push project", () => {
  it("declares the messaging service and the action receiver, and asks to post notifications", () => {
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain('android:name="android.permission.POST_NOTIFICATIONS"');
    expect(manifest).toMatch(/<service\s+android:name="\.MurageMessagingService"\s+android:exported="false">[\s\S]*com\.google\.firebase\.MESSAGING_EVENT/);
    expect(manifest).toMatch(/<receiver\s+android:name="\.PushActionReceiver"\s+android:exported="false"/);
  });
  it("has three channels at the spec's importance", () => {
    const channels = read("android/app/src/main/java/com/murage/mobile/PushChannels.java");
    expect(channels).toContain('"approvals", "Approvals", NotificationManager.IMPORTANCE_HIGH');
    expect(channels).toContain('"questions", "Questions", NotificationManager.IMPORTANCE_DEFAULT');
    expect(channels).toContain('"finished", "Finished", NotificationManager.IMPORTANCE_LOW');
  });
  it("keeps every push secret out of the repository", () => {
    const tracked = [...files("android"), ...files("ios"), ...files("contract"), ...files("scripts")];
    expect(tracked.filter((p) => /google-services\.json$|AuthKey_.*\.p8$|service-account.*\.json$|push-relay\.token$/.test(p))).toEqual([]);
    expect(read(".gitignore")).toContain("android/app/google-services.json");
    expect(read("scripts/android-remote.sh")).toContain('GS="$HOME/.config/murage-mobile/google-services.json"');
  });
});

describe("Plan 3b I2: PushKeysGuard, where each push secret lives on iOS", () => {
  const stores = () => read("ios/App/MurageShell/Sources/MurageShellCore/PushStores.swift");
  it("respond is readable only while unlocked, and never in the shared group", () => {
    expect(stores()).toMatch(/case \.respond:\s*return \("com\.murage\.mobile\.push\.respond", kSecAttrAccessibleWhenUnlockedThisDeviceOnly, nil\)/);
  });
  it("detail is readable after first unlock, in the shared group only", () => {
    expect(stores()).toMatch(/case \.detail:\s*return \("com\.murage\.mobile\.push\.detail", kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, sharedGroup\)/);
  });
  it("the device secret is app-only", () => {
    expect(stores()).toMatch(/case \.deviceSecret:\s*return \("com\.murage\.mobile\.push\.device", kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, nil\)/);
  });
  it("the extension's sources never mention the respond secret", () => {
    expect(read("ios/App/NotificationService/NotificationService.swift")).not.toMatch(/respond/i);
  });
});

describe("Plan 3b I3: the extension always answers", () => {
  const nse = () => read("ios/App/NotificationService/NotificationService.swift");
  it("delivers generic text on expiry, with a single delivery", () => {
    expect(nse()).toContain("override func serviceExtensionTimeWillExpire()");
    expect(nse()).toMatch(/serviceExtensionTimeWillExpire\(\) \{\s*deliverOnce\(\)/);
  });
  it("fetches with a 5 second deadline, no cookies and no cache", () => {
    expect(nse()).toContain("timeoutIntervalForRequest = 5");
    expect(nse()).toContain("timeoutIntervalForResource = 5");
    expect(nse()).toContain("URLSessionConfiguration.ephemeral");
  });
  it("logs nothing about content", () => {
    expect(nse()).not.toMatch(/os_log|print\(|NSLog/);
  });
  it("never follows a redirect, and caps the body", () => {
    const core = read("ios/App/MurageShell/Sources/MurageShellCore/PushExtension.swift");
    expect(core).toMatch(/willPerformHTTPRedirection[^{]*\{\s*completionHandler\(nil\)/);
    expect(core).toContain("session.bytes(for: request, delegate: NoRedirects())");
    expect(core).toContain("static let bodyCap = 64 * 1024");
  });
});

describe("Plan 3b I4: iOS categories and registration", () => {
  const categories = () => read("ios/App/MurageShell/Sources/MurageShell/PushCategories.swift");
  it("every lock-screen action needs the phone unlocked", () => {
    const actions = categories().match(/UNNotificationAction\([^)]*\)/g) ?? [];
    expect(actions.length).toBe(3);
    for (const a of actions) expect(a).toContain(".authenticationRequired");
  });
  it("a risky approval offers Deny and Open only", () => {
    expect(categories()).toMatch(/"APPROVAL_OPEN", actions: actions \? \[deny, open\] : \[open\]/);
  });
  it("App Attest hashes the relay's challenge exactly as the relay does", () => {
    expect(read("ios/App/MurageShell/Sources/MurageShell/PushRegistrar.swift")).toContain("SHA256.hash(data: Data(challenge.utf8))");
  });
});

describe("Plan 3b I4 fix: the relay client and the relay's contract", () => {
  const client = () => read("ios/App/MurageShell/Sources/MurageShell/RelayClient.swift");
  it("the device secret never follows a redirect, and every call is capped at 15 s", () => {
    expect(client()).toContain("willPerformHTTPRedirection");
    expect(client()).toContain("completionHandler(nil)");
    expect(client()).toContain("URLSessionConfiguration.ephemeral");
    expect(client()).toContain("timeoutIntervalForResource = 15");
    expect(client()).not.toContain("URLSession.shared");
  });
  it("the relay's answer is body-capped like every push call (final review M6)", () => {
    expect(client()).toContain("await PushExtension.send(request.urlRequest(origin: origin), session: session)");
    expect(client()).not.toContain("session.data(");
  });
  it("relay-requests.json names routes and fields the relay really has", () => {
    const relay = readFileSync(join(ROOT, "../../cloudflare/push-relay/src/relay.ts"), "utf8");
    const cases = JSON.parse(read("contract/relay-requests.json")) as { method: string; path: string; body: string[] | null }[];
    for (const c of cases) {
      if (c.path.endsWith("/:id")) expect(relay).toContain(`request.method === "${c.method}" && deleting`);
      else expect(relay).toContain(`request.method === "${c.method}" && path === "${c.path}"`);
    }
    const registration = relay.slice(relay.indexOf("const registration"), relay.indexOf("async function body"));
    for (const key of cases.find((c) => c.path === "/v1/devices")?.body ?? []) expect(registration).toMatch(new RegExp(`\\b${key}[,:]`));
    const approval = relay.slice(relay.indexOf("const approvalKeyRequest"), relay.indexOf("async function body"));
    for (const key of cases.find((c) => c.path === "/v1/approval-keys")?.body ?? []) expect(approval).toMatch(new RegExp(`\\b${key}[,:]`));
  });
});

describe("Plan 3b I5: iOS taps and actions", () => {
  const responder = () => read("ios/App/MurageShell/Sources/MurageShell/PushResponder.swift");
  const coordinator = () => read("ios/App/MurageShell/Sources/MurageShell/ShellCoordinator.swift");
  // The request builders and the answer flow live in MurageShellCore (tested
  // with fakes by PushResponseTests); the responder is the UIKit glue.
  const core = () => read("ios/App/MurageShell/Sources/MurageShellCore/PushResponse.swift");
  it("a tap routes by binding and fences by origin", () => {
    expect(responder()).toContain("ledger?.origin(payload.bindingId)");
    expect(coordinator()).toMatch(/func openFromNotification\(origin: WorkspaceOrigin[\s\S]*PendingOpen\(origin: origin/);
  });
  it("a removed workspace drops the tap with a notice", () => {
    expect(responder()).toContain('ShellCoordinator.shared.showNotice(code: "removedWorkspace")');
  });
  it("an action answers with the respond secret, strict body, and always leaves a notice", () => {
    expect(responder()).toContain("PushKeychain.read(secret: .respond, account: payload.bindingId)");
    expect(core()).toContain('["requestId": requestId, "decision": decision, "revision": revision]');
    expect(responder()).toContain("await postNotice(notice, for: response.notification)");
  });
  it("reconciles every workspace when the app becomes active", () => {
    expect(read("ios/App/App/SceneDelegate.swift")).toContain("PushSetup.becameActive()");
    expect(core()).toContain("/api/mobile/push/pending");
  });
  it("the respond bearer never follows a redirect, has a deadline, and goes only to the bound origin", () => {
    expect(responder()).toContain("URLSessionConfiguration.ephemeral");
    expect(responder()).toContain("timeoutIntervalForResource = seconds");
    expect(responder()).toContain("PushExtension.send(request, session: session)");
    expect(responder()).not.toContain("URLSession.shared");
    expect(core()).toMatch(/static func origin\(_ text: String\?\)[\s\S]*\.serialized == text/);
    expect(core()).toContain('PushPattern.token(token, prefix: "murage_pr_")');
  });
  it("an action never trusts a target the notification carried", () => {
    const answer = core().slice(core().indexOf("static func answer("), core().indexOf("static func tapTarget("));
    expect(answer).not.toContain("userInfo");
    // The respond token is read before the detail read, while the phone is surely unlocked.
    expect(answer.indexOf("respondToken()")).toBeLessThan(answer.indexOf("detailToken()"));
    // A tap target that came with the push (relay-built) is dropped before the extension's own fetch.
    expect(read("ios/App/NotificationService/NotificationService.swift")).toMatch(/mutableCopy\(\) as\? UNMutableNotificationContent\s*(\/\/.*\s*)*best\?\.userInfo\["murageTarget"\] = nil/);
  });
  it("a cold-start tap waits for the launch-time open instead of presenting from an off-screen launcher", () => {
    const tap = coordinator().slice(coordinator().indexOf("func openFromNotification("), coordinator().indexOf("func showNotice("));
    expect(tap).toMatch(/guard autoOpened else \{ notificationOrigin = origin; return \}[\s\S]*present\(origin: origin/);
    expect(tap).not.toContain("autoOpened = true");
  });
  it("the delegate is set at launch, and the launcher hears notices even before it listens", () => {
    expect(read("ios/App/MurageShell/Sources/MurageShell/PushServices.swift")).toMatch(/static func launch\(\) \{\s*UNUserNotificationCenter\.current\(\)\.delegate = PushResponder\.shared/);
    expect(read("ios/App/App/ShellPlugin.swift")).toMatch(/notifyListeners\("notice", data: \["code": code\], retainUntilConsumed: true\)/);
  });
});

describe("Plan 3b final review I2: iOS clears the notifications of a binding it no longer holds", () => {
  const shell = (f: string) => read(`ios/App/MurageShell/Sources/MurageShell/${f}`);
  const core = () => read("ios/App/MurageShell/Sources/MurageShellCore/PushResponse.swift");
  it("forget and the launch sweep remove a dropped binding's delivered notifications, as Android's cancelFor does", () => {
    const services = shell("PushServices.swift");
    expect(services).toMatch(/func forget\(serialized origin: String\) \{[\s\S]*?clearDelivered\(of: \[removed\]\)[\s\S]*?onForget\?\(removed\)/);
    expect(services).toMatch(/func sweep\(knownOrigins: Set<String>\) \{[\s\S]*?clearDelivered\(of: Set\(out\.dropped \+ out\.orphans\)\)/);
    expect(services).toMatch(/private func clearDelivered\(of dropped: Set<String>\) \{[\s\S]*?PushResponse\.delivered\(delivered, of: dropped\)[\s\S]*?removeDeliveredNotifications/);
  });
  it("reconcile sweeps unbound notifications but keeps a pending replace's: waiting replaces read first, then the ledger", () => {
    const reconcile = core().slice(core().indexOf("static func reconcile("));
    expect(reconcile).toMatch(/let kept = await keep\(\)\s*guard let after = ledger\.read\(\) else \{ return \(remove, nil\) \}\s*remove \+= unbound\(delivered, bound: Set\(after\.bindingIds\), keep: kept\)/);
    // Main-actor state is read on the main actor, never from the reconcile's thread.
    expect(shell("PushResponder.swift")).toContain("keep: { await MainActor.run { PushRegistrar.shared.pendingBindingIds } }");
  });
});

describe("Plan 3b re-register fix: iOS never replaces a working binding on a locked or leaving phone", () => {
  const shell = (f: string) => read(`ios/App/MurageShell/Sources/MurageShell/${f}`);
  const core = (f: string) => read(`ios/App/MurageShell/Sources/MurageShellCore/${f}`);
  it("registerPush and issuePushTokens wait for the person: not in the background, not while protected data is locked", () => {
    const vc = shell("WorkspaceViewController.swift");
    const helper = vc.match(/private func pushWhilePresent\([\s\S]*?\n {4}\}/)?.[0] ?? "";
    expect(helper).toMatch(/applicationState != \.background/);
    expect(helper).toMatch(/isProtectedDataAvailable/);
    expect(vc).toMatch(/case \.registerPush:\s*guard let push else \{[^\n]*\}\s*guard pushWhilePresent\("push register deferred"\) else \{ reply\(nil, ChannelError\.unavailable\.rawValue\); return \}/);
    expect(vc).toMatch(/case \.issuePushTokens:[^\n]*\n[^\n]*\n\s*guard pushWhilePresent\("push issue deferred"\) else \{ reply\(nil, ChannelError\.unavailable\.rawValue\); return \}\s*guard let push, push\.issuePushTokens/);
  });
  it("a replace keeps the old binding until issuePushTokens adopts the new one", () => {
    const enrolment = core("PushEnrolment.swift");
    expect(enrolment).not.toMatch(/if binding != nil \{ forget\(origin\) \}/);
    expect(enrolment).toMatch(/pending\[origin\] = \(bindingId, old\)/);
    expect(shell("PushServices.swift")).toMatch(/PushRegistrar\.shared\.adopt\(origin: origin, bindingId: tokens\.bindingId\)\s*return bindings\.issue/);
  });
  it("a dropped install, or a forgotten workspace, takes its pending replaces with it", () => {
    expect(core("PushEnrolment.swift")).toMatch(/func dropInstall\(failing: String\) \{\s*guard installSecret == failing else \{ return \}[\s\S]*?pending\.removeAll\(\)/);
    expect(shell("PushServices.swift")).toMatch(/func forget\(serialized origin: String\) \{\s*PushRegistrar\.shared\.cancelPending\(origin: origin\)/);
  });
  it("issuePushTokens reads expiresAt as WebKit sends it: a double NSNumber (the iPhone churn of 2026-09-28)", () => {
    const contract = core("PushContract.swift");
    const parse = contract.match(/public struct IssuedTokens[\s\S]*?\n\}/)?.[0] ?? "";
    expect(parse).toMatch(/let expiresAt = channelInteger\(o\["expiresAt"\]\)/);
    expect(parse).not.toMatch(/JSONInteger\.value\(o\[/);
    expect(parse).toMatch(/if !CFNumberIsFloatType\(number\) \{ return JSONInteger\.value\(number\) \}/);
    expect(parse).toMatch(/double\.rounded\(\) == double, abs\(double\) <= 9_007_199_254_740_991/);
    expect(shell("WorkspaceViewController.swift")).toMatch(/guard let tokens = IssuedTokens\.parse\(request\.args\) else \{ ShellLog\.channelRefused\(\.badArgs\);/);
  });
  it("the registerPush plan is logged in debug builds only, with booleans and no ids", () => {
    const log = shell("ShellLog.swift");
    const debug = log.match(/#if DEBUG[\s\S]*?#endif/)?.[0] ?? "";
    expect(debug).toMatch(/static func pushPlan\(_ d: PushEnrolment\.Decision\)/);
    expect(log.replace(debug, "")).not.toMatch(/pushPlan/);
    const line = debug.match(/func pushPlan[\s\S]*?\n {4}\}/)?.[0] ?? "";
    expect(line).toMatch(/plan=.*bound=.*detail=.*fresh=/);
    expect(line).not.toMatch(/binding(Id)?\b|token|grant|secret/i);
    expect(shell("PushRegistrar.swift")).toMatch(/#if DEBUG\s*enrolment\.onDecision = \{ ShellLog\.pushPlan\(\$0\) \}\s*#endif/);
    expect(core("PushEnrolment.swift")).toMatch(/onDecision\?\(Decision\(plan: plan, permission: permission, bound: binding != nil, hasDetail: hasDetail, fresh: fresh\)\)/);
  });
  it("issue writes respond before touching detail, so a refused respond write keeps the old pair", () => {
    const stores = core("PushStores.swift");
    expect(stores).not.toMatch(/let id = tokens\.bindingId\s*\n\s*secrets\.delete\(secret: \.detail/);
    expect(stores).toMatch(/let id = tokens\.bindingId\s*guard secrets\.write\(tokens\.respond, secret: \.respond, account: id\) else \{ return false \}/);
  });
});


describe("SEC-006: iOS fresh authentication", () => {
  const keys = read("ios/App/MurageShell/Sources/MurageShell/ApprovalKeys.swift");
  const vc = read("ios/App/MurageShell/Sources/MurageShell/WorkspaceViewController.swift");
  const coordinator = read("ios/App/MurageShell/Sources/MurageShell/ShellCoordinator.swift");
  it("uses a Secure Enclave key that needs user presence and a passcode", () => {
    expect(keys).toContain("SecureEnclave.P256.Signing.PrivateKey(accessControl:");
    expect(keys).toContain("kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly");
    expect(keys).toMatch(/\[\.privateKeyUsage, \.userPresence\]/);
  });
  it("authenticates every time with a fresh context", () => {
    expect(keys).toContain("touchIDAuthenticationAllowableReuseDuration = 0");
    expect(keys).toContain(".deviceOwnerAuthentication");
    expect(keys).not.toContain(".deviceOwnerAuthenticationWithBiometrics");
  });
  it("keeps the software key to the simulator", () => {
    const software = keys.indexOf("P256.Signing.PrivateKey()");
    expect(software).toBeGreaterThan(-1);
    expect(keys.lastIndexOf("#if targetEnvironment(simulator)", software)).toBeGreaterThan(-1);
  });
  it("signs only ApprovalRequest.message", () => {
    expect(keys).toContain("signature(for: request.message)");
  });
  it("never logs key material, signatures or nonces", () => {
    expect(keys).not.toMatch(/ShellLog|print\(|NSLog|os_log|Logger/);
  });
  it("asks for Face ID with a reason", () => {
    const plist = read("ios/App/App/Info.plist");
    expect(plist).toContain("<key>NSFaceIDUsageDescription</key>");
    const reason = plist.match(/<key>NSFaceIDUsageDescription<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? "";
    expect(reason.length).toBeGreaterThan(10);
    expect(reason).not.toMatch(/—|\bsafe|\bsafety/i);
  });
  it("routes approveWithDevice only while active and one at a time", () => {
    expect(vc).toMatch(/case \.approveWithDevice:/);
    expect(vc).toContain("ChannelError.busy.rawValue");
    expect(vc).toContain("ApprovalRequest.parse(request.args)");
    expect(vc).toContain("UIApplication.shared.applicationState == .active");
  });
  it("makes the key at pairing and removes it on sign-out, removal and re-pair", () => {
    expect(coordinator).toContain("ApprovalKeys.enrol(origin: origin)");
    expect(coordinator).toContain("ApprovalKeys.remove(origin: origin)");
    expect(coordinator).toContain("reason == .signedOut");
  });
  it("drops any older key when enrolment fails or is not offered, so P9 never sends a stale one", () => {
    expect(coordinator).toContain("approvalKey = ApprovalKeys.enrol(origin: origin)");
    expect(coordinator).toContain("if approvalKey == nil { ApprovalKeys.remove(origin: origin) }");
  });
  it("sends the key only with the relay statement, through ApprovalAttestation.enterPath (P9)", () => {
    expect(coordinator).toContain("ApprovalAttestation.statement(transport: RelayClient(), attester: AppAttester()");
    expect(coordinator).toContain("ApprovalAttestation.enterPath(credential: credential");
    expect(coordinator).not.toMatch(/PairingLink\.enterPath\([^)]*approvalKey/);
    expect(coordinator).not.toMatch(/ShellLog\.event\("[^"]*(\\\(|" *\+)/);
  });
});

describe("minimum host capability before desktop loading", () => {
  const ios = (file: string) => read(`ios/App/MurageShell/Sources/${file}`);
  const android = (file: string) => read(`android/app/src/main/java/com/murage/mobile/${file}`);

  it("iOS reads mobile as a JSON integer, rejecting strings, booleans and fractions", () => {
    const probe = ios("MurageShellCore/ProbeVerdict.swift");
    expect(probe).toContain('JSONInteger.value(json["mobile"]) == 1');
    expect(probe).toContain('let hostCapability = JSONInteger.value(json["mobileFeatures"])');
    expect(probe).toContain("raw as? NSNumber");
    expect(probe).toContain("CFGetTypeID(number) != CFBooleanGetTypeID()");
    expect(probe).toContain("!CFNumberIsFloatType(number)");
    expect(probe).toContain("public let hostCapability: Int64?");
    expect(probe).toContain("(hostCapability ?? 0) >= 1");
    expect(probe).toContain("guard status == 200");
  });

  it("Android reads mobile only from integer JSON number types", () => {
    const probe = android("shell/ProbeVerdict.java");
    expect(probe).toContain('Object mobile = json.opt("mobile")');
    expect(probe).toContain('Object features = json.opt("mobileFeatures")');
    expect(probe).toContain("mobile instanceof Integer || mobile instanceof Long) || ((Number) mobile).longValue() != 1");
    expect(probe).toContain("features instanceof Integer || features instanceof Long ? ((Number) features).longValue() : null");
    expect(probe).toContain("public final Long hostCapability");
    expect(probe).toContain("hostCapability != null && hostCapability >= 1");
    expect(probe).toContain("if (status != 200 || body == null) return new ProbeVerdict(Kind.BASIC, null)");
  });

  it("returns capability to the launcher and stops unsupported opens before native presentation", () => {
    const coordinator = ios("MurageShell/ShellCoordinator.swift");
    const start = coordinator.indexOf("public func open(originString:");
    const gate = coordinator.indexOf("guard verdict.hostCapabilityOk else { return .success(verdict) }", start);
    expect(gate).toBeGreaterThan(start);
    expect(gate).toBeLessThan(coordinator.indexOf("if let failure = present(", start));
    const shell = android("Shell.java");
    const finish = shell.slice(shell.indexOf("private void finishOpen("), shell.indexOf("String startWorkspace("));
    expect(finish).toMatch(/if \(!verdict.hostCapabilityOk\(\)\) \{\s*done.opened\(verdict\);\s*return;/);
    expect(finish.indexOf("!verdict.hostCapabilityOk()")).toBeLessThan(finish.indexOf("startWorkspace("));
    expect(read("ios/App/App/ShellPlugin.swift")).toContain('result["hostCapability"] = hostCapability');
    expect(android("ShellPlugin.java")).toContain('result.put("hostCapability", verdict.hostCapability)');
  });

  it("startup and notification workspaces wait for a probe before loading any desktop page", () => {
    const swift = ios("MurageShell/WorkspaceViewController.swift");
    expect(swift).toContain("if verdict == nil { probeBeforeLoading(path: startPath) }");
    expect(swift).toContain("guard !closing, verdict?.hostCapabilityOk == true else { return }");
    expect(swift).toContain("guard verdict.hostCapabilityOk else { self.close(.updateRequired); return }");
    const java = android("WorkspaceActivity.java");
    expect(java).toContain('if (mode == null || state != null) mode = "unknown"');
    expect(java).toContain("if (hostCapabilityChecked) load(path);\n        else probeBeforeLoading(path);");
    expect(java).toContain("if (closing || webView == null || !hostCapabilityChecked) return;");
    expect(java).toContain("if (!verdict.hostCapabilityOk()) { close(CloseReason.UPDATE_REQUIRED); return; }");
  });
});
