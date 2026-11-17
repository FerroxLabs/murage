// Explicit opt-in packaged fixture. Never attaches to an existing/live app.
// Build dist with --mode help-fixture, then electron-builder --dir using already
// prepared native/server artifacts. HELP_FIXTURE_EXECUTABLE names that package.
import { evidenceRoot } from "./evidence";
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { seedTermsAccepted, seedWhatsNewSeen } from "../../scripts/control-murage";
let app: ElectronApplication, page: Page, data: string, origin: string, scriptKey = "";
const chief = "help-fixture-chief", thread = "help-fixture-task";
const call = (method: string, ...args: any[]) => page.evaluate(({ method, args }) => {
  const driver = (window as any).__helpAskFixture;
  if (!driver) throw Error("Requires an isolated help-fixture package");
  return driver[method](...args);
}, { method, args });
const snapshot = () => call("snapshot");
const state = () => page.locator("[data-help-ask-state]");
const question = () => page.getByRole("textbox", { name: "Your question", exact: true });
const press = (name: string) => page.locator("[data-help-ask]").getByRole("button", { name, exact: true }).click();
const close = () => page.getByRole("button", { name: "Close help", exact: true }).click();
const open = () => page.getByRole("button", { name: "Help and ask about this screen (?)", exact: true }).click();
async function cleanStop() {
  await expect(state()).toHaveAttribute("data-help-ask-state", "running");
  await expect(state()).not.toContainText("Could not stop it.");
  await expect(state().getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await expect(state().getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
}
async function cleanQueued() {
  await expect(state()).toHaveAttribute("data-help-ask-state", "queued");
  await expect(state().getByRole("button", { name: "Remove from line", exact: true })).toBeEnabled();
}
// Typing in the same instant as a scope change belongs to the old scope and is dropped, so the words are typed until they stay.
async function ask(text = "Unique Help fixture question") {
  await expect(async () => { await question().fill(text); await expect(question()).toHaveValue(text, { timeout: 500 }); }).toPass({ timeout: 10_000 });
  await press("Ask");
}
async function queued(expected = "queued") {
  await call("respond", "send", { kind: "answer", value: { queued: true, queueId: "fixture-q" } });
  await ask(); await expect(state()).toHaveAttribute("data-help-ask-state", expected);
}
async function running() {
  await queued();
  const send = (await snapshot()).requests.filter((r: any) => r.route === "send").at(-1).payload;
  await call("patchBot", chief, { busy: true, messages: [
    { id: "own", role: "user", kind: "text", text: send.text, sendId: send.sendId, dispatchedIn: "fixture-turn", at: 1 },
    { id: "answer", role: "bot", kind: "text", text: "Only this Ask answer", turnId: "fixture-turn", at: 2 },
    { id: "foreign", role: "bot", kind: "text", text: "Foreign answer", turnId: "other-turn", at: 3 },
  ] });
  await expect(state()).toHaveAttribute("data-help-ask-state", "running");
}
// A packaged app keeps no standing key in its data folder, so the script door is the owner's scoped grant (mcp-grants.ts).
async function scriptAccess() {
  if (scriptKey) return;
  scriptKey = (await call("ownerApi", "/api/mcp-grants", { method: "POST", body: JSON.stringify({ botId: chief, send: true }) })).token;
  expect(scriptKey).toBeTruthy();
}
function control(...args: string[]) {
  return execFileSync(process.execPath, ["--experimental-strip-types", "scripts/control-murage.ts", ...args, "--url", origin],
    { encoding: "utf8", env: { ...process.env, MURAGE_DATA_DIR: data, MURAGE_TOKEN: scriptKey } });
}
test.beforeAll(async () => {
  const executablePath = process.env.HELP_FIXTURE_EXECUTABLE;
  if (!executablePath) throw Error("Set HELP_FIXTURE_EXECUTABLE to the fixture package; live CDP attachment is forbidden");
  const evidence = evidenceRoot("help-ask-fixture");
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, ".help-package-"));
  data = join(root, "data");
  const home = join(root, "home"), user = join(root, "user");
  for (const dir of [data, home, user, join(root, "tmp"), join(data, "finish-fake")]) mkdirSync(dir);
  seedTermsAccepted(data); seedWhatsNewSeen(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({ profile: { email: "fixture@example.test" }, instances: {
    verification: { driver: "claudeAgent", displayName: "Verification fixture", config: { cli: resolve("server/testing/fake-claude-cli.ts") } },
  } }));
  writeFileSync(join(data, "bots.json"), JSON.stringify([{ id: chief, threadId: thread, name: "Fixture Chief",
    title: "", description: "", color: "green", notifications: false, unread: false, createdAt: 1,
    chiefOfStaff: true, chiefScope: "workspace", modelSelection: { instanceId: "verification", model: "sonnet" },
    resumeCursors: {}, tasks: [{ threadId: thread, title: "Fixture task", createdAt: 1, resumeCursors: {} }],
    computer: "off", browser: false, composio: false }]));
  // Playwright's Electron transport uses CDP for page.evaluate. The executable
  // starts its own server with this isolated profile and the packaged ui/.
  const env: Record<string, string> = {};
  for (const key of ["PATH", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "SYSTEMROOT", "WINDIR", "LANG"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
    MURAGE_USER_DATA: user, MURAGE_DATA_DIR: data, TMPDIR: join(root, "tmp"), TEMP: join(root, "tmp"), TMP: join(root, "tmp"),
    MURAGE_ANNOUNCEMENTS_URL: "off", MURAGE_PUSH_RELAY_URL: "off", FAKE_CLAUDE_MODE: "happy",
    FAKE_CLAUDE_FINISH_GATE_DIR: join(data, "finish-fake"), FAKE_CLAUDE_DUMP: join(data, "fake-dump.json") });
  app = await _electron.launch({ executablePath: resolve(executablePath), env });
  // A packaged app opens its startup splash first and closes it when the real window loads, so take the window by URL.
  const started = Date.now();
  for (;;) {
    const found = app.windows().find(window => /^http:\/\/127\.0\.0\.1:/.test(window.url()));
    if (found) { page = found; break; }
    if (Date.now() - started > 60_000) throw Error("The fixture package never opened its main window");
    await new Promise(done => setTimeout(done, 100));
  }
  origin = new URL(page.url()).origin;
  console.log(JSON.stringify({ url: origin, dataDir: data, pid: app.process().pid, evidence: root }));
  await page.evaluate(() => localStorage.setItem("murage-email-gate", "skipped"));
  await open();
  await page.waitForFunction(() => Boolean((window as any).__helpAskFixture));
  // Driver installation precedes React's first scope publication. Wait for the
  // seeded Chief before freezing time or reading the first scenario's snapshot.
  await expect.poll(async () => (await snapshot()).bots?.some((bot: any) => bot.id === chief)).toBe(true);
  // install() starts the clock running, so the pause point must lie ahead of it.
  const time = new Date(); await page.clock.install({ time }); await page.clock.pauseAt(new Date(time.getTime() + 60_000));
});
test.afterAll(async () => { await app?.close(); });
test.beforeEach(async ({}, info) => {
  if (await page.getByRole("button", { name: "Close help", exact: true }).count() === 0) await open();
  await call("reset");
  await call("setScope", "account", `row-${info.title}@example.test`);
  await call("respond", "state", ...Array.from({ length: 100 }, () => ({ kind: "answer", value: { state: "running" } })));
});
test.afterEach(async ({}, info) => {
  await info.attach("driver-trace", { body: JSON.stringify(await snapshot(), null, 2), contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("help.png") });
});

test("1 Chief selection and hidden Chief", async () => {
  const bot = (await snapshot()).bots.find((b: any) => b.id === chief);
  await call("setScope", "bots", [{ ...bot, id: "non-chief", chiefOfStaff: false }, bot]);
  await queued();
  expect((await snapshot()).requests.filter((r: any) => r.route === "send").at(-1).payload.botId).toBe(chief);
  await call("setScope", "bots", [{ ...bot, id: "non-chief", chiefOfStaff: false }, { ...bot, hidden: true }]);
  await expect(question()).toHaveCount(0);
  await expect(page.locator("[data-help-ask]")).toBeVisible();
});
test("2 Draft scope changes retain the mount", async () => {
  const before = (await snapshot()).observations.filter((o: any) => o.kind === "unmount").length;
  for (const [method, args] of [["setScope", ["account", "changed"]], ["patchBot", [chief, { id: "replacement" }]],
    ["patchBot", [chief, { threadId: "replacement-task" }]], ["setScope", ["dispatch", 12]]] as const) {
    await call("reset");
    await question().fill("Must disappear"); await call(method, ...args); await expect(question()).toHaveValue("");
  }
  expect((await snapshot()).observations.filter((o: any) => o.kind === "unmount")).toHaveLength(before);
});
test("3 Authorization while open and closed", async () => {
  await queued(); await call("setScope", "signedOut", true); await expect(state()).toHaveCount(0);
  await call("setScope", "signedOut", false); await expect(question()).toHaveValue("");
  await queued(); await close(); await call("setScope", "signedOut", true); await call("setScope", "signedOut", false); await open();
  await expect(state()).toHaveCount(0); await expect(question()).toHaveValue("");
});
test("4 Every opening dependency permits a fresh receipt", async () => {
  for (const [method, args] of [["setScope", ["account", "opening"]], ["patchBot", [chief, { id: "new-chief" }]],
    ["patchBot", [chief, { threadId: "new-task" }]], ["setScope", ["dispatch", 44]], ["setScope", ["signedOut", true]]] as const) {
    await call("reset"); await call("setScope", "account", "baseline"); await queued();
    await call(method, ...args);
    if (args[0] === "signedOut") await call("setScope", "signedOut", false);
    await queued();
    const last = (await snapshot()).observations.filter((o: any) => o.kind === "opening").at(-1);
    expect(last.value.aborted).toBe(false);
  }
});
test("5 Held Remove and Stop cannot repaint a reopened Help", async () => {
  // A late Remove answer reaches onDone and a late failure reaches onError, so each has its own pass.
  for (const [route, late] of [
    ["remove", { kind: "answer", value: { stopped: false } }],
    ["remove", { kind: "fail" }],
    ["stop", { kind: "answer", value: { stopped: false } }],
  ] as const) {
    await call("setScope", "account", `${route}-${late.kind}`);
    if (route === "remove") await queued(); else await running();
    await call("respond", route, { kind: "hold" }); await press(route === "remove" ? "Remove from line" : "Stop");
    const held = await snapshot();
    const old = held.held.at(-1);
    const attemptId = route === "remove" ? held.observations.filter((o: any) => o.kind === "attempt").at(-1).id : undefined;
    const clean = route === "remove" ? cleanQueued : cleanStop;
    await close();
    expect((await snapshot()).timerCount).toBe(0); expect((await snapshot()).listenerCount).toBe(0);
    expect((await snapshot()).requests.find((r: any) => r.id === old).aborted).toBe(true);
    await open();
    await clean();
    if (attemptId !== undefined) expect((await snapshot()).observations.find((o: any) => o.id === attemptId).value.live).toBe(false);
    await call("release", old, late);
    await expect.poll(async () => (await snapshot()).requests.find((r: any) => r.id === old).settled).toBe(true);
    // Transport finally() precedes the store callback. Observe this exact
    // request's callback before remounting to read committed React state.
    if (route === "remove") await expect.poll(async () => (await snapshot()).requests.find((r: any) => r.id === old).callbackSettled).toBe(true);
    await clean();
    // A late write lands in the retained record and React paints it after this read, so a fresh mount reads the record itself.
    await close(); await expect(state()).toHaveCount(0); await open();
    await clean();
    if (attemptId !== undefined) expect((await snapshot()).observations.find((o: any) => o.id === attemptId).value.live).toBe(false);
    await expect(state()).toContainText("Unique Help fixture question");
    await expect(page.getByRole("button", { name: /^(Stopping|Removing)/ })).toHaveCount(0);
  }
});
test("6 Refused then held retry and unrelated stream", async () => {
  await call("respond", "send", { kind: "refuse" }, { kind: "hold" }); await ask();
  await expect(state()).toHaveAttribute("data-help-ask-state", "refused"); await press("Try again");
  await expect(state()).toHaveAttribute("data-help-ask-state", "sending");
  await expect(page.locator("[data-help-ask]").getByRole("button", { name: "Try again" })).toHaveCount(0);
  const trace = await snapshot();
  const retry = trace.requests.filter((r: any) => r.route === "send").at(-1).payload;
  await call("setScope", "pendingQueued", { [thread]: [
    { sendId: retry.sendId, text: retry.text, refused: true }, { sendId: retry.sendId, text: retry.text, sending: true },
  ] });
  await expect(state()).toHaveAttribute("data-help-ask-state", "sending");
  // The receipt stays held: only reconciliation can leave Sending.
  await call("setScope", "pendingQueued", { [thread]: [{ sendId: retry.sendId, text: retry.text, queueId: "q" }] });
  await expect(state()).toHaveAttribute("data-help-ask-state", "queued");
  await call("setScope", "pendingQueued", {});
  await expect(state()).toHaveAttribute("data-help-ask-state", "sending");
  const send = trace.requests.filter((r: any) => r.route === "send").at(-1).payload;
  await call("patchBot", chief, { messages: [{ id: "own", role: "user", sendId: send.sendId, dispatchedIn: "own-turn" },
    { id: "ours", role: "bot", kind: "text", turnId: "own-turn", text: "Own answer" },
    { id: "foreign", role: "bot", kind: "text", turnId: "foreign", text: "Foreign transcript" }] });
  await expect(state()).toHaveAttribute("data-help-ask-state", "running");
  await expect(state()).toContainText("Own answer");
  await expect(state()).not.toContainText("Foreign transcript");
  expect((await snapshot()).held).toContain(trace.held.at(-1));
  await call("hint", { turnId: "foreign", ended: false }); await call("streamAt", thread, "Foreign stream");
  await expect(state()).toContainText("Own answer"); await expect(state()).not.toContainText("Foreign stream");
});
test("7 Unloaded page fails, retries and cancels on close", async () => {
  for (const count of [1, 10]) {
    await call("setScope", "account", `page-${count}`);
    await call("failPages", count); await call("patchBot", chief, { messagesUnloaded: true });
    const before = (await snapshot()).requests.filter((r: any) => r.route === "page").length;
    await queued("inChat");
    if (count === 1) {
      const send = (await snapshot()).requests.filter((r: any) => r.route === "send").at(-1).payload;
      await call("respond", "page", { kind: "fail" }, { kind: "answer", value: { messages: [
        { id: "page-own", role: "user", sendId: send.sendId, dispatchedIn: "page-turn" },
        { id: "page-answer", role: "bot", kind: "text", turnId: "page-turn", text: "Answer loaded without selecting chat" },
      ] } });
    }
    await page.clock.runFor(12_100);
    if (count === 1) await expect(state()).toContainText("Answer loaded without selecting chat");
    const loads = (await snapshot()).requests.filter((r: any) => r.route === "page").length - before;
    expect(loads).toBe(count === 1 ? 2 : 4);
    await close(); expect((await snapshot()).timerCount).toBe(0); expect((await snapshot()).listenerCount).toBe(0); await open();
  }
  await call("setScope", "account", "close-before-page-retry"); await call("failPages", 10);
  await call("patchBot", chief, { messagesUnloaded: true }); await queued("inChat");
  // Every load already asked for has answered with a failure, so this Ask's retry timer is armed when Help closes.
  const armed = () => snapshot().then((now) => now.observations.some((o: any) => o.kind === "pageTimer" && o.value.active));
  await expect.poll(async () => { await page.clock.runFor(1); return armed(); }).toBe(true);
  await close(); expect(await armed()).toBe(false);
  const before = (await snapshot()).requests.length; await page.clock.runFor(7000);
  expect((await snapshot()).requests.slice(before)).toEqual([]); await open();
});
test("7b Retained page effect replaces record and dispatch independently", async () => {
  for (const dependency of ["record", "dispatch"]) {
    const mounts = (await snapshot()).observations.filter((o: any) => o.kind === "pageProbeMount").length;
    await call("mountPageProbe");
    await expect.poll(async () => (await snapshot()).observations.filter((o: any) => o.kind === "pageTimer").at(-1)?.value.active).toBe(true);
    const before = await snapshot();
    const oldTimer = before.observations.filter((o: any) => o.kind === "pageTimer").at(-1).id;
    const oldInput = before.observations.filter((o: any) => o.kind === "pageProbeInput").at(-1).value;
    await call("changePageProbe", dependency);
    await expect.poll(async () => (await snapshot()).observations.find((o: any) => o.id === oldTimer).value.active).toBe(false);
    const changed = (await snapshot()).observations.filter((o: any) => o.kind === "pageProbeInput").at(-1).value;
    expect(changed.needsPage).toBe(oldInput.needsPage);
    expect(changed[dependency]).not.toBe(oldInput[dependency]);
    expect(changed[dependency === "record" ? "dispatch" : "record"]).toBe(oldInput[dependency === "record" ? "dispatch" : "record"]);
    const previousRequests = (await snapshot()).requests.filter((r: any) => r.route === "page" && r.payload.probe).length;
    await page.clock.runFor(2000);
    expect((await snapshot()).requests.filter((r: any) => r.route === "page" && r.payload.probe)).toHaveLength(previousRequests + 1);
    const request = (await snapshot()).requests.filter((r: any) => r.route === "page" && r.payload.probe).at(-1);
    expect(request.payload).toMatchObject({ threadId: changed.record, dispatch: changed.dispatch });
    expect((await snapshot()).observations.filter((o: any) => o.kind === "pageProbeMount")).toHaveLength(mounts + 1);
    await call("unmountPageProbe");
  }
});
test("8 Follow identities, deadline, live hints and approval", async ({}, info) => {
  const counts: Record<string, number> = {};
  const initialReads = (await snapshot()).reads;
  const clockStart = await page.evaluate(() => Date.now());
  await running();
  const until = (await snapshot()).observations.filter((o: any) => o.kind === "follow").at(-1).value.until;
  const reads = (await snapshot()).reads; await call("render"); expect((await snapshot()).reads).toBe(reads);
  for (const [method, args] of [["hint", [{ turnId: "other" }]], ["hint", [{ ended: true }]],
    ["patchBot", [chief, { busy: false }]]] as const) {
    const before = (await snapshot()).reads; await call(method, ...args);
    const dimension = method === "patchBot" ? "bot.busy" : "turnId" in args[0] ? "live.turnId" : "live.ended";
    // Browser time stays frozen: a periodic poll cannot rescue a missing nudge.
    await expect.poll(async () => (await snapshot()).reads, { message: `${dimension} must trigger one immediate read` }).toBe(before + 1);
    counts[dimension] = (await snapshot()).reads - before;
    expect(await page.evaluate(() => Date.now())).toBe(clockStart);
  }
  const send = (await snapshot()).requests.filter((r: any) => r.route === "send").at(-1).payload;
  await page.clock.runFor(1000); // Time moves, but no five-second poll can mask a missing nudge.
  const beforeRestamp = (await snapshot()).reads;
  await call("patchBot", chief, { messages: [{ id: "own", role: "user", sendId: send.sendId, dispatchedIn: "restamped" },
    { id: "approval", role: "bot", kind: "options", turnId: "restamped", card: { title: "Fixture approval" } }] });
  await expect(state()).toHaveAttribute("data-help-ask-state", "approval");
  const follow = (await snapshot()).observations.filter((o: any) => o.kind === "follow").at(-1).value;
  counts.restamp = (await snapshot()).reads - beforeRestamp;
  expect(counts.restamp).toBe(1);
  expect(follow.key).toContain("restamped"); expect(follow.until).toBe(until);
  // The read itself must ask about the new turn: a nudge alone would still read through the old follow.
  expect((await snapshot()).requests.filter((r: any) => r.route === "state").at(-1).payload.path).toContain("turnId=restamped");
  await call("respond", "state", { kind: "answer", value: { state: "ended" } });
  await call("hint", { ended: false });
  await expect(state()).toHaveAttribute("data-help-ask-state", "done"); await press("Done");
  await call("respond", "state", { kind: "answer", value: { state: "running" } });
  await queued();
  const next = await snapshot();
  const nextSend = next.requests.filter((r: any) => r.route === "send").at(-1).payload;
  const nextFollow = next.observations.filter((o: any) => o.kind === "follow").at(-1).value;
  expect(nextSend.sendId).not.toBe(send.sendId);
  expect(nextFollow.key).not.toBe(follow.key); expect(nextFollow.key).toContain(nextSend.sendId);
  expect(nextFollow.until).toBe(until + 1000);
  expect(next.requests.filter((r: any) => r.route === "state").at(-1).payload.path).toContain(nextSend.sendId);
  counts.total = (await snapshot()).reads - initialReads;
  await info.attach("l13-follow-counts", { body: JSON.stringify(counts), contentType: "application/json" });
});
test("9 Ask queues behind real held engine without steering", async () => {
  await scriptAccess();
  console.log(control("send", "--bot", chief, "--text", "__fixture_hold_authority__"));
  await expect.poll(async () => (await snapshot()).bots.find((b: any) => b.id === chief)?.busy).toBe(true);
  const heldTurn = async () => (await snapshot()).bots.find((b: any) => b.id === chief).messages
    .findLast((m: any) => m.role === "user" && m.text?.includes("__fixture_hold_authority__"))?.dispatchedIn;
  await expect.poll(heldTurn).toBeTruthy();
  const originalTurn = await heldTurn();
  await ask("No steer fixture question"); await expect(state()).toHaveAttribute("data-help-ask-state", "queued");
  await expect(page.getByRole("button", { name: "Remove from line", exact: true })).toBeVisible();
  const send = (await snapshot()).requests.filter((r: any) => r.route === "send").at(-1).payload;
  expect(send.noSteer).toBe(true);
  console.log(control("interrupt", "--bot", chief));
  console.log(control("wait", "--bot", chief, "--timeout", "30"));
  const transcript = control("messages", "--bot", chief, "--limit", "30"); console.log(transcript);
  expect(transcript).toContain("No steer fixture question");
  await expect.poll(async () => (await snapshot()).bots.find((b: any) => b.id === chief).messages
    .find((m: any) => m.sendId === send.sendId)?.dispatchedIn).toBeTruthy();
  const own = (await snapshot()).bots.find((b: any) => b.id === chief).messages.find((m: any) => m.sendId === send.sendId);
  expect(own.dispatchedIn).not.toBe(originalTurn);
  await expect(page.locator("[data-help-answer]").first()).toBeVisible();
});
test("10 Retry identity, late receipt and uncertain delivery", async () => {
  await call("respond", "send", { kind: "refuse" }, { kind: "hold" }); await ask("Identity question");
  await expect(state()).toHaveAttribute("data-help-ask-state", "refused"); await press("Try again");
  const trace = await snapshot(), sends = trace.requests.filter((r: any) => r.route === "send").slice(-2);
  expect(sends[0].payload.sendId).toBe(sends[1].payload.sendId); expect(sends[0].payload.text).toBe(sends[1].payload.text);
  await close(); await call("release", trace.held.at(-1), { kind: "answer", value: { queued: true, queueId: "q" } }); await open();
  await expect(state()).toHaveAttribute("data-help-ask-state", "queued");
  await call("setScope", "account", "uncertain"); await call("respond", "send", { kind: "fail" }); await ask();
  await expect(state()).toHaveAttribute("data-help-ask-state", "inChat");
  await expect(page.locator("[data-help-ask]").getByRole("button", { name: "Try again" })).toHaveCount(0);
  expect((await snapshot()).requests.filter((r: any) => r.route === "send").at(-1).payload.sendId).not.toBe(sends[0].payload.sendId);
});
test("11 Remove timeout, retired attempt and sending retries", async () => {
  await queued(); await call("respond", "remove", { kind: "hold" }, { kind: "answer" }); await press("Remove from line");
  const old = (await snapshot()).held.at(-1);
  const attemptId = (await snapshot()).observations.filter((o: any) => o.kind === "attempt").at(-1).id;
  await page.clock.runFor(15_001);
  await expect(state()).toHaveAttribute("data-help-ask-state", "removeRetry");
  expect((await snapshot()).observations.find((o: any) => o.id === attemptId).value.live).toBe(false);
  await call("release", old, { kind: "fail", value: { body: { state: "started" } } });
  await expect.poll(async () => (await snapshot()).requests.find((r: any) => r.id === old).settled).toBe(true);
  await expect.poll(async () => (await snapshot()).requests.find((r: any) => r.id === old).callbackSettled).toBe(true);
  await expect(state()).toHaveAttribute("data-help-ask-state", "removeRetry");
  await press("Try again");
  await expect(state()).toHaveAttribute("data-help-ask-state", "removed");
  // Separate replacement fencing: release the old response after the replacement succeeds.
  await call("setScope", "account", "replacement-remove"); await queued();
  await call("respond", "remove", { kind: "hold" }, { kind: "answer" });
  await press("Remove from line"); const replaced = (await snapshot()).held.at(-1);
  await page.clock.runFor(15_001); await press("Try again");
  await expect(state()).toHaveAttribute("data-help-ask-state", "removed");
  await call("release", replaced, { kind: "fail", value: { body: { state: "started" } } });
  await expect(state()).toHaveAttribute("data-help-ask-state", "removed");
  await call("setScope", "account", "sending-remove"); await queued();
  await call("respond", "remove", ...Array.from({ length: 5 }, () => ({ kind: "fail", value: { body: { state: "sending" } } })));
  const before = (await snapshot()).requests.filter((r: any) => r.route === "remove").length;
  await press("Remove from line"); await page.clock.runFor(5000);
  expect((await snapshot()).requests.filter((r: any) => r.route === "remove").length - before).toBe(5);
  await close(); expect((await snapshot()).timerCount).toBe(0); expect((await snapshot()).listenerCount).toBe(0); await open();
});
test("12 Stop false nudges an immediate ended read; closed Stop is silent", async () => {
  await running(); await call("respond", "stop", { kind: "answer", value: { stopped: false } });
  await call("respond", "state", { kind: "hold" });
  const before = (await snapshot()).reads; await press("Stop");
  await expect.poll(async () => (await snapshot()).reads).toBe(before + 1);
  await expect(state()).toHaveAttribute("data-help-ask-state", "running");
  await expect(state()).toContainText("Could not stop it.");
  const held = (await snapshot()).held.at(-1); await call("release", held, { kind: "answer", value: { state: "ended" } });
  await expect(state()).toHaveAttribute("data-help-ask-state", "done");
  await call("setScope", "account", "closed-stop"); await running(); await call("respond", "stop", { kind: "hold" });
  await press("Stop"); const stop = (await snapshot()).held.at(-1); await close();
  await open(); await cleanStop();
  const reads = (await snapshot()).reads;
  await call("release", stop, { kind: "answer", value: { stopped: false } });
  await cleanStop(); expect((await snapshot()).reads).toBe(reads);
});
test("13 Done discards the question and fences late callbacks", async () => {
  await call("holdCallbacks", true);
  await call("respond", "send", { kind: "answer", value: { queued: true, queueId: "late" } }); await ask();
  // The receipt is held, so establish delivered rows independently, as a stream can.
  const trace = await snapshot(), send = trace.requests.filter((r: any) => r.route === "send").at(-1).payload;
  // The read that the new turn starts must already answer ended: an earlier row may have left the live hint at ended, and a hint with no change asks nothing.
  await call("respond", "state", ...Array.from({ length: 20 }, () => ({ kind: "answer", value: { state: "ended" } })));
  await call("patchBot", chief, { messages: [{ id: "own", role: "user", sendId: send.sendId, dispatchedIn: "done-turn" }] });
  await call("hint", { ended: true });
  await expect(state()).toHaveAttribute("data-help-ask-state", "done"); await press("Done"); await close(); await open();
  for (const id of (await snapshot()).callbacks) await call("releaseCallback", id);
  await expect(question()).toHaveValue(""); await call("holdCallbacks", false);
});
test("14 Trim, preview, submit and Open in chat", async () => {
  await scriptAccess(); console.log(control("bots"));
  await question().fill("   "); await expect(page.locator("[data-help-ask]").getByRole("button", { name: "Ask", exact: true })).toBeDisabled();
  const selected = await snapshot();
  await question().fill("Preview question"); await expect(page.locator("[data-help-ask-preview]")).toContainText("Preview question");
  await expect(page.locator("[data-help-ask-preview]")).toContainText(/\(Asked from help on the .+ screen\.\)/);
  await press("Ask"); await expect(page.locator("[data-help-ask]").getByRole("button", { name: "Open in chat", exact: true })).toBeVisible();
  expect((await snapshot()).selectedId).toBe(selected.selectedId); expect((await snapshot()).activeView).toBe(selected.activeView);
  await press("Open in chat"); await expect(page.getByRole("button", { name: "Chat list", exact: true })).toBeVisible();
  // Reopen Help so the observer reads the new provider selection.
  if (await page.getByRole("button", { name: "Close help", exact: true }).count() === 0) await open();
  expect((await snapshot()).selectedId).toBe(chief);
  expect((await snapshot()).bots.find((b: any) => b.id === chief).threadId).toBe(thread);
});

// F6 assertions are acceptance criteria, not a claim that the historical
// package implements the new UI. Run these again on A3 + final Slice I.
test("15 UI-LAYOUT light/dark desktop and 320px touch targets", async ({}, info) => {
  try {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.skin)).toBe(colorScheme);
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const panel = page.locator("[data-help-ask]");
        await expect(panel).toBeVisible();
        await question().fill("A long question that must wrap within the phone screen without hiding the Ask button.");
        await page.screenshot({ path: info.outputPath(`${colorScheme}-${width}-draft.png`) });
        const dimensions = await panel.evaluate(element => {
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, inner: element.clientWidth, content: element.scrollWidth };
        });
        expect.soft(dimensions.left, `${colorScheme}/${width} left edge`).toBeGreaterThanOrEqual(0);
        expect.soft(dimensions.right, `${colorScheme}/${width} right edge`).toBeLessThanOrEqual(width);
        expect.soft(dimensions.content, `${colorScheme}/${width} horizontal overflow`).toBeLessThanOrEqual(dimensions.inner);
        if (width === 320) {
          const controls = await panel.locator("button:visible, textarea:visible, input:visible").evaluateAll(elements => elements.map(element => ({
            name: element.getAttribute("aria-label") || element.textContent,
            height: element.getBoundingClientRect().height,
            width: element.getBoundingClientRect().width,
          })));
          expect(controls.length).toBeGreaterThan(0);
          for (const control of controls) {
            expect.soft(control.height, `${control.name} touch height`).toBeGreaterThanOrEqual(44);
            expect.soft(control.width, `${control.name} touch width`).toBeGreaterThanOrEqual(44);
          }
        }
      }
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
  }
});

test("16 UI-G9 question focus, exact preview and return to Help", async ({}, info) => {
  await close(); await open();
  await expect.soft(question(), "opening focuses Your question").toBeFocused();
  await question().fill("  Where are my settings?  ");
  const preview = page.locator("[data-help-ask-preview]");
  await expect.soft(preview).toContainText(/Where are my settings\?\s+\(Asked from help on the .+ screen\.\)/);
  await expect.soft(page.locator("[data-help-ask]")).toContainText("Your question and this screen's name go to Fixture Chief's chat. Its usual memory and permissions apply. Replies count toward usage.");
  await page.screenshot({ path: info.outputPath("question-preview-focus.png") });
  await page.keyboard.press("Escape");
  await expect.soft(page.getByRole("button", { name: "Close help", exact: true })).toHaveCount(0);
  await expect.soft(page.getByRole("button", { name: "Help and ask about this screen (?)", exact: true })).toBeFocused();
});
