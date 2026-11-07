import { removeTempDirSync } from "../../testing/cleanup.ts";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());
vi.mock("../../procs.ts", async (original) => ({
  ...await original<typeof import("../../procs.ts")>(),
  execCli: run,
}));
import { canListOpenCodeModels, discoverOpenCodeModels, resetOpenCodeModelCache } from "./opencode-go.ts";

describe("OpenCode catalog ownership", () => {
  beforeEach(() => { resetOpenCodeModelCache(); run.mockReset(); });

  it("does not reuse another binary's model list after a probe failure", async () => {
    run.mockImplementation((_cli, _args, _options, callback) => callback(null, "private/model\n", ""));
    await discoverOpenCodeModels({}, "first");
    run.mockImplementation((_cli, _args, _options, callback) => callback(new Error("offline"), "", ""));
    const other = await discoverOpenCodeModels({}, "second");
    expect(other.options.map(row => row.id)).not.toContain("private/model");
    expect((await discoverOpenCodeModels({}, "first")).options.map(row => row.id)).toContain("private/model");
  });

  it("does not reuse another home's catalog or anonymous model probe", async () => {
    run.mockImplementation((_cli, _args, _options, callback) => callback(null, "private/model\n", ""));
    await discoverOpenCodeModels({ HOME: "/first" });
    run.mockImplementation((_cli, _args, _options, callback) => callback(new Error("offline"), "", ""));
    expect((await discoverOpenCodeModels({ HOME: "/second" })).options.map(row => row.id)).not.toContain("private/model");
    const probe = vi.fn(async ( _cli: string, env: Record<string, string | undefined>) => env.HOME === "/first" ? "private/model\n" : "");
    expect(await canListOpenCodeModels({ HOME: "/first" }, "opencode", probe)).toBe(true);
    expect(await canListOpenCodeModels({ HOME: "/second" }, "opencode", probe)).toBe(false);
  });

  it("waits for a shared refresh before either concurrent caller reads the list", async () => {
    let finish!: () => void;
    let refreshed = false;
    run.mockImplementation((_cli, args, _options, callback) => {
      if (args.includes("--refresh")) finish = () => { refreshed = true; callback(null, "", ""); };
      else callback(null, refreshed ? "provider/new\n" : "provider/stale\n", "");
    });
    const first = discoverOpenCodeModels({}, "opencode", { refresh: true });
    const second = discoverOpenCodeModels({}, "opencode", { refresh: true });
    await Promise.resolve();
    expect(run.mock.calls.filter(call => !call[1].includes("--refresh"))).toHaveLength(0);
    finish();
    expect((await Promise.all([first, second])).map(row => row.default)).toEqual(["provider/new", "provider/new"]);
    expect(run.mock.calls.filter(call => call[1].includes("--refresh"))).toHaveLength(1);
  });

  it("lets a failed refresh be retried immediately", async () => {
    let refreshes = 0;
    run.mockImplementation((_cli, args, _options, callback) => {
      if (args.includes("--refresh")) { refreshes++; callback(new Error("offline"), "", ""); }
      else callback(null, "provider/model\n", "");
    });
    await discoverOpenCodeModels({}, "opencode", { refresh: true });
    await discoverOpenCodeModels({}, "opencode", { refresh: true });
    expect(refreshes).toBe(2);
  });

  it("scopes refresh throttling to inline provider config", async () => {
    run.mockImplementation((_cli, args, _options, callback) => callback(null, args.includes("--refresh") ? "" : "provider/model\n", ""));
    await discoverOpenCodeModels({ OPENCODE_CONFIG_CONTENT: "first" }, "opencode", { refresh: true });
    await discoverOpenCodeModels({ OPENCODE_CONFIG_CONTENT: "second" }, "opencode", { refresh: true });
    expect(run.mock.calls.filter(call => call[1].includes("--refresh"))).toHaveLength(2);
  });

  it("also holds a passive lookup behind an outstanding refresh", async () => {
    let finish!: () => void;
    run.mockImplementation((_cli, args, _options, callback) => {
      if (args.includes("--refresh")) finish = () => callback(null, "", "");
      else callback(null, "provider/new\n", "");
    });
    const refreshing = discoverOpenCodeModels({}, "opencode", { refresh: true });
    const passive = discoverOpenCodeModels({}, "opencode");
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    expect((await Promise.all([refreshing, passive])).map(row => row.default)).toEqual(["provider/new", "provider/new"]);
  });

  it("bounds retained catalogs after environment changes", async () => {
    run.mockImplementation((_cli, _args, _options, callback) => callback(null, "private/model\n", ""));
    for (let i = 0; i < 129; i++) await discoverOpenCodeModels({ HOME: String(i) });
    run.mockImplementation((_cli, _args, _options, callback) => callback(new Error("offline"), "", ""));
    expect((await discoverOpenCodeModels({ HOME: "0" })).options.map(row => row.id)).not.toContain("private/model");
    expect((await discoverOpenCodeModels({ HOME: "128" })).options.map(row => row.id)).toContain("private/model");
  });
});

describe("on-disk catalog identity", () => {
  it.each(["auth", "config", "binary", "path"])("invalidates retained catalogs and probes when %s changes in place", async (kind) => {
    resetOpenCodeModelCache();
    const home = mkdtempSync(join(tmpdir(), "b89-identity-"));
    const folder = join(home, kind === "auth" ? ".local/share/opencode" : ".config/opencode");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, kind === "auth" ? "auth.json" : kind === "binary" || kind === "path" ? "engine.exe" : "opencode.json");
    const env = { HOME: home, ...(kind === "path" ? { PATH: folder } : {}) };
    const cli = kind === "binary" ? file : kind === "path" ? "engine.exe" : "opencode";
    try {
      writeFileSync(file, '{"account":"first"}');
      chmodSync(file, 0o700);
      // Whole seconds survive filesystem timestamp precision round trips.
      utimesSync(file, 1700000000, 1700000000);
      const before = statSync(file);
      run.mockImplementation((_cli, _args, _options, callback) => callback(null, "private/model\n", ""));
      await discoverOpenCodeModels(env, cli);
      const probe = vi.fn(async () => "private/model\n");
      expect(await canListOpenCodeModels(env, cli, probe)).toBe(true);
      writeFileSync(file, '{"account":"other"}');
      if (kind === "auth" || kind === "config") {
        utimesSync(file, before.atime, before.mtime);
        const after = statSync(file);
        expect([after.ino, after.size, after.mtimeMs]).toEqual([before.ino, before.size, before.mtimeMs]);
      }
      run.mockImplementation((_cli, _args, _options, callback) => callback(new Error("offline"), "", ""));
      probe.mockResolvedValue("");
      expect((await discoverOpenCodeModels(env, cli)).options.map(row => row.id)).not.toContain("private/model");
      expect(await canListOpenCodeModels(env, cli, probe)).toBe(false);
    } finally { removeTempDirSync(home); }
  });
});

it("discards a catalog and anonymous probe if credentials change during the request", async () => {
  resetOpenCodeModelCache();
  const home = mkdtempSync(join(tmpdir(), "b89-race-"));
  const dir = join(home, ".local/share/opencode");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "auth.json");
  const env = { HOME: home };
  try {
    writeFileSync(file, "first");
    let finish!: () => void;
    run.mockImplementation((_cli, _args, _options, callback) => { finish = () => callback(null, "private/model\n", ""); });
    const pending = discoverOpenCodeModels(env);
    await Promise.resolve();
    writeFileSync(file, "other");
    finish();
    expect((await pending).options.map(row => row.id)).not.toContain("private/model");
    let finishProbe!: (value: string) => void;
    const pendingProbe = canListOpenCodeModels(env, "opencode", () => new Promise(resolve => { finishProbe = resolve; }));
    writeFileSync(file, "third");
    finishProbe("private/model\n");
    expect(await pendingProbe).toBe(false);
  } finally { removeTempDirSync(home); }
});

it("uses fresh oversized config results without caching catalogs or auth probes", async () => {
  resetOpenCodeModelCache();
  const home = mkdtempSync(join(tmpdir(), "opencode-oversized-"));
  const config = join(home, "opencode.json");
  const env = { HOME: home, OPENCODE_CONFIG: config };
  try {
    writeFileSync(config, JSON.stringify({ description: "x".repeat(1024 * 1024) }));
    run.mockImplementation((_cli, _args, _options, callback) => callback(null, "private/model\n", ""));
    expect(await discoverOpenCodeModels(env)).toMatchObject({ source: "live", default: "private/model" });
    run.mockImplementation((_cli, _args, _options, callback) => callback(new Error("offline"), "", ""));
    expect((await discoverOpenCodeModels(env)).options.map(row => row.id)).not.toContain("private/model");
    const probe = vi.fn(async () => "private/model\n");
    expect(await canListOpenCodeModels(env, "opencode", probe)).toBe(true);
    probe.mockResolvedValue("");
    expect(await canListOpenCodeModels(env, "opencode", probe)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  } finally { removeTempDirSync(home); }
});

describe("referenced-file cache isolation", () => {
  it.each(["opencode.json", "opencode.jsonc", "config.json", "explicit", "inline"])(
    "does not reuse catalogs or positive probes after only a referenced file changes (%s)", async (source) => {
      resetOpenCodeModelCache();
      const home = mkdtempSync(join(tmpdir(), "opencode-reference-"));
      const dir = join(home, ".config/opencode");
      mkdirSync(dir, { recursive: true });
      const dependency = join(dir, "provider-key");
      const config = JSON.stringify({ provider: { private: { options: { apiKey: `{file:${dependency}}` } } } });
      const env: Record<string, string> = { HOME: home };
      if (source === "inline") env.OPENCODE_CONFIG_CONTENT = config;
      else {
        const path = join(dir, source === "explicit" ? "custom.json" : source);
        writeFileSync(path, config);
        if (source === "explicit") env.OPENCODE_CONFIG = path;
      }
      try {
        writeFileSync(dependency, "first-secret");
        run.mockImplementation((_cli, _args, _options, callback) => callback(null, "private/model\n", ""));
        expect(await discoverOpenCodeModels(env)).toMatchObject({ source: "live", default: "private/model" });
        const probe = vi.fn(async () => "private/model\n");
        expect(await canListOpenCodeModels(env, "opencode", probe)).toBe(true);
        // The configuration and environment stay byte-for-byte identical.
        writeFileSync(dependency, "other-secret");
        run.mockImplementation((_cli, _args, _options, callback) => callback(new Error("offline"), "", ""));
        probe.mockResolvedValue("");
        expect.soft((await discoverOpenCodeModels(env)).options.map(row => row.id)).not.toContain("private/model");
        expect.soft(await canListOpenCodeModels(env, "opencode", probe)).toBe(false);
        expect(probe).toHaveBeenCalledTimes(2);
      } finally { removeTempDirSync(home); }
    },
  );
});
