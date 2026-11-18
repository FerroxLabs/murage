import fs from "node:fs";
import { classifyDataDirEntry } from "./data-dir-inventory.ts";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { credentialCoverage, checkCoverageCase, type CoverageCase } from "./testing/credential-coverage.ts";
import { SENSITIVE_PATHS } from "../shared/sensitive-paths.ts";
import { dataCredentialHit } from "../shared/data-credential-paths.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const { createCuaConnectionStore } = createRequire(import.meta.url)("../electron/cua-connection.cjs");

it.each(["cua-connection.json", "browser-connection.json"])("covers every real descriptor-writer destination for %s", fileName => {
  const source = fs.readFileSync("docs/verification/gate-credential-writers-1018.md", "utf8");
  const line = source.split("\n").find(line => line.startsWith("electron/cua-connection.cjs:35 | A |"))!;
  const [coverage] = credentialCoverage(line);
  expect(coverage).toBeDefined();
  const fixture = fs.mkdtempSync(join(tmpdir(), "murage-writer-coverage-"));
  try {
    for (const branch of ["default userData", "relocated userData"]) {
      const root = join(fixture, branch);
      const destinations: string[] = [];
      // Observe the actual filesystem operations; every call still writes and renames real files.
      const fileSystem = { ...fs,
        openSync(path: string, flags: string, mode: number) { destinations.push(path); return fs.openSync(path, flags, mode); },
        renameSync(from: string, to: string) { destinations.push(to); return fs.renameSync(from, to); },
      };
      createCuaConnectionStore({ getUserData: () => root, fileSystem, fileName }).persist({ token: "fixture-only-credential" });
      expect(JSON.parse(fs.readFileSync(join(root, fileName), "utf8"))).toEqual({ token: "fixture-only-credential" });
      expect(destinations).toHaveLength(2);
      expect(destinations[0]).toMatch(/\.\d+\.[0-9a-f-]+\.tmp$/);
      for (const path of destinations) {
        const tail = relative(root, path).replaceAll("\\", "/");
        for (const representativeRoot of new Set(coverage!.cases.map(row => row.root))) {
          const candidates = coverage!.cases.filter(row => row.root === representativeRoot);
          expect(candidates.some(row => dataCredentialHit([row.root + "/" + tail], [row.root], [row.cover])), `${branch}: ${tail} at ${representativeRoot}`).toBe(true);
        }
      }
    }
  } finally { removeTempDirSync(fixture); }
});


// Every observer forwards to the real filesystem. No successful write is fabricated.
const observed = vi.hoisted(() => ({ paths: [] as string[], active: false }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  const copy = { ...real };
  for (const name of ["openSync", "writeFileSync", "appendFileSync", "renameSync", "copyFileSync", "linkSync"] as const) {
    const original = real[name] as (...args: unknown[]) => unknown;
    Object.assign(copy, { [name]: (...args: unknown[]) => {
      const target = args[name === "renameSync" || name === "copyFileSync" || name === "linkSync" ? 1 : 0];
      const flags = args[1];
      const writing = name !== "openSync" || (typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" && (flags & 3) !== 0);
      if (observed.active && writing && typeof target === "string") observed.paths.push(target);
      return original(...args);
    } });
  }
  return { ...copy, default: copy };
});
vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const copy = { ...real };
  for (const name of ["open", "writeFile", "rename", "copyFile"] as const) {
    const original = real[name] as (...args: unknown[]) => unknown;
    Object.assign(copy, { [name]: (...args: unknown[]) => {
      const target = args[name === "rename" || name === "copyFile" ? 1 : 0];
      const flags = args[1];
      const writing = name !== "open" || (typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" && (flags & 3) !== 0);
      if (observed.active && writing && typeof target === "string") observed.paths.push(target);
      return original(...args);
    } });
  }
  return { ...copy, default: copy };
});
// Counted writers capture pristine fs methods before Vitest mocks; observe their
// public boundary too, forwarding every call to the real counted implementation.
vi.mock("./counted-fs.ts", async importOriginal => {
  const real = await importOriginal<typeof import("./counted-fs.ts")>();
  const copy = { ...real };
  for (const name of ["writeFileSync", "appendFileSync", "copyFileSync"] as const) {
    const original = real[name] as (...args: unknown[]) => unknown;
    Object.assign(copy, { [name]: (...args: unknown[]) => {
      const target = args[name === "copyFileSync" ? 1 : 0];
      if (observed.active && typeof target === "string") observed.paths.push(target);
      return original(...args);
    } });
  }
  return { ...copy, default: { ...real.default, ...copy } };
});
type WriterFixture = (data: string, home: string) => Promise<void>;
const fixtures: Record<number, WriterFixture> = {};
const seed = (file: string, text: string) => {
  const active = observed.active; observed.active = false;
  try { fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, text, { mode: 0o600 }); }
  finally { observed.active = active; }
};
// OS keyring bytes are inert; filesystem writes and serialization are the production implementations.
const safeStorage = { isEncryptionAvailable: () => true, isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => "gnome_libsecret",
  encryptString: (text: string) => Buffer.from(text), decryptString: (bytes: Buffer) => bytes.toString() };
fixtures[3] = async data => {
  // @ts-expect-error Electron JavaScript module has no TypeScript declaration.
  const { createCloudHomeStore } = await import("../electron/cloud-home-store.mjs");
  const store = createCloudHomeStore({ safeStorage, directory: join(data, "cloud-homes"), platform: process.platform });
  const record = { homeId: "fixture", cpEnvironment: "test", publicOrigin: "https://fixture.invalid", environmentId: "fixture", homeKey: "fixture", generation: 1, deviceId: "fixture", account: "fixture", sessionPrivateKey: "session-fixture", assertionPrivateKey: "assertion-fixture", pinnedAt: 1 };
  await store.save(record);
  await store.savePending({ sessionPublicKey: "session-public", sessionPrivateKey: "session-fixture", assertionPublicKey: "assertion-public", assertionPrivateKey: "assertion-fixture", cpEnvironment: "test", startedAt: 1 });
  await store.saveRevocations([{ ...record, cancelledAt: 2 }]);
};
fixtures[4] = async data => {
  // @ts-expect-error Electron JavaScript module has no TypeScript declaration.
  const { stashDoorLink } = await import("../electron/cloud-link-handoff.mjs");
  await stashDoorLink({ safeStorage, directory: join(data, "cloud-homes"), url: `murage://door?h=home-0123456789abcdef01234567&o=${encodeURIComponent("https://h-0123456789abcdef0123456789abcdef.murage.ai")}#t=${Buffer.from(JSON.stringify({ type: "murage-door-v2", account: "fixture", bind: "a".repeat(64) })).toString("base64url")}.${"S".repeat(86)}`, now: () => 1 });
};
fixtures[5] = async data => {
  // @ts-expect-error Electron JavaScript module has no TypeScript declaration.
  const { recordSidecar } = await import("../electron/companion-stale.mjs");
  expect(await recordSidecar(data, { pid: 42, recoveryToken: "a".repeat(64) }, { available: async () => true, encrypt: async (text: string) => Buffer.from(text) })).toBe("recorded");
};
fixtures[6] = async data => {
  for (const fileName of ["cua-connection.json", "browser-connection.json"]) {
    const fileSystem = { ...fs, openSync(path: string, flags: string, mode: number) { observed.paths.push(path); return fs.openSync(path, flags, mode); }, renameSync(from: string, to: string) { observed.paths.push(to); return fs.renameSync(from, to); } };
    createCuaConnectionStore({ getUserData: () => data, fileSystem, fileName }).persist({ token: "fixture-only" });
  }
};
fixtures[18] = async data => {
  const { writePrivateBrowserClientJson } = await import("./browser-extension-clients.ts");
  const file = join(data, "browser-extension/client-configs/client.json");
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writePrivateBrowserClientJson(file, { token: "fixture-only" });
};
fixtures[20] = async data => {
  const { fileAuthKey } = await import("./channels/whatsapp/auth-key-source.ts");
  expect(fileAuthKey(data)).toMatch(/^[a-f0-9]{64}$/);
};
fixtures[22] = async data => {
  const { useEncryptedAuthState } = await import("./channels/whatsapp/core/auth-store.ts");
  const dir = join(data, "whatsapp/auth");
  const key = Buffer.alloc(32, 7);
  const options = { initCreds: () => ({ fixture: true }) };
  const state = await useEncryptedAuthState(dir, key, options);
  await state.saveCreds(); await state.saveCreds();
  await state.state.keys.set({ session: { fixture: { token: "fixture-only" } } });
  await state.flush();
  seed(join(dir, "creds.bin"), "broken");
  expect((await useEncryptedAuthState(dir, key, options)).restoredFromBackup).toBe(true);
};
fixtures[23] = async data => {
  const { replaceClaudeAccountInstances, restoreClaudeAccountInstances } = await import("./claude-account-config.ts");
  const path = join(data, "config.json"); seed(path, '{"instances":{}}');
  restoreClaudeAccountInstances(replaceClaudeAccountInstances({}, path));
};
fixtures[25] = async data => {
  const { SealedSecretStore } = await import("./cloud-home/secrets.ts");
  const store = new SealedSecretStore(data, "fixture", Buffer.alloc(32, 7));
  try { expect(store.patch({ apiKey: "fixture-only" }).apiKey).toBe("fixture-only"); } finally { store.close(); }
};
fixtures[27] = async data => {
  const { handOverInitialTools } = await import("./connector-cache-harness.ts");
  expect(handOverInitialTools({ dir: join(data, "connector-tools-cache"), windowsPrivate: false }, { identity: "fixture", revision: "1" }, [{ name: "fixture" }])).not.toBeNull();
};
fixtures[28] = async data => {
  const { writeCacheEntry } = await import("./connector-cache.ts");
  const dir = join(data, "connector-tools-cache"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  expect(writeCacheEntry(dir, "fixture.json", '{"tools":[]}')).toBe(true);
};
fixtures[10] = async data => {
  // @ts-expect-error Electron JavaScript module has no TypeScript declaration.
  const { saveSkillRecording } = await import("../electron/skill-recording-store.mjs");
  saveSkillRecording({ name: "Fixture", description: "Fixture recording", events: [], transcript: "fixture" }, { dataRoot: data });
};
fixtures[19] = async (data, home) => {
  const { prepareBrowserRestore, markBrowserRestoreVisited, encryptEngineData } = await import("./browser-restore-store.ts");
  for (const selected of [join(data, "browser-engine/bot/home"), home]) for (const suffix of [".json", ".json.enc"]) {
    const dir = join(selected, ".agent-browser/sessions");
    const path = join(dir, "fixture-1" + suffix);
    const body = JSON.stringify({ cookies: [{ name: "fixture", value: "fixture-only" }], origins: [{ origin: "https://fixture.invalid", localStorage: [{ name: "token", value: "fixture-only" }] }] });
    seed(path, body);
    if (suffix.endsWith("enc")) { observed.active = false; fs.writeFileSync(path, encryptEngineData(Buffer.from(body), "fixture-key")); observed.active = true; }
    const spec = { env: { HOME: selected, USERPROFILE: selected, AGENT_BROWSER_RESTORE: "fixture", AGENT_BROWSER_ENCRYPTION_KEY: "fixture-key", AGENT_BROWSER_RESTORE_SAVE: "auto" } };
    expect(prepareBrowserRestore(spec)).toBeDefined();
    expect(markBrowserRestoreVisited(spec, "https://fixture.invalid")).toBe(true);
  }
};
fixtures[21] = async data => {
  const { MediaStore } = await import("./channels/whatsapp/bridge.ts");
  const { Readable } = await import("node:stream");
  const store = new MediaStore(join(data, "whatsapp/media/fixture"), () => 1);
  expect(await store.save("chat", "message", "image/jpeg", Readable.from([Buffer.from("fixture")]), 1024)).not.toBeNull();
};
const engineFixtures = [
  [31, "./drivers/acp/droid.ts", "ensureDroidInjectModel", "removeDroidLocalHost", ".factory/settings.json"],
  [34, "./drivers/acp/grok.ts", "ensureGrokInjectSlug", "removeGrokLocalHost", ".grok/config.toml"],
  [35, "./drivers/acp/hermes.ts", "ensureHermesInjectProvider", "removeHermesLocalHost", ".hermes/config.yaml"],
  [36, "./drivers/acp/kimi.ts", "ensureKimiInjectAlias", "removeKimiLocalHost", ".kimi-code/config.toml"],
  [38, "./drivers/acp/opencode-go.ts", "ensureOpenCodeInjectModel", "removeOpenCodeLocalHost", ".config/opencode/opencode.json"],
  [39, "./drivers/acp/qwen.ts", "ensureQwenInjectModel", "removeQwenLocalHost", ".qwen/settings.json"],
  [48, "./drivers/pi.ts", "ensurePiInjectModel", "removePiLocalHost", ".pi/agent/models.json"],
] as const;
for (const [number, module, add, remove, destination] of engineFixtures) fixtures[number] = async (_data, home) => {
  const writer = await import(module);
  const { localHost } = await import("./drivers/local-inject.ts");
  const env = { HOME: home, USERPROFILE: home, GROK_HOME: join(home, ".grok"), KIMI_CODE_HOME: join(home, ".kimi-code"), HERMES_HOME: join(home, ".hermes"), OPENCODE_CONFIG_DIR: join(home, ".config/opencode") };
  fs.mkdirSync(dirname(join(home, destination)), { recursive: true, mode: 0o700 });
  writer[add]("omlx::fixture-model", env);
  expect(fs.existsSync(join(home, destination))).toBe(true);
  writer[add]("omlx::fixture-model-2", env);
  expect(writer[remove](localHost("omlx")!, env)).toBe("removed");
};
fixtures[32] = async (_data, home) => {
  seed(join(home, ".gemini/settings.json"), '{"security":{"auth":{"selectedType":"oauth-personal"}}}');
  const { isolateGeminiFromPersonalSetup } = await import("./drivers/acp/gemini-isolation.ts");
  isolateGeminiFromPersonalSetup({ HOME: home, USERPROFILE: home }, "fixture", true);
};
fixtures[33] = async (_data, home) => {
  seed(join(home, ".grok/config.toml"), 'api_key = "fixture-only"\n');
  const { scopeGrokHome } = await import("./drivers/acp/grok-scope.ts");
  scopeGrokHome({ HOME: home, USERPROFILE: home }, "1.0.62", "fixture");
};
fixtures[42] = async data => {
  const { ClaudeOverlayStore } = await import("./drivers/claude-private.ts");
  const store = new ClaudeOverlayStore(() => join(data, "claude-private"));
  const path = store.acquire('{"env":{"TOKEN":"fixture-only"}}');
  expect(fs.readFileSync(path, "utf8")).toContain("fixture-only");
  store.release(path);
};
fixtures[43] = async data => {
  const { ClaudeSigninAnswers } = await import("./drivers/claude-signin-answers.ts");
  const store = new ClaudeSigninAnswers(() => join(data, "claude-signin-answers.json"), () => 1);
  store.remember({ files: ["fixture"], canonical: "fixture" }, true);
};
fixtures[45] = async data => {
  const { writeHookFiles } = await import("./drivers/codex-hook.ts");
  const home = join(data, "native/codex-scope/fixture");
  writeHookFiles(home, join(data, "fixture.sock"), "fixture-only", join(home, "hook-env/42-fixture.env"));
};
fixtures[46] = async (_data, home) => {
  seed(join(home, ".codex/config.toml"), 'model = "fixture"\n');
  const { scopedCodexHome } = await import("./drivers/codex-isolation.ts");
  expect(scopedCodexHome({ HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex") }, "0.150.0", "fixture")).not.toBeNull();
};
fixtures[50] = async (_data, home) => {
  const { nodeLinkIo } = await import("./drivers/shared-login-link.ts");
  const file = join(home, ".grok/auth.json"); fs.mkdirSync(dirname(file), { recursive: true });
  nodeLinkIo.writeFileSync(file, Buffer.from('{"token":"fixture-only"}'), { mode: 0o600 });
};
fixtures[52] = async (_data, home) => {
  const { mutOps } = await import("./engine-fs.ts");
  const file = join(home, ".codex/sessions/2026/01/01/rollout-fixture.jsonl"); seed(file, "old\n");
  const fd = fs.openSync(file, "r+");
  try { mutOps.pwrite(fd, Buffer.from("new"), 0); mutOps.append(fd, Buffer.from("tail")); } finally { fs.closeSync(fd); }
};
fixtures[56] = async data => {
  const { keepFuigoTurnLogs } = await import("./fuigo-turn-logs.ts");
  const from = join(data, "fixture-source"); seed(join(from, "logs/engine.log"), "fixture log"); seed(join(from, "logs/sub/engine.log"), "fixture log");
  expect(keepFuigoTurnLogs(from, "turn", join(data, "native/fuigo-turn-logs"))).toBe(true);
};
fixtures[59] = async data => {
  const { HealthPublisher } = await import("./health/publisher.ts");
  expect(new HealthPublisher({ dataDir: data }).loadTokenKey()).toHaveLength(32);
};
fixtures[62] = async data => {
  const { configureLocalServerStore, writeLocalServers } = await import("./local-servers.ts");
  configureLocalServerStore(data);
  try { writeLocalServers([{ id: "fixture", name: "Fixture", kind: "openai", apiBase: "http://127.0.0.1:1/v1", apiKey: "fixture-only", createdAt: 1, updatedAt: 1 }]); }
  finally { configureLocalServerStore(null); }
};
fixtures[63] = async data => {
  const { readOrCreateMcpAccessKey } = await import("./mcp-access.ts");
  expect(readOrCreateMcpAccessKey(data)).toMatch(/^[a-f0-9]{64}$/);
};
fixtures[64] = async data => {
  const { pinReflectionFuigoConfig } = await import("./memory/pip-transport.ts");
  const home = join(data, "pip-tmp/run/home"); seed(join(home, "config.toml"), 'api_key = "fixture-only"\n');
  pinReflectionFuigoConfig(home);
};
fixtures[41] = async (data, home) => {
  const { buildAntigravityScopedHome } = await import("./drivers/antigravity-scope.ts");
  seed(join(home, ".gemini/config/preferences.json"), '{"fixture":true}');
  const scope = buildAntigravityScopedHome({ realHome: home, scopeRoot: join(data, "native/antigravity-scope"), name: "fixture", servers: { fixture: { command: "fixture", args: [], env: { TOKEN: "fixture-only" } } }, askStopHooks: '{"hooks":{}}' });
  scope.dispose();
};
fixtures[49] = async (_data, home) => {
  const { scopedCliHome } = await import("./drivers/scoped-cli-home.ts");
  seed(join(home, ".grok/auth.json"), '{"token":"fixture-only"}');
  const spec = { kind: "grok", realHome: join(home, ".grok"), botId: "fixture", share: ["auth.json"], generated: () => ({ "config.toml": 'api_key = "fixture-only"\n' }) };
  expect(fs.existsSync(join(scopedCliHome(spec), "config.toml"))).toBe(true);
  scopedCliHome(spec);
};
fixtures[65] = async data => {
  const { commitPackageImportFiles, recoverPackageImportTransaction } = await import("./package-import-transaction.ts");
  const name = "workspaces/12345678-1234-4234-8234-123456789abc/skills/fixture/SKILL.md";
  const opts = { allowedNewBotIds: ["12345678-1234-4234-8234-123456789abc"], assertOwned: () => {} };
  commitPackageImportFiles(data, new Map([[name, Buffer.from("fixture")]]), new Map([[name, null]]), opts);
  recoverPackageImportTransaction(data, opts);
};
fixtures[68] = async () => {
  const { importCollectionSkill } = await import("./skill-collection.ts");
  expect(importCollectionSkill([{ path: "SKILL.md", content: "---\nname: fixture\ndescription: Fixture\n---\nFixture instructions\n" }], { kind: "file", label: "fixture" })).not.toHaveProperty("error");
};
fixtures[70] = async data => {
  const { WebhookManager } = await import("./webhooks.ts");
  const manager = new WebhookManager({ file: join(data, "webhooks.json"), now: () => 1, emit: () => {}, botState: () => "ready", enqueue: () => ({ id: "fixture" }), cancelQueued: () => {}, pendingRuns: () => 0 });
  expect(manager.create({ name: "Fixture", prompt: "Fixture prompt", botId: "fixture" })).toHaveProperty("secret");
};

fixtures[14] = async () => {
  const { saveFile, saveImage } = await import("./attachments.ts");
  async function* bytes() { yield Buffer.from("fixture document"); }
  await saveFile(bytes(), "fixture.txt", "text/plain");
  saveImage(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"), "image/png");
};
fixtures[24] = async data => {
  seed(join(data, "cloud-computer-turns.json"), "broken");
  const { cloudTurnStrict } = await import("./cloud-computer-turns.ts");
  expect(cloudTurnStrict("fixture")).toBe(true);
  // The reset ledger is covered; only the malformed copy remains exempt.
  expect(dataCredentialHit([join(data, "cloud-computer-turns.json")], [data])).toBe("murage-data-credentials:cloud-computer-turns.json");
  expect(fs.readFileSync(join(data, "cloud-computer-turns.json.unreadable"), "utf8")).toBe("broken");
};
fixtures[26] = async data => {
  const { saveConfig } = await import("./config.ts");
  saveConfig({ flux: { apiKey: "fixture-only" } });
  expect(fs.readFileSync(join(data, "config.json"), "utf8")).toContain("fixture-only");
};
fixtures[55] = async (data, home) => {
  const { connectOpenCodeFlux, disconnectOpenCodeFlux } = await import("./opencode-config.ts");
  seed(join(home, ".config/opencode/opencode.json"), '{"theme":"fixture"}');
  const env = { HOME: home, MURAGE_DATA_DIR: data };
  expect((await connectOpenCodeFlux({ key: "sk-flux-Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", env })).ok).toBe(true);
  expect((await disconnectOpenCodeFlux({ env })).ok).toBe(true);
};

const writerSources = [
  "deploy/cloud-home/murage-turn-launch.py",
  "electron/browser-extension-windows.mjs",
  "electron/cloud-home-store.mjs",
  "electron/cloud-link-handoff.mjs",
  "electron/companion-stale.mjs",
  "electron/cua-connection.cjs",
  "electron/cua-linux-runtime.cjs",
  "electron/cua.mjs",
  "electron/main.mjs",
  "electron/skill-recording-store.mjs",
  "native/browser-extension/transport.cpp",
  "native/engine-exclusion/exclusion.c",
  "server/artifacts.ts",
  "server/attachments.ts",
  "server/bot-package-import.ts",
  "server/browser-engine.ts",
  "server/browser-extension-broker.ts",
  "server/browser-extension-clients.ts",
  "server/browser-restore-store.ts",
  "server/channels/whatsapp/auth-key-source.ts",
  "server/channels/whatsapp/bridge.ts",
  "server/channels/whatsapp/core/auth-store.ts",
  "server/claude-account-config.ts",
  "server/cloud-computer-turns.ts",
  "server/cloud-home/secrets.ts",
  "server/config.ts",
  "server/connector-cache-harness.ts",
  "server/connector-cache.ts",
  "server/connector-proxy.ts",
  "server/drivers/acp/cursor.ts",
  "server/drivers/acp/droid.ts",
  "server/drivers/acp/gemini-isolation.ts",
  "server/drivers/acp/grok-scope.ts",
  "server/drivers/acp/grok.ts",
  "server/drivers/acp/hermes.ts",
  "server/drivers/acp/kimi.ts",
  "server/drivers/acp/openclaw.ts",
  "server/drivers/acp/opencode-go.ts",
  "server/drivers/acp/qwen.ts",
  "server/drivers/antigravity-relay.ts",
  "server/drivers/antigravity-scope.ts",
  "server/drivers/claude-private.ts",
  "server/drivers/claude-signin-answers.ts",
  "server/drivers/claude.ts",
  "server/drivers/codex-hook.ts",
  "server/drivers/codex-isolation.ts",
  "server/drivers/native.ts",
  "server/drivers/pi.ts",
  "server/drivers/scoped-cli-home.ts",
  "server/drivers/shared-login-link.ts",
  "server/engine-exec.ts",
  "server/engine-fs.ts",
  "server/env-path.ts",
  "server/flux-composio-dev-token.ts",
  "server/flux-connector.ts",
  "server/fuigo-turn-logs.ts",
  "server/harness/bus.ts",
  "server/harness/event-log.ts",
  "server/health/publisher.ts",
  "server/index.ts",
  "server/installation-app-schema-downgrade.ts",
  "server/local-servers.ts",
  "server/mcp-access.ts",
  "server/memory/pip-transport.ts",
  "server/package-import-transaction.ts",
  "server/procedure-bundles.ts",
  "server/provider-routing.ts",
  "server/skill-collection.ts",
  "server/skills.ts",
  "server/webhooks.ts"
] as const;
// These are branch-specific execution limits, not exemptions from path checking.
// A missing fixture is never inferred from a missing import or silently skipped.
const cannotRun: Record<number, string> = {
  1: "Cloud launcher: Python fd-relative writes, uid/gid changes and mount namespaces require the Cloud fixture rig; Windows/macOS do not run this Linux launcher.",
  2: "Windows --write dispatch: requires the built native helper and owner-only Windows ACLs; a mocked successful helper would not exercise the writer.",
  7: "Linux CUA ready/reconnect branches: descriptor publication follows a running companion child and socket handshake; needs the isolated companion rig.",
  8: "Desktop CUA child-ready branch: requires Electron utility process and authenticated companion lifecycle before descriptor publication.",
  9: "Electron main credential migration branches: importing main starts the app, single-instance ownership and OS safeStorage; needs the packaged isolated desktop fixture.",
  11: "Windows transport writeAll/writePrivate/--write: requires Windows HANDLE, ACL and MoveFileExW semantics in the native executable.",
  12: "Native held-file branch: requires the compiled exclusion addon and OS handle ownership barrier; raw JS fs writes would bypass handle_write.",
  13: "Artifact publish branch: requires Store database, verified workspace ownership and disk-space admission; run the isolated artifact service fixture on the server rig.",
  15: "Reviewed bot package import: requires archive review hash, scan admission and owned installation transaction; a bare payload write is not this writer.",
  16: "Browser key issuance: requires browser-engine runtime initialization and profile/connection selection; use the isolated browser runtime fixture.",
  17: "Broker publication: requires authenticated native broker/socket startup; sandbox cannot allocate loopback/socket fixture resources.",
  29: "Proxy disk-list write: private function reached after MCP transport listTools and generation checks; requires isolated fake MCP child fixture.",
  30: "Cursor config publication: private grant path reached during ACP beforeSpawn with host-computer integration; requires the isolated fake ACP lifecycle fixture.",
  37: "OpenClaw retained permission record: follows Gateway sessions.get plus sessions.patch version negotiation; requires the isolated Gateway protocol fixture.",
  40: "Antigravity relay env: follows relay socket gate allocation and arming; needs the isolated socket fixture unavailable in this sandbox.",
  44: "Claude overlay acquisition in launch/fallback: requires the driver process lifecycle and session binding; use the isolated fake Claude child fixture.",
  47: "Native trace rotation: requires driver trace retention lifecycle including existing segment accounting; use the isolated native driver fixture.",
  51: "Engine executor overwrite: requires a valid deletion plan, exclusion hold and age guard before gPwrite; direct mutOps is covered separately and is not executor proof.",
  53: "Login environment persist: private function follows spawned login shell probing; child-output execution is unavailable here and must use the isolated shell rig.",
  54: "Broker token persistence: private writer follows broker token mint/refresh and Flux credential admission; requires the isolated fake broker HTTP fixture.",
  57: "Harness bus event publication: requires initialized thread Store and event ownership lifecycle; use isolated bus fixture.",
  58: "Event-log rewrite: requires retained-tail concurrency and rename/rotation lifecycle; use isolated event-log fixture.",
  60: "Pairing route: importing index boots the server and binds ports; requires isolated HTTP server fixture with authenticated pairing, unavailable here.",
  61: "Schema downgrade: requires legacy delegation database state and transactional export; use isolated schema fixture, never installation data.",
  66: "Procedure bundle create/publish: requires frozen skill catalogue, thread ownership and workspace projection; use isolated procedure fixture.",
  67: "Provider route branch: Grok needs thread identity and Fuigo needs routed scratch lifecycle; Cloud routes are rendered by the privileged launcher, not this desktop writer.",
  69: "Skill installation branch: requires workspace ownership and staged skill validation; use isolated skill service fixture.",
};
const partialBranches: Record<number, string> = {
  55: "Flux connector failed-probe rollback requires a synthetic rejected probe; successful install/remove runs here without network.",
  19: "Windows actual-profile fallback uses node:os homedir rather than the supplied HOME/USERPROFILE; requires an isolated Windows account.",
  31: "Droid scoped HOME and host-computer MCP grants require beforeSpawn integration; custom-model add/update/remove runs here.",
  32: "Gemini linked-login generation rotation and Windows hardlink fallback require the process ownership rig.",
  33: "Grok generation rotation/recovery and Windows link privilege failure require the process ownership rig.",
  35: "Hermes ask and Flux memory overlays require hook token/turn context; Cloud materializeFluxHermesHome explicitly refuses Hermes on home.",
  38: "OpenCode global instruction scoping needs ACP beforeSpawn; Cloud uses cloudTurnRender instead of writing an owner config.",
  39: "Qwen Flux memory overlay is private and requires the ACP Flux memory decision lifecycle.",
  41: "Antigravity crash recovery, conflict retention, cross-volume move fallback and owner writeback races require held-process/volume failure fixtures.",
  42: "Claude private Windows create and atomic manifest writes require native ACL helper; POSIX acquire/release runs here.",
  46: "Codex generation rotation and Windows symlink-denied hardlink fallback require the process ownership/volume fixture.",
  49: "Scoped CLI generation carry, adopted login, conflicting login quarantine and prune require held-process and crash-recovery fixtures.",
  64: "PIP copied Grok login branch requires reflection model/route binding; append writer runs here with planted config.",
  65: "Package transaction crash rollback and preexisting replacement branch require fault checkpoints and valid installation lease fixture.",
};
const tableSource = fs.readFileSync("docs/verification/gate-credential-writers-1018.md", "utf8");
const rawRows = tableSource.split("\n").filter(line => /^[^ |]+:\d+ \| [ABC] \| /.test(line)).map(line => {
  const [source] = line.split(" | ");
  const marker = line.indexOf(" | coverage=");
  return { source: source!, cases: marker < 0 ? [] : JSON.parse(line.slice(marker + " | coverage=".length)) as CoverageCase[] };
});
const writerRows = (source: string) => rawRows.filter(row => row.source.startsWith(source + ":"));
it("BUILD-FIX 8: every A/B/C writer has a real fixture or a named execution reason", () => {
  const found = [...new Set(rawRows.map(row => row.source.replace(/:\d+$/, "")))].sort();
  expect(found).toEqual([...writerSources].sort());
  expect(found).toHaveLength(70);
  for (const [index, source] of writerSources.entries()) {
    expect(typeof fixtures[index + 1] === "function" || Boolean(cannotRun[index + 1]?.trim()), source).toBe(true);
    for (const row of writerRows(source)) expect(row.cases.length, row.source).toBeGreaterThan(0);
  }
});
// The names include the writer and every table branch, so an inability to execute
// Windows or a privileged Cloud branch is never hidden in one global disclaimer.
for (const [index, source] of writerSources.entries()) {
  const number = index + 1;
  const rows = writerRows(source);
  for (const row of rows) for (const representative of row.cases) {
    const reason = cannotRun[number] ?? (representative.platform !== process.platform
      ? `${source}: ${representative.platform} native filesystem/ACL semantics need that platform's isolated rig; this host is ${process.platform}.`
      : representative.root.startsWith("/data") ? `${source}: fixed Cloud roots and launcher namespaces require the Cloud rig; only temporary relocated roots execute here.`
      : partialBranches[number]);
    if (reason) it(`${source} ${representative.branch ?? representative.root}: named reason; ${representative.path}`, () => {
      expect(reason.trim().length).toBeGreaterThan(30);
      checkCoverageCase(representative, row.source);
    });
  }
  const run = fixtures[number];
  if (!run) continue;
  it.each(["default", "relocated"])(`${source}: real writer at %s isolated root`, async branch => {
    const fixture = fs.mkdtempSync(join(tmpdir(), "murage-credential-matrix-"));
    const data = join(fixture, branch === "default" ? "home/.murage" : "relocated data");
    const home = join(fixture, "owner");
    fs.mkdirSync(data, { recursive: true, mode: 0o700 }); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    vi.stubEnv("MURAGE_DATA_DIR", data); vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    for (const [name, suffix] of Object.entries({ CODEX_HOME: ".codex", FUIGO_HOME: ".fuigo", GROK_HOME: ".grok", KIMI_CODE_HOME: ".kimi-code", HERMES_HOME: ".hermes", XDG_CONFIG_HOME: ".config", XDG_DATA_HOME: ".local/share", GEMINI_CLI_HOME: ".gemini", OPENCODE_CONFIG_DIR: ".config/opencode" })) vi.stubEnv(name, join(home, suffix));
    vi.resetModules(); observed.paths = []; observed.active = true;
    try {
      await run(data, home);
      observed.active = false;
      const destinations = [...new Set(observed.paths)].filter(path => path.startsWith(data + "/") || path.startsWith(home + "/"));
      expect(destinations.length, source).toBeGreaterThan(0);
      let checked = 0;
      for (const path of destinations) {
        const underData = path.startsWith(data + "/");
        const tail = relative(underData ? data : home, path).replaceAll("\\", "/");
        // Base's own classification, unchanged: data-roots.ts writeRecord leaves `.murage-root.json.<uuid>.tmp`, which
        // server/data-dir-inventory.ts:346 classifies excluded(LEFTOVER): not a credential and not restored. Only
        // that one name is skipped here. The final `.murage-root.json` (base `record`, :60) has a coverage row in the
        // writers table instead, and every other destination still needs its coverage row.
        if (underData && /^\.murage-root\.json\.[0-9a-f-]{36}\.tmp$/.test(tail) && classifyDataDirEntry(tail)?.backup === "excluded") { checked++; continue; }
        const representatives = rows.flatMap(row => row.cases);
        const hasOwnerRules = representatives.some(row => row.cover.startsWith("rule:"));
        const candidates = representatives.filter(row => underData ? !row.cover.startsWith("rule:") : row.cover.startsWith("rule:") || (!hasOwnerRules && row.cover.startsWith("exempt:")));
        const project = (row: CoverageCase): string => {
          const folders: Record<string, string> = { "$GROK_HOME": ".grok/", "$HERMES_HOME": ".hermes/", "$KIMI_CODE_HOME": ".kimi-code/", "$OPENCODE_CONFIG_DIR": ".config/opencode/" };
          const prefix = folders[row.root];
          return row.root + "/" + (prefix && tail.startsWith(prefix) ? tail.slice(prefix.length) : tail);
        };
        const groups = new Map<string, CoverageCase[]>();
        for (const row of candidates) {
          const key = row.platform + ":" + row.root;
          groups.set(key, [...(groups.get(key) ?? []), row]);
        }
        expect(groups.size, `${source}: no representative roots for ${tail}`).toBeGreaterThan(0);
        for (const group of groups.values()) {
          const matching = group.find(row => {
            const projected = project(row);
            if (row.cover.startsWith("exempt:")) {
              const listedTail = row.path.slice(row.root.length + 1);
              return tail.split("/")[0] === listedTail.split("/")[0];
            }
            if (row.cover.startsWith("rule:")) return SENSITIVE_PATHS.find(rule => "rule:" + rule.id === row.cover)?.re.test(projected);
            return dataCredentialHit([projected], [row.root], [row.cover]);
          });
          expect(matching, `${source}: observed destination ${tail} has no coverage at ${group[0]!.root}`).toBeDefined();
          if (matching) { checkCoverageCase({ ...matching, path: project(matching) }, source); checked++; }
        }
      }
      expect(checked, `${source}: no observed A/B/C destination matched its table`).toBeGreaterThan(0);
    } finally { observed.active = false; vi.unstubAllEnvs(); removeTempDirSync(fixture); }
  });
}
