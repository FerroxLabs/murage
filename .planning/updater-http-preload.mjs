// Fixture-only dependency injection. The real server, owner routing, manager,
// config persistence, busy/stale checks and reload rollback remain executable.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { nativeFixtureAsset } from "../server/testing/fuigo-native-fixture.ts";
let state = { version: "1.0.9", mode: "normal", downloads: 0, probes: 0, activations: 0, networkDenied: [] };
let controls;
globalThis.fetch = async input => {
  const url = String(input), asset = nativeFixtureAsset(state.version);
  if (url === "https://registry.npmjs.org/fuigo/latest") return Response.json({ name: "fuigo", version: state.version });
  if (url === `https://registry.npmjs.org/%40fuigo%2Fdarwin-arm64/${state.version}`) return Response.json(asset.metadata);
  if (url === asset.metadata.dist.tarball) { state.downloads++; return new Response(new Uint8Array(asset.archive)); }
  state.networkDenied.push(new URL(url).origin);
  throw new Error("Fixture denied a non-updater request");
};
globalThis.__updaterFixture = {
  deps(deps) {
    return { ...deps, fetch: globalThis.fetch,
      fuigoProbe: async (_cli, version) => {
        state.probes++;
        if (state.mode === "probe-stale") controls.select(`${process.env.MURAGE_DATA_DIR}/concurrent-choice`);
        if (state.mode === "probe-busy") controls.busy(true);
        return { version: version ?? "1.0.9", protocolVersion: 1, loadSession: true, sessionCreated: true };
      },
      activate: async (...args) => {
        state.activations++;
        if (state.mode === "root-stale") controls.select(`${process.env.MURAGE_DATA_DIR}/concurrent-choice`);
        if (state.mode === "root-busy") controls.busy(true);
        return deps.activate(...args);
      },
    };
  },
  ready(value) { controls = value; process.send?.({ fixture: "ready" }); },
};
process.on("message", message => {
  if (!message || message.fixture !== "control" || !controls) return;
  try {
    if (message.mode) state.mode = message.mode;
    if (message.version) state.version = message.version;
    if (message.cli !== undefined) controls.select(message.cli);
    if (message.busy !== undefined) controls.busy(message.busy);
    if (message.failReload) controls.failReload();
    process.send?.({ fixture: "reply", id: message.id, state: { ...state, ...controls.snapshot() } });
  } catch (error) { process.send?.({ fixture: "reply", id: message.id, error: error.message }); }
});
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith("/server/engine-management.ts")) {
    const source = readFileSync(new URL(url), "utf8"), anchor = "constructor(deps: Dependencies) { this.deps = deps; }";
    if (!source.includes(anchor)) throw new Error("Updater dependency fixture anchor changed");
    return { format: "module-typescript", shortCircuit: true, source: source.replace(anchor,
      "constructor(deps: Dependencies) { this.deps = globalThis.__updaterFixture.deps(deps); }") };
  }
  if (url.endsWith("/server/index.ts")) {
    const source = readFileSync(new URL(url), "utf8");
    return { format: "module-typescript", shortCircuit: true, source: source + `
const updaterFixtureBot = store.createBot({ name: "Updater fixture", modelSelection: { instanceId: "fuigo", model: "fixture" } }, { seedMessages: false });
let updaterFixtureRun;
globalThis.__updaterFixture.ready({
  select(cli) {
    const next = withInstanceCli(cfg, "fuigo", cli);
    if (!next.ok) throw new Error("Fixture Fuigo configuration missing");
    saveConfig({ instances: next.config.instances }); Object.assign(cfg, loadConfig());
  },
  busy(value) {
    if (value && !updaterFixtureRun) updaterFixtureRun = directRuns.admit(updaterFixtureBot.id, updaterFixtureBot.threadId, updaterFixtureBot);
    if (!value && updaterFixtureRun) { directRuns.release(updaterFixtureRun); updaterFixtureRun = undefined; }
  },
  failReload() {
    const original = registry.load.bind(registry);
    registry.load = async (...args) => { registry.load = original; throw new Error("Injected provider reload failure"); };
  },
  snapshot() { return { selectedCli: instanceConfigs(cfg).fuigo?.config?.cli ?? null, providerConfigBusy,
    directRuns: directRuns.forBot(updaterFixtureBot.id).length, primaryBotBusy: Boolean(updaterFixtureBot.busy) }; },
});
` };
  }
  return nextLoad(url, context);
} });
