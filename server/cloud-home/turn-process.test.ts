import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_ENGINES, CLOUD_RENDER_SYSTEM_PROMPT, TURN_MARKER, TURN_RENDER, cloudTurnRender, cloudEngineHome, cloudTurnEnvironment, cloudTurnLaunch } from "./turn-process.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

afterEach(() => vi.unstubAllEnvs());

describe("home engine turns", () => {
  it("leaves desktop environments and launch behavior unchanged", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    const env = { HOME: "/desktop", PRIVATE_KEY: "fixture" };
    expect(cloudTurnEnvironment("anything", env)).toBe(env);
    expect(cloudTurnLaunch("node", [], env)).toBeNull();
  });
  it.each(CLOUD_ENGINES)("gives %s an explicit home without ambient secrets", engine => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const env = cloudTurnEnvironment(engine, { HOME: "/data", CODEX_HOME: "/other", TZ: "Europe/London", MURAGE_CLOUD_BOOTSTRAP_SECRET: "bootstrap", UNKNOWN_SECRET: "secret", GEMINI_API_KEY: "own-key" }, ["GEMINI_API_KEY"]);
    expect(env.HOME).toBe(`/data/engine-homes/${engine}`);
    expect(env[TURN_MARKER]).toBe(engine);
    expect(env.GEMINI_API_KEY).toBe("own-key");
    expect(env.TZ).toBe("Europe/London");
    expect(env).not.toHaveProperty("UNKNOWN_SECRET");
    expect(env).not.toHaveProperty("MURAGE_CLOUD_BOOTSTRAP_SECRET");
    if (engine === "codex") expect(env.CODEX_HOME).toBe("/data/engine-homes/codex/.codex");
    else expect(env).not.toHaveProperty("CODEX_HOME");
  });
  it("refuses unknown engines and unmarked launches on homes", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    expect(() => cloudEngineHome("../secrets")).toThrow();
    expect(() => cloudTurnLaunch("node", [], {})).toThrow("explicit engine");
  });
  it("gives Grok, Kimi and OpenCode their own config homes with self-update off", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    expect(cloudTurnEnvironment("grokAgent", {})).toMatchObject({ GROK_HOME: "/data/engine-homes/grokAgent/.grok", GROK_DISABLE_AUTOUPDATER: "1" });
    expect(cloudTurnEnvironment("kimiAgent", {})).toMatchObject({ KIMI_CODE_HOME: "/data/engine-homes/kimiAgent/.kimi-code", KIMI_CODE_NO_AUTO_UPDATE: "1" });
    expect(cloudTurnEnvironment("opencodeGo", {})).toMatchObject({ OPENCODE_DISABLE_AUTOUPDATE: "1" });
  });
  it("turns agy's self-update off with exactly \"true\" (\"1\" still calls the updater, measured on 1.4.4) and keeps its HOME the engine home", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const env = cloudTurnEnvironment("antigravity", {});
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
    expect(env.HOME).toBe("/data/engine-homes/antigravity");
  });
  it("sends the Antigravity driver's MCP stanzas and Ask hook to the launcher as render parts on a home, and builds no owner-home mirror", () => {
    const driver = readFileSync(new URL("../drivers/antigravity.ts", import.meta.url), "utf8");
    expect(driver).toContain('const onCloudHome = process.env.MURAGE_CLOUD_ROLE === "home";');
    expect(driver).toContain("if (!onCloudHome) scoped = buildAntigravityScopedHome({");
    expect(driver).toContain('cloudTurnRender(turnEnv, "mcp", stanzas)');
    expect(driver).toContain('if (askStop) cloudTurnRender(turnEnv, "hooks", "ask")');
  });
  it("keeps Claude Code's updater and non-allowlisted telemetry off on a home", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    expect(cloudTurnEnvironment("claudeAgent", {})).toMatchObject({ DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
  });
  it("sends intentional turn credentials through FD payload, not launcher argv", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const env = cloudTurnEnvironment("claudeAgent", {});
    env.ANTHROPIC_AUTH_TOKEN = "turn-only-fixture";
    env.MURAGE_CLOUD_SECRETS_FD = "3";
    env.NODE_OPTIONS = "--require /evil.js";
    env.LD_AUDIT = "/fixture/evil.so";
    env.LD_DEBUG_OUTPUT = "/fixture/debug";
    env.CI = "1";
    const launch = cloudTurnLaunch("/usr/bin/claude", ["--version"], env)!;
    expect(launch.args.join(" ")).not.toContain("turn-only-fixture");
    expect(JSON.parse(launch.request)).toMatchObject({ engine: "claudeAgent", env: { ANTHROPIC_AUTH_TOKEN: "turn-only-fixture" }, cwd: "/data/engine-homes/claudeAgent" });
    for (const key of ["MURAGE_CLOUD_SECRETS_FD", "NODE_OPTIONS", "CI", "LD_AUDIT", "LD_DEBUG_OUTPUT", TURN_MARKER]) expect(JSON.parse(launch.request).env).not.toHaveProperty(key);
  });
  it("sends typed render parameters through the FD payload, never files, argv or the process environment", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const env = cloudTurnEnvironment("codex", {});
    cloudTurnRender(env, "route", { provider: "murage_0123456789abcdef", baseUrl: "https://fixture.example/v1", model: "fixture-model", apiKey: "fixture-inline-key" });
    const launch = cloudTurnLaunch("/opt/murage/bin/codex", ["app-server"], env)!;
    const payload = JSON.parse(launch.request);
    expect(payload).not.toHaveProperty("files");
    expect(payload.render.route.apiKey).toBe("fixture-inline-key");
    expect(payload.env).not.toHaveProperty(TURN_RENDER);
    expect(JSON.stringify(launch.args)).not.toContain("fixture-inline-key");
  });
  it("unit DAC check denies a different uid the sealed store, config and SQLite", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-turn-permissions-"));
    try {
      chmodSync(root, 0o711);
      mkdirSync(join(root, "secrets"), { mode: 0o700 });
      for (const name of ["secrets/sealed", "config.json", "server.sqlite"]) writeFileSync(join(root, name), "fixture-only", { mode: 0o600 });
      // Stat-backed Unix DAC calculation only. This fixture does not switch
      // uid or establish VM namespace enforcement in the unprivileged runner.
      const server = statSync(root);
      const turnUid = server.uid + 1;
      const grantedRead = (path: string) => {
        const st = statSync(path);
        const bit = st.uid === turnUid ? 0o400 : 0o004;
        return (st.mode & bit) !== 0;
      };
      expect(statSync(join(root, "secrets")).mode & 0o077).toBe(0);
      for (const name of ["secrets/sealed", "config.json", "server.sqlite"]) {
        expect(grantedRead(join(root, name))).toBe(false);
        expect(statSync(join(root, name)).mode & 0o077).toBe(0);
      }
    } finally { removeTempDirSync(root); }
  });
  it("launcher drops host identity and mounts only selected directories", () => {
    const source = readFileSync(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url), "utf8");
    expect(source.indexOf('os.setgroups([grp.getgrnam("murage-eng-" + engine).gr_gid, grp.getgrnam(SANDBOX_GROUP).gr_gid])')).toBeLessThan(source.indexOf("os.setuid(account.pw_uid)"));
    expect(source.indexOf("os.setuid(account.pw_uid)")).toBeLessThan(source.indexOf("os.execve(PASTA, pasta_argv(turn_dir), env)"));
    expect(source).toContain('"--unshare-user", "--unshare-pid"');
    expect(source).toContain('"--cap-drop", "ALL"');
    expect(source).toContain('"--disable-userns"'); expect(source).toContain('with_seccomp(argv, FD_TOKEN + "seccomp")');
    expect(source).toContain('"/proc/self/fd/" + str(fd)');
    expect(source).toContain("mounts = anchor_mounts(mounts)");
    expect(source).toContain("libc.unshare(0x00020000)");
    expect(source).not.toContain('["--bind", "/data", "/data"]');
    expect(source).toContain("os.closerange(3,");
    expect(source).toContain('"--ro-bind-data", FD_TOKEN + token, path');
    expect(source).toContain('"--child", command');
  });
});

it("strips loader controls at the parent FD boundary", () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const keys = ["LD_PRELOAD", "BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "PYTHONSTARTUP", "PYTHONHOME", "PYTHONPATH", "PYTHONINSPECT", "PERL5OPT", "PERL5LIB", "RUBYOPT", "GCONV_PATH"];
  const env = cloudTurnEnvironment("fuigoAgent", {});
  Object.assign(env, Object.fromEntries(keys.map(key => [key, "fixture-loader"])));
  const payload = JSON.parse(cloudTurnLaunch("/opt/murage/bin/fuigo", [], env)!.request);
  for (const key of keys) expect(payload.env).not.toHaveProperty(key);
});

describe("server never writes inside an engine home", () => {
  it("hands the system prompt to the launcher as a typed render part and names its file by placeholder", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const env = cloudTurnEnvironment("claudeAgent", {});
    cloudTurnRender(env, "systemPrompt", "system text\n${HOME}");
    const payload = JSON.parse(cloudTurnLaunch("/opt/murage/bin/claude", ["--append-system-prompt-file", CLOUD_RENDER_SYSTEM_PROMPT], env)!.request);
    expect(payload.render).toEqual({ systemPrompt: "system text\n${HOME}" });
    expect(payload.args).toEqual(["--append-system-prompt-file", "@render:system-prompt"]);
  });
  it("refuses a render part outside a home", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    expect(() => cloudTurnRender({}, "systemPrompt", "x")).toThrow();
  });
  it("keeps Claude and pi turn files off the server's filesystem in Cloud mode", () => {
    const claude = readFileSync(new URL("../drivers/claude.ts", import.meta.url), "utf8");
    expect(claude).not.toMatch(/mkdtempSync\(join\(process\.env\.MURAGE_CLOUD_ROLE === "home" \? join\(cloudEngineHome/u);
    expect(claude).toContain("cloudTurnRender(env, \"mcp\"");
    expect(claude).toContain("cloudTurnRender(env, \"systemPrompt\"");
    expect(readFileSync(new URL("../drivers/pi.ts", import.meta.url), "utf8")).toContain("cloudHomeCopy.piOnHome");
  });
});

describe("Claude approval broker socket", () => {
  it("lives in the shared broker directory, never an engine home, and the launcher binds only that for Claude and Antigravity (its relay hook)", async () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const { permissionSocketPath } = await import("../drivers/claude.ts");
    expect(permissionSocketPath("thread-1")).toMatch(/^\/data\/broker\/perm-[0-9a-z-]+\.sock$/u);
    const launcher = readFileSync(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url), "utf8");
    expect(launcher).toContain('BROKER_DIR = "/data/broker"');
    expect(launcher).toContain('if engine in ("claudeAgent", "antigravity") and os.path.isdir(BROKER_DIR)');
  });
});
