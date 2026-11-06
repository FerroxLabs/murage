import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { runInNewContext } from "node:vm";

async function bundle(mode: string) {
  return (await build({ entryPoints: ["src/components/help/help-ask-port.ts"], bundle: true,
    write: false, format: "iife", globalName: "port", platform: "browser",
    define: { "import.meta.env.MODE": JSON.stringify(mode) }, minify: true })).outputFiles[0].text;
}
describe("Help fixture production boundary", () => {
  it("erases the driver from production, with a positive fixture control", async () => {
    const production = await bundle("production"), fixture = await bundle("help-fixture");
    for (const marker of ["HELP_ASK_FIXTURE_ONLY", "__helpAskFixture"]) {
      expect(production).not.toContain(marker);
      expect(fixture).toContain(marker);
    }
  });
  it("ignores every runtime opt-in and calls the original API once", async () => {
    const context: any = { window: { __helpAskFixture: { scope: () => { throw Error("injected"); } } },
      localStorage: { getItem: () => "help-fixture" }, location: { search: "?mode=help-fixture&__helpAskFixture=1" } };
    context.window.localStorage = context.localStorage; context.window.location = context.location;
    runInNewContext(await bundle("production"), context);
    // Let a mistakenly unguarded dynamic import finish before asserting identity.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const scope = { state: { bots: [], config: { profile: { email: "real" } } }, dispatch() {} };
    expect(context.port.askScope(scope)).toBe(scope);
    let calls = 0;
    const api = async () => { calls++; return "real"; };
    expect(await context.port.askApi(api)("/test")).toBe("real");
    expect(calls).toBe(1);
    // Positive control for this exact runtime oracle: removing the guard
    // installs the driver, changes scope identity and intercepts the API.
    const fixture: any = { window: {} };
    runInNewContext(await bundle("help-fixture"), fixture);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.window.__helpAskFixture.setScope("account", "injected");
    expect(fixture.port.askScope(scope).state.config.profile.email).toBe("injected");
    fixture.window.__helpAskFixture.respond("state", { kind: "answer", value: "injected" });
    expect(await fixture.port.askApi(api)("/test")).toBe("injected");
    expect(calls).toBe(1);
  });
  it("checks dist in the budget step and before packaging, and rejects release mode overrides", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/pnpm check:bundle-budget\s+node scripts\/check-help-fixture-absent.mjs/);
    expect(readFileSync("playwright.config.ts", "utf8")).toContain("\"**/help-ask-fixture.human.spec.ts\"");
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["package:prepare"]).toContain("pnpm build && node scripts/check-help-fixture-absent.mjs");
    const checker = readFileSync("scripts/check-help-fixture-absent.mjs", "utf8");
    expect(checker).toContain("--mode");
    expect(checker).toContain(".github/workflows/release.yml");
    const release = readFileSync(".github/workflows/release.yml", "utf8");
    for (const platform of ["mac", "win", "linux"]) {
      expect(release).toContain(`pnpm package:${platform}`);
      expect(pkg.scripts[`package:${platform}`]).toContain("pnpm package:prepare");
    }
  });
});

describe("mounted-free driver smoke", () => {
  it("holds, releases, refuses, fails and preserves abort observations at the API seam", async () => {
    const { createDriver } = await import("./help-ask-fixture");
    const driver = createDriver(() => {});
    const controller = new AbortController();
    let real = 0;
    const api = driver.api(async () => { real++; return { state: "running" }; });
    driver.respond("state", { kind: "hold" }, { kind: "refuse" }, { kind: "fail" });
    const held = api("/api/bots/b/turn-state", { signal: controller.signal });
    controller.abort();
    const snap = driver.snapshot();
    expect(snap.requests[0].aborted).toBe(true);
    driver.release(snap.held[0], { kind: "answer", value: { state: "ended" } });
    expect(await held).toEqual({ state: "ended" });
    await expect(api("/api/bots/b/turn-state")).rejects.toMatchObject({ status: 400 });
    await expect(api("/api/bots/b/turn-state")).rejects.toThrow();
    await api("/api/bots/b/turn-state");
    expect(real).toBe(1);
    expect(driver.snapshot().reads).toBe(4);
  });
  it("retains dispatch identity across renders, changes it on demand, and holds callbacks", async () => {
    const { createDriver } = await import("./help-ask-fixture");
    const driver = createDriver(() => {});
    const original: any = { state: { bots: [{ id: "b", threadId: "t", messages: [] }], config: { profile: { email: "a" } } }, dispatch() {} };
    const first = driver.scope(original);
    driver.render();
    expect(driver.scope(original).dispatch).toBe(first.dispatch);
    driver.setScope("dispatch", 1);
    expect(driver.scope(original).dispatch).not.toBe(first.dispatch);
    driver.setScope("account", "other"); driver.setScope("signedOut", true);
    driver.patchBot("b", { threadId: "other" });
    const scope = driver.scope(original);
    expect(scope.state.config?.profile?.email).toBe("other");
    expect(scope.state.signedOut).toBe(true);
    expect(scope.state.bots[0].threadId).toBe("other");
    driver.hint({ turnId: "restamp", ended: true });
    expect(driver.live({ ended: false })).toEqual({ turnId: "restamp", ended: true });
    driver.streamAt("unrelated", "foreign");
    expect(driver.stream({})).toEqual({ unrelated: "foreign" });
    driver.respond("send", { kind: "answer", value: { queued: true, queueId: "q" } });
    driver.holdCallbacks();
    let receipt: unknown;
    scope.dispatch({ type: "send", botId: "b", text: "question", sendId: "s", noSteer: true, onReceipt: (value) => { receipt = value; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(receipt).toBeUndefined();
    const snap = driver.snapshot();
    expect(snap.requests[0].payload.noSteer).toBe(true);
    driver.releaseCallback(snap.callbacks[0]);
    expect(receipt).toEqual({ queued: true, queueId: "q" });
  });
});

it("dist scanner rejects fixture assets, empty builds and release mode arguments", async () => {
  const modulePath = resolve("scripts/check-help-fixture-absent.mjs");
  const { checkHelpFixtureAbsent: check } = await import(modulePath);
  const root = mkdtempSync(resolve(".help-scan-"));
  try {
    const dist = join(root, "dist"), workflow = join(root, "release.yml");
    mkdirSync(dist); writeFileSync(workflow, "run: pnpm package:linux");
    expect(() => check(dist, workflow, [])).toThrow("Empty dist");
    writeFileSync(join(dist, "app.js"), "production");
    expect(() => check(dist, workflow, [])).not.toThrow();
    for (const marker of ["HELP_ASK_FIXTURE_ONLY", "__helpAskFixture"]) {
      writeFileSync(join(dist, "app.js"), marker);
      expect(() => check(dist, workflow, [])).toThrow("Help fixture");
    }
    writeFileSync(join(dist, "app.js"), "production");
    expect(() => check(dist, workflow, ["--mode", "help-fixture"])).toThrow("--mode");
    writeFileSync(workflow, "run: pnpm exec vite build --mode=help-fixture");
    expect(() => check(dist, workflow, [])).toThrow("--mode");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("tracks actual timer and abort registrations, not inferred cleanup state", async () => {
  const { createDriver } = await import("./help-ask-fixture");
  const d = createDriver(() => {});
  const controller = new AbortController(), callback = () => {};
  const timer = d.setTimeout(callback, 60_000);
  d.addAbort(controller.signal, callback);
  expect(d.snapshot()).toMatchObject({ timerCount: 1, listenerCount: 1 });
  d.clearTimeout(timer); d.removeAbort(controller.signal, callback);
  expect(d.snapshot()).toMatchObject({ timerCount: 0, listenerCount: 0 });
  d.addAbort(controller.signal, callback); controller.abort();
  expect(d.snapshot().listenerCount).toBe(0);
});

it("injects Stop false, sending-state DELETE errors and fail-N page transitions", async () => {
  const { createDriver } = await import("./help-ask-fixture");
  let realLoads = 0, revoked = 0;
  const d = createDriver(() => {}, () => { revoked++; });
  const input: any = { state: { bots: [{ id: "b", threadId: "t", messages: [] }], groups: [], transcriptGeneration: {} }, dispatch: () => {} };
  const dispatch = d.scope(input, async () => { realLoads++; return { messages: [] }; }).dispatch;
  d.respond("stop", { kind: "answer", value: { stopped: false } });
  expect(await d.api(async () => { throw Error("unexpected real Stop"); })("/api/bots/b/interrupt")).toEqual({ stopped: false });
  d.respond("remove", { kind: "fail", value: { body: { state: "sending" } } });
  let error: unknown;
  dispatch({ type: "cancelQueued", botId: "b", queueId: "q", onError: (value) => { error = value; } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(error).toMatchObject({ body: { state: "sending" } });
  d.patchBot("b", { messagesUnloaded: true }); d.failPages(2);
  for (let n = 0; n < 2; n++) {
    dispatch({ type: "loadFirstPage", threadId: "t" });
    expect(d.scope(input).state.bots[0].firstPageEvents).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(d.scope(input).state.bots[0].messagesUnloaded).toBe(true);
    expect(d.scope(input).state.bots[0].firstPageEvents).toBeUndefined();
  }
  dispatch({ type: "loadFirstPage", threadId: "t" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(realLoads).toBe(1);
  d.setScope("signedOut", true); d.setScope("signedOut", false);
  expect(revoked).toBe(1);
});
