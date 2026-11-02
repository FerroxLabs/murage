// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The sign-in recipe: fixed per driver, and an environment that passes nothing by default (ENGINE-SIGNIN-SIMPLE-1014, Part A).
import { describe, expect, it } from "vitest";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { buildEngineSigninRecipe, buildSigninEnv, ENGINE_SIGNIN_TABLE, resolveSigninArgv, SIGNIN_ACCOUNT_ROOT_KEYS, SIGNIN_OPENER_ENV } from "./engine-signin-recipe.ts";

const HOSTILE: Record<string, string> = {
  ANTHROPIC_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "x", ANTHROPIC_BASE_URL: "https://evil.example", CLAUDE_CODE_OAUTH_TOKEN: "x", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "x",
  OPENAI_API_KEY: "x", OPENAI_BASE_URL: "https://evil.example", XAI_API_KEY: "x", FLUX_API_KEY: "x", FUIGO_API_KEY: "x", KIMI_API_KEY: "x", GOOGLE_API_KEY: "x",
  HTTP_PROXY: "http://evil.example", HTTPS_PROXY: "http://evil.example", ALL_PROXY: "http://evil.example", NO_PROXY: "*", http_proxy: "http://evil.example", https_proxy: "http://evil.example",
  NODE_OPTIONS: "--require /tmp/evil.js", NODE_EXTRA_CA_CERTS: "/tmp/ca", SSL_CERT_FILE: "/tmp/ca", BASH_ENV: "/tmp/evil.sh", ENV: "/tmp/evil.sh",
  DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib", DYLD_LIBRARY_PATH: "/tmp", LD_PRELOAD: "/tmp/evil.so", LD_LIBRARY_PATH: "/tmp", BROWSER: "/tmp/evil",
};
const HEADLESS = ENGINE_SIGNIN_TABLE.claudeAgent;

describe("the sign-in table", () => {
  it("has a row for every driver, and every sign-in command either runs from the table or goes to the key box", () => {
    for (const driver of BUILT_IN_DRIVERS) {
      expect(ENGINE_SIGNIN_TABLE[driver.driverKind], driver.driverKind).toBeDefined();
      if (driver.install?.signInCommand && driver.driverKind !== "minimax" && driver.driverKind !== "fuigoAgent") expect(ENGINE_SIGNIN_TABLE[driver.driverKind].kind, driver.driverKind).not.toBe("none");
    }
  });

  it("never gives minimax a run button: its sign-in command holds the key", () => {
    expect(BUILT_IN_DRIVERS.find(driver => driver.driverKind === "minimax")?.install?.signInCommand).toContain("KEY");
    expect(ENGINE_SIGNIN_TABLE.minimax.kind).toBe("none");
    expect(ENGINE_SIGNIN_TABLE.minimax.args).toEqual([]);
  });

  it("pins each row to the agreed table", () => {
    const rows = Object.fromEntries(Object.entries(ENGINE_SIGNIN_TABLE).filter(([, row]) => row.kind === "headless").map(([kind, row]) => [kind, row.args]));
    expect(rows).toEqual({ claudeAgent: ["auth", "login"], codex: ["login"], grokAgent: ["login", "--oauth"], cursorAgent: ["login"], kimiAgent: ["login", "--region", "global"] });
    for (const kind of ["opencodeGo", "clineAgent", "droidAgent", "hermesAgent", "openclawAgent", "antigravityAgent"]) expect(ENGINE_SIGNIN_TABLE[kind].kind, kind).toBe("terminal");
  });

  it("never calls Fuigo's bare login: it stays on the Flux key card", () => {
    expect(ENGINE_SIGNIN_TABLE.fuigoAgent).toMatchObject({ kind: "none", args: [] });
  });

  it("no row reads a link or a code any more", () => {
    for (const row of Object.values(ENGINE_SIGNIN_TABLE)) for (const gone of ["hosts", "linkCode", "honoursBrowser"]) expect(row).not.toHaveProperty(gone);
  });

  it("pins every row's added names to the account root names", () => {
    for (const [kind, row] of Object.entries(ENGINE_SIGNIN_TABLE)) for (const name of row.accountKeys) expect(SIGNIN_ACCOUNT_ROOT_KEYS, `${kind} ${name}`).toContain(name);
    for (const blocked of ["SSL_CERT_FILE", "BASH_ENV", "NODE_OPTIONS", "LD_PRELOAD", "HTTP_PROXY", "BROWSER"]) expect(SIGNIN_ACCOUNT_ROOT_KEYS).not.toContain(blocked);
  });
});

describe("the sign-in environment", () => {
  const base = { source: { ...HOSTILE, PATH: "/ignored", HOME: "/home/sam", MURAGE_DATA_DIR: "/data", SECRET_THING: "x" }, searchPath: "/server/path", platform: "linux" as NodeJS.Platform };

  it("drops every token, key, base URL, proxy, NODE_OPTIONS, DYLD_* and LD_PRELOAD", () => {
    const { env, unsetKeys } = buildSigninEnv({ ...base, row: HEADLESS });
    expect(env).toEqual({ PATH: "/server/path", HOME: "/home/sam" });
    for (const name of Object.keys(HOSTILE)) expect(unsetKeys).toContain(name);
    expect(unsetKeys).toContain("MURAGE_DATA_DIR");
  });

  it("drops them the same way on Windows whatever their case, and reads Path and Home in any case", () => {
    const spelled = Object.fromEntries(Object.entries(HOSTILE).map(([name, value], index) => [index % 2 ? name.toLowerCase() : name, value]));
    const { env, unsetKeys } = buildSigninEnv({ row: { accountKeys: ["CODEX_HOME"] }, platform: "win32", searchPath: "C:\\bin",
      source: { ...spelled, Path: "C:\\ignored", UserProfile: "C:\\Users\\Sam", SYSTEMROOT: "C:\\Windows", pathext: ".EXE", codex_home: "C:\\c" } });
    expect(env).toEqual({ PATH: "C:\\bin", USERPROFILE: "C:\\Users\\Sam", SystemRoot: "C:\\Windows", PATHEXT: ".EXE", CODEX_HOME: "C:\\c" });
    expect(Object.keys(env).map(name => name.toUpperCase()).sort()).toEqual(["CODEX_HOME", "PATH", "PATHEXT", "SYSTEMROOT", "USERPROFILE"]);
    expect(unsetKeys.length).toBeGreaterThan(20);
  });

  it("lets an instance set its account root, and nothing else, through its saved environment", () => {
    const { env } = buildSigninEnv({ ...base, row: ENGINE_SIGNIN_TABLE.codex, instanceEnvironment: { CODEX_HOME: "/acct/two", SSL_CERT_FILE: "/tmp/ca", BASH_ENV: "/tmp/evil", NODE_OPTIONS: "x", OPENAI_API_KEY: "x", HTTPS_PROXY: "x" } });
    expect(env).toEqual({ PATH: "/server/path", HOME: "/home/sam", CODEX_HOME: "/acct/two" });
  });

  it("refuses a row that names anything but an account root, however it got there", () => {
    const { env } = buildSigninEnv({ ...base, row: { accountKeys: ["SSL_CERT_FILE", "BASH_ENV", "LD_PRELOAD", "HTTP_PROXY", "CODEX_HOME"] },
      instanceEnvironment: { SSL_CERT_FILE: "/tmp/ca", BASH_ENV: "/tmp/evil", LD_PRELOAD: "/tmp/e.so", HTTP_PROXY: "x", CODEX_HOME: "/c" }, account: { SSL_CERT_FILE: "/tmp/ca" } });
    expect(env).toEqual({ PATH: "/server/path", HOME: "/home/sam", CODEX_HOME: "/c" });
  });

  it("gives a named Claude account its folder ahead of anything inherited, and leaves the default alone", () => {
    const named = buildSigninEnv({ ...base, row: HEADLESS, source: { ...base.source, CLAUDE_CONFIG_DIR: "/inherited" }, account: { CLAUDE_CONFIG_DIR: "/acct/claude" } });
    expect(named.env.CLAUDE_CONFIG_DIR).toBe("/acct/claude");
    expect(buildSigninEnv({ ...base, row: HEADLESS }).env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(buildSigninEnv({ ...base, row: HEADLESS, source: { ...base.source, CLAUDE_CONFIG_DIR: "/inherited" } }).env.CLAUDE_CONFIG_DIR).toBe("/inherited");
  });

  it("never carries a value with a line break or a NUL", () => {
    expect(buildSigninEnv({ ...base, row: ENGINE_SIGNIN_TABLE.codex, instanceEnvironment: { CODEX_HOME: "/a\nb" } }).env.CODEX_HOME).toBeUndefined();
  });

  it("leaves BROWSER out, so the engine opens the real browser", () => {
    for (const platform of ["linux", "darwin", "win32"] as NodeJS.Platform[]) expect(buildSigninEnv({ ...base, platform, row: HEADLESS }).env.BROWSER).toBeUndefined();
  });

  it("gives Linux the opener names from the desktop session, and an instance cannot set them", () => {
    const session = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000", XAUTHORITY: "/home/sam/.Xauthority", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" };
    const { env } = buildSigninEnv({ ...base, row: HEADLESS, source: { ...base.source, ...session }, instanceEnvironment: { DISPLAY: ":99", DBUS_SESSION_BUS_ADDRESS: "unix:path=/evil", XDG_RUNTIME_DIR: "/evil" } });
    expect(env).toEqual({ PATH: "/server/path", HOME: "/home/sam", ...session });
    const none = buildSigninEnv({ ...base, row: HEADLESS, instanceEnvironment: { DISPLAY: ":99" } });
    expect(none.env.DISPLAY).toBeUndefined();
  });

  it("gives Windows its opener names in any case, from the session alone", () => {
    const { env } = buildSigninEnv({ row: HEADLESS, platform: "win32", searchPath: "C:\\bin", instanceEnvironment: { COMSPEC: "C:\\evil.exe", TEMP: "C:\\evil" },
      source: { COMSPEC: "C:\\Windows\\cmd.exe", WINDIR: "C:\\Windows", appdata: "C:\\A", LocalAppData: "C:\\L", Temp: "C:\\T", tmp: "C:\\T" } });
    expect(env).toEqual({ PATH: "C:\\bin", ComSpec: "C:\\Windows\\cmd.exe", windir: "C:\\Windows", APPDATA: "C:\\A", LOCALAPPDATA: "C:\\L", TEMP: "C:\\T", TMP: "C:\\T" });
  });

  it("adds no opener name on a Mac, and the lists hold nothing that loads code or carries a key", () => {
    const session = { ...base, platform: "darwin" as NodeJS.Platform, source: { ...base.source, DISPLAY: ":0", TEMP: "/t" } };
    expect(buildSigninEnv({ ...session, row: HEADLESS }).env).toEqual({ PATH: "/server/path", HOME: "/home/sam" });
    for (const list of Object.values(SIGNIN_OPENER_ENV)) for (const name of list) expect(Object.keys(HOSTILE)).not.toContain(name);
  });
});

describe("the sign-in executable", () => {
  const facts = { args: ["auth", "login"], platform: "linux" as NodeJS.Platform, resolve: (cli: string, args: string[]) => ({ command: cli, args }), candidates: (name: string) => name === "claude" ? ["/usr/local/bin/claude"] : [], realpath: (file: string) => `/real${file}` };

  it("is an absolute realpath, ahead of the fixed args", () => {
    expect(resolveSigninArgv({ ...facts, cli: "claude" })).toEqual(["/real/usr/local/bin/claude", "auth", "login"]);
  });
  it("keeps a wrapper's fixed words ahead of the args", () => {
    expect(resolveSigninArgv({ ...facts, cli: "/opt/ag", resolve: (_cli, args) => ({ command: "/opt/ag", args: ["claude", ...args] }) })).toEqual(["/real/opt/ag", "claude", "auth", "login"]);
  });
  it("is null when the command is not on the engine PATH, or its file has gone", () => {
    expect(resolveSigninArgv({ ...facts, cli: "missing" })).toBeNull();
    expect(resolveSigninArgv({ ...facts, cli: "claude", realpath: () => { throw new Error("gone"); } })).toBeNull();
  });
  it("takes a resolved Windows shim, and refuses one it could not resolve", () => {
    const windows = { ...facts, platform: "win32" as NodeJS.Platform, realpath: (file: string) => file };
    expect(resolveSigninArgv({ ...windows, cli: "claude", resolve: (_cli, args) => ({ command: "C:\\nodejs\\node.exe", args: ["C:\\npm\\cli.js", ...args] }) })).toEqual(["C:\\nodejs\\node.exe", "C:\\npm\\cli.js", "auth", "login"]);
    for (const shim of ["C:\\npm\\claude.cmd", "C:\\npm\\claude.BAT", "C:\\npm\\claude.ps1"]) expect(resolveSigninArgv({ ...windows, cli: "claude", resolve: (_cli, args) => ({ command: shim, args }) })).toBeNull();
  });
});

describe("the recipe", () => {
  const input = { label: "Codex", cli: "codex", source: { HOME: "/home/sam", OPENAI_API_KEY: "x" }, searchPath: "/p", platform: "linux" as NodeJS.Platform, resolve: (cli: string, args: string[]) => ({ command: cli, args }), candidates: () => ["/bin/codex"], realpath: (file: string) => file };

  it("holds the contract's fields, and no text from a caller", () => {
    expect(buildEngineSigninRecipe({ ...input, driverKind: "codex" })).toEqual({ kind: "headless", argv: ["/bin/codex", "login"], env: { PATH: "/p", HOME: "/home/sam" }, unsetKeys: ["OPENAI_API_KEY"], accountRoot: "/home/sam/.codex", accountEnv: {}, label: "Codex" });
  });
  it("carries the account keys alone for a terminal, never the rest of the sign-in env", () => {
    expect(buildEngineSigninRecipe({ ...input, driverKind: "codex", instanceEnvironment: { CODEX_HOME: "/acct" } }).accountEnv).toEqual({ CODEX_HOME: "/acct" });
  });
  it("names the folder the sign-in writes to", () => {
    expect(buildEngineSigninRecipe({ ...input, driverKind: "codex", instanceEnvironment: { CODEX_HOME: "/acct" } }).accountRoot).toBe("/acct");
    expect(buildEngineSigninRecipe({ ...input, driverKind: "claudeAgent", cli: "claude", account: { CLAUDE_CONFIG_DIR: "/acct/c" }, accountRoot: "/acct/c" }).accountRoot).toBe("/acct/c");
    expect(buildEngineSigninRecipe({ ...input, driverKind: "droidAgent", cli: "droid", instanceEnvironment: { FACTORY_HOME_OVERRIDE: "/f" } }).accountRoot).toBe("/f/.factory");
  });
  it("is none, with nothing to run, for an unresolved command, a key engine and an unknown driver", () => {
    expect(buildEngineSigninRecipe({ ...input, driverKind: "codex", candidates: () => [] })).toMatchObject({ kind: "none", argv: [], env: {} });
    expect(buildEngineSigninRecipe({ ...input, driverKind: "minimax", cli: "mmx" })).toMatchObject({ kind: "none", argv: [] });
    expect(buildEngineSigninRecipe({ ...input, driverKind: "newDriver" })).toMatchObject({ kind: "none", argv: [] });
    expect(buildEngineSigninRecipe({ ...input, driverKind: "codex", cli: undefined })).toMatchObject({ kind: "none", argv: [] });
  });
});
