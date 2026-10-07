// Plan 3b A2's native-guard block, kept in its own file so it does not collide
// with the iOS task (I2) appending to native-guards.test.ts at the same time.
// Same read() helper as native-guards.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)); // apps/mobile
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("Plan 3b A2: where each push secret lives on Android", () => {
  const store = () => read("android/app/src/main/java/com/murage/mobile/PushStore.java");
  it("respond needs an unlocked device; detail does not", () => {
    expect(store()).toMatch(/RESPOND_ALIAS[\s\S]*setUnlockedDeviceRequired\(true\)/);
    expect(store()).toMatch(/keystoreKeys\(DETAIL_ALIAS, false\)/);
    expect(store()).toMatch(/keystoreKeys\(RESPOND_ALIAS, true\)/);
  });
  it("the messaging service never reads the respond token", () => {
    expect(read("android/app/src/main/java/com/murage/mobile/MurageMessagingService.java")).not.toMatch(/respond\(/);
  });
});

describe("Plan 3b A3: the messaging service builds the notification itself", () => {
  const service = () => read("android/app/src/main/java/com/murage/mobile/MurageMessagingService.java");
  it("tags each notification with its collapse key and fetches through the 5 s helper", () => {
    expect(service()).toMatch(/\.notify\(p\.collapseKey, 1, /);
    expect(service()).toMatch(/PushDetailFetch\.fetch\(FETCH, PushDetailFetch\.door\(/);
    expect(read("android/app/src/main/java/com/murage/mobile/PushDetailFetch.java")).toMatch(/DEADLINE_MS = 5000;/);
  });
  it("demands an unlock for lock-screen answers, and only from API 31", () => {
    expect(service()).toMatch(/if \(plan\.authRequired\) a\.setAuthenticationRequired\(true\);/);
    expect(read("android/app/src/main/java/com/murage/mobile/shell/NotificationPlan.java")).toMatch(/lockScreenActions && sdk >= 31/);
  });
  it("logs nothing from the payload or the detail", () => {
    for (const f of ["MurageMessagingService.java", "PushDetailFetch.java", "PushHttp.java"]) {
      const lines = read(`android/app/src/main/java/com/murage/mobile/${f}`).split("\n").filter((l) => l.includes("ShellLog.i("));
      for (const l of lines) expect(l).not.toMatch(/eventRef|token|title|body|threadId|bindingId|url|origin|\bp\./i);
    }
  });
});

describe("Plan 3b A2 fix: Keystore makes the IV, and removed computers lose their tokens", () => {
  const store = () => read("android/app/src/main/java/com/murage/mobile/PushStore.java");
  it("seals like SecureStore: the Keystore picks the IV, never the caller", () => {
    expect(store()).toMatch(/init\(Cipher\.ENCRYPT_MODE, key\);[\s\S]*getIV\(\)/);
    expect(store()).not.toMatch(/ENCRYPT_MODE,\s*key,\s*new GCMParameterSpec/);
    expect(store()).not.toMatch(/setRandomizedEncryptionRequired/);
  });
  it("every open sweeps push bindings against the saved computers", () => {
    expect(read("android/app/src/main/java/com/murage/mobile/MainActivity.java")).toMatch(/PushServices\.get\(this\)\.sweep\(book\)/);
  });
});

describe("Plan 3b A4: Android registration", () => {
  const java = (f: string) => read(`android/app/src/main/java/com/murage/mobile/${f}`);
  it("the relay client talks to the deployed relay and never follows a redirect", () => {
    expect(java("RelayClient.java")).toMatch(/DEFAULT_ORIGIN = "https:\/\/murage-push-relay\.sean-874\.workers\.dev";/);
    expect(java("RelayClient.java")).toMatch(/setInstanceFollowRedirects\(false\)/);
    expect(java("PushHttp.java")).toMatch(/setInstanceFollowRedirects\(false\)/);
    for (const f of ["RelayClient.java", "PushRegistrar.java", "PushEnrolment.java"]) expect(java(f)).not.toMatch(/push\.murage\.ai/);
  });
  it("Debug registers as development, and only Debug takes the murage.relay override", () => {
    expect(java("RelayClient.java")).toMatch(/ENVIRONMENT = BuildConfig\.DEBUG \? "development" : "production";/);
    expect(java("RelayClient.java")).toMatch(/static String overrideOrigin\(String value\) \{\s*if \(!BuildConfig\.DEBUG\) return null;/);
    const main = java("MainActivity.java");
    expect(main).toMatch(/private void applyDebugExtras\(Intent intent\) \{\s*if \(!BuildConfig\.DEBUG\) return;[\s\S]*getStringExtra\("murage\.relay"\)/);
    expect(main.match(/murage\.relay"/g)?.length).toBe(1);
  });
  it("the Play Integrity nonce is the relay's challenge", () => {
    expect(java("PushEnrolment.java")).toMatch(/String integrity = attest\.token\(nonce\);[\s\S]*\.put\("challenge", nonce\)/);
    expect(java("PushRegistrar.java")).toMatch(/IntegrityTokenRequest\.builder\(\)\.setNonce\(nonce\)/);
  });
  it("the device secret is app-only and needs no unlock, and the push token is kept only as a digest", () => {
    const store = java("PushStore.java");
    expect(store).toMatch(/String deviceSecret\(\) \{ return open\("device\.secret", detailKey\); \}/);
    expect(store).toMatch(/putDeviceSecret\(String secret\) \{ return seal\("device\.secret", secret, detailKey\); \}/);
    expect(store).toMatch(/putString\("relay\.token\.sha256", digest\(pushToken\)\)/);
  });
  it("every dropped binding, stray tokens included, is deleted at the relay and retried on open", () => {
    const services = java("PushServices.java");
    expect(services).toMatch(/for \(String bindingId : store\.sweep\(saved\)\) unbound\(bindingId\);/);
    expect(services).toMatch(/if \(removed != null\) \{\s*unbound\(removed\);/);
    expect(services).toMatch(/private void unbound\(String bindingId\) \{\s*PushReconciler\.cancelFor\(app, bindingId\);\s*PushRegistrar\.get\(app\)\.deleteAtRelay\(bindingId\);/);
    expect(services).toMatch(/PushRegistrar\.get\(app\)\.retryDeletes\(\);/);
    expect(java("PushStore.java")).toMatch(/dropped\.addAll\(orphans\);\s*return dropped;/);
    expect(java("PushRegistrar.java")).toMatch(/void deleteAtRelay\(String bindingId\) \{\s*store\(\)\.addRelayDelete\(bindingId\);/);
  });
  it("a rotated FCM token reaches the relay", () => {
    expect(java("MurageMessagingService.java")).toMatch(/onNewToken\(String token\) \{\s*PushRegistrar\.get\(this\)\.tokenChanged\(token\);/);
  });
  it("asks for POST_NOTIFICATIONS once, on API 33 and later", () => {
    const activity = java("WorkspaceActivity.java");
    expect(activity).toMatch(/Build\.VERSION\.SDK_INT >= 33 && !prefs\.getBoolean\("asked", false\)/);
    expect(activity).toMatch(/pushPermissionAsk\.launch\(Manifest\.permission\.POST_NOTIFICATIONS\)/);
    expect(activity).not.toMatch(/case "registerPush":\s*reply\.error\("unavailable"\)/);
    expect(read("android/app/src/main/AndroidManifest.xml")).toMatch(/android\.permission\.POST_NOTIFICATIONS/);
  });
  it("logs no secret, grant, push token, Integrity token or binding id", () => {
    for (const f of ["RelayClient.java", "PushRegistrar.java", "PushEnrolment.java"]) {
      // What each line concatenates besides its literal text: a status, the plan, the route template, a deadline or an exception's class.
      const args = [...java(f).matchAll(/ShellLog\.i\(([^;]*)\);/g)].map((m) => m[1]);
      expect(args.length).toBeGreaterThan(0);
      for (const a of args) {
        const terms = a.replace(/"[^"]*"/g, " ").split("+").map((t) => t.trim()).filter(Boolean);
        for (const t of terms) expect(t).toMatch(/^(status|plan|DEADLINE_MS|route\(method, path\)|\w+\.getClass\(\)\.getSimpleName\(\))$/);
      }
    }
  });
  it("the relay client caps the whole request, not just each read", () => {
    expect(java("RelayClient.java")).toMatch(/static volatile long DEADLINE_MS = 15_000;/);
    expect(java("RelayClient.java")).toMatch(/answer\.get\(DEADLINE_MS, TimeUnit\.MILLISECONDS\)/);
  });
  it("a dropped install takes every binding's tokens, and only when its own secret failed", () => {
    expect(java("PushStore.java")).toMatch(/boolean dropInstall\(String failingSecret\) \{\s*if \(failingSecret == null \|\| !failingSecret\.equals\(deviceSecret\(\)\)\) return false;\s*deleteDeviceSecret\(\);\s*for \(String bindingId : ledger\(\)\.bindingIds\(\)\) deleteTokens\(bindingId\);/);
    expect(java("PushEnrolment.java")).not.toMatch(/deleteDeviceSecret\(/);
  });
  it("overlapping registerPush calls share one flight on one thread", () => {
    const registrar = java("PushRegistrar.java");
    expect(registrar).toMatch(/Executors\.newSingleThreadExecutor\(\)/);
    expect(registrar).toMatch(/new SingleFlight<>\(io, main::post\)/);
    // A5 (A4 review Minor 5): the entry clears in a finally, so an Error cannot strand later calls.
    expect(java("SingleFlight.java")).toMatch(/if \(waiting != null\) \{ waiting\.add\(done\); return; \}/);
    expect(java("SingleFlight.java")).toMatch(/\} finally \{\s*List<Consumer<V>> waiting;\s*synchronized \(inFlight\) \{ waiting = inFlight\.remove\(key\); \}/);
  });
});

describe("Plan 3b A5: Android taps and actions", () => {
  const java = (f: string) => read(`android/app/src/main/java/com/murage/mobile/${f}`);
  const receiver = () => java("PushActionReceiver.java");
  const shell = () => java("Shell.java");
  it("answers off the main thread with the respond token and the strict body, always leaving a notice", () => {
    expect(receiver()).toContain("goAsync()");
    expect(receiver()).toContain("store.respond(bindingId)");
    expect(receiver()).toContain('new JSONObject().put("requestId", requestId).put("decision", decision).put("revision", revision)');
    expect(receiver()).toContain("postNotice(app, intent, result)");
    expect(receiver()).toMatch(/"\/api\/mobile\/push\/respond"/);
  });
  it("a tap routes by binding, fences by origin, and drops a removed computer with a notice", () => {
    expect(shell()).toMatch(/void openFromNotification\(Activity from, WorkspaceOrigin origin[\s\S]*new PendingOpen\(origin/);
    expect(java("MainActivity.java")).toContain('showNotice("removedWorkspace")');
    expect(java("ShellPlugin.java")).toMatch(/notifyListeners\("notice", /);
  });
  it("reconciles when a workspace comes to the front", () => {
    expect(java("WorkspaceActivity.java")).toContain("PushReconciler.run(this)");
    expect(java("PushReconciler.java")).toMatch(/"\/api\/mobile\/push\/pending"/);
  });
  it("every push PendingIntent is told apart by an identifier, never a hashed request code", () => {
    for (const f of ["MurageMessagingService.java", "PushActionReceiver.java"]) {
      expect(java(f)).not.toMatch(/hashCode\(\)/);
      expect(java(f)).toMatch(/setIdentifier\(/);
    }
    expect(java("MurageMessagingService.java")).toMatch(/setIdentifier\(p\.collapseKey \+ "\/" \+ action\)/);
  });
  it("both notification builders use the status-bar icon, not the launcher mipmap (B11)", () => {
    for (const f of ["MurageMessagingService.java", "PushActionReceiver.java"]) {
      expect(java(f)).toMatch(/setSmallIcon\(R\.drawable\.ic_stat_murage\)/);
      expect(java(f)).not.toMatch(/setSmallIcon\(R\.mipmap/);
    }
  });
  it("the ledger records a revision only after the notification is up", () => {
    expect(java("MurageMessagingService.java")).toMatch(/poster\.post\([\s\S]*store\.updateLedger\(l -> l\.accept\(/);
  });
  it("a push request is cut off at its deadline, not just each read", () => {
    expect(java("PushHttp.java")).toMatch(/DEADLINES\.schedule\(open::disconnect, timeoutMs, TimeUnit\.MILLISECONDS\)/);
  });
  it("logs nothing from the payload, the answer or a token", () => {
    for (const f of ["PushActionReceiver.java", "PushReconciler.java"]) {
      const lines = java(f).split("\n").filter((l) => l.includes("ShellLog.i("));
      for (const l of lines) expect(l).not.toMatch(/eventRef|token|title|threadId|bindingId|requestId|url|origin|\bp\./i);
    }
  });
  it("the docs say a risky approval gets Deny and Open", () => {
    const doc = readFileSync(join(ROOT, "../../docs/mobile/phase3/ANDROID-PUSH.md"), "utf8");
    expect(doc).toContain("A risky approval gets Deny and Open");
    expect(doc).not.toContain("Deny only");
  });
});

describe("Plan 3b A5 review fixes: taps, removed computers, answers", () => {
  const java = (f: string) => read(`android/app/src/main/java/com/murage/mobile/${f}`);
  const manifest = () => read("android/app/src/main/AndroidManifest.xml");
  it("every notification tap goes to a non-exported activity by explicit, immutable PendingIntent (Minor 2)", () => {
    expect(manifest()).toMatch(/android:name="\.PushOpenActivity"\s+android:exported="false"/);
    expect(java("PushIntents.java")).toMatch(/new Intent\(context, PushOpenActivity\.class\)\.setAction\(OPEN\)/);
    const service = java("MurageMessagingService.java");
    expect(service).toMatch(/Intent tap = PushIntents\.fill\(PushIntents\.tap\(this\), p, detail\.target\);/);
    expect(java("PushActionReceiver.java")).toMatch(/Intent tap = PushIntents\.tap\(context\)/);
    for (const f of ["MurageMessagingService.java", "PushActionReceiver.java"]) {
      expect(java(f)).not.toMatch(/new Intent\([^)]*MainActivity\.class\)/);
      for (const m of java(f).matchAll(/PendingIntent\.get(?:Activity|Broadcast)\([^;]*;/g)) expect(m[0]).toContain("PendingIntent.FLAG_IMMUTABLE");
    }
  });
  it("the exported launcher never takes a computer or a chat from an intent's extras", () => {
    const main = java("MainActivity.java");
    expect(main).not.toMatch(/getStringExtra\("murage\.(bindingId|threadId|messageId)"\)/);
    expect(main).toMatch(/Shell\.PushTap tap = shell\.takePushTap\(\);/);
    expect(main).toMatch(/PushIntents\.OPEN\.equals\(getIntent\(\)\.getAction\(\)\) && shell\.hasPushTap\(\)/);
    // The old no-bridge trampoline branch for PUSH_OPEN is gone from the launcher.
    expect(main).not.toMatch(/PushIntents\.OPEN\.equals\(launch\.getAction\(\)\)/);
  });
  it("with no live workspace the tap reaches the root launcher with CLEAR_TOP, so no dead workspace stays under it (Minor 3)", () => {
    const open = java("PushOpenActivity.java");
    expect(open).toMatch(/boolean live = shell\.live\(\) != null;/);
    expect(open).toMatch(/shell\.handPushTap\(new Shell\.PushTap\(origin, threadId, messageId\)\);\s*startActivity\(launcher\(this\)\);/);
    expect(open).toMatch(/Intent\.FLAG_ACTIVITY_NEW_TASK \| Intent\.FLAG_ACTIVITY_CLEAR_TOP \| Intent\.FLAG_ACTIVITY_SINGLE_TOP/);
    expect(open).toMatch(/finish\(\);\s*\}/);
    expect(manifest()).toMatch(/\.PushOpenActivity"[\s\S]*?Theme\.NoDisplay/);
  });
  it("a removed computer's notifications go with its binding, and a tap or action says so at once (Minor 7)", () => {
    expect(java("PushServices.java")).toMatch(/private void unbound\(String bindingId\) \{\s*PushReconciler\.cancelFor\(app, bindingId\);/);
    expect(java("PushOpenActivity.java")).toMatch(/if \(origin == null\) Toast\.makeText\(getApplicationContext\(\), R\.string\.removed_workspace/);
    expect(java("PushActionReceiver.java")).toMatch(/if \(result\.removed\) removed\(app, intent\);/);
    expect(java("PushActionReceiver.java")).toMatch(/Toast\.makeText\(context, R\.string\.removed_workspace/);
    const words = read("android/app/src/main/res/values/strings.xml").match(/<string name="removed_workspace">([^<]*)<\/string>/)?.[1];
    expect(read("src/notice.ts")).toContain(`removedWorkspace: "${words}"`);
  });
  it("the respond token is read before the detail re-read (Minor 1, as 927200df on iOS)", () => {
    const r = java("PushActionReceiver.java");
    const respond = r.indexOf("String token = store.respond(bindingId);");
    expect(respond).toBeGreaterThan(0);
    expect(respond).toBeLessThan(r.indexOf("String detail = store.detail(bindingId);"));
  });
  it("a detail re-read that fails or answers 5xx is Couldn't reach (Minor 4)", () => {
    expect(java("PushActionReceiver.java")).toMatch(/if \(got\.status == null \|\| got\.status >= 500\) return new Result\(PushOutcome\.Notice\.UNREACHABLE, null\);/);
  });
  it("reconcile passes coalesce: one running, at most one waiting (Minor 5)", () => {
    expect(java("PushReconciler.java")).toMatch(/new Coalesce\(WORK, \(\) -> pass\(app\)\)/);
    expect(java("PushReconciler.java")).not.toMatch(/WORK\.execute\(/);
    expect(java("Coalesce.java")).toMatch(/if \(running\) \{ again = true; return; \}/);
  });
  it("a bearer goes only to a canonical origin, checked where it is sent (Minor 6)", () => {
    expect(java("PushStore.java")).toMatch(/return origin != null && origin\.serialized\(\)\.equals\(text\) \? origin : null;/);
    expect(java("PushActionReceiver.java")).toMatch(/WorkspaceOrigin bound = store\.canonicalOrigin\(bindingId\);/);
    expect(java("PushReconciler.java")).toMatch(/WorkspaceOrigin origin = store\.canonicalOrigin\(binding\);/);
    expect(java("MurageMessagingService.java")).toMatch(/PushStore\.canonical\(peek\.origin\(p\.bindingId\)\)/);
    expect(java("PushOpenActivity.java")).toMatch(/store\.canonicalOrigin\(intent\.getStringExtra\("murage\.bindingId"\)\)/);
    for (const f of ["PushActionReceiver.java", "PushReconciler.java", "MurageMessagingService.java"]) expect(java(f)).not.toMatch(/ledger\(\)\.origin\(/);
  });
  it("posting the notice cannot crash the app (Minor 8)", () => {
    expect(java("PushActionReceiver.java")).toMatch(/try \{\s*if \(result\.removed\) removed\(app, intent\);\s*else postNotice\(app, intent, result\);\s*\} catch \(RuntimeException unposted\)/);
  });
  it("Allow on a risky approval is refused on the phone (Minor 9)", () => {
    expect(java("PushActionReceiver.java")).toMatch(/a\.category == PushContract\.Category\.APPROVAL_OPEN && "allow"\.equals\(decision\)\) return new Result\(PushOutcome\.Notice\.STEP_UP, null\);/);
  });
  it("the new code logs nothing from the payload, a token or an id", () => {
    // What each line concatenates besides its literal text: the notice's wire name, a count or an exception's class.
    for (const f of ["PushOpenActivity.java", "PushActionReceiver.java", "PushReconciler.java"]) {
      const args = [...java(f).matchAll(/ShellLog\.i\(([^;]*)\);/g)].map((m) => m[1]);
      expect(args.length).toBeGreaterThan(0);
      for (const a of args) {
        const terms = a.replace(/"[^"]*"/g, " ").split("+").map((t) => t.trim()).filter(Boolean);
        for (const t of terms) expect(t).toMatch(/^(notice\.wire|cancel\.size\(\)|\w+\.getClass\(\)\.getSimpleName\(\))$/);
      }
    }
  });
});

describe("Plan 3b re-register fix: Android never replaces a working binding on a locked or leaving phone", () => {
  const java = (f: string) => read(`android/app/src/main/java/com/murage/mobile/${f}`);
  it("registerPush and issuePushTokens wait for an unlocked phone and a started activity", () => {
    const activity = java("WorkspaceActivity.java");
    const helper = activity.match(/private boolean pushWhilePresent\([\s\S]*?\n {4}\}/)?.[0] ?? "";
    expect(helper).toMatch(/isDeviceLocked\(\)/);
    expect(helper).toMatch(/isAtLeast\(Lifecycle\.State\.STARTED\)/);
    expect(activity).toMatch(/case "registerPush": \{\s*if \(!pushWhilePresent\("register"\)\) \{ reply\.error\("unavailable"\); break; \}/);
    expect(activity).toMatch(/if \(!pushWhilePresent\("issue"\)\) \{ reply\.error\("unavailable"\); break; \}\s*if \(!PushServices\.get\(this\)\.issue\(origin, tokens\)\)/);
  });
  it("a replace keeps the old binding until issuePushTokens adopts the new one", () => {
    const enrolment = java("PushEnrolment.java");
    expect(enrolment).not.toMatch(/if \(binding != null\) forget\.run\(\)/);
    expect(enrolment).toMatch(/pending\.put\(origin, new String\[\] \{made\.bindingId, binding\}\);/);
    expect(java("PushServices.java")).toMatch(/boolean issue\(WorkspaceOrigin origin, PushContract\.Issued tokens\) \{\s*PushRegistrar\.get\(app\)\.adopt\(origin, tokens\.bindingId\);/);
    // One pending map for every enrolment the registrar makes (it makes a new PushEnrolment per call).
    expect(java("PushRegistrar.java")).toMatch(/new PushEnrolment\(RelayClient::call, store\(\), RelayClient\.ENVIRONMENT, pending\)/);
  });
  it("a dropped install, or a forgotten computer, takes its pending replaces with it; a pending binding shows generic text", () => {
    expect(java("PushEnrolment.java")).toMatch(/private void drop\(String failingSecret, int status\) \{\s*if \(!store\.dropInstall\(failingSecret\)\) return;[\s\S]*?pending\.clear\(\);/);
    expect(java("PushServices.java")).toMatch(/void forget\(WorkspaceOrigin origin\) \{\s*PushRegistrar\.get\(app\)\.cancelPending\(origin\);/);
    expect(java("MurageMessagingService.java")).toMatch(/this::post, PushRegistrar\.get\(this\)::isPending\)/);
  });
  it("putTokens seals respond before touching detail, so a locked respond key keeps the old pair", () => {
    const body = java("PushStore.java").match(/boolean putTokens\(String bindingId, String detail, String respond\) \{([\s\S]*?)\n {4}\}/)?.[1] ?? "";
    expect(body.trim()).not.toMatch(/^prefs\.edit\(\)\.remove\("detail\."/);
    expect(body.trim()).toMatch(/^if \(!seal\("respond\." \+ bindingId, respond, respondKey\)\) return false;/);
  });
});

describe("Plan 3b final re-review N2: Android reconcile reads the waiting replaces before the ledger", () => {
  it("never sweeps a replace adopted between the two reads", () => {
    const java = readFileSync(new URL("../android/app/src/main/java/com/murage/mobile/PushReconciler.java", import.meta.url), "utf8");
    expect(java).toMatch(/if \(!pendingReplace\.test\(id\)\) candidates\.add\(id\);\s*List<String> bound = store\.ledger\(\)\.bindingIds\(\);/);
  });
});

describe("privacy data minimisation: the last workspace going releases the FCM token and installation", () => {
  const dir = "android/app/src/main/java/com/murage/mobile/";
  it("PushRegistrar deletes both, best effort, on its own thread", () => {
    const registrar = read(dir + "PushRegistrar.java");
    expect(registrar).toContain("FirebaseMessaging.getInstance().deleteToken()");
    expect(registrar).toContain("FirebaseInstallations.getInstance().delete()");
    expect(registrar).toMatch(/void releaseDeviceIfLast\(\) \{\s*io\.execute\(/);
    expect(registrar).toContain("if (store().hasBindings()) return;");
  });
  it("forget and sweep both reach it after dropping bindings", () => {
    const services = read(dir + "PushServices.java");
    expect(services).toMatch(/void forget\([\s\S]*?releaseDeviceIfLast\(\)/);
    expect(services).toMatch(/void sweep\([\s\S]*?releaseDeviceIfLast\(\)/);
  });
  it("the release helper logs the exception class only, never its message", () => {
    const release = read(dir + "DeviceRelease.java");
    expect(release).toContain("getClass().getSimpleName()");
    expect(release).not.toContain("getMessage()");
  });
});
