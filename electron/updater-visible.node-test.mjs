import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { createCheckHealth, describeCheckFailure } from "./updater-health.mjs";
import { createGithubFallbackFeed, resolveLatestReleaseFeed } from "./updater-fallback.mjs";

const HOUR = 60 * 60 * 1000;

function noVersions() {
  const error = new Error("No published versions on GitHub");
  error.code = "ERR_UPDATER_NO_PUBLISHED_VERSIONS";
  return error;
}

// Mirrors electron-updater: a failed check emits "error" and then rejects with the same error.
function harness(options = {}) {
  const updater = new EventEmitter();
  updater.on("error", () => {});
  const logged = [];
  updater.logger = { warn: (line) => logged.push(line), info() {}, error() {} };
  let state = { status: "idle" };
  const states = [];
  const coordinator = createUpdaterCoordinator(updater, (patch) => {
    state = { ...state, ...patch };
    if ("staleCheckSince" in patch && patch.staleCheckSince === undefined) delete state.staleCheckSince;
    states.push({ ...state });
  }, options);
  return { updater, coordinator, logged, states, getState: () => state };
}

test("provider says no versions: the latest-release lookup offers the newer version", async () => {
  let feed = "github";
  const fallbackFeed = {
    activate: async () => { feed = "generic"; return true; },
    reset: () => { feed = "github"; },
  };
  const h = harness({ fallbackFeed });
  h.updater.checkForUpdates = async () => {
    h.updater.emit("checking-for-update");
    if (feed === "github") {
      const error = noVersions();
      h.updater.emit("error", error);
      throw error;
    }
    h.updater.emit("update-available", { version: "1.0.3" });
    return { isUpdateAvailable: true };
  };

  await h.coordinator.check(true);

  assert.equal(h.getState().status, "available");
  assert.equal(h.getState().version, "1.0.3");
  assert.equal(h.states.some((entry) => entry.status === "error"), false, "the lookup answers; no error flashes first");
});

test("when the lookup finds nothing either, a manual check still reports the original error", async () => {
  const h = harness({ fallbackFeed: { activate: async () => false, reset() {} } });
  h.updater.checkForUpdates = async () => {
    const error = noVersions();
    h.updater.emit("error", error);
    throw error;
  };
  await h.coordinator.check(true);
  assert.equal(h.getState().status, "error");
});

test("each failed check is logged with its code and status, never its message", async () => {
  const h = harness();
  h.updater.checkForUpdates = async () => {
    const error = new Error("Bearer ghp_SECRET https://example.test/?token=abc");
    error.code = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  };
  await h.coordinator.check();
  assert.equal(h.logged.length, 1);
  assert.match(h.logged[0], /code=ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/);
  assert.match(h.logged[0], /status=404/);
  assert.doesNotMatch(h.logged[0], /ghp_|token|example/);
});

test("24 hours of failed checks raise the notice once, and a good check withdraws it", async () => {
  let clock = 1_000_000;
  const h = harness({ now: () => clock });
  let fail = true;
  h.updater.checkForUpdates = async () => { if (fail) throw new Error("offline"); return { isUpdateAvailable: false }; };

  await h.coordinator.check();
  clock += 23 * HOUR;
  await h.coordinator.check();
  assert.equal(h.getState().staleCheckSince, undefined);

  clock += 1 * HOUR;
  await h.coordinator.check();
  const since = h.getState().staleCheckSince;
  assert.equal(since, new Date(1_000_000).toISOString());

  clock += HOUR;
  await h.coordinator.check();
  clock += HOUR;
  await h.coordinator.check();
  assert.equal(h.states.filter((entry, i, all) => entry.staleCheckSince === since && all[i - 1]?.staleCheckSince !== since).length, 1);

  fail = false;
  await h.coordinator.check();
  assert.equal(h.getState().staleCheckSince, undefined);
});

test("health: the notice fires once per streak", () => {
  let clock = 0;
  const seen = [];
  const health = createCheckHealth({ now: () => clock, onStale: (since) => seen.push(since), onRecovered: () => seen.push("ok") });
  health.failed();
  clock = 25 * HOUR;
  health.failed();
  health.failed();
  assert.deepEqual(seen, [new Date(0).toISOString()]);
  health.succeeded();
  assert.deepEqual(seen.at(-1), "ok");
});

test("describeCheckFailure names code, status and net error only", () => {
  assert.equal(describeCheckFailure(Object.assign(new Error("x"), { code: "ERR_X", statusCode: 503 })), "Update check failed (stage=provider code=ERR_X status=503)");
  assert.match(describeCheckFailure(new Error("net::ERR_INTERNET_DISCONNECTED at https://private")), /net=ERR_INTERNET_DISCONNECTED/);
});

test("latest-release lookup: a release with its yml becomes a download folder; drafts and bad tags do not", async () => {
  const reply = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });
  const good = { tag_name: "v1.0.3", draft: false, prerelease: false, assets: [{ name: "latest-mac.yml" }] };
  assert.deepEqual(await resolveLatestReleaseFeed({ fetchImpl: reply(good) }), {
    tag: "v1.0.3",
    url: "https://github.com/FerroxLabs/murage-releases/releases/download/v1.0.3",
  });
  assert.equal(await resolveLatestReleaseFeed({ fetchImpl: reply({ ...good, draft: true }) }), null);
  assert.equal(await resolveLatestReleaseFeed({ fetchImpl: reply({ ...good, tag_name: "../evil" }) }), null);
  assert.equal(await resolveLatestReleaseFeed({ fetchImpl: reply({ ...good, assets: [] }) }), null);
  await assert.rejects(resolveLatestReleaseFeed({ fetchImpl: reply({}, false, 403) }), { statusCode: 403 });
});

test("fallback feed switches to a generic provider and back to GitHub", async () => {
  const calls = [];
  const feed = createGithubFallbackFeed({ setFeedURL: (value) => calls.push(value) }, { resolve: async () => ({ tag: "v1.0.3", url: "https://example.test/d" }) });
  assert.equal(await feed.activate(), true);
  feed.reset();
  feed.reset();
  assert.deepEqual(calls, [
    { provider: "generic", url: "https://example.test/d" },
    { provider: "github", owner: "FerroxLabs", repo: "murage-releases" },
  ]);
});
