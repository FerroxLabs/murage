import assert from "node:assert/strict";
import test from "node:test";
import { prepareUpdaterRestart } from "./updater-restart.mjs";

const options = (overrides = {}) => ({ environment: {}, isClosing: () => false, isCleanedUp: () => false,
  readActivity: async () => ({ bots: [], groups: [] }), cleanup: async () => {}, ...overrides });

for (const activity of [{ bots: [{ busy: true }], groups: [] }, { bots: [], groups: [{ working: true }] }]) {
  test("active work refuses restart before cleanup", async () => {
    await assert.rejects(prepareUpdaterRestart(options({ readActivity: async () => activity,
      cleanup: () => assert.fail("active work was interrupted") })), /Finish or stop current work/);
  });
}
for (const readActivity of [async () => { throw new Error("offline"); }, async () => ({}), async () => ({ bots: [] })]) {
  test("unknown work state fails closed before cleanup", async () => {
    await assert.rejects(prepareUpdaterRestart(options({ readActivity,
      cleanup: () => assert.fail("unknown state was stopped") })), /Could not check current work/);
  });
}
for (const environment of [{ MURAGE_USER_DATA: "C:\\Fixture Profile" }, { MURAGE_DATA_DIR: "/fixture/data" }]) {
  test("custom profiles require their existing launcher and are never silently replaced", async () => {
    await assert.rejects(prepareUpdaterRestart(options({ environment,
      readActivity: () => assert.fail("profile refusal must precede activity/cleanup"),
      cleanup: () => assert.fail("custom profile was stopped") })), /custom profile.*same profile launcher/);
  });
}
test("quiescent restart awaits cleanup", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let done = false;
  const operation = prepareUpdaterRestart(options({ cleanup: () => pending })).then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  release(); await operation; assert.equal(done, true);
});
test("cleanup failure does not claim the app stayed ready", async () => {
  await assert.rejects(prepareUpdaterRestart(options({ cleanup: () => { throw new Error("held lease"); } })),
    /could not finish closing safely.*update was not started.*reopen Murage/);
});
test("installer retry after completed cleanup does not query a stopped harness", async () => {
  await prepareUpdaterRestart(options({ isClosing: () => true, isCleanedUp: () => true,
    readActivity: () => assert.fail("harness is already stopped"), cleanup: () => assert.fail("already clean") }));
});
test("a partially closing app cannot begin another updater cleanup", async () => {
  await assert.rejects(prepareUpdaterRestart(options({ isClosing: () => true,
    readActivity: () => assert.fail("closing app") })), /already closing/);
});
