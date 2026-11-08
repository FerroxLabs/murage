import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OpenCodeDestinationKey, DESTINATION_CONFIG_ENV, destinationAccountRemote } from "./opencode-destination-key.ts";
import { OpenCodeDestinationResolver, openCodeDestinationAnswer, type DestinationContext } from "./opencode-destination.ts";
import { fluxDestination } from "./flux-destination.ts";
import { DatabaseSync } from "node:sqlite";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "x4-destination-")); roots.push(root);
  const cwd = join(root, "project"); mkdirSync(cwd);
  const cli = join(root, "cli"); writeFileSync(cli, "fixture");
  const env = { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed") } as Record<string, string>;
  const ctx: DestinationContext = { cwd, cli, env, signal: new AbortController().signal, model: "p/m", memoryOff: true };
  const key = new OpenCodeDestinationKey();
  const read = () => key.read(env, cwd, cli, Date.now() + 10_000);
  const write = (path: string, text = "{}") => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  return { root, cwd, cli, env, ctx, read, write };
}
it.each(["baseURL", "endpoint", "api", "model-api"])("judges %s and refuses an alias", field => {
  const provider = field === "api" ? { api: "https://api.fluxrouter.ai/v1" } : field === "model-api" ? { models: { m: { api: "https://api.fluxrouter.ai/v1" } } } : { options: { [field]: "https://api.fluxrouter.ai/v1" } };
  const answer = openCodeDestinationAnswer({ provider: { p: provider } }, { model: "p/m", memoryOff: true });
  expect(fluxDestination(answer, "flux")).toBe("refuse-alias");
});
it("pins the default and judges every provider when no default is known", () => {
  expect(openCodeDestinationAnswer({ model: "p/m" }, { memoryOff: true }).model).toBe("p/m");
  const answer = openCodeDestinationAnswer({ provider: { alias: { options: { baseURL: "https://api.fluxrouter.ai" } } } }, { memoryOff: true });
  expect(fluxDestination(answer, "flux")).toBe("refuse-alias");
});
it("refuses missing resumed models and pre-existing memory headers", () => {
  const answer = openCodeDestinationAnswer({ provider: { flux: { options: { headers: { "X-Flux-Memory-Inject": "on" } } } } }, { model: "flux/m", memoryOff: true });
  expect(fluxDestination(answer, "flux")).toBe("refuse-unknown");
  expect(fluxDestination(answer.forModel!("missing/m", true), "flux")).toBe("refuse-unknown");
  expect(fluxDestination(answer.forModel!(undefined, true), "flux")).toBe("refuse-unknown");
});
it.each([false, 1, "{env:X}", "api.fluxrouter.ai/v1"])("refuses unjudgeable URL %s", baseURL => {
  expect(fluxDestination(openCodeDestinationAnswer({ provider: { p: { options: { baseURL } } } }, { model: "p/m", memoryOff: true }), "flux")).toBe("refuse-unknown");
});
it.each(["options", "model"])("refuses memory-off Flux with %s-only memory headers", level => {
  const headers = { "X-FlUx-MeMoRy-Inject": "on" };
  const provider = level === "options" ? { options: { headers } } : { models: { m: { headers } } };
  const answer = openCodeDestinationAnswer({ provider: { flux: provider } }, { model: "flux/m", memoryOff: true });
  expect(answer).toMatchObject({ unknown: "config" });
  expect(fluxDestination(answer, "flux")).toBe("refuse-unknown");
});
it("keeps Flux connector with clean options and model headers", () => {
  const provider = { options: { headers: { "X-Client": "fixture" } }, models: { m: { headers: { "X-Model": "fixture" } } } };
  expect(fluxDestination(openCodeDestinationAnswer({ provider: { flux: provider } }, { model: "flux/m", memoryOff: true }), "flux")).toBe("connector");
});
it("refuses model memory headers in the no-model scan", () => {
  const provider = { models: { m: { headers: { "X-Flux-Memory-Capture": "on" } } } };
  const answer = openCodeDestinationAnswer({ provider: { flux: provider } }, { memoryOff: true });
  expect(answer).toMatchObject({ unknown: "config" });
  expect(fluxDestination(answer, "flux")).toBe("refuse-unknown");
});
it.each(["options", "model"])("refuses malformed %s header maps on memory-off Flux", level => {
  for (const headers of [true, 42, "x", [], null, undefined, { "x-other": 1 }]) {
    const provider = level === "options" ? { options: { headers } } : { models: { m: { headers } } };
    for (const model of ["flux/m", undefined]) {
      const answer = openCodeDestinationAnswer({ provider: { flux: provider } }, { model, memoryOff: true });
      expect(answer).toMatchObject({ unknown: "config" });
      expect(fluxDestination(answer, "flux")).toBe("refuse-unknown");
    }
  }
});
it.each(["options", "model"])("keeps connector with clean %s header maps on memory-off Flux", level => {
  for (const headers of [{}, { "x-other": "fixture" }]) {
    const provider = level === "options" ? { options: { headers } } : { models: { m: { headers } } };
    for (const model of ["flux/m", undefined]) {
      expect(fluxDestination(openCodeDestinationAnswer({ provider: { flux: provider } }, { model, memoryOff: true }), "flux")).toBe("connector");
    }
  }
});
it.each(["alias", "unknown"])("caches a successful %s refusal across unchanged turns", async kind => {
  const f = fixture();
  const probe = vi.fn(async () => ({ provider: { p: { api: kind === "alias" ? "https://api.fluxrouter.ai" : "{env:UNRESOLVED}" } } }));
  const resolver = new OpenCodeDestinationResolver(probe, () => Date.now() + 10_000);
  for (let turn = 0; turn < 2; turn++) {
    expect(fluxDestination(await resolver.resolve(f.ctx), "flux")).toBe(`refuse-${kind}`);
  }
  expect(probe).toHaveBeenCalledTimes(1);
});
it("empty env substitution means the provider default", () => {
  for (const id of ["p", "flux"]) expect(fluxDestination(openCodeDestinationAnswer({ provider: { [id]: { options: { baseURL: "" } } } }, { model: `${id}/m`, memoryOff: true }), "flux")).toBe(id === "flux" ? "connector" : "other");
});
it("caches a settled probe and rejudges the current model", async () => {
  const f = fixture(); const probe = vi.fn(async () => ({ provider: { p: {}, alias: { api: "https://api.fluxrouter.ai" } } }));
  const resolver = new OpenCodeDestinationResolver(probe, () => Date.now() + 10_000);
  await resolver.resolve(f.ctx);
  expect(fluxDestination((await resolver.resolve({ ...f.ctx, model: "alias/m" })), "flux")).toBe("refuse-alias");
  expect(probe).toHaveBeenCalledTimes(1);
});
it("never saves failures or a key moved during the probe", async () => {
  const f = fixture(); const probe = vi.fn(async () => { f.write(join(f.cwd, "opencode.json"), JSON.stringify({ n: Math.random() })); return {}; });
  const resolver = new OpenCodeDestinationResolver(probe, () => Date.now() + 10_000);
  await resolver.resolve(f.ctx); await resolver.resolve(f.ctx); expect(probe).toHaveBeenCalledTimes(2);
  const failed = vi.fn(async () => { throw new Error("private output must not escape"); });
  const bad = new OpenCodeDestinationResolver(failed, () => Date.now() + 10_000);
  expect(fluxDestination((await bad.resolve(f.ctx)), "flux")).toBe("refuse-unknown");
  await bad.resolve(f.ctx); expect(failed).toHaveBeenCalledTimes(2);
});
it("tracks ancestor files, file and env tokens, symlink targets and executable changes", () => {
  const f = fixture(); let last = f.read().key;
  const changed = () => { const next = f.read().key; expect(next).not.toBe(last); last = next; };
  f.write(join(f.root, "opencode.json"), '{"api":"{env:ROUTER_URL}","key":"{file:secret}"}'); changed();
  f.env.ROUTER_URL = "https://example.org"; changed();
  f.write(join(f.root, "secret"), "one"); changed();
  f.write(f.cli, "upgraded"); changed();
  f.write(join(f.cwd, "a"), "{}"); f.write(join(f.cwd, "b"), "{}");
  symlinkSync(join(f.cwd, "a"), join(f.cwd, "opencode.json")); changed();
  rmSync(join(f.cwd, "opencode.json")); symlinkSync(join(f.cwd, "b"), join(f.cwd, "opencode.json")); changed();
});
it.each(DESTINATION_CONFIG_ENV)("includes final handed %s in the key", name => {
  const f = fixture(), before = f.read().key; f.env[name] = join(f.root, "changed"); expect(f.read().key).not.toBe(before);
});
it("reads active account org state read-only on every turn", () => {
  const f = fixture(); f.env.OPENCODE_DB = join(f.root, "account.db");
  const db = new DatabaseSync(f.env.OPENCODE_DB);
  db.exec("CREATE TABLE account_state(id INTEGER, active_account_id TEXT, active_org_id TEXT); INSERT INTO account_state VALUES(1,'account',NULL)");
  expect(destinationAccountRemote(f.env)).toBe(false);
  db.exec("UPDATE account_state SET active_org_id='org'");
  expect(destinationAccountRemote(f.env)).toBe(true); db.close();
});

it("never caches an unpinned development-channel account database", async () => {
  const f = fixture(), probe = vi.fn(async () => ({}));
  const resolver = new OpenCodeDestinationResolver(probe, () => Date.now() + 10_000);
  await resolver.resolve({ ...f.ctx, cliVersion: "0.0.0-dev-fixture" });
  await resolver.resolve({ ...f.ctx, cliVersion: "0.0.0-dev-fixture" });
  expect(probe).toHaveBeenCalledTimes(2);
});

it.each(["provider-api", "baseURL", "endpoint"])("judges model-specific %s from the config schema", field => {
  const model = field === "provider-api" ? { provider: { api: "https://api.fluxrouter.ai" } } : { options: { [field]: "https://api.fluxrouter.ai" } };
  const answer = openCodeDestinationAnswer({ provider: { p: { models: { m: model } } } }, { model: "p/m", memoryOff: true });
  expect(fluxDestination(answer, "flux")).toBe("refuse-alias");
});

it("never caches managed plist tokens that require structured decoding", () => {
  const f = fixture(); f.env.OPENCODE_CONFIG = join(f.root, "managed.plist");
  f.write(f.env.OPENCODE_CONFIG, "bplist00fixture"); expect(f.read().cacheable).toBe(false);
});
